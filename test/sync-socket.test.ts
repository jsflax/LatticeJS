// Sync-WebSocket teardown tests.
//
// The socket is created wasm-side, so there is no wasm here: these tests stand
// in the realm's `WebSocket` constructor and the `Module._ws_*` handler surface
// that wasm/bindings.cpp installs, then drive the exact sequence the C++
// transport drives (`connect()` -> `new WebSocket` -> stamp `_lattice_client`
// -> addEventListener x4) and assert that close-time teardown replays
// `emscripten_websocket_client::disconnect()` faithfully.
//
// Node/vitest, no browser required — matching the rest of the unit suite.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    installSyncSocketTracker,
    captureSyncSockets,
    adoptSyncSocket,
    claimSyncSockets,
    releaseSyncSockets,
    liveSyncSocketCount,
    __resetSyncSocketTracker,
    NORMAL_CLOSURE,
} from '../src/sync-socket';

// ============================================================================
// Fakes: the realm's WebSocket + the wasm Module's ws handler surface
// ============================================================================

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Ordered log of every teardown-relevant operation, shared by both fakes. */
let ops: string[] = [];

class FakeWebSocket {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;

    url: string;
    // The handshake is irrelevant to teardown; start OPEN like a settled socket.
    readyState = OPEN;
    _lattice_client?: number;

    private listeners = new Map<string, Set<Function>>();
    closeCalls: Array<{ code?: number; reason?: string; attachedTypes: string[]; client: unknown }> = [];

    constructor(url: string) {
        this.url = url;
    }

    addEventListener(type: string, listener: Function): void {
        let set = this.listeners.get(type);
        if (!set) this.listeners.set(type, (set = new Set()));
        set.add(listener);
    }

    removeEventListener(type: string, listener: Function): void {
        ops.push(`detach:${type}`);
        this.listeners.get(type)?.delete(listener);
    }

    close(code?: number, reason?: string): void {
        ops.push('close');
        this.closeCalls.push({
            code,
            reason,
            attachedTypes: [...this.listeners.entries()].filter(([, s]) => s.size > 0).map(([t]) => t),
            client: this._lattice_client,
        });
        this.readyState = CLOSING;
        // Browsers still deliver a close event to whatever is attached.
        this.dispatch('close', { code: code ?? 1005, reason: reason ?? '' });
        this.readyState = CLOSED;
    }

    /** Test hook: deliver an event exactly as the browser would. */
    dispatch(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
    }

    attachedCount(): number {
        let n = 0;
        for (const set of this.listeners.values()) n += set.size;
        return n;
    }
}

/** Mirrors the JS half of `setup_ws_handlers()` in wasm/bindings.cpp. */
function makeWasmModule() {
    const mod = {
        _ws_msg_queue: [] as Array<{ client: number; event: unknown }>,
        /** client pointers handed to _ws_purge_client */
        purged: [] as number[],
        /** client pointers that reached C++ via the close handler */
        handledCloses: [] as number[],
        /** what Lattice.onSyncState listeners would have received */
        syncStateEvents: [] as Array<{ state: string; code: number }>,
        _ws_purge_client(clientPtr: number) {
            ops.push('purge');
            mod.purged.push(clientPtr);
            mod._ws_msg_queue = mod._ws_msg_queue.filter((item) => item.client !== clientPtr);
        },
        _ws_onopen_handler() {},
        _ws_onmessage_handler() {},
        _ws_onerror_handler() {},
        _ws_onclose_handler(this: FakeWebSocket, event: { code: number }) {
            // bindings.cpp gates the C++ hop on _lattice_client but dispatches
            // the sync-state event unconditionally.
            const client = this._lattice_client;
            if (client) mod.handledCloses.push(client);
            mod.syncStateEvents.push({ state: 'closed', code: event.code });
        },
    };
    return mod;
}

type WasmModule = ReturnType<typeof makeWasmModule>;

/** What `emscripten_websocket_client::connect()` does, in JS. */
function wasmConnect(scope: { WebSocket: any }, mod: WasmModule, url: string, clientPtr: number): FakeWebSocket {
    const sock: FakeWebSocket = new scope.WebSocket(`${url}?token=tok`);
    sock._lattice_client = clientPtr;
    sock.addEventListener('open', mod._ws_onopen_handler);
    sock.addEventListener('message', mod._ws_onmessage_handler);
    sock.addEventListener('error', mod._ws_onerror_handler);
    sock.addEventListener('close', mod._ws_onclose_handler);
    return sock;
}

// ============================================================================

const URL = 'ws://localhost:8080/sync';

