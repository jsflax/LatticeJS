import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { SyncStateInfo } from '../src/types';

const { fakeWasmPath } = vi.hoisted(() => ({
    fakeWasmPath: new URL('./fixtures/lifecycle-wasm.js', import.meta.url).pathname,
}));
vi.mock('../wasm/build/lattice.js?url', () => ({ default: fakeWasmPath }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/fake/lattice.wasm' }));

class Socket {
    readyState = 0;
    _lattice_client = 0;
    listeners = new Map<string, Set<(event: any) => void>>();
    hangClose = false;
    constructor(readonly url: string) {}
    addEventListener(type: string, callback: (event: any) => void) {
        const values = this.listeners.get(type) ?? new Set(); values.add(callback); this.listeners.set(type, values);
    }
    removeEventListener(type: string, callback: (event: any) => void) { this.listeners.get(type)?.delete(callback); }
    emit(type: string, event = {}) { for (const callback of [...(this.listeners.get(type) ?? [])]) callback(event); }
    open() { this.readyState = 1; this.emit('open'); }
    close() {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        if (!this.hangClose) { this.readyState = 3; this.emit('close', { code: 1000, reason: '' }); }
    }
}

let control: any;
beforeEach(() => {
    vi.resetModules();
    control = { stores: new Map(), handles: [], nextClient: 1, requests: 0, releases: 0, deletes: 0, purges: 0, pending: () => 0 };
    vi.stubGlobal('__latticeLifecycleTest', control);
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

async function library() {
    const { Lattice } = await import('../src/lattice');
    const { model } = await import('../src/decorators');
    class Note { title = ''; }
    return { Lattice, Note: model(Note) };
}
const sync = { websocketUrl: 'wss://example.test/sync', authToken: 'not-a-real-token' };

describe('Lattice instance lifecycle', () => {
    it('registers before native construction and isolates stores sharing an endpoint', async () => {
        const { Lattice, Note } = await library();
        const first: SyncStateInfo[] = [], second: SyncStateInfo[] = [];
        const a = await Lattice.open(':memory:a', [Note], { sync, onSyncState(info) {
            if (!first.length) expect(control.handles).toHaveLength(0);
            first.push(info);
        } });
        const b = await Lattice.open(':memory:b', [Note], { sync, onSyncState: info => second.push(info) });
        control.handles[0].store.socket.open();
        expect(first.map(v => v.state)).toEqual(['connecting', 'open']);
        expect(second.map(v => v.state)).toEqual(['connecting']);
        expect(first[0].instanceId).not.toBe(second[0].instanceId);
        await a.close();
        control.handles[1].store.socket.open();
        expect(second.at(-1)?.state).toBe('open');
        await b.close();
    });

    it('replays shared current state and closes only the last exact native owner', async () => {
        const { Lattice, Note } = await library();
        const a = await Lattice.open(':memory:shared', [Note], { sync });
        control.handles[0].store.socket.open();
        const events: SyncStateInfo[] = [];
        const b = await Lattice.open(':memory:shared', [Note], { sync, onSyncState: info => events.push(info) });
        expect(events.map(v => v.state)).toEqual(['connecting', 'open']);
        expect(await a.close()).toMatchObject({ native: 'shared', transport: 'shared' });
        expect(control.handles[1].store.socket.readyState).toBe(1);
        const off = b.onSyncState(info => events.push(info)); off(); off();
        expect(await b.close()).toMatchObject({ native: 'closed', transport: 'closed' });
    });

    it('retires callbacks synchronously and destroys native state on a later task exactly once', async () => {
        const { Lattice, Note } = await library(); const events: string[] = [];
        const db = await Lattice.open(':memory:retire', [Note], { sync, onSyncState: info => events.push(info.state) });
        let rows = 0; db.observeTable(Note, () => rows++);
        const handle = control.handles[0], savedCallback = [...handle.observers.values()][0] as () => void;
        const closing = db.close();
        expect(db.close()).toBe(closing);
        expect(control.releases).toBe(0);
        handle.store.socket.open(); savedCallback();
        db.onSyncState(() => events.push('late'));
        expect(rows).toBe(0); expect(events).toEqual(['connecting']);
        expect(await closing).toEqual({ native: 'closed', transport: 'closed', uploads: 'not-requested', snapshot: 'not-persistent' });
        expect(control.releases).toBe(1); expect(control.deletes).toBe(1); expect(control.requests).toBe(0);
    });

    it('awaits opt-in upload ACK progress without blocking the event loop', async () => {
        const { Lattice, Note } = await library();
        const db = await Lattice.open(':memory:drain', [Note], { sync });
        let pending = 1; control.pending = () => pending;
        control.request = () => setTimeout(() => { pending = 0; }, 5);
        expect(await db.close({ uploadTimeoutMs: 100 })).toMatchObject({ uploads: 'drained', native: 'closed' });
        expect(control.requests).toBe(1);
    });

    it('reports upload and transport timeouts independently while releasing native storage', async () => {
        const { Lattice, Note } = await library();
        const db = await Lattice.open(':memory:timeouts', [Note], { sync });
        control.pending = () => 1; control.handles[0].store.socket.hangClose = true;
        expect(await db.close({ uploadTimeoutMs: 5, transportTimeoutMs: 5 })).toMatchObject({ uploads: 'timeout', transport: 'timeout', native: 'closed' });
    });

    it('does not treat a failed pending count as zero or silently claim legacy cleanup', async () => {
        const { Lattice, Note } = await library();
        const db = await Lattice.open(':memory:error', [Note], { sync });
        control.pending = () => { throw new Error('count failed'); };
        control.handles[0].releaseStorage = () => undefined;
        expect(await db.close({ uploadTimeoutMs: 5 })).toMatchObject({ uploads: 'unavailable', native: 'unsupported' });
    });

    it('retains native storage through a timed-out OPFS save and releases after it settles', async () => {
        const { Lattice, Note } = await library();
        let finish!: () => void;
        const writing = new Promise<void>(resolve => { finish = resolve; });
        control.snapshotBytes = new Uint8Array([1]);
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({
            getDirectoryHandle: async (_name: string, options: { create: boolean }) => {
                if (!options.create) throw new Error('no existing snapshot');
                return { getFileHandle: async () => ({ createWritable: async () => ({ write: () => writing, close: async () => {} }) }) };
            },
        }) } });
        const db = await Lattice.open('pending-snapshot.db', [Note], { sync });
        const result = await db.close({ snapshotTimeoutMs: 5 });
        expect(result).toMatchObject({ native: 'pending', snapshot: 'timeout', transport: 'closed' });
        expect(control.releases).toBe(0);
        finish(); await new Promise(resolve => setTimeout(resolve, 0));
        expect(control.releases).toBe(1); expect(control.deletes).toBe(1);
        expect(await db.close()).toBe(result);
    });

    it('tracks native handoffs and does not close a shared socket before sibling watcher delivery', async () => {
        const { Lattice, Note } = await library(); const states: SyncStateInfo[] = [];
        const a = await Lattice.open(':memory:handoff', [Note], { sync, onSyncState: value => states.push(value) });
        const b = await Lattice.open(':memory:handoff', [Note], { sync });
        const first = control.handles[0], second = control.handles[1];
        const old = first.store.socket; old.open();
        const replacement = new Socket(sync.websocketUrl); replacement.open();
        first.store.socket = replacement;
        // Only A's async native watcher has delivered. B still holds the old JS lease.
        for (const watch of first.watchers.values()) watch(replacement);
        expect(states.at(-1)).toMatchObject({ state: 'open', connectionGeneration: 2 });
        const lateWatch = [...first.watchers.values()][0] as (socket: Socket) => void;
        const closing = a.close(); lateWatch(old);
        expect(await closing).toMatchObject({ native: 'shared', transport: 'shared' });
        expect(replacement.readyState).toBe(1);
        expect(await b.close()).toMatchObject({ native: 'closed', transport: 'closed' });
        expect(replacement.readyState).toBe(3);
    });

    it('removes progress subscriptions once and makes a copied callback inert', async () => {
        const { Lattice, Note } = await library(); const db = await Lattice.open(':memory:progress', [Note], { sync });
        let called = 0;
        const off = db.onSyncProgress(() => called++);
        const callback = [...control.handles[0].observers.values()][0] as () => void;
        callback(); off(); off(); callback();
        expect(called).toBe(1); expect(control.progressRemoved).toBe(1);
        db.onSyncProgress(() => called++);
        const late = [...control.handles[0].observers.values()][0] as () => void;
        const closing = db.close(); late();
        expect(called).toBe(1);
        await closing; expect(control.progressRemoved).toBe(2);
    });

    it('cleans up a handle when exact socket lookup or watch registration fails', async () => {
        const { Lattice, Note } = await library(); control.getterError = true;
        await expect(Lattice.open(':memory:getter-error', [Note], { sync })).rejects.toThrow('getter failure');
        expect(control.releases).toBe(1); expect(control.deletes).toBe(1);
        control.getterError = false; control.watchError = true;
        await expect(Lattice.open(':memory:watch-error', [Note], { sync })).rejects.toThrow('watch failure');
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(control.releases).toBe(2); expect(control.deletes).toBe(2);
    });

    it('requires the full native lifecycle capability before reporting storage cleanup', async () => {
        const { Lattice, Note } = await library();
        const db = await Lattice.open(':memory:legacy', [Note], { sync });
        control.handles[0].requestSyncUpload = undefined;
        expect(await db.close()).toMatchObject({ native: 'unsupported' });
    });

    it('cancels resume waiting immediately and suppresses its report after close', async () => {
        const { Lattice, Note } = await library(); const report = vi.fn();
        const db = await Lattice.open(':memory:resume', [Note], { sync, resumePendingFrom: 'old.db', onResumePending: report });
        const handle = control.handles[0];
        await db.close();
        expect(handle.watchers.size).toBe(0);
        expect((db as any).stopWaits.size).toBe(0);
        expect(report).not.toHaveBeenCalled();
        await expect(db.drainPendingFrom('old.db')).rejects.toThrow('closing or closed');
    });

    it('stops an in-flight drain before another yielded chunk can touch released storage', async () => {
        const { Lattice, Note } = await library(); const db = await Lattice.open(':memory:chunks', [Note], { sync });
        control.pendingRows = Array.from({ length: 201 }, (_, i) => ({
            id: i + 1, globalId: `audit-${i}`, tableName: 'Note', operation: 'INSERT',
            globalRowId: `row-${i}`, changedFields: '{}', timestamp: '2026-09-19', isSynchronized: false,
        }));
        let closing!: ReturnType<typeof db.close>;
        control.onApply = () => { closing = db.close(); expect(control.handles[0].released).not.toBe(true); };
        await expect(db.drainPendingFrom('old.db')).rejects.toThrow('closing or closed');
        expect(control.applies).toBe(1);
        await closing;
        expect(control.handles[0].released).toBe(true);
    });

    it('joins concurrent first opens onto one WASM module and retries a rejected initialization', async () => {
        const { Lattice, Note } = await library(); control.factoryError = true;
        await expect(Lattice.open(':memory:failed-load', [Note])).rejects.toThrow('factory failure');
        control.factoryError = false;
        const [a, b] = await Promise.all([
            Lattice.open(':memory:concurrent-a', [Note], { sync }),
            Lattice.open(':memory:concurrent-b', [Note], { sync }),
        ]);
        expect(control.factories).toBe(2); // One failed load, then one successful shared initialization.
        await Promise.all([a.close(), b.close()]);
    });

    it('cleans persistent housekeeping and native ownership if observer setup throws', async () => {
        const { Lattice, Note } = await library(); control.observeError = true;
        const add = vi.fn(), remove = vi.fn();
        vi.stubGlobal('document', { addEventListener: add, removeEventListener: remove });
        vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });
        const clear = vi.spyOn(globalThis, 'clearInterval');
        await expect(Lattice.open('observer-failure.db', [Note], { sync })).rejects.toThrow('observe failure');
        expect(control.handles[0].watchers.size).toBe(0);
        expect(control.releases).toBe(1); expect(control.deletes).toBe(1);
        expect(clear).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
        clear.mockRestore();
    });

    it('keeps a deferred first native transport connecting and resumes waiting on its actual open', async () => {
        const { Lattice, Note } = await library(); const states: SyncStateInfo[] = [];
        control.stores.set(':memory:lazy', { socket: null, holders: 0 });
        const db = await Lattice.open(':memory:lazy', [Note], {
            sync, onSyncState: info => states.push(info), resumePendingFrom: 'old.db',
        });
        expect(states.map(info => info.state)).toEqual(['connecting']);
        expect((db as any).stopWaits.size).toBe(1);
        db.onSyncState(null); // Public listener reset must not retire internal readiness.
        const socket = new Socket(sync.websocketUrl);
        const handle = control.handles[0]; handle.store.socket = socket;
        for (const watch of handle.watchers.values()) watch(socket);
        socket.open();
        expect(states).toHaveLength(1);
        let current: SyncStateInfo | undefined; db.onSyncState(info => { current = info; });
        expect(current).toMatchObject({ state: 'open', connectionGeneration: 1 });
        await Promise.resolve();
        expect((db as any).stopWaits.size).toBe(1); // Catch-up sleep replaced readiness; it did not time out.
        expect(control.progressReads).toBe(1);
        await db.close(); expect((db as any).stopWaits.size).toBe(0);
    });

    it('counts modern exact sockets without replacing the realm WebSocket constructor', async () => {
        const { Lattice, Note } = await library();
        const { liveSyncSocketCount } = await import('../src/sync-socket');
        const original = globalThis.WebSocket;
        const a = await Lattice.open(':memory:diagnostic', [Note], { sync });
        const b = await Lattice.open(':memory:diagnostic', [Note], { sync });
        expect(globalThis.WebSocket).toBe(original);
        expect(liveSyncSocketCount()).toBe(1);
        await a.close(); expect(liveSyncSocketCount()).toBe(1);
        await b.close(); expect(liveSyncSocketCount()).toBe(0);
    });

    it('rejects invalid timeout policy without beginning disposal', async () => {
        const { Lattice, Note } = await library();
        const db = await Lattice.open(':memory:options', [Note], { sync });
        expect(() => db.close({ transportTimeoutMs: Infinity })).toThrow(RangeError);
        expect(() => db.close({ snapshotTimeoutMs: -1 })).toThrow(RangeError);
        expect(() => db.close({ uploadTimeoutMs: 30001 })).toThrow(RangeError);
        await db.close();
    });
});
