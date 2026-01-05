// Main Lattice class - user-facing API
import type { SchemaEntry, ModelConstructor, LatticeObject, LatticeWasm, LatticeWasmModule } from './types';
import { buildSchemas, getTableName, isModel, getPropertySchemas, hydrateInstance } from './decorators';
import { setWasmModule, DYNAMIC_OBJECT, PROPERTY_SCHEMA, LATTICE_REF } from './storage';
import { Results } from './results';

/**
 * Represents an audit log entry from the database.
 * Used for sync and observation.
 */
export interface AuditLogEntry {
    id: number;
    globalId: string;
    tableName: string;
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    rowId: number;
    globalRowId: string;
    changedFields: Record<string, unknown>;
    changedFieldsNames: string[];
    timestamp: string;
    isFromRemote: boolean;
    isSynchronized: boolean;
}

// Static imports - bundler handles the URLs
// @ts-ignore - Vite handles ?url imports
import wasmJsUrl from '../wasm/build/lattice.js?url';
// @ts-ignore
import wasmBinaryUrl from '../wasm/build/lattice.wasm?url';
// @ts-ignore - Vite handles ?url imports
import sharedWorkerUrl from './worker/shared-bootstrap?url';
import * as Comlink from 'comlink';
import type { SharedWorkerApi } from './worker/shared-impl';

// Listen for debug messages from SharedWorker
const debugChannel = new BroadcastChannel('lattice-debug');
debugChannel.onmessage = (e) => {
    if (e.data.type === 'error') {
        console.error('[SharedWorker]', e.data.msg);
    } else {
        console.log('[SharedWorker]', e.data.msg);
    }
};

// Create SharedWorker with URL
function createSharedWorker(): SharedWorker {
    const workerUrl = new URL(sharedWorkerUrl, import.meta.url);
    console.log('[Lattice] SharedWorker URL:', workerUrl.href);

    const worker = new SharedWorker(workerUrl, { type: 'module', name: 'lattice-shared' });

    // Log any errors from the worker
    worker.onerror = (e) => {
        console.error('[Lattice] SharedWorker error:', e);
    };

    return worker;
}

// Global WASM module cache
let wasmModule: any = null;

/**
 * Main Lattice class for browser-based database operations.
 *
 * For in-memory databases (`:memory:`), runs WASM directly on main thread.
 * For persistent databases, uses a Web Worker for OPFS and syncs via BroadcastChannel.
 */
export class Lattice {
    private db: LatticeWasm;
    private schemas: SchemaEntry[];
    private modelMap: Map<string, ModelConstructor>;

    // For persistent databases with worker sync
    private sharedWorker: SharedWorker | null = null;
    private workerApi: Comlink.Remote<SharedWorkerApi> | null = null;
    private broadcastChannel: BroadcastChannel | null = null;
    private syncObserverId: (() => void) | null = null;
    private instanceId: string = crypto.randomUUID();

    private constructor(
        db: LatticeWasm,
        schemas: SchemaEntry[],
        modelMap: Map<string, ModelConstructor>
    ) {
        this.db = db;
        this.schemas = schemas;
        this.modelMap = modelMap;
    }

    /**
     * Sync configuration for connecting to a Lattice server.
     */
    static syncConfig?: {
        websocketUrl: string;
        authToken?: string;
    };

