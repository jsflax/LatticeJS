import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { LatticeReconnectOptions, SyncStateInfo } from '../src/index';

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
    constructor(readonly url: string) { (control.rawSockets ??= []).push(this); }
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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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

    it('admitted close waits for the physical socket while native storage and callbacks retire', async () => {
        const { Lattice, Note } = await library(); const states: SyncStateInfo[] = [];
        control.admissionSupported = true;
        const db = await Lattice.open(':memory:admitted-delay', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: async () => {} }, onSyncState: value => states.push(value),
        });
        const raw = control.rawSockets[0] as Socket; raw.open(); raw.hangClose = true;
        const proxy = control.handles[0].store.socket;
        let completed = false;
        const closing = db.close({ transportTimeoutMs: 1000 }).then(result => { completed = true; return result; });
        expect(proxy.readyState).toBe(3); expect(raw.readyState).toBe(2);
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(control.releases).toBe(1); expect(completed).toBe(false);
        raw.readyState = 3; raw.emit('close', { code: 1000, reason: '' });
        expect(await closing).toEqual({ native: 'closed', transport: 'closed', uploads: 'not-requested', snapshot: 'not-persistent' });
        expect(states.at(-1)?.state).toBe('open');
        expect(raw.listeners.get('close')?.size).toBe(0);
    });

    it('admitted close reports a physical timeout even though its proxy is already CLOSED', async () => {
        const { Lattice, Note } = await library();
        control.admissionSupported = true;
        const db = await Lattice.open(':memory:admitted-timeout', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: async () => {} },
        });
        const raw = control.rawSockets[0] as Socket; raw.open(); raw.hangClose = true;
        const closing = db.close({ transportTimeoutMs: 0 });
        expect(control.handles[0].store.socket.readyState).toBe(3);
        const result = await closing;
        expect(result).toEqual({ native: 'closed', transport: 'timeout', uploads: 'not-requested', snapshot: 'not-persistent' });
        raw.readyState = 3; raw.emit('close', { code: 1000, reason: '' });
        expect(raw.listeners.get('close')?.size).toBe(0);
        expect(await db.close()).toBe(result); // A later event cannot rewrite the original receipt.
    });

    it('admitted physical tracking retains legacy queued-frame purge and client detachment', async () => {
        const { Lattice, Note } = await library(); control.admissionSupported = true;
        const db = await Lattice.open(':memory:admitted-legacy-cleanup', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: async () => {} },
        });
        const handle = control.handles[0], proxy = handle.store.socket;
        const raw = control.rawSockets[0] as Socket; raw.open(); raw.hangClose = true;
        handle.prepareClose = undefined; // Admission capability alone is not the full lifecycle capability.
        const closing = db.close({ transportTimeoutMs: 0 });
        const result = await closing;
        expect(control.purges).toBe(1); expect(proxy._lattice_client).toBe(0);
        expect(result).toMatchObject({ native: 'unsupported', transport: 'timeout' });
        raw.readyState = 3; raw.emit('close', { code: 1000, reason: '' });
        expect(raw.listeners.get('close')?.size).toBe(0);
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

