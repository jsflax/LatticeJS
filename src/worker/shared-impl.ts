// SharedWorker implementation - loaded via shared-bootstrap.ts
//
// This is a thin cross-tab coordination relay. The main thread owns the database
// and sync. The SharedWorker just relays change notifications between tabs.
import * as Comlink from 'comlink';
import type { SchemaEntry } from '../types';

// Debug logging via BroadcastChannel
const debugChannel = new BroadcastChannel('lattice-debug');
function debugLog(...args: any[]) {
    const msg = args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
    }).join(' ');
    debugChannel.postMessage({ type: 'log', msg });
    console.log(...args);
}

debugLog('[SharedWorker Impl] Module loading...');

let isInitialized = false;
let isOpened = false;
let broadcastChannel: BroadcastChannel | null = null;

// Track connected ports for debugging
const connectedPorts: Set<MessagePort> = new Set();

/**
 * Worker API exposed via Comlink to each connected tab
 */
const workerApi = {
    /**
     * Initialize (no-op for relay-only mode, kept for API compat)
     */
    async init(_wasmUrl: string, _wasmBinaryUrl?: string): Promise<void> {
        if (isInitialized) {
            debugLog('[SharedWorker] Already initialized');
            return;
        }
        debugLog('[SharedWorker] Initialized (relay mode)');
        isInitialized = true;
    },

    /**
     * Open — sets up BroadcastChannel for cross-tab relay
     */
    async open(_path: string, _schemas: SchemaEntry[], channelName?: string): Promise<void> {
        if (isOpened) {
            debugLog('[SharedWorker] Already open');
            return;
        }

        if (channelName) {
            debugLog('[SharedWorker] Setting up relay channel:', channelName);
            broadcastChannel = new BroadcastChannel(channelName);
        }

        isOpened = true;
        debugLog('[SharedWorker] Relay ready');
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

    port.start();
    Comlink.expose(workerApi, port);

    port.onmessageerror = () => {
        connectedPorts.delete(port);
    };
}

// Register with bootstrap's connection handler
if (self.__registerConnectionHandler) {
    debugLog('[SharedWorker Impl] Registering with bootstrap...');
    self.__registerConnectionHandler(handleConnection);
} else {
    debugLog('[SharedWorker Impl] No bootstrap handler, setting up onconnect directly');
    self.onconnect = (event: MessageEvent) => {
        handleConnection(event.ports[0]);
    };
}

debugLog('[SharedWorker Impl] Connection handler ready');
