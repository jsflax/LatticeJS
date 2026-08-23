// Orphaned-write drain tests.
//
// No wasm here (same approach as sync-socket.test.ts): the fakes below
// implement the two embind methods the drain uses — `getPendingAuditLog()` and
// `applyRemoteChanges()` — with the semantics wasm/bindings.cpp and
// LatticeCore give them:
//
//   * getPendingAuditLog() returns EVERY AuditLog row, synced included
//     (query_audit_log with only_unsynced = false);
//   * applyRemoteChanges() replays each entry's SQL keyed on the DATA row's
//     globalId (generate_instruction upserts on globalId, never on rowId),
//     then records the entry in AuditLog with isFromRemote = 1,
//     isSynchronized = 0 — the state the uploader picks up;
//   * the uploader sends AuditLog rows with isSynchronized = 0 above the
//     slot's upload floor (query_audit_log_for_sync, branch 2 — deliberately
//     no isFromRemote filter);
//   * an ACK sets isSynchronized = 1 (mark_audit_entries_synced);
//   * the server skips any entry whose audit globalId it already has
//     (receive(), "Skip if already in AuditLog (idempotent)").
//
// The orphan test reproduces the joyjet repro's shape — healthy write, socket
// death, write into the dead socket, fresh store under a NEW name, catch-up —
// and asserts both the loss and the rescue.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    selectPendingUploads,
    readPendingUploads,
    drainPendingUploads,
    waitForCatchUpQuiet,
    emptyDrainReport,
    type PendingUploadRow,
} from '../src/pending-drain';
import { whenSyncSocketOpen } from '../src/sync-socket';

// ============================================================================
// Fakes: a wasm-shaped store, and the server on the other end of the socket
// ============================================================================

type AuditRow = PendingUploadRow;

let clock = 0;
const stamp = () => `2026-08-23T00:00:${String(clock++).padStart(2, '0')}Z`;

class FakeStore {
    readonly path: string;
    /** AuditLog, ordered by id — the real table's only ordering guarantee. */
    log: AuditRow[] = [];
    /** table -> globalId -> row. The data tables. */
    tables = new Map<string, Map<string, Record<string, unknown>>>();
    /** The sync slot's upload floor: entries at or below it are never rescanned. */
    uploadFloor = 0;
    /** Whether the sync socket is alive. Dead = writes queue and never ship. */
    online = true;
    /** applyRemoteChanges calls, for chunking assertions. */
    applyCalls = 0;
    /** Table names that exist. An entry for anything else throws, like SQL would. */
    schema: Set<string>;

    private nextId = 1;

    constructor(path: string, schema: string[] = ['Activity']) {
        this.path = path;
        this.schema = new Set(schema);
        for (const t of schema) this.tables.set(t, new Map());
    }

    // ---- local writes (what the sqlite AuditLog trigger records) ----

    write(table: string, globalRowId: string, fields: Record<string, unknown>): AuditRow {
        this.rowsFor(table).set(globalRowId, { globalId: globalRowId, ...fields });
        return this.record({
            tableName: table,
            operation: 'INSERT',
            globalRowId,
            changedFields: fields,
            changedFieldsNames: Object.keys(fields),
            isFromRemote: false,
            isSynchronized: false,
        });
    }

    private record(partial: Omit<AuditRow, 'id' | 'globalId' | 'rowId' | 'timestamp'>): AuditRow {
        const row: AuditRow = {
            id: this.nextId++,
            globalId: `chg-${this.path}-${this.nextId}`,
            rowId: this.rowsFor(partial.tableName).size,
            timestamp: stamp(),
            ...partial,
        };
        this.log.push(row);
        return row;
    }

    private rowsFor(table: string): Map<string, Record<string, unknown>> {
        let rows = this.tables.get(table);
        if (!rows) this.tables.set(table, (rows = new Map()));
        return rows;
    }

    titles(table = 'Activity'): string[] {
        return [...this.rowsFor(table).values()].map((r) => String(r.title));
    }

