// Orphaned-write drain — rescuing un-ACKed writes out of an abandoned store.
//
// THE DATA-LOSS CLASS
// -------------------
// A browser build never redials: `synchronizer_base::schedule_reconnect()` is
// `#ifdef __EMSCRIPTEN__ return;`. When the sync socket dies, the wasm store
// keeps accepting writes and keeps journalling them into `AuditLog` with
// `isSynchronized = 0` — they are queued for an uploader whose transport is
// gone. Detecting the death is app-side and never instantaneous (the socket
// only reports `close` when the TCP/WS teardown lands), so there is always a
// window in which a write is accepted into a store that can no longer ship it.
//
// The app-standard recovery is to redial with a FRESH store name
// (`trip-e2e-${tripId}-${Date.now()}`, and its equivalents): a new path, a new
// wasm instance, a new socket. That store starts empty, catches up from the
// server, and is correct about everything the server knows — but the writes
// stranded in the OLD store are not on the server, so they are not in the
// catch-up, and nothing ever revisits the old store. `close()` does not help:
// even after PR #6 it tears down the transport, it does not drain the queue
// (and it could not — the socket is already dead). No redelivery mechanism
// exists anywhere in the stack. The write is simply gone.
//
// Verified end-to-end by the joyjet orphan repro: a write made ~300ms after a
// server SIGKILL never reaches the server — not by client resend within 60s,
// not through `close()`, and not through the fresh store's catch-up.
//
// WHAT THIS MODULE DOES
// ---------------------
// The stranded set is knowable from JS: it is exactly the `AuditLog` rows the
// old store still has with `isSynchronized = 0`, which the embind method
// `getPendingAuditLog()` already returns (it returns ALL rows — the filtering
// below is ours). Re-offering them through a LIVE store is also possible from
// JS: `applyRemoteChanges(entries)` replays each row's SQL and then records the
// row in the live store's `AuditLog` with `isSynchronized = 0`, which is the
// state the uploader picks up (`query_audit_log_for_sync`'s branch 2:
// `a.isSynchronized = 0 AND a.id > floor AND NOT EXISTS(sync_state row)`), and
// the `AuditLog` INSERT itself fires the synchronizer's table observer →
// `request_upload()`. So the drained rows upload on the live socket.
//
// This module is the wasm-free half of that: it decides WHICH rows are
// pending, dedupes, and drives the two embind calls. Everything here is
// testable in node against a fake store — see test/pending-drain.test.ts.
//
// WHY REPLAY IS SAFE TO REPEAT (IDEMPOTENCY)
// ------------------------------------------
// Three independent layers, in the order they fire:
//
//   1. THIS MODULE. Before offering anything it reads the target's own
//      `AuditLog` and drops every row whose audit `globalId` is already there.
//      Re-draining the same source into the same target is a no-op.
//   2. THE DATA APPLY. `audit_log_entry::generate_instruction()` keys on the
//      DATA row's `globalId` (`globalRowId` on the entry), never on `rowId`:
//      INSERT is `INSERT ... ON CONFLICT(globalId) DO UPDATE SET ... WHERE
//      <some value actually differs>`, UPDATE is `... WHERE globalId = ? AND
//      (<some value actually differs>)`. A value-identical re-apply changes
//      zero rows. This is also why replay works ACROSS stores at all: row ids
//      differ between stores, global ids do not.
//   3. THE SERVER. `receive()` skips any entry whose audit `globalId` is
//      already in its `AuditLog`. A row drained into two different fresh
//      stores uploads twice and lands once.
//
// ORDERING
// --------
// Drained rows are appended to the live store's `AuditLog` at drain time, so
// they land AFTER everything the live socket has already caught up with, and
// they carry ids above the sync slot's upload floor (the floor only ever
// advances to ids that already existed). That is the intended order: the
// server's view is authoritative for the catch-up, and the rescued write is a
// later edit on top of it. Draining before catch-up settles would invert that
// and let a stale catch-up frame overwrite the rescued value locally — which
// is why `resumePendingFrom` waits for the socket to open AND for the received
// counter to go quiet before draining (see `waitForCatchUpQuiet`).

