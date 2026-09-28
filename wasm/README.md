# Pinned WASM build and strict script policy

`CMakeLists.txt` sets `DYNAMIC_EXECUTION=0` so Emscripten's Embind glue uses
its non-JIT paths instead of generating JavaScript with `new Function`.
Do not add JavaScript `unsafe-eval` to a consumer's Content Security Policy
to accommodate the generated loader. WebAssembly compilation is separate:
the browser still needs the appropriate `wasm-unsafe-eval` permission.

Build from a clean committed LatticeJS checkout with its exact LatticeCore
submodule, preserving any existing qualified build:

```sh
python3 wasm/build-pinned.py /absolute/localdev/fresh-wasm-output
node --experimental-vm-modules wasm/check-no-dynamic-execution.mjs \
  /absolute/localdev/fresh-wasm-output/build/lattice.js \
  /absolute/localdev/fresh-wasm-output/build/lattice.wasm
```

The existing pinned builder archives the committed sources, verifies the SQLite
archive, and compiles using the immutable Emscripten image with build networking
disabled. `BUILD_INFO.json` records actual source, input and output hashes.
This flag does not change Core, dependency versions or that custody recipe.
Never copy or relabel historical loader/WASM bytes as the new build.

The runtime check instantiates the **actual generated loader and WASM** inside
a V8 context that denies JavaScript string code generation, proves `eval` and
`new Function` are blocked, and exercises in-memory SQLite CRUD through Embind.
It uses no browser, persistent storage, remote synchronization or real credentials.
It is a focused regression, not a substitute for the consumer's actual strict-CSP
browser qualification, sync/revocation tests and provenance checks before changing
consumer pins. Dynamic lookup of otherwise unexported C functions and other
Emscripten features that require string code generation remain unsupported.
