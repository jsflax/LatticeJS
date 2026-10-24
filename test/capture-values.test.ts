import { describe, expect, it, vi } from 'vitest';
vi.mock('../wasm/build/lattice.js?url', () => ({ default: '/not-loaded.js' }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/not-loaded.wasm' }));
import { Lattice } from '../src/lattice';
import { captureValuesSync, copyCaptureSelectors, CAPTURE_LIMITS } from '../src/capture-values';
const selectors = [{ table: 'Row', properties: ['label', 'seq', 'date', 'empty', 'bytes', 'parent'], maxRows: 2 }] as const;
const fixture = () => ({ formatVersion: 1, rows: [{ table: 'Row', globalId: 'row-1', values: {
    label: 'value', seq: (1n << 63n) - 1n, date: 0, empty: null, bytes: [0, 128, 255], parent: { table: 'Row', globalId: 'row-2' },
} }] });
describe('synchronous detached capture boundary', () => {
    it('public Lattice method is synchronous, refuses closing/legacy native and preserves the immutable result', () => {
        const native = { captureValuesSync: vi.fn(() => fixture()) };
        const db = Object.assign(Object.create(Lattice.prototype), { db: native, closing: false }) as Lattice;
        const result = db.captureValuesSync(selectors);
        expect(result).not.toBeInstanceOf(Promise); expect(result.rows[0].values.seq).toBe((1n << 63n) - 1n);
        expect(Object.isFrozen(result)).toBe(true); expect(native.captureValuesSync).toHaveBeenCalledTimes(1);
        (db as any).closing = true; expect(() => db.captureValuesSync(selectors)).toThrow(/closing or closed/);
        expect(native.captureValuesSync).toHaveBeenCalledTimes(1);
        (db as any).closing = false; (db as any).db = {}; expect(() => db.captureValuesSync(selectors)).toThrow(/capability/);
    });
    it('uses exactly one native call and returns copied immutable physical values', () => {
        const raw = fixture(), native = { captureValuesSync: vi.fn(() => raw) };
        const result = captureValuesSync(native, selectors);
        expect(native.captureValuesSync).toHaveBeenCalledTimes(1);
        expect(native.captureValuesSync).toHaveBeenCalledWith(selectors);
        expect(result.rows[0].values).toEqual(raw.rows[0].values);
        raw.rows[0].values.label = 'later'; raw.rows[0].values.bytes[0] = 9; raw.rows[0].values.parent.globalId = 'later';
        expect(result.rows[0].values.label).toBe('value'); expect(result.rows[0].values.bytes).toEqual([0, 128, 255]);
        expect(result.rows[0].values.parent).toEqual({ table: 'Row', globalId: 'row-2' });
        for (const value of [result, result.rows, result.rows[0], result.rows[0].values, result.rows[0].values.bytes, result.rows[0].values.parent]) expect(Object.isFrozen(value)).toBe(true);
    });
    it('refuses missing capability and propagates native failure without partial fallback', () => {
        expect(() => captureValuesSync({}, selectors)).toThrow(/capability/);
        expect(() => captureValuesSync({ captureValuesSync: () => { throw new Error('preflight failed'); } }, selectors)).toThrow('preflight failed');
        expect(() => captureValuesSync({ captureValuesSync: () => Promise.resolve(fixture()) }, selectors)).toThrow(/capture result/);
    });
    it.each([
        [], [{ table: 'Row', properties: [] }], [{ table: 'Row', properties: ['id'] }], [{ table: 'Row', properties: ['label', 'LABEL'] }],
        [{ table: 'Row', properties: ['label'], maxRows: 0 }], [{ table: 'Row', properties: ['label'], maxRows: null }], [{ table: 'Row', properties: ['label'], where: '1=1' }],
        [{ table: 'Row', properties: ['label'] }, { table: 'row', properties: ['label'] }],
    ])('refuses malformed selectors before native entry: %j', bad => {
        const native = { captureValuesSync: vi.fn() };
        expect(() => captureValuesSync(native, bad as any)).toThrow(); expect(native.captureValuesSync).not.toHaveBeenCalled();
    });
    it('refuses accessor/sparse selector inputs without invoking getters', () => {
        const getter = vi.fn(() => 'Row'), entry = { properties: ['label'], get table() { return getter(); } };
        expect(() => copyCaptureSelectors([entry])).toThrow(/data fields/); expect(getter).not.toHaveBeenCalled();
        const properties: any[] = new Array(1); expect(() => copyCaptureSelectors([{ table: 'Row', properties }])).toThrow(/sparse/);
        const values: any[] = []; Object.defineProperty(values, 0, { get: getter }); values.length = 1;
        expect(() => copyCaptureSelectors(values as any)).toThrow(/data elements/); expect(getter).not.toHaveBeenCalled();
    });
    it.each([
        ['wide integer', (raw: any) => raw.rows[0].values.seq = 1n << 63n],
        ['nonfinite real', (raw: any) => raw.rows[0].values.date = NaN],
        ['invalid blob', (raw: any) => raw.rows[0].values.bytes = [256]],
        ['unselected link', (raw: any) => raw.rows[0].values.parent.table = 'Other'],
        ['missing property', (raw: any) => delete raw.rows[0].values.empty],
        ['extra property', (raw: any) => raw.rows[0].values.surprise = 4],
        ['duplicate row', (raw: any) => raw.rows.push(raw.rows[0])],
        ['unknown table', (raw: any) => raw.rows[0].table = 'Other'],
        ['oversized UTF-8 cell', (raw: any) => raw.rows[0].values.label = '😀'.repeat(CAPTURE_LIMITS.cellBytes / 4 + 1)],
    ])('refuses malformed native result: %s', (_, mutate) => {
        const raw = fixture(); mutate(raw); expect(() => captureValuesSync({ captureValuesSync: () => raw }, selectors)).toThrow();
    });
    it('refuses table row bounds and aggregate UTF-8 bytes without truncation', () => {
        const raw = fixture(); raw.rows.push({ ...raw.rows[0], globalId: 'row-2' });
        expect(() => captureValuesSync({ captureValuesSync: () => raw }, [{ ...selectors[0], maxRows: 1 }])).toThrow(/row bound/);
        const result = { formatVersion: 1, rows: Array.from({ length: 33 }, (_, i) => ({ table: 'Row', globalId: `r-${i}`, values: { text: 'x'.repeat(CAPTURE_LIMITS.cellBytes) } })) };
        expect(() => captureValuesSync({ captureValuesSync: () => result }, [{ table: 'Row', properties: ['text'] }])).toThrow(/aggregate byte/);
    });
});
