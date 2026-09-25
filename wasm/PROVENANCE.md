# Pinned WASM build

`python3 wasm/build-pinned.py /absolute/new/output` builds from a clean committed LatticeJS checkout and its exact clean LatticeCore submodule. The output directory must be fresh and outside the checkout; it contains every downloaded input, cache, scratch file, compiler log, artifact and receipt. It does not read or copy an existing Lattice WASM binary.

The build pins the ARM64 Emscripten 5.0.6 image by immutable manifest digest and the SQLite 3.45.0 archive by SHA256. SQLite is downloaded and checked before compilation. Docker compilation runs with networking disabled, archives of the recorded source commits mounted read-only, and a bounded job count. The source archives and their hashes are retained; compilation never reads ignored binaries or later checkout edits. The compiler's supplied system libraries come from the pinned image and are copied into the output cache. `INPUTS.json` binds source commits/trees, core commit/tree, image and SQLite hashes before compilation; `BUILD_INFO.json` adds actual tool versions and artifact hashes after success.

To use a qualified result, copy its `build/lattice.js`, `build/lattice.wasm` and `BUILD_INFO.json` into the consumer's explicitly staged `wasm/build/` directory, then build the TypeScript layer. Keep that receipt with the browser bundle hashes and runtime test receipt. A compile alone does not qualify OPFS, synchronization, access revocation or browser compatibility.

An old ignored binary without a corresponding receipt remains historically untraceable. A new build and its tested hash establish new custody; they do not retroactively identify that old binary's compiler or source. The older developer build script remains available, but it does not enforce this pinned, clean-source boundary.
