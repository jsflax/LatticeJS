// Web Worker entry point - runs WASM in background thread
import * as Comlink from 'comlink';
import type { SchemaEntry } from '../types';

let wasmModule: any = null;
let latticeInstance: any = null;
let broadcastChannel: BroadcastChannel | null = null;
let observerId: number | null = null;
let workerInstanceId: string = crypto.randomUUID();

/**
 * Worker API exposed via Comlink
 */
const workerApi = {
    /**
     * Initialize the WASM module
     */
    async init(wasmUrl: string, wasmBinaryUrl?: string): Promise<void> {
        if (wasmModule) return; // Already initialized

        console.log('[Worker] Loading WASM from:', wasmUrl);

        // Determine base URL for locating .wasm file
        const wasmBase = wasmUrl.substring(0, wasmUrl.lastIndexOf('/') + 1);

        // Dynamic import of the WASM module
        const module = await import(/* @vite-ignore */ wasmUrl);

        wasmModule = await module.default({
            locateFile: (path: string) => {
                console.log('[Worker] locateFile:', path);
                if (path.endsWith('.wasm') && wasmBinaryUrl) {
                    return wasmBinaryUrl;
                }
                return wasmBase + path;
            }
        });

        console.log('[Worker] WASM module initialized');

        // Initialize OPFS for persistent storage
        // Use async init + polling (works from worker context)
        try {
            if (typeof wasmModule.initOPFSAsync === 'function') {
                wasmModule.initOPFSAsync();
                console.log('[Worker] OPFS async initialization started');

                // Wait for OPFS to be ready
                const maxWait = 5000;
                const pollInterval = 50;
                let waited = 0;

                while (waited < maxWait) {
                    if (wasmModule.isOPFSAvailable()) {
                        console.log('[Worker] OPFS ready');
                        break;
                    }
                    if (wasmModule.isOPFSInitFailed()) {
                        console.warn('[Worker] OPFS initialization failed');
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                    waited += pollInterval;
                }
            }
        } catch (e) {
            console.warn('[Worker] OPFS initialization error:', e);
        }
    },

    /**
     * Check if OPFS is available
     */
    async isOPFSAvailable(): Promise<boolean> {
        if (!wasmModule) return false;
        try {
            return typeof wasmModule.isOPFSAvailable === 'function' && wasmModule.isOPFSAvailable();
        } catch {
            return false;
        }
    },

    /**
     * Open a Lattice database with optional BroadcastChannel sync
     */
    async open(path: string, schemas: SchemaEntry[], channelName?: string): Promise<void> {
        if (!wasmModule) {
            throw new Error('WASM module not initialized. Call init() first.');
        }
        if (latticeInstance) {
            throw new Error('Database already open. Close it first.');
        }

        // Transform path for OPFS if available
        let actualPath = path;
        if (path !== ':memory:' && !path.startsWith(':memory:')) {
            const opfsAvailable = await this.isOPFSAvailable();
            if (opfsAvailable) {
                actualPath = path.startsWith('/opfs/') ? path : `/opfs/${path}`;
                console.log('[Worker] Using OPFS path:', actualPath);
            } else {
                console.warn('[Worker] OPFS not available, using in-memory database');
                actualPath = ':memory:';
            }
        }

        console.log('[Worker] Opening database:', actualPath);
        latticeInstance = new wasmModule.Lattice(actualPath, schemas);
        console.log('[Worker] Database opened');

        // Set up BroadcastChannel sync if channel name provided
        if (channelName) {
            console.log('[Worker] Setting up BroadcastChannel:', channelName);
            broadcastChannel = new BroadcastChannel(channelName);

            // Listen for changes from other sources
            broadcastChannel.onmessage = (event) => {
                // Ignore our own messages (same instance)
                if (event.data.instanceId === workerInstanceId) return;
                console.log('[Worker] Received changes from:', event.data.source, 'entries:', event.data.entries?.length);
                if (event.data.entries) {
                    try {
                        const json = JSON.stringify(event.data.entries);
                        latticeInstance.applyRemoteChanges(json);
                    } catch (e) {
                        console.error('[Worker] Failed to apply remote changes:', e);
                    }
                }
            };

            // Observe local changes and broadcast to channel
            observerId = latticeInstance.observeAuditLog((json: string) => {
                if (broadcastChannel) {
                    try {
                        const allEntries = JSON.parse(json);
                        // Only broadcast local changes
                        const localEntries = allEntries.filter((e: any) => !e.isFromRemote);
                        if (localEntries.length > 0) {
                            console.log('[Worker] Broadcasting local changes:', localEntries.length);
                            broadcastChannel.postMessage({
                                source: 'worker',
                                instanceId: workerInstanceId,
                                entries: localEntries
                            });
                        }
                    } catch (e) {
                        console.error('[Worker] Failed to broadcast changes:', e);
                    }
                }
            });
        }
    },

    /**
     * Close the database
     */
    async close(): Promise<void> {
        // Clean up observer
        if (observerId !== null && latticeInstance) {
            latticeInstance.removeAuditLogObserver(observerId);
            observerId = null;
        }

        // Clean up BroadcastChannel
        if (broadcastChannel) {
            broadcastChannel.close();
            broadcastChannel = null;
        }

        if (latticeInstance) {
            latticeInstance = null;
        }
    },

    /**
     * Add an object to a table
     */
    async add(tableName: string, obj: Record<string, unknown>): Promise<number> {
        assertOpen();
        // Use the add method which takes tableName and plain JS object
        return latticeInstance.add(tableName, obj);
    },

    /**
     * Find an object by ID
     */
    async find(tableName: string, id: number): Promise<Record<string, unknown> | null> {
        assertOpen();
        const result = latticeInstance.find(tableName, id);
        return result || null;
    },

    /**
     * Find an object by global ID
     */
    async findByGlobalId(tableName: string, globalId: string): Promise<Record<string, unknown> | null> {
        assertOpen();
        const result = latticeInstance.findByGlobalId(tableName, globalId);
        return result || null;
    },

    /**
     * Query objects from a table
     */
    async objects(
        tableName: string,
        where?: string | null,
        orderBy?: string | null,
        limit?: number | null,
        offset?: number | null
    ): Promise<Record<string, unknown>[]> {
        assertOpen();
        return latticeInstance.objects(tableName, where, orderBy, limit, offset);
    },

    /**
     * Count objects in a table
     */
    async count(tableName: string, where?: string | null): Promise<number> {
        assertOpen();
        const count = latticeInstance.count(tableName, where);
        return typeof count === 'bigint' ? Number(count) : count;
    },

    /**
     * Remove an object by ID
     */
    async remove(tableName: string, id: number): Promise<boolean> {
        assertOpen();
        return latticeInstance.remove(tableName, id);
    },

    /**
     * Begin a write transaction
     */
    async beginWrite(): Promise<void> {
        assertOpen();
        latticeInstance.beginWrite();
    },

    /**
     * Commit the current transaction
     */
    async commitWrite(): Promise<void> {
        assertOpen();
        latticeInstance.commitWrite();
    },

    /**
     * Get the database path
     */
    async getPath(): Promise<string> {
        assertOpen();
        return latticeInstance.path;
    },

    /**
     * Debug: list tables
     */
    async debugListTables(): Promise<string> {
        assertOpen();
        return latticeInstance.debugListTables();
    },

    /**
     * Debug: query count
     */
    async debugQueryCount(sql: string): Promise<number> {
        assertOpen();
        return latticeInstance.debugQueryCount(sql);
    },

    /**
     * Get pending (unsynchronized) audit log entries as JSON.
     * Used for initial sync when main thread connects.
     */
    async getPendingAuditLog(): Promise<string> {
        assertOpen();
        return latticeInstance.getPendingAuditLog();
    },
};

function assertOpen(): void {
    if (!latticeInstance) {
        throw new Error('Database not open. Call open() first.');
    }
}

export type WorkerApi = typeof workerApi;

// Expose the API via Comlink
Comlink.expose(workerApi);
