import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineModels } from '../src/explicit-models';
import { buildSchemas } from '../src/decorators';
import { setWasmModule } from '../src/storage';

function definition(flag: unknown = true): any {
    return { formatVersion: 1, models: [{ tableName: 'NoHistoryRow', properties: [
        { name: 'cache', kind: 'primitive', type: 'string', nullable: true, noHistory: flag },
    ] }] };
}
afterEach(() => setWasmModule(null));

describe('explicit NoHistory metadata', () => {
    it.each([true, false])('preserves the exact boolean %s through metadata and native descriptors', flag => {
        const { NoHistoryRow } = defineModels(definition(flag));
        expect(buildSchemas([NoHistoryRow])[0].properties[0].noHistory).toBe(flag);
    });
    it('keeps absent metadata absent for legacy primitive models', () => {
        const input = definition(); delete input.models[0].properties[0].noHistory;
        const { NoHistoryRow } = defineModels(input);
        expect(Object.hasOwn(buildSchemas([NoHistoryRow])[0].properties[0], 'noHistory')).toBe(false);
    });
    it.each([null, undefined, 1, 'true'])('rejects nonboolean flag %# before native allocation', flag => {
        const allocate = vi.fn(); setWasmModule({ createDynamicObject: allocate });
        const input = definition(); input.models[0].properties[0].noHistory = flag;
        expect(() => defineModels(input)).toThrow(/noHistory/);
        expect(allocate).not.toHaveBeenCalled();
    });
    it.each([true, false])('rejects NoHistory on links even when the flag is %s', flag => {
        const input = definition(flag);
        Object.assign(input.models[0].properties[0], { kind: 'link', type: 'int', targetTable: 'NoHistoryRow' });
        expect(() => defineModels(input)).toThrow(/noHistory/);
    });
    it('requires native capability before allocation only for true flags', () => {
        const allocate = vi.fn(() => ({ isValid: () => true, getInt: () => 0n, getString: () => '', setNil: vi.fn(), delete: vi.fn() }));
        setWasmModule({ createDynamicObject: allocate });
        const flagged = defineModels(definition(true)).NoHistoryRow;
        expect(() => new flagged({ cache: null })).toThrow(/explicitNoHistoryVersion/);
        expect(allocate).not.toHaveBeenCalled();
        const ordinary = defineModels(definition(false)).NoHistoryRow;
        new ordinary({ cache: null });
        expect(allocate).toHaveBeenCalledOnce();
        setWasmModule({ createDynamicObject: allocate, explicitNoHistoryVersion: () => 1 });
        new flagged({ cache: null });
        expect(allocate).toHaveBeenCalledTimes(2);
        expect(allocate.mock.calls[1][1][0].noHistory).toBe(true);
    });
});
