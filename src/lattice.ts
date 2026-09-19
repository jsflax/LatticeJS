// Main Lattice class - user-facing API
import type { SchemaEntry, ModelConstructor, LatticeObject, LatticeWasm, LatticeWasmModule, CollectionChange, SyncProgress, SyncFilter, MigrationContext, TableChanges, SyncStateInfo, LatticeCloseOptions, LatticeCloseResult } from './types';
import { buildSchemas, getTableName, isModel, getPropertySchemas, hydrateInstance } from './decorators';
import { setWasmModule, DYNAMIC_OBJECT, PROPERTY_SCHEMA, LATTICE_REF } from './storage';
import { Results } from './results';
import { safeRandomUUID } from './uuid';
import {
    installSyncSocketTracker,
    captureSyncSockets,
    claimSyncSockets,
    closeSyncSockets,
    forgetSyncSockets,
    waitForSyncSocketsClosed,
    InstanceSyncState,
    type TrackedSyncSocket,
} from './sync-socket';
import {
    selectPendingUploads,
    drainPendingUploads,
    waitForCatchUpQuiet,
    emptyDrainReport,
    type PendingUploadRow,
    type PendingSelectOptions,
    type DrainReport,
} from './pending-drain';

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

// NO SharedWorker, NO BroadcastChannel — deliberately.
//
// openPersistent used to construct a SharedWorker unconditionally (and this
// module used to open a `lattice-debug` BroadcastChannel at import time). Both
// are optional platform APIs: they are absent in Safari < 16.4, in iOS
// WKWebView, and in embedded webviews generally. `new SharedWorker(...)` on
// such an engine throws ReferenceError, and it threw OUTSIDE any catch — so
// `Lattice.open()` on a persistent path REJECTED there. Total failure of the
// library on a whole class of engines, in exchange for a worker that did
// nothing: its `init()` was a no-op, its `open()` built a BroadcastChannel
// that was never listened on and never posted to, the page never joined that
// channel, and in production bundles Vite inlined the bootstrap as a `data:`
// URL, from which its relative `import('./shared-impl')` could never resolve.
// There was no cross-tab relay to lose. Cross-tab convergence, where it
// matters, is the SERVER's job: two tabs synced to the same websocket URL
// converge through it.
//
// Do not reintroduce either global without feature-detecting it first.
// Regression coverage: test/no-shared-worker.test.ts.

export enum LogLevel {
    Off = 0,
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
}

// Global WASM module cache
let wasmModule: any = null;
let wasmInitialization: Promise<any> | null = null;

/** How long `resumePendingFrom` waits for the new store's socket to open. */
const RESUME_CONNECT_TIMEOUT_MS = 20000;
/** How long the received counter must hold still before a resume drain runs. */
const RESUME_QUIET_MS = 1200;
/** Floor on the settle wait — socket-open is not catch-up-begun, so a quiet
 *  window that elapses at `received === 0` before the server\'s replay even
 *  starts must not trigger the drain (the ordering inversion). */
const RESUME_MIN_WAIT_MS = 3000;
/** Hard cap on the settle wait — past this the resume drain runs anyway. */
const RESUME_MAX_WAIT_MS = 20000;

/**
 * Main Lattice class for browser-based database operations.
 *
 * WASM runs on the main thread in both modes. `:memory:` databases live only
 * for the page's lifetime; persistent databases are the same MEMFS database
 * snapshotted to OPFS (periodically, on page-lifecycle edges, and at close)
 * and restored from that snapshot on the next open. No worker is involved,
 * so nothing here needs `SharedWorker` — see the note at the top of this file.
 */
export class Lattice {
    private db: LatticeWasm;
    /** Tears down openPersistent's snapshot timer + page-lifecycle listeners. */
    private housekeepingCleanup: (() => void) | null = null;
    /** openPersistent installs this: one last OPFS snapshot at close time,
     *  AFTER timers/listeners are retired and any in-flight save drained,
     *  BEFORE the wasm instance is deleted. Without it, a reopen-loop
     *  consumer (the orbital-server observer redials every ~5s) only ever
     *  persists a lucky early snapshot — every refresh then re-downloads
     *  the world (found live: "BindingError: Cannot pass deleted object"
     *  from the un-retired initial-save timer firing after close). */
    private persistentFinalFlush: (() => Promise<'saved' | 'unavailable' | 'error'>) | null = null;
    /** The sync WebSocket(s) this instance holds — see ./sync-socket. Empty
     *  when sync is not configured. */
    private syncSockets: TrackedSyncSocket[] = [];
    private schemas: SchemaEntry[];
    private modelMap: Map<string, ModelConstructor>;

    private syncObserverId: (() => void) | null = null;
    private closing = false;
    private socketWatchId: number | null = null;
    private readonly stopWaits = new Set<() => void>();
    private closePromise: Promise<LatticeCloseResult> | null = null;
    private nativeCleanupResult: LatticeCloseResult['native'] | null = null;
    private readonly observerDisposers = new Set<() => void>();