    // ---- the two embind methods the drain uses ----

    getPendingAuditLog(): string {
        // ALL rows, synced included — the misnomer is faithful to the binding.
        return JSON.stringify(this.log);
    }

    applyRemoteChanges(entriesJson: string): string {
        this.applyCalls++;
        const entries = JSON.parse(entriesJson) as AuditRow[];
        const applied: string[] = [];
        for (const entry of entries) {
            if (!this.schema.has(entry.tableName)) continue;  // SQL would fail; C++ logs and skips
            this.applyData(entry);
            applied.push(entry.globalId);
            // INSERT OR REPLACE INTO AuditLog (..., isFromRemote=1, isSynchronized=0)
            const existing = this.log.findIndex((r) => r.globalId === entry.globalId);
            const recorded: AuditRow = {
                ...entry,
                id: this.nextId++,
                isFromRemote: true,
                isSynchronized: false,
            };
            if (existing >= 0) this.log.splice(existing, 1);
            this.log.push(recorded);
        }
        return JSON.stringify(applied);
    }

    private applyData(entry: AuditRow): void {
        const rows = this.rowsFor(entry.tableName);
        if (entry.operation === 'DELETE') { rows.delete(entry.globalRowId); return; }
        // Both INSERT (ON CONFLICT(globalId) DO UPDATE) and UPDATE key on the
        // DATA row's globalId — never on rowId, which is per-store.
        const current = rows.get(entry.globalRowId);
        if (!current && entry.operation === 'UPDATE') return;  // 0 rows changed
        rows.set(entry.globalRowId, { ...(current ?? { globalId: entry.globalRowId }), ...entry.changedFields });
    }

    // ---- ACK handling ----

    markSynced(globalIds: readonly string[]): void {
        const acked = new Set(globalIds);
        for (const row of this.log) if (acked.has(row.globalId)) row.isSynchronized = true;
    }
}

class FakeServer {
    /** audit globalId -> entry. The server's own AuditLog (its dedupe key). */
    log = new Map<string, AuditRow>();
    rows = new Map<string, Record<string, unknown>>();
    /** Entries that were NEW to the server — a duplicate delivery does not count. */
    applies = 0;

    /** receive(): dedupe on audit globalId, apply, ACK everything received. */
    receive(entries: readonly AuditRow[]): string[] {
        for (const entry of entries) {
            if (this.log.has(entry.globalId)) continue;
            this.log.set(entry.globalId, entry);
            this.applies++;
            const key = `${entry.tableName}/${entry.globalRowId}`;
            if (entry.operation === 'DELETE') this.rows.delete(key);
            else this.rows.set(key, { ...(this.rows.get(key) ?? {}), ...entry.changedFields });
        }
        return entries.map((e) => e.globalId);
    }

    titles(): string[] {
        return [...this.rows.values()].map((r) => String(r.title));
    }

    /** What a fresh store's catch-up delivers: every entry, marked synced. */
    catchUp(store: FakeStore): void {
        for (const entry of this.log.values()) {
            if (store.log.some((r) => r.globalId === entry.globalId)) continue;
            store.applyRemoteChanges(JSON.stringify([entry]));
            store.markSynced([entry.globalId]);
        }
    }
}

/** One upload pass: exactly what query_audit_log_for_sync + the ACK do. */
function uploadPass(store: FakeStore, server: FakeServer): number {
    if (!store.online) return 0;
    const pending = store.log.filter((r) => !r.isSynchronized && r.id > store.uploadFloor);
    if (pending.length === 0) return 0;
    const acked = server.receive(pending);
    store.markSynced(acked);
    store.uploadFloor = Math.max(store.uploadFloor, ...pending.map((r) => r.id));
    return pending.length;
}

// ============================================================================

