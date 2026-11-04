// Orphaned writes are rescued through opaque native audit frames. Native code
// selects unsynced/unmarked entries, preserves source order and exact Int64 JSON
// tokens, late-binds NoHistory values, and applies Core's guarded pending-import
// mode. JS never parses or rewrites frame payloads. Sources remain unchanged;
// only the live uploader's eventual ACK can establish delivery.
//
// The legacy object helpers below refuse unsafe numbers. They remain useful for
// older safe-number journals, but are not an exact wire representation. Every
// import still requires the new native boundary; no manual SQL fallback exists.
import { assertSafeAuditValue, parseSafeAuditJSON } from './audit-json';

/**
 * One `AuditLog` row, in the legacy safe-number representation. Unsafe numbers are refused.
 * Use PendingAuditFrame for exact storage, copying and retransmission.
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
    /** Live NULL markers supplied by Core's NoHistory late binder. */
    noHistoryNulls?: string[];
}

/** The one embind method needed to read a store's pending set. */
export interface AuditLogSource {
    getPendingAuditLog(): string;
}

/** The two embind methods needed to re-offer rows through a live store. */
export interface DrainTarget extends AuditLogSource {
    importPendingFrame?: (json: string) => PendingImportResult;
}

export interface PendingAuditFrame {
    readonly formatVersion: 1;
    /** Metadata only; never used to reconstruct or rewrite json. */
    readonly entries: readonly { readonly globalId: string; readonly tableName: string }[];
    /** Exact native-serialized JSON array. Do not JSON.parse/stringify this. */
    readonly json: string;
}
export interface PendingImportResult {
    readonly imported: readonly string[];
    readonly alreadyPresent: readonly string[];
    readonly rejected: readonly string[];
}
export interface PendingFrameSource {
    getUnshippedAuditFrames?: (localOnly: boolean, maxEntries: number) => PendingAuditFrame[];
}
export interface PendingFrameTarget {
    importPendingFrame?: (json: string) => PendingImportResult;
}
export const MAX_PENDING_FRAME_ENTRIES = 1000;
export const MAX_PENDING_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING_TOTAL_ENTRIES = 4096;
export const MAX_PENDING_TOTAL_BYTES = 16 * 1024 * 1024;

export function copyPendingAuditFrames(raw: unknown): readonly PendingAuditFrame[] {
    if (!Array.isArray(raw)) throw new TypeError('Invalid native pending frames');
    const ids = new Set<string>();
    let totalBytes = 0, totalEntries = 0;
    return Object.freeze(raw.map(frame => {
        if (!frame || frame.formatVersion !== 1 || typeof frame.json !== 'string' ||
            new TextEncoder().encode(frame.json).length > MAX_PENDING_FRAME_BYTES ||
            !Array.isArray(frame.entries) || !frame.entries.length || frame.entries.length > MAX_PENDING_FRAME_ENTRIES) {
            throw new TypeError('Invalid native pending frame');
        }
        totalBytes += new TextEncoder().encode(frame.json).length;
        totalEntries += frame.entries.length;
        if (totalBytes > MAX_PENDING_TOTAL_BYTES || totalEntries > MAX_PENDING_TOTAL_ENTRIES) {
            throw new RangeError('Pending audit aggregate limit exceeded');
        }
        const entries = frame.entries.map((entry: any) => {
            if (!entry || typeof entry.globalId !== 'string' || !entry.globalId.length ||
                typeof entry.tableName !== 'string' || !entry.tableName.length || ids.has(entry.globalId)) {
                throw new TypeError('Invalid or duplicate pending frame identity');
            }
            ids.add(entry.globalId);
            return Object.freeze({ globalId: entry.globalId, tableName: entry.tableName });
        });
        return Object.freeze({ formatVersion: 1 as const, entries: Object.freeze(entries), json: frame.json });
    }));
}

