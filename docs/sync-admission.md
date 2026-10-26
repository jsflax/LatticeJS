# Browser sync admission (candidate)

This optional path waits for host admission before every WebSocket construction.
It is qualified by the focused native and actual-browser checks below.
The previously qualified 39-case artifact does not expose this capability and fails closed.

```ts
const cancellation = new AbortController();
const db = await Lattice.open(':memory:personal-replica', models, {
  sync: {
    websocketUrl: 'wss://your-host.example/browser/sync',
    authToken: '',
    signal: cancellation.signal,
    beforeConnect: async ({ signal, websocketUrl, instanceId, connectionGeneration }) => {
      // Host verifies its current grant generation and configured endpoint, then
      // POSTs its fixed ticket route using memory CSRF and HttpOnly session cookies.
      // Resolve only after a strict ready response; return no token or credential.
      await host.prepareConnection({ websocketUrl, instanceId, connectionGeneration }, signal);
    },
  },
});
// Revocation retires pending admission and initiates transport closure immediately.
cancellation.abort();
const closed = await db.close();
// Require closed.transport === 'closed' before replacing this owner.
```

`open()` returns a usable local database before remote admission completes. Use
`onSyncState` for connection state; a returned database does not mean admission succeeded.
The hook must return a Promise resolving to `undefined`. Rejection, invalid return,
cancellation, or a retired owner cannot create a WebSocket. Host error text is not
copied into transport diagnostics. A new attempt receives a fresh AbortSignal and
monotonic connection generation. Closing/superseding an attempt aborts that signal.
No native pointer lives in an asynchronous admission continuation.

The native scheduler owns its socket factory. Its cache identity is distinct from
legacy schedulers and other admitted owners. One live owner is allowed per canonical
MEMFS path when admission is involved; another admitted or legacy open must wait for
complete close. Two unrelated owners do not share callbacks, signals, or sockets.
Reentrant close listeners cannot revive a disposed owner or overwrite a newer attempt.
The host must additionally serialize/refuse overlapping grants sharing one cookie scope:
a browser has only one cookie slot for the same name/domain/path. The first personal
host supports one active session and mounted replica per origin.

The first public slice is memory-only (`:memory:` or a named `:memory:<name>` MEMFS
store). It refuses admitted persistent opens before WASM/OPFS initialization. It does
not offer cross-tab locking or admitted OPFS persistence. SQLite `file:` URI owners
cannot mix with admitted owners until URI identity is supported. Ordinary legacy-only
URI and OPFS behavior is unchanged. A synchronous native ownership check immediately
before the sole restore write also prevents a legacy OPFS alias from overwriting an
admitted file after an asynchronous read. Missing guard capability fails closed when
the runtime advertises admission; older runtimes cannot open admitted stores.

The configured URL is stable and has no query, fragment, userinfo, or credential.
Core's existing resume syntax appends a noncredential `last-event-id` audit cursor.
The factory preserves at most one such raw cursor, bounded to 256 ASCII unreserved
characters plus colon, and refuses all other query keys/duplicates. Current generated
IDs are UUIDs; unsupported cursor spelling refuses rather than being rewritten or
silently dropped. The hook receives the configured URL without the cursor. Gateway
authority comes exclusively from its grant-bound cookie, never from the cursor.

Core defaults remain bearer-token-required. The new explicit `transport_managed`
authentication configuration permits empty token sync only for an admitted native
open. Its mode participates in the bridge cache fingerprint. No dummy token is used.
Legacy bearer URL/header behavior is outside this new mode and unchanged.

Reconnection remains app-owned, as in current Emscripten Core. `reconnectSync()`
requests a new transport on the same live store; closing and reopening also runs
fresh admission. No automatic retry policy is added. `close()` cancels the
admitted transport synchronously, so callers requiring upload drain must request and
finish that drain before close. The normal close receipt still reports actual pending
uploads, transport retirement, snapshot disposition, and native release.

