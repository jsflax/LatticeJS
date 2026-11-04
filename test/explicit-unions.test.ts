import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../wasm/build/lattice.js?url', () => ({ default: '/not-loaded.js' }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/not-loaded.wasm' }));
import { defineModels } from '../src/explicit-models';
import { buildSchemas, getPropertySchemas, hydrateInstance } from '../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../src/storage';

const cases = [
    { name: 'noop', values: [] },
    { name: 'claim', values: [{ paramName: 'owner', type: 'string' }, { paramName: 'ttlMs', type: 'int' }] },
    { name: 'message', values: [{ paramName: '', type: 'string' }] },
] as const;
const definition = { formatVersion: 1, models: [{ tableName: 'UnionRow', properties: [
    { name: 'action', kind: 'union', type: 'string', nullable: true, logicalNullable: false, targetTable: '_Action', unionCases: cases },
    { name: 'optional', kind: 'union', type: 'string', nullable: true, logicalNullable: true, targetTable: '_Action', unionCases: cases },
] }] } as const;
const noop = () => ({ case: 'noop', fields: {} });
class NativeUnion {
    values = new Map<string, any>();
    isValid() { return true; }
    getInt() { return 0n; }
    getString() { return ''; }
    getUnion = vi.fn((key: string) => this.values.get(key) ?? null);
    setUnion = vi.fn((key: string, value: any) => { this.values.set(key, structuredClone(value)); });
    setNil = vi.fn();
    delete = vi.fn();
}
let allocate: ReturnType<typeof vi.fn>;
beforeEach(() => {
    allocate = vi.fn(() => new NativeUnion());
    setWasmModule({ createDynamicObject: allocate, explicitUnionVersion: () => 1 });
});
afterEach(() => setWasmModule(null));

describe('explicit union descriptors', () => {
    it('preserves ordered cases, physical optionality and independent logical nullability', () => {
        setWasmModule(null);
        const { UnionRow } = defineModels(definition);
        const [schema] = buildSchemas([UnionRow]);
        expect(schema.properties[0]).toMatchObject({ kind: 'union', type: 'string', nullable: true, logicalNullable: false, targetTable: '_Action', unionCases: cases });
        expect(schema.properties[1].logicalNullable).toBe(true);
        expect(allocate).not.toHaveBeenCalled();
    });
    it.each([
        ['missing logical nullability', (p: any) => { delete p.logicalNullable; }],
        ['physical nonnull', (p: any) => { p.nullable = false; }],
        ['wrong storage', (p: any) => { p.type = 'int'; }],
        ['empty cases', (p: any) => { p.unionCases = []; }],
        ['duplicate case', (p: any) => { p.unionCases.push(p.unionCases[0]); }],
        ['unknown field type', (p: any) => { p.unionCases[1].values[0].type = 'float'; }],
        ['nullable associated field', (p: any) => { p.unionCases[1].values[0].nullable = true; }],
        ['linked associated field', (p: any) => { p.unionCases[1].values[0].isLink = true; }],
        ['duplicate field', (p: any) => { p.unionCases[1].values.push(p.unionCases[1].values[0]); }],
        ['multi-value unlabeled field', (p: any) => { p.unionCases[1].values[0].paramName = ''; }],
        ['derived column collision', (p: any) => { p.unionCases.push({ name: 'claim__owner', values: [{ paramName: '', type: 'string' }] }); }],
        ['case-insensitive column collision', (p: any) => { p.unionCases.push({ name: 'CLAIM__OWNER', values: [{ paramName: '', type: 'string' }] }); }],
        ['model-table collision', (p: any) => { p.targetTable = 'UnionRow'; }],
        ['case-insensitive model-table collision', (p: any) => { p.targetTable = 'unionrow'; }],
        ['too many cases', (p: any) => { p.unionCases = Array.from({ length: 129 }, (_, i) => ({ name: `c${i}`, values: [] })); }],
        ['too many fields', (p: any) => { p.unionCases[1].values = Array.from({ length: 65 }, (_, i) => ({ paramName: `f${i}`, type: 'string' })); }],
        ['sparse cases', (p: any) => { p.unionCases = new Array(2); }],
        ['indexed union', (p: any) => { p.isIndexed = true; }],
        ['noHistory', (p: any) => { p.noHistory = true; }],
    ])('refuses %s before native allocation', (_, mutate) => {
        const invalid: any = structuredClone(definition);
        mutate(invalid.models[0].properties[0]);
        expect(() => defineModels(invalid)).toThrow();
        expect(allocate).not.toHaveBeenCalled();
    });
    it('rejects shared union table drift and freezes nested descriptor arrays', () => {
        const input: any = structuredClone(definition);
        const { UnionRow } = defineModels(input);
        input.models[0].properties[0].unionCases = structuredClone(input.models[0].properties[0].unionCases);
        input.models[0].properties[0].unionCases[1].values[0].type = 'int';
        expect(buildSchemas([UnionRow])[0].properties[0].unionCases![1].values[0].type).toBe('string');
        expect(() => { (getPropertySchemas(UnionRow)[0].unionCases![1].values as any).push({}); }).toThrow();
        expect(() => defineModels(input)).toThrow(/Conflicting union table descriptor/);
        input.models[0].properties[0].targetTable = '_ACTION';
        expect(() => defineModels(input)).toThrow(/Conflicting union table descriptor/);
    });
    it('refuses descriptor array accessors without evaluating them', () => {
        const input: any = structuredClone(definition), getter = vi.fn(() => cases[0]);
        Object.defineProperty(input.models[0].properties[0].unionCases, '0', { get: getter, enumerable: true });
        expect(() => defineModels(input)).toThrow(/accessor/);
        expect(getter).not.toHaveBeenCalled();
    });
    it('rejects primary tables and columns that differ only by SQLite identifier case', () => {
        const input: any = structuredClone(definition);
        input.models.push({ ...input.models[0], tableName: 'unionrow' });
        expect(() => defineModels(input)).toThrow(/Duplicate table/);
        input.models.pop();
        input.models[0].properties[1].name = 'ACTION';
        expect(() => defineModels(input)).toThrow(/Duplicate property/);
        input.models[0].properties[1].name = 'GLOBALID';
        expect(() => defineModels(input)).toThrow(/Duplicate property/);
        expect(allocate).not.toHaveBeenCalled();
    });
    it('refuses runtime capability absence before creating an unmanaged object', () => {
        const { UnionRow } = defineModels(definition);
        setWasmModule({ createDynamicObject: allocate });
        expect(() => new UnionRow({ action: noop(), optional: null })).toThrow(/explicitUnionVersion/);
        expect(allocate).not.toHaveBeenCalled();
    });
});

