// Real Core SQLite/wire checks for the explicit NoHistory primitive capability.
// SQL only inspects history; mutations use model APIs or Core-backed receive.
import assert from 'node:assert/strict';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas } from '../../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';

const definition = { formatVersion: 1, models: [{ tableName: 'ExplicitNoHistory', properties: [
    { name: 'label', kind: 'primitive', type: 'string', nullable: false, noHistory: false },
    { name: 'cache', kind: 'primitive', type: 'string', nullable: true, noHistory: true },
    { name: 'required', kind: 'primitive', type: 'string', nullable: false, noHistory: true },
] }] } as const;

export async function runExplicitNoHistoryCases({ module, test, newPath, register, dispose }: any) {
    async function fixture(body: (state: any) => Promise<any>) {
        assert.equal(module.explicitNoHistoryVersion?.(), 1);
        const { ExplicitNoHistory: Row } = defineModels(definition);
        const natives: any[] = [], wrappers = new Set<any>();
        const own = <T>(row: T): T => { if (row) wrappers.add((row as any)[DYNAMIC_OBJECT]); return row; };
        const open = () => {
            const native = new module.Lattice(newPath('explicit-nohistory'), buildSchemas([Row]));
            register(native); natives.push(native);
            return { native, db: Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice };
        };
        // Send the actual envelope directly so malformed-marker tests exercise
        // receive's decoder, not createSyncMessage's earlier filter.
        const receive = (native: any, entries: any[]) => JSON.parse(native.receive(JSON.stringify({ kind: 'auditLog', auditLog: entries })));
        const read = async (db: Lattice) => own((await db.objectsArray(Row))[0]);
        setWasmModule(module);
        try {
            const source = open(), peer = open();
            const row = own(new Row({ label: 'initial', cache: 'initial-cache', required: 'required-value' }));
            await source.db.add(row);
            const seed = JSON.parse(source.native.eventsAfter('')).filter((entry: any) => entry.tableName === 'ExplicitNoHistory');
            assert.equal(seed.length, 1);
            assert.deepEqual(receive(peer.native, seed), seed.map((entry: any) => entry.globalId));
            return await body({ Row, source, peer, row, seed: seed[0], open, own, read, receive });
        } finally {
            setWasmModule(null);
            for (const wrapper of wrappers) wrapper.delete();
            for (const native of natives) dispose(native);
        }
    }

    await test('NoHistory stores valueless updates and late-binds marked nullable clears through Core receive', () => fixture(async ({ source, peer, row, seed, read, receive }) => {
        assert.equal((await read(peer.db)).cache, 'initial-cache');
        row.cache = 'fresh-cache';
        assert.equal(Number(source.native.debugQueryCount("SELECT id FROM AuditLog WHERE tableName='ExplicitNoHistory' AND operation='UPDATE' AND json_type(changedFields,'$.cache')='null'")), 1);
        assert.equal(Number(source.native.debugQueryCount("SELECT id FROM AuditLog WHERE operation='UPDATE' AND changedFields LIKE '%fresh-cache%'")), 0);
        const changed = JSON.parse(source.native.eventsAfter(seed.globalId));
        assert.equal(changed.length, 1);
        assert.equal(changed[0].changedFields.cache.value, 'fresh-cache');
        assert.equal(changed[0].noHistoryNulls, undefined);
        assert.deepEqual(receive(peer.native, changed), [changed[0].globalId]);
        assert.equal((await read(peer.db)).cache, 'fresh-cache');
        row.cache = null;
        const cleared = JSON.parse(source.native.eventsAfter(changed[0].globalId));
        assert.equal(cleared.length, 1);
        assert.deepEqual(cleared[0].changedFields.cache, { kind: 4, value: null });
        assert.deepEqual(cleared[0].noHistoryNulls, ['cache']);
        const pending = JSON.parse(source.native.getUnshippedAuditLog()).find((entry: any) => entry.globalId === cleared[0].globalId);
        assert.deepEqual(pending.noHistoryNulls, ['cache']);
        assert.deepEqual(pending.changedFields.cache, { kind: 4, value: null });
        assert.deepEqual(receive(peer.native, [pending]), [pending.globalId]);
        assert.equal((await read(peer.db)).cache, null);
        assert.equal((await read(peer.db)).required, 'required-value');
        assert.deepEqual(receive(peer.native, cleared), [pending.globalId], 'Retry must acknowledge the committed clear');
        return { rawHistoryContainsPlaceholder: true, nonnullPositiveControl: true, exportAndUnshippedMarkersAgree: true, coreReceiveClearsNullable: true, duplicateClearAcknowledged: true };
    }));

    await test('Core receive preserves legacy NoHistory placeholders and refuses clears of required columns', () => fixture(async ({ peer, seed, read, receive }) => {
        const nullValue = { kind: 4, value: null };
        const legacy = { ...seed, globalId: `${seed.globalId}-legacy`, operation: 'UPDATE',
            changedFieldsNames: ['label', 'required', 'cache'],
            changedFields: { label: { ...seed.changedFields.label, value: 'legacy-applied' }, required: nullValue, cache: nullValue } };
        assert.deepEqual(receive(peer.native, [legacy]), [legacy.globalId]);
        const afterLegacy = await read(peer.db);
        assert.equal(afterLegacy.label, 'legacy-applied');
        assert.equal(afterLegacy.required, 'required-value');
        assert.equal(afterLegacy.cache, 'initial-cache');
        const markedRequired = { ...legacy, globalId: `${seed.globalId}-marked-required`, noHistoryNulls: ['required'],
            changedFieldsNames: ['label', 'required'],
            changedFields: { label: { ...seed.changedFields.label, value: 'guarded-applied' }, required: nullValue } };
        assert.deepEqual(receive(peer.native, [markedRequired]), [markedRequired.globalId]);
        const guarded = await read(peer.db);
        assert.equal(guarded.label, 'guarded-applied');
        assert.equal(guarded.required, 'required-value');
        assert.equal(guarded.cache, 'initial-cache');
        const invalid = { ...markedRequired, globalId: `${seed.globalId}-bad-marker`,
            changedFields: { ...markedRequired.changedFields, required: { kind: 4 } } };
        assert.deepEqual(receive(peer.native, [invalid]), []);
        assert.equal((await read(peer.db)).required, 'required-value');
        return { legacyNullableAndRequiredNullsIgnored: true, unrelatedFieldApplied: true, markedRequiredNullIgnored: true, malformedMarkedNullUnacknowledged: true };
    }));
}
