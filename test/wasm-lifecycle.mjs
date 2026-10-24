// Actual rebuilt WASM/SQLite lifecycle tests. The WebSocket below is a local
// event-delivery fixture, not a fake Lattice or native reference implementation.
// Build first, then run:
// node test/wasm-lifecycle.mjs --output /absolute/path/to/native-runtime.json
// Optional: --build /absolute/path/to/the/completed/wasm/build
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareExplicitRuntime } from './explicit-models-wasm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    const value = process.argv[i + 1];
    if (!['--build', '--output'].includes(name) || !value || value.startsWith('--') || options.has(name)) {
        throw new Error('Usage: node test/wasm-lifecycle.mjs [--build DIRECTORY] --output /absolute/path/report.json');
    }
    options.set(name, value);
}
if (!options.has('--output') || !path.isAbsolute(options.get('--output'))) {
    throw new Error('--output requires an explicit absolute report path. CI uses $HOME/localdev/lattice-js-lifecycle-ci/.');
}
const build = path.resolve(options.get('--build') ?? path.join(here, '../wasm/build'));
const output = path.resolve(options.get('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
const jsPath = path.join(build, 'lattice.js');
const wasmPath = path.join(build, 'lattice.wasm');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const started = performance.now();
const reports = [];
const asyncErrors = [];
const fatalLogs = [];
const logs = [];
let droppedLogs = 0;
let module;
let baseline;
let serial = 0;
const handles = new Set();
const keys = ['nativeOwners', 'retainedHandles', 'schedulers', 'pendingCallbacks', 'nativeDatabases'];
const scope = {
    actualRebuiltWasm: true, actualSQLite: true, actualBindings: true,
    fixtureWebSocketOnly: true, nativeSdkTestRun: false, realBrowser: false,
    liveNetwork: false, remoteSync: false, opfs: false, fullMatrix: false,
    performanceComparison: false, releaseQualification: false,
};
const recordLog = (...values) => {
    const line = values.map(value => String(value)).join(' ').slice(0, 1800);
    if (/SCHEDULER EXCEPTION|Aborted\(|RuntimeError:|Deferred Lattice release failed|Lattice release failed/.test(line)) {
        fatalLogs.push(line);
    }
    if (logs.length < 240) logs.push(line); else ++droppedLogs;
};
const oldConsole = { log: console.log, warn: console.warn, error: console.error };
const event = (type, fields = {}) => Object.assign(new Event(type), fields);
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const turns = async (count = 8) => { for (let i = 0; i < count; ++i) await turn(); };
async function until(predicate, label, milliseconds = 1800) {
    const end = performance.now() + milliseconds;
    for (;;) {
        if (predicate()) return;
        assert.equal(asyncErrors.length, 0, `Async error while waiting for ${label}: ${asyncErrors.join('\n')}`);
        assert.equal(fatalLogs.length, 0, `Native failure while waiting for ${label}: ${fatalLogs.join('\n')}`);
        if (performance.now() >= end) assert.fail(`Timed out waiting for ${label}; diagnostics=${JSON.stringify(diag())}`);
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

class FixtureWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0;
    binaryType = 'blob';
    sent = [];
    closeCalls = 0;
    listeners = new Map();
    constructor(url) {
        super();
        this.url = String(url);
        FixtureWebSocket.instances.push(this);
    }
    addEventListener(type, callback, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
        return super.addEventListener(type, callback, options);
    }
    removeEventListener(type, callback, options) {
        this.listeners.get(type)?.delete(callback);
        return super.removeEventListener(type, callback, options);
    }
    open() {
        assert.equal(this.readyState, this.CONNECTING);
        this.readyState = this.OPEN;
        this.dispatchEvent(event('open'));
    }
    send(data) {
        assert.equal(this.readyState, this.OPEN, 'Native transport sent on a closed fixture socket');
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        this.sent.push({ text, decoded: JSON.parse(text) });
    }
    message(data = { kind: 'ack', ack: [] }) {
        this.dispatchEvent(event('message', {
            data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data),
        }));
    }
    error() { this.dispatchEvent(event('error')); }
    serverClose(code = 1006, reason = 'fixture server close') {
        this.readyState = this.CLOSED;
        this.dispatchEvent(event('close', { code, reason, wasClean: code === 1000 }));
    }
    close(code = 1000, reason = '') {
        ++this.closeCalls;
        if (this.readyState === this.CLOSED || this.readyState === this.CLOSING) return;
        this.readyState = this.CLOSING;
        setTimeout(() => {
            this.readyState = this.CLOSED;
            this.dispatchEvent(event('close', { code, reason, wasClean: true }));
        }, 0);
    }
    lateEvents() {
        // Browser event tasks can already be queued when native teardown runs.
        // Deliver through EventTarget so detached listeners, not our fixture,
        // determine whether any native handler is entered.
        this.dispatchEvent(event('open'));
        this.message({ kind: 'ack', ack: ['late-old-connection'] });
        this.error();
        this.dispatchEvent(event('close', { code: 1006, reason: 'late close', wasClean: false }));
    }
    get listenerCount() {
        return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
    }
}

const schema = [{
    tableName: 'LifecycleItem',
    properties: [
        { name: 'name', type: 'string', nullable: false },
        { name: 'rank', type: 'int', nullable: false },
    ],
}];
const table = 'LifecycleItem';
const syncUrl = 'ws://lifecycle.invalid/sync'; // The fixture never opens a network connection.
const newPath = label => `/lifecycle/${++serial}-${label}.sqlite`;
const diag = () => {
    if (!module) return null;
    const value = module._lifecycleDiagnostics();
    return Object.fromEntries(keys.map(key => [key, Number(value[key])]));
};
function openVersioned(...args) {
    const result = module._openVersioned(...args);
    if (!result.ok) throw new Error(result.error);
    return result.db;
}
function open(store = newPath('store'), sync = false, version) {
    const token = sync ? 'local-fixture-token' : '';
    const db = version === undefined ? new module.Lattice(store, schema, sync ? syncUrl : '', token) :
        openVersioned(store, schema, sync ? syncUrl : '', token, version, null);
    handles.add(db);
    return db;
}
function dispose(db, explicit = true) {
    if (!handles.has(db)) return 'already-disposed-by-fixture';
    const result = explicit ? db.releaseStorage() : 'destructor';
    db.delete();
    handles.delete(db);
    return result;
}
function migrationCall(method, ...args) {
    const result = module[method](...args);
    if (!result.ok) throw new Error(result.error);
}
function addRows(db, names) {
    db.beginWrite();
    const ids = names.map((name, rank) => db.add(table, { name, rank }));
    db.commitWrite();
    return ids;
}
function count(db) { return Number(db.count(table, null, null, null)); }
function assertAuditRowsMatchStorage(db, observed) {
    const stored = JSON.parse(db.eventsAfter(''));
    const storedCount = Number(db.debugQueryCount('SELECT id FROM AuditLog'));
    assert.equal(stored.length, storedCount, 'Stored audit enumeration omitted rows');
    assert.equal(observed.length, storedCount,
        `Audit payload must contain each stored row once; observed IDs=${observed.map(entry => entry.id)}, stored IDs=${stored.map(entry => entry.id)}`);
    assert.equal(new Set(observed.map(entry => entry.globalId)).size, storedCount,
        'Audit payload repeated a stored globalId');
    // eventsAfter's legacy query does not preserve numeric timestamps as text.
    // Compare all other serialized fields exactly, and check the observation's
    // timestamp against the actual SQLite value separately.
    const withoutTimestamp = ({ timestamp, ...entry }) => entry;
    assert.deepEqual(observed.map(withoutTimestamp), stored.map(withoutTimestamp),
        'Audit payload differs from stored identity, order, operation, fields or provenance');
    for (const entry of observed) {
        assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0);
        assert.equal(typeof entry.timestamp, 'string');
        assert.match(entry.timestamp, /^[0-9.eE+-]+$/);
        assert.ok(Number.isFinite(Number(entry.timestamp)) && Number(entry.timestamp) > 0);
        assert.equal(Number(db.debugQueryCount(
            `SELECT id FROM AuditLog WHERE id=${entry.id} AND CAST(timestamp AS TEXT)='${entry.timestamp}'`)), 1,
        'Observed timestamp does not match its stored audit row');
    }
    return stored;
}
async function baselineAgain(label) {
    await turns();
    await until(() => keys.every(key => diag()[key] === baseline[key]), `${label} native resources return to baseline`);
    await turns(3);
    assert.deepEqual(diag(), baseline, `${label}: resource baseline changed after extra browser turns`);
    assert.equal(asyncErrors.length, 0, asyncErrors.join('\n'));
    assert.equal(fatalLogs.length, 0, fatalLogs.join('\n'));
    for (const socket of FixtureWebSocket.instances) {
        assert.equal(socket.readyState, socket.CLOSED, `${label}: fixture socket remains open`);
        assert.equal(socket._lattice_client, 0, `${label}: socket retains native client pointer`);
        assert.equal(socket.listenerCount, 0, `${label}: socket retains native event listeners`);
    }
}
async function test(name, body) {
    const begin = performance.now();
    const before = diag();
    try {
        const observations = await body();
        assert.equal(handles.size, 0, `${name}: test left native wrappers undisposed`);
        await baselineAgain(name);
        reports.push({ name, passed: true, elapsedMs: performance.now() - begin, before, after: diag(), observations });
    } catch (error) {
        reports.push({ name, passed: false, elapsedMs: performance.now() - begin, before, after: diag(), error: error?.stack ?? String(error) });
        throw error;
    }
}

let receipt;
let failure;
const onAsyncError = error => asyncErrors.push(error?.stack ?? String(error));
process.on('uncaughtException', onAsyncError);
process.on('unhandledRejection', onAsyncError);
const watchdog = setTimeout(() => {
    const result = { passed: false, scope, reason: 'Harness exceeded 45 second wall bound', reports, diagnostics: diag(), asyncErrors, fatalLogs };
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(JSON.stringify({ passed: false, reason: result.reason, output }) + '\n');
    process.exit(2);
}, 45000);

try {
    const jsBytes = fs.readFileSync(jsPath);
    const wasmBytes = fs.readFileSync(wasmPath);
    receipt = {
        js: { path: jsPath, bytes: jsBytes.length, sha256: digest(jsBytes) },
        wasm: { path: wasmPath, bytes: wasmBytes.length, sha256: digest(wasmBytes) },
        harness: { path: fileURLToPath(import.meta.url), sha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))) },
        node: process.version,
    };
    // The artifact is compiled for web/worker. Supply a browser-like global
    // environment and the exact local WASM bytes; any attempted fetch fails.
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.location = new URL('https://lifecycle.invalid/');
    globalThis.document = { currentScript: { src: pathToFileURL(jsPath).href } };
    globalThis.WebSocket = FixtureWebSocket;
    globalThis.BroadcastChannel = class { postMessage() {} close() {} };
    globalThis.fetch = async () => { throw new Error('Network is disabled in the native lifecycle harness'); };
    console.log = console.warn = console.error = recordLog;
    const savedProcess = globalThis.process;
    try {
        // Prevent Emscripten's environment detector from choosing the Node
        // branch that was deliberately excluded from the released artifact.
        globalThis.process = undefined;
        const imported = await import(pathToFileURL(jsPath).href + `?sha256=${receipt.js.sha256}`);
        module = await imported.default({
            wasmBinary: wasmBytes,
            locateFile: name => pathToFileURL(path.join(build, name)).href,
            print: recordLog, printErr: recordLog,
            onAbort: reason => fatalLogs.push(`Aborted(${String(reason)})`),
        });
    } finally { globalThis.process = savedProcess; }
    assert.equal(digest(fs.readFileSync(jsPath)), receipt.js.sha256, 'Consumed JS changed during initialization');
    assert.equal(digest(fs.readFileSync(wasmPath)), receipt.wasm.sha256, 'Consumed WASM changed during initialization');
    assert.equal(typeof module._lifecycleDiagnostics, 'function', 'This is not the rebuilt lifecycle artifact');
    module._lattice_set_log_level(0);
    module.FS.mkdir('/lifecycle');
    await turns();
    baseline = diag();
    assert.ok(keys.every(key => Number.isSafeInteger(baseline[key]) && baseline[key] >= 0));

    await test('unknown native descriptor capabilities refuse before opening or migrating a file', async () => {
        const store = newPath('schema-refusal');
        const db = open(store);
        addRows(db, ['preserved']);
        dispose(db);
        await turns();
        const original = module.FS.readFile(store);
        for (const property of [
            { name: 'future', type: 'future', kind: 'primitive' },
            { name: 'future', type: 'string', kind: 'unionType' },
            { name: 'future', type: 'string', kind: 'primitive', futurePolicy: false },
            { name: 'future', type: 'object', kind: 'primitive' },
            { name: 'future', type: 'string', kind: 'primitive', noHistory: 'false' },
            { name: 'future', type: 'int', kind: 'link', targetTable: table, noHistory: false },
            { name: 'future', type: 'string', kind: 'union', noHistory: false },
        ]) {
            assert.throws(() => openVersioned(store, [{ ...schema[0], properties: [...schema[0].properties, property] }], '', '', 1, null), /Unsupported property|Unsupported record field|boolean/);
            await turns();
            assert.deepEqual(module.FS.readFile(store), original, 'Rejected descriptor changed database bytes');
        }
        const reopened = open(store);
        assert.equal(reopened.objects(table, null, null, null, null)[0].name, 'preserved');
        dispose(reopened);
        return { rejectedCapabilities: 7, fileUnchanged: true, reopened: true };
    });

    await test('queued table and object unsubscribe suppresses real native delivery', async () => {
        const db = open();
        const [row] = addRows(db, ['object-before']);
        await turns();
        let tableCalls = 0;
        let objectCalls = 0;
        const tableId = db.observeTable(table, () => ++tableCalls);
        const objectId = db.observeObject(table, row, () => ++objectCalls);
        addRows(db, ['queued-one', 'queued-two']);
        assert.equal(db.remove(table, row), true);
        assert.ok(diag().pendingCallbacks > baseline.pendingCallbacks, 'No real native work was queued before unsubscribe');
        db.removeTableObserver(table, tableId);
        db.removeObjectObserver(table, row, objectId);
        await turns();
        assert.equal(tableCalls, 0);
        assert.equal(objectCalls, 0);
        assert.equal(count(db), 2);
        const [controlRow] = addRows(db, ['object-control']);
        await turns();
        let objectControlCalls = 0;
        const controlId = db.observeObject(table, controlRow, fields => {
            assert.equal(typeof fields, 'string');
            ++objectControlCalls;
        });
        assert.equal(db.remove(table, controlRow), true);
        await until(() => objectControlCalls === 1, 'live object-observer control');
        db.removeObjectObserver(table, controlRow, controlId);
        assert.equal(count(db), 2);
        dispose(db);
        return { tableCalls, objectCalls, objectControlCalls, remainingRows: 2 };
    });

    await test('table callback self-unsubscribes after first row of a native batch', async () => {
        const db = open();
        let calls = 0;
        const id = db.observeTable(table, change => {
            assert.equal(change.operation, 'INSERT');
            ++calls;
            db.removeTableObserver(table, id);
        });
        addRows(db, ['batch-one', 'batch-two']);
        await until(() => calls > 0, 'first batch row');
        await turns();
        assert.equal(calls, 1);
        assert.equal(count(db), 2);
        dispose(db);
        return { deliveredRows: calls, storedRows: 2 };
    });

    await test('AuditLog repeated unsubscribe releases once and disables queued copies', async () => {
        const db = open();
        let calls = 0;
        const id = db.observeAuditLog(json => { assert.ok(JSON.parse(json).length > 0); ++calls; });
        addRows(db, ['audit-control']);
        await until(() => calls > 0, 'AuditLog control callback');
        const delivered = calls;
        addRows(db, ['audit-queued']);
        db.removeAuditLogObserver(id);
        db.removeAuditLogObserver(id);
        await turns();
        assert.equal(calls, delivered);
        dispose(db);
        return { beforeUnsubscribe: delivered, afterUnsubscribe: calls };
    });

    await test('closing cached handle A retires only A observers and preserves B', async () => {
        const store = newPath('cached-observers');
        const a = open(store);
        const b = open(store);
        let aCalls = 0;
        let bCalls = 0;
        a.observeTable(table, () => ++aCalls);
        b.observeTable(table, () => ++bCalls);
        addRows(a, ['shared-queued']);
        assert.equal(dispose(a), 'shared');
        await until(() => bCalls === 1, 'surviving cached observer');
        assert.equal(aCalls, 0);
        addRows(b, ['shared-still-writable']);
        await until(() => bCalls === 2, 'surviving cached observer second write');
        assert.equal(count(b), 2);
        dispose(b);
        return { retiredCalls: aCalls, survivingCalls: bCalls };
    });

    await test('closing older progress subscriber preserves newer cached subscriber', async () => {
        const store = newPath('progress');
        const a = open(store, true);
        const b = open(store, true);
        const socket = b.getSyncSocket();
        let aCalls = 0;
        let bCalls = 0;
        a.onSyncProgress(() => ++aCalls);
        const id = b.onSyncProgress(() => ++bCalls);
        assert.equal(dispose(a), 'shared');
        socket.open();
        addRows(b, ['upload-progress']);
        await until(() => bCalls > 0, 'actual native upload progress');
        assert.equal(aCalls, 0);
        b.removeSyncProgress(id);
        const delivered = bCalls;
        addRows(b, ['progress-retired']);
        await turns(12);
        assert.equal(bCalls, delivered);
        dispose(b);
        return { retiredCalls: aCalls, survivingProgressCalls: delivered };
    });

    await test('direct native delete inside observer defers final destruction safely', async () => {
        const db = open(newPath('reentrant-delete'), true);
        const socket = db.getSyncSocket();
        socket.open();
        await turns();
        let calls = 0;
        let ownerCountImmediatelyAfterDelete;
        db.observeTable(table, () => {
            ++calls;
            dispose(db, false);
            // Do not touch the deleted wrapper. Global diagnostics witness
            // the retained native capsule until the current stack returns.
            ownerCountImmediatelyAfterDelete = diag().nativeOwners;
        });
        addRows(db, ['delete-first', 'delete-skipped']);
        await until(() => calls > 0, 'reentrant destructor callback');
        await turns();
        assert.equal(calls, 1);
        assert.equal(ownerCountImmediatelyAfterDelete, baseline.nativeOwners + 1);
        return { calls, ownerCountImmediatelyAfterDelete };
    });

    await test('exact cached transport identity excludes another store at identical URL', async () => {
        const sharedPath = newPath('same-url-shared');
        const a = open(sharedPath, true);
        const b = open(sharedPath, true);
        const independent = open(newPath('same-url-independent'), true);
        const shared = a.getSyncSocket();
        const other = independent.getSyncSocket();
        assert.ok(shared instanceof FixtureWebSocket);
        assert.equal(shared, b.getSyncSocket());
        assert.notEqual(shared, other);
        assert.equal(shared.url, other.url);
        shared.open(); other.open();
        await turns();
        assert.equal(dispose(a), 'shared');
        assert.equal(shared.readyState, shared.OPEN);
        assert.equal(shared.closeCalls, 0);
        addRows(b, ['shared-survives']);
        addRows(independent, ['independent-survives']);
        assert.equal(count(b), 1); assert.equal(count(independent), 1);
        dispose(b);
        assert.equal(shared.closeCalls, 1);
        assert.equal(other.readyState, other.OPEN);
        dispose(independent);
        return { exactSharedObject: true, independentSameUrlObject: true, sharedCloseCalls: shared.closeCalls };
    });

    await test('queued transport messages and old events cannot reach replacement owner', async () => {
        const store = newPath('replacement');
        const first = open(store, true);
        const oldSocket = first.getSyncSocket();
        oldSocket.open();
        await turns();
        oldSocket.message({ kind: 'ack', ack: [] });
        oldSocket.message(new TextEncoder().encode(JSON.stringify({ kind: 'ack', ack: [] })).buffer);
        // The first browser task transfers the message into C++; native
        // invocation is a later task, so this closes across that boundary.
        await turn();
        assert.ok(diag().pendingCallbacks > baseline.pendingCallbacks);
        assert.ok(module._ws_msg_queue.length > 0, 'Second frame did not remain in the native transport JS queue');
        dispose(first);
        assert.equal(module._ws_msg_queue.length, 0, 'Close did not purge the old transport JS queue');
        const replacement = open(store, true);
        const current = replacement.getSyncSocket();
        assert.notEqual(current, oldSocket);
        oldSocket.lateEvents();
        current.open();
        addRows(replacement, ['after-old-events']);
        await until(() => current.sent.some(frame => frame.decoded.auditLog?.length), 'replacement upload after old events');
        assert.equal(count(replacement), 1);
        assert.equal(oldSocket._lattice_client, 0);
        dispose(replacement);
        return { replacementUploadFrames: current.sent.length, oldListenerCount: oldSocket.listenerCount };
    });

    await test('server-closed transport can retire before its queued native close callback', async () => {
        const db = open(newPath('server-close'), true);
        const socket = db.getSyncSocket();
        socket.open(); await turns();
        socket.error();
        socket.serverClose();
        assert.ok(diag().pendingCallbacks > baseline.pendingCallbacks);
        dispose(db);
        socket.lateEvents();
        return { listenerCountAfterClose: socket.listenerCount };
    });

    await test('socket watcher delivery may delete its native handle after registration returns', async () => {
        const db = open(newPath('watcher-delete'), true);
        const socket = db.getSyncSocket();
        let calls = 0;
        let ownerCountImmediatelyAfterDelete;
        db.watchSyncSocket(observed => {
            assert.equal(observed, socket);
            ++calls;
            dispose(db, false);
            ownerCountImmediatelyAfterDelete = diag().nativeOwners;
        });
        assert.equal(calls, 0, 'Socket watcher invoked user code inside registration');
        await until(() => calls === 1, 'deferred socket watcher');
        await turns();
        assert.equal(calls, 1);
        assert.equal(ownerCountImmediatelyAfterDelete, baseline.nativeOwners + 1);
        return { calls, ownerCountImmediatelyAfterDelete };
    });

    await test('Core handoff binds replacement socket to surviving distinct native scheduler', async () => {
        const store = newPath('handoff');
        const first = open(store, true, 1);
        const sibling = open(store, true, 2);
        const oldSocket = first.getSyncSocket();
        assert.equal(diag().nativeOwners, baseline.nativeOwners + 2);
        assert.equal(sibling.getSyncSocket(), null, 'Second native owner should begin as dormant sync sibling');
        const observed = [];
        const watcher = sibling.watchSyncSocket(socket => observed.push(socket));
        await turns();
        assert.ok(observed.includes(null), 'Watcher did not report initial dormant state');
        oldSocket.open(); await turns();
        dispose(first);
        const current = sibling.getSyncSocket();
        assert.ok(current instanceof FixtureWebSocket);
        assert.notEqual(current, oldSocket);
        await until(() => observed.includes(current), 'surviving owner exact replacement notification');
        oldSocket.lateEvents();
        current.open();
        addRows(sibling, ['handoff-upload']);
        await until(() => current.sent.some(frame => frame.decoded.auditLog?.length), 'handoff upload');
        sibling.unwatchSyncSocket(watcher);
        dispose(sibling);
        return { distinctNativeOwners: 2, observedDormantThenReplacement: true, replacementUploadFrames: current.sent.length };
    });

    await test('twenty final closes return native resources and sockets to baseline without blocking drain', async () => {
        const durations = [];
        for (let i = 0; i < 20; ++i) {
            const db = open(newPath(`cycle-${i}`), true);
            const socket = db.getSyncSocket();
            socket.open(); await turns();
            addRows(db, [`pending-unacked-${i}`]);
            await until(() => socket.sent.some(frame => frame.decoded.auditLog?.length), `cycle ${i} pending native upload`);
            assert.ok(db.getPendingSyncUploadCount() > 0, 'Fixture unexpectedly acknowledged pending writes');
            const probe = turn();
            const closeStarted = performance.now();
            assert.equal(dispose(db), 'closed');
            await probe;
            const elapsedMs = performance.now() - closeStarted;
            durations.push(elapsedMs);
            assert.ok(elapsedMs < 750, `Cycle ${i} blocked event loop for ${elapsedMs} ms; Core drain may be spinning`);
            socket.lateEvents();
            await baselineAgain(`cycle ${i}`);
        }
        return { cycles: 20, unacknowledgedWritesBeforeEachClose: true, closeAndEventLoopMs: durations, maxMs: Math.max(...durations) };
    });

    await test('managed findObject wrappers release their native owner references', async () => {
        const db = open(newPath('managed-find'), true);
        const socket = db.getSyncSocket();
        socket.open(); await turns();
        const [row] = addRows(db, ['managed-lifetime']);
        for (let i = 0; i < 5; ++i) {
            const object = db.findObject(table, row);
            assert.equal(object.isValid(), true);
            assert.equal(object.getString('name'), 'managed-lifetime');
            object.delete();
        }
        dispose(db);
        return { wrappersCreatedAndDeleted: 5, diagnosticsAfterOwnerClose: diag() };
    });

    for (const memory of [true, false]) {
        await test(`AuditLog ${memory ? 'memory' : 'named-file'} transaction emits every stored row exactly once`, async () => {
            const db = open(memory ? ':memory:' : newPath('audit-exact'));
            assert.equal(Number(db.debugQueryCount(
                `SELECT name FROM pragma_database_list WHERE name='main' AND file ${memory ? '=' : '<>'} ''`)), 1,
            'The test is not using its claimed SQLite backend');
            const observed = [];
            const subscription = db.observeAuditLog(json => observed.push(...JSON.parse(json)));
            const insertedName = 'insert α "quoted"';
            const updatedName = 'update β "quoted"';
            let object;
            db.beginWrite();
            const row = db.add(table, { name: insertedName, rank: 42 });
            try {
                object = db.findObject(table, row);
                object.setString('name', updatedName);
                assert.equal(db.remove(table, row), true);
            } finally { object?.delete(); }
            db.commitWrite();
            await until(() => observed.length > 0, 'transaction audit delivery');
            await turns();
            const stored = assertAuditRowsMatchStorage(db, observed);
            assert.equal(stored.length, 3, 'Fixture must persist INSERT, UPDATE and DELETE');
            assert.deepEqual(observed.map(entry => entry.operation), ['INSERT', 'UPDATE', 'DELETE']);
            assert.deepEqual(observed.map(entry => entry.changedFields.name.value),
                [insertedName, updatedName, updatedName]);
            assert.ok(observed.every(entry => entry.tableName === table && Number(entry.rowId) === Number(row)));
            db.removeAuditLogObserver(subscription);
            dispose(db);
            return { backend: memory ? 'SQLite memory' : 'SQLite named file in MEMFS', storedRows: stored.length, observedRows: observed.length };
        });
    }

    await test('versioned open refuses a newer schema through a normal JavaScript Error', async () => {
        const store = newPath('version-floor');
        const before = open(store, false, 2);
        addRows(before, ['preserved']);
        dispose(before);
        await turns();
        assert.throws(() => openVersioned(store, schema, '', '', 1, null), error =>
            error instanceof Error && /schema version.*newer/i.test(error.message));
        const after = open(store, false, 2);
        assert.equal(count(after), 1);
        dispose(after);
        return { rejectedWithJSError: true, originalVersionAndDataPreserved: true };
    });

    await test('named-file migration operations update real SQLite and retire the callback context', async () => {
        const store = newPath('migration');
        const migrationSchema = [
            { tableName: 'MigrationItem', properties: [
                { name: 'oldValue', type: 'string', kind: 'primitive' },
                { name: 'newValue', type: 'string', kind: 'primitive' },
            ] },
            { tableName: 'MigrationDiscard', properties: [{ name: 'name', type: 'string', kind: 'primitive' }] },
        ];
        const before = openVersioned(store, migrationSchema, '', '', 1, null);
        handles.add(before);
        before.beginWrite();
        before.add('MigrationItem', { oldValue: 'keep', newValue: '' });
        before.add('MigrationDiscard', { name: 'discard' });
        before.commitWrite();
        dispose(before);
        await turns();
        const nextSchema = [{ ...migrationSchema[0], properties: [...migrationSchema[0].properties,
            { name: 'detail', type: 'string', kind: 'primitive', nullable: true },
        ] }, migrationSchema[1]];
        let pointer;
        let callbacks = 0;
        const after = openVersioned(store, nextSchema, '', '', 2, ctx => {
            ++callbacks;
            pointer = ctx._ctx_ptr;
            assert.ok(ctx.pendingChanges.some(change => change.tableName === 'MigrationItem' && change.addedColumns.includes('detail')));
            migrationCall("_migration_rename_property", pointer, 'MigrationItem', 'oldValue', 'newValue');
            migrationCall("_migration_execute_sql", pointer, "UPDATE MigrationItem SET oldValue = 'migrated'");
            migrationCall("_migration_delete_all", pointer, 'MigrationDiscard');
        });
        handles.add(after);
        assert.equal(callbacks, 1);
        assert.equal(Number(after.debugQueryCount("SELECT id FROM MigrationItem WHERE newValue = 'keep' AND oldValue = 'migrated'")), 1);
        assert.equal(Number(after.debugQueryCount('SELECT id FROM MigrationDiscard')), 0);
        assert.throws(() => migrationCall("_migration_execute_sql", pointer, 'DELETE FROM MigrationItem'));
        assert.equal(Number(after.debugQueryCount('SELECT id FROM MigrationItem')), 1);
        dispose(after);
        await turns();
        assert.throws(() => openVersioned(store, migrationSchema, '', '', 1, null), /version|schema/i);
        return { callbacks, copiedExistingColumn: true, executedSql: true, deletedRows: true, expiredContextRefused: true, downgradeRefused: true };
    });

    await test('a throwing JavaScript migration rolls back SQL and expires its context', async () => {
        const store = newPath('refused-migration');
        const before = open(store, false, 1);
        addRows(before, ['before-refusal']);
        dispose(before);
        await turns();
        const nextSchema = [{ ...schema[0], properties: [...schema[0].properties,
            { name: 'newColumn', type: 'string', kind: 'primitive', nullable: true },
        ] }];
        let token;
        assert.throws(() => openVersioned(store, nextSchema, '', '', 2, ctx => {
            token = ctx._ctx_ptr;
            migrationCall("_migration_execute_sql", token, "UPDATE LifecycleItem SET name = 'must-roll-back'");
            throw new Error('fixture migration refusal');
        }), /fixture migration refusal/);
        assert.ok(Number.isInteger(token));
        assert.throws(() => migrationCall("_migration_delete_all", token, table));
        await turns();
        const recovered = open(store, false, 1);
        assert.equal(Number(recovered.debugQueryCount("SELECT id FROM LifecycleItem WHERE name = 'before-refusal'")), 1);
        assert.equal(Number(recovered.debugQueryCount("SELECT name FROM pragma_table_info('LifecycleItem') WHERE name = 'newColumn'")), 0);
        dispose(recovered);
        return { errorPreserved: true, sqlRolledBack: true, schemaUnchanged: true, reopened: true, expiredContextRefused: true };
    });

    await test('async migration is refused and its resumed token cannot mutate the store', async () => {
        const store = newPath('migration-async');
        const before = open(store, false, 1);
        addRows(before, ['before']);
        dispose(before);
        await turns();
        const nextSchema = [{ ...schema[0], properties: [...schema[0].properties,
            { name: 'detail', type: 'string', kind: 'primitive', nullable: true },
        ] }];
        let resumedError;
        assert.throws(() => openVersioned(store, nextSchema, '', '', 2, async ctx => {
            migrationCall('_migration_execute_sql', ctx._ctx_ptr, "UPDATE LifecycleItem SET name = 'must-roll-back'");
            await Promise.resolve();
            try { migrationCall('_migration_delete_all', ctx._ctx_ptr, table); }
            catch (error) { resumedError = error; }
        }), /synchronously/);
        await turns();
        assert.match(String(resumedError), /no longer active/);
        const reopened = open(store, false, 1);
        assert.equal(reopened.objects(table, null, null, null, null)[0].name, 'before');
        dispose(reopened);
        return { asyncRefused: true, resumedMutationRefused: true, originalDataPreserved: true };
    });

    await test('native SQL errors during migration preserve their error and roll back earlier writes', async () => {
        const store = newPath('migration-sql-error');
        const before = open(store, false, 1);
        addRows(before, ['before-sql-error']);
        dispose(before);
        await turns();
        const nextSchema = [{ ...schema[0], properties: [...schema[0].properties,
            { name: 'afterError', type: 'string', kind: 'primitive', nullable: true },
        ] }];
        let token;
        assert.throws(() => openVersioned(store, nextSchema, '', '', 2, ctx => {
            token = ctx._ctx_ptr;
            migrationCall('_migration_execute_sql', token, "UPDATE LifecycleItem SET name = 'must-roll-back'");
            migrationCall('_migration_execute_sql', token, 'UPDATE MissingMigrationTable SET name = 1');
        }), /no such table|MissingMigrationTable/);
        assert.throws(() => migrationCall('_migration_delete_all', token, table), /no longer active/);
        await turns();
        const recovered = open(store, false, 1);
        assert.equal(Number(recovered.debugQueryCount("SELECT id FROM LifecycleItem WHERE name = 'before-sql-error'")), 1);
        assert.equal(Number(recovered.debugQueryCount("SELECT name FROM pragma_table_info('LifecycleItem') WHERE name = 'afterError'")), 0);
        dispose(recovered);
        return { nativeErrorPreserved: true, earlierWriteRolledBack: true, schemaUnchanged: true, reopened: true };
    });

    await test('AuditLog named-file link changes emit every model and junction row exactly once', async () => {
        const linkSchema = [{ ...schema[0], properties: [...schema[0].properties,
            { name: 'children', type: 'object', kind: 'list', targetTable: table },
        ] }];
        const db = new module.Lattice(newPath('audit-links'), linkSchema);
        handles.add(db);
        const observed = [];
        const subscription = db.observeAuditLog(json => observed.push(...JSON.parse(json)));
        const [parentId, childId] = addRows(db, ['parent', 'child']);
        const parent = db.findObject(table, parentId);
        const child = db.findObject(table, childId);
        const list = parent.getLinkList('children');
        try {
            assert.equal(list.isValid(), true);
            list.push_back(child);
            assert.equal(Number(list.size()), 1);
        } finally {
            list.delete(); child.delete(); parent.delete();
        }
        await until(() => observed.length > 0, 'link audit delivery');
        await turns();
        const stored = assertAuditRowsMatchStorage(db, observed);
        assert.ok(stored.length > 2, 'Fixture did not persist a junction audit row');
        assert.ok(observed.some(entry => entry.tableName.startsWith('_') && entry.operation === 'INSERT'));
        db.removeAuditLogObserver(subscription);
        dispose(db);
        return { storedRows: stored.length, observedRows: observed.length, includesJunctionInsert: true };
    });
    await test('server receive acknowledges duplicate deliveries without replaying or duplicating observations', async () => {
        const source = open(), target = open();
        addRows(source, ['received-one', 'received-two']);
        await turns();
        const entries = JSON.parse(source.eventsAfter('')).filter(entry => entry.tableName === table);
        assert.equal(entries.length, 2);
        const ids = entries.map(entry => entry.globalId);
        const message = module.createSyncMessage(JSON.stringify(entries));
        const changes = [], audits = [];
        const tableObserver = target.observeTable(table, change => changes.push(change));
        const auditObserver = target.observeAuditLog(json => audits.push(...JSON.parse(json)));
        assert.deepEqual(JSON.parse(target.receive(message)), ids);
        await until(() => changes.length === 2 && audits.length === 2, 'committed remote receive observations');
        assert.equal(count(target), 2);
        assert.ok(audits.every(entry => entry.isFromRemote && entry.isSynchronized));
        assert.deepEqual(audits.map(entry => entry.globalId), ids);
        assert.deepEqual(JSON.parse(target.receive(message)), ids, 'Redelivery must acknowledge already committed IDs');
        assert.deepEqual(JSON.parse(target.receive('invalid-json')), []);
        await turns();
        assert.equal(changes.length, 2, 'Duplicate delivery must not emit another model mutation');
        assert.equal(audits.length, 2, 'Duplicate delivery must not insert duplicate audit rows');
        assert.equal(Number(target.debugQueryCount('SELECT id FROM AuditLog')), 2);
        assert.equal(Number(target.debugQueryCount('SELECT id FROM _SyncControl WHERE disabled=0')), 1);
        target.removeTableObserver(table, tableObserver);
        target.removeAuditLogObserver(auditObserver);
        dispose(target); dispose(source);
        return { duplicateIDsAcknowledged: true, duplicateEffectsSuppressed: true, postCommitObservation: true, malformedFrameReturnsEmpty: true, triggerGateRestored: true };
    });

    await test('server receive applies acknowledgments without emitting an acknowledgment echo', async () => {
        const db = open();
        addRows(db, ['awaiting-ack']);
        await turns();
        const entries = JSON.parse(db.eventsAfter('')).filter(entry => entry.tableName === table);
        assert.equal(entries.length, 1);
        const ids = entries.map(entry => entry.globalId);
        assert.equal(Number(db.getPendingSyncUploadCount()), 1);
        const changes = [];
        const observer = db.observeTable('AuditLog', change => changes.push(change));
        const ack = module.createAckMessage(JSON.stringify(ids));
        assert.deepEqual(JSON.parse(db.receive(ack)), [], 'ACK frames must never be acknowledged in return');
        await until(() => changes.some(change => change.operation === 'UPDATE'), 'ACK bookkeeping observation');
        assert.equal(Number(db.getPendingSyncUploadCount()), 0);
        assert.equal(Number(db.debugQueryCount('SELECT id FROM AuditLog WHERE isSynchronized=1')), 1);
        assert.deepEqual(JSON.parse(db.receive(ack)), []);
        assert.equal(count(db), 1);
        db.removeTableObserver('AuditLog', observer);
        dispose(db);
        return { ackReturnsNoIDs: true, repeatedAckReturnsNoIDs: true, uploadBookkeepingApplied: true, auditUpdateObserved: true };
    });

    const explicitRuntime = await prepareExplicitRuntime(path.dirname(output));
    receipt.explicitModels = explicitRuntime.receipt;
    await explicitRuntime.run({ module, test, newPath, register: db => handles.add(db), dispose });
} catch (error) {
    failure = error?.stack ?? String(error);
} finally {
    // Cleanup is bounded and preserves the original failure in the receipt.
    for (const db of [...handles]) {
        try { dispose(db); } catch (error) { asyncErrors.push(`cleanup: ${error?.stack ?? String(error)}`); }
    }
    await turns();
    clearTimeout(watchdog);
    process.off('uncaughtException', onAsyncError);
    process.off('unhandledRejection', onAsyncError);
    Object.assign(console, oldConsole);
    const passed = !failure && asyncErrors.length === 0 && fatalLogs.length === 0 && reports.length === 39 && reports.every(test => test.passed);
    const result = {
        passed, scope, receipt, baseline, final: diag(), elapsedMs: performance.now() - started,
        tests: reports, failure, asyncErrors, fatalLogs,
        fixture: { socketsCreated: FixtureWebSocket.instances.length, remainingHandles: handles.size },
        boundedLogs: { retained: logs, dropped: droppedLogs },
    };
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ passed, tests: reports.length, failed: reports.filter(test => !test.passed).map(test => test.name), output, failure }) + '\n');
    process.exitCode = passed ? 0 : 1;
}
