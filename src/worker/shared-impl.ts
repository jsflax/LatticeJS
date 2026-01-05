// SharedWorker implementation - loaded via shared-bootstrap.ts
import * as Comlink from 'comlink';
import type { SchemaEntry } from '../types';

// Debug logging via BroadcastChannel
const debugChannel = new BroadcastChannel('lattice-debug');
function debugLog(...args: any[]) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    debugChannel.postMessage({ type: 'log', msg });
    console.log(...args);
}

debugLog('[SharedWorker Impl] Module loading...');

let wasmModule: any = null;
let latticeInstance: any = null;
let broadcastChannel: BroadcastChannel | null = null;
let observerId: number | null = null;
let workerInstanceId: string = crypto.randomUUID();
let isInitialized = false;
let isOpened = false;

// Track connected ports for debugging
const connectedPorts: Set<MessagePort> = new Set();

/**
 * Worker API exposed via Comlink to each connected tab
 */
const workerApi = {
    /**
     * Initialize the WASM module (only happens once across all tabs)
     */
    async init(wasmUrl: string, wasmBinaryUrl?: string): Promise<void> {
        if (isInitialized) {
            debugLog('[SharedWorker] WASM already initialized, skipping');
            return;
        }

        debugLog('[SharedWorker] Loading WASM from:', wasmUrl);

        const wasmBase = wasmUrl.substring(0, wasmUrl.lastIndexOf('/') + 1);

        debugLog('[SharedWorker] Importing module...');
        const module = await import(/* @vite-ignore */ wasmUrl);
        debugLog('[SharedWorker] Module imported, calling default...');

        try {
            wasmModule = await module.default({
                locateFile: (path: string) => {
                    debugLog('[SharedWorker] locateFile:', path);
                    if (path.endsWith('.wasm') && wasmBinaryUrl) {
                        return wasmBinaryUrl;
                    }
                    return wasmBase + path;
                }
            });
            debugLog('[SharedWorker] WASM module initialized successfully');

            // Log WASM version for debugging
            if (typeof wasmModule.getWasmVersion === 'function') {
                debugLog('[SharedWorker] WASM version:', wasmModule.getWasmVersion());
            } else {
                debugLog('[SharedWorker] WASM version: unknown (getWasmVersion not available)');
            }
        } catch (e: any) {
            debugLog('[SharedWorker] WASM module init FAILED:', e.message);
            throw e;
        }

        // Try to initialize OPFS if available
        // First initialize the OPFS root (async), then register the VFS
        try {
            // Step 1: Initialize OPFS root directory (async JS operation)
            if (typeof wasmModule.initOpfsRoot === 'function') {
                debugLog('[SharedWorker] Initializing OPFS root...');
                const rootReady = await wasmModule.initOpfsRoot();
                if (rootReady) {
                    debugLog('[SharedWorker] OPFS root initialized');
                } else {
                    debugLog('[SharedWorker] Failed to initialize OPFS root');
                }
            }

            // Step 2: Register the OPFS VFS with SQLite
            if (typeof wasmModule.initOPFSSync === 'function') {
                debugLog('[SharedWorker] Registering OPFS VFS...');
                const success = wasmModule.initOPFSSync();
                if (success) {
                    debugLog('[SharedWorker] OPFS VFS registered successfully');
                } else {
                    debugLog('[SharedWorker] OPFS VFS registration failed');
                }
            } else {
                debugLog('[SharedWorker] initOPFSSync not exported');
            }
        } catch (e) {
            debugLog('[SharedWorker] OPFS init error:', e);
        }

        isInitialized = true;
    },

    /**
     * Check if OPFS is available
     */
    async isOPFSAvailable(): Promise<boolean> {
        debugLog('[SharedWorker] isOPFSAvailable called, wasmModule:', !!wasmModule);
        if (!wasmModule) return false;
        try {
            const hasFunc = typeof wasmModule.isOPFSAvailable === 'function';
            debugLog('[SharedWorker] hasFunc:', hasFunc);
            if (!hasFunc) return false;
            const result = wasmModule.isOPFSAvailable();
            debugLog('[SharedWorker] isOPFSAvailable result:', result);
            return result;
        } catch (e: any) {
            debugLog('[SharedWorker] isOPFSAvailable error:', e.message);
            return false;
        }
    },

    /**
     * Open a Lattice database (only happens once across all tabs)
     */
    async open(path: string, schemas: SchemaEntry[], channelName?: string, syncConfig?: { websocketUrl: string; authToken?: string }): Promise<void> {
        if (!wasmModule) {
            throw new Error('WASM module not initialized. Call init() first.');
        }

        if (isOpened) {
            // If sync config is provided but wasn't before, we need to warn
            // (can't change sync config without restarting the worker)
            if (syncConfig?.websocketUrl) {
                console.log('[SharedWorker] Database already open - sync config change requires page refresh with cleared SharedWorker');
                console.log('[SharedWorker] To apply new sync config, close all tabs and reopen');
            } else {
                console.log('[SharedWorker] Database already open, skipping');
            }
            return;
        }

        // Transform path for OPFS if available
        let actualPath = path;
        let useOpfs = false;
        if (path !== ':memory:' && !path.startsWith(':memory:')) {
            const opfsAvailable = await this.isOPFSAvailable();
            if (opfsAvailable) {
                // Strip /opfs/ prefix for the file path (VFS handles the storage)
                const fileName = path.startsWith('/opfs/') ? path.substring(6) : path;
                // OPFS is registered as default VFS, just use the filename
                actualPath = fileName;
                useOpfs = true;
                debugLog('[SharedWorker] Using OPFS path:', actualPath);

                // Pre-open the database file and related files BEFORE SQLite tries to open them
                // This is required because we can't do async operations during SQLite's xOpen
                debugLog('[SharedWorker] Pre-opening database files...');
                try {
                    // First, try to delete any existing corrupt files to start fresh
                    // This helps when previous sessions left the database in an inconsistent state
                    try {
                        const root = await navigator.storage.getDirectory();
                        const filesToCheck = [fileName, fileName + '-journal', fileName + '-wal', fileName + '-shm'];
                        for (const file of filesToCheck) {
                            try {
                                await root.removeEntry(file);
                                debugLog('[SharedWorker] Deleted existing file:', file);
                            } catch (e) {
                                // File doesn't exist, that's fine
                            }
                        }
                    } catch (e) {
                        debugLog('[SharedWorker] Could not clear old files:', e);
                    }

                    // Pre-open main database file (create if doesn't exist)
                    const mainHandle = await wasmModule.opfsPreOpen(fileName, true);
                    debugLog('[SharedWorker] Pre-opened main db, handle:', mainHandle);

                    // Pre-open journal file (for rollback journal mode)
                    const journalHandle = await wasmModule.opfsPreOpen(fileName + '-journal', true);
                    debugLog('[SharedWorker] Pre-opened journal, handle:', journalHandle);

                    // Pre-open WAL file (for WAL mode)
                    const walHandle = await wasmModule.opfsPreOpen(fileName + '-wal', true);
                    debugLog('[SharedWorker] Pre-opened WAL, handle:', walHandle);

                    // Pre-open SHM file (for WAL mode shared memory)
                    const shmHandle = await wasmModule.opfsPreOpen(fileName + '-shm', true);
                    debugLog('[SharedWorker] Pre-opened SHM, handle:', shmHandle);
                } catch (e: any) {
                    debugLog('[SharedWorker] Pre-open error:', e.message);
                    // Continue anyway - SQLite will handle missing files
                }
            } else {
                debugLog('[SharedWorker] OPFS not available - using in-memory database (data will not persist across page reloads)');
                actualPath = ':memory:';
            }
        }

        debugLog('[SharedWorker] Opening database:', actualPath, 'syncConfig:', syncConfig ? 'provided' : 'none');
        try {
            if (syncConfig?.websocketUrl) {
                debugLog('[SharedWorker] Sync enabled:', syncConfig.websocketUrl);
                latticeInstance = new wasmModule.Lattice(actualPath, schemas, syncConfig.websocketUrl, syncConfig.authToken || '');
            } else {
                debugLog('[SharedWorker] Opening WITHOUT sync');
                latticeInstance = new wasmModule.Lattice(actualPath, schemas);
            }
            debugLog('[SharedWorker] Database opened');
        } catch (e: any) {
            debugLog('[SharedWorker] Lattice constructor FAILED');
            debugLog('[SharedWorker] Error name:', e?.name);
            debugLog('[SharedWorker] Error message:', e?.message);
            debugLog('[SharedWorker] Error:', String(e));
            // Try to get more info
            if (e && typeof e === 'object') {
                for (const key of Object.keys(e)) {
                    debugLog('[SharedWorker] Error.' + key + ':', String(e[key]));
                }
            }
            throw e;
        }

        // Set up BroadcastChannel sync if channel name provided
        if (channelName) {
            debugLog('[SharedWorker] Setting up BroadcastChannel:', channelName);
            broadcastChannel = new BroadcastChannel(channelName);

            // Listen for changes from main threads
            broadcastChannel.onmessage = (event) => {
                debugLog('[SharedWorker] BroadcastChannel message received from:', event.data.source, 'instanceId:', event.data.instanceId?.substring(0,8));
                // Ignore our own messages
                if (event.data.instanceId === workerInstanceId) {
                    debugLog('[SharedWorker] Ignoring own message');
                    return;
                }
                debugLog('[SharedWorker] Applying', event.data.entries?.length, 'entries from:', event.data.source);
                if (event.data.entries) {
                    try {
                        const json = JSON.stringify(event.data.entries);
                        const result = latticeInstance.applyRemoteChanges(json);
                        debugLog('[SharedWorker] Applied changes, result:', result);
                    } catch (e: any) {
                        debugLog('[SharedWorker] Failed to apply remote changes:', e.message);
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
                            console.log('[SharedWorker] Broadcasting local changes:', localEntries.length);
                            broadcastChannel.postMessage({
                                source: 'worker',
                                instanceId: workerInstanceId,
                                entries: localEntries
                            });
                        }
                    } catch (e) {
                        console.error('[SharedWorker] Failed to broadcast changes:', e);
                    }
                }
            });
        }

        isOpened = true;
    },

    /**
     * Get pending audit log entries (for initial sync)
     */
    async getPendingAuditLog(): Promise<string> {
        if (!latticeInstance) {
            debugLog('[SharedWorker] getPendingAuditLog: no lattice instance');
            return '[]';
        }
        const result = latticeInstance.getPendingAuditLog();
        const parsed = JSON.parse(result);
        debugLog('[SharedWorker] getPendingAuditLog returning', parsed.length, 'entries');
        return result;
    },

    /**
     * Get connection count (for debugging)
     */
    async getConnectionCount(): Promise<number> {
        return connectedPorts.size;
    },
};

