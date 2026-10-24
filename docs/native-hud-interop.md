# Native HUD storage qualification

The source-only consumer is `test/native-hud-interop.mjs`. It consumes the closed,
synthetic fixture produced by HUD's `NativeStorageInteropTests.swift`; it never
opens an owner store or executes HUD sources, handlers, URLs, or network requests.

The consumer bundles the actual Browser `createHUDLatticeDefinition()` adapter
and LatticeJS `defineModels`/`buildSchemas`. It requires the generated Browser
metadata to agree with the fixture contract and a passing combined 39-case Wasm
receipt for exactly the same JS/Wasm artifact hashes, including the three detached
capture cases. It does not strip unsupported
metadata or invent a second model declaration.

It checks all eight typed model tables and all four union families/cases through
the public typed codecs. Generic managed union-side getters have an unquoted
reserved `case` column in the current baseline; the actual link junction has no
numeric row ID. Both side-table groups are checked with test-only read-only SQLite inspection of a
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

The older 33-case artifact is qualified; the new combined artifact and repaired
native fixture are still pending. After both gates pass,
producer supplies a complete fixture, run with explicit absolute paths (replace
`native-storage-interop-ready` with that directory; the output must not exist):

```sh
node test/native-hud-interop.mjs \
  --fixture /Users/jason/localdev/hud-scratch/hudjs-layout/native-storage-interop-ready \
  --output-dir /Users/jason/localdev/latticejs-hud/tmp/native-hud-interop-run1 \
  --hud-repo /Users/jason/localdev/hud-browser \
  --core-repo /Users/jason/localdev/latticecore-hud-migration \
  --build /Users/jason/localdev/latticejs-hud/wasm/build \
  --runtime-receipt /Users/jason/localdev/latticejs-hud/tmp/wasm-pending-capture-v2/runtime.json
```

Use the actual returned green runtime receipt path; the example does not assert
that the new artifact is qualified. The native fixture owner then runs the existing
`verify-returned` mode with the same native producer candidates. That separate read-only Swift oracle compares the
full physical/typed snapshot, NoHistory raw/late-bound audit behavior, and verifies
that reading did not change the returned file. Consumer success alone does not
establish Swift round-trip parity, browser OPFS, sync/rescue, the public open
loader, installed application behavior, or release qualification.

Current qualification: five exact-value helper tests pass; the actual generated
adapter bundles into eight models, four union properties, and three true NoHistory
properties without a native open. Three actual SQLite diagnostic tests verify
id-less junction reads, quoted union-side columns, exact integers and refusal of invented columns without
changing file bytes. The combined 33-case actual Wasm artifact is qualified at
`tmp/wasm-union-nohistory-v1/runtime-v2.json`. The real native fixture consume/export
and Swift read-only oracle still await the native producer.

The original `native-storage-interop` directory contains a preserved failed
producer attempt and no complete manifest. It is not a valid consumer input.
The producer's metadata and id-less junction corrections must pass before using
a new complete fixture. Public browser loading and OPFS checks are separate work;
their harness files are not part of this qualification packet.

The native v5 producer passes metadata, union and checkpoint diagnostics, then
fails the pinned Swift 2.2.4 nullable NoHistory replay assertion. A scratch-only
producer using exact Swift `465fcbd` and Core `e7361f9` candidates is prepared;
production dependencies remain untouched. Its manifest records actual candidate
pins separately from the archived HUD lock (`recordedHUDDependencyPins` and
`packageResolvedRole`), with candidate build/source provenance hashes. The
consumer preserves those fields in its receipt. A partial producer directory
without a complete manifest is never valid input.
