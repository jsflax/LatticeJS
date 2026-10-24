import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../wasm/build/lattice.js?url', () => ({ default: '/not-loaded.js' }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/not-loaded.wasm' }));
import { defineModels, type ExplicitModelsDefinition } from '../src/explicit-models';
import { buildSchemas, getPropertySchemas, hydrateInstance, model } from '../src/decorators';
import { DYNAMIC_OBJECT, LATTICE_REF, setWasmModule } from '../src/storage';
import { Lattice } from '../src/lattice';

class NativeObject {
    values = new Map<string, any>([['id', 0n]]);
    delete = vi.fn();
    isValid() { return true; }
    hasValue(key: string) { return this.values.has(key) && this.values.get(key) !== null; }
    getInt(key: string) { return this.values.get(key) ?? 0n; }
    getDouble(key: string) { return this.values.get(key); }
    getString(key: string) { return this.values.get(key) ?? ''; }
    getBool(key: string) { return this.values.get(key); }
    getData(key: string) { return this.values.get(key); }
    getObject(key: string) { return this.values.get(key); }
    setInt(key: string, value: bigint) { this.values.set(key, value); }
    setDouble(key: string, value: number) { this.values.set(key, value); }
    setString(key: string, value: string) { this.values.set(key, value); }
    setBool(key: string, value: boolean) { this.values.set(key, value); }
    setData(key: string, value: Uint8Array) { this.values.set(key, value); }
    setObject(key: string, value: NativeObject) { this.values.set(key, value); }
    setNil(key: string) { this.values.set(key, null); }
}

const definition = {
    formatVersion: 1,
    models: [{
        tableName: 'ExplicitRecord',
        properties: [
            { name: 'name', kind: 'primitive', type: 'string', nullable: false, isFullText: true },
            { name: 'seq', kind: 'primitive', type: 'int', representation: 'bigint', nullable: false, isIndexed: true },
            { name: 'at', kind: 'primitive', type: 'date', representation: 'unixSeconds', nullable: true },
            { name: 'score', kind: 'primitive', type: 'float', nullable: false },
            { name: 'ok', kind: 'primitive', type: 'bool', nullable: false },
            { name: 'bytes', kind: 'primitive', type: 'blob', nullable: true },
            { name: 'parent', kind: 'link', type: 'int', targetTable: 'ExplicitRecord', nullable: true },
        ],
        constraints: [{ columns: ['name', 'seq'], allowsUpsert: true }],
    }],
} as const satisfies ExplicitModelsDefinition;
function values() { return { name: 'one', seq: 1n, at: 0, score: 7, ok: true, bytes: null, parent: null }; }
let allocate: ReturnType<typeof vi.fn>;
beforeEach(() => {
    allocate = vi.fn(() => new NativeObject());
    setWasmModule({ createDynamicObject: allocate });
});
afterEach(() => setWasmModule(null));

