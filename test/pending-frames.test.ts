import { describe, expect, it, vi } from 'vitest';
vi.mock('../wasm/build/lattice.js?url', () => ({ default: '/not-loaded.js' }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/not-loaded.wasm' }));
import { Lattice } from '../src/lattice';
import { parseSafeAuditJSON, assertSafeAuditValue } from '../src/audit-json';
import { copyPendingAuditFrames, drainPendingAuditFrames, drainPendingUploads, readPendingAuditFrames, selectPendingUploads,
    validatePendingImportResult, MAX_PENDING_FRAME_BYTES, MAX_PENDING_TOTAL_ENTRIES, type PendingAuditFrame } from '../src/pending-drain';

const wire = '[{"id":9007199254740993,"globalId":"a","tableName":"Row","operation":"UPDATE","rowId":9223372036854775807,"globalRowId":"row","changedFields":{"seq":{"kind":0,"value":-9223372036854775808},"cache":{"kind":4,"value":null}},"changedFieldsNames":["seq","cache"],"timestamp":"2026-10-24T00:00:00Z","isFromRemote":true,"isSynchronized":false,"synthesized":true,"noHistoryNulls":["cache"]}]';
const frame = (id = 'a', json = wire): PendingAuditFrame => ({ formatVersion: 1, entries: [{ globalId: id, tableName: 'Row' }], json });
const report = (imported: string[] = [], alreadyPresent: string[] = [], rejected: string[] = []) => ({ imported, alreadyPresent, rejected });
const facade = (db: any) => Object.assign(Object.create(Lattice.prototype), { db, observerDisposers: new Set() }) as any;

describe('opaque pending frames', () => {
    it('passes Int64 extrema and metadata byte-for-byte without parsing JSON payloads across two rescues', async () => {
        const input = [frame()];
        const source = { getUnshippedAuditFrames: vi.fn(() => input) };
        const selected = readPendingAuditFrames(source, {}, 100);
        expect(source.getUnshippedAuditFrames).toHaveBeenCalledWith(false, 100);
        const seen: string[] = [];
        const target = { importPendingFrame: (json: string) => { seen.push(json); return report(['a']); } };
        const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('Payload parse is forbidden'); });
        const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('Payload rewrite is forbidden'); });
        try {
            expect((await drainPendingAuditFrames(target, selected)).applied).toEqual(['a']);
            expect((await drainPendingAuditFrames(target, readPendingAuditFrames({ getUnshippedAuditFrames: () => selected as PendingAuditFrame[] }))).applied).toEqual(['a']);
        } finally { parse.mockRestore(); stringify.mockRestore(); }
        expect(seen).toEqual([wire, wire]);
        expect(input[0].json).toBe(wire);
        expect(Object.isFrozen(selected[0].entries[0])).toBe(true);
    });
    it('sends localOnly and chunk bounds to native selection and fails closed on older runtimes', async () => {
        const get = vi.fn(() => []);
        readPendingAuditFrames({ getUnshippedAuditFrames: get }, { localOnly: true }, 1);
        expect(get).toHaveBeenCalledWith(true, 1);
        expect(() => readPendingAuditFrames({})).toThrow(/capability/);
        for (const size of [0, 1001, 1.5, NaN]) expect(() => readPendingAuditFrames({ getUnshippedAuditFrames: get }, {}, size)).toThrow(/maxEntries/);
        await expect(drainPendingAuditFrames({}, [])).rejects.toThrow(/capability/);
    });
    it('accounts imported, known and rejected identities exactly without changing source', async () => {
        const input: PendingAuditFrame[] = [{ ...frame(), entries: ['a', 'b', 'c'].map(globalId => ({ globalId, tableName: 'Row' })) }];
        const before = structuredClone(input);
        const result = await drainPendingAuditFrames({ importPendingFrame: () => report(['a'], ['b'], ['c']) }, input);
        expect(result).toEqual({ sourceMissing: false, found: 3, offered: 3, alreadyPresent: 1, unknownTable: 0, applied: ['a'], failed: ['c'] });
        expect(input).toEqual(before);
    });
    it.each([
        ['missing result', undefined], ['missing identity', report()], ['foreign identity', report(['other'])],
        ['duplicate identity', report(['a', 'a'])], ['contradictory identity', report(['a'], ['a'])],
        ['malformed category', { imported: 'a', alreadyPresent: [], rejected: [] }],
    ])('does not report success for %s', async (_, invalid) => {
        const target = { importPendingFrame: () => invalid as any };
        const result = await drainPendingAuditFrames(target, [frame()]);
        expect(result.applied).toEqual([]); expect(result.failed).toEqual(['a']);
        expect(() => validatePendingImportResult(invalid, ['a'])).toThrow();
    });
    it('retains ambiguous failed work and yields only between native frames', async () => {
        const sleep = vi.fn(async () => {}), seen: string[] = [];
        const result = await drainPendingAuditFrames({ importPendingFrame: json => {
            seen.push(json); if (seen.length === 1) throw new Error('native failed'); return report([], ['b']);
        } }, [frame(), frame('b', 'native-second-frame')], { sleep });
        expect(result.failed).toEqual(['a']); expect(result.alreadyPresent).toBe(1); expect(sleep).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([wire, 'native-second-frame']);
    });
    it('refuses the whole aggregate before importing any frame', async () => {
        const native = vi.fn(() => report());
        const rows = Array.from({ length: MAX_PENDING_TOTAL_ENTRIES + 1 }, (_, i) => frame(`id-${i}`, '[]'));
        await expect(drainPendingAuditFrames({ importPendingFrame: native }, rows)).rejects.toThrow(/aggregate/);
        const large = 'x'.repeat(MAX_PENDING_FRAME_BYTES);
        await expect(drainPendingAuditFrames({ importPendingFrame: native }, [frame('a', large), frame('b', large), frame('c', '[]')])).rejects.toThrow(/aggregate/);
        expect(native).not.toHaveBeenCalled();
    });
    it('refuses malformed metadata, duplicate IDs and oversized frames before import', async () => {
        const native = vi.fn(() => report(['a']));
        for (const input of [[frame(), frame()], [{ ...frame(), formatVersion: 2 }], [{ ...frame(), entries: [] }],
            [{ ...frame(), json: 'x'.repeat(MAX_PENDING_FRAME_BYTES + 1) }]]) {
            await expect(drainPendingAuditFrames({ importPendingFrame: native }, input as any)).rejects.toThrow();
        }
        expect(native).not.toHaveBeenCalled();
        const input = frame(); const copied = copyPendingAuditFrames([input]);
        (input.entries as any)[0].globalId = 'changed';
        expect(copied[0].entries[0].globalId).toBe('a');
    });
});

