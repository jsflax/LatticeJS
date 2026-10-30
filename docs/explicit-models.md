# Explicit model definitions

`defineModels` defines Lattice models from validated descriptors without executing
an application constructor or inferring a property's type or default. It returns
ordinary model constructors accepted by `Lattice.open`, query and hydration APIs.

```ts
import { defineModels, Lattice } from '@jsflax/lattice';

const models = defineModels({
    formatVersion: 1,
    models: [{
        tableName: 'Note',
        properties: [
            { name: 'text', kind: 'primitive', type: 'string', nullable: false },
            { name: 'seq', kind: 'primitive', type: 'int', representation: 'bigint', nullable: false },
            { name: 'checkedAt', kind: 'primitive', type: 'date', representation: 'unixSeconds', nullable: true },
            { name: 'parent', kind: 'link', type: 'int', targetTable: 'Note', nullable: true },
        ],
        constraints: [{ columns: ['text', 'seq'], allowsUpsert: true }],
    }],
});
const db = await Lattice.open(':memory:', Object.values(models));
const note = new models.Note({ text: 'Example', seq: 9007199254740993n, checkedAt: 0, parent: null });
await db.add(note);
```

Every field is required at creation, including an explicit `null` for nullable
fields. There are no implicit defaults. Unknown fields, invalid types and missing
values fail before native object allocation. Definitions are copied and frozen;
mutating their input later does not change the installed schema.

Supported primitive storage types are `string`, `int`, `float`, `bool`, `date` and
`blob`. Int64 fields require BigInt values within the signed 64-bit range. Float
and date values require finite Numbers; dates remain exact stored double values
in Unix seconds, including zero, without conversion to JavaScript `Date`.
Blob values are `Uint8Array`. No scalar coercion occurs. Links accept instances of
their declared target model; targets, including circular relationships, must be
defined in the same call. Index/full-text flags and compound upsert constraints
are forwarded through existing schema metadata.

The additional union capability uses explicit case metadata and requires
`explicitUnionVersion() === 1` from the native runtime before opening a store or
allocating an unmanaged object. A union descriptor uses `kind: 'union'`,
`type: 'string'`, physical `nullable: true`, a separate `logicalNullable` boolean,
its Core-owned `targetTable`, and ordered `unionCases`. Each case specifies a
`name` and ordered `values` containing `paramName` and `type: 'string' | 'int'`.
Values have the shape `{ case: 'claim', fields: { owner: 'example', ttlMs: 9n } }`.
Bare cases use an empty `fields` record. A single unnamed associated value uses
the `_0` key; multiple values must all have explicit labels. Associated Int64
values remain BigInt. No associated field is inferred, coerced or nullable.

Optional union values use `null`; required unions reject it on both reads and
writes. Physical optionality is preserved independently of that logical rule.
Case switches and clearing use Core's union API and side-table ownership, never
JSON columns or direct SQL writes. Descriptor validation rejects case-insensitive
storage column collisions, model/union-table collisions, conflicting shared
union tables, more than 128 cases or 64 fields per case, and unsupported metadata.
Union values and descriptors are copied and frozen without invoking accessors.
The union implementation passed three actual Wasm cases in the 33-case combined
receipt below: exact case/Int64 hydration, replacement/null cleanup and reopen,
and malformed/dangling-reference refusal without corrupting stored values.

Primitive descriptors additionally accept an explicit `noHistory` boolean. True
requires `explicitNoHistoryVersion() === 1` before opening or allocating models;
false is forwarded unchanged, and absent metadata remains absent. Links and unions
reject this flag even when false. Core owns the installed trigger policy: UPDATE
history records that a value changed, then outgoing entries read its latest value.
The paired Core wire capability distinguishes observed nullable clears with
`noHistoryNulls` from legacy placeholder nulls. Two actual Wasm cases verify raw valueless history, late-bound nullable clear
markers, Core receive, the legacy placeholder guard and required-column null
refusal. Full native-file interoperability remains pending. Pending-upload import
is a separate unqualified path, including its current lossy JS numeric decoding.

Lists, authored defaults and embedded/enum codecs remain excluded.
Unsupported fields are rejected, even when their value is
false. A generated native schema must be adapted explicitly and rejected if it
requires one of these capabilities; stripping metadata to make it fit is unsafe.
The full HUD storage export still requires actual native-file qualification before
adoption; accepting descriptor metadata alone does not establish interoperability.