describe('selectPendingUploads', () => {
    beforeEach(() => { clock = 0; });

    it('returns only un-ACKed rows, oldest first', () => {
        const store = new FakeStore('old');
        const a = store.write('Activity', 'row-a', { title: 'probe-A' });
        const b = store.write('Activity', 'row-b', { title: 'probe-B' });
        store.markSynced([a.globalId]);

        const pending = readPendingUploads(store);
        expect(pending.map((r) => r.globalId)).toEqual([b.globalId]);
        expect(pending[0].changedFields).toEqual({ title: 'probe-B' });
    });

    it('keeps write order even when the rows arrive shuffled', () => {
        const store = new FakeStore('old');
        store.write('Activity', 'row-a', { title: 'first' });
        store.write('Activity', 'row-b', { title: 'second' });
        const shuffled = JSON.stringify([...store.log].reverse());

        expect(selectPendingUploads(shuffled).map((r) => r.changedFields.title))
            .toEqual(['first', 'second']);
    });

    it('includes rows relayed in from a sibling — the uploader does not filter on origin', () => {
        const store = new FakeStore('old');
        const relayed: AuditRow = {
            id: 1, globalId: 'chg-relayed', tableName: 'Activity', operation: 'INSERT',
            rowId: 1, globalRowId: 'row-r', changedFields: { title: 'from-sibling' },
            changedFieldsNames: ['title'], timestamp: stamp(),
            isFromRemote: true, isSynchronized: false,
        };
        const json = JSON.stringify([relayed]);

        expect(selectPendingUploads(json)).toHaveLength(1);
        // ...and localOnly narrows to strictly local writes.
        expect(selectPendingUploads(json, { localOnly: true })).toHaveLength(0);
    });

    it('drops duplicate change ids and survives malformed input', () => {
        const row: AuditRow = {
            id: 1, globalId: 'chg-dupe', tableName: 'Activity', operation: 'INSERT',
            rowId: 1, globalRowId: 'row-a', changedFields: {}, changedFieldsNames: [],
            timestamp: stamp(), isFromRemote: false, isSynchronized: false,
        };
        expect(selectPendingUploads(JSON.stringify([row, { ...row, id: 2 }]))).toHaveLength(1);
        expect(selectPendingUploads('not json')).toEqual([]);
        expect(selectPendingUploads('{"rows":[]}')).toEqual([]);
    });
});

