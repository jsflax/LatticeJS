// Real browser/public loader qualification. These synthetic rows use the actual
// generated HUD model adapter; no source, handler, sync endpoint or owner file.
import { createHUDLatticeDefinition, HUD_REGISTRY_HASH } from 'hud-browser-gate-adapter';
import { defineModels } from '../../src/explicit-models';
import { Lattice, LogLevel } from '../../src/lattice';
import { DYNAMIC_OBJECT, getWasmModule } from '../../src/storage';

const definition = createHUDLatticeDefinition();
const models = defineModels(definition);
const allModels = Object.values(models);
const Node = models.HUDNode, Source = models.HUDSource;
const violations: string[] = [];
document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function fixture(path: string, body: (db: Lattice, own: <T>(row: T) => T) => Promise<unknown>) {
    const wrappers = new Set<any>();
    const own = <T>(row: T): T => { if (row) wrappers.add((row as any)[DYNAMIC_OBJECT]); return row; };
    const db = await Lattice.open(path, allModels, { schemaVersion: 2 });
    let result: unknown;
    try { result = await body(db, own); }
    finally {
        try { for (const wrapper of wrappers) if (!wrapper.isDeleted()) wrapper.delete(); }
        finally {
            // close() is the real public persistence and native disposal path,
            // including when an explicit wrapper cleanup itself fails.
            var closed = await db.close({ snapshotTimeoutMs: 10000 });
        }
    }
    await tick(); await tick();
    check(closed.native === 'closed', 'Native storage did not release');
    check(closed.transport === 'not-configured', 'Unexpected transport');
    const module = getWasmModule();
    const diagnostics = module._lifecycleDiagnostics();
    check(Object.values(diagnostics).every(value => value === 0), 'Native lifecycle counters remain live');
    return { result, closed, diagnostics, registryHash: HUD_REGISTRY_HASH, modelCount: allModels.length, violations: [...violations] };
}

const storageGate = {
    async seed(path: string) {
        await Lattice.setLogLevel(LogLevel.Off);
        return fixture(path, async (db, own) => {
            check(allModels.length === 8, 'Expected generated HUD models');
            check(await db.count(Node) === 0, 'Test path already has data');
            const base = { createdAt: 0, createdBy: 'browser-fixture', deletedAt: null, deletedBy: null,
                lifetimeID: 'synthetic-browser-lifetime', parent: null, sortKey: 0 };
            const root = own(new Node({ ...base, key: 'browser-fixture', kind: 'hud' }));
            await db.add(root);
            const child = own(new Node({ ...base, key: 'child', kind: 'text', parent: root, sortKey: 0.125 }));
            await db.add(child);
            const source = own(new Source({ key: 'synthetic-cache', deletedAt: null, editedAt: -0.125,
                editedBy: 'browser-fixture', lastError: 'stale', lastFetchedAt: 0.125,
                lastValue: '{"exact":"9007199254740993"}', refreshMs: 9007199254740993n,
                spec: { case: 'noop', fields: {} } }));
            await db.add(source);
            source.lastError = null; source.lastFetchedAt = 0;
            source.spec = { case: 'lease', fields: { leaseKey: 'synthetic-only' } };
            check(own(child.parent).key === root.key, 'Managed parent lookup failed');
            return { rows: await db.count(Node), refreshMs: source.refreshMs.toString(), sourceAt: source.lastFetchedAt,
                sourceError: source.lastError, spec: source.spec, rootAt: root.createdAt };
        });
    },
    async read(path: string) {
        await Lattice.setLogLevel(LogLevel.Off);
        return fixture(path, async (db, own) => {
            const nodes = (await db.objectsArray(Node, { orderBy: 'sortKey ASC' })).map(own);
            check(nodes.length === 2, 'Fresh page did not restore both persisted nodes');
            check(nodes[0].key === 'browser-fixture' && nodes[0].createdAt === 0, 'Root identity/date changed');
            check(nodes[1].sortKey === 0.125 && own(nodes[1].parent).key === 'browser-fixture', 'Parent or float changed');
            const sources = (await db.objectsArray(Source)).map(own);
            check(sources.length === 1, 'Source missing after reload');
            const source = sources[0];
            check(source.refreshMs === 9007199254740993n && source.editedAt === -0.125, 'Integer/date fidelity lost');
            check(source.lastError === null && source.lastFetchedAt === 0, 'NoHistory null/zero lost');
            check(source.lastValue === '{"exact":"9007199254740993"}', 'Embedded text changed');
            check(source.spec.case === 'lease' && source.spec.fields.leaseKey === 'synthetic-only', 'Union changed');
            return { rows: nodes.length, refreshMs: source.refreshMs.toString(), restored: true };
        });
    },
    async downgrade(path: string) {
        let opened: Lattice | undefined, failure: unknown;
        try { opened = await Lattice.open(path, allModels, { schemaVersion: 1 }); }
        catch (error) { failure = error; }
        if (opened) {
            try { await opened.close(); }
            finally { throw new Error('Persistent schema downgrade was accepted'); }
        }
        check(failure instanceof Error && /schema version \(2\).*newer.*\(1\)/i.test(failure.message),
            `Downgrade failed for an unrelated reason: ${String(failure)}`);
        return { refused: true, reason: failure.message, violations: [...violations] };
    },
    async denied(path: string) {
        // Only this synthetic browser context is changed, restoring the original
        // descriptor afterward. This exercises real loader/MEMFS fallback.
        const storage = navigator.storage;
        const original = Object.getOwnPropertyDescriptor(storage, 'getDirectory');
        Object.defineProperty(storage, 'getDirectory', { configurable: true,
            value: async () => { throw new DOMException('Synthetic denial', 'NotAllowedError'); } });
        try {
            const result = await storageGate.seed(path);
            check(result.closed.snapshot === 'error', 'Denied persistence was reported as saved');
            return result;
        } finally {
            if (original) Object.defineProperty(storage, 'getDirectory', original);
            else delete (storage as any).getDirectory;
        }
    },
    async missing(path: string) {
        const storage = navigator.storage;
        const original = Object.getOwnPropertyDescriptor(storage, 'getDirectory');
        Object.defineProperty(storage, 'getDirectory', { configurable: true, value: undefined });
        try {
            const result = await storageGate.seed(path);
            check(result.closed.snapshot === 'unavailable', 'Missing persistence was reported as saved');
            return result;
        } finally {
            if (original) Object.defineProperty(storage, 'getDirectory', original);
            else delete (storage as any).getDirectory;
        }
    },
};
(window as any).storageGate = storageGate;
