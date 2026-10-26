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

## 2026-10-25: bulk export candidate and current limits

The later candidate at LatticeJS
`7550597bdcb720c5be73bba22482e0f1d8d8a147`, paired with Core
`db81e0ced019803ffa5fd5c7fc5ee80d17b8aac9`, passes a fresh Release build and
all 45 actual Wasm/SQLite runtime cases. This includes the original 39, three
scalar/link-query regressions, and three aggregate-admission regressions. The
original primitive-codec case additionally checks escaped and tag-looking text,
Unicode, embedded NUL and line separators, and a detached 4 KiB blob. All final
native resource counters and retained handles are zero, with no asynchronous
errors or fatal logs. The paired Core passes 74 selected native cases, including
the formerly failing mixed model registry and geographic-list schema checks.

Capture now reuses snapshot-local hydrated values and validated link identities,
aggregates physical-cell preflight before hydration, and crosses the Wasm
boundary once with a detached JSON packet. Private integer tags are decoded to
BigInt before the existing public validation/copy boundary; there is no public
codec or result-shape change. Selected scalar statement counts stay at 7 for
one field, five fields, and 64 rows; repeated link targets stay at 22 statements.
These are statement-count checks, not a latency guarantee.

Qualification receipt: `/Users/jason/localdev/hud-scratch/hud-capture-bulk-export-v1/qualification/qualification.json`.
Candidate artifact SHA256:

- `lattice.js`: `f9381842b21fa91ebb8c3792bfff33663e0469b15026db33e3bde984714c6410`
- `lattice.wasm`: `90b91786aa02f6ab9333c11cc013ea35bec4293bd41a174851e0d04b6807b5d3`

The payload limits above are unchanged. The temporary JSON representation adds
keys, escaping, integer tags and numeric blob arrays, so the 8 MiB logical payload
limit is not an encoded JSON size or peak-memory/RSS bound. Capture still runs on
the main thread; this candidate adds no worker or persistent cross-call cache.

The separate local Chrome/macOS 652-node HUD consumer, with its renderer admission
optimization, passed all seven behavior/lifecycle checks but missed performance
budgets: mount 257.8 ms against 500 ms, update p95 178 ms against 100 ms, burst-frame
p95 150 ms against 34 ms, and scroll-frame p95 16.8 ms against 34 ms. All nine
owned children joined and the terminal process census was clear. The ordinary
mount/update budgets were measured without profiling; the input profile is a
separate diagnostic. This does not qualify end-to-end latency, physical devices,
remote sync, or a release. Receipt:
`/Users/jason/localdev/hud-scratch/hud-live-performance-v1/owned-bulk45-renderer-v1/evidence/browser/receipt.json`.
