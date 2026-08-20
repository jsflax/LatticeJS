// Sync-WebSocket ownership and teardown.
//
// WHERE THE SOCKET LIVES
// ----------------------
// The sync socket is created WASM-SIDE, not here. `new wasmModule.Lattice(
// path, schemas, websocketUrl, authToken)` runs, synchronously inside the C++
// constructor, `lattice_db::setup_sync_if_configured()` ->
// `synchronizer_base::connect()` -> `emscripten_websocket_client::connect()`,
// which does `val::global("WebSocket").new_(url)` — i.e. it calls OUR realm's
// `WebSocket` constructor and keeps the resulting JS object in a C++ `val`.
// It then stamps the socket with `_lattice_client` (the transport's raw C++
// pointer) and subscribes four module-level handlers via addEventListener:
// `Module._ws_onopen_handler` / `_ws_onmessage_handler` / `_ws_onerror_handler`
// / `_ws_onclose_handler`.
//
// WHY close() COULD NOT TEAR IT DOWN
// ----------------------------------
// C++ *does* have the teardown: `~lattice_db` -> `teardown_sync()` ->
// `synchronizer_->disconnect()` -> `emscripten_websocket_client::disconnect()`,
// which detaches the handlers and closes the socket. Nothing reaches it from
// JS, for two independent reasons:
//
//   1. NO BINDING. `EMSCRIPTEN_BINDINGS(lattice)` in wasm/bindings.cpp registers
//      ~40 methods on `class_<JsLattice>("Lattice")` and NONE of them is
//      `close`, `disconnect`, `disconnectSync` or `stopSync`. The core exposes
//      `lattice_db::close()` and `lattice_db::disconnect_sync()`, and the Swift
//      bridge re-exports `swift_lattice_ref::close()` — but the embind surface
//      skips all three. (Verified against the shipped wasm/build/lattice.js:
//      the only ws-related module exports are `_ws_handle_*`, `_ws_purge_client`
//      and `setSyncStateCallback`.) So the ONLY teardown JS can reach is
//      embind's `.delete()`, which runs `~JsLattice`.
//
//   2. `~JsLattice` IS A NO-OP FOR THE UNDERLYING DB. It calls
//      `releaseSwiftLatticeRef(ref_)`, which is `if (ptr->release()) delete ptr;`
//      with `bool release() { return --ref_count_ == 0; }` over a
//      `std::atomic<int> ref_count_{0}`. The factory `swift_lattice_ref::_make()`
//      returns the heap ref UNRETAINED (`SWIFT_RETURNS_UNRETAINED` — Swift emits
//      the balancing retain at the call site); every LatticeCAPI open therefore
//      does `ref->retain();  // Start with ref_count = 1` right after
//      `swift_lattice_ref::create(...)`. wasm/bindings.cpp does NOT. So the
//      count starts at 0, `~JsLattice` decrements it to -1, `release()` returns
//      false, the heap ref is never deleted, its `shared_ptr<swift_lattice>` is
//      never dropped, `~lattice_db` never runs, `teardown_sync()` never runs —
//      and the browser WebSocket stays OPEN for the life of the page.
//
// That is the leak: one live socket (plus the wasm sqlite instance behind it)
// per open/close cycle, and server-side one per-connection Lattice held open
// per leaked socket. A page that redials every 5s accumulates sockets instead
// of replacing them.
//
// THE MITIGATION
// --------------
// The socket is an ordinary JS object in our realm, so JS can perform the exact
// teardown the C++ `disconnect()` performs. This module tracks the sockets the
// wasm transport creates (by wrapping the realm's `WebSocket` constructor for
// the window in which the wasm Lattice is constructed) and replays
// `emscripten_websocket_client::disconnect()` step for step, in its order:
// purge deferred frames -> clear `_lattice_client` -> removeEventListener x4 ->
// `close()`. Fixing the refcount needs a wasm rebuild (add `ref->retain()`
// after `swift_lattice_ref::create` in wasm/bindings.cpp, matching
// LatticeCAPI); until then the C++ objects still leak, but the two resources
// that actually hurt in production — the browser socket and the server-side
// connection — are released.
//
// Closing the socket cannot make the wasm redial: `synchronizer_base::
// schedule_reconnect()` is `#ifdef __EMSCRIPTEN__ return;` — browser builds
// reconnect at the app layer only.
//
// WHEN THE WASM IS REBUILT
// ------------------------
// The real fix is one line in each `JsLattice` constructor —
// `ref_ = swift_lattice_ref::create(...); ref_->retain();` — but it needs
// emsdk AND a decision about `teardown_sync()`'s Phase-0 drain: it waits up to
// 2000ms for pending uploads to ACK ON THE CALLING THREAD, which in a
// single-threaded browser build is a main-thread stall that cannot make
// progress (the emscripten scheduler dispatches through the event loop the
// stall is blocking). Land the retain together with an Emscripten-aware drain
// (skip it, or bound it to 0) — not on its own. This module stays correct
// either way: once C++ disconnects first, the socket is already CLOSING here
// and `releaseSyncSockets` reports 0 closed instead of double-closing.

/** The subset of `WebSocket` this module needs, plus the wasm's expando. */
export interface TrackedSyncSocket {
    readonly url: string;
    readonly readyState: number;
    close(code?: number, reason?: string): void;
    removeEventListener(type: string, listener: any, options?: any): void;
    /** Raw C++ `emscripten_websocket_client*`, stamped by the wasm transport. */
    _lattice_client?: number;
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
 * Sockets constructed since the tracker was installed, newest last. Pruned of
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

/**
 * Find a live tracked socket already serving `url` — the cached-instance case,
 * where the wasm handed this open an existing `swift_lattice` (and therefore an
 * existing transport) instead of building one. The transport appends
 * `?token=`/`&last-event-id=` to the configured URL, hence the prefix match.
 */
export function adoptSyncSocket(url: string): TrackedSyncSocket | null {
    for (let i = registry.length - 1; i >= 0; i--) {
        const sock = registry[i];
        if (sock.readyState === CLOSING || sock.readyState === CLOSED) continue;
        if (sock.url === url || sock.url.startsWith(url)) return sock;
    }
    return null;
}

/** Register `sockets` as held by one more Lattice instance. */
export function claimSyncSockets(sockets: readonly TrackedSyncSocket[]): void {
    for (const sock of sockets) {
        socketOwners.set(sock, (socketOwners.get(sock) ?? 0) + 1);
    }
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
