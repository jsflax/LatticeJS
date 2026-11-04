// Actual Core/Wasm union tests. Model changes use public accessors or the raw
// bridge; the repair cases also install fixed synthetic old trigger templates.
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

    // These synthetic stores exercise Wasm reopen/repair, not the private Swift
    // fingerprint-v1 admission (covered by the qualified Core owner tests).
    async function repairFixture(body: (state: any) => Promise<any>) {
        const { ExplicitUnion: Row } = defineModels({ ...definition, models: [{
            ...definition.models[0], properties: [...definition.models[0].properties,
                { name: 'exact', kind: 'primitive', type: 'float', nullable: true },
            ],
        }] });
        const natives = new Set<any>(), wrappers = new Set<any>();
        const own = <T>(row: T): T => { if (row) wrappers.add((row as any)[DYNAMIC_OBJECT]); return row; };
        const clear = () => { for (const wrapper of wrappers) wrapper.delete(); wrappers.clear(); };
        const open = (path = newPath('union-repair')) => {
            const native = new module.Lattice(path, buildSchemas([Row]));
            register(native); natives.add(native);
            return { path, native, db: Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice };
        };
        const reopen = (store: any) => {
            clear(); dispose(store.native); natives.delete(store.native);
            return open(store.path);
        };
        const sql = (store: any, statement: string, rows = 0) => assert.equal(
            store.native.debugQueryCount(statement), rows, `Fixture SQL refused: ${statement}`);
        const events = (store: any) => JSON.parse(store.native.eventsAfter(''));
        const receive = (store: any, entries: any[]) => JSON.parse(store.native.receive(JSON.stringify({ kind: 'auditLog', auditLog: entries })));
        const read = async (store: any, id: number) => own(await store.db.find(Row, id));
        setWasmModule(module);
        try { return await body({ Row, open, reopen, own, sql, events, receive, read }); }
        finally { setWasmModule(null); clear(); for (const native of natives) dispose(native); }
    }

    for (const mode of ['legacy-real', 'incomplete-reference'] as const) {
        await test(`union parent ${mode} triggers repair on Wasm reopen without losing rows or replay`, () => repairFixture(async ({ Row, open, reopen, own, sql, events, receive, read }) => {
            let source = open();
            const precise = 1788921763.083822;
            let row = own(new Row({ name: 'kept', action: noop(), optional: null, exact: precise }));
            await source.db.add(row);
            const id = row.id, globalID = row.globalId;
            const before = events(source);
            // Exact old template semantics for this fixed model: legacy passes
            // REAL directly; the faulty refresh omits both union references.
            const columns = mode === 'legacy-real' ? ['name', 'exact', 'action', 'optional'] : ['name', 'exact'];
            const value = (prefix: string, column: string) => column === 'exact' && mode !== 'legacy-real'
                ? `CASE WHEN ${prefix}.exact IS NULL THEN NULL ELSE json(printf('%!.17g', ${prefix}.exact)) END`
                : `${prefix}.${column}`;
            source.native.beginWrite();
            try {
                for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
                    const trigger = operation === 'UPDATE' ? 'AuditLog_Update_ExplicitUnion' : `AuditExplicitUnion${operation === 'INSERT' ? 'Insert' : 'Delete'}`;
                    const prefix = operation === 'INSERT' ? 'NEW' : 'OLD';
                    const fields = columns.map(column => `'${column}', ${operation === 'UPDATE'
                        ? `CASE WHEN OLD.${column} IS NOT NEW.${column} THEN ${value('NEW', column)} ELSE NULL END`
                        : value(prefix, column)}`).join(',');
                    const names = columns.map(column => operation === 'UPDATE'
                        ? `CASE WHEN OLD.${column} IS NOT NEW.${column} THEN '${column}' ELSE NULL END`
                        : `'${column}'`).join(',');
                    const condition = operation === 'UPDATE'
                        ? `(sync_disabled() = 0) AND (${columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')})`
                        : 'sync_disabled() = 0';
                    sql(source, `DROP TRIGGER ${trigger}`);
                    sql(source, `CREATE TRIGGER ${trigger} AFTER ${operation} ON ExplicitUnion WHEN (${condition}) BEGIN
                        INSERT INTO AuditLog(tableName,operation,rowId,globalRowId,changedFields,changedFieldsNames,timestamp)
                        VALUES('ExplicitUnion','${operation}',${prefix}.id,${prefix}.globalId,json_object(${fields}),json_array(${names}),unixepoch('subsec')); END`);
                }
            } finally { source.native.commitWrite(); }
            sql(source, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ExplicitUnion' AND name LIKE 'Audit%'", 3);
            sql(source, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ExplicitUnion' AND name LIKE 'Audit%' AND instr(sql, char(39)||'action'||char(39))>0", mode === 'legacy-real' ? 3 : 0);
            sql(source, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ExplicitUnion' AND name LIKE 'Audit%' AND instr(sql, 'json(printf(')>0", mode === 'legacy-real' ? 0 : 3);
            source = reopen(source);
            row = await read(source, id);
            assert.equal(row.globalId, globalID); assert.equal(row.exact, precise);
            assert.deepEqual(row.action, noop()); assert.equal(row.optional, null);
            assert.deepEqual(events(source), before, 'Repair must preserve prior audit identities and values');
            sql(source, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='ExplicitUnion' AND name LIKE 'Audit%' AND instr(sql, char(39)||'action'||char(39))>0 AND instr(sql, char(39)||'optional'||char(39))>0 AND instr(sql, 'json(printf(')>0", 3);
            source.native.beginWrite();
            try { sql(source, "CREATE TABLE _JsExpectedRepairTriggers AS SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='ExplicitUnion' AND name LIKE 'Audit%'"); }
            finally { source.native.commitWrite(); }
            source = reopen(source); row = await read(source, id);
            sql(source, "SELECT e.name FROM _JsExpectedRepairTriggers e LEFT JOIN sqlite_master m ON m.name=e.name WHERE m.sql IS NULL OR m.sql<>e.sql", 0);
            assert.deepEqual(events(source), before, 'Healthy reopen must not alter retained history');
            const peer = open();
            assert.deepEqual(receive(peer, before), before.map((entry: any) => entry.globalId));
            row.optional = { case: 'message', fields: { _0: 'replacement payload' } };
            const first = events(source);
            const referenceUpdate = first.filter((entry: any) => entry.tableName === 'ExplicitUnion' && entry.operation === 'UPDATE').at(-1);
            assert.ok(referenceUpdate.changedFieldsNames.includes('optional'));
            assert.equal(referenceUpdate.changedFields.optional.value, row[DYNAMIC_OBJECT].getString('optional'));
            assert.deepEqual(receive(peer, first), first.map((entry: any) => entry.globalId));
            let peerRow = await read(peer, id);
            assert.equal(peerRow.globalId, globalID); assert.deepEqual(peerRow.optional, row.optional);
            assert.equal(peerRow[DYNAMIC_OBJECT].getString('optional'), row[DYNAMIC_OBJECT].getString('optional'));
            row.optional = null;
            const cleared = events(source);
            assert.deepEqual(receive(peer, cleared), cleared.map((entry: any) => entry.globalId));
            assert.equal((await read(peer, id)).optional, null);
            row.exact = precise + 0.000001;
            const changedReal = events(source).filter((entry: any) => entry.tableName === 'ExplicitUnion' && entry.operation === 'UPDATE').at(-1);
            assert.equal(changedReal.changedFields.exact.value, row.exact, 'REAL audit must retain the exact stored JS number');
            row.exact = null;
            const clearedReal = events(source).filter((entry: any) => entry.tableName === 'ExplicitUnion' && entry.operation === 'UPDATE').at(-1);
            assert.equal(clearedReal.changedFields.exact.value, null);
            const extra = own(new Row({ name: 'insert-delete', action: noop(), optional: { case: 'message', fields: { _0: 'owned' } }, exact: precise }));
            await source.db.add(extra);
            const ownedReference = extra[DYNAMIC_OBJECT].getString('optional');
            const added = events(source);
            const inserted = added.filter((entry: any) => entry.tableName === 'ExplicitUnion' && entry.globalRowId === extra.globalId && entry.operation === 'INSERT');
            // addObject inserts the parent first, then persists each staged union and updates its reference.
            assert.equal(inserted.length, 1);
            assert.ok(Object.prototype.hasOwnProperty.call(inserted[0].changedFields, 'optional'));
            assert.ok(inserted[0].changedFieldsNames.includes('optional'));
            assert.equal(inserted[0].changedFields.optional.value, null);
            assert.equal(inserted[0].changedFields.exact.value, precise);
            const referenceInserted = added.filter((entry: any) => entry.tableName === 'ExplicitUnion' && entry.globalRowId === extra.globalId && entry.operation === 'UPDATE' && entry.changedFieldsNames.includes('optional'));
            assert.equal(referenceInserted.length, 1);
            assert.equal(referenceInserted[0].changedFields.optional.value, ownedReference);
            const ownedUnionInserted = added.filter((entry: any) => entry.tableName === '_ExplicitUnionValue' && entry.globalRowId === ownedReference && entry.operation === 'INSERT');
            assert.equal(ownedUnionInserted.length, 1);
            assert.ok(added.indexOf(inserted[0]) < added.indexOf(ownedUnionInserted[0]));
            assert.ok(added.indexOf(ownedUnionInserted[0]) < added.indexOf(referenceInserted[0]));
            assert.deepEqual(receive(peer, added), added.map((entry: any) => entry.globalId));
            const addedPeer = await read(peer, extra.id);
            assert.equal(addedPeer.globalId, extra.globalId);
            assert.deepEqual(addedPeer.optional, extra.optional);
            assert.equal(addedPeer[DYNAMIC_OBJECT].getString('optional'), ownedReference);
            const extraID = extra.id, extraGlobalID = extra.globalId;
            assert.equal(await source.db.remove(Row, extraID), true);
            const deleted = events(source).filter((entry: any) => entry.tableName === 'ExplicitUnion' && entry.globalRowId === extraGlobalID && entry.operation === 'DELETE');
            assert.equal(deleted.length, 1); assert.equal(deleted[0].changedFields.optional.value, ownedReference);
            assert.equal(deleted[0].changedFields.exact.value, precise);
            sql(source, `SELECT id FROM _ExplicitUnionValue WHERE globalId='${ownedReference}'`, 0);
            assert.deepEqual(receive(peer, events(source)), events(source).map((entry: any) => entry.globalId));
            assert.equal((await read(peer, id)).exact, null);
            assert.equal(await peer.db.find(Row, extraID), null);
            return { mode, realUnionDescriptors: true, actualReopen: true, stableRepairedTriggers: true, parentReferenceAuditAndReplay: true, optionalClear: true, exactRealAndNull: true, ownedCascade: true };
        }));
    }

    await test('union replay accepts canonical and legacy case spelling and refuses ambiguity before dedupe', () => repairFixture(async ({ Row, open, own, events, sql, receive }) => {
        const source = open();
        const row = own(new Row({ name: 'wire', action: { case: 'message', fields: { _0: 'kept payload' } }, optional: null, exact: 0 }));
        await source.db.add(row);
        const seed = events(source).find((entry: any) => entry.tableName === '_ExplicitUnionValue' && entry.operation === 'INSERT');
        assert.ok(seed);
        for (const legacy of [false, true]) {
            const peer = open(), spelling = legacy ? '"case"' : 'case';
            const canonical = seed.changedFields.case ?? seed.changedFields['"case"'];
            assert.ok(canonical);
            const entry = { ...seed, changedFields: { ...seed.changedFields }, changedFieldsNames: seed.changedFieldsNames.map((name: string) => name === 'case' || name === '"case"' ? spelling : name) };
            delete entry.changedFields.case; delete entry.changedFields['"case"']; entry.changedFields[spelling] = canonical;
            assert.deepEqual(peer.native.importPendingFrame(JSON.stringify([entry])), { imported: [entry.globalId], alreadyPresent: [], rejected: [] });
            sql(peer, "SELECT id FROM _ExplicitUnionValue WHERE \"case\"='message' AND message='kept payload'", 1);
            const retained = events(peer).find((value: any) => value.globalId === entry.globalId);
            assert.deepEqual(retained.changedFieldsNames, entry.changedFieldsNames);
            assert.deepEqual(retained.changedFields, entry.changedFields, 'Pending import preserves wire spelling and values');
            assert.deepEqual(peer.native.importPendingFrame(JSON.stringify([entry])), { imported: [], alreadyPresent: [entry.globalId], rejected: [] });
            assert.deepEqual(receive(peer, [entry]), [entry.globalId]);
            const audits = events(peer);
            const receipts = peer.native.debugQueryCount('SELECT * FROM _lattice_applied_receipts');
            assert.ok(receipts >= 0);
            const freshIDs = ['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000103'];
            const freshRows = ['00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000203'];
            for (const [index, variant] of ['names', 'values', 'both'].entries()) {
                for (const retainedIdentity of [false, true]) {
                    const opposite = legacy ? 'case' : '"case"';
                    const ambiguous = { ...entry, globalId: retainedIdentity ? entry.globalId : freshIDs[index],
                        globalRowId: retainedIdentity ? entry.globalRowId : freshRows[index],
                        changedFields: { ...entry.changedFields }, changedFieldsNames: [...entry.changedFieldsNames] };
                    if (variant !== 'values') ambiguous.changedFieldsNames.push(opposite);
                    if (variant !== 'names') ambiguous.changedFields[opposite] = canonical;
                    assert.deepEqual(receive(peer, [ambiguous]), [], 'Ambiguous values or names must refuse before known-ID ACK');
                    assert.deepEqual(peer.native.importPendingFrame(JSON.stringify([ambiguous])), { imported: [], alreadyPresent: [], rejected: [ambiguous.globalId] });
                    assert.deepEqual(events(peer), audits);
                    sql(peer, 'SELECT * FROM _lattice_applied_receipts', receipts);
                    sql(peer, "SELECT id FROM _ExplicitUnionValue WHERE \"case\"='message' AND message='kept payload'", 1);
                }
            }
        }
        return { canonicalAndLegacyWirePreserved: true, pendingAndReceive: true, ambiguousNamesAndValuesRefusedBeforeDedupe: true, historyAndReceiptsUnchanged: true };
    }));
}