describe('explicit schema definitions', () => {
    it('defines and extracts schemas without WASM, construction or inferred defaults', () => {
        setWasmModule(null);
        const { ExplicitRecord } = defineModels(definition);
        expect(allocate).not.toHaveBeenCalled();
        const [schema] = buildSchemas([ExplicitRecord]);
        expect(schema.tableName).toBe('ExplicitRecord');
        expect(schema.constraints).toEqual([{ columns: ['name', 'seq'], allowsUpsert: true }]);
        expect(schema.properties.find(p => p.name === 'seq')).toMatchObject({ kind: 'primitive', type: 'int', nullable: false, isIndexed: true });
        expect(schema.properties.find(p => p.name === 'score')?.type).toBe('float');
        expect(schema.properties.find(p => p.name === 'parent')).toMatchObject({ kind: 'link', type: 'int', nullable: true, targetTable: 'ExplicitRecord' });
        expect(getPropertySchemas(ExplicitRecord).every(p => p.defaultValue === undefined)).toBe(true);
        expect(() => new ExplicitRecord(values())).toThrow(/WASM not loaded/);
    });

    it.each([
        ['version', (d: any) => { d.formatVersion = 2; }],
        ['union', (d: any) => { d.models[0].properties[0].kind = 'union'; }],
        ['nonboolean noHistory', (d: any) => { d.models[0].properties[0].noHistory = 'false'; }],
        ['default', (d: any) => { d.models[0].properties[0].defaultValue = ''; }],
        ['list', (d: any) => { d.models[0].properties[6].kind = 'list'; }],
        ['unknown type', (d: any) => { d.models[0].properties[0].type = 'anything'; }],
        ['missing int representation', (d: any) => { delete d.models[0].properties[1].representation; }],
        ['date milliseconds', (d: any) => { d.models[0].properties[2].representation = 'milliseconds'; }],
        ['missing nullability', (d: any) => { delete d.models[0].properties[0].nullable; }],
        ['duplicate field', (d: any) => { d.models[0].properties.push(d.models[0].properties[0]); }],
        ['duplicate table', (d: any) => { d.models.push(d.models[0]); }],
        ['unknown target', (d: any) => { d.models[0].properties[6].targetTable = 'Missing'; }],
        ['unknown constraint column', (d: any) => { d.models[0].constraints[0].columns = ['Missing']; }],
        ['unsafe identifier', (d: any) => { d.models[0].tableName = 'Bad; DROP TABLE'; }],
    ])('rejects %s before any database open or allocation', async (_, mutate) => {
        const invalid = structuredClone(definition);
        mutate(invalid);
        const open = vi.spyOn(Lattice, 'open');
        try {
            expect(() => { const models = defineModels(invalid); void Lattice.open(':memory:', Object.values(models)); }).toThrow();
            expect(open).not.toHaveBeenCalled();
            expect(allocate).not.toHaveBeenCalled();
        } finally { open.mockRestore(); }
    });

    it('copies and freezes descriptors so caller mutations cannot change the schema', () => {
        const input: any = structuredClone(definition);
        const { ExplicitRecord } = defineModels(input);
        input.models[0].properties[0].type = 'int';
        expect(buildSchemas([ExplicitRecord])[0].properties[0].type).toBe('string');
        expect(() => { getPropertySchemas(ExplicitRecord)[0].type = 'int'; }).toThrow();
    });
});

