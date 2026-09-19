import type { SyncStateInfo, LatticeCloseResult } from './types';

// Exact sync-WebSocket ownership, observation and bounded teardown.
//
// New native bindings expose each handle's actual WebSocket. Shared native
// owners therefore share the same object; different stores on one endpoint do
// not. The constructor tracker remains only for legacy builds and diagnostics:
// newly created sockets can be attributed, but cached sockets are never adopted
// by URL. Browser reconnect remains app-owned.
//
// Last-wrapper release purges deferred frames and detaches native handlers before
// initiating close. Per-instance listeners retire separately and synchronously.
// Native storage release follows on a later browser task, through releaseStorage
// in the new binding; legacy builds cannot claim native cleanup from JS deletion.

/** The subset of `WebSocket` this module needs, plus the wasm's expando. */
export interface TrackedSyncSocket {
    readonly url: string;
    readonly readyState: number;
    close(code?: number, reason?: string): void;
    removeEventListener(type: string, listener: any, options?: any): void;
    /** Only needed by `whenSyncSocketOpen`; absent on a minimal stub. */
    addEventListener?(type: string, listener: any, options?: any): void;
    /** Raw C++ `emscripten_websocket_client*`, stamped by the wasm transport. */
    _lattice_client?: number;
}

/** One wrapper's subscriptions to its exact native transport. No global callbacks. */
export class InstanceSyncState {
    private listeners = new Set<(info: SyncStateInfo) => void>();
    private internalListeners = new Set<(info: SyncStateInfo) => void>();
    private detach: (() => void) | null = null;
    private active = true;
    private socket: TrackedSyncSocket | null = null;
    private current: SyncStateInfo;
    private lastSocket: TrackedSyncSocket | null = null;

    constructor(instanceId: string, configured: boolean) {
        this.current = Object.freeze({
            state: configured ? 'connecting' : 'closed',
            instanceId,
            connectionGeneration: configured ? 1 : 0,
            code: 0,
            reason: configured ? '' : 'sync-not-configured',
        });
    }

    subscribe(callback: ((info: SyncStateInfo) => void) | null): () => void {
        if (callback === null) {
            this.listeners.clear();
            return () => {};
        }
        return this.addListener(callback, this.listeners);
    }

    /** Internal owner waits are not removed by the public null-clear operation. */
    subscribeInternal(callback: (info: SyncStateInfo) => void): () => void {
        return this.addListener(callback, this.internalListeners);
    }

    private addListener(callback: (info: SyncStateInfo) => void, listeners: Set<(info: SyncStateInfo) => void>): () => void {
        if (typeof callback !== 'function') throw new TypeError('Sync state callback must be a function.');
        if (!this.active) return () => {};
        // A registration has its own identity even when callers reuse a function.
        const listener = (info: SyncStateInfo) => callback(info);
        listeners.add(listener);
        this.deliver(listener, this.current);
        return () => { listeners.delete(listener); };
    }

    private deliver(listener: (info: SyncStateInfo) => void, info: SyncStateInfo): void {
        if (!this.active || this.current !== info || (!this.listeners.has(listener) && !this.internalListeners.has(listener))) return;
        try { listener(info); } catch { /* A consumer cannot interrupt native dispatch or cleanup. */ }
    }

    private publish(state: SyncStateInfo['state'], code = 0, reason = '', force = false): void {
        if (!this.active) return;
        if (!force && this.current.state === state && this.current.code === code && this.current.reason === reason) return;
        const info = Object.freeze({ ...this.current, state, code, reason });
        this.current = info;
        for (const listener of [...this.listeners, ...this.internalListeners]) this.deliver(listener, info);
    }

    bind(socket: TrackedSyncSocket | null): void {
        if (!this.active) return;
        this.detach?.();
        this.detach = null;
        const replacement = !!this.lastSocket && !!socket && this.lastSocket !== socket;
        if (replacement) {
            this.current = Object.freeze({ ...this.current, connectionGeneration: this.current.connectionGeneration + 1 });
        }
        this.socket = socket;
        if (socket) this.lastSocket = socket;
        if (!socket) {
            if (this.lastSocket) this.publish('closed', 0, 'sync-transport-unavailable');
            return;
        }
        const onOpen = () => { if (this.socket === socket) this.publish('open'); };
        const onError = () => { if (this.socket === socket) this.publish('error'); };
        const onClose = (event: { code?: unknown; reason?: unknown }) => {
            if (this.socket !== socket) return;
            this.publish('closed', typeof event?.code === 'number' ? event.code : 0,
                typeof event?.reason === 'string' ? event.reason : '');
        };
        const handlers = [['open', onOpen], ['error', onError], ['close', onClose]] as const;
        for (const [event, handler] of handlers) socket.addEventListener?.(event, handler);
        this.detach = () => {
            for (const [event, handler] of handlers) {
                try { socket.removeEventListener(event, handler); } catch { /* Retired callbacks remain inert. */ }
            }
        };
        // Attach before the state read: an already-open shared transport is replayed.
        if (socket.readyState === OPEN) this.publish('open', 0, '', replacement);
        else if (socket.readyState === CLOSING || socket.readyState === CLOSED) this.publish('closed', 0, '', replacement);
        else this.publish('connecting', 0, '', replacement);
    }