export function readPendingAuditFrames(store: PendingFrameSource, options: PendingSelectOptions = {}, maxEntries = 200): readonly PendingAuditFrame[] {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_PENDING_FRAME_ENTRIES) {
        throw new RangeError('maxEntries must be an integer between 1 and 1000');
    }
    if (typeof store.getUnshippedAuditFrames !== 'function') throw new Error('Native opaque pending audit frames capability required');
    return copyPendingAuditFrames(store.getUnshippedAuditFrames(options.localOnly === true, maxEntries));
}

export function validatePendingImportResult(raw: unknown, offered: readonly string[]): PendingImportResult {
    const result = raw as PendingImportResult;
    if (!result || typeof result !== 'object') throw new TypeError('Invalid pending import report');
    const expected = new Set(offered), seen = new Set<string>();
    if (expected.size !== offered.length) throw new TypeError('Duplicate offered identity');
    for (const key of ['imported', 'alreadyPresent', 'rejected'] as const) {
        if (!Array.isArray(result[key])) throw new TypeError('Incomplete pending import report');
        for (const id of result[key]) {
            if (typeof id !== 'string' || !expected.has(id) || seen.has(id)) throw new TypeError('Invalid pending import report identity');
            seen.add(id);
        }
    }
    if (seen.size !== expected.size) throw new TypeError('Incomplete pending import report');
    return { imported: [...result.imported], alreadyPresent: [...result.alreadyPresent], rejected: [...result.rejected] };
}