describe('explicit value codecs through existing native accessors', () => {
    it('requires every creation value, including nullable fields, before allocation', () => {
        const { ExplicitRecord } = defineModels(definition);
        expect(() => new ExplicitRecord({} as any)).toThrow(/Missing creation value/);
        expect(() => new ExplicitRecord({ ...values(), at: undefined } as any)).toThrow(/explicit value or null/);
        expect(() => new ExplicitRecord({ ...values(), extra: 1 } as any)).toThrow(/Unsupported creation/);
        expect(() => new ExplicitRecord({ ...values(), name: null } as any)).toThrow(/non-null/);
        expect(allocate).not.toHaveBeenCalled();
    });

    it.each([-(1n << 63n), (1n << 63n) - 1n, (1n << 53n) - 1n, (1n << 53n) + 1n])('preserves Int64 %s', seq => {
        const { ExplicitRecord } = defineModels(definition);
        const row = new ExplicitRecord({ ...values(), seq });
        expect(row.seq).toBe(seq);
        expect((row as any)[DYNAMIC_OBJECT].getInt('seq')).toBe(seq);
    });

    it.each([1, 9007199254740992, NaN, Infinity, 1n << 63n, -(1n << 63n) - 1n])('rejects invalid Int64 input %s', seq => {
        const { ExplicitRecord } = defineModels(definition);
        expect(() => new ExplicitRecord({ ...values(), seq } as any)).toThrow(/Int64/);
        expect(allocate).not.toHaveBeenCalled();
    });

    it.each([0, -0.125, 1234567890.123456, null])('preserves Unix seconds %s without Date conversion', at => {
        const { ExplicitRecord } = defineModels(definition);
        const row = new ExplicitRecord({ ...values(), at });
        expect(row.at).toBe(at);
        row.at = null;
        expect(row.at).toBeNull();
    });

    it('rejects nonfinite dates, implicit Date conversion, and scalar coercion', () => {
        const { ExplicitRecord } = defineModels(definition);
        const row = new ExplicitRecord(values());
        for (const at of [Infinity, NaN, new Date(0), '0', undefined]) expect(() => { row.at = at as any; }).toThrow();
        expect(() => { row.score = Infinity; }).toThrow();
        expect(() => { row.ok = 1 as any; }).toThrow();
        expect(() => { row.name = 9 as any; }).toThrow();
        row.bytes = new Uint8Array([0, 255]);
        expect(row.bytes).toEqual(new Uint8Array([0, 255]));
        expect(row.score).toBe(7);
    });

    it('hydrates without creation values or another native allocation; rejects lossy stored integers', () => {
        const { ExplicitRecord } = defineModels(definition);
        const native = new NativeObject();
        native.values.set('seq', (1n << 53n) + 1n);
        native.values.set('at', 0);
        const row = hydrateInstance(ExplicitRecord, native, {});
        expect(allocate).not.toHaveBeenCalled();
        expect(row.seq).toBe((1n << 53n) + 1n);
        expect(row.at).toBe(0);
        native.values.set('seq', Number.MAX_SAFE_INTEGER + 1);
        expect(() => row.seq).toThrow();
        native.values.delete('seq');
        expect(() => row.seq).toThrow(/Missing required/);
    });

    it('uses checked safe-number row IDs and refuses unsupported native IDs', () => {
        const { ExplicitRecord } = defineModels(definition);
        const native = new NativeObject();
        const row = hydrateInstance(ExplicitRecord, native, {});
        expect(row.id).toBeUndefined();
        native.values.set('id', BigInt(Number.MAX_SAFE_INTEGER));
        expect(row.id).toBe(Number.MAX_SAFE_INTEGER);
        native.values.set('id', BigInt(Number.MAX_SAFE_INTEGER) + 1n);
        expect(() => row.id).toThrow(/safe integer/);
    });

    it('shares strict codecs through declared links and rejects other target models', () => {
        const { ExplicitRecord } = defineModels(definition);
        const parent = new ExplicitRecord({ ...values(), seq: (1n << 53n) + 1n });
        Object.defineProperty(parent, 'toString', { value() { throw new Error('No application coercion during link assignment'); } });
        const child = new ExplicitRecord({ ...values(), parent });
        expect(child.parent!.id).toBeUndefined();
        expect((child.parent as any).seq).toBe((1n << 53n) + 1n);
        const { ExplicitRecord: Other } = defineModels(definition);
        expect(() => { child.parent = new Other(values()); }).toThrow(/declared link target/);
        child.parent = null;
        expect(child.parent).toBeNull();
    });

    it('deletes an invalid native link wrapper before rejecting hydration', () => {
        const { ExplicitRecord } = defineModels(definition);
        const native = new NativeObject();
        const invalid = { isValid: () => false, delete: vi.fn() };
        native.values.set('parent', invalid);
        const row = hydrateInstance(ExplicitRecord, native, {});
        expect(() => row.parent).toThrow(/Cannot hydrate stored link/);
        expect(invalid.delete).toHaveBeenCalledOnce();
    });

    it('keeps legacy decorator integer and Date behavior separate', () => {
        class Legacy { count = 1; when = new Date(1); }
        const Model = model(Legacy);
        const native = new NativeObject();
        native.values.set('count', 42n);
        native.values.set('when', 1);
        const row = hydrateInstance(Model, native, {});
        expect(row.count).toBe(42);
        expect(row.when).toEqual(new Date(1000));
    });
});