    fail(): void { this.publish('error', 0, 'sync-open-failed'); }

    /** Synchronous, idempotent retirement; even a copied dispatch list becomes inert. */
    retire(): void {
        if (!this.active) return;
        this.active = false;
        this.listeners.clear();
        this.internalListeners.clear();
        this.detach?.();
        this.detach = null;
        this.socket = null;
    }
}

/** The `Module` handlers the wasm transport subscribes with. */
export interface SyncSocketWasmModule {
    _ws_purge_client?: (clientPtr: number) => void;
    _ws_onopen_handler?: unknown;
    _ws_onmessage_handler?: unknown;
    _ws_onerror_handler?: unknown;
    _ws_onclose_handler?: unknown;
}

interface SocketScope {
    WebSocket?: any;
}

/** WebSocket.readyState values — spelled out so this module needs no DOM lib. */
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** `close()` with a NORMAL closure code, never a protocol/abnormal one. */
export const NORMAL_CLOSURE = 1000;
const CLOSE_REASON = 'lattice close';

/**
 * The four (event type, Module handler property) pairs the wasm transport
 * subscribes with — detached in this same set on teardown.
 */
const WASM_HANDLERS: ReadonlyArray<readonly [string, keyof SyncSocketWasmModule]> = [
    ['open', '_ws_onopen_handler'],
    ['message', '_ws_onmessage_handler'],
    ['error', '_ws_onerror_handler'],
    ['close', '_ws_onclose_handler'],
];

/**
 * Exact claimed sockets plus legacy constructor captures, newest last. Pruned of
 * already-CLOSED entries whenever a capture starts, so it stays bounded across
 * a long-lived redial loop.
 */
let registry: TrackedSyncSocket[] = [];

/**
 * How many live Lattice instances hold each socket. Refcounted, because a
 * second `Lattice.open()` on the same path+url does NOT create a second socket:
 * `LatticeCache::get_or_create` returns the cached `swift_lattice` and the
 * caller inherits the first instance's transport. Closing on the first
 * `close()` would cut sync out from under the sibling that is still using it.
 */
const socketOwners = new WeakMap<object, number>();

let trackerScope: SocketScope | null = null;
let nativeWebSocket: any = null;

/**
 * Wrap the realm's `WebSocket` so sockets the wasm transport creates can be
 * found again at close time. Idempotent, and a no-op in a realm without
 * `WebSocket` (node without a polyfill, where sync is never configured anyway).
 *
 * Must run BEFORE `new wasmModule.Lattice(...)` — the transport resolves
 * `val::global("WebSocket")` at connect time, which happens synchronously
 * inside that constructor.
 *
 * @returns whether tracking is active in this realm.
 */
export function installSyncSocketTracker(scope: SocketScope = globalThis as SocketScope): boolean {
    if (trackerScope === scope) return true;
    const Native = scope?.WebSocket;
    if (typeof Native !== 'function') return false;

    class LatticeTrackedWebSocket extends (Native as { new (...args: any[]): object }) {
        constructor(...args: any[]) {
            super(...args);
            registry.push(this as unknown as TrackedSyncSocket);
        }
    }
    // Subclassing (rather than a Proxy) keeps `instanceof WebSocket`, the
    // readyState constants, and every prototype accessor intact for any app
    // code that also constructs sockets in this realm.
    Object.defineProperty(LatticeTrackedWebSocket, 'name', { value: Native.name });

    scope.WebSocket = LatticeTrackedWebSocket;
    trackerScope = scope;
    nativeWebSocket = Native;
    return true;
}

/** Drop entries that are already CLOSED — nothing can be adopted from them. */
function prune(): void {
    if (registry.length === 0) return;
    registry = registry.filter((s) => s.readyState !== CLOSED);
}

/**
 * Run `create` (the wasm Lattice construction) and report which sockets it
 * created. The transport connects synchronously inside the C++ constructor, so
 * this window is exact: whatever appears in it belongs to the instance being
 * built, and a construction that reused a cached `swift_lattice` reports none.
 */
