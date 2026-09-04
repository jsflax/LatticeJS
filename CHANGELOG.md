## Unreleased — orphaned-write drain fix round

- **Read-only audit open** (arity-3 `Lattice` constructor → `create_dynamic`): reading an
  abandoned store's pending set no longer runs `ensure_tables`/`heal_collapsed_sync_state`
  (the write-capable constructor mutated the store it audited), never migrates on schema
  drift (schema is reconstructed from the file), bypasses the instance key-cache, and —
  via the new `releaseStorage()` binding — actually closes the sqlite connection
  (`.delete()` alone freed only the JS wrapper: one leaked connection per abandoned store).
- **`getUnshippedAuditLog()`**: the drain predicate in SQL — unsynced AND unmarked in
  `_lattice_sync_state`. Rows the synchronizer *downloaded* carry a per-sync_id ack mark
  and are now excluded; the previous JSON-side filter over `getPendingAuditLog()` was a
  superset that re-offered the entire downloaded room on every rescue.
- **Missing ≠ empty**: `pendingUploads()` returns `null` (and `DrainReport` gains
  `sourceMissing`) when no store exists at the path — a wrong name no longer reads as
  "nothing was stranded".
- **Drain ordering floor**: `waitForCatchUpQuiet` gains `minWaitMs`
  (`resumePendingFrom` uses 3s) — socket-open is not catch-up-begun, and a quiet window
  elapsing at `received === 0` before the server's replay starts must not fire the drain.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Orphaned-write drain.** Writes accepted between a sync socket's death and
  the app noticing were stranded forever: browser builds never redial, `close()`
  cannot drain a dead socket, and the standard recovery — reopening under a
  fresh store name — starts from a store whose catch-up cannot contain writes
  the server never saw. Three new entry points make that set readable and
  re-deliverable, all JS-side over existing bindings:
  `Lattice.pendingUploads(path, models)` (storage-only read of a store's
  un-ACKed rows, as plain JSON — opens no socket),
  `instance.drainPendingFrom(previousPath)` (re-offers them through a live
  synced instance so they upload), and the `resumePendingFrom` option on
  `Lattice.open()`, which runs that drain automatically once the new store's
  socket is open and its catch-up has gone quiet. Idempotent: re-draining an
  already-delivered store is a no-op. See `src/pending-drain.ts`.

## [1.0.0] - 2026-07-25

### Changed
- **LatticeCore submodule bumped to 1.0.1** (b5337c3 → 16828cb, the `1.0.1`
  tag). Core 1.0.1: 62-scenario conformance corpus; unique-DDL enforcement on
  the dynamic-schema path, thread-scoped in-transaction read routing, and the
  geo-bounds dynamic-add fix. The wasm module (`lattice.wasm`/`lattice.js`)
  is rebuilt from the tag via `wasm/build.sh --clean`; `BUILD_INFO.json`
  stamps the 1.0.1 commit/tag.
- **Version aligned at 1.0.0** (`package.json`, was 0.1.0), tracking the
  core 1.0.x line as planned at the rc.1 pin.
- **Package renamed to `@jsflax/lattice`** (was `lattice-js`). Install and
  import paths change accordingly (`@jsflax/lattice`, `@jsflax/lattice/worker`,
  `@jsflax/lattice/vite`).
- The wasm module and `bindings.cpp` build cleanly against the 1.0.x core
  tree under Emscripten 5.0.6 with no core-side changes — the
  `__EMSCRIPTEN__` guards around the core's native-threading code
  (scheduler/pacer, sync loop) hold (first verified at the rc.1 pin, up from
  the 0.10.4-era pin).
- `objects()` worker RPC now forwards `groupBy`/`distinctBy` through to the
  wasm binding, matching the current 7-argument embind `objects()` signature.
  No behavior change for existing callers (both default to `null`).
- `wasm/build.sh` provenance stamp now defaults to the repo's tag-pinned
  submodule (instead of a machine-specific path) and correctly detects the
  submodule's `.git` file, so `BUILD_INFO.json` records the real LatticeCore
  commit/tag.

### Fixed
- Repaired a corrupted `.gitignore` line that had fused `wasm/build/` onto the
  `!.vscode/extensions.json` negation, leaving wasm build output unignored.
  Build artifacts are never tracked in git; npm ships `wasm/build/*.{js,wasm}`
  via the `files` whitelist. Untracked stray editor-backup and vitest-output
  debris from the index.

### Added
- Minimal CI (`.github/workflows/ci.yml`): emsdk 5.0.6 setup, wasm build
  against the pinned submodule, artifact presence/size assertions, and
  `vitest run`. This proves the wasm module *compiles* against the pinned
  core and that the TypeScript layer behaves; it does **not** exercise wasm
  runtime behavior in a browser.
