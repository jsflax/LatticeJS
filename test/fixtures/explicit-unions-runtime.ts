// Actual Core/Wasm union tests. SQL below observes storage only; all mutations
// use the public TypeScript accessors or the raw bridge under qualification.
import assert from 'node:assert/strict';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas } from '../../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';

const cases = [
    { name: 'noop', values: [] },
    { name: 'claim', values: [{ paramName: 'owner', type: 'string' }, { paramName: 'ttlMs', type: 'int' }] },
    { name: 'message', values: [{ paramName: '', type: 'string' }] },
    { name: 'counter', values: [{ paramName: '', type: 'int' }] },
] as const;
const definition = { formatVersion: 1, models: [{ tableName: 'ExplicitUnion', properties: [
    { name: 'name', kind: 'primitive', type: 'string', nullable: false },
    { name: 'action', kind: 'union', type: 'string', nullable: true, logicalNullable: false, targetTable: '_ExplicitUnionValue', unionCases: cases },
    { name: 'optional', kind: 'union', type: 'string', nullable: true, logicalNullable: true, targetTable: '_ExplicitUnionValue', unionCases: cases },
] }] } as const;
const noop = () => ({ case: 'noop', fields: {} });
const claim = (ttlMs: bigint) => ({ case: 'claim', fields: { owner: '雪 🧭\n\"quoted\"', ttlMs } });