describe('legacy audit numeric refusal', () => {
    it.each(['9007199254740993', '9223372036854775807', '-9223372036854775808', '1e100', '1e400'])('refuses unsafe wire token %s before it escapes', token => {
        expect(() => parseSafeAuditJSON(`{"n":${token}}`)).toThrow(/Unsafe audit number/);
        expect(() => selectPendingUploads(wire.replace('-9223372036854775808', token))).toThrow(/Unsafe audit number/);
    });
    it('allows safe numbers, dates and escaped numeric text', () => {
        const json = '{"safe":9007199254740991,"date":-0.125,"text":"\\\"9223372036854775807\\\\"}';
        expect(parseSafeAuditJSON(json)).toEqual(JSON.parse(json));
        expect(() => parseSafeAuditJSON('{"bad":01}')).toThrow();
    });
    it('refuses unsafe legacy objects before any native call', async () => {
        const native = vi.fn(() => report());
        const rows: any = [{ globalId: 'a', id: 1, changedFields: { n: Number.MAX_SAFE_INTEGER + 2 } }];
        await expect(drainPendingUploads({ getPendingAuditLog: () => '[]', importPendingFrame: native }, rows)).rejects.toThrow(/Unsafe audit number/);
        expect(() => facade({ importPendingFrame: native }).applyRemoteChanges(rows)).toThrow(/Unsafe audit number/);
        expect(native).not.toHaveBeenCalled();
        expect(() => assertSafeAuditValue({ n: 9n })).toThrow(/opaque audit frames/);
    });
    it('delivers exact raw observation but refuses rounded legacy delivery and retires callbacks', () => {
        const callbacks: ((frame: string) => void)[] = [], remove = vi.fn();
        const db = facade({ getUnshippedAuditFrames: () => [], observeAuditLog: (cb: any) => (callbacks.push(cb), callbacks.length), removeAuditLogObserver: remove });
        const raw = vi.fn(), legacy = vi.fn();
        const stopRaw = db.observeAuditFrames(raw), stopLegacy = db.observe(legacy);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try { callbacks.forEach(cb => cb(wire)); } finally { error.mockRestore(); }
        expect(raw).toHaveBeenCalledWith(wire); expect(legacy).not.toHaveBeenCalled();
        stopRaw(); stopLegacy(); callbacks.forEach(cb => cb(wire));
        expect(raw).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(2);
    });
    it('refuses exact frame observation on a legacy runtime before registering a callback', () => {
        const observeAuditLog = vi.fn();
        expect(() => facade({ observeAuditLog }).observeAuditFrames(() => {})).toThrow(/exact audit frame capability/);
        expect(observeAuditLog).not.toHaveBeenCalled();
    });
    it('checks numbers in string-encoded changedFields and rejects unsafe pending inspection', () => {
        const db = facade({ getPendingAuditLog: () => wire });
        expect(() => db.getPendingChanges()).toThrow(/Unsafe audit number/);
        expect(() => db.parseAuditLogEntry({ changedFields: '{"n":9223372036854775807}', changedFieldsNames: '[]' })).toThrow(/Unsafe audit number/);
    });
});