export type SharedWorkerApi = typeof workerApi;

// SharedWorker connection handler
declare const self: SharedWorkerGlobalScope & {
    __registerConnectionHandler?: (handler: (port: MessagePort) => void) => void;
};

function handleConnection(port: MessagePort) {
    debugLog('[SharedWorker Impl] handleConnection called!');
    connectedPorts.add(port);
    debugLog('[SharedWorker Impl] New connection, total:', connectedPorts.size);

    // Start the port
    port.start();

    // Expose the API to this port via Comlink
    debugLog('[SharedWorker Impl] Exposing API via Comlink...');
    Comlink.expose(workerApi, port);
    debugLog('[SharedWorker Impl] API exposed');

    // Clean up when port closes (note: this doesn't always fire reliably)
    port.onmessageerror = () => {
        connectedPorts.delete(port);
        debugLog('[SharedWorker Impl] Connection error, total:', connectedPorts.size);
    };
}

// Register with bootstrap's connection handler
if (self.__registerConnectionHandler) {
    debugLog('[SharedWorker Impl] Registering with bootstrap...');
    self.__registerConnectionHandler(handleConnection);
} else {
    // Fallback: set up onconnect directly
    debugLog('[SharedWorker Impl] No bootstrap handler, setting up onconnect directly');
    self.onconnect = (event: MessageEvent) => {
        handleConnection(event.ports[0]);
    };
}

debugLog('[SharedWorker Impl] Connection handler ready');
