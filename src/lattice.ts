// Main Lattice class - user-facing API
import type { SchemaEntry, ModelConstructor, LatticeObject, LatticeWasm, LatticeWasmModule, CollectionChange, SyncProgress, SyncFilter, MigrationContext, TableChanges } from './types';
import { buildSchemas, getTableName, isModel, getPropertySchemas, hydrateInstance } from './decorators';
import { setWasmModule, DYNAMIC_OBJECT, PROPERTY_SCHEMA, LATTICE_REF } from './storage';
import { Results } from './results';
import { safeRandomUUID } from './uuid';
import {
    installSyncSocketTracker,
    captureSyncSockets,
    adoptSyncSocket,
    claimSyncSockets,
    releaseSyncSockets,
    whenSyncSocketOpen,
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
    private persistentFinalFlush: (() => Promise<void>) | null = null;
    /** The sync WebSocket(s) this instance holds — see ./sync-socket. Empty
     *  when sync is not configured. */
    private syncSockets: TrackedSyncSocket[] = [];
    private schemas: SchemaEntry[];
    private modelMap: Map<string, ModelConstructor>;

    private syncObserverId: (() => void) | null = null;
    private instanceId: string = safeRandomUUID();

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
     * Load and cache the WASM module (idempotent). Every entry point that
     * touches wasm — open(), setLogLevel(), pendingUploads() — goes through
     * here so a storage-only read can be the FIRST thing a page does.
     */
    private static async ensureWasm(): Promise<any> {
        if (!wasmModule) {
            const module = await import(/* @vite-ignore */ wasmJsUrl);
            wasmModule = await module.default({
                locateFile: (p: string) => {
                    if (p.endsWith('.wasm')) return wasmBinaryUrl;
                    return p;
                }
            });
            // Make WASM available for model instances
            setWasmModule(wasmModule);
        }
        return wasmModule;
    }

    /**
     * Set the global C++ log level.
     * Loads WASM if not already loaded.
     */
    static async setLogLevel(level: LogLevel) {
        await Lattice.ensureWasm();
        wasmModule._lattice_set_log_level(level);
    }

    /**
     * Build the wasm instance and take ownership of whatever sync socket it
     * opened.
     *
     * The socket is created wasm-side, synchronously inside the C++
     * constructor (`setup_sync_if_configured` -> `synchronizer::connect` ->
     * `new WebSocket(...)` through `val::global`), so the capture window
     * around `make()` attributes it exactly. Two outcomes are both normal:
     *
     * - one socket captured: this instance built a fresh `swift_lattice` and
     *   owns its transport;
     * - none captured: `LatticeCache::get_or_create` returned a CACHED
     *   `swift_lattice` for this path+url+schema, so this instance inherits a
     *   sibling's live transport. Adopt it under refcount — closing it when
     *   only one of the two holders goes away would cut sync out from under
     *   the other.
     *
     * @see ./sync-socket for why close() has to do this from JS at all.
     */
    private static constructWithSyncSocket(
        syncUrl: string | undefined,
        make: () => LatticeWasm
    ): { db: LatticeWasm; sockets: TrackedSyncSocket[] } {
        if (!syncUrl) return { db: make(), sockets: [] };

        installSyncSocketTracker();
        const { value: db, sockets } = captureSyncSockets(make);

        let owned = sockets;
        if (owned.length === 0) {
            const inherited = adoptSyncSocket(syncUrl);
            if (inherited) {
                owned = [inherited];
            } else {
                // No new socket and nothing live to inherit. Either the wasm
                // reused a cached instance whose transport a previous close()
                // already tore down (it cannot redial — schedule_reconnect is
                // compiled out on Emscripten), or the tracker was installed
                // too late. Both are silent-no-sync states, so say so.
                console.warn(
                    '[Lattice] sync configured but no live sync socket for',
                    syncUrl,
                    '— this open reused a wasm instance with no usable transport;',
                    'reload the page to redial.'
                );
            }
        }
        claimSyncSockets(owned);
        return { db, sockets: owned };
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
            const { db, sockets } = Lattice.constructWithSyncSocket(syncConfig?.websocketUrl, makeDb);
            lattice = new Lattice(db, schemas, modelMap);
            lattice.syncSockets = sockets;
        } else {
            // Persistent: same main-thread wasm, snapshotted to and restored
            // from OPFS. See openPersistent.
            lattice = await Lattice.openPersistent(path, schemas, modelMap, syncConfig);
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
        syncConfig?: { websocketUrl: string; authToken?: string }
    ): Promise<Lattice> {
        console.log('[Lattice] Opening persistent database:', path);

        // Try to restore from OPFS snapshot before opening
        const restored = await Lattice.restoreSnapshot(path);
        if (restored) {
            console.log('[Lattice] Restored snapshot from OPFS');
        }

        // Open with named path (MEMFS) + sync
        const { db, sockets } = Lattice.constructWithSyncSocket(syncConfig?.websocketUrl, () => {
            if (syncConfig?.websocketUrl) {
                console.log('[Lattice] Sync enabled:', syncConfig.websocketUrl);
                return new wasmModule.Lattice(path, schemas, syncConfig.websocketUrl, syncConfig.authToken || '');
            }
            return new wasmModule.Lattice(path, schemas);
        });
        const lattice = new Lattice(db, schemas, modelMap);
        lattice.syncSockets = sockets;

        // Set up periodic OPFS snapshot saves (every 15s when dirty)
        let snapshotDirty = false;
        let snapshotInFlight = false;
        const flushSnapshot = async () => {
            if (!snapshotDirty || snapshotInFlight) return;
            snapshotInFlight = true;
            snapshotDirty = false;
            try {
                await Lattice.saveSnapshot(path, db);
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
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', onPagehide);
        }

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
        // The close-time snapshot is the MOST valuable one — it carries the
        // resume cursor of everything this session applied. Drain any
        // in-flight save first (two concurrent createWritable() streams on
        // one snapshot file would race), then take one final snapshot.
        lattice.persistentFinalFlush = async () => {
            while (snapshotInFlight) await new Promise((r) => setTimeout(r, 25));
            await Lattice.saveSnapshot(path, db);
        };

        // Mark dirty when data changes (for snapshot saves)
        for (const [, model] of modelMap) {
            lattice.observeTable(model, () => { snapshotDirty = true; });
        }

        // Save initial snapshot after first sync batch completes
        // (triggers after the first burst of observer callbacks settles)
        let initialSaveTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleInitialSave = () => {
            if (initialSaveTimer) clearTimeout(initialSaveTimer);
            initialSaveTimer = setTimeout(async () => {
                initialSaveTimer = null;
                await Lattice.saveSnapshot(path, db);
                console.log('[Lattice] Initial snapshot saved');
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
    }

    /**
     * Save database snapshot to OPFS (async API, works on main thread).
     */
    private static async saveSnapshot(path: string, db: LatticeWasm): Promise<void> {
        try {
            if (!navigator?.storage?.getDirectory) return;
            // A deleted wasm object throws BindingError on ANY method call —
            // a save that lost the race with close() must be a no-op, not a
            // dirty-window-eating failure.
            if ((db as unknown as { isDeleted?: () => boolean }).isDeleted?.()) return;

            // Flush WAL into main database file
            db.walCheckpoint();

            // Read from Emscripten MEMFS
            const data: Uint8Array = wasmModule.FS.readFile(path);
            if (data.length === 0) return;

            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('lattice-snapshots', { create: true });
            const safeName = path.replace(/[^a-z0-9._-]/gi, '_');
            const fileHandle = await dir.getFileHandle(safeName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(data.buffer as ArrayBuffer);
            await writable.close();

            console.log(`[Lattice] Snapshot saved: ${data.length} bytes`);
        } catch (e) {
            console.warn('[Lattice] Snapshot save failed:', e);
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

        const drained = await drainPendingUploads(this.db, rows, {
            ...options,
            tables: this.schemas.map((s) => s.tableName),
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
                const opened = await whenSyncSocketOpen(this.syncSockets, RESUME_CONNECT_TIMEOUT_MS);
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
                });
                const report = await this.drainPendingFrom(previousPath);
                onReport?.(report);
            } catch (err) {
                console.warn('[Lattice] resumePendingFrom drain failed:', err);
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
        const observerId = this.db.observeTable(tableName, callback);
        return () => {
            this.db.removeTableObserver(tableName, observerId);
        };
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

        const observerId = this.db.observeObject(tableName, id, (changedFields: string) => {
            callback(changedFields.split(',').filter(s => s.length > 0));
        });
        return () => {
            this.db.removeObjectObserver(tableName, id, observerId);
        };
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

    /**
     * Observe sync progress changes.
     * @returns Unsubscribe function
     */
    /**
     * Observe the sync WebSocket's lifecycle (open / closed / error).
     * Module-global and MULTI-listener: each registration is additive (the
     * app shell, a status pill, and a reconnect controller can all listen);
     * pass null to clear all. Events carry no socket identity — with several
     * synced lattices open, every listener hears every socket.
     */
    onSyncState(callback: ((info: import('./types').SyncStateInfo) => void) | null): void {
        wasmModule.setSyncStateCallback(callback);
    }

    onSyncProgress(callback: (progress: SyncProgress) => void): () => void {
        const observerId = this.db.onSyncProgress(callback);
        return () => {
            // Note: removal handled by C++ when observer is destroyed
        };
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
        // Wrap the callback to parse JSON from C++
        const wrappedCallback = (json: string) => {
            try {
                const rawEntries = JSON.parse(json);
                const entries: AuditLogEntry[] = rawEntries.map((e: any) => this.parseAuditLogEntry(e));
                callback(entries);
            } catch (e) {
                console.error('[Lattice.observe] Failed to parse audit log:', e);
            }
        };

        // Register observer with C++
        const observerId = this.db.observeAuditLog(wrappedCallback);

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
     * Close the database and clean up resources: severs the sync socket,
     * unregisters observers, retires the snapshot timer and page-lifecycle
     * listeners, takes the final OPFS snapshot, then deletes the wasm handle.
     */
    async close(): Promise<void> {
        console.log('[Lattice.close] Closing database...');

        // Sever the sync transport FIRST. Two reasons it leads:
        //
        // 1. It is the leak this method exists to stop. `db.delete()` below
        //    does NOT reach the C++ teardown that would disconnect the socket:
        //    no `close`/`disconnect` is registered on the embind Lattice class,
        //    and `~JsLattice`'s `releaseSwiftLatticeRef` underflows a refcount
        //    that wasm/bindings.cpp never retained, so `~lattice_db` — and with
        //    it `teardown_sync()` — never runs. Full derivation in
        //    ./sync-socket. Every close() therefore used to leave a live socket
        //    behind (and a per-connection Lattice open on the server); a page
        //    redialing every 5s accumulated them.
        // 2. Quiescing the socket before the final snapshot makes that snapshot
        //    deterministic: no remote apply can land between walCheckpoint()
        //    and the MEMFS read that follows it.
        //
        // Refcounted — a sibling Lattice sharing this wasm instance's transport
        // keeps it open. Deliberately silent: the wasm's close handler is
        // detached first, so an app-level reconnect controller listening via
        // onSyncState does not hear this teardown and redial into it (same
        // contract as the C++ disconnect()).
        if (this.syncSockets.length > 0) {
            const closed = releaseSyncSockets(this.syncSockets, wasmModule);
            this.syncSockets = [];
            console.log(`[Lattice.close] sync sockets released (${closed} closed)`);
        }

        // Remove sync observer
        if (this.syncObserverId) {
            this.syncObserverId();
            this.syncObserverId = null;
        }

        // Retire openPersistent's snapshot timer + page-lifecycle listeners
        // FIRST (nothing may schedule a save once teardown begins)…
        if (this.housekeepingCleanup) {
            this.housekeepingCleanup();
            this.housekeepingCleanup = null;
        }
        // …then take the close-time snapshot while the wasm instance is
        // still alive. Best-effort: a failed final save costs a larger
        // delta on next open, never corruption (createWritable is
        // swap-on-close).
        if (this.persistentFinalFlush) {
            try {
                await this.persistentFinalFlush();
            } catch (err) {
                console.warn('[Lattice.close] final snapshot failed:', err);
            }
            this.persistentFinalFlush = null;
        }

        // Destroy the embind wrapper. This runs `~JsLattice`, which is where
        // the wasm-side teardown SHOULD continue — `releaseSwiftLatticeRef` ->
        // `~swift_lattice` -> `~lattice_db` -> `teardown_sync()`. It does not:
        // `swift_lattice_ref` is handed out with `ref_count_ == 0` (the
        // factories return UNRETAINED and every LatticeCAPI open pairs them
        // with `ref->retain()`; wasm/bindings.cpp does not), so `release()`
        // decrements to -1, never frees the ref, and the sqlite connection,
        // synchronizer and transport all outlive this call. Fixing that needs
        // a wasm rebuild (one `ref->retain()` after `swift_lattice_ref::create`
        // in wasm/bindings.cpp). Until then the socket teardown above is the
        // part JS can enforce, and this delete() still frees the wrapper and
        // makes further use of `this.db` throw a BindingError rather than
        // silently operating on a closed database.
        try {
            (this.db as unknown as { delete?: () => void }).delete?.();
        } catch (err) {
            console.warn('[Lattice.close] wasm instance delete failed:', err);
        }

        console.log('[Lattice.close] Database closed');
    }
}
