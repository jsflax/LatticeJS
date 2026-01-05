// Bootstrap for SharedWorker - sets up polyfills before loading main worker code

// Use BroadcastChannel to send debug logs to main thread (since SharedWorker console is hard to access)
const debugChannel = new BroadcastChannel('lattice-debug');
function debugLog(...args: any[]) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    debugChannel.postMessage({ type: 'log', msg });
    console.log(...args);
}
function debugError(...args: any[]) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    debugChannel.postMessage({ type: 'error', msg });
    console.error(...args);
}

debugLog('[SharedWorker Bootstrap] Starting...');

// Polyfill Worker for SharedWorker context (Comlink checks for it)
if (typeof (self as any).Worker === 'undefined') {
    debugLog('[SharedWorker Bootstrap] Polyfilling Worker...');
    (self as any).Worker = class DummyWorker {
        constructor(url: string | URL) {
            debugLog('[SharedWorker] Worker construction attempted with:', url);
        }
        postMessage() {}
        terminate() {}
        addEventListener() {}
        removeEventListener() {}
    };
}

// Queue to hold connections that arrive before the impl is loaded
const pendingConnections: MessagePort[] = [];
let implLoaded = false;
let handleConnectionFn: ((port: MessagePort) => void) | null = null;

// Set up onconnect handler BEFORE importing (to catch early connections)
(self as any).onconnect = (event: MessageEvent) => {
    debugLog('[SharedWorker Bootstrap] onconnect received!');
    const port = event.ports[0];
    if (implLoaded && handleConnectionFn) {
        debugLog('[SharedWorker Bootstrap] Forwarding to impl...');
        handleConnectionFn(port);
    } else {
        debugLog('[SharedWorker Bootstrap] Queuing connection (impl not ready)');
        pendingConnections.push(port);
    }
};

// Export function for impl to register its handler
(self as any).__registerConnectionHandler = (handler: (port: MessagePort) => void) => {
    debugLog('[SharedWorker Bootstrap] Handler registered, processing', pendingConnections.length, 'queued connections');
    handleConnectionFn = handler;
    implLoaded = true;
    for (const port of pendingConnections) {
        handler(port);
    }
    pendingConnections.length = 0;
};

// Now import the actual worker code
debugLog('[SharedWorker Bootstrap] Importing shared-impl...');
import('./shared-impl')
    .then(() => {
        debugLog('[SharedWorker Bootstrap] shared-impl loaded successfully');
    })
    .catch((err) => {
        debugError('[SharedWorker Bootstrap] Failed to load shared-impl:', err.message, err.stack);
    });
