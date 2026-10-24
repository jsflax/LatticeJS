# Synchronous detached values (candidate runtime qualified)

`captureValuesSync(selectors)` is a single native read for bounded immutable
display input. It is separate from pending audit rescue and is exposed through
the public synchronous Lattice method and tagged Wasm binding. The bounded single-thread Wasm behavior is qualified below; browser
persistence, complete native HUD file interoperability and release remain separate
gates. It does not provide a persistent read generation or cross-tab snapshot.

Each selector names one registered model table, explicit primitive/to-one-link
properties, and an optional `maxRows`. All linked target tables must also be
selected. There are no predicates, arbitrary SQL, callbacks, lazy getters,
authoring operations, or union/list traversal. The native result copies physical
INTEGER as BigInt, REAL as finite Number (including exact Unix-second dates),
TEXT verbatim (including enum/embedded JSON), BLOB as bytes, NULL as null, and a
link as `{table, globalId}`. The TypeScript boundary freezes copied records and
byte arrays. Physical metadata cannot infer whether INTEGER means bool or Int64,
or whether REAL means a date; interpretation belongs to the exported descriptor.

The first native implementation explicitly refuses non-Wasm, PTHREADS, shared
memory, and Wasm-worker builds. In the qualified single-thread artifact, it
rejects an existing transaction and uses Core database `execute("BEGIN
DEFERRED")` and rollback through a scoped guard. `database::is_in_transaction()`
reads SQLite autocommit state, and Core has no additional depth counter to bypass.
Normal statement/hook accounting is retained. No JavaScript call or value
construction occurs until the copied native snapshot has left the read scope.
Core logging is suppressed only during that scope, then restored on success or
exception, preventing `Module.printErr` reentry during the copy. Observer drain
requires autocommit and cannot deliver inside the held read transaction.

Limits refuse the entire capture; they never truncate: 16 tables, 64 selected
properties per table, 16,384 rows in total, 256 KiB per text/blob cell, 8 MiB of
cumulative copied payload, and 262,144 inspected/read cells. Caller row bounds
can be tighter (HUD uses 1,024 nodes and 1,024 sources). Before Core's existing
flat-row hydration can load values, actual physical schema and cell byte lengths
are checked in the same read transaction. Unselected or stale physical columns
are included, so an oversized unselected cell conservatively refuses capture.
Selected to-one junctions are discovered from installed internal-table metadata,
checked against the current Core getter mapping and actual physical columns, then
preflighted for row/byte/work bounds, unique parents and existing target identities.
Duplicate or dangling links refuse before Core can materialize them.
This bounds materialized values, rows and getter work, not a guaranteed wall-clock
latency. Strings must be valid UTF-8; selected stored scalar types must match the
registered physical descriptor, avoiding silent getter default coercion.

The candidate passed the combined 39-case actual Wasm/SQLite harness on
2026-10-24 with Core `e7361f9f9b6df889acf4035f02aa3350ce999327`. Its three capture
cases cover exact Int64 extrema, date zero/fractions, NULL, blobs, linked cycles,
detachment after writes, outer-transaction preservation, closed/unknown-schema
refusal, malformed scalar and oversized unselected values, row limits, duplicate/
dangling/oversized junction refusal, parent-link sentinel and NoHistory observer
invalidation, post-failure writes and zero native cleanup counters. Corrupt junctions
are deliberately written only in synthetic fixtures through an explicit native
writer transaction; capture itself remains read-only.

Receipt: `tmp/wasm-pending-capture-v2/runtime-v3.json` (39 passed, all five native
counters zero, no fatal/asynchronous errors). The 22 capture boundary tests are
part of 288 passing TypeScript tests (six existing skips). The first compile
receipt and two fixture-setup failures are retained in the same scratch lineage;
none is counted as a passing runtime gate. Candidate artifact SHA256:

- `lattice.js`: `eda61a80e5d719a37c36a6c620ba45215ea086a556272fa46cd66614e2156985`
- `lattice.wasm`: `2097e8d39a7b5ccc778bf575fa6aa3646ffda3565668421144c82642e3503157`

All-eight-model HUD open, the three-table browser read port, actual browser
storage and complete Swift↔Wasm file roundtrip are separate integration gates.
The upstream branch is unpublished; no native application pin or owner store
was changed. This receipt is not a cross-tab consistency, wall-clock latency or
release qualification claim.