describe('exact union values through native accessors', () => {
    it('handles bare/labeled/unlabeled cases and signed Int64 boundaries without inference', () => {
        const { UnionRow } = defineModels(definition);
        const row = new UnionRow({ action: noop(), optional: null });
        expect(row.action).toEqual(noop());
        expect(row.optional).toBeNull();
        for (const ttlMs of [-(1n << 63n), 0n, (1n << 53n) + 1n, (1n << 63n) - 1n]) {
            row.action = { case: 'claim', fields: { owner: '', ttlMs } };
            expect(row.action).toEqual({ case: 'claim', fields: { owner: '', ttlMs } });
        }
        row.action = { case: 'message', fields: { _0: 'verbatim opaque text' } };
        expect(row.action.fields._0).toBe('verbatim opaque text');
        row.optional = noop();
        row.optional = null;
        expect((row as any)[DYNAMIC_OBJECT].setNil).not.toHaveBeenCalled();
        expect((row as any)[DYNAMIC_OBJECT].setUnion).toHaveBeenLastCalledWith('optional', null);
    });
    it.each([
        null, undefined, { case: 'unknown', fields: {} }, { case: 'noop', fields: { extra: '' } },
        { case: 'claim', fields: { owner: 'x' } }, { case: 'claim', fields: { owner: 'x', ttlMs: 1 } },
        { case: 'claim', fields: { owner: 'x', ttlMs: 1n << 63n } },
        { case: 'claim', fields: { owner: null, ttlMs: 1n } },
        { case: 'noop', fields: {}, extra: true }, { case: 'noop', fields: [] },
    ])('rejects malformed or missing values before allocation: case %#', action => {
        const { UnionRow } = defineModels(definition);
        expect(() => new UnionRow({ action, optional: null } as any)).toThrow();
        expect(allocate).not.toHaveBeenCalled();
    });
    it('rejects getters and nested caller mutation; reads return independent frozen values', () => {
        const { UnionRow } = defineModels(definition);
        const getter = vi.fn(() => 'noop');
        expect(() => new UnionRow({ action: { get case() { return getter(); }, fields: {} }, optional: null })).toThrow(/accessors/);
        expect(getter).not.toHaveBeenCalled();
        const value = { case: 'claim', fields: { owner: 'before', ttlMs: 9n } };
        const row = new UnionRow({ action: value, optional: null });
        value.fields.owner = 'after';
        expect(row.action.fields.owner).toBe('before');
        const read = row.action;
        expect(() => { (read.fields as any).owner = 'mutated'; }).toThrow();
        expect(row.action).not.toBe(read);
    });
    it('strictly checks stored union DTOs without running an application constructor', () => {
        const { UnionRow } = defineModels(definition);
        const native = new NativeUnion();
        const row = hydrateInstance(UnionRow, native, {});
        expect(allocate).not.toHaveBeenCalled();
        expect(() => row.action).toThrow(/non-null union/);
        expect(row.optional).toBeNull();
        native.values.set('action', { case: 'claim', fields: { owner: 'x', ttlMs: 9007199254740992 } });
        expect(() => row.action).toThrow(/Int64/);
        native.values.set('action', { case: 'claim', fields: { owner: 'x', ttlMs: 9007199254740993n } });
        expect(row.action.fields.ttlMs).toBe(9007199254740993n);
        expect(() => { row.action = null as any; }).toThrow(/non-null union/);
        expect(native.setUnion).not.toHaveBeenCalled();
    });
});