    private constructor(
        db: LatticeWasm,
        schemas: SchemaEntry[],
        modelMap: Map<string, ModelConstructor>,
        private readonly syncState: InstanceSyncState,
        private readonly syncConfigured: boolean,
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
     * Load and cache the WASM module (idempotent). Every entry point that
     * touches wasm — open(), setLogLevel(), pendingUploads() — goes through
     * here so a storage-only read can be the FIRST thing a page does.
     */
    private static async ensureWasm(): Promise<any> {
        if (wasmModule) return wasmModule;
        if (!wasmInitialization) {
            wasmInitialization = (async () => {
                const module = await import(/* @vite-ignore */ wasmJsUrl);
                const loaded = await module.default({
                    locateFile: (p: string) => p.endsWith('.wasm') ? wasmBinaryUrl : p,
                });
                setWasmModule(loaded);
                wasmModule = loaded;
                return loaded;
            })().catch(error => { wasmInitialization = null; throw error; });
        }
        return wasmInitialization;
    }

    /**
     * Set the global C++ log level.
     * Loads WASM if not already loaded.
     */
    static async setLogLevel(level: LogLevel) {
        await Lattice.ensureWasm();
        wasmModule._lattice_set_log_level(level);
    }

    /** Construct with exact native transport identity; legacy capture never matches by URL. */
    private static async constructWithSyncSocket(
        syncUrl: string | undefined,
        make: () => LatticeWasm,
        state: InstanceSyncState,
    ): Promise<{ db: LatticeWasm; sockets: TrackedSyncSocket[] }> {
        const modern = typeof wasmModule?.Lattice?.prototype?.getSyncSocket === 'function' &&
            typeof wasmModule?.Lattice?.prototype?.prepareClose === 'function';
        if (syncUrl && !modern) installSyncSocketTracker();
        const { value: db, sockets: captured } = modern ? { value: make(), sockets: [] } : captureSyncSockets(make);
        let sockets: TrackedSyncSocket[] = [];
        try {
            const exact = !syncUrl ? null : typeof db.getSyncSocket === 'function' ? db.getSyncSocket() :
                captured.length === 1 ? captured[0] : null;
            sockets = exact ? [exact] : [];
            claimSyncSockets(sockets);
            state.bind(exact);
            return { db, sockets };
        } catch (error) {
            // A post-construction getter/listener failure must not leak the handle.
            state.fail(); state.retire();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            forgetSyncSockets(sockets);
            try { db.prepareClose?.(); } catch { /* Release is still attempted. */ }
            try { db.releaseStorage?.(); } catch { /* Delete is still attempted. */ }
            try { (db as unknown as { delete?: () => void }).delete?.(); } catch { /* Preserve the original error. */ }
            throw error;
        }
    }

    private startSyncSocketWatch(): void {
        if (!this.syncConfigured || typeof this.db.watchSyncSocket !== 'function') return;
        try {
            this.socketWatchId = this.db.watchSyncSocket(socket => {
                if (this.closing) return;
                if (socket === (this.syncSockets[0] ?? null)) return;
                // A native handoff, not JS lease counts, determines old transport
                // closure. Late watcher delivery cannot close a sibling's socket.
                forgetSyncSockets(this.syncSockets);
                this.syncSockets = socket ? [socket] : [];
                claimSyncSockets(this.syncSockets);
                this.syncState.bind(socket);
            });
        } catch (error) {
            void this.close();
            throw error;
        }
    }

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
            /** Installed before transport construction; events belong to this instance. */
            onSyncState?: (info: SyncStateInfo) => void;
            sync?: {
                websocketUrl: string;
                authToken?: string;
            };
            schemaVersion?: number;
            migration?: (ctx: MigrationContext) => void;
            /**
             * Path of the store this one REPLACES — the previous name in the
             * "redial under a fresh store name" pattern.
             *
             * Writes that landed in that store after its sync socket died are
             * stranded there: the server never got them, so this store's
             * catch-up does not contain them, and nothing else ever revisits
             * that store. With this option set, once THIS store's socket is
             * open and its catch-up has gone quiet, those rows are re-offered
             * here and upload on the live socket — equivalent to calling
             * `drainPendingFrom(previousPath)` by hand at the right moment.
             *
             * Requires `sync` (a store with no transport can ship nothing).
             * Never blocks `open()`. Idempotent: rows this store already has
             * are skipped, so passing the same previous path on every open is
             * safe. See ./pending-drain.
             */
            resumePendingFrom?: string;
            /** Result of the `resumePendingFrom` drain, when it runs. */
            onResumePending?: (report: DrainReport) => void;
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

        const state = new InstanceSyncState(safeRandomUUID(), !!options?.sync?.websocketUrl);
        if (options?.onSyncState) state.subscribe(options.onSyncState);
        try {
            // Load WASM module if not already loaded (needed for main thread)
            await Lattice.ensureWasm();

            const isInMemory = path === ':memory:' || path.startsWith(':memory:');
            const syncConfig = options?.sync;
            const schemaVersion = options?.schemaVersion;
            const migrationFn = options?.migration;
            let lattice: Lattice;

            if (isInMemory) {
                // In-memory: just use main thread
                console.log('[Lattice] Creating in-memory database');
                const makeDb = (): LatticeWasm => {
                    if (schemaVersion && migrationFn) {
                        // Migration-aware constructor
                        const jsMigrationCallback = (ctx: any) => {
                            const migrationCtx: MigrationContext = {
                                pendingChanges: () => ctx.pendingChanges as TableChanges[],
                                hasChangesFor: (tableName: string) => {
                                    return (ctx.pendingChanges as TableChanges[]).some(
                                        (c: TableChanges) => c.tableName === tableName &&
                                            (c.addedColumns.length > 0 || c.removedColumns.length > 0 || c.changedColumns.length > 0)
                                    );
                                },
                                renameProperty: (tableName: string, oldName: string, newName: string) => {
                                    // Call C++ via the context pointer
                                    wasmModule._migration_rename_property(ctx._ctx_ptr, tableName, oldName, newName);
                                },
                                deleteAll: (tableName: string) => {
                                    wasmModule._migration_delete_all(ctx._ctx_ptr, tableName);
                                },
                                executeSql: (sql: string) => {
                                    wasmModule._migration_execute_sql(ctx._ctx_ptr, sql);
                                },
                                enumerateObjects: () => {
                                    // Complex operation — not exposed in initial version
                                    console.warn('enumerateObjects not yet supported in WASM migrations');
                                },
                            };
                            migrationFn(migrationCtx);
                        };
                        return new wasmModule.Lattice(
                            path, schemas,
                            syncConfig?.websocketUrl || '', syncConfig?.authToken || '',
                            schemaVersion, jsMigrationCallback
                        );
                    } else if (syncConfig?.websocketUrl) {
                        console.log('[Lattice] Sync enabled:', syncConfig.websocketUrl);
                        return new wasmModule.Lattice(path, schemas, syncConfig.websocketUrl, syncConfig.authToken || '');
                    } else {
                        return new wasmModule.Lattice(path, schemas);
                    }
                };
                const { db, sockets } = await Lattice.constructWithSyncSocket(syncConfig?.websocketUrl, makeDb, state);
                lattice = new Lattice(db, schemas, modelMap, state, !!syncConfig?.websocketUrl);
                lattice.syncSockets = sockets;
                lattice.startSyncSocketWatch();
            } else {
                // Persistent: same main-thread wasm, snapshotted to and restored
                // from OPFS. See openPersistent.
                lattice = await Lattice.openPersistent(path, schemas, modelMap, state, syncConfig);
            }

            // Rescue whatever the store this one replaces never managed to upload.
            // Scheduled, never awaited: open() must not wait on a handshake.
            if (options?.resumePendingFrom) {
                lattice.scheduleResumeDrain(
                    options.resumePendingFrom,
                    !!syncConfig?.websocketUrl,
                    options.onResumePending,
                );
            }
            return lattice;
        } catch (error) {
            state.fail(); state.retire();
            throw error;
        }
    }