Logical cancellation is immediate; physical WebSocket closure can take longer.
The transport receipt waits for every raw socket belonging to the admitted owner,
including superseded attempts and a socket returned by a factory that cancelled
the owner reentrantly. A cancelled admission that never constructed a socket is
closed. A synthetic proxy close or a thrown raw `close()` call does not establish
physical closure: an unobserved close reports `timeout`. A later close event releases
the retained listener but does not rewrite that earlier receipt. This correction is
covered by JavaScript lifecycle tests; the historical browser receipts below do not
establish delayed-close ordering.

## Explicit same-store recovery (candidate)

```ts
const state = await db.reconnectSync({ timeoutMs: 10000 });
// state identifies the same instance and a new connection generation.
// An open socket does not prove replica catch-up or acknowledgement of writes.
```

This operation requires the new native `disconnectSync`/`connectSync` capability
and one exclusive native store owner. Older runtimes and shared owners refuse;
they do not silently fall back to replacing the database. The method leaves rows,
observers, pending local writes and the store identity intact. Native disconnect
runs on a later browser task so row/transport callbacks may request recovery.
Only after every previous raw transport is known closed does it connect again.
Each admitted attempt calls the original `beforeConnect` with a fresh signal and
monotonically increasing generation. It never reuses a ticket returned by the host.

Concurrent requests share the same promise and first deadline. The optional finite
timeout is 0–30000 milliseconds (default 10000), covering disconnect, physical
closure, admission and the new-generation open. A timeout/refusal rejects, cancels
any new pending attempt, and leaves the database available for local reads and a
later explicit retry. Unknown physical closure refuses a replacement until actual
closure is observed. Closing the database or aborting its configured admission
signal cancels recovery; a revoked admission owner cannot reconnect. Host policy
still decides whether the grant remains valid, and must keep stale actions gated.

These additions are source candidates with focused lifecycle regressions and an
extended existing browser admission fixture. Fresh Wasm compilation and real
browser qualification remain pending; the historical receipts below do not
qualify the reconnect API.

## Qualification

- Unit tests cover cancellation, late resolution/rejection, superseding/reentrant
  attempts, empty-token/URL validation, resume cursor admission, old capability refusal,
  memory-only refusal, and post-await restore ownership ordering.
- `LatticeTransportAuthenticationTests` is a four-case actual-Core target for default
  gating, Swift configuration copying, cache identity, and captured transport headers.
- `test/browser-sync-admission.mjs` is a real Chromium/public loader/loopback WebSocket
  gate. It checks single-use HttpOnly ticket admission, real Core resume cursor,
  same-path/URI/OPFS alias refusal, late completion, and revocation/native cleanup.
  The fixture uses HTTP loopback; it does not qualify production TLS/Secure cookies,
  external account authorization, the actual gateway, or a release.

On 2026-10-24, the candidate passed the native four-case target, all 39 unchanged
actual Wasm lifecycle cases, and all four actual Chrome admission scenarios. The
browser observed three freshly admitted upgrades, one rejected ticket reuse, one
actual Core resume cursor, zero credential query parameters/Authorization headers,
and zero remaining native owners, schedulers, handles, or callbacks. No external
requests or browser errors occurred. The browser version was Chrome 156.0.8078.47.

Exact source hashes, commands, logs, and receipts are retained in
`tmp/wasm-sync-admission-v1/`; the native receipt is
`/Users/jason/localdev/hud-scratch/lattice-transport-auth-v1/receipt.json`.
The qualified loader SHA256 is
`c2d377e1ac7d41ffe5993c89ee41304f91caa3013c7d46eac6462a5206d0f6be`;
the Wasm SHA256 is
`ad0cf8a0d79353b49937cc41b0c2c1640efdfb7e3f9a15194a5c62e0a504f452`.
The prior 39-case artifact is preserved separately. Actual gateway/HTTPS testing,
upstream publication, and owner application adoption remain separate gates.
