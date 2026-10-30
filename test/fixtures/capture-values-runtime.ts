// Actual-Wasm cases: all native objects/SQLite are real; the facade uses the
// receipt-hashed open module instance, not a fake database.
import assert from 'node:assert/strict';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas } from '../../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';
import { captureValuesSync, CAPTURE_LIMITS } from '../../src/capture-values';

const table = 'DetachedCapture';
const definition = { formatVersion: 1, models: [{ tableName: table, properties: [
    { name: 'label', kind: 'primitive', type: 'string', nullable: false },
    { name: 'seq', kind: 'primitive', type: 'int', representation: 'bigint', nullable: false },
    { name: 'at', kind: 'primitive', type: 'date', representation: 'unixSeconds', nullable: false },
    { name: 'optional', kind: 'primitive', type: 'string', nullable: true, noHistory: true },
    { name: 'blob', kind: 'primitive', type: 'blob', nullable: false },
    { name: 'parent', kind: 'link', type: 'int', targetTable: table, nullable: true },
] }] } as const;
const selectors = [{ table, properties: ['label', 'seq', 'at', 'optional', 'blob', 'parent'], maxRows: 2 }];

export async function runCaptureValueCases({ module, test, newPath, register, dispose }: any) {
    async function fixture(body: (state: any) => Promise<any>) {
        const { DetachedCapture: Row } = defineModels(definition);
        const native = new module.Lattice(newPath('detached-capture'), buildSchemas([Row])); register(native);
        const db = Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice;
        const wrappers = new Set<any>();
        const own = (row: any) => { wrappers.add(row[DYNAMIC_OBJECT]); return row; };
        const add = async (label: string, seq: bigint, at: number) => {
            const row = own(new Row({ label, seq, at, optional: null, blob: new Uint8Array([0, 128, 255]), parent: null }));
            await db.add(row); return row;
        };
        setWasmModule(module);
        try { return await body({ native, db, add }); }
        finally { setWasmModule(null); for (const wrapper of wrappers) wrapper.delete(); dispose(native); }
    }
    await test('detached native capture preserves primitive codecs and linked cycles without wrappers', () => fixture(async ({ native, db, add }) => {
        const first = await add('first', -(1n << 63n), 0), second = await add('second', (1n << 63n) - 1n, -0.125);
        first.parent = second; second.parent = first;
        const captured = db.captureValuesSync(selectors);
        assert.equal(captured.rows.length, 2);
        const left = captured.rows.find(row => row.globalId === first.globalId)!, right = captured.rows.find(row => row.globalId === second.globalId)!;
        assert.deepEqual({ ...left.values }, { label: 'first', seq: -(1n << 63n), at: 0, optional: null, blob: [0, 128, 255], parent: { table, globalId: second.globalId } });
        assert.equal(right.values.seq, (1n << 63n) - 1n); assert.equal(right.values.at, -0.125);
        assert.deepEqual(right.values.parent, { table, globalId: first.globalId });
        first.label = 'later'; first.blob = new Uint8Array([9]);
        assert.equal(left.values.label, 'first'); assert.deepEqual(left.values.blob, [0, 128, 255]);
        assert.equal(captureValuesSync(native, selectors).rows.find(row => row.globalId === first.globalId)!.values.label, 'later');
        assert.ok(Object.isFrozen(left.values));
        // A bulk native packet must preserve JSON-looking text, escapes and
        // non-ASCII values without confusing text with its private integer tag.
        const literal = '{"$latticeInt64":"9223372036854775807"}\n"\\\t café 😀\u0000\u2028\u2029';
        first.label = literal;
        first.blob = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 256));
        const encoded = captureValuesSync(native, selectors).rows.find(row => row.globalId === first.globalId)!;
        const encodedBlob = encoded.values.blob;
        assert.ok(Array.isArray(encodedBlob));
        assert.equal(encoded.values.label, literal);
        assert.deepEqual(encodedBlob, Array.from(first.blob));
        assert.equal(encoded.values.seq, -(1n << 63n));
        first.label = 'after packet'; first.blob = new Uint8Array();
        assert.equal(encoded.values.label, literal); assert.equal(encodedBlob.length, 4096);
        // Streaming packet containers must keep the same scalar codec, even
        // across empty strings/blobs, all JSON control bytes and Int64 values
        // that cannot pass through a JavaScript Number without rounding.
        for (const sample of [
            { text: '', seq: 0n, bytes: [] },
            { text: Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join(''), seq: -9007199254740993n, bytes: Array.from({ length: 256 }, (_, i) => i) },
            { text: '\uD7FF\uE000\u{10FFFF}', seq: 9007199254740993n, bytes: [255, 0, 128] },
        ]) {
            first.label = sample.text; first.seq = sample.seq; first.blob = new Uint8Array(sample.bytes);
            const values = captureValuesSync(native, selectors).rows.find(row => row.globalId === first.globalId)!.values;
            assert.deepEqual({ label: values.label, seq: values.seq, blob: values.blob, optional: values.optional, parent: values.parent },
                { label: sample.text, seq: sample.seq, blob: sample.bytes, optional: null, parent: { table, globalId: second.globalId } });
        }
        for (const real of [-0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, 1.2345678901234567, 1e-30, 1e30]) {
            first.at = real;
            // Compare with the existing public getter's actual SQLite value:
            // storage may normalize -0; the packet must not introduce another
            // numeric conversion, including for subnormal and finite extremes.
            const stored = first.at;
            const copied = captureValuesSync(native, selectors).rows.find(row => row.globalId === first.globalId)!.values.at;
            assert.ok(Object.is(copied, stored), 'Packet floats must equal the existing getter, including signed zero and subnormals');
        }
        return { exactInt64: true, epochAndFraction: true, nullable: true, copiedBlob: true, cyclicIdentityLinks: true, detachedAfterWrite: true, escapedPacketTextAndBlob: true };
    }));
    await test('detached capture refuses outer transactions and preflight failures then allows ordinary writes', () => fixture(async ({ native, add }) => {
        const row = await add('initial', 7n, 0);
        native.beginWrite();
        try {
            row.label = 'outer-before';
            assert.throws(() => captureValuesSync(native, selectors), /active transaction/);
            row.label = 'outer-after';
        } finally { native.commitWrite(); }
        assert.equal(row.label, 'outer-after', 'Capture must not rollback or commit the caller transaction');
        assert.throws(() => captureValuesSync(native, [{ table: 'Missing', properties: ['value'] }]), /registered table/);
        assert.throws(() => captureValuesSync(native, [{ table, properties: ['missing'] }]), /Unknown capture property/);
        // Intentional malformed-storage fixture through native low-level API:
        // ordinary explicit-model setters already refuse a string for Int64.
        row[DYNAMIC_OBJECT].setString('seq', 'invalid-int');
        assert.throws(() => captureValuesSync(native, selectors), /stored scalar type/);
        row.seq = 8n; row.label = 'after-type-failure';
        row.optional = 'x'.repeat(CAPTURE_LIMITS.cellBytes + 1);
        assert.throws(() => captureValuesSync(native, [{ table, properties: ['label'] }]), /cell byte bound/, 'Unselected physical payload must still be bounded before hydration');
        row.optional = null;
        const second = await add('second', 9n, 1);
        assert.throws(() => captureValuesSync(native, [{ ...selectors[0], maxRows: 1 }]), /row bound/);
        second.label = 'post-failure-write';
        assert.equal(captureValuesSync(native, selectors).rows.find(item => item.globalId === second.globalId)!.values.label, 'post-failure-write');
        const closed = new module.Lattice(newPath('capture-closed'), buildSchemas([defineModels(definition).DetachedCapture])); register(closed);
        try { closed.releaseStorage(); assert.throws(() => captureValuesSync(closed, selectors), /open database/); }
        finally { dispose(closed); }
        return { outerTransactionPreserved: true, unknownSchemaRefused: true, invalidStoredTypeRefused: true, unselectedOversizeRefused: true, rowBounds: true, postFailureWrite: true, closedRefused: true };
    }));
    await test('detached capture refuses malformed junctions and table observers invalidate links and NoHistory', () => fixture(async ({ native, add }) => {
        const first = await add('first', 1n, 0), second = await add('second', 2n, 0), third = await add('third', 3n, 0);
        const selection = [{ ...selectors[0], maxRows: 4 }];
        let inCapture = false;
        const events: any[] = [];
        const observer = native.observeTable(table, (event: any) => { assert.equal(inCapture, false, 'No observer may reenter the capture read'); events.push(event); });
        const sqlText = (value: string) => "'" + value.replaceAll("'", "''") + "'";
        const junction = '"_DetachedCapture_DetachedCapture_parent"'; // Test-only fixture corruption of actual Core-generated table.
        // read_db() is read-only outside an owning transaction. Route this
        // intentional test corruption through the existing writer transaction;
        // assert setup succeeded rather than mistaking refusal for a bad capture.
        const corrupt = (sql: string) => {
            native.beginWrite();
            try { assert.equal(native.debugQueryCount(sql), 0, 'Synthetic corruption SQL must execute'); }
            finally { native.commitWrite(); }
        };
        const nativeCapture = () => { inCapture = true; try { return captureValuesSync(native, selection); } finally { inCapture = false; } };
        try {
            first.parent = second;
            first.optional = 'NoHistory changed';
            assert.equal(nativeCapture().rows.find(row => row.globalId === first.globalId)!.values.optional, 'NoHistory changed');
            for (let i = 0; i < 8; ++i) await new Promise(resolve => setTimeout(resolve, 0));
            assert.ok(events.some(event => event.operation === 'UPDATE' && event.rowId === 0 && event.globalRowId === ''), 'Junction edit must invalidate the parent model table');
            assert.ok(events.some(event => event.operation === 'UPDATE' && event.globalRowId === first.globalId), 'NoHistory change must invalidate the model table');
            corrupt(`INSERT INTO ${junction} (lhs,rhs,globalId) VALUES (${sqlText(first.globalId)},${sqlText(third.globalId)},'duplicate-test-link')`);
            assert.throws(nativeCapture, /Duplicate capture to-one link/);
            corrupt(`DELETE FROM ${junction} WHERE globalId='duplicate-test-link'`);
            corrupt(`UPDATE ${junction} SET rhs='missing-test-target' WHERE lhs=${sqlText(first.globalId)}`);
            assert.throws(nativeCapture, /Dangling capture to-one link/);
            first.parent = second;
            corrupt(`INSERT INTO ${junction} (lhs,rhs,globalId) VALUES (${sqlText(third.globalId)},${sqlText('x'.repeat(CAPTURE_LIMITS.cellBytes + 1))},'oversize-test-link')`);
            assert.throws(nativeCapture, /cell byte bound/);
            corrupt(`DELETE FROM ${junction} WHERE globalId='oversize-test-link'`);
            first.optional = 'after-junction-refusals';
            assert.equal(nativeCapture().rows.find(row => row.globalId === first.globalId)!.values.optional, 'after-junction-refusals');
            return { duplicateLinkRefused: true, danglingLinkRefused: true, junctionPayloadBound: true, parentSentinelObserved: true, noHistoryObserved: true, noObserverReentry: true };
        } finally { native.removeTableObserver(table, observer); }
    }));
    await test('detached scalar capture statement work is independent of selected cells and row count', () => fixture(async ({ db, add }) => {
        assert.equal(typeof module._captureStatementCount, 'function', 'Capture SQL diagnostic requires the candidate artifact');
        const measure = (properties: string[]) => {
            const before = module._captureStatementCount();
            assert.equal(typeof before, 'bigint');
            const captured = (db as Lattice).captureValuesSync([{ table, properties, maxRows: 64 }]);
            const statements = module._captureStatementCount() - before;
            assert.ok(statements > 0n, 'The real SQLite capture must execute statements');
            return { captured, statements };
        };
        const first = await add('first', -(1n << 63n), -0.125);
        const narrow = measure(['label']);
        const properties = ['label', 'seq', 'at', 'optional', 'blob'];
        const wide = measure(properties);
        assert.equal(wide.statements, narrow.statements, 'Selecting additional hydrated scalar cells must not issue per-cell SQL');
        const expected = [{ table, globalId: first.globalId, values: {
            label: 'first', seq: -(1n << 63n), at: -0.125, optional: null, blob: [0, 128, 255],
        } }];
        for (let i = 1; i < 64; ++i) {
            const row = await add(`row-${i}`, BigInt(i), i + 0.25);
            expected.push({ table, globalId: row.globalId, values: {
                label: `row-${i}`, seq: BigInt(i), at: i + 0.25, optional: null, blob: [0, 128, 255],
            } });
        }
        const many = measure(properties);
        assert.equal(many.captured.rows.length, 64);
        assert.equal(many.statements, wide.statements, 'Additional rows must not issue per-row scalar SELECTs');
        assert.deepEqual(many.captured.rows.map(row => ({ ...row, values: { ...row.values } })), expected,
            'Selected scalar values must remain exact and rows must retain physical insertion order');
        const reversed = measure([...properties].reverse());
        assert.deepEqual(reversed.captured, many.captured, 'Selector field order must not change values or row order');
        assert.equal(reversed.statements, many.statements, 'Reordered scalar selection must not add SQL');
        assert.throws(() => (db as Lattice).captureValuesSync([{ table, properties, maxRows: 63 }]), /row bound/,
            'Direct selected reads must refuse excess rows rather than return a truncated prefix');
        assert.deepEqual(measure(properties).captured, many.captured, 'A refused capture must leave exact prior values readable');
        const saved = many.captured.rows.find(row => row.globalId === first.globalId)!;
        assert.deepEqual({ ...saved.values }, { label: 'first', seq: -(1n << 63n), at: -0.125, optional: null, blob: [0, 128, 255] });
        first.optional = 'present'; first.seq = (1n << 63n) - 1n; first.blob = new Uint8Array();
        const updated = measure(properties).captured.rows.find(row => row.globalId === first.globalId)!;
        assert.equal(updated.values.optional, 'present'); assert.equal(updated.values.seq, (1n << 63n) - 1n); assert.deepEqual(updated.values.blob, []);
        first.optional = null;
        assert.equal(measure(properties).captured.rows.find(row => row.globalId === first.globalId)!.values.optional, null);
        assert.equal(saved.values.optional, null); assert.equal(saved.values.seq, -(1n << 63n)); assert.deepEqual(saved.values.blob, [0, 128, 255]);
        return { rows: 64, selectedPrimitiveFields: 5, narrowStatements: String(narrow.statements), wideStatements: String(wide.statements), manyStatements: String(many.statements), freshNullAndBlob: true, exactScalarProjectionAndOrder: true, rowBoundRefusalAndRecovery: true };
    }));
    await test('detached cross-table links reuse identities with nullable repeated targets and no per-parent SQL', async () => {
        const { CaptureOwner: Owner, CaptureTarget: Target } = defineModels({ formatVersion: 1, models: [
            { tableName: 'CaptureOwner', properties: [
                { name: 'target', kind: 'link', type: 'int', targetTable: 'CaptureTarget', nullable: true },
            ] },
            { tableName: 'CaptureTarget', properties: [
                { name: 'label', kind: 'primitive', type: 'string', nullable: false },
                { name: 'owner', kind: 'link', type: 'int', targetTable: 'CaptureOwner', nullable: true },
            ] },
        ] } as const);
        const native = new module.Lattice(newPath('capture-repeated-links'), buildSchemas([Owner, Target])); register(native);
        const db = Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice;
        const wrappers = new Set<any>();
        const add = async (row: any) => { wrappers.add(row[DYNAMIC_OBJECT]); await db.add(row); return row; };
        const selection = [
            { table: 'CaptureOwner', properties: ['target'], maxRows: 64 },
            { table: 'CaptureTarget', properties: ['label', 'owner'], maxRows: 2 },
        ];
        const capture = () => {
            const before = module._captureStatementCount();
            const result = db.captureValuesSync(selection);
            return { result, statements: module._captureStatementCount() - before };
        };
        setWasmModule(module);
        try {
            const target = await add(new Target({ label: 'shared', owner: null }));
            const first = await add(new Owner({ target })); target.owner = first;
            assert.throws(() => db.captureValuesSync([selection[0]]), /link target must also be selected/);
            assert.equal(db.captureValuesSync([{ table: 'CaptureTarget', properties: ['label'] }]).rows[0]!.values.label, 'shared', 'Unselected link fields must not require their target table');
            const one = capture();
            const owners = [first];
            for (let i = 1; i < 64; ++i) owners.push(await add(new Owner({ target: i === 63 ? null : target })));
            const many = capture();
            assert.equal(many.statements, one.statements, 'Repeated target links must not hydrate/query each parent');
            assert.equal(many.result.rows.length, 65);
            for (const owner of owners) assert.deepEqual(many.result.rows.find(row => row.globalId === owner.globalId)!.values.target,
                owner === owners[63] ? null : { table: 'CaptureTarget', globalId: target.globalId });
            assert.deepEqual(many.result.rows.find(row => row.globalId === target.globalId)!.values.owner, { table: 'CaptureOwner', globalId: first.globalId });
            first.target = null; owners[63].target = target;
            const next = capture().result;
            assert.equal(next.rows.find(row => row.globalId === first.globalId)!.values.target, null);
            assert.deepEqual(next.rows.find(row => row.globalId === owners[63].globalId)!.values.target, { table: 'CaptureTarget', globalId: target.globalId });
            assert.deepEqual(many.result.rows.find(row => row.globalId === first.globalId)!.values.target, { table: 'CaptureTarget', globalId: target.globalId });
            return { repeatedTargets: 63, nullable: true, crossTableCycle: true, unselectedTargetRefused: true, scalarOnlyAllowed: true, oneStatements: String(one.statements), manyStatements: String(many.statements) };
        } finally { setWasmModule(null); for (const wrapper of wrappers) wrapper.delete(); dispose(native); }
    });
    await test('detached junction aliases preserve canonical stored identity spelling', () => fixture(async ({ native, add }) => {
        const first = await add('first', 1n, 0), second = await add('second', 2n, 0);
        first.parent = second;
        const firstID = 'a1111111-1111-4111-8111-111111111111', secondID = 'b2222222-2222-4222-8222-222222222222';
        const oldFirst = first.globalId, oldSecond = second.globalId;
        const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
        native.beginWrite();
        try {
            // Real stored UUIDs and real Core junction; only case differs from
            // each target row. No lazy wrappers are used after this setup.
            for (const sql of [
                `UPDATE DetachedCapture SET globalId=${quote(firstID)} WHERE globalId=${quote(oldFirst)}`,
                `UPDATE DetachedCapture SET globalId=${quote(secondID)} WHERE globalId=${quote(oldSecond)}`,
                `UPDATE _DetachedCapture_DetachedCapture_parent SET lhs=${quote(firstID.toUpperCase())},rhs=${quote(secondID.toUpperCase())}`,
            ]) assert.equal(native.debugQueryCount(sql), 0);
        } finally { native.commitWrite(); }
        const captured = captureValuesSync(native, selectors);
        assert.deepEqual(captured.rows.find(row => row.globalId === firstID)!.values.parent, { table, globalId: secondID });
        assert.equal(captured.rows.find(row => row.globalId === secondID)!.values.parent, null);
        return { canonicalTargetUUID: true, caseInsensitiveJunction: true, absentLinkIsNull: true };
    }));
    await test('detached aggregate preflight admits empty wide schemas and exact physical cell limits', async () => {
        const wideTable = 'CaptureWide';
        const names = Array.from({ length: 63 }, (_, i) => `value${i}`);
        const { CaptureWide: Wide } = defineModels({ formatVersion: 1, models: [{
            tableName: wideTable,
            properties: names.map(name => ({ name, kind: 'primitive' as const, type: 'string' as const, nullable: true })),
        }] });
        const native = new module.Lattice(newPath('capture-wide-aggregate'), buildSchemas([Wide])); register(native);
        const db = Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice;
        let wrapper: any;
        setWasmModule(module);
        try {
            const initialColumns = native.debugQueryCount('PRAGMA table_info(CaptureWide)');
            assert.equal(initialColumns, 65, 'Real model has 63 scalars and the two identity columns');
            native.beginWrite();
            try {
                for (let i = initialColumns; i < 512; ++i)
                    assert.equal(native.debugQueryCount(`ALTER TABLE CaptureWide ADD COLUMN stale${i} BLOB`), 0);
            } finally { native.commitWrite(); }
            assert.equal(native.debugQueryCount('PRAGMA table_info(CaptureWide)'), 512);
            // Core audit triggers accept 63 scalar fields under SQLite's 127-argument
            // limit. MAX/SUM for 512 physical columns plus those 63 type checks
            // exercises 1,088 aggregate result columns, even on an empty table.
            assert.deepEqual(db.captureValuesSync([{ table: wideTable, properties: names }]).rows, []);
            const row = new Wide(Object.fromEntries(names.map(name => [name, null])));
            wrapper = (row as any)[DYNAMIC_OBJECT]; await db.add(row);
            row.value0 = 'x'.repeat(CAPTURE_LIMITS.cellBytes);
            row.value1 = 'after-empty';
            const selection = [{ table: wideTable, properties: ['value1'] }];
            assert.equal(db.captureValuesSync(selection).rows[0]!.values.value1, 'after-empty');
            row.value0 += 'x';
            assert.throws(() => db.captureValuesSync(selection), /cell byte bound/);
            row.value0 = null; row.value1 = 'after-cell-refusal';
            assert.equal(db.captureValuesSync(selection).rows[0]!.values.value1, 'after-cell-refusal');
            return { physicalColumns: 512, selectedProperties: 63, aggregateResultColumns: 1088, empty: true, exactCellAdmitted: true, unselectedOversizeRefused: true, postFailureWrite: true };
        } finally { setWasmModule(null); wrapper?.delete(); dispose(native); }
    });
    await test('detached aggregate preflight enforces one byte budget across selected tables', async () => {
        const definitions = ['CaptureBudgetA', 'CaptureBudgetB'].map(tableName => ({ tableName, properties: [
            { name: 'label', kind: 'primitive' as const, type: 'string' as const, nullable: false },
            { name: 'payload', kind: 'primitive' as const, type: 'string' as const, nullable: true },
        ] }));
        const models = defineModels({ formatVersion: 1, models: definitions });
        const native = new module.Lattice(newPath('capture-table-budget'), buildSchemas(Object.values(models))); register(native);
        const db = Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice;
        const rows: any[] = [];
        const selection = definitions.map(model => ({ table: model.tableName, properties: ['label'], maxRows: 17 }));
        setWasmModule(module);
        try {
            for (const { tableName } of definitions) for (let i = 0; i < 17; ++i) {
                const Row = models[tableName]!;
                const row = new Row({ label: `${tableName}-${i}`, payload: 'x'.repeat(CAPTURE_LIMITS.cellBytes) });
                rows.push(row); await db.add(row);
            }
            for (const part of selection) assert.equal(db.captureValuesSync([part]).rows.length, 17, 'Each table is within the total bound alone');
            assert.throws(() => db.captureValuesSync(selection), /aggregate byte bound/, 'The budget is shared across every selected table');
            for (const row of rows) row.payload = null;
            rows[33].label = 'after-aggregate-refusal';
            const recovered = db.captureValuesSync(selection);
            assert.equal(recovered.rows.length, 34);
            assert.equal(recovered.rows.find(row => row.globalId === rows[33].globalId)!.values.label, 'after-aggregate-refusal');
            return { tables: 2, rowsPerTable: 17, individualTablesAdmitted: true, combinedBytesRefused: true, completeRecovery: true };
        } finally { setWasmModule(null); for (const row of rows) row[DYNAMIC_OBJECT].delete(); dispose(native); }
    });
    await test('detached aggregate type admission checks late rows while preserving nullable nulls', () => fixture(async ({ native, add }) => {
        const first = await add('first', 1n, 0), second = await add('second', 2n, -0.125), last = await add('last', 3n, 1);
        const selection = [{ table, properties: ['label', 'seq', 'at', 'optional'], maxRows: 3 }];
        const before = captureValuesSync(native, selection);
        assert.equal(before.rows.length, 3);
        assert.ok(before.rows.every(row => row.values.optional === null));
        last[DYNAMIC_OBJECT].setString('seq', 'invalid-late-int');
        assert.throws(() => captureValuesSync(native, selection), /stored scalar type/);
        last.seq = 4n; last.label = 'after-late-refusal';
        const recovered = captureValuesSync(native, selection);
        for (const unchanged of [first, second])
            assert.deepEqual(recovered.rows.find(row => row.globalId === unchanged.globalId)!.values, before.rows.find(row => row.globalId === unchanged.globalId)!.values);
        assert.deepEqual({ ...recovered.rows.find(row => row.globalId === last.globalId)!.values }, { label: 'after-late-refusal', seq: 4n, at: 1, optional: null });
        assert.equal(before.rows.find(row => row.globalId === last.globalId)!.values.seq, 3n, 'Earlier detached values remain immutable');
        return { lateInvalidTypeRefused: true, nullableNullsRetained: true, siblingValuesUnchanged: true, detachedValuesUnchanged: true, postFailureWrite: true };
    }));
}