describe('the orphaned write (joyjet repro shape)', () => {
    let server: FakeServer;
    let oldStore: FakeStore;

    beforeEach(async () => {
        clock = 0;
        server = new FakeServer();
        oldStore = new FakeStore('trip-1000');

        // Healthy path: probe-A lands on the server.
        oldStore.write('Activity', 'row-a', { title: 'probe-A' });
        uploadPass(oldStore, server);
        expect(server.titles()).toEqual(['probe-A']);

        // The socket dies. The store keeps accepting writes it can never ship.
        oldStore.online = false;
        oldStore.write('Activity', 'row-b', { title: 'probe-B' });
        uploadPass(oldStore, server);
    });

    it('is lost by the fresh-store redial — the class this PR fixes', async () => {
        const fresh = new FakeStore('trip-2000');   // the app reopens under a NEW name
        server.catchUp(fresh);

        expect(server.titles()).toEqual(['probe-A']);        // never reached the server
        expect(fresh.titles()).toEqual(['probe-A']);         // not in the catch-up either
        // ...and it is still sitting in the abandoned store, readable.
        expect(readPendingUploads(oldStore).map((r) => r.changedFields.title)).toEqual(['probe-B']);
    });

    it('is rescued by draining the abandoned store into the fresh one', async () => {
        const fresh = new FakeStore('trip-2000');
        server.catchUp(fresh);

        const report = await drainPendingUploads(fresh, readPendingUploads(oldStore), {
            tables: ['Activity'],
        });
        expect(report).toMatchObject({ found: 1, alreadyPresent: 0, offered: 1, failed: [] });
        expect(report.applied).toHaveLength(1);

        // The rescued row is live locally AND uploads on the fresh socket.
        expect(fresh.titles().sort()).toEqual(['probe-A', 'probe-B']);
        expect(uploadPass(fresh, server)).toBe(1);
        expect(server.titles().sort()).toEqual(['probe-A', 'probe-B']);
    });

    it('appends the rescued rows AFTER the catch-up, above the upload floor', async () => {
        const fresh = new FakeStore('trip-2000');
        server.catchUp(fresh);
        uploadPass(fresh, server);
        const floorBefore = fresh.uploadFloor;

        await drainPendingUploads(fresh, readPendingUploads(oldStore), { tables: ['Activity'] });

        const drained = fresh.log[fresh.log.length - 1];
        expect(drained.changedFields.title).toBe('probe-B');
        expect(drained.id).toBeGreaterThan(floorBefore);
        // Every catch-up row precedes it, so a stale catch-up frame cannot
        // overwrite the rescued value.
        expect(fresh.log.slice(0, -1).every((r) => r.id < drained.id)).toBe(true);
    });

    it('re-draining the same store is a no-op, not a duplicate', async () => {
        const fresh = new FakeStore('trip-2000');
        server.catchUp(fresh);
        await drainPendingUploads(fresh, readPendingUploads(oldStore), { tables: ['Activity'] });
        uploadPass(fresh, server);
        const appliesAfterFirst = server.applies;
        const applyCallsAfterFirst = fresh.applyCalls;

        const second = await drainPendingUploads(fresh, readPendingUploads(oldStore), {
            tables: ['Activity'],
        });
        expect(second).toMatchObject({ found: 1, alreadyPresent: 1, offered: 0, applied: [] });
        // The skip happens BEFORE any write: the target was never touched.
        expect(fresh.applyCalls).toBe(applyCallsAfterFirst);
        expect(uploadPass(fresh, server)).toBe(0);
        expect(server.applies).toBe(appliesAfterFirst);
        expect(server.titles().sort()).toEqual(['probe-A', 'probe-B']);
    });

    it('dedupes server-side when the same orphan is drained into two stores', async () => {
        const first = new FakeStore('trip-2000');
        server.catchUp(first);
        await drainPendingUploads(first, readPendingUploads(oldStore), { tables: ['Activity'] });
        uploadPass(first, server);
        const appliesAfterFirst = server.applies;

        // A second redial (page reload) drains the SAME abandoned store again.
        const second = new FakeStore('trip-3000');
        server.catchUp(second);
        const report = await drainPendingUploads(second, readPendingUploads(oldStore), {
            tables: ['Activity'],
        });
        // The new store has the row from catch-up, under the SAME change id,
        // so the drain skips it before any write happens.
        expect(report).toMatchObject({ alreadyPresent: 1, offered: 0 });
        expect(uploadPass(second, server)).toBe(0);
        expect(server.applies).toBe(appliesAfterFirst);
        expect(server.titles().sort()).toEqual(['probe-A', 'probe-B']);
    });

    it('rescues a chain: a store that was itself drained into still has the row', async () => {
        // The rescue store's own socket dies before it can upload.
        const rescue = new FakeStore('trip-2000');
        server.catchUp(rescue);
        await drainPendingUploads(rescue, readPendingUploads(oldStore), { tables: ['Activity'] });
        rescue.online = false;
        expect(uploadPass(rescue, server)).toBe(0);

        // Drained rows are stamped isFromRemote — the default filter still
        // sees them, which is what keeps a second-generation rescue possible.
        const stillPending = readPendingUploads(rescue);
        expect(stillPending.map((r) => r.changedFields.title)).toEqual(['probe-B']);
        expect(readPendingUploads(rescue, { localOnly: true })).toEqual([]);

        const third = new FakeStore('trip-3000');
        server.catchUp(third);
        await drainPendingUploads(third, stillPending, { tables: ['Activity'] });
        uploadPass(third, server);
        expect(server.titles().sort()).toEqual(['probe-A', 'probe-B']);
    });
});

