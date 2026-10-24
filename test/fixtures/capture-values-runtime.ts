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
        return { exactInt64: true, epochAndFraction: true, nullable: true, copiedBlob: true, cyclicIdentityLinks: true, detachedAfterWrite: true };
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
}