/**
 * One `AuditLog` row, exactly as the wasm serialises it
 * (`audit_log_entry::to_json`) — plain JSON, safe to `structuredClone`,
 * `JSON.stringify`, journal to `localStorage`, or hand back to
 * `applyRemoteChanges` verbatim.
 *
 * `globalId` identifies the CHANGE (the dedupe key everywhere in this
 * pipeline); `globalRowId` identifies the ROW the change applies to.
 */
export interface PendingUploadRow {
    /** `AuditLog.id` in the SOURCE store. Ordering only — ids are per-store. */
    id: number;
    /** Identity of this change. Dedupe key here, in the target, and server-side. */
    globalId: string;
    tableName: string;
    operation: 'INSERT' | 'UPDATE' | 'DELETE' | string;
    /** Primary key in the SOURCE store. Never used to locate the row on apply. */
    rowId: number;
    /** Identity of the row this change applies to — what the apply keys on. */
    globalRowId: string;
    /** AnyProperty-format values, keyed by column. */
    changedFields: Record<string, unknown>;
    changedFieldsNames: string[];
    timestamp: string;
    /** True when the row reached the source store from a sibling/relay, not a local write. */
    isFromRemote: boolean;
    /** Always false for a pending row — kept so the row round-trips verbatim. */
    isSynchronized: boolean;
    synthesized?: boolean;
}

/** The one embind method needed to read a store's pending set. */
export interface AuditLogSource {
    getPendingAuditLog(): string;
}

/** The two embind methods needed to re-offer rows through a live store. */
export interface DrainTarget extends AuditLogSource {
    applyRemoteChanges(entriesJson: string): string;
}

export interface PendingSelectOptions {
    /**
     * Only rows that originated as LOCAL writes in the source store
     * (`isFromRemote === false`).
     *
     * Default `false`, which matches what the store's own uploader would have
     * sent: `query_audit_log_for_sync` deliberately applies **no**
     * `isFromRemote` filter — "any entry not synced by this sync_id is
     * pending, enabling cross-transport relay". Rows a sibling tab relayed in
     * (via `applyRemoteChanges`, which stamps `isFromRemote = 1`,
     * `isSynchronized = 0`) are owed upstream by this store exactly like its
     * own writes, and a row this drain itself rescued is stamped the same way
     * — so `localOnly` would make a second-generation rescue lossy.
     *
     * Set it when you want strictly locally-originated rows (e.g. journalling
     * "what did THIS device write that never landed").
     */
    localOnly?: boolean;
}

export interface DrainOptions extends PendingSelectOptions {
    /**
     * Model table names the target store knows. Rows for any other table are
     * skipped — their SQL would fail against a schema that has no such table,
     * and the failure is only visible in a C++ `printf`.
     *
     * Underscore-prefixed tables are ALWAYS allowed regardless of this list:
     * see {@link isInternalTable}.
     */
    tables?: Iterable<string>;
    /**
     * Rows per `applyRemoteChanges` call (default 200). Each call is one
     * synchronous C++ loop over the batch; chunking keeps a large backlog from
     * blocking the main thread in a single unbroken pass, and bounds what one
     * failing batch can take with it.
     */
    chunkSize?: number;
    /** Injectable for tests. Called between chunks to yield the event loop. */
    sleep?: (ms: number) => Promise<void>;
}

export interface DrainReport {
    /** Pending rows read out of the source store. */
    found: number;
    /** Dropped: the target's `AuditLog` already has this change. */
    alreadyPresent: number;
    /** Dropped: the target's schema has no such table. */
    unknownTable: number;
    /** Rows handed to `applyRemoteChanges`. */
    offered: number;
    /** Audit `globalId`s the target actually applied — these will upload. */
    applied: string[];
    /**
     * Offered but not applied (the row's SQL threw target-side). Nothing was
     * recorded for them, so a later drain retries them.
     */
    failed: string[];
}

const EMPTY_REPORT: DrainReport = {
    found: 0, alreadyPresent: 0, unknownTable: 0, offered: 0, applied: [], failed: [],
};