describe('drainPendingUploads', () => {
    beforeEach(() => { clock = 0; });

    it('reports nothing to do for an empty source', async () => {
        const target = new FakeStore('new');
        await expect(drainPendingUploads(target, [])).resolves.toEqual(emptyDrainReport());
        expect(target.applyCalls).toBe(0);
    });

    it('skips rows for tables the target does not have', async () => {
        const source = new FakeStore('old', ['Activity', 'Ghost']);
        source.write('Activity', 'row-a', { title: 'kept' });
        source.write('Ghost', 'row-g', { title: 'dropped' });
        const target = new FakeStore('new', ['Activity']);

        const report = await drainPendingUploads(target, readPendingUploads(source), {
            tables: ['Activity'],
        });
        expect(report).toMatchObject({ found: 2, unknownTable: 1, offered: 1 });
        expect(report.applied).toHaveLength(1);
    });

    it('never drops link/list join tables — the graph edges are not @model tables', async () => {
        // Found live by the joyjet repro: `tables` comes from schemas, which
        // only lists @model tables, so the `_Day_Activity_activities` edge row
        // was skipped and the rescued Activity arrived on the server detached
        // from its Day — present, and invisible to every graph query.
        const source = new FakeStore('old', ['Activity', '_Day_Activity_activities']);
        source.write('Activity', 'row-a', { title: 'probe-B' });
        source.write('_Day_Activity_activities', 'edge-1', { lhs: 'day-1', rhs: 'row-a' });
        const target = new FakeStore('new', ['Activity', '_Day_Activity_activities']);

        const report = await drainPendingUploads(target, readPendingUploads(source), {
            tables: ['Activity'],   // exactly what schemas gives you
        });
        expect(report).toMatchObject({ found: 2, unknownTable: 0, offered: 2 });
        expect(target.tables.get('_Day_Activity_activities')!.size).toBe(1);
    });

    it('chunks large batches instead of one unbroken pass', async () => {
        const source = new FakeStore('old');
        for (let i = 0; i < 5; i++) source.write('Activity', `row-${i}`, { title: `t${i}` });
        const target = new FakeStore('new');
        const sleep = vi.fn(async () => {});

        const report = await drainPendingUploads(target, readPendingUploads(source), {
            chunkSize: 2, sleep,
        });
        expect(target.applyCalls).toBe(3);      // 2 + 2 + 1
        expect(sleep).toHaveBeenCalledTimes(2); // between chunks only
        expect(report.applied).toHaveLength(5);
        expect(target.titles()).toEqual(['t0', 't1', 't2', 't3', 't4']);
    });

    it('reports a failing chunk instead of throwing, and retries it next time', async () => {
        const source = new FakeStore('old');
        source.write('Activity', 'row-a', { title: 'boom' });
        const target = new FakeStore('new');
        const realApply = target.applyRemoteChanges.bind(target);
        let failed = false;
        target.applyRemoteChanges = (json: string) => {
            if (!failed) { failed = true; throw new Error('SQL FAILED'); }
            return realApply(json);
        };

        const first = await drainPendingUploads(target, readPendingUploads(source));
        expect(first).toMatchObject({ offered: 1, applied: [] });
        expect(first.failed).toHaveLength(1);

        // Nothing was recorded target-side, so the row is still drainable.
        const second = await drainPendingUploads(target, readPendingUploads(source));
        expect(second.applied).toHaveLength(1);
        expect(target.titles()).toEqual(['boom']);
    });

    it('still delivers when the target audit log cannot be read for dedupe', async () => {
        const source = new FakeStore('old');
        source.write('Activity', 'row-a', { title: 'probe' });
        const target = new FakeStore('new');
        target.getPendingAuditLog = () => 'not json';

        const report = await drainPendingUploads(target, readPendingUploads(source));
        expect(report.applied).toHaveLength(1);
    });

    it('replays UPDATEs onto the row identified by globalId, not by rowId', async () => {
        // The whole reason cross-store replay works: row ids differ per store.
        const source = new FakeStore('old');
        source.write('Activity', 'row-a', { title: 'v1' });
        const edit = source.log[0];
        const update: PendingUploadRow = {
            ...edit, id: 99, globalId: 'chg-update', operation: 'UPDATE',
            rowId: 4242, changedFields: { title: 'v2' }, changedFieldsNames: ['title'],
        };

        const target = new FakeStore('new');
        target.write('Activity', 'row-a', { title: 'v1' });  // same row, different rowId
        await drainPendingUploads(target, [update]);

        expect(target.titles()).toEqual(['v2']);
    });
});