export function captureSyncSockets<T>(create: () => T): { value: T; sockets: TrackedSyncSocket[] } {
    prune();
    const mark = registry.length;
    const value = create();
    return { value, sockets: registry.slice(mark) };
}

/** Register `sockets` as held by one more Lattice instance. */
export function claimSyncSockets(sockets: readonly TrackedSyncSocket[]): void {
    for (const sock of sockets) {
        if (!registry.includes(sock)) registry.push(sock);
        socketOwners.set(sock, (socketOwners.get(sock) ?? 0) + 1);
    }
}

/** Drop only JS leases. Modern native ownership decides whether to disconnect. */
export function forgetSyncSockets(sockets: readonly TrackedSyncSocket[]): void {
    for (const socket of sockets) {
        const remaining = (socketOwners.get(socket) ?? 1) - 1;
        if (remaining > 0) socketOwners.set(socket, remaining);
        else socketOwners.delete(socket);
    }
    prune();
}

/** Observe native-initiated disconnect without touching shared transport handlers. */
export function waitForSyncSocketsClosed(
    sockets: readonly TrackedSyncSocket[], timeoutMs: number,
): Promise<LatticeCloseResult['transport']> {
    if (!sockets.length) return Promise.resolve('unavailable');
    return new Promise(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const completed = new Set<TrackedSyncSocket>();
        const cleanups: Array<() => void> = [];
        const finish = (result: LatticeCloseResult['transport']) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            for (const cleanup of cleanups) { try { cleanup(); } catch { /* Already settled. */ } }
            resolve(result);
        };
        const check = () => {
            if (sockets.every(socket => completed.has(socket) || socket.readyState === CLOSED)) finish('closed');
        };
        for (const socket of sockets) {
            const onClose = () => { completed.add(socket); check(); };
            try {
                socket.addEventListener?.('close', onClose);
                cleanups.push(() => socket.removeEventListener('close', onClose));
            } catch { /* Ready state still supports an already-closed transport. */ }
        }
        check();
        if (!settled) timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
}

/**
 * Replay `emscripten_websocket_client::disconnect()` from JS, in ITS order —
 * the order is load-bearing, not stylistic:
 *
 *   1. `Module._ws_purge_client(ptr)` drops deferred frames sitting in
 *      `Module._ws_msg_queue`; they captured the raw client pointer at enqueue
 *      time and would otherwise dispatch into C++ after teardown.
 *   2. `_lattice_client = 0` orphans the socket for any handler path that still
 *      reads it.
 *   3. `removeEventListener` for all four handlers prevents even ALREADY-QUEUED
 *      event tasks from reaching C++ — and, deliberately, suppresses the
 *      `_dispatchSyncState('closed', ...)` that `_ws_onclose_handler` fires
 *      unconditionally. An intentional teardown must stay silent, exactly as
 *      the C++ path is: an app-level reconnect controller listening via
 *      `onSyncState` would otherwise hear its own `close()` and redial.
 *   4. `close(1000, ...)` — normal closure, so the server records a clean
 *      goodbye and drops its per-connection Lattice instead of waiting out a
 *      1006 abnormal-close timeout.
 *
 * After step 4 the socket is CLOSING, so the C++ transport's `send()` — which
 * still believes it is open — becomes a silent no-op rather than a throw
 * (`send()` only raises InvalidStateError while CONNECTING).
 *
 * @returns true if this call transitioned the socket toward closed.
 */
function detachAndClose(sock: TrackedSyncSocket, mod: SyncSocketWasmModule | null): boolean {
    const client = typeof sock._lattice_client === 'number' ? sock._lattice_client : 0;

    if (client && typeof mod?._ws_purge_client === 'function') {
        try {
            mod._ws_purge_client(client);
        } catch (err) {
            console.warn('[Lattice] purging deferred sync frames failed:', err);
        }
    }

    try {
        sock._lattice_client = 0;
    } catch {
        /* frozen expando — the removeEventListener below still orphans it */
    }

    for (const [type, prop] of WASM_HANDLERS) {
        const handler = mod?.[prop];
        if (!handler) continue;
        try {
            sock.removeEventListener(type, handler);
        } catch (err) {
            console.warn(`[Lattice] detaching sync ws '${type}' handler failed:`, err);
        }
    }

    if (sock.readyState === CLOSING || sock.readyState === CLOSED) return false;
    try {
        sock.close(NORMAL_CLOSURE, CLOSE_REASON);
    } catch (err) {
        console.warn('[Lattice] closing sync ws failed:', err);
        return false;
    }
    return true;
}