export async function runExplicitUnionCases({ module, test, newPath, register, dispose }: any) {
    async function fixture(body: (state: any) => Promise<any>) {
        assert.equal(module.explicitUnionVersion?.(), 1, 'Actual union runtime capability is required');
        const { ExplicitUnion: Row } = defineModels(definition);
        const path = newPath('explicit-union');
        const wrappers = new Set<any>();
        let native: any;
        const open = () => {
            native = new module.Lattice(path, buildSchemas([Row]));
            register(native);
            return Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice;
        };
        const clearWrappers = () => { for (const wrapper of wrappers) wrapper.delete(); wrappers.clear(); };
        const own = <T>(row: T): T => { if (row) wrappers.add((row as any)[DYNAMIC_OBJECT]); return row; };
        const make = (overrides: any = {}) => own(new Row({ name: 'one', action: noop(), optional: null, ...overrides }));
        setWasmModule(module);
        try {
            const db = open();
            return await body({ Row, db, make, own, getNative: () => native, reopen: () => {
                clearWrappers(); dispose(native); native = undefined;
                return open();
            } });
        } finally {
            setWasmModule(null);
            clearWrappers();
            if (native) dispose(native);
        }
    }

    await test('explicit unions preserve exact cases and Int64 values through actual managed hydration', () => fixture(async ({ Row, db, make, own, getNative }) => {
        const values = [noop(), claim(-(1n << 63n)), claim((1n << 53n) + 1n), claim((1n << 63n) - 1n),
            { case: 'message', fields: { _0: '{"wide":9007199254740993}' } },
            { case: 'counter', fields: { _0: 0n } }];
        for (let index = 0; index < values.length; ++index) {
            const row = make({ name: `value-${index}`, action: values[index] });
            assert.deepEqual(row.action, values[index], 'unmanaged read retains the exact associated values');
            assert.deepEqual(row.action, values[index], 'repeated reads do not consume staged values');
            await db.add(row);
        }
        setWasmModule(null);
        assert.throws(() => make(), /WASM not loaded/);
        const rows = (await db.objectsArray(Row, { orderBy: 'name ASC' })).map(own);
        assert.equal(rows.length, values.length);
        for (let index = 0; index < rows.length; ++index) {
            assert.deepEqual(rows[index].action, values[index]);
            assert.equal(rows[index].optional, null);
        }
        rows[0].action = { case: 'counter', fields: { _0: (1n << 53n) + 3n } };
        assert.equal(own(await db.find(Row, rows[0].id)).action.fields._0, (1n << 53n) + 3n);
        assert.equal(Number(getNative().debugQueryCount('SELECT id FROM _ExplicitUnionValue WHERE counter=9007199254740995')), 1);
        assert.throws(() => { rows[0].action = null; }, /non-null union/);
        assert.equal(own(await db.find(Row, rows[0].id)).action.fields._0, (1n << 53n) + 3n);
        return { unmanagedAndManaged: true, caseOrderPreserved: true, bareAndNamedAndUnnamed: true, exactInt64Boundaries: true, opaqueJSONTextPreserved: true, constructorFreeHydration: true };
    }));

    await test('explicit union switches clear inactive columns and optional values persist across reopen', () => fixture(async ({ Row, db, make, own, getNative, reopen }) => {
        const row = make({ action: claim(9007199254740993n), optional: { case: 'message', fields: { _0: 'temporary' } } });
        await db.add(row);
        const id = row.id;
        const native = getNative();
        assert.equal(Number(native.debugQueryCount('SELECT id FROM _ExplicitUnionValue')), 2);
        row.action = { case: 'message', fields: { _0: 'retained' } };
        assert.equal(Number(native.debugQueryCount("SELECT id FROM _ExplicitUnionValue WHERE message='retained' AND claim__owner IS NULL AND claim__ttlMs IS NULL AND counter IS NULL")), 1);
        row.optional = null;
        assert.equal(row.optional, null);
        assert.equal(Number(native.debugQueryCount('SELECT id FROM _ExplicitUnionValue')), 1, 'Core clear removes the old side-table row');
        row.optional = { case: 'counter', fields: { _0: -(1n << 63n) } };
        row.optional = noop();
        assert.equal(Number(native.debugQueryCount('SELECT id FROM _ExplicitUnionValue WHERE "case"=\'noop\' AND counter IS NULL AND message IS NULL')), 1);
        row.optional = null;
        const reopened = reopen();
        const found = own(await reopened.find(Row, id));
        assert.deepEqual(found.action, { case: 'message', fields: { _0: 'retained' } });
        assert.equal(found.optional, null);
        assert.equal(Number(getNative().debugQueryCount('SELECT id FROM _ExplicitUnionValue')), 1);
        return { actualSameFileReopen: true, inactiveColumnsNull: true, coreOwnedClearRemovesSideRow: true, logicalNullabilityPreserved: true };
    }));

    await test('raw union bridge rejects malformed values and detects unreadable references without corrupting prior data', () => fixture(async ({ db, make }) => {
        const row = make({ action: claim(9n) });
        await db.add(row);
        const raw = row[DYNAMIC_OBJECT];
        const getter = () => { throw new Error('Input accessor must not execute'); };
        const accessor = { fields: {} } as any;
        Object.defineProperty(accessor, 'case', { get: getter, enumerable: true });
        for (const value of [
            { case: 'missing', fields: {} }, { case: 'noop', fields: { extra: '' } },
            { case: 'claim', fields: { owner: '', ttlMs: 9 } },
            { case: 'claim', fields: { owner: '', ttlMs: 1n << 63n } },
            { case: 'claim', fields: { owner: '' } }, accessor,
        ]) {
            assert.throws(() => raw.setUnion('action', value), error => error instanceof Error && !/Input accessor must not execute/.test(error.message));
            assert.deepEqual(row.action, claim(9n));
        }
        assert.throws(() => raw.getUnion('name'), error => error instanceof Error);
        const reference = raw.getString('optional');
        raw.setString('optional', 'missing-synthetic-union-row');
        assert.throws(() => row.optional, /no readable value/);
        raw.setString('optional', reference);
        assert.equal(row.optional, null);
        // The native layer deliberately does not invent logical nullability.
        // A corrupt required field is refused when it crosses the TS boundary.
        raw.setUnion('action', null);
        assert.throws(() => row.action, /non-null union/);
        row.action = noop();
        assert.deepEqual(row.action, noop());
        return { rawFailuresAreJSErrors: true, invalidWritesPreservePriorValue: true, inputAccessorsNotInvoked: true, danglingReferenceRefused: true, requiredNullReadRefused: true };
    }));
}
