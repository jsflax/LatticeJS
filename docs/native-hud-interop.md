# Native HUD storage qualification

The source-only consumer is `test/native-hud-interop.mjs`. It consumes the closed,
synthetic fixture produced by HUD's `NativeStorageInteropTests.swift`; it never
opens an owner store or executes HUD sources, handlers, URLs, or network requests.

The consumer bundles the actual Browser `createHUDLatticeDefinition()` adapter
and LatticeJS `defineModels`/`buildSchemas`. It requires the generated Browser
metadata to agree with the fixture contract and a passing 33-case Wasm lifecycle
receipt for exactly the same JS/Wasm artifact hashes. It does not strip unsupported
metadata or invent a second model declaration.

It checks all eight typed model tables, all four union families/cases, and native
managed reads of union side tables. The actual link junction has no numeric row
ID: its rows are checked with test-only read-only SQLite inspection of a
checkpointed Wasm copy, using manifest fields and actual PRAGMA column metadata.
It never calls `findObject(0)` or declares synthetic identity columns; typed parent
links remain an independent managed API check. Int64 cells use decimal strings and
BigInt; dates/floats use IEEE754 bits; embedded strings stay opaque. Logical union
equality comes from physical manifest cells plus generated union descriptors:
`logicalUnions.codableJSON` is never parsed through JavaScript Number. Primary row
IDs must fit the current checked safe-number API. The current mutation manifest
uses bare/string union cases; integer-bearing Codable mutation payloads fail
closed until an exact decoder is supplied.

Only manifest-declared mutations are applied. After comparing the expected
returned snapshot, it checkpoints and fully closes the candidate native handle,
verifies resource ownership and absence of pending WAL/journal data, checks that
all original fixture hashes are unchanged, then writes `wasm-returned.lattice`
with exclusive-create semantics. It refuses to overwrite a previous result.
A new output directory receives the bundle and receipt, including native pins,
source revisions/diff hashes, source hashes, artifact hashes, and original file
hashes. No output is written outside `/Users/jason/localdev`.

The Wasm artifact is qualified; the native fixture is still pending. After the
producer supplies a complete fixture, run with explicit absolute paths (replace
`native-storage-interop-ready` with that directory; the output must not exist):

```sh
node test/native-hud-interop.mjs \
  --fixture /Users/jason/localdev/hud-scratch/hudjs-layout/native-storage-interop-ready \
  --output-dir /Users/jason/localdev/latticejs-hud/tmp/native-hud-interop-run1 \
  --hud-repo /Users/jason/localdev/hud-browser \
  --core-repo /Users/jason/localdev/latticecore-hud-migration \
  --build /Users/jason/localdev/latticejs-hud/wasm/build \
  --runtime-receipt /Users/jason/localdev/latticejs-hud/tmp/wasm-union-nohistory-v1/runtime-v2.json
```

Then the native fixture owner must run its existing `verify-returned` mode with
the same native baseline pins. That separate read-only Swift oracle compares the
full physical/typed snapshot, NoHistory raw/late-bound audit behavior, and verifies
that reading did not change the returned file. Consumer success alone does not
establish Swift round-trip parity, browser OPFS, sync/rescue, the public open
loader, installed application behavior, or release qualification.

Current qualification: five exact-value helper tests pass; the actual generated
adapter bundles into eight models, four union properties, and three true NoHistory
properties without a native open. Two actual SQLite diagnostic tests verify
id-less junction reads, exact integers and refusal of invented columns without
changing file bytes. The combined 33-case actual Wasm artifact is qualified at
`tmp/wasm-union-nohistory-v1/runtime-v2.json`. The real native fixture consume/export
and Swift read-only oracle still await the native producer.

The original `native-storage-interop` directory contains a preserved failed
producer attempt and no complete manifest. It is not a valid consumer input.
The producer's metadata and id-less junction corrections must pass before using
a new complete fixture. Public browser loading and OPFS checks are separate work;
their harness files are not part of this qualification packet.
