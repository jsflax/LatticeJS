# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Package renamed to `@jsflax/lattice`** (was `lattice-js`). Install and
  import paths change accordingly (`@jsflax/lattice`, `@jsflax/lattice/worker`,
  `@jsflax/lattice/vite`). Version stays 0.x; alignment to 1.0.0 happens at
  the LatticeCore 1.0.0 tag.
- LatticeCore submodule pinned to **1.0.0-rc.1** (the C ABI freeze), up from
  the 0.10.4-era pin. The wasm module and `bindings.cpp` build cleanly against
  the rc.1 tree under Emscripten 5.0.6 with no core-side changes — the
  `__EMSCRIPTEN__` guards around the core's native-threading code
  (scheduler/pacer, sync loop) hold.
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