/** A fresh zeroed report — never hand out the shared EMPTY_REPORT object. */
export function emptyDrainReport(): DrainReport {
    return { ...EMPTY_REPORT, applied: [], failed: [] };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Rows in `auditLogJson` that are still owed upstream, oldest first.
 *
 * `getPendingAuditLog()` is a misnomer inherited from the cross-tab relay: it
 * returns EVERY `AuditLog` row — it calls `query_audit_log` with
 * `only_unsynced = false`, so synced rows come back too and a new tab can
 * bootstrap from a sibling. The pending set is the `isSynchronized === false`
 * subset — the same predicate the wasm uploader uses for entries that have no
 * per-sync_id state row.
 *
 * LIMITATION (no binding for it): per-`sync_id` state lives in
 * `_lattice_sync_state`, and nothing in `EMSCRIPTEN_BINDINGS(lattice)` exposes
 * a row-returning SQL surface (`debugQueryCount` returns an int; there is no
 * `sql()`), so JS cannot see "synced for sync_id A but not B". For the browser
 * client that gap is empty in practice: a page runs ONE synchronizer per store,
 * and single-sync_id ACKs go through `mark_audit_entries_synced`, which sets
 * the global `AuditLog.isSynchronized` flag this reads. A store with several
 * live sync_ids (IPC relay + WSS) would need a `sql()` binding to be precise;
 * this filter would then be a superset — it can re-offer a row one transport
 * already ACKed, which the target and the server both dedupe away.
 */
export function selectPendingUploads(
    auditLogJson: string,
    options: PendingSelectOptions = {},
): PendingUploadRow[] {
    let raw: unknown;
    try {
        raw = JSON.parse(auditLogJson);
    } catch (err) {
        console.warn('[Lattice] pending audit log is not JSON:', err);
        return [];
    }
    if (!Array.isArray(raw)) return [];

    const seen = new Set<string>();
    const rows: PendingUploadRow[] = [];
    for (const entry of raw as PendingUploadRow[]) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.isSynchronized) continue;
        if (options.localOnly && entry.isFromRemote) continue;
        if (typeof entry.globalId !== 'string' || entry.globalId.length === 0) continue;
        // A duplicated change id in one batch is a bug upstream, not two writes.
        if (seen.has(entry.globalId)) continue;
        seen.add(entry.globalId);
        rows.push(entry);
    }
    // getPendingAuditLog() already orders by id ASC; sort anyway so a caller
    // that concatenated or re-serialised rows still gets write order, which is
    // the order the apply must run in (an UPDATE after its INSERT).
    rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    return rows;
}

/** `selectPendingUploads` over a live store handle. */
export function readPendingUploads(
    store: AuditLogSource,
    options: PendingSelectOptions = {},
): PendingUploadRow[] {
    return selectPendingUploads(store.getPendingAuditLog(), options);
}

/**
 * Underscore-prefixed tables are Lattice's own: the link/list join tables that
 * carry the object graph's EDGES (`_Day_Activity_activities`,
 * `_Trip_Destination_destinations`) plus sync bookkeeping. They are real
 * tables with real AuditLog rows, but they are not `@model` classes, so they
 * never appear in a `tables` list built from schemas — and dropping them
 * silently was found live: the rescued Activity row arrived on the server
 * detached from its Day, i.e. invisible to every graph query the app makes.
 *
 * LatticeCore's own upload filter carries exactly this exemption:
 * `filter_clause += " OR a.tableName LIKE '\\_%' ESCAPE '\\'"`.
 */
function isInternalTable(tableName: string): boolean {
    return typeof tableName === 'string' && tableName.startsWith('_');
}

/** Every audit `globalId` the target already knows — synced or not. */
function knownChangeIds(target: AuditLogSource): Set<string> {
    const ids = new Set<string>();
    try {
        const raw = JSON.parse(target.getPendingAuditLog());
        if (!Array.isArray(raw)) return ids;
        for (const entry of raw) {
            if (entry && typeof entry.globalId === 'string') ids.add(entry.globalId);
        }
    } catch (err) {
        // Reading the target's log is the idempotency guard. If it fails we
        // would re-offer everything; the data apply and the server still
        // dedupe (layers 2 and 3), so continue — but say so.
        console.warn('[Lattice] could not read target audit log for dedupe:', err);
    }
    return ids;
}

/**
 * Re-offer `rows` through `target` so its live uploader ships them.
 *
 * Rows the target already has (by audit `globalId`) are dropped before any
 * write happens — re-draining is a no-op, not a duplicate. Rows for a table
 * the target's schema does not have are dropped too, EXCEPT Lattice's own
 * underscore-prefixed tables, which carry the graph edges and are never in a
 * schema list (see {@link isInternalTable}). Whatever survives is applied in
 * source order, in chunks.
 */
