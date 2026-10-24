// Bundled by the actual-WASM harness. Native objects/database handles are real;
// the TS facade only reuses the already-open, receipt-hashed module instance.
import assert from 'node:assert/strict';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas, hydrateInstance } from '../../src/decorators';
import { DYNAMIC_OBJECT, LATTICE_REF, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';
import { runExplicitUnionCases } from './explicit-unions-runtime';
import { runExplicitNoHistoryCases } from './explicit-nohistory-runtime';

export async function runExplicitModelCases({ module, test, newPath, register, dispose }: any) {
    const definition = {
        formatVersion: 1,
        models: [{ tableName: 'ExplicitRuntime', properties: [
            { name: 'name', kind: 'primitive', type: 'string', nullable: false },
            { name: 'seq', kind: 'primitive', type: 'int', representation: 'bigint', nullable: false },
            { name: 'at', kind: 'primitive', type: 'date', representation: 'unixSeconds', nullable: true },
            { name: 'score', kind: 'primitive', type: 'float', nullable: false },
            { name: 'ok', kind: 'primitive', type: 'bool', nullable: false },
            { name: 'bytes', kind: 'primitive', type: 'blob', nullable: true },
            { name: 'parent', kind: 'link', type: 'int', targetTable: 'ExplicitRuntime', nullable: true },
        ], constraints: [{ columns: ['name', 'seq'], allowsUpsert: false }] }],
    } as const;
    async function fixture(body: (state: any) => Promise<any>) {
        const { ExplicitRuntime: Row } = defineModels(definition);
        const native = new module.Lattice(newPath('explicit'), buildSchemas([Row]));
        register(native);
        // This invokes real Lattice methods over the actual native handle. It
        // does not claim coverage of the separate public open/OPFS loader.
        const db = Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice;
        const wrappers = new Set<any>();
        const own = <T>(row: T): T => { if (row) wrappers.add((row as any)[DYNAMIC_OBJECT]); return row; };
        const make = (overrides: any = {}) => own(new Row({ name: 'one', seq: 1n, at: 0, score: 7, ok: false, bytes: null, parent: null, ...overrides }));
        setWasmModule(module);
        try { return await body({ Row, native, db, make, own }); }
        finally {
            setWasmModule(null);
            for (const wrapper of wrappers) wrapper.delete();
            dispose(native);
        }
    }

    await test('explicit model scalar codecs round-trip actual Wasm SQLite without constructor hydration', () => fixture(async ({ Row, native, db, make, own }) => {
        const integers = [-(1n << 63n), (1n << 63n) - 1n, (1n << 53n) - 1n, (1n << 53n) + 1n];
        const dates = [0, -0.125, 1234567890.123456, null];
        for (let index = 0; index < integers.length; ++index) {
            await db.add(make({ name: `value-${index}`, seq: integers[index], at: dates[index], bytes: index === 0 ? new Uint8Array([0, 255, 128]) : index === 1 ? new Uint8Array() : null }));
        }
        // Construction would now throw. Managed query hydration must not use it.
        setWasmModule(null);
        assert.throws(() => make(), /WASM not loaded/);
        const rows = (await db.objectsArray(Row, { orderBy: 'name ASC' })).map(own);
        assert.equal(rows.length, 4);
        for (let index = 0; index < rows.length; ++index) {
            assert.equal(rows[index].seq, integers[index]);
            assert.equal(rows[index].at, dates[index]);
            assert.equal(rows[index].score, 7);
            assert.equal(rows[index].ok, false);
        }
        assert.deepEqual(rows[0].bytes, new Uint8Array([0, 255, 128]));
        assert.deepEqual(rows[1].bytes, new Uint8Array());
        assert.equal(rows[2].bytes, null);
        const copiedBytes = rows[0].bytes;
        copiedBytes[0] = 44;
        assert.deepEqual(rows[0].bytes, new Uint8Array([0, 255, 128]), 'getData must return JS-owned bytes');
        rows[3].seq = (1n << 53n) + 3n;
        rows[3].at = 0;
        const found = own(await db.find(Row, rows[3].id));
        assert.equal(found.seq, (1n << 53n) + 3n);
        assert.equal(found.at, 0);
        assert.equal(Number(native.debugQueryCount("SELECT id FROM ExplicitRuntime WHERE name='value-3' AND seq=9007199254740995 AND at=0")), 1);
        assert.equal(Number(native.debugQueryCount("SELECT id FROM ExplicitRuntime WHERE hex(bytes)='00FF80'")), 1);
        return { actualSQLite: true, int64Boundaries: integers.map(String), dateZeroAndNull: true, blobOwnedCopy: true, queryConstructorUnavailable: true, managedUpdatePersisted: true };
    }));

    await test('explicit row IDs reject unsafe native integers rather than rounding', () => fixture(async ({ Row, db, make }) => {
        const unmanaged = make();
        await assert.rejects(() => db.addAll([unmanaged]), /addAll is not supported/);
        await assert.rejects(() => db.findByGlobalId(Row, 'unsupported-global-id'), /findByGlobalId is not supported/);
        await assert.rejects(() => db.objects(Row).nearest('bytes', new Float32Array([1]), 1), /nearest is not supported/);
        await assert.rejects(() => db.objects(Row).matching('name', 'example'), /matching is not supported/);
        assert.equal(await db.count(Row), 0);
        unmanaged[DYNAMIC_OBJECT].setInt('id', (1n << 53n) + 1n);
        assert.equal(unmanaged[DYNAMIC_OBJECT].getInt('id'), (1n << 53n) + 1n);
        const hydrated = hydrateInstance(Row, unmanaged[DYNAMIC_OBJECT], db);
        assert.throws(() => hydrated.id, /safe integer/);
        await assert.rejects(() => db.find(Row, Number.MAX_SAFE_INTEGER + 1), /safe integer/);
        await assert.rejects(() => db.remove(Row, Number.MAX_SAFE_INTEGER + 1), /safe integer/);
        return { actualNativeInt64Read: true, unsafeIdentityRefused: true, unsafeLookupAndRemoveRefused: true, unsupportedBulkRefusedWithoutWrite: true, unsupportedGlobalIDAndVectorRoutesRefused: true, fullInt64RowIDSupport: false };
    }));
    await test('explicit compound constraints preserve rows and allow a failed insert to retry', () => fixture(async ({ Row, native, db, make, own }) => {
        const first = make({ name: 'first' });
        const second = make({ name: 'second' });
        await db.add(first);
        await db.add(second);
        let failure: unknown;
        try { first.name = 'second'; } catch (error) { failure = error; }
        assert.ok(failure instanceof Error, `native setter must throw a JavaScript Error, got ${String(failure)}`);
        assert.match(failure.message, /unique|constraint/i);
        assert.equal(first.name, 'first');
        assert.equal(own(await db.find(Row, first.id)).name, 'first');
        assert.equal(Number(native.debugQueryCount("SELECT id FROM ExplicitRuntime WHERE name IN ('first','second') AND seq=1")), 2);
        const duplicate = make({ name: 'first', at: 42 });
        let insertFailure: unknown;
        try { await db.add(duplicate); } catch (error) { insertFailure = error; }
        assert.ok(insertFailure instanceof Error, `native add must throw a JavaScript Error, got ${String(insertFailure)}`);
        assert.match(insertFailure.message, /unique|constraint/i);
        assert.equal(await db.count(Row), 2);
        assert.equal(own(await db.find(Row, first.id)).at, 0, 'failed insert must not replace the original row');
        assert.equal(duplicate[LATTICE_REF], undefined, 'failed insert must remain unmanaged');
        assert.equal(duplicate[DYNAMIC_OBJECT].isValid(), true);
        assert.equal(duplicate.name, 'first');
        assert.equal(duplicate.seq, 1n);
        assert.equal(duplicate.at, 42);
        duplicate.name = 'recovered';
        assert.equal(await db.add(duplicate), duplicate);
        assert.equal(duplicate[LATTICE_REF], db);
        assert.ok(duplicate.id > 0);
        assert.equal(await db.count(Row), 3);
        const recovered = own(await db.find(Row, duplicate.id));
        assert.equal(recovered.name, 'recovered');
        assert.equal(recovered.at, 42);
        assert.equal(own(await db.find(Row, first.id)).name, 'first');
        return { compoundConstraintEnforced: true, nativeFailureIsJSError: true, failedWritePreservedData: true, duplicateAddIsJSError: true, failedInsertRemainsUnmanaged: true, correctedRetryPersists: true };
    }));

    await test('explicit model links preserve native presence nullability and target codecs', () => fixture(async ({ Row, native, db, make, own }) => {
        const parent = make({ name: 'parent', seq: (1n << 53n) + 1n });
        const child = make({ name: 'child', parent });
        assert.equal(parent[DYNAMIC_OBJECT].hasValue('parent'), false);
        assert.equal(child[DYNAMIC_OBJECT].hasValue('parent'), true);
        const stagedLink = own(child.parent);
        assert.equal(stagedLink[DYNAMIC_OBJECT].hasValue('seq'), true, 'reading an unmanaged link must retain its target fields');
        assert.equal(parent[DYNAMIC_OBJECT].hasValue('seq'), true, 'reading an unmanaged link must not consume the original target');
        assert.equal(stagedLink.seq, (1n << 53n) + 1n);
        assert.equal(parent.seq, (1n << 53n) + 1n);
        await db.add(parent);
        await db.add(child);
        const found = own(await db.find(Row, child.id));
        assert.equal(found[DYNAMIC_OBJECT].hasValue('parent'), true);
        const linked = own(found.parent);
        assert.equal(linked.id, parent.id);
        assert.equal(linked.seq, (1n << 53n) + 1n);
        found.parent = null;
        assert.equal(found.parent, null);
        const reloaded = own(await db.find(Row, child.id));
        assert.equal(reloaded[DYNAMIC_OBJECT].hasValue('parent'), false);
        assert.equal(reloaded.parent, null);
        assert.equal(Number(native.debugQueryCount("SELECT id FROM ExplicitRuntime WHERE name='parent'")), 1);
        // A managed cycle must never enter the legacy plain-object graph
        // materializer. Only the guard is instrumented; the identity query,
        // managed hydration and all scalar/link values use actual Core/Wasm.
        parent.parent = child;
        child.parent = parent;
        const identities = native.objectIdentities('ExplicitRuntime', null, 'name ASC', null, null, null, null);
        assert.equal(identities.length, 2);
        for (const identity of identities) {
            assert.deepEqual(Object.keys(identity).sort(), ['globalId', 'id']);
            assert.equal(typeof identity.id, 'bigint');
            assert.equal(typeof identity.globalId, 'string');
        }
        const legacyObjects = native.objects;
        native.objects = () => { throw new Error('Explicit query invoked recursive plain-object materialization'); };
        setWasmModule(null);
        try {
            assert.throws(() => make(), /WASM not loaded/);
            const rows = (await db.objectsArray(Row, { orderBy: 'name ASC' })).map(own);
            assert.deepEqual(rows.map((row: any) => row.name), ['child', 'parent']);
            assert.equal(rows[1].seq, (1n << 53n) + 1n);
            assert.equal(own(rows[0].parent).id, parent.id);
            assert.equal(own(rows[1].parent).id, child.id);
            const results = db.objects(Row).sorted('name ASC');
            assert.equal(own(await results.at(0)).name, 'child');
            const snapshot = (await results.snapshot()).map(own);
            assert.equal(snapshot[1].seq, (1n << 53n) + 1n);
            let seen = 0;
            for await (const item of results) {
                const row = own(item);
                assert.equal(row.at, 0);
                assert.equal(own(row.parent).name, row.name === 'child' ? 'parent' : 'child');
                ++seen;
            }
            assert.equal(seen, 2);
        } finally { native.objects = legacyObjects; }
        return { unmanagedAndManagedPresence: true, bigintThroughLink: true, clearedLinkPersists: true, managedCycleQuery: true, identityOnlyArrayAtSnapshotIterator: true, recursiveMaterializerRefused: true };
    }));

    await runExplicitUnionCases({ module, test, newPath, register, dispose });
    await runExplicitNoHistoryCases({ module, test, newPath, register, dispose });
}