describe('explicit managed query admission', () => {
    it('requires identity-query capability for every explicit query route without falling back', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const handle = { objects: vi.fn(() => []), findObject: vi.fn() };
        const db = Object.assign(Object.create(Lattice.prototype), { db: handle }) as Lattice;
        const results = db.objects(ExplicitRecord);
        await expect(db.objectsArray(ExplicitRecord)).rejects.toThrow(/objectIdentities/);
        await expect(results.at(0)).rejects.toThrow(/objectIdentities/);
        await expect(results.snapshot()).rejects.toThrow(/objectIdentities/);
        await expect(results[Symbol.asyncIterator]().next()).rejects.toThrow(/objectIdentities/);
        expect(handle.objects).not.toHaveBeenCalled();
        expect(handle.findObject).not.toHaveBeenCalled();
        class Legacy { name = ''; }
        const LegacyModel = model(Legacy);
        expect(await db.objectsArray(LegacyModel)).toEqual([]);
        expect(await db.objects(LegacyModel).snapshot()).toEqual([]);
        expect(handle.objects).toHaveBeenCalledTimes(2);
    });

    it('uses identity rows with the existing query options and strict hydration across result routes', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const native = new NativeObject();
        native.values.set('id', 9n);
        native.values.set('seq', (1n << 53n) + 1n);
        native.values.set('at', 0);
        const handle = { objectIdentities: vi.fn(() => [{ id: 9n, globalId: 'row-nine' }]), objects: vi.fn(), findObject: vi.fn(() => native) };
        const db = Object.assign(Object.create(Lattice.prototype), { db: handle }) as Lattice;
        const array = await db.objectsArray(ExplicitRecord, { where: 'seq > 0', orderBy: 'name ASC', limit: 4, offset: 2 });
        expect(handle.objectIdentities).toHaveBeenLastCalledWith('ExplicitRecord', 'seq > 0', 'name ASC', 4, 2, null, null);
        expect(array[0].seq).toBe((1n << 53n) + 1n);
        const results = db.objects(ExplicitRecord).where('seq > 0').sorted('name ASC').groupBy('name').distinct('seq');
        const first = await results.at(2);
        expect(handle.objectIdentities).toHaveBeenLastCalledWith('ExplicitRecord', 'seq > 0', 'name ASC', 1, 2, 'name', 'seq');
        expect(first?.at).toBe(0);
        expect((await results.snapshot())[0].seq).toBe((1n << 53n) + 1n);
        expect(handle.objectIdentities).toHaveBeenLastCalledWith('ExplicitRecord', 'seq > 0', 'name ASC', null, null, 'name', 'seq');
        for await (const row of results) expect(row.seq).toBe((1n << 53n) + 1n);
        expect(handle.objectIdentities).toHaveBeenLastCalledWith('ExplicitRecord', 'seq > 0', 'name ASC', 100, 0, 'name', 'seq');
        expect(handle.objects).not.toHaveBeenCalled();
        expect(allocate).not.toHaveBeenCalled();
    });

    it('refuses global-ID and vector routes before native access for explicit models', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const handle = { findByGlobalId: vi.fn(() => null), nearestNeighbors: vi.fn(() => []), ftsQuery: vi.fn(() => []), findObject: vi.fn() };
        const db = Object.assign(Object.create(Lattice.prototype), { db: handle }) as Lattice;
        await expect(db.findByGlobalId(ExplicitRecord, 'record-id')).rejects.toThrow(/findByGlobalId is not supported/);
        await expect(db.objects(ExplicitRecord).nearest('bytes', new Float32Array([1]), 1)).rejects.toThrow(/nearest is not supported/);
        await expect(db.objects(ExplicitRecord).matching('name', 'example')).rejects.toThrow(/matching is not supported/);
        expect(handle.findByGlobalId).not.toHaveBeenCalled();
        expect(handle.nearestNeighbors).not.toHaveBeenCalled();
        expect(handle.findObject).not.toHaveBeenCalled();
        expect(handle.ftsQuery).not.toHaveBeenCalled();

        class Legacy { name = ''; }
        const LegacyModel = model(Legacy);
        expect(await db.findByGlobalId(LegacyModel, 'missing')).toBeNull();
        expect(await db.objects(LegacyModel).nearest('bytes', new Float32Array([1]), 1)).toEqual([]);
        expect(await db.objects(LegacyModel).matching('name', 'example')).toEqual([]);
        expect(handle.findByGlobalId).toHaveBeenCalledOnce();
        expect(handle.nearestNeighbors).toHaveBeenCalledOnce();
        expect(handle.ftsQuery).toHaveBeenCalledOnce();
    });

    it('releases the extra native add result while retaining the model wrapper', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const row = new ExplicitRecord(values());
        const native = (row as any)[DYNAMIC_OBJECT];
        const returned = { delete: vi.fn() };
        const handle = { addObject: vi.fn(() => returned) };
        const db = Object.assign(Object.create(Lattice.prototype), { db: handle }) as Lattice;
        expect(await db.add(row)).toBe(row);
        expect(handle.addObject).toHaveBeenCalledWith('ExplicitRecord', native);
        expect(returned.delete).toHaveBeenCalledOnce();
        expect(native.delete).not.toHaveBeenCalled();
        expect((row as any)[DYNAMIC_OBJECT]).toBe(native);
        expect((row as any)[LATTICE_REF]).toBe(db);
        row.seq = 2n;
        expect(row.seq).toBe(2n);
    });

    it('preserves the model wrapper when an add shim returns the original handle', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const row = new ExplicitRecord(values());
        const native = (row as any)[DYNAMIC_OBJECT];
        const db = Object.assign(Object.create(Lattice.prototype), { db: { addObject: () => native } }) as Lattice;
        expect(await db.add(row)).toBe(row);
        expect(native.delete).not.toHaveBeenCalled();
    });

    it('does not mark a model managed when the native add throws', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const row = new ExplicitRecord(values());
        const native = (row as any)[DYNAMIC_OBJECT];
        const db = Object.assign(Object.create(Lattice.prototype), { db: { addObject: () => { throw new Error('constraint failure'); } } }) as Lattice;
        await expect(db.add(row)).rejects.toThrow('constraint failure');
        expect((row as any)[LATTICE_REF]).toBeUndefined();
        expect(native.delete).not.toHaveBeenCalled();
    });

    it('refuses explicit and mixed bulk batches before touching native handles', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const explicit = new ExplicitRecord(values());
        class Legacy { name = ''; }
        const LegacyModel = model(Legacy);
        const legacy = new LegacyModel();
        const explicitValid = vi.spyOn((explicit as any)[DYNAMIC_OBJECT], 'isValid');
        const legacyValid = vi.spyOn((legacy as any)[DYNAMIC_OBJECT], 'isValid');
        const handle = { addBulk: vi.fn() };
        const db = Object.assign(Object.create(Lattice.prototype), { db: handle }) as Lattice;
        for (const batch of [[explicit], [legacy, explicit], [explicit, legacy]]) {
            await expect(db.addAll(batch as any)).rejects.toThrow(/addAll is not supported/);
        }
        expect(handle.addBulk).not.toHaveBeenCalled();
        expect(explicitValid).not.toHaveBeenCalled();
        expect(legacyValid).not.toHaveBeenCalled();
        expect(await db.addAll([legacy] as any)).toEqual([legacy]);
        expect(handle.addBulk).toHaveBeenCalledOnce();
    });

    it('deletes an invalid native find wrapper before returning null', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const invalid = { isValid: () => false, delete: vi.fn() };
        const db = Object.assign(Object.create(Lattice.prototype), { db: { findObject: () => invalid } }) as Lattice;
        expect(await db.find(ExplicitRecord, 1)).toBeNull();
        expect(invalid.delete).toHaveBeenCalledOnce();
    });

    it('queries keep native backing and never fall back to a detached constructor', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const native = new NativeObject();
        native.values.set('id', 9n);
        native.values.set('seq', 3n);
        const handle = { objectIdentities: () => [{ id: 9n }], findObject: vi.fn(() => native) };
        const db = Object.assign(Object.create(Lattice.prototype), { db: handle }) as Lattice;
        const [row] = await db.objectsArray(ExplicitRecord);
        row.seq = 4n;
        expect(native.getInt('seq')).toBe(4n);
        expect(allocate).not.toHaveBeenCalled();
        handle.findObject.mockImplementation(() => { throw new Error('native lookup refused'); });
        await expect(db.objectsArray(ExplicitRecord)).rejects.toThrow('native lookup refused');
        expect(allocate).not.toHaveBeenCalled();
    });

    it('refuses missing rows, missing IDs and unsafe IDs before lossy lookup', async () => {
        const { ExplicitRecord } = defineModels(definition);
        const handle = { objectIdentities: () => [{ id: 1n }], findObject: vi.fn(() => null), remove: vi.fn() };
        const db = Object.assign(Object.create(Lattice.prototype), { db: handle }) as Lattice;
        await expect(db.objectsArray(ExplicitRecord)).rejects.toThrow(/managed row/);
        for (const row of [{}, { id: 1n << 53n }]) {
            handle.objectIdentities = () => [row as any];
            handle.findObject.mockClear();
            await expect(db.objectsArray(ExplicitRecord)).rejects.toThrow(/safe integer/);
            expect(handle.findObject).not.toHaveBeenCalled();
        }
        await expect(db.find(ExplicitRecord, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(/safe integer/);
        await expect(db.remove(ExplicitRecord, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(/safe integer/);
        expect(handle.remove).not.toHaveBeenCalled();
    });
});