export async function drainPendingUploads(
    target: DrainTarget,
    rows: readonly PendingUploadRow[],
    options: DrainOptions = {},
): Promise<DrainReport> {
    const report = emptyDrainReport();
    report.found = rows.length;
    if (rows.length === 0) return report;

    const tables = options.tables ? new Set(options.tables) : null;
    const known = knownChangeIds(target);

    const offer: PendingUploadRow[] = [];
    for (const row of rows) {
        if (known.has(row.globalId)) { report.alreadyPresent++; continue; }
        if (tables && !tables.has(row.tableName) && !isInternalTable(row.tableName)) {
            report.unknownTable++;
            continue;
        }
        offer.push(row);
    }
    report.offered = offer.length;
    if (offer.length === 0) return report;

    const chunkSize = Math.max(1, options.chunkSize ?? 200);
    const sleep = options.sleep ?? defaultSleep;
    const applied = new Set<string>();

    for (let i = 0; i < offer.length; i += chunkSize) {
        const chunk = offer.slice(i, i + chunkSize);
        try {
            const resultJson = target.applyRemoteChanges(JSON.stringify(chunk));
            const ids = JSON.parse(resultJson);
            if (Array.isArray(ids)) {
                for (const id of ids) if (typeof id === 'string') applied.add(id);
            }
        } catch (err) {
            // A throwing chunk leaves its rows unrecorded target-side, so they
            // stay pending in the source and a later drain retries them.
            console.warn('[Lattice] drain chunk failed:', err);
        }
        if (i + chunkSize < offer.length) await sleep(0);
    }

    for (const row of offer) {
        if (applied.has(row.globalId)) report.applied.push(row.globalId);
        else report.failed.push(row.globalId);
    }
    return report;
}

// ============================================================================
// Catch-up quiescence
// ============================================================================

export interface CatchUpQuietOptions {
    /** How long `received` must hold still to count as settled (default 1000ms). */
    quietMs?: number;
    /** Hard cap; past this the drain runs anyway (default 15000ms). */
    maxWaitMs?: number;
    /** Poll period (default 250ms). */
    pollMs?: number;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable for tests. */
    now?: () => number;
}

export interface CatchUpQuietResult {
    /** False when the hard cap hit first — the caller drains anyway. */
    quiet: boolean;
    waitedMs: number;
    received: number;
}

/**
 * Wait until the sync progress `received` counter stops moving.
 *
 * A drain must land AFTER catch-up (see the ORDERING note at the top): the
 * server's replay is authoritative for what it already knows, and the rescued
 * write is a later edit on top of it. Draining mid-catch-up would let a
 * catch-up frame minted before the drain overwrite the rescued value locally.
 *
 * `received` is monotonic per session, so "unchanged across a quiet window"
 * is a sound settle signal, and a store with nothing to catch up settles on
 * the first window. Timing out is NOT an error: an orphan that never drains is
 * strictly worse than one that drains a little early, so the caller proceeds.
 */
export async function waitForCatchUpQuiet(
    readReceived: () => number,
    options: CatchUpQuietOptions = {},
): Promise<CatchUpQuietResult> {
    const quietMs = options.quietMs ?? 1000;
    const maxWaitMs = options.maxWaitMs ?? 15000;
    const pollMs = Math.max(1, options.pollMs ?? 250);
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());

    const started = now();
    let last = safeRead(readReceived);
    let lastChangedAt = started;

    for (;;) {
        const elapsed = now() - started;
        if (now() - lastChangedAt >= quietMs) {
            return { quiet: true, waitedMs: elapsed, received: last };
        }
        if (elapsed >= maxWaitMs) {
            return { quiet: false, waitedMs: elapsed, received: last };
        }
        await sleep(pollMs);
        const current = safeRead(readReceived);
        if (current !== last) {
            last = current;
            lastChangedAt = now();
        }
    }
}

function safeRead(readReceived: () => number): number {
    try {
        const value = readReceived();
        return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    } catch {
        // A deleted wasm instance throws BindingError on any call. Treat it as
        // "nothing moving" — the caller's own guards handle a dead store.
        return 0;
    }
}