    /**
     * Open a persistent database.
     *
     * Architecture:
     * - Main thread opens named database (MEMFS) with sync — owns the data + WebSocket
     * - On startup, restore from OPFS snapshot for fast reload (delta sync only)
     * - Periodically save snapshots to OPFS (async API), plus on page-lifecycle
     *   edges and at close()
     *
     * Uses no worker of any kind: everything here runs on the main thread, so
     * an engine without `SharedWorker` (Safari < 16.4, iOS WKWebView, embedded
     * webviews) opens a persistent database exactly like any other.
     */
    private static async openPersistent(
        path: string,
        schemas: SchemaEntry[],
        modelMap: Map<string, ModelConstructor>,
        state: InstanceSyncState,
        syncConfig?: { websocketUrl: string; authToken?: string }
    ): Promise<Lattice> {
        console.log('[Lattice] Opening persistent database:', path);

        // Try to restore from OPFS snapshot before opening
        const restored = await Lattice.restoreSnapshot(path);
        if (restored) {
            console.log('[Lattice] Restored snapshot from OPFS');
        }

        // Open with named path (MEMFS) + sync
        const { db, sockets } = await Lattice.constructWithSyncSocket(syncConfig?.websocketUrl, () => {
            if (syncConfig?.websocketUrl) {
                console.log('[Lattice] Sync enabled:', syncConfig.websocketUrl);
                return new wasmModule.Lattice(path, schemas, syncConfig.websocketUrl, syncConfig.authToken || '');
            }
            return new wasmModule.Lattice(path, schemas);
        }, state);
        const lattice = new Lattice(db, schemas, modelMap, state, !!syncConfig?.websocketUrl);
        lattice.syncSockets = sockets;
        try {
            lattice.startSyncSocketWatch();

            // Set up periodic OPFS snapshot saves (every 15s when dirty)
            let snapshotDirty = false;
            let snapshotInFlight = false;
            let initialSaveTimer: ReturnType<typeof setTimeout> | null = null;
            const flushSnapshot = async () => {
                if (!snapshotDirty || snapshotInFlight) return;
                snapshotInFlight = true;
                snapshotDirty = false;
                try {
                    const outcome = await Lattice.saveSnapshot(path, db);
                    if (outcome === 'error') snapshotDirty = true;
                } catch (err) {
                    // A failed save must re-arm — otherwise this dirty window is
                    // silently lost until the NEXT write, and a tab closed in
                    // between re-downloads everything.
                    snapshotDirty = true;
                    console.warn('[Lattice] OPFS snapshot save failed:', err);
                } finally {
                    snapshotInFlight = false;
                }
            };
            const snapshotTimer = setInterval(flushSnapshot, 15000);

            // The 15s timer alone loses up to 15s of applied entries when the
            // tab closes — including the resume cursor they carry, so the next
            // load re-downloads everything since the last lucky tick. Flush on
            // the page-lifecycle edges instead of hoping the timer fired:
            // pagehide is the last reliable signal on close/navigate, and
            // visibilitychange→hidden covers tab-switch-then-kill (mobile
            // Safari never fires pagehide in that order). Best-effort — the
            // async OPFS write gets a head start it wouldn't otherwise have,
            // and a write the teardown truncates is SAFE: createWritable() is
            // swap-on-close, so until close() succeeds the previous snapshot
            // remains untouched. Worst case is the old behavior (stale
            // snapshot, larger delta), never a corrupt one.
            const onVisibility = () => {
                if (document.visibilityState === 'hidden') void flushSnapshot();
            };
            const onPagehide = () => { void flushSnapshot(); };

            // close() must be able to retire all of this — reopen loops (the
            // embed's reconnect controller) would otherwise accumulate a timer,
            // two listeners, and a live wasm sqlite handle per cycle. NOTE the
            // initial-save timer is retired here too: it holds `db` in its
            // closure, and firing after close() deleted the wasm object was the
            // observed "Cannot pass deleted object as a pointer" failure that
            // silently killed OPFS persistence for reopen-loop consumers.
            lattice.housekeepingCleanup = () => {
                clearInterval(snapshotTimer);
                if (initialSaveTimer) { clearTimeout(initialSaveTimer); initialSaveTimer = null; }
                if (typeof document !== 'undefined') {
                    document.removeEventListener('visibilitychange', onVisibility);
                }
                if (typeof window !== 'undefined') {
                    window.removeEventListener('pagehide', onPagehide);
                }
            };
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', onVisibility);
            }
            if (typeof window !== 'undefined') {
                window.addEventListener('pagehide', onPagehide);
            }
            // The close-time snapshot is the MOST valuable one — it carries the
            // resume cursor of everything this session applied. Drain any
            // in-flight save first (two concurrent createWritable() streams on
            // one snapshot file would race), then take one final snapshot.
            lattice.persistentFinalFlush = async () => {
                while (snapshotInFlight) await new Promise((r) => setTimeout(r, 25));
                return Lattice.saveSnapshot(path, db);
            };

            // Mark dirty when data changes (for snapshot saves)
            for (const [, model] of modelMap) {
                lattice.observeTable(model, () => { snapshotDirty = true; });
            }

            // Save initial snapshot after first sync batch completes
            // (triggers after the first burst of observer callbacks settles)
            const scheduleInitialSave = () => {
                if (initialSaveTimer) clearTimeout(initialSaveTimer);
                initialSaveTimer = setTimeout(async () => {
                    initialSaveTimer = null;
                    snapshotDirty = true;
                    await flushSnapshot();
                }, 5000);
            };
            // The observeTable callbacks will fire as sync data arrives
            for (const [, model] of modelMap) {
                lattice.observeTable(model, () => {
                    if (initialSaveTimer !== null || !restored) {
                        // Still in initial sync phase — schedule save
                        scheduleInitialSave();
                    }
                });
            }

            console.log('[Lattice] Persistent database ready');
            return lattice;
        } catch (error) {
            state.fail();
            await lattice.close();
            throw error;
        }
    }

    /**
     * Save database snapshot to OPFS (async API, works on main thread).
     */
    private static async saveSnapshot(path: string, db: LatticeWasm): Promise<'saved' | 'unavailable' | 'error'> {
        try {
            if (typeof navigator === 'undefined' || !navigator?.storage?.getDirectory) return 'unavailable';
            // A deleted wasm object throws BindingError on ANY method call —
            // a save that lost the race with close() must be a no-op, not a
            // dirty-window-eating failure.
            if ((db as unknown as { isDeleted?: () => boolean }).isDeleted?.()) return 'error';

            // Flush WAL into main database file
            db.walCheckpoint();

            // Read from Emscripten MEMFS
            const data: Uint8Array = wasmModule.FS.readFile(path);
            if (data.length === 0) return 'unavailable';

            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('lattice-snapshots', { create: true });
            const safeName = path.replace(/[^a-z0-9._-]/gi, '_');
            const fileHandle = await dir.getFileHandle(safeName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(data.buffer as ArrayBuffer);
            await writable.close();

            console.log(`[Lattice] Snapshot saved: ${data.length} bytes`);
            return 'saved';
        } catch (e) {
            console.warn('[Lattice] Snapshot save failed:', e);
            return 'error';
        }
    }

    /**
     * Restore database snapshot from OPFS into Emscripten MEMFS.
     */
    private static async restoreSnapshot(path: string): Promise<boolean> {
        try {
            if (!navigator?.storage?.getDirectory) return false;

            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('lattice-snapshots', { create: false });
            const safeName = path.replace(/[^a-z0-9._-]/gi, '_');
            const fileHandle = await dir.getFileHandle(safeName, { create: false });
            const file = await fileHandle.getFile();
            const data = new Uint8Array(await file.arrayBuffer());

            if (data.length === 0) return false;

            // Write to Emscripten MEMFS so SQLite finds it when opening
            wasmModule.FS.writeFile(path, data);
            console.log(`[Lattice] Snapshot restored: ${data.length} bytes`);
            return true;
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Orphaned-write drain
    //
    // A write accepted between the sync socket's death and the app noticing is
    // journalled into that store's AuditLog with isSynchronized = 0 and never
    // ships: browser builds do not redial (`schedule_reconnect()` is
    // `#ifdef __EMSCRIPTEN__ return;`), close() cannot drain a dead socket, and
    // the app's recovery — reopen under a FRESH store name — starts from an
    // empty store whose catch-up cannot contain writes the server never saw.
    // These two entry points make that set readable and re-deliverable from JS.
    // Full derivation, and the three layers of idempotency, in ./pending-drain.
    // ========================================================================

    /**
     * Open `path` READ-ONLY (the arity-3 audit constructor — no DDL, no
     * heal, no change hook, no socket, no cache entry) and read the writes it
     * still owes upstream via the unshipped predicate (unsynced AND unmarked
     * in `_lattice_sync_state`, so downloaded rows are excluded). Nothing is
     * mutated and the connection is really closed afterwards. Safe to call
     * before any other Lattice is open — it loads the wasm module itself.
     *
     * @param path   the ABANDONED store's path (the previous name in a redial)
     * @param models retained for API compatibility; the audit open
     *               reconstructs the schema from the file and never migrates
     * @returns un-ACKed rows, oldest first, as plain JSON (see
     *          PendingUploadRow) — or **null when no store exists at `path`**
     *          (never created, snapshot gone, or a wrong name), which is NOT
     *          the same as an empty pending set. Journal them, count them,
     *          show them — or hand `path` to {@link drainPendingFrom} to
     *          actually re-deliver them.
     */
    static async pendingUploads(
        path: string,
        models: ModelConstructor[],
        options?: PendingSelectOptions,
    ): Promise<PendingUploadRow[] | null> {
        await Lattice.ensureWasm();
        return Lattice.readPendingAt(path, options);
    }

    /**
     * Re-offer everything `previousPath` never managed to upload through THIS
     * (live, synced) instance, so it uploads here.
     *
     * Each rescued row is replayed into this store and re-journalled with
     * `isSynchronized = 0`, which is what the uploader picks up; the AuditLog
     * INSERT itself wakes the synchronizer. Rows land at the tail of this
     * store's log — after everything already caught up — which is the intended
     * order: the server's replay is authoritative for what it knows, the
     * rescued write is a later edit on top of it.
     *
     * Idempotent at three levels (this method's own globalId check, the
     * value-guarded upsert the apply generates, and the server's dedupe), so
     * re-draining an already-delivered store is a no-op, not a duplicate.
     *
     * Call it AFTER this instance's sync is connected and caught up — or let
     * `resumePendingFrom` do exactly that for you.
     *
     * @param previousPath the abandoned store. Must not be this store's path.
     */
    async drainPendingFrom(previousPath: string, options?: PendingSelectOptions): Promise<DrainReport> {
        this.assertOpen();
        const report = emptyDrainReport();
        if (!previousPath) return report;
        if (previousPath === this.getPath()) {
            // Not an error, but never useful: every row's globalId is already
            // in this store's log, so the drain would report nothing but
            // alreadyPresent. Say so instead of doing a pointless full pass.
            console.warn('[Lattice] drainPendingFrom: previous path is this store — nothing to drain');
            return report;
        }
        if (this.syncSockets.length === 0) {
            // The rows would land here as pending and stay pending: nothing
            // would ship them, and the app would have to drain THIS store next.
            console.warn(
                '[Lattice] drainPendingFrom: this instance has no sync socket —',
                'draining would only move the orphans, not deliver them',
            );
        }

        await Lattice.ensureWasm();
        const rows = await Lattice.readPendingAt(previousPath, options);
        this.assertOpen();
        if (rows === null) {
            // A missing store is NOT an empty one: the caller named a path
            // that has nothing behind it (wrong name, or the snapshot is
            // gone). Say so in the report instead of a zero that reads as
            // "nothing was stranded".
            console.warn('[Lattice] drainPendingFrom: no store exists at', previousPath);
            report.sourceMissing = true;
            return report;
        }
        if (rows.length === 0) return report;

        const drained = await drainPendingUploads({
            getPendingAuditLog: () => { this.assertOpen(); return this.db.getPendingAuditLog(); },
            applyRemoteChanges: json => { this.assertOpen(); return this.db.applyRemoteChanges(json); },
        }, rows, {
            ...options,
            tables: this.schemas.map((s) => s.tableName),
            sleep: ms => this.sleepWhileOpen(ms),
        });
        console.log(
            `[Lattice] drained ${drained.applied.length}/${drained.found} pending row(s) from ${previousPath}` +
            ` (already present: ${drained.alreadyPresent}, unknown table: ${drained.unknownTable}` +
            `, failed: ${drained.failed.length})`
        );
        return drained;
    }

    /**
     * Open `path` storage-only, read its pending set, and let the handle go.
     *
     * OPFS RESTORE RULE: after a page reload the abandoned store exists only as
     * an OPFS snapshot, so it has to be restored into MEMFS before sqlite can
     * see it — but if the MEMFS file is already there (same page session, the
     * store was open a moment ago) restoring would overwrite the file a live
     * sqlite handle may still hold open. So: restore only when MEMFS has
     * nothing.
     */
    private static async readPendingAt(
        path: string,
        options?: PendingSelectOptions,
    ): Promise<PendingUploadRow[] | null> {
        let memfsHasIt = false;
        try {
            memfsHasIt = !!wasmModule.FS?.analyzePath?.(path)?.exists;
        } catch { /* no FS shim — treat as absent and let the restore decide */ }
        if (!memfsHasIt) {
            const restored = await Lattice.restoreSnapshot(path);
            if (!restored) {
                // MISSING, not empty — null so the caller can tell the two
                // apart (a wrong path must not read as "nothing stranded").
                return null;
            }
        }

        let db: LatticeWasm | null = null;
        try {
            // READ-ONLY AUDIT OPEN (arity-3 constructor): no DDL, no
            // heal_collapsed_sync_state, no change hook, no socket, no
            // key-cache entry — reading an abandoned store mutates nothing
            // and can never alias a later writable open. The schema is
            // reconstructed from the file, so no drift can migrate it.
            db = new wasmModule.Lattice(path, [], true) as LatticeWasm;
        } catch (err) {
            // The read-only open of an existing MEMFS file failing means the
            // file is not a database this build can read — surface as
            // missing/unreadable rather than an empty pending set.
            console.warn('[Lattice] could not open store read-only at', path, err);
            return null;
        }
        try {
            // The unshipped set (owed upstream) — see types.ts; the JS-side
            // select is the belt (order, dedupe, isSynchronized).
            return selectPendingUploads(db.getUnshippedAuditLog(), options);
        } catch (err) {
            console.warn('[Lattice] reading pending uploads failed for', path, err);
            return [];
        } finally {
            // releaseStorage() drops the audit open\'s ONLY reference — the
            // sqlite connection actually closes (embind .delete() alone frees
            // just the wrapper and leaked one connection per abandoned store).
            try { db.releaseStorage?.(); } catch { /* already gone */ }
            try {
                (db as unknown as { delete?: () => void } | null)?.delete?.();
            } catch { /* already gone */ }
        }
    }

    /**
     * `resumePendingFrom`'s timing: wait for THIS store's socket to open, wait
     * for its catch-up to go quiet, then drain. Fire-and-forget by design —
     * open() returns immediately and the rescue happens when it can.
     */
    private scheduleResumeDrain(
        previousPath: string,
        synced: boolean,
        onReport?: (report: DrainReport) => void,
    ): void {
        if (!synced) {
            console.warn(
                '[Lattice] resumePendingFrom ignored: this store has no sync config,',
                'so rescued writes would have no transport to ship them.',
            );
            return;
        }
        void (async () => {
            try {
                const opened = await this.waitForSyncOpen(RESUME_CONNECT_TIMEOUT_MS);
                if (this.closing) return;
                if (!opened) {
                    // Draining now would relocate the orphans into a store that
                    // also cannot ship them. Leave them where they are so the
                    // next open can still name the ORIGINAL path.
                    console.warn(
                        '[Lattice] resumePendingFrom: sync never connected —',
                        `leaving pending writes in ${previousPath} for a later open`,
                    );
                    return;
                }
                await waitForCatchUpQuiet(() => this.getSyncProgress()?.received ?? 0, {
                    quietMs: RESUME_QUIET_MS,
                    minWaitMs: RESUME_MIN_WAIT_MS,
                    maxWaitMs: RESUME_MAX_WAIT_MS,
                    sleep: ms => this.sleepWhileOpen(ms),
                });
                if (this.closing) return;
                const report = await this.drainPendingFrom(previousPath);
                if (!this.closing) onReport?.(report);
            } catch (err) {
                if (!this.closing) console.warn('[Lattice] resumePendingFrom drain failed:', err);
            }
        })();
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
        this.db.addObject(tableName, dynObj);

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
            options?.offset ?? null,
            null,
            null
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
     * Add multiple model instances in a single transaction.
     * Much faster than calling add() in a loop.
     *
     * @returns The instances with id and globalId populated.
     */
    async addAll<T extends LatticeObject>(instances: T[]): Promise<T[]> {
        if (instances.length === 0) return [];

        const modelClass = instances[0].constructor as ModelConstructor;
        if (!isModel(modelClass)) {
            throw new Error(`${modelClass.name} is not a @model`);
        }

        const tableName = getTableName(modelClass);

        // Build array of plain objects from dynamic objects
        const jsArray: Record<string, any>[] = [];
        for (const instance of instances) {
            const dynObj = (instance as any)[DYNAMIC_OBJECT];
            if (!dynObj || !dynObj.isValid()) {
                throw new Error(`${modelClass.name} has no C++ backing`);
            }
            jsArray.push(dynObj);
        }

        // Use bulk insert
        const results = this.db.addBulk(tableName, jsArray);

        // Populate ids on instances
        for (let i = 0; i < instances.length; i++) {
            (instances[i] as any)[LATTICE_REF] = this;
        }

        return instances;
    }

    // ========================================================================
    // Fine-grained Observation
    // ========================================================================

    /**
     * Observe changes to a specific table.
     * Callback fires for every INSERT, UPDATE, DELETE on the table.
     *
     * @returns Unsubscribe function
     */
    observeTable<T>(
        modelClass: ModelConstructor<T>,
        callback: (change: CollectionChange) => void
    ): () => void {
        const tableName = getTableName(modelClass);
        return this.observeWhileOpen(active => {
            const observerId = this.db.observeTable(tableName, change => { if (active()) callback(change); });
            return () => this.db.removeTableObserver(tableName, observerId);
        });
    }

    /**
     * Observe changes to a specific object instance.
     * Callback fires with the names of changed fields.
     *
     * @returns Unsubscribe function
     */
    observeObject<T>(
        modelClass: ModelConstructor<T>,
        instance: T,
        callback: (changedFieldNames: string[]) => void
    ): () => void {
        const tableName = getTableName(modelClass);
        const id = (instance as any).id;
        if (!id) throw new Error('Cannot observe object without an id');

        return this.observeWhileOpen(active => {
            const observerId = this.db.observeObject(tableName, id, (changedFields: string) => {
                if (active()) callback(changedFields.split(',').filter(s => s.length > 0));
            });
            return () => this.db.removeObjectObserver(tableName, id, observerId);
        });
    }

    // ========================================================================
    // Sync Progress / Filters / Compaction
    // ========================================================================

    /**
     * Get current sync progress.
     */
    getSyncProgress(): SyncProgress {
        return this.db.getSyncProgress();
    }

    /** Subscribe to this instance and immediately replay its current state.
     * The idempotent disposer removes only this registration. Null clears only
     * this instance's listeners; close retires all before any asynchronous work.
     */
    onSyncState(callback: ((info: SyncStateInfo) => void) | null): () => void {
        return this.syncState.subscribe(callback);
    }

    /** Observe sync progress with an idempotent disposer. Legacy WASM only retires JS delivery. */
    onSyncProgress(callback: (progress: SyncProgress) => void): () => void {
        return this.observeWhileOpen(active => {
            const observerId = this.db.onSyncProgress(progress => { if (active()) callback(progress); });
            // A legacy binding can retire delivery only. New bindings remove
            // the native registration as well, including on a shared owner.
            return () => this.db.removeSyncProgress?.(observerId);
        });
    }

    /**
     * Update sync filter — only specified tables (and optional where clauses) will sync.
     */
    updateSyncFilter(filters: SyncFilter[]): void {
        this.db.updateSyncFilter(JSON.stringify(filters));
    }

    /**
     * Clear all sync filters (sync everything).
     */
    clearSyncFilter(): void {
        this.db.clearSyncFilter();
    }

    /**
     * Force compact the audit log (removes synced entries).
     */
    compactAuditLog(): void {
        this.db.compactAuditLog();
    }

    /**
     * Safely compact stale audit log entries.
     * @param staleSeconds - Only compact entries older than this many seconds
     */
    safeCompactAuditLog(staleSeconds: number): void {
        this.db.safeCompactAuditLog(staleSeconds);
    }

    /**
     * Generate history from current database state.
     */
    generateHistory(): void {
        this.db.generateHistory();
    }

    /**
     * Execute a write transaction.
     */
    async write<T>(fn: () => Promise<T>): Promise<T> {
        this.assertOpen();
        this.db.beginWrite();
        try {
            const result = await fn();
            this.assertOpen();
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
        // MANAGED hydration first: a query row with an id gets the REAL
        // C++-backed object (same path as find()), so property setters write
        // through to the row (audit triggers → sync history) and LinkLists
        // have live backing. The copy-into-unmanaged fallback below made
        // every query result a DETACHED facsimile — edits and list pushes
        // were silently local-only, and synced link lists read empty
        // (found by JoyJet's browser sync.spec).
        if (data.id !== undefined) {
            const numId = typeof data.id === 'bigint' ? Number(data.id) : data.id as number;
            try {
                const managed = this.db.findObject(getTableName(modelClass), numId);
                if (managed && managed.isValid()) {
                    return hydrateInstance(modelClass, managed, this);
                }
            } catch { /* fall through to detached copy */ }
        }
        // Detached fallback (no id — e.g. raw data rows).
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
        return this.observeWhileOpen(active => {
            const observerId = this.db.observeAuditLog((json: string) => {
                if (!active()) return;
                try {
                    const rawEntries = JSON.parse(json);
                    const entries: AuditLogEntry[] = rawEntries.map((e: any) => this.parseAuditLogEntry(e));
                    if (active()) callback(entries);
                } catch (error) { console.error('[Lattice.observe] Failed to parse audit log:', error); }
            });
            return () => this.db.removeAuditLogObserver(observerId);
        });
    }

    private observeWhileOpen(register: (active: () => boolean) => () => void): () => void {
        if (this.closing) throw new Error('Lattice is closing.');
        let active = true;
        let remove = () => {};
        const dispose = () => {
            if (!active) return;
            active = false;
            this.observerDisposers.delete(dispose);
            remove();
        };
        this.observerDisposers.add(dispose);
        try { remove = register(() => active && !this.closing); }
        catch (error) { active = false; this.observerDisposers.delete(dispose); throw error; }
        return dispose;
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
     * Retire callbacks immediately, then close with cooperative bounded waits.
     * Upload drain is opt-in. A timed-out persistent save retains native storage
     * until the save settles; it never reports native cleanup as complete.
     */
    close(options: LatticeCloseOptions = {}): Promise<LatticeCloseResult> {
        if (this.closePromise) return this.closePromise;
        const timeout = (value: number | undefined, fallback: number): number => {
            const result = value ?? fallback;
            if (!Number.isFinite(result) || result < 0 || result > 30000) {
                throw new RangeError('Close timeouts must be finite milliseconds between 0 and 30000.');
            }
            return result;
        };
        const uploadMs = timeout(options.uploadTimeoutMs, 0);
        const transportMs = timeout(options.transportTimeoutMs, 2000);
        const snapshotMs = timeout(options.snapshotTimeoutMs, 2000);
        this.closing = true;
        this.syncState.retire();
        for (const stop of [...this.stopWaits]) stop();
        this.housekeepingCleanup?.();
        this.housekeepingCleanup = null;
        this.closePromise = (async () => {
            // A lifecycle/row callback can call close while C++ is still on the
            // stack. Destruction and native unsubscription start on a later task.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            if (this.socketWatchId !== null) {
                try { this.db.unwatchSyncSocket?.(this.socketWatchId); } catch { /* Native release also retires watchers. */ }
                this.socketWatchId = null;
            }
            for (const dispose of [...this.observerDisposers]) {
                try { dispose(); } catch { /* Native release still must run. */ }
            }
            this.syncObserverId?.(); this.syncObserverId = null;
            const uploads = await this.finishUploads(uploadMs);
            // Fetch again because the native watcher may have a queued handoff.
            // Modern native ownership alone authorizes disconnect of shared stores.
            let sockets = this.syncSockets;
            let transport: Promise<LatticeCloseResult['transport']>;
            if (this.hasNativeLifecycle() && this.db.prepareClose) {
                try {
                    const socket = this.db.getSyncSocket!();
                    sockets = socket ? [socket] : [];
                    const disposition = this.db.prepareClose();
                    transport = !this.syncConfigured ? Promise.resolve('not-configured') :
                        disposition === 'shared' ? Promise.resolve('shared') : waitForSyncSocketsClosed(sockets, transportMs);
                } catch { transport = Promise.resolve('unavailable'); }
                forgetSyncSockets(this.syncSockets);
            } else {
                transport = this.syncConfigured ? closeSyncSockets(sockets, wasmModule, transportMs) :
                    Promise.resolve('not-configured');
            }
            this.syncSockets = [];
            let snapshot: LatticeCloseResult['snapshot'] = 'not-persistent';
            let native: LatticeCloseResult['native'];
            const flush = this.persistentFinalFlush; this.persistentFinalFlush = null;
            if (flush) {
                const saving = Promise.resolve().then(flush).catch(() => 'error' as const);
                const settled = await within(saving, snapshotMs);
                if (settled.completed) {
                    snapshot = settled.value;
                    native = this.releaseNativeStorage();
                } else {
                    snapshot = 'timeout'; native = 'pending';
                    // The outstanding save can still touch db. Retain it until
                    // settlement and keep the initial result explicitly pending.
                    void saving.then(() => this.releaseNativeStorage());
                }
            } else native = this.releaseNativeStorage();
            return Object.freeze({ native, transport: await transport, uploads, snapshot });
        })();
        return this.closePromise;
    }

    private assertOpen(): void {
        if (this.closing) throw new Error('Lattice is closing or closed.');
    }

    /** Includes a native transport created after open, without polling other stores. */
    private waitForSyncOpen(timeoutMs: number): Promise<boolean> {
        return new Promise(resolve => {
            if (this.closing) { resolve(false); return; }
            let settled = false;
            let off = () => {};
            const finish = (opened: boolean) => {
                if (settled) return;
                settled = true; clearTimeout(timer); this.stopWaits.delete(stop); off(); resolve(opened);
            };
            const stop = () => finish(false);
            const timer = setTimeout(stop, timeoutMs);
            this.stopWaits.add(stop);
            off = this.syncState.subscribeInternal(info => { if (info.state === 'open') finish(true); });
            if (settled) off(); // Immediate current-state replay may finish inside subscribe.
        });
    }

    private sleepWhileOpen(ms: number): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.closing) { reject(new Error('Lattice is closing or closed.')); return; }
            const stop = () => {
                clearTimeout(timer); this.stopWaits.delete(stop);
                reject(new Error('Lattice is closing or closed.'));
            };
            const timer = setTimeout(() => { this.stopWaits.delete(stop); resolve(); }, ms);
            this.stopWaits.add(stop);
        });
    }

    private hasNativeLifecycle(): boolean {
        return typeof this.db.getSyncSocket === 'function' &&
            typeof this.db.requestSyncUpload === 'function' &&
            typeof this.db.getPendingSyncUploadCount === 'function' &&
            typeof this.db.prepareClose === 'function';
    }

    private async finishUploads(timeoutMs: number): Promise<LatticeCloseResult['uploads']> {
        if (timeoutMs === 0) return 'not-requested';
        if (!this.syncConfigured || !this.db.getPendingSyncUploadCount || !this.db.requestSyncUpload) return 'unavailable';
        const deadline = performance.now() + timeoutMs;
        try {
            this.db.requestSyncUpload();
            for (;;) {
                const pending = this.db.getPendingSyncUploadCount();
                if (!Number.isSafeInteger(pending) || pending < 0) return 'unavailable';
                if (pending === 0) return 'drained';
                const remaining = deadline - performance.now();
                if (remaining <= 0) return 'timeout';
                await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
            }
        } catch { return 'unavailable'; }
    }

    private releaseNativeStorage(): LatticeCloseResult['native'] {
        if (this.nativeCleanupResult) return this.nativeCleanupResult;
        let native: LatticeCloseResult['native'] = 'unsupported';
        try {
            if (this.db.releaseStorage) {
                const supported = this.hasNativeLifecycle();
                const result = this.db.releaseStorage();
                native = !supported ? 'unsupported' : result === 'pending' ? 'pending' :
                    result === 'closed' || result === 'already-released' ? 'closed' :
                    result === 'shared' ? 'shared' : result === undefined ? 'unsupported' : 'error';
            }
        } catch { native = 'error'; }
        try {
            (this.db as unknown as { delete?: () => void }).delete?.();
        } catch { native = 'error'; }
        this.nativeCleanupResult = native;
        return native;
    }
}

/** A timeout does not cancel the underlying work or claim that it completed. */
function within<T>(operation: Promise<T>, timeoutMs: number): Promise<
    { completed: true; value: T } | { completed: false }
> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
        operation.then(value => { clearTimeout(timer); resolve({ completed: true, value }); },
            error => { clearTimeout(timer); reject(error); });
    });
}