    /**
     * Open a Lattice database.
     *
     * @param path Database path (use ':memory:' for in-memory)
     * @param models Array of model classes to register
     * @param options Optional configuration including sync settings
     */
    static async open(
        path: string,
        models: ModelConstructor[],
        options?: {
            sync?: {
                websocketUrl: string;
                authToken?: string;
            };
        }
    ): Promise<Lattice> {
        // Build schemas from models
        const schemas = buildSchemas(models);

        // Create model lookup map
        const modelMap = new Map<string, ModelConstructor>();
        for (const schema of schemas) {
            const model = models.find(m => getTableName(m) === schema.tableName);
            if (model) {
                modelMap.set(schema.tableName, model);
            }
        }

        // Load WASM module if not already loaded (needed for main thread)
        if (!wasmModule) {
            console.log('[Lattice] Loading WASM...');

            const module = await import(/* @vite-ignore */ wasmJsUrl);
            wasmModule = await module.default({
                locateFile: (p: string) => {
                    if (p.endsWith('.wasm')) return wasmBinaryUrl;
                    return p;
                }
            });
            console.log('[Lattice] WASM initialized');

            // Make WASM available for model instances
            setWasmModule(wasmModule);
        }

        const isInMemory = path === ':memory:' || path.startsWith(':memory:');
        const syncConfig = options?.sync;

        if (isInMemory) {
            // In-memory: just use main thread
            console.log('[Lattice] Creating in-memory database');
            let db;
            if (syncConfig?.websocketUrl) {
                console.log('[Lattice] Sync enabled:', syncConfig.websocketUrl);
                db = new wasmModule.Lattice(path, schemas, syncConfig.websocketUrl, syncConfig.authToken || '');
            } else {
                db = new wasmModule.Lattice(path, schemas);
            }
            return new Lattice(db, schemas, modelMap);
        } else {
            // Persistent: use worker for OPFS + main thread for live objects
            return Lattice.openPersistent(path, schemas, modelMap, syncConfig);
        }
    }

    /**
     * Open a persistent database with worker sync.
     */
    private static async openPersistent(
        path: string,
        schemas: SchemaEntry[],
        modelMap: Map<string, ModelConstructor>,
        syncConfig?: { websocketUrl: string; authToken?: string }
    ): Promise<Lattice> {
        console.log('[Lattice] Opening persistent database:', path);

        // Generate unique channel name for this database
        const channelName = `lattice-sync-${path.replace(/[^a-z0-9]/gi, '-')}`;

        // Create in-memory database on main thread (for live objects)
        // Main thread has sync enabled since this is where local changes originate
        let db;
        if (syncConfig?.websocketUrl) {
            console.log('[Lattice] Main thread sync enabled:', syncConfig.websocketUrl);
            db = new wasmModule.Lattice(':memory:', schemas, syncConfig.websocketUrl, syncConfig.authToken || '');
        } else {
            db = new wasmModule.Lattice(':memory:', schemas);
        }
        const lattice = new Lattice(db, schemas, modelMap);

        // Connect to SharedWorker for OPFS persistence (shared across all tabs)
        console.log('[Lattice] Connecting to SharedWorker for OPFS...');
        const sharedWorker = createSharedWorker();
        lattice.sharedWorker = sharedWorker;

        // Start the port BEFORE wrapping with Comlink
        sharedWorker.port.start();
        console.log('[Lattice] SharedWorker port started');

        // Add raw message listener for debugging
        sharedWorker.port.addEventListener('message', (e) => {
            console.log('[Lattice] Raw message from SharedWorker:', 
                JSON.stringify(e.data));
        });

        lattice.workerApi = Comlink.wrap<SharedWorkerApi>(sharedWorker.port);
        console.log('[Lattice] Comlink wrapped, calling init...');

        // Initialize WASM in worker (no-op if already initialized by another tab)
        await lattice.workerApi.init(wasmJsUrl, wasmBinaryUrl);

        // Open OPFS database in worker (no-op if already opened by another tab)
        // SharedWorker is just for persistence - main thread handles server sync
        await lattice.workerApi.open(path, schemas, channelName);
        console.log('[Lattice] SharedWorker database ready (persistence only)');

        // Set up BroadcastChannel on main thread
        lattice.broadcastChannel = new BroadcastChannel(channelName);

        // Listen for changes from other sources (worker or other tabs)
        lattice.broadcastChannel.onmessage = (event) => {
            console.log('[Lattice] BroadcastChannel received:', event.data.source, 'instanceId:', event.data.instanceId?.substring(0,8), 'myId:', lattice.instanceId.substring(0,8));
            // Ignore our own messages (same instance)
            if (event.data.instanceId === lattice.instanceId) {
                console.log('[Lattice] Ignoring own message');
                return;
            }
            console.log('[Lattice] Applying changes from:', event.data.source, 'entries:', event.data.entries?.length);
            if (event.data.entries) {
                lattice.applyRemoteChanges(event.data.entries);
            }
        };

        // Observe main thread changes and broadcast to channel
        lattice.syncObserverId = lattice.observe((entries) => {
            console.log('[Lattice] Observe callback fired, entries:', entries.length, entries.map(e => ({op: e.operation, table: e.tableName, isRemote: e.isFromRemote})));
            // Only broadcast local changes (not ones we received from elsewhere)
            const localEntries = entries.filter(e => !e.isFromRemote);
            if (localEntries.length > 0 && lattice.broadcastChannel) {
                console.log('[Lattice] Broadcasting local changes:', localEntries.length);
                lattice.broadcastChannel.postMessage({
                    source: 'main',
                    instanceId: lattice.instanceId,
                    entries: localEntries
                });
            } else if (entries.length > 0 && localEntries.length === 0) {
                console.log('[Lattice] All entries were remote, not broadcasting');
            }
        });

        // Load existing data from worker to main thread
        console.log('[Lattice] Syncing existing data from SharedWorker...');
        const pendingJson = await lattice.workerApi.getPendingAuditLog?.();
        console.log('[Lattice] Got pending audit log:', pendingJson?.substring(0, 200));
        if (pendingJson) {
            try {
                const entries = JSON.parse(pendingJson);
                if (entries.length > 0) {
                    console.log('[Lattice] Applying', entries.length, 'existing entries from SharedWorker');
                    const applied = lattice.applyRemoteChanges(entries);
                    console.log('[Lattice] Applied entries, result:', applied);
                } else {
                    console.log('[Lattice] No existing entries in SharedWorker');
                }
            } catch (e) {
                console.error('[Lattice] Failed to sync existing data:', e);
            }
        }

        console.log('[Lattice] Persistent database ready');
        return lattice;
    }

