// Stand-in for the Emscripten module (`wasm/build/lattice.js`).
//
// `Lattice.ensureWasm()` does `await import(wasmJsUrl)` and calls the module's
// default export to instantiate. Tests that need to drive the TypeScript layer
// end-to-end — without a browser, OPFS, or a real wasm binary — point that URL
// here (see test/no-shared-worker.test.ts) and get this instead.
//
// It implements only what the pure-TS paths touch: the `Lattice` constructor,
// the table-observer pair, `walCheckpoint`, the MEMFS `FS` shim, and the
// embind lifecycle methods (`isDeleted`/`delete`) that close() and the
// snapshot writer probe.

class FakeLatticeDb {
    constructor(path, schemas, syncUrl = '', authToken = '') {
        this.path = path;
        this.schemas = schemas;
        this.syncUrl = syncUrl;
        this.authToken = authToken;
        this.observers = new Map();
        this.checkpoints = 0;
        this.deleted = false;
        this.nextObserverId = 1;
    }

    observeTable(tableName, callback) {
        const id = this.nextObserverId++;
        this.observers.set(`${tableName}:${id}`, callback);
        return id;
    }

    removeTableObserver(tableName, observerId) {
        this.observers.delete(`${tableName}:${observerId}`);
    }

    /** Observers still registered — close() must leave none of ours behind. */
    get observerCount() {
        return this.observers.size;
    }

    walCheckpoint() {
        if (this.deleted) throw new Error('BindingError: Cannot pass deleted object as a pointer');
        this.checkpoints++;
    }

    getPath() {
        return this.path;
    }

    isDeleted() {
        return this.deleted;
    }

    delete() {
        this.deleted = true;
    }
}

/** MEMFS shim: an empty read makes saveSnapshot a no-op without touching OPFS. */
const FS = {
    files: new Map(),
    readFile(path) {
        return FS.files.get(path) ?? new Uint8Array(0);
    },
    writeFile(path, data) {
        FS.files.set(path, data);
    },
};

export default async function createFakeLatticeModule(_options) {
    return {
        Lattice: FakeLatticeDb,
        FS,
        _lattice_set_log_level() {},
    };
}