Row IDs still use the existing safe-Number find/remove contract. Native BigInt IDs
within that range can be represented exactly; IDs outside it throw instead of
rounding. This is a deliberate refusal of unsupported IDs, not support for the
entire Int64 row-ID range. Int64 *property values* remain BigInt independently.
Explicit model query results must hydrate a real managed object. Missing IDs,
unsafe IDs and failed native lookups throw; they do not create detached copies.
`addAll` currently uses a separate plain-object conversion path and is unsupported
for explicit models. Any batch containing one is rejected before native access,
including mixed batches. Use the supported `add` operation for each model.
`findByGlobalId`, `Results.nearest` and `Results.matching` are also refused before
native access for explicit models. Global-ID and full-text lookups need an
identity-only boundary; vector metadata is outside this first capability.
Use `find` with a checked row ID. Ordinary array, indexed, snapshot and iterator
queries require the native `objectIdentities` capability and hydrate managed
objects from its checked IDs. Older runtimes fail before querying; there is no
fallback to recursive plain-object graph materialization.

Existing decorator models retain their prior representation and inference rules.
The explicit path reuses their metadata, native-backed accessors and constructor-
free hydration. `test/explicit-models.test.ts` checks the TypeScript boundary with
instrumented native handles; these tests do not establish actual Wasm/native
storage parity. The real rebuilt-Wasm harness passed all 26 cases on October 24,
2026 (07:13 UTC), including scalar values, constructor-free managed hydration,
identity refusal, managed cyclic links, constraint-error delivery and failed-add
retry. All native ownership counters returned to zero, with no async errors or
fatal native logs. The receipt is `tmp/native-runtime-unmanaged-link-v1.json`;
its adjacent source manifest and receipt record the exact unpublished Core
override, bindings and built artifact hashes. The additional schema capabilities
are still required before adopting a native HUD replica. The harness uses a
fixture WebSocket and does not cover a real browser, network synchronization,
OPFS, the public loader or release qualification.


Combined unpublished runtime qualification passed **33/33** on October 24, 2026
at 08:20:36 UTC: `tmp/wasm-union-nohistory-v1/runtime-v2.json`. This includes the
existing 26 cases, two Core receive/ACK cases, three unions and two NoHistory
cases. All five native ownership counters returned to zero; no asynchronous or
fatal native errors remained. The same directory preserves exact source copies,
tracked diffs, Core HEAD `844c7ac6840d5be4e06c8113280b8d8f492fcd76` plus the
uncommitted accessor/unmanaged-link changes, build commands and artifact hashes.
The first receipt failed only because the test diagnostic matcher omitted the
strict parser's “Unsupported record field” wording; it is preserved. The matcher
was corrected and the same built artifact passed without a rebuild. This does not
qualify the public browser loader, OPFS, real network sync, native HUD file
round-trip, dependency adoption or release publication.

The qualified compiled files are recorded by SHA-256 (build outputs stay local):

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `wasm/build/lattice.js` | 139113 | `cf2147f44ac32a892700792750bb29856af0eb377cd1143976688b845b6b8e38` |
| `wasm/build/lattice.wasm` | 3223627 | `e558d18b9e91de540d12dc64f7d81daec95aa2961da31502d17926ae770f0e0f` |

This build explicitly used `LATTICECORE_DIR=/Users/jason/localdev/latticecore-hud-migration`.
The checked-in Core submodule pin is unchanged; a default build against that old
pin is not the qualified candidate. The unpublished Core changes and matching
bindings must be reviewed and adopted together before release.

The full TypeScript check finished at 08:26:29 UTC on October 24, 2026:
12 test files, **243 passed and 6 skipped**, `npm run build:ts` passed, and the
separate two-test SQLite junction diagnostic passed. Commands, logs and assertions
are retained in `tmp/qualified-typescript-v1`. Vitest's top-level JSON counters
incorrectly count skipped assertions as passed; the assertion-level statuses and
console summary supply the counts above. The skips are the existing list decorator
Wasm test and five browser integration examples, not additional qualified coverage.
The suite ran with at most two fork workers and no native rebuild:

```sh
npm run test -- --pool=forks --poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=1
npm run build:ts
node --test test/native-hud-junctions.test.mjs
```
