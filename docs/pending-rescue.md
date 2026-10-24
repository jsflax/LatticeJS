# Exact pending audit rescue

The opaque rescue path keeps native audit JSON unchanged between a read-only
source and a live target. It does not pass payloads through JavaScript
`JSON.parse` or `JSON.stringify`, which would round Int64 values above the safe
Number range. Core owns audit decoding, NoHistory late binding, pending import,
deduplication, row/journal transactions, and eventual upload acknowledgments.

Native boundaries:

- `getUnshippedAuditFrames(localOnly, maxEntries)` selects unsynchronized rows
  without an acknowledged `_lattice_sync_state` mark, in native audit order.
  Default selection includes relayed rows so a second rescue is possible.
  Each frame has `formatVersion: 1`, string-only `entries` metadata
  (`globalId`, `tableName`), and opaque `json`. A frame contains at most 1,000
  entries and 8 MiB of UTF-8 JSON. The entire export additionally refuses more
  than 4,096 entries or 16 MiB of raw/serialized data, before publishing any frame.
  Selection queries at most 4,097 identities and byte lengths before Core decodes
  selected rows; it does not load all audit history. Oversized work fails whole.
  Core's selected reader also bounds data read from live NoHistory fields.
- `importPendingFrame(json)` validates the raw array and unique audit IDs, then
  calls `apply_pending_changes`. The result separates `imported`,
  `alreadyPresent`, and `rejected` IDs. TypeScript accepts a report only when
  every offered ID appears exactly once in one category.
- The compatibility `applyRemoteChanges` method delegates to the same guarded
  pending importer. It keeps its accepted-ID array and `[]` failure shape;
  it no longer writes rows or journals with its own SQL. Server `receive`
  remains a separate Core path with normal receive/ACK semantics.

`Lattice.pendingUploadFrames(path)` reads through the existing isolated read-only
audit open and closes that handle even on failure. `drainPendingFrom` and
`resumePendingFrom` now use opaque frames; older runtimes fail closed, without
falling back to the legacy payload parser. Import and report failures never mark
or remove source entries. Even a successful import is not a delivery ACK: the
live uploader owns that acknowledgment. The existing catch-up quiet-window timing
is unchanged; it remains a heuristic, not an authoritative server barrier.

The legacy object APIs (`pendingUploads`, `selectPendingUploads`,
`drainPendingUploads`, and typed audit observation) support safe-number JSON only.
They reject unsafe integer tokens before decoding and reject unsafe materialized
numbers before retransmission. They do not claim lossless Int64 support. Exact
observation is available through `observeAuditFrames`, whose callback receives
the untouched native JSON string and shares normal observer disposal behavior.
This API also refuses older runtimes without the exact-frame capability.
Observer serialization uses the same bounded Core selected-row decoder and
NoHistory late binder, preserving synthesized snapshots and intentional NULLs.
Frame metadata is for accounting, not a substitute for native payload validation.
Legacy table filters are convenience only: underscore names gain no authority,
and Core rejects unsupported installed table/column shapes on every import.

The candidate passed the combined 39-case actual Wasm/SQLite harness against
Core `e7361f9f9b6df889acf4035f02aa3350ce999327` on 2026-10-24. Receipt:
`tmp/wasm-pending-capture-v2/runtime-v3.json`; all five native counters and remaining
handles were zero, with no fatal/asynchronous errors. Actual cases cover exact
Int64 values through two rescues and Core server receive, synthesized/NoHistory
observer metadata, nullable clear and legacy/required-null guards, duplicate ACKs,
refusal/deduplication and the separate detached capture packet. The prior 33-case
artifact is retained and does not qualify these new APIs. Full TypeScript tests
passed 288 with six existing skips; those tests supplement the actual native
runtime rather than establish Core parity themselves. Artifact hashes are
recorded in `docs/capture-values.md` and the build/runtime receipts.

Native HUD file interoperability, browser persistence, real network delivery,
published dependency adoption and release remain separately qualified work.