/** Core owns deduplication and schema validation. Metadata cannot grant success. */
export async function drainPendingAuditFrames(target: PendingFrameTarget, input: readonly PendingAuditFrame[], options: Pick<DrainOptions, 'sleep'> = {}): Promise<DrainReport> {
    if (typeof target.importPendingFrame !== 'function') throw new Error('Native guarded pending import capability required');
    const frames = copyPendingAuditFrames(input), report = emptyDrainReport();
    report.found = frames.reduce((sum, frame) => sum + frame.entries.length, 0);
    const sleep = options.sleep ?? defaultSleep;
    for (let i = 0; i < frames.length; ++i) {
        const frame = frames[i], ids = frame.entries.map(entry => entry.globalId);
        report.offered += ids.length;
        try {
            const result = validatePendingImportResult(target.importPendingFrame(frame.json), ids);
            report.applied.push(...result.imported);
            report.alreadyPresent += result.alreadyPresent.length;
            report.failed.push(...result.rejected);
        } catch {
            // The source is never mutated, even if an ambiguous target outcome
            // committed. A later Core import deduplicates exact known identities.
            report.failed.push(...ids);
        }
        if (i + 1 < frames.length) await sleep(0);
    }
    return report;
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
     * (via `importPendingFrame`, which stamps `isFromRemote = 1`,
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
    /** Optional safe-number legacy helper prefilter. This is not schema
     * authority: Core validates installed table/column shapes for every import.
     * Underscore names only bypass this convenience filter; they receive no
     * authorization or automatic acceptance. Opaque rescue always defers to Core. */
    tables?: Iterable<string>;
    /**
     * Rows per `importPendingFrame` call (default 200). Each call is one
     * synchronous C++ loop over the batch; chunking keeps a large backlog from
     * blocking the main thread in a single unbroken pass, and bounds what one
     * failing batch can take with it.
     */
    chunkSize?: number;
    /** Injectable for tests. Called between chunks to yield the event loop. */
    sleep?: (ms: number) => Promise<void>;
}

export interface DrainReport {
    /** The source store does not exist (never created, snapshot gone, or a
     *  wrong path) — DISTINCT from an existing store with nothing pending.
     *  Everything else in the report is zero/empty when this is set. */
    sourceMissing: boolean;
    /** Pending rows read out of the source store. */
    found: number;
    /** Dropped: the target's `AuditLog` already has this change. */
    alreadyPresent: number;
    /** Dropped: the target's schema has no such table. */
    unknownTable: number;
    /** Entries handed to Core pending import (includes known/rejected results). */
    offered: number;
    /** Audit IDs durably imported as pending; upload/ACK is still asynchronous. */
    applied: string[];
    /**
     * Rejected or ambiguous outcomes. The source stays intact; a later Core
     * import deduplicates identities that committed before a report failure.
     */
    failed: string[];
}

const EMPTY_REPORT: DrainReport = {
    sourceMissing: false,
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
 * The AUTHORITATIVE source is `getUnshippedAuditLog()` (wasm/bindings.cpp):
 * unsynced rows with NO `_lattice_sync_state` ack mark — the drain predicate
 * in SQL, which excludes rows the synchronizer DOWNLOADED (those carry a
 * per-sync_id ack the global `isSynchronized` flag doesn\'t show until heal
 * collapses it) while keeping stranded local writes, sibling-relayed rows,
 * and second-generation rescues. This function is the JS-side belt on top:
 * whatever JSON it is given, it drops `isSynchronized` rows, dedupes, and
 * restores write order. Fed from `getPendingAuditLog()` (which returns EVERY
 * row) it over-selects downloads — use the unshipped binding for drains.
 */
export function selectPendingUploads(
    auditLogJson: string,
    options: PendingSelectOptions = {},
): PendingUploadRow[] {
    let raw: unknown;
    try {
        raw = parseSafeAuditJSON(auditLogJson);
    } catch (err) {
        if (err instanceof RangeError) throw err;
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
        const raw = parseSafeAuditJSON(target.getPendingAuditLog());
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
    assertSafeAuditValue(rows);
    if (typeof target.importPendingFrame !== 'function') throw new Error('Native guarded pending import capability required');
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

    const chunkSize = options.chunkSize ?? 200;
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_PENDING_FRAME_ENTRIES) {
        throw new RangeError('chunkSize must be an integer between 1 and 1000');
    }
    const sleep = options.sleep ?? defaultSleep;
    const applied = new Set<string>();

    for (let i = 0; i < offer.length; i += chunkSize) {
        const chunk = offer.slice(i, i + chunkSize);
        try {
            const result = validatePendingImportResult(target.importPendingFrame(JSON.stringify(chunk)), chunk.map(row => row.globalId));
            for (const id of result.imported) applied.add(id);
            for (const id of result.alreadyPresent) { known.add(id); report.alreadyPresent++; }
        } catch (err) {
            // A throwing chunk leaves its rows unrecorded target-side, so they
            // stay pending in the source and a later drain retries them.
            console.warn('[Lattice] drain chunk failed:', err);
        }
        if (i + chunkSize < offer.length) await sleep(0);
    }

    for (const row of offer) {
        if (applied.has(row.globalId)) report.applied.push(row.globalId);
        else if (!known.has(row.globalId)) report.failed.push(row.globalId);
    }
    return report;
}

// ============================================================================
// Catch-up quiescence
// ============================================================================

export interface CatchUpQuietOptions {
    /** How long `received` must hold still to count as settled (default 1000ms). */
    quietMs?: number;
    /**
     * Never report quiet before this much time has passed (default 0).
     * Socket-open is NOT catch-up-begun: the server\'s replay can start after
     * a quiet window has already elapsed at `received === 0`, and a drain
     * that fires in that gap runs BEFORE catch-up — the exact inversion the
     * ordering note warns about. A minimum wait gives the first frame time
     * to arrive so the stillness signal measures something real.
     */
    minWaitMs?: number;
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
    const minWaitMs = options.minWaitMs ?? 0;
    const maxWaitMs = options.maxWaitMs ?? 15000;
    const pollMs = Math.max(1, options.pollMs ?? 250);
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());

    const started = now();
    let last = safeRead(readReceived);
    let lastChangedAt = started;

    for (;;) {
        const elapsed = now() - started;
        if (elapsed >= minWaitMs && now() - lastChangedAt >= quietMs) {
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
