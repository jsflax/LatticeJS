import { describe, expect, it } from 'vitest';
import { assertScalar, doubleBits, expectedUnion, fromDoubleBits, integer, mutationUnion, rowID, scalar } from './fixtures/native-hud-interop-values';

describe('native HUD oracle exact value transport', () => {
    it('preserves native Int64 extrema and refuses unsafe row identity conversion', () => {
        for (const value of [-(1n << 63n), -(1n << 53n) - 1n, 0n, (1n << 53n) + 1n, (1n << 63n) - 1n]) {
            expect(integer(String(value))).toBe(value);
            expect(scalar({ kind: 'int64', value: String(value) }, 'int')).toBe(value);
        }
        expect(rowID('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
        expect(() => rowID('9007199254740992')).toThrow(/Unsafe/);
        expect(() => integer('9223372036854775808')).toThrow(/Int64/);
        expect(() => integer(9007199254740992)).toThrow(/decimal text/);
        expect(() => integer('01')).toThrow();
    });
    it('compares floating bits, including zero, independently of native display spelling', () => {
        for (const number of [0, -0, 0.125, -0.125, 1700000000.125]) {
            const bits = doubleBits(number);
            expect(Object.is(fromDoubleBits(bits), number)).toBe(true);
            expect(() => assertScalar(number, { kind: 'unixSeconds', value: 'unused native display spelling', bits }, 'date', 'date')).not.toThrow();
        }
        expect(() => assertScalar(-0, { kind: 'float64', bits: doubleBits(0) }, 'float', 'zero')).toThrow();
        expect(() => fromDoubleBits('7ff0000000000000')).toThrow(/Nonfinite/);
    });
    it('keeps embedded JSON opaque and distinguishes epoch zero, false and null', () => {
        const text = '{"wide":9007199254740993,"escaped":"\\u0061"}';
        expect(scalar({ kind: 'embeddedJSON', value: text }, 'string')).toBe(text);
        expect(scalar({ kind: 'int64', value: '0' }, 'bool')).toBe(false);
        expect(scalar({ kind: 'null' }, 'date')).toBeNull();
        expect(scalar({ kind: 'unixSeconds', bits: doubleBits(0) }, 'date')).toBe(0);
        expect(() => scalar({ kind: 'int64', value: '2' }, 'bool')).toThrow();
    });
    it('derives exact union expectations from physical decimal cells without parsing Codable JSON', () => {
        const owner = { table: 'HUDHandler', globalId: 'owner', fields: { action: { kind: 'unionRef', table: '_HUDAction', value: 'side' } } };
        const property = { name: 'action', targetTable: '_HUDAction', logicalNullable: false, unionCases: [
            { name: 'claim', values: [{ paramName: 'ttlMs', type: 'int' }] },
            { name: 'emitEvent', values: [{ paramName: 'name', type: 'string' }] },
        ] };
        const snapshot = { rows: [{ table: '_HUDAction', globalId: 'side', fields: {
            case: { kind: 'text', value: 'claim' }, claim__ttlMs: { kind: 'int64', value: '9223372036854775807' }, emitEvent__name: { kind: 'null' },
        } }], logicalUnions: [{ ownerTable: 'HUDHandler', ownerGlobalId: 'owner', property: 'action', caseName: 'claim', codableJSON: '{"claim":{"ttlMs":9223372036854775807}}' }] };
        expect(expectedUnion(snapshot, owner, property)).toEqual({ case: 'claim', fields: { ttlMs: 9223372036854775807n } });
        snapshot.rows[0].fields.emitEvent__name = { kind: 'text', value: 'must be cleared' } as any;
        expect(() => expectedUnion(snapshot, owner, property)).toThrow(/Inactive union/);
    });
    it('supports manifest bare/string mutations and refuses integer union decoding through Number', () => {
        const property = { unionCases: [{ name: 'noop', values: [] },
            { name: 'setProp', values: [{ paramName: 'value', type: 'string' }] },
            { name: 'claim', values: [{ paramName: 'ttlMs', type: 'int' }] }] };
        expect(mutationUnion({ kind: 'unionCodableJSON', value: '{"noop":{}}' }, property)).toEqual({ case: 'noop', fields: {} });
        expect(mutationUnion({ kind: 'unionCodableJSON', value: '{"setProp":{"value":"9007199254740993"}}' }, property))
            .toEqual({ case: 'setProp', fields: { value: '9007199254740993' } });
        expect(() => mutationUnion({ kind: 'unionCodableJSON', value: '{"claim":{"ttlMs":9223372036854775807}}' }, property)).toThrow(/exact JSON decoder/);
        expect(() => mutationUnion({ kind: 'unionCodableJSON', value: '{"setProp":{"value":3}}' }, property)).toThrow();
    });
});