    /**
     * Add a model instance to the database.
     * Returns the instance with id and globalId populated.
     */
    async add<T extends LatticeObject>(instance: T): Promise<T> {
        const modelClass = instance.constructor as ModelConstructor;
        if (!isModel(modelClass)) {
            throw new Error(`${modelClass.name} is not a @model`);
        }

        const tableName = getTableName(modelClass);
        const dynObj = (instance as any)[DYNAMIC_OBJECT];

        if (!dynObj || !dynObj.isValid()) {
            throw new Error(`${modelClass.name} has no C++ backing - was WASM loaded before creating this object?`);
        }

        // Add to database - this makes dynObj managed and assigns id/globalId
        console.log('[Lattice.add] Adding to table:', tableName);
        this.db.addObject(tableName, dynObj);
        console.log('[Lattice.add] Added, id:', dynObj.getInt('id'));

        // Store lattice reference for link/list resolution
        (instance as any)[LATTICE_REF] = this;

        return instance;
    }

    /**
     * Find an object by its primary key.
     * Returns an instance with C++ backing for live property access (including lists).
     */
    async find<T>(modelClass: ModelConstructor<T>, id: number): Promise<T | null> {
        const tableName = getTableName(modelClass);
        const numId = typeof id === 'bigint' ? Number(id) : id;

        // Use findObject to get a JsDynamicObject with proper C++ backing
        // This is necessary for lists to work (they need to call C++ getLinkList)
        const dynObj = this.db.findObject(tableName, numId);
        if (!dynObj || !dynObj.isValid()) return null;

        return this.dynObjToInstance(modelClass, dynObj);
    }

    /**
     * Find an object by its global ID.
     */
    async findByGlobalId<T>(modelClass: ModelConstructor<T>, globalId: string): Promise<T | null> {
        const tableName = getTableName(modelClass);
        const data = this.db.findByGlobalId(tableName, globalId);
        if (!data) return null;
        return this.dataToInstance(modelClass, data);
    }

    /**
     * Query objects of a type. Returns live Results.
     *
     * @example
     * ```typescript
     * // Get live results
     * const results = lattice.objects(Person);
     *
     * // Chain filters
     * const adults = lattice.objects(Person)
     *     .where("age >= 18")
     *     .sorted("name ASC");
     *
     * // Iterate
     * for await (const person of results) {
     *     console.log(person.name);
     * }
     *
     * // Get snapshot array
     * const people = await results.snapshot();
     * ```
     */
    objects<T>(
        modelClass: ModelConstructor<T>,
        options?: {
            where?: string;
            orderBy?: string;
        }
    ): Results<T> {
        return new Results(
            this.db,
            modelClass,
            (data) => this.dataToInstance(modelClass, data),
            options
        );
    }

