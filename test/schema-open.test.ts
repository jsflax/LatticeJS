// Exercises option forwarding and failure admission through the real TS open
// path. Native migration correctness is covered separately with rebuilt WASM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';

const { fixture } = vi.hoisted(() => ({
    fixture: new URL('./fixtures/lifecycle-wasm.js', import.meta.url).pathname,
}));
vi.mock('../wasm/build/lattice.js?url', () => ({ default: fixture }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/fixture.wasm' }));

let control: any;
let opens: any[];
beforeEach(() => {
    vi.resetModules();
    opens = [];
    control = {
        stores: new Map(), handles: [], nextClient: 1, requests: 0,
        releases: 0, deletes: 0, purges: 0, pending: () => 0,
        onConstruct: (options: any) => opens.push(options),
    };
    vi.stubGlobal('__latticeLifecycleTest', control);
    vi.stubGlobal('navigator', {});
});
afterEach(() => vi.unstubAllGlobals());

async function library() {
    const { Lattice } = await import('../src/lattice');
    const { model } = await import('../src/decorators');
    class Note { title = ''; }
    return { Lattice, Note: model(Note) };
}

describe('schema-aware opening', () => {
    it('refuses explicit NoHistory before native open when the runtime capability is absent', async () => {
        const { Lattice } = await library();
        const { defineModels } = await import('../src/explicit-models');
        const { NoHistoryRow } = defineModels({ formatVersion: 1, models: [{ tableName: 'NoHistoryRow', properties: [
            { name: 'cache', kind: 'primitive', type: 'string', nullable: true, noHistory: true },
        ] }] } as const);
        await expect(Lattice.open(':memory:nohistory', [NoHistoryRow])).rejects.toThrow(/explicitNoHistoryVersion/);
        expect(opens).toHaveLength(0);
        expect(control.handles).toHaveLength(0);
    });
    it('refuses explicit unions before native open when the runtime capability is absent', async () => {
        const { Lattice } = await library();
        const { defineModels } = await import('../src/explicit-models');
        const { UnionRow } = defineModels({ formatVersion: 1, models: [{ tableName: 'UnionRow', properties: [
            { name: 'action', kind: 'union', type: 'string', nullable: true, logicalNullable: false,
                targetTable: '_Action', unionCases: [{ name: 'noop', values: [] }] },
        ] }] } as const);
        await expect(Lattice.open(':memory:union', [UnionRow])).rejects.toThrow(/explicitUnionVersion/);
        expect(opens).toHaveLength(0);
        expect(control.handles).toHaveLength(0);
    });
    for (const path of [':memory:versioned', 'versioned.db']) {
        for (const version of [1, 5]) {
            it(`honors schema version ${version} without a callback for ${path}`, async () => {
                const { Lattice, Note } = await library();
                const db = await Lattice.open(path, [Note], { schemaVersion: version });
                try {
                    expect(opens).toHaveLength(1);
                    expect(opens[0].schemaVersion).toBe(version);
                    expect(opens[0].migration).toBeNull();
                } finally { await db.close(); }
            });
        }

        it(`passes a migration and its pending changes for ${path}`, async () => {
            const { Lattice, Note } = await library();
            const changes = [{ tableName: 'Note', addedColumns: ['title'], removedColumns: [], changedColumns: [] }];
            control.onConstruct = (options: any) => {
                opens.push(options);
                options.migration?.({ pendingChanges: changes, _ctx_ptr: 1 });
            };
            const migration = vi.fn(ctx => {
                expect(ctx.pendingChanges()).toEqual(changes);
                expect(ctx.hasChangesFor('Note')).toBe(true);
                expect(ctx.hasChangesFor('Other')).toBe(false);
            });
            const db = await Lattice.open(path, [Note], { schemaVersion: 5, migration });
            try {
                expect(opens[0].schemaVersion).toBe(5);
                expect(migration).toHaveBeenCalledOnce();
            } finally { await db.close(); }
        });
    }

    it.each([0, -1, 1.5, NaN, Infinity, 2147483648])('rejects invalid schema version %s before loading the database', async version => {
        const { Lattice, Note } = await library();
        await expect(Lattice.open('invalid.db', [Note], { schemaVersion: version })).rejects.toThrow(/schemaVersion/);
        expect(control.factories ?? 0).toBe(0);
        expect(opens).toHaveLength(0);
    });

    it('rejects an unversioned migration instead of silently ignoring it', async () => {
        const { Lattice, Note } = await library();
        await expect(Lattice.open('invalid.db', [Note], { migration() {} })).rejects.toThrow(/schemaVersion/);
        expect(opens).toHaveLength(0);
    });

    it('propagates persistent migration refusal without registering timers or handles', async () => {
        const { Lattice, Note } = await library();
        control.onConstruct = options => options.migration?.({ pendingChanges: [], _ctx_ptr: 1 });
        await expect(Lattice.open('refused.db', [Note], {
            schemaVersion: 5, migration() { throw new Error('unsupported prior schema'); },
        })).rejects.toThrow('unsupported prior schema');
        expect(control.handles).toHaveLength(0);
    });

    it('forwards active migration operations through the tagged native boundary', async () => {
        const { Lattice, Note } = await library();
        const operations: unknown[][] = [];
        control.onConstruct = options => options.migration?.({ pendingChanges: [], _ctx_ptr: 7 });
        control.migrationOperation = (...args: unknown[]) => { operations.push(args); return { ok: true }; };
        const db = await Lattice.open('operations.db', [Note], {
            schemaVersion: 5, migration(ctx) {
                ctx.renameProperty('Note', 'old', 'title');
                ctx.deleteAll('Other');
                ctx.executeSql('SELECT 1');
            },
        });
        try {
            expect(operations).toEqual([
                ['renameProperty', 7, 'Note', 'old', 'title'],
                ['deleteAll', 7, 'Other'], ['executeSql', 7, 'SELECT 1'],
            ]);
        } finally { await db.close(); }
    });

    it('refuses opening when a native migration operation returns an error', async () => {
        const { Lattice, Note } = await library();
        control.onConstruct = options => options.migration?.({ pendingChanges: [], _ctx_ptr: 7 });
        control.migrationOperation = () => ({ ok: false, error: 'no such table: Missing' });
        await expect(Lattice.open('invalid-sql.db', [Note], {
            schemaVersion: 5, migration(ctx) { ctx.executeSql('UPDATE Missing SET title = 1'); },
        })).rejects.toThrow('no such table: Missing');
        expect(control.handles).toHaveLength(0);
    });

    it('expires retained migration contexts after admission', async () => {
        const { Lattice, Note } = await library();
        let retained: any;
        control.onConstruct = options => options.migration?.({ pendingChanges: [], _ctx_ptr: 1 });
        const db = await Lattice.open('retained.db', [Note], {
            schemaVersion: 5, migration(ctx) { retained = ctx; },
        });
        try {
            expect(() => retained.pendingChanges()).toThrow(/no longer active/);
            expect(() => retained.renameProperty('Note', 'old', 'new')).toThrow(/no longer active/);
            expect(() => retained.deleteAll('Note')).toThrow(/no longer active/);
            expect(() => retained.executeSql('SELECT 1')).toThrow(/no longer active/);
        } finally { await db.close(); }
    });

    it('refuses unsupported enumeration instead of silently completing a migration', async () => {
        const { Lattice, Note } = await library();
        control.onConstruct = options => options.migration?.({ pendingChanges: [], _ctx_ptr: 1 });
        await expect(Lattice.open('enumeration.db', [Note], {
            schemaVersion: 5, migration(ctx) { ctx.enumerateObjects('Note', () => {}); },
        })).rejects.toThrow(/not supported/);
        expect(control.handles).toHaveLength(0);
    });

    it('refuses async migration callbacks and invalidates resumed access', async () => {
        const { Lattice, Note } = await library();
        let resumedError: unknown;
        control.onConstruct = options => options.migration?.({ pendingChanges: [], _ctx_ptr: 1 });
        await expect(Lattice.open('async.db', [Note], {
            schemaVersion: 5, async migration(ctx) {
                await Promise.resolve();
                try { ctx.executeSql('SELECT 1'); } catch (error) { resumedError = error; }
            },
        })).rejects.toThrow(/synchronously/);
        await Promise.resolve();
        expect(String(resumedError)).toMatch(/no longer active/);
        expect(control.handles).toHaveLength(0);
    });
});