describe('sync socket teardown', () => {
    let scope: { WebSocket: any };
    let mod: WasmModule;

    beforeEach(() => {
        ops = [];
        scope = { WebSocket: FakeWebSocket };
        mod = makeWasmModule();
        expect(installSyncSocketTracker(scope)).toBe(true);
    });

    afterEach(() => {
        __resetSyncSocketTracker();
    });

    it('installs over the realm WebSocket without breaking instanceof or the readyState constants', () => {
        const sock = new scope.WebSocket(URL);
        expect(sock instanceof FakeWebSocket).toBe(true);
        expect(scope.WebSocket.CLOSED).toBe(CLOSED);
        // Idempotent: a second install is a no-op, not a second wrapper.
        const wrapper = scope.WebSocket;
        expect(installSyncSocketTracker(scope)).toBe(true);
        expect(scope.WebSocket).toBe(wrapper);
    });

    it('attributes only the sockets opened during the construction window', () => {
        const before = new scope.WebSocket('ws://elsewhere/other');
        const { value, sockets } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        expect(sockets).toHaveLength(1);
        expect(sockets[0]).toBe(value);
        expect(sockets).not.toContain(before);
    });

    it('closes the captured socket with a NORMAL closure code', () => {
        const { value: sock, sockets } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        claimSyncSockets(sockets);

        expect(releaseSyncSockets(sockets, mod)).toBe(1);
        expect(sock.closeCalls).toHaveLength(1);
        expect(sock.closeCalls[0].code).toBe(NORMAL_CLOSURE);
        expect(sock.readyState).toBe(CLOSED);
    });

    it('replays the C++ disconnect order: purge, orphan, detach, then close', () => {
        const { value: sock, sockets } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        claimSyncSockets(sockets);
        releaseSyncSockets(sockets, mod);

        expect(ops[0]).toBe('purge');
        expect(ops.slice(1, 5)).toEqual(['detach:open', 'detach:message', 'detach:error', 'detach:close']);
        expect(ops[5]).toBe('close');
        // Nothing was still attached when close() ran, and the socket had
        // already been orphaned from its C++ client.
        expect(sock.closeCalls[0].attachedTypes).toEqual([]);
        expect(sock.closeCalls[0].client).toBe(0);
        expect(sock.attachedCount()).toBe(0);
    });

    it('keeps the teardown silent — no C++ close hop and no syncState event', () => {
        const { sockets } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        claimSyncSockets(sockets);
        releaseSyncSockets(sockets, mod);

        // An app-level reconnect controller listening via onSyncState must not
        // hear its own close() and redial into the teardown.
        expect(mod.syncStateEvents).toEqual([]);
        expect(mod.handledCloses).toEqual([]);
    });

    it('purges deferred frames that captured the raw client pointer', () => {
        const { sockets } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        mod._ws_msg_queue.push({ client: 0xaa, event: {} }, { client: 0xbb, event: {} });
        claimSyncSockets(sockets);
        releaseSyncSockets(sockets, mod);

        expect(mod.purged).toEqual([0xaa]);
        expect(mod._ws_msg_queue).toEqual([{ client: 0xbb, event: {} }]);
    });

    it('keeps a socket shared by two Lattices open until the last one closes', () => {
        // Second open of the same path+url: LatticeCache hands back the cached
        // swift_lattice, so the constructor opens no socket and the instance
        // inherits the sibling's transport.
        const { value: sock, sockets: first } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        claimSyncSockets(first);

        const { sockets: none } = captureSyncSockets(() => undefined);
        expect(none).toHaveLength(0);
        const inherited = adoptSyncSocket(URL);
        expect(inherited).toBe(sock);
        claimSyncSockets([inherited!]);

        expect(releaseSyncSockets(first, mod)).toBe(0);
        expect(sock.readyState).toBe(OPEN);
        expect(releaseSyncSockets([inherited!], mod)).toBe(1);
        expect(sock.readyState).toBe(CLOSED);
    });

    it('is idempotent — a second release neither closes nor throws', () => {
        const { value: sock, sockets } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        claimSyncSockets(sockets);

        expect(releaseSyncSockets(sockets, mod)).toBe(1);
        expect(releaseSyncSockets(sockets, mod)).toBe(0);
        expect(sock.closeCalls).toHaveLength(1);
    });

    it('leaves an already-closed socket alone (server-initiated close)', () => {
        const { value: sock, sockets } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        claimSyncSockets(sockets);
        sock.readyState = CLOSED;

        expect(releaseSyncSockets(sockets, mod)).toBe(0);
        expect(sock.closeCalls).toHaveLength(0);
    });

    it('never adopts a socket that is already closing or closed', () => {
        const { value: sock } = captureSyncSockets(() => wasmConnect(scope, mod, URL, 0xaa));
        sock.readyState = CLOSING;
        expect(adoptSyncSocket(URL)).toBeNull();
    });

    it('a redial loop replaces sockets instead of accumulating them', () => {
        // The production failure: an observer that closes and reopens every 5s
        // accumulated one live socket (and one wasm instance) per cycle.
        const closedCodes: Array<number | undefined> = [];
        for (let cycle = 0; cycle < 5; cycle++) {
            const { value: sock, sockets } = captureSyncSockets(() =>
                wasmConnect(scope, mod, URL, 0x100 + cycle)
            );
            claimSyncSockets(sockets);
            expect(liveSyncSocketCount()).toBe(1);

            releaseSyncSockets(sockets, mod);
            closedCodes.push(sock.closeCalls[0]?.code);
            expect(liveSyncSocketCount()).toBe(0);
        }
        expect(closedCodes).toEqual([1000, 1000, 1000, 1000, 1000]);
        expect(mod.syncStateEvents).toEqual([]);
    });

    it('tracks nothing in a realm without WebSocket', () => {
        __resetSyncSocketTracker();
        expect(installSyncSocketTracker({} as { WebSocket?: any })).toBe(false);
    });
});