    /**
     * Query all objects as array (convenience method).
     * For live queries, use objects() instead.
     */
    async objectsArray<T>(
        modelClass: ModelConstructor<T>,
        options?: {
            where?: string;
            orderBy?: string;
            limit?: number;
            offset?: number;
        }
    ): Promise<T[]> {
        const tableName = getTableName(modelClass);
        const data = this.db.objects(
            tableName,
            options?.where ?? null,
            options?.orderBy ?? null,
            options?.limit ?? null,
            options?.offset ?? null
        );
        return data.map((d: Record<string, any>) => this.dataToInstance(modelClass, d));
    }

    /**
     * Count objects in a table.
     */
    async count<T>(modelClass: ModelConstructor<T>, where?: string): Promise<number> {
        const tableName = getTableName(modelClass);
        const count = this.db.count(tableName, where ?? null);
        // Convert BigInt to number if needed
        return typeof count === 'bigint' ? Number(count) : count;
    }

    /**
     * Remove an object by ID.
     */
    async remove<T>(modelClass: ModelConstructor<T>, id: number): Promise<boolean> {
        const tableName = getTableName(modelClass);
        const numId = typeof id === 'bigint' ? Number(id) : id;
        return this.db.remove(tableName, numId);
    }

    /**
     * Execute a write transaction.
     */
    async write<T>(fn: () => Promise<T>): Promise<T> {
        this.db.beginWrite();
        try {
            const result = await fn();
            this.db.commitWrite();
            return result;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get the database path.
     */
    getPath(): string {
        return this.db.path;
    }

    /**
     * Debug: List all tables in the database.
     */
    debugListTables(): string {
        return this.db.debugListTables();
    }

    /**
     * Debug: Query count with raw SQL.
     */
    debugQueryCount(sql: string): number {
        return this.db.debugQueryCount(sql);
    }

    // ========================================================================
    // Private helpers
    // ========================================================================

    /**
     * Create a model instance from database data (plain JS object).
     * Used by objects() query which returns plain objects.
     * Note: This creates a NEW DynamicObject and copies data into it.
     */
    private dataToInstance<T>(modelClass: ModelConstructor<T>, data: Record<string, unknown>): T {
        // This needs to run the constructor to create a DynamicObject
        const instance = new modelClass() as any;
        instance[LATTICE_REF] = this;

        // Get the DynamicObject to set id/globalId directly
        const dynObj = instance[DYNAMIC_OBJECT];

        // Set id and globalId on the DynamicObject
        if (data.id !== undefined) {
            const id = typeof data.id === 'bigint' ? Number(data.id) : data.id as number;
            dynObj.setInt('id', id);
        }
        if (data.globalId !== undefined) {
            dynObj.setString('globalId', data.globalId as string);
        }

        // Set other values via the property accessors (goes to C++ storage)
        for (const [key, value] of Object.entries(data)) {
            if (key === 'id' || key === 'globalId') continue; // Already set above
            try {
                if (typeof value === 'bigint') {
                    instance[key] = Number(value);
                } else {
                    instance[key] = value;
                }
            } catch (e) {
                // Property might not exist, skip
            }
        }

        return instance;
    }

    /**
     * Create a model instance from a C++ DynamicObject.
     */
    private dynObjToInstance<T>(modelClass: ModelConstructor<T>, dynObj: any): T {
        return hydrateInstance(modelClass, dynObj, this);
    }

    /**
     * Resolve a link property to its actual object.
     * Use this when you need to access a linked object.
     *
     * @example
     * ```typescript
     * const person = await lattice.find(Person, 1);
     * const dog = await lattice.resolveLink(person.dog);
     * console.log(dog.name);
     * ```
     */
    async resolveLink<T>(link: T | { __linkId: number; __targetModel: ModelConstructor<T> }): Promise<T | null> {
        if (!link) return null;

        // If it's already a resolved object, return it
        if (typeof link === 'object' && '__linkId' in link) {
            const { __linkId, __targetModel } = link as { __linkId: number; __targetModel: ModelConstructor<T> };
            return this.find(__targetModel, __linkId);
        }

        // Already resolved
        return link as T;
    }

    /**
     * Get the model class by table name.
     */
    getModelClass(tableName: string): ModelConstructor | undefined {
        return this.modelMap.get(tableName);
    }

    // ========================================================================
    // Observation / Sync
    // ========================================================================

    /**
     * Observe changes to the database.
     * Callback is called with audit log entries whenever local changes are made.
     *
     * @example
     * ```typescript
     * const unsubscribe = lattice.observe((entries) => {
     *     for (const entry of entries) {
     *         console.log(`${entry.operation} on ${entry.tableName}`);
     *     }
     * });
     *
     * // Later, to stop observing:
     * unsubscribe();
     * ```
     *
     * @returns Unsubscribe function
     */
    observe(callback: (entries: AuditLogEntry[]) => void): () => void {
        console.log('[Lattice.observe] Registering observer...');

        // Wrap the callback to parse JSON from C++
        const wrappedCallback = (json: string) => {
            console.log('[Lattice.observe] Callback invoked with JSON:', json?.substring(0, 200));
            try {
                const rawEntries = JSON.parse(json);
                const entries: AuditLogEntry[] = rawEntries.map((e: any) => this.parseAuditLogEntry(e));
                console.log('[Lattice.observe] Parsed entries:', entries.length);
                callback(entries);
            } catch (e) {
                console.error('[Lattice.observe] Failed to parse audit log:', e);
            }
        };

        // Register observer with C++
        console.log('[Lattice.observe] Calling db.observeAuditLog...');
        const observerId = this.db.observeAuditLog(wrappedCallback);
        console.log('[Lattice.observe] Got observer ID:', observerId);

        // Return unsubscribe function
        return () => {
            this.db.removeAuditLogObserver(observerId);
        };
    }

    /**
     * Parse a raw audit log entry from JSON into typed AuditLogEntry.
     */
    private parseAuditLogEntry(e: any): AuditLogEntry {
        return {
            id: e.id,
            globalId: e.globalId,
            tableName: e.tableName,
            operation: e.operation,
            rowId: e.rowId,
            globalRowId: e.globalRowId,
            changedFields: typeof e.changedFields === 'string'
                ? JSON.parse(e.changedFields)
                : e.changedFields,
            changedFieldsNames: typeof e.changedFieldsNames === 'string'
                ? JSON.parse(e.changedFieldsNames)
                : e.changedFieldsNames,
            timestamp: e.timestamp,
            isFromRemote: e.isFromRemote,
            isSynchronized: e.isSynchronized,
        };
    }

    /**
     * Get pending (unsynced) audit log entries.
     * Used internally for sync.
     */
    private getPendingChanges(): AuditLogEntry[] {
        try {
            const json = this.db.getPendingAuditLog();
            const rawEntries = JSON.parse(json);
            return rawEntries.map((e: any) => this.parseAuditLogEntry(e));
        } catch (e) {
            console.error('[Lattice.getPendingChanges] Failed:', e);
            return [];
        }
    }

    /**
     * Apply remote changes from audit log entries.
     * Used internally to sync changes from other sources.
     */
    private applyRemoteChanges(entries: AuditLogEntry[]): string[] {
        try {
            const json = JSON.stringify(entries);
            const resultJson = this.db.applyRemoteChanges(json);
            return JSON.parse(resultJson);
        } catch (e) {
            console.error('[Lattice.applyRemoteChanges] Failed:', e);
            return [];
        }
    }

    /**
     * Mark audit log entries as synchronized.
     * Used internally after syncing.
     */
    private markEntriesSynced(globalIds: string[]): void {
        try {
            const json = JSON.stringify(globalIds);
            this.db.markEntriesSynced(json);
        } catch (e) {
            console.error('[Lattice.markEntriesSynced] Failed:', e);
        }
    }

    /**
     * Close the database and clean up resources.
     * Unregisters observers and disconnects from SharedWorker.
     */
    async close(): Promise<void> {
        console.log('[Lattice.close] Closing database...');

        // Remove sync observer
        if (this.syncObserverId) {
            this.syncObserverId();
            this.syncObserverId = null;
        }

        // Close broadcast channel
        if (this.broadcastChannel) {
            this.broadcastChannel.close();
            this.broadcastChannel = null;
        }

        // Disconnect from SharedWorker (worker stays alive for other tabs)
        if (this.sharedWorker) {
            this.sharedWorker.port.close();
            this.sharedWorker = null;
            this.workerApi = null;
        }

        console.log('[Lattice.close] Database closed');
    }
}
