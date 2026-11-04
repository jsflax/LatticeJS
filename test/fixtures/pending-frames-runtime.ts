// Real Wasm/Core pending-import qualification. Frame payloads stay opaque;
// only string identities/reports are inspected by JS.
import assert from 'node:assert/strict';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas } from '../../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';
import { drainPendingAuditFrames, readPendingAuditFrames } from '../../src/pending-drain';

const table = 'OpaquePending';
const definition = { formatVersion: 1, models: [{ tableName: table, properties: [
    { name: 'label', kind: 'primitive', type: 'string', nullable: false },
    { name: 'seq', kind: 'primitive', type: 'int', representation: 'bigint', nullable: false },
    { name: 'cache', kind: 'primitive', type: 'string', nullable: true, noHistory: true },
    { name: 'required', kind: 'primitive', type: 'string', nullable: false, noHistory: true },
] }] } as const;

export async function runPendingFrameCases({ module, test, newPath, register, dispose }: any) {
    async function fixture(body: (state: any) => Promise<any>) {
        const { OpaquePending: Row } = defineModels(definition), natives: any[] = [], wrappers = new Set<any>();
        const own = (row: any) => { if (row) wrappers.add(row[DYNAMIC_OBJECT]); return row; };
        const open = () => {
            const native = new module.Lattice(newPath('opaque-pending'), buildSchemas([Row]));
            register(native); natives.push(native);
            return { native, db: Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice };
        };
        const rows = async (store: any) => (await store.db.objectsArray(Row, { orderBy: 'label ASC' })).map(own);
        const add = async (store: any, label: string, seq = 7n) => {
            const row = own(new Row({ label, seq, cache: 'initial-cache', required: 'required-value' }));
            await store.db.add(row); return row;
        };
        setWasmModule(module);
        try { return await body({ open, rows, add, own }); }
        finally { setWasmModule(null); for (const wrapper of wrappers) wrapper.delete(); for (const native of natives) dispose(native); }
    }

    await test('opaque pending rescue preserves Int64 extrema through two rescues and Core server receive', () => fixture(async ({ open, rows, add }) => {
        const source = open(), first = open(), second = open(), server = open();
        const values = [-(1n << 63n), (1n << 63n) - 1n, (1n << 53n) + 1n, (1n << 53n) + 3n];
        for (let i = 0; i < values.length; ++i) await add(source, `item-${i}`, values[i]);
        const frames = readPendingAuditFrames(source.native, {}, 2);
        assert.equal(frames.length, 2);
        const sourceBytes = frames.map(frame => frame.json);
        for (const value of values) assert.ok(sourceBytes.some(json => json.includes(value.toString())), 'Native JSON omitted exact Int64 token');
        const report1 = await drainPendingAuditFrames(first.native, frames);
        assert.equal(report1.applied.length, 4); assert.deepEqual(report1.failed, []);
        assert.deepEqual((await rows(first)).map((row: any) => row.seq), values);
        const secondFrames = readPendingAuditFrames(first.native, {}, 2);
        assert.equal(readPendingAuditFrames(first.native, { localOnly: true }).length, 0, 'Rescued rows are relayed; default must retain them');
        const report2 = await drainPendingAuditFrames(second.native, secondFrames);
        assert.equal(report2.applied.length, 4); assert.deepEqual(report2.failed, []);
        assert.deepEqual((await rows(second)).map((row: any) => row.seq), values);
        for (const frame of readPendingAuditFrames(second.native)) {
            const accepted = JSON.parse(server.native.receive(module.createSyncMessage(frame.json)));
            assert.deepEqual(accepted, frame.entries.map(entry => entry.globalId));
            second.native.markEntriesSynced(JSON.stringify(accepted));
        }
        assert.deepEqual((await rows(server)).map((row: any) => row.seq), values);
        assert.equal(readPendingAuditFrames(second.native).length, 0);
        assert.deepEqual(readPendingAuditFrames(source.native, {}, 2).map(frame => frame.json), sourceBytes, 'Rescue must not mark or alter the abandoned source');
        assert.equal(Number(first.native.debugQueryCount('SELECT audit_entry_id FROM _lattice_sync_state')), 0);
        return { exactInt64: values.map(String), twoRescues: true, serverReceive: true, localOnlyExplicit: true, noReceivingMark: true, sourceUnchanged: true };
    }));

    await test('pending import late-binds NoHistory clears and retains legacy and required-null guards', () => fixture(async ({ open, rows, add }) => {
        const source = open(), target = open();
        const row = await add(source, 'seed');
        const seed = readPendingAuditFrames(source.native)[0];
        assert.equal((await drainPendingAuditFrames(target.native, [seed])).applied.length, 1);
        source.native.markEntriesSynced(JSON.stringify(seed.entries.map(entry => entry.globalId)));
        const observed: string[] = [];
        const sourceObserver = source.native.observeAuditLog((json: string) => observed.push(json));
        row.cache = 'intermediate'; row.cache = null;
        for (let i = 0; i < 8; ++i) await new Promise(resolve => setTimeout(resolve, 0));
        source.native.removeAuditLogObserver(sourceObserver);
        assert.ok(observed.some(json => json.includes('"noHistoryNulls":["cache"]')), 'Observer must use Core NoHistory late binder');
        const updates = readPendingAuditFrames(source.native);
        assert.ok(updates[0].json.includes('"noHistoryNulls":["cache"]'));
        assert.equal((await drainPendingAuditFrames(target.native, updates)).applied.length, 2);
        assert.equal((await rows(target))[0].cache, null);
        const current = (await rows(target))[0]; current.cache = 'keep-cache';
        // Authored legacy fixture uses only exact safe values; it is not a
        // parse/rewrite of the native Int64 frame.
        const legacy = { id: 1, globalId: 'pending-legacy-null', tableName: table, operation: 'UPDATE', rowId: 1,
            globalRowId: current.globalId, changedFields: { cache: { kind: 4, value: null }, required: { kind: 4, value: null }, label: { kind: 2, value: 'legacy' } },
            changedFieldsNames: ['cache', 'required', 'label'], timestamp: '2026-10-24T00:00:00Z', isFromRemote: true, isSynchronized: false };
        assert.deepEqual(target.native.importPendingFrame(JSON.stringify([legacy])), { imported: [legacy.globalId], alreadyPresent: [], rejected: [] });
        assert.equal((await rows(target))[0].cache, 'keep-cache'); assert.equal((await rows(target))[0].required, 'required-value');
        const required = { ...legacy, globalId: 'pending-marked-required', noHistoryNulls: ['required'] };
        assert.deepEqual(target.native.importPendingFrame(JSON.stringify([required])).imported, [required.globalId]);
        assert.equal((await rows(target))[0].required, 'required-value');
        assert.equal(Number(target.native.debugQueryCount("SELECT id FROM AuditLog WHERE globalId='pending-marked-required' AND isSynchronized=0")), 1, 'Value-identical new identity must remain upload eligible');
        const synthetic = { ...legacy, globalId: 'pending-synthesized-observer', globalRowId: 'synthetic-row', operation: 'INSERT', synthesized: true,
            changedFields: { label: { kind: 2, value: 'synthetic' }, seq: { kind: 0, value: 9 }, cache: { kind: 4, value: null }, required: { kind: 2, value: 'required-value' } },
            changedFieldsNames: ['label', 'seq', 'cache', 'required'] };
        const targetObserved: string[] = [];
        const observer = target.native.observeAuditLog((json: string) => targetObserved.push(json));
        assert.deepEqual(target.native.importPendingFrame(JSON.stringify([synthetic])).imported, [synthetic.globalId]);
        for (let i = 0; i < 8; ++i) await new Promise(resolve => setTimeout(resolve, 0));
        target.native.removeAuditLogObserver(observer);
        assert.ok(targetObserved.some(json => json.includes(synthetic.globalId) && json.includes('"synthesized":true') && json.includes('"noHistoryNulls":["cache"]')), 'Observer must retain synthesized and live nullable marker');
        return { lateBoundNullableClear: true, observerLateBoundNull: true, observerSynthesized: true, legacyNullablePreserved: true, requiredNullGuard: true, valueIdenticalNewIDJournalled: true };
    }));

    await test('pending import deduplicates known IDs and refuses malformed or unknown schema entries', () => fixture(async ({ open, rows, add }) => {
        const source = open(), target = open();
        await add(source, 'old');
        const frame = readPendingAuditFrames(source.native)[0], ids = frame.entries.map(entry => entry.globalId);
        assert.deepEqual(target.native.importPendingFrame(frame.json), { imported: ids, alreadyPresent: [], rejected: [] });
        (await rows(target))[0].label = 'newer-local';
        assert.deepEqual(target.native.importPendingFrame(frame.json), { imported: [], alreadyPresent: ids, rejected: [] });
        assert.equal((await rows(target))[0].label, 'newer-local');
        assert.deepEqual(JSON.parse(target.native.applyRemoteChanges(frame.json)), ids, 'Compatibility API must use guarded identity dedupe');
        assert.equal((await rows(target))[0].label, 'newer-local');
        assert.throws(() => target.native.importPendingFrame('not json'), Error);
        assert.throws(() => target.native.importPendingFrame(frame.json.replace(/]$/, ',' + frame.json.slice(1))), /duplicate/i);
        const unknown = { id: 1, globalId: 'pending-unknown-table', tableName: 'AbsentTable', operation: 'INSERT', rowId: 1,
            globalRowId: 'absent-row', changedFields: { name: { kind: 2, value: 'absent' } }, changedFieldsNames: ['name'],
            timestamp: '2026-10-24T00:00:00Z', isFromRemote: false, isSynchronized: false };
        assert.deepEqual(target.native.importPendingFrame(JSON.stringify([unknown])), { imported: [], alreadyPresent: [], rejected: [unknown.globalId] });
        assert.equal(Number(target.native.debugQueryCount("SELECT id FROM AuditLog WHERE globalId='pending-unknown-table'")), 0);
        assert.equal(Number(target.native.debugQueryCount('SELECT id FROM _SyncControl WHERE disabled=0')), 1);
        const view = new module.Lattice(source.native.path, [], true); register(view);
        try { assert.throws(() => view.importPendingFrame(frame.json), /Writable/); }
        finally { dispose(view); }
        // Safe-value test setup only; no production SQL or owner store. This
        // creates 4097 real pending rows including the existing source insert.
        const added = source.native.addBulk(table, Array.from({ length: 4096 }, (_, i) => ({ label: `cap-${i}`, seq: 7, cache: 'cache', required: 'required-value' })));
        assert.equal(added.length, 4096);
        const beforeCap = Number(source.native.debugQueryCount('SELECT id FROM AuditLog'));
        assert.throws(() => source.native.getUnshippedAuditFrames(false, 200), /aggregate row limit/);
        assert.equal(Number(source.native.debugQueryCount('SELECT id FROM AuditLog')), beforeCap, 'Refused export must not alter source');
        return { aggregateLimitRefusedWithoutMutation: true, knownIDCannotRevert: true, compatibilityGuarded: true, malformedAndDuplicateRefused: true, unsupportedSchemaRejected: true, readonlySourceProtected: true, triggerGateRestored: true };
    }));
}
