import { describe, expect, it, vi } from 'vitest';
vi.mock('../wasm/build/lattice.js?url', () => ({ default: '/not-loaded.js' }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/not-loaded.wasm' }));
import { Lattice } from '../src/lattice';
import { drainPendingUploads, selectPendingUploads } from '../src/pending-drain';

const entry = () => ({
    id: 1, globalId: 'audit-fixture', tableName: 'Row', operation: 'UPDATE', rowId: 7,
    globalRowId: 'row-fixture', changedFields: { cache: { kind: 4, value: null } },
    changedFieldsNames: ['cache'], timestamp: '2026-10-24T00:00:00Z',
    isFromRemote: false, isSynchronized: false, synthesized: true, noHistoryNulls: ['cache'],
});
const facade = (native: any = {}) => Object.assign(Object.create(Lattice.prototype), {
    db: native, observerDisposers: new Set(),
}) as any;

describe('audit wire metadata', () => {
    it.each([false, true])('retains optional metadata through observer delivery and retransmission (string containers: %s)', stringContainers => {
        let emit: (json: string) => void = () => {};
        const applied: any[] = [];
        const native = {
            observeAuditLog(callback: typeof emit) { emit = callback; return 1; },
            removeAuditLogObserver: vi.fn(),
            applyRemoteChanges(json: string) { applied.push(...JSON.parse(json)); return '["audit-fixture"]'; },
        };
        const db = facade(native), observed: any[] = [];
        const stop = db.observe((rows: any[]) => observed.push(...rows));
        const raw: any = entry();
        if (stringContainers) {
            raw.changedFields = JSON.stringify(raw.changedFields);
            raw.changedFieldsNames = JSON.stringify(raw.changedFieldsNames);
        }
        emit(JSON.stringify([raw]));
        expect(observed).toEqual([entry()]);
        expect(db.applyRemoteChanges(observed)).toEqual(['audit-fixture']);
        expect(applied).toEqual([entry()]);
        stop();
        expect(native.removeAuditLogObserver).toHaveBeenCalledWith(1);
    });
    it('retains flat null, false synthesized, and empty marker arrays; leaves absent metadata absent', () => {
        const db = facade();
        const raw: any = entry();
        raw.changedFields.cache = null;
        raw.synthesized = false;
        expect(db.parseAuditLogEntry(raw)).toEqual(raw);
        raw.noHistoryNulls = [];
        expect(db.parseAuditLogEntry(raw).noHistoryNulls).toEqual([]);
        delete raw.noHistoryNulls;
        delete raw.synthesized;
        const parsed = db.parseAuditLogEntry(raw);
        expect(Object.hasOwn(parsed, 'noHistoryNulls')).toBe(false);
        expect(Object.hasOwn(parsed, 'synthesized')).toBe(false);
    });
    it.each([
        ['null list', (raw: any) => { raw.noHistoryNulls = null; }],
        ['nonarray', (raw: any) => { raw.noHistoryNulls = 'cache'; }],
        ['duplicate', (raw: any) => { raw.noHistoryNulls = ['cache', 'cache']; }],
        ['empty name', (raw: any) => { raw.noHistoryNulls = ['']; }],
        ['missing field', (raw: any) => { delete raw.changedFields.cache; }],
        ['unlisted field', (raw: any) => { raw.changedFieldsNames = []; }],
        ['incomplete typed null', (raw: any) => { raw.changedFields.cache = { kind: 4 }; }],
        ['coerced typed null', (raw: any) => { raw.changedFields.cache = { kind: 2, value: null }; }],
        ['nonnull field', (raw: any) => { raw.changedFields.cache = { kind: 2, value: 'present' }; }],
        ['delete operation', (raw: any) => { raw.operation = 'DELETE'; }],
    ])('refuses malformed explicit null metadata: %s', (_, mutate) => {
        const raw = entry(); mutate(raw);
        expect(() => facade().parseAuditLogEntry(raw)).toThrow(/Invalid noHistoryNulls/);
    });
    it('preserves metadata from pending enumeration through the raw drain path', async () => {
        const raw = entry(), db = facade({ getPendingAuditLog: () => JSON.stringify([raw]) });
        expect(db.getPendingChanges()).toEqual([raw]);
        const received: any[] = [];
        const target = {
            getPendingAuditLog: () => '[]',
            applyRemoteChanges(json: string) { received.push(...JSON.parse(json)); return '["audit-fixture"]'; },
        };
        const result = await drainPendingUploads(target, selectPendingUploads(JSON.stringify([raw])));
        expect(result.applied).toEqual(['audit-fixture']);
        expect(received).toEqual([raw]);
    });
});