describe('explicit same-store reconnect', () => {
    it('coalesces requests, awaits physical closure and preserves the store and observers', async () => {
        const { Lattice, Note } = await library(); control.admissionSupported = true;
        const attempts: Array<{ connectionGeneration: number; signal: AbortSignal }> = [];
        const states: SyncStateInfo[] = [];
        const db = await Lattice.open(':memory:reconnect', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: async context => { attempts.push(context); } },
            onSyncState: state => states.push(state),
        });
        const native = control.handles[0], store = native.store, old = control.rawSockets[0] as Socket;
        old.open(); old.hangClose = true;
        let rows = 0; db.observeTable(Note, () => rows++);
        const callback = [...native.observers.values()][0] as () => void;
        const options: LatticeReconnectOptions = { timeoutMs: 1000 };
        const reconnect: Promise<SyncStateInfo> = db.reconnectSync(options);
        expect(db.reconnectSync({ timeoutMs: 1 })).toBe(reconnect);
        expect(control.disconnects ?? 0).toBe(0); // Native callback stack has not unwound yet.
        await vi.waitFor(() => expect(old.readyState).toBe(2));
        expect(states.at(-1)?.state).toBe('closed');
        expect(attempts.map(value => value.connectionGeneration)).toEqual([1]);
        expect(attempts[0].signal.aborted).toBe(true);
        expect(control.connects ?? 0).toBe(0); expect(control.rawSockets).toHaveLength(1);
        old.readyState = 3; old.emit('close');
        await vi.waitFor(() => expect(control.rawSockets).toHaveLength(2));
        const replacement = control.rawSockets[1] as Socket; replacement.open();
        expect(await reconnect).toMatchObject({ state: 'open', instanceId: states[0].instanceId, connectionGeneration: 2 });
        expect(attempts.map(value => value.connectionGeneration)).toEqual([1, 2]);
        expect(attempts[1].signal).not.toBe(attempts[0].signal);
        expect(control.handles).toHaveLength(1); expect(native.store).toBe(store);
        expect(control.releases).toBe(0); expect(control.deletes).toBe(0);
        callback(); expect(rows).toBe(1); expect(native.observers.size).toBe(1);
        expect(control.disconnects).toBe(1); expect(control.connects).toBe(1);
        await db.close(); callback(); expect(rows).toBe(1);
    });

    it('allows recovery from a native callback only after its stack unwinds', async () => {
        const { Lattice, Note } = await library(); const db = await Lattice.open(':memory:callback-reconnect', [Note], { sync });
        let reconnect!: Promise<SyncStateInfo>;
        db.observeTable(Note, () => { reconnect = db.reconnectSync({ timeoutMs: 1000 }); });
        control.executing = true;
        ([...control.handles[0].observers.values()][0] as () => void)();
        expect(control.disconnects ?? 0).toBe(0);
        control.executing = false;
        await vi.waitFor(() => expect(control.rawSockets).toHaveLength(2));
        control.rawSockets[1].open(); expect((await reconnect).state).toBe('open');
        await db.close();
    });

    it('refuses shared native ownership before interrupting a sibling socket or observer', async () => {
        const { Lattice, Note } = await library();
        const first = await Lattice.open(':memory:shared-reconnect', [Note], { sync });
        const second = await Lattice.open(':memory:shared-reconnect', [Note], { sync });
        const socket = control.rawSockets[0] as Socket; socket.open();
        let rows = 0; second.observeTable(Note, () => rows++);
        await expect(first.reconnectSync()).rejects.toThrow('exclusive native owner');
        expect(socket.readyState).toBe(1); expect(control.rawSockets).toHaveLength(1);
        expect(control.disconnects ?? 0).toBe(0); expect(control.connects ?? 0).toBe(0);
        ([...control.handles[1].observers.values()][0] as () => void)(); expect(rows).toBe(1);
        expect(await first.close()).toMatchObject({ native: 'shared', transport: 'shared' });
        await second.close();
    });

    it('rechecks shared ownership after the asynchronous physical-close barrier', async () => {
        const { Lattice, Note } = await library();
        const first = await Lattice.open(':memory:late-shared', [Note], { sync });
        const old = control.rawSockets[0] as Socket; old.hangClose = true;
        const failed = first.reconnectSync({ timeoutMs: 1000 }).catch(error => error);
        await vi.waitFor(() => expect(old.readyState).toBe(2));
        const second = await Lattice.open(':memory:late-shared', [Note], { sync });
        old.readyState = 3; old.emit('close');
        expect(await failed).toMatchObject({ message: 'Sync reconnect requires an exclusive native owner' });
        expect(control.connects ?? 0).toBe(0); expect(control.rawSockets).toHaveLength(1);
        await first.close(); await second.close();
    });

    it('refuses unknown physical closure, then recovers only after the real close arrives', async () => {
        const { Lattice, Note } = await library(); control.admissionSupported = true;
        const admission = vi.fn(async () => {});
        const db = await Lattice.open(':memory:unknown-close', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: admission },
        });
        await vi.waitFor(() => expect(control.rawSockets).toHaveLength(1));
        const old = control.rawSockets[0] as Socket; old.open(); old.hangClose = true;
        vi.useFakeTimers();
        const failed = db.reconnectSync({ timeoutMs: 20 }).catch(error => error);
        await vi.advanceTimersByTimeAsync(20);
        expect((await failed).message).toMatch(/timed out|closure is unknown/);
        vi.useRealTimers();
        expect(control.rawSockets).toHaveLength(1); expect(admission).toHaveBeenCalledTimes(1);
        expect(control.connects ?? 0).toBe(0);
        old.readyState = 3; old.emit('close');
        const retry = db.reconnectSync({ timeoutMs: 1000 });
        await vi.waitFor(() => expect(control.rawSockets).toHaveLength(2));
        control.rawSockets[1].open(); expect((await retry).connectionGeneration).toBe(2);
        expect(admission).toHaveBeenCalledTimes(2); await db.close();
    });

    it('close cancels a waiting reconnect without claiming the still-closing transport is closed', async () => {
        const { Lattice, Note } = await library(); control.admissionSupported = true;
        const db = await Lattice.open(':memory:close-during-reconnect', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: async () => {} },
        });
        const old = control.rawSockets[0] as Socket; old.hangClose = true;
        const failed = db.reconnectSync({ timeoutMs: 1000 }).catch(error => error);
        await vi.waitFor(() => expect(old.readyState).toBe(2));
        const closed = await db.close({ transportTimeoutMs: 0 });
        expect(await failed).toBeInstanceOf(Error);
        expect(closed).toMatchObject({ native: 'closed', transport: 'timeout' });
        expect(control.rawSockets).toHaveLength(1); expect(control.connects ?? 0).toBe(0);
        old.readyState = 3; old.emit('close');
        expect(old.listeners.get('close')?.size).toBe(0);
    });

    it('revocation cancels fresh admission and its late completion never constructs a socket', async () => {
        const { Lattice, Note } = await library(); control.admissionSupported = true;
        const owner = new AbortController(); let finish!: () => void; let secondSignal!: AbortSignal;
        const held = new Promise<void>(resolve => { finish = resolve; });
        const db = await Lattice.open(':memory:revoke-reconnect', [Note], {
            sync: { websocketUrl: sync.websocketUrl, signal: owner.signal, beforeConnect: async context => {
                if (context.connectionGeneration === 2) { secondSignal = context.signal; await held; }
            } },
        });
        const failed = db.reconnectSync({ timeoutMs: 1000 }).catch(error => error);
        await vi.waitFor(() => expect(secondSignal).toBeDefined());
        owner.abort(); expect(secondSignal.aborted).toBe(true);
        expect(await failed).toBeInstanceOf(Error);
        finish(); await Promise.resolve(); await Promise.resolve();
        expect(control.rawSockets).toHaveLength(1);
        expect(() => db.reconnectSync()).toThrow('Sync admission owner is closed');
        expect(await db.close()).toMatchObject({ native: 'closed', transport: 'closed' });
    });

    it('an open timeout retires pending admission but preserves explicit retry and its next generation', async () => {
        const { Lattice, Note } = await library(); control.admissionSupported = true;
        let finish!: () => void; let pendingSignal!: AbortSignal;
        const held = new Promise<void>(resolve => { finish = resolve; });
        const generations: number[] = [];
        const db = await Lattice.open(':memory:open-timeout-reconnect', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: async context => {
                generations.push(context.connectionGeneration);
                if (context.connectionGeneration === 2) { pendingSignal = context.signal; await held; }
            } },
        });
        vi.useFakeTimers();
        const failed = db.reconnectSync({ timeoutMs: 30 }).catch(error => error);
        await vi.advanceTimersByTimeAsync(5);
        expect(pendingSignal).toBeDefined();
        await vi.advanceTimersByTimeAsync(30);
        expect((await failed).message).toBe('Sync reconnect timed out.');
        vi.useRealTimers();
        expect(pendingSignal.aborted).toBe(true);
        finish(); await Promise.resolve(); await Promise.resolve();
        expect(control.rawSockets).toHaveLength(1); expect(generations).toEqual([1, 2]);
        const retry = db.reconnectSync({ timeoutMs: 1000 });
        await vi.waitFor(() => expect(control.rawSockets).toHaveLength(2));
        control.rawSockets[1].open(); expect((await retry).connectionGeneration).toBe(3);
        expect(generations).toEqual([1, 2, 3]); await db.close();
    });

    it('rejects refused fresh admission without an automatic second attempt', async () => {
        const { Lattice, Note } = await library(); control.admissionSupported = true;
        const generations: number[] = [];
        const db = await Lattice.open(':memory:refused-reconnect', [Note], {
            sync: { websocketUrl: sync.websocketUrl, beforeConnect: async context => {
                generations.push(context.connectionGeneration);
                if (context.connectionGeneration === 2) throw new Error('private host refusal');
            } },
        });
        await expect(db.reconnectSync({ timeoutMs: 1000 })).rejects.toThrow('Sync reconnect did not open');
        expect(generations).toEqual([1, 2]); expect(control.rawSockets).toHaveLength(1);
        await db.close();
    });

    it('does not report open success if an earlier public state listener closes the owner', async () => {
        const { Lattice, Note } = await library(); const db = await Lattice.open(':memory:reentrant-reconnect', [Note], { sync });
        let closed: ReturnType<typeof db.close> | undefined;
        db.onSyncState(info => { if (info.connectionGeneration === 2 && info.state === 'open') closed = db.close(); });
        const failed = db.reconnectSync({ timeoutMs: 1000 }).catch(error => error);
        await vi.waitFor(() => expect(control.rawSockets).toHaveLength(2));
        control.rawSockets[1].open();
        expect(await failed).toBeInstanceOf(Error);
        expect(await closed).toMatchObject({ native: 'closed', transport: 'closed' });
        expect(control.connects).toBe(1);
    });

    it('refuses unsupported, unsynced, closed and invalid requests before native mutation', async () => {
        const { Lattice, Note } = await library();
        const local = await Lattice.open(':memory:no-sync', [Note]);
        expect(() => local.reconnectSync()).toThrow('capability is unavailable'); await local.close();
        const db = await Lattice.open(':memory:reconnect-policy', [Note], { sync });
        for (const timeoutMs of [-1, Infinity, NaN, 30001]) expect(() => db.reconnectSync({ timeoutMs })).toThrow(RangeError);
        await expect(db.reconnectSync({ timeoutMs: 0 })).rejects.toThrow('timed out');
        const native = control.handles[1]; native.connectSync = undefined;
        expect(() => db.reconnectSync()).toThrow('capability is unavailable');
        expect(control.disconnects ?? 0).toBe(0); expect(control.connects ?? 0).toBe(0);
        await db.close(); expect(() => db.reconnectSync()).toThrow('closing or closed');
    });

    it('a throwing transport disconnect retires only this wrapper connected claim and never redials', async () => {
        const { Lattice, Note } = await library(); const states: SyncStateInfo[] = [];
        const db = await Lattice.open(':memory:throwing-disconnect', [Note], { sync, onSyncState: state => states.push(state) });
        const old = control.rawSockets[0] as Socket; old.open();
        const originalClose = old.close;
        old.close = () => { throw new Error('raw close failed'); };
        await expect(db.reconnectSync()).rejects.toThrow('raw close failed');
        expect(states.at(-1)?.state).toBe('error');
        expect(control.rawSockets).toHaveLength(1); expect(control.connects ?? 0).toBe(0);
        old.close = originalClose; await db.close();
    });
});