describe('waitForCatchUpQuiet', () => {
    it('settles once the received counter holds still', async () => {
        let now = 0;
        let received = 0;
        const sleep = async (ms: number) => { now += ms; };
        // Two more entries arrive, then catch-up stops.
        const reads = [0, 1, 2, 2, 2, 2, 2];
        let i = 0;

        const result = await waitForCatchUpQuiet(() => (received = reads[Math.min(i++, reads.length - 1)]), {
            quietMs: 500, pollMs: 250, maxWaitMs: 10000, sleep, now: () => now,
        });
        expect(result.quiet).toBe(true);
        expect(result.received).toBe(2);
        expect(result.waitedMs).toBeGreaterThan(0);
    });

    it('gives up at the hard cap rather than blocking the rescue forever', async () => {
        let now = 0;
        let received = 0;
        const sleep = async (ms: number) => { now += ms; };

        const result = await waitForCatchUpQuiet(() => ++received, {
            quietMs: 500, pollMs: 100, maxWaitMs: 1000, sleep, now: () => now,
        });
        expect(result.quiet).toBe(false);
        expect(result.waitedMs).toBeGreaterThanOrEqual(1000);
    });

    it('treats a store that throws (deleted wasm instance) as quiet', async () => {
        let now = 0;
        const result = await waitForCatchUpQuiet(() => { throw new Error('BindingError'); }, {
            quietMs: 100, pollMs: 50, maxWaitMs: 1000,
            sleep: async (ms) => { now += ms; }, now: () => now,
        });
        expect(result.quiet).toBe(true);
    });
});

describe('whenSyncSocketOpen', () => {
    const OPEN = 1;
    const CONNECTING = 0;

    class FakeSocket {
        readyState = CONNECTING;
        url = 'ws://localhost:8080/sync';
        private listeners = new Map<string, Set<Function>>();
        close(): void {}
        addEventListener(type: string, fn: Function): void {
            let set = this.listeners.get(type);
            if (!set) this.listeners.set(type, (set = new Set()));
            set.add(fn);
        }
        removeEventListener(type: string, fn: Function): void { this.listeners.get(type)?.delete(fn); }
        open(): void {
            this.readyState = OPEN;
            for (const fn of this.listeners.get('open') ?? []) fn.call(this, {});
        }
        attached(): number {
            let n = 0;
            for (const s of this.listeners.values()) n += s.size;
            return n;
        }
    }

    it('resolves immediately for an already-open socket', async () => {
        const sock = new FakeSocket();
        sock.readyState = OPEN;
        await expect(whenSyncSocketOpen([sock as any], 1000)).resolves.toBe(true);
    });

    it('resolves when the handshake completes, and detaches its listener', async () => {
        const sock = new FakeSocket();
        const waiting = whenSyncSocketOpen([sock as any], 1000);
        sock.open();
        await expect(waiting).resolves.toBe(true);
        expect(sock.attached()).toBe(0);
    });

    it('resolves false when nothing opens in time, and when there is no socket', async () => {
        const sock = new FakeSocket();
        await expect(whenSyncSocketOpen([sock as any], 0)).resolves.toBe(false);
        await expect(whenSyncSocketOpen([], 1000)).resolves.toBe(false);
    });

    it('works on a stub socket with no addEventListener (poll fallback)', async () => {
        const stub = { readyState: CONNECTING, url: 'ws://x', close() {}, removeEventListener() {} };
        const waiting = whenSyncSocketOpen([stub as any], 5000, async () => { stub.readyState = OPEN; });
        await expect(waiting).resolves.toBe(true);
    });
});