/**
 * Drop this instance's hold on `sockets`; close the ones no live Lattice holds
 * any more. Safe to call twice — the second call finds no ownership and a
 * CLOSING/CLOSED socket, and reports 0.
 *
 * @returns how many sockets this call actually closed.
 */
export function releaseSyncSockets(
    sockets: readonly TrackedSyncSocket[],
    mod: SyncSocketWasmModule | null,
): number {
    let closed = 0;
    for (const sock of sockets) {
        const remaining = (socketOwners.get(sock) ?? 1) - 1;
        if (remaining > 0) {
            socketOwners.set(sock, remaining);
            continue;
        }
        socketOwners.delete(sock);
        if (detachAndClose(sock, mod)) closed++;
    }
    prune();
    return closed;
}

/** Release exact socket ownership and observe CLOSED, never merely CLOSING. */
export function closeSyncSockets(
    sockets: readonly TrackedSyncSocket[],
    mod: SyncSocketWasmModule | null,
    timeoutMs: number,
): Promise<LatticeCloseResult['transport']> {
    if (sockets.length === 0) return Promise.resolve('unavailable');
    const exclusive = sockets.filter(socket => (socketOwners.get(socket) ?? 1) <= 1);
    if (exclusive.length === 0) {
        releaseSyncSockets(sockets, mod);
        return Promise.resolve('shared');
    }
    return new Promise(resolve => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanups: Array<() => void> = [];
        const completed = new Set<TrackedSyncSocket>();
        const finish = (result: LatticeCloseResult['transport']) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            for (const cleanup of cleanups) { try { cleanup(); } catch { /* Waiting is already settled. */ } }
            resolve(result);
        };
        const check = () => {
            if (exclusive.every(socket => socket.readyState === CLOSED)) finish('closed');
        };
        for (const socket of exclusive) {
            const closed = () => {
                // A close event itself is terminal, including test transports
                // which update readyState immediately after dispatch.
                completed.add(socket);
                if (exclusive.every(value => completed.has(value) || value.readyState === CLOSED)) finish('closed');
            };
            socket.addEventListener?.('close', closed);
            cleanups.push(() => socket.removeEventListener('close', closed));
        }
        releaseSyncSockets(sockets, mod);
        check();
        if (!settled) timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
}

/**
 * Resolve once one of `sockets` is OPEN, or `false` if none opens within
 * `timeoutMs` (or there is nothing to wait for).
 *
 * Used by `resumePendingFrom`: rescued writes may only be offered to a store
 * whose exact transport can actually ship them. A rejected injected sleep
 * cancels the wait and detaches its listeners when the owner retires.
 *
 * Listener-based, with the already-open case handled synchronously and a
 * fallback poll for a stub socket without `addEventListener`. No SharedWorker,
 * no BroadcastChannel — Safari-safe.
 */
export function whenSyncSocketOpen(
    sockets: readonly TrackedSyncSocket[],
    timeoutMs: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
    if (sockets.length === 0) return Promise.resolve(false);
    if (sockets.some((s) => s.readyState === OPEN)) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
        let settled = false;
        const cleanups: Array<() => void> = [];
        const finish = (opened: boolean) => {
            if (settled) return;
            settled = true;
            for (const undo of cleanups) {
                try { undo(); } catch { /* detaching a dead socket is not an error */ }
            }
            resolve(opened);
        };

        for (const sock of sockets) {
            if (typeof sock.addEventListener !== 'function') continue;
            const onOpen = () => finish(true);
            try {
                sock.addEventListener('open', onOpen);
                cleanups.push(() => sock.removeEventListener('open', onOpen));
            } catch { /* fall back to the poll below */ }
        }

        // The poll covers both the stub case and a socket that opened between
        // the readyState check above and the listener attaching.
        const deadline = Date.now() + timeoutMs;
        void (async () => {
            try {
                while (!settled) {
                    if (sockets.some((s) => s.readyState === OPEN)) return finish(true);
                    if (Date.now() >= deadline) return finish(false);
                    await sleep(50);
                }
            } catch { finish(false); }
        })();
    });
}

/**
 * Sockets the wasm transport created that are still CONNECTING/OPEN. Diagnostic
 * surface for a redial loop: it must not grow across open/close cycles.
 */
export function liveSyncSocketCount(): number {
    let n = 0;
    for (const sock of registry) {
        if (sock.readyState !== CLOSING && sock.readyState !== CLOSED) n++;
    }
    return n;
}

/** Test-only: uninstall the wrapper and forget every tracked socket. */
export function __resetSyncSocketTracker(): void {
    if (trackerScope && nativeWebSocket) trackerScope.WebSocket = nativeWebSocket;
    trackerScope = null;
    nativeWebSocket = null;
    registry = [];
}
