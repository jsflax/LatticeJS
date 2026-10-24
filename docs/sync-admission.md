# Browser sync admission (candidate)

This optional path waits for host admission before every WebSocket construction.
It is source-qualified in TypeScript; native and actual-browser qualification are pending.
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
// Revocation retires pending admission and closes the transport immediately.
cancellation.abort();
await db.close();
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

Reconnection remains app-owned, as in current Emscripten Core. Closing and reopening
runs fresh admission; no automatic retry policy is added. `close()` cancels the
admitted transport synchronously, so callers requiring upload drain must request and
finish that drain before close. The normal close receipt still reports actual pending
uploads, transport retirement, snapshot disposition, and native release.

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

After the coordinated native build and unchanged baseline39 pass, run the browser gate
with fresh localdev evidence and `HUD_BROWSER_REPO` pointing to the existing Browser
test tooling. Do not run it against the preserved39 artifact expecting success.
