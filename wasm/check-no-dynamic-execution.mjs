// Execute the actual compiled glue/WASM with V8 string code generation denied.
// This is a runtime regression, not browser CSP or remote sync qualification.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

if (process.argv.length !== 4) {
    throw new Error('Usage: node --experimental-vm-modules wasm/check-no-dynamic-execution.mjs LOADER WASM');
}
const loaderPath = resolve(process.argv[2]);
const wasmPath = resolve(process.argv[3]);
const loader = readFileSync(loaderPath, 'utf8');
const wasm = readFileSync(wasmPath);
const logs = [];
let networkCalls = 0;
const denyNetwork = () => {
    networkCalls++;
    throw new Error('Network is unavailable in the in-memory regression');
};
const context = vm.createContext({
    window: {}, URL, TextDecoder, TextEncoder, crypto: webcrypto, performance,
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    fetch: denyNetwork, WebSocket: denyNetwork, XMLHttpRequest: denyNetwork,
    setTimeout, clearTimeout, setInterval, clearInterval,
}, { codeGeneration: { strings: false, wasm: true } });

// Prove the engine-level restriction is active rather than replacing Function
// in a way that the generated glue could accidentally bypass.
for (const source of ["eval('1')", "new Function('return 1')()"]) {
    assert.throws(() => vm.runInContext(source, context), /Code generation from strings disallowed/);
}
const module = new vm.SourceTextModule(loader, {
    context, identifier: pathToFileURL(loaderPath).href,
    initializeImportMeta: meta => { meta.url = pathToFileURL(loaderPath).href; },
});
await module.link(() => { throw new Error('Unexpected generated-loader import'); });
await module.evaluate({ timeout: 10000 });
const latticeModule = await module.namespace.default({ wasmBinary: new Uint8Array(wasm) });
assert.equal(latticeModule.getWasmVersion(), 'opfs-vfs-v3');

// Exercise Embind's constructors, val/property access, methods, BigInt returns,
// arrays and JS callbacks through actual SQLite-backed C++ operations.
const database = new latticeModule.Lattice(':memory:', [{
    tableName: 'StrictCodegenProbe', properties: [
        { name: 'name', type: 'string', nullable: false },
        { name: 'score', type: 'int', nullable: false },
    ],
}]);
const changes = [];
const observer = database.observeTable('StrictCodegenProbe', change => changes.push(change));
assert.notEqual(Number(observer), 0);
try {
    const id = database.add('StrictCodegenProbe', { name: 'CSP-safe', score: 42 });
    assert.equal(typeof id, 'bigint');
    const found = database.find('StrictCodegenProbe', id);
    assert.equal(found.name, 'CSP-safe');
    assert.equal(Number(found.score), 42);
    const rows = database.objects('StrictCodegenProbe', null, null, null, null, null, null);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'CSP-safe');
    assert.equal(Number(database.count('StrictCodegenProbe', null, null, null)), 1);
    assert.equal(database.remove('StrictCodegenProbe', id), true);
    assert.equal(Number(database.count('StrictCodegenProbe', null, null, null)), 0);
    const deadline = Date.now() + 1000;
    while (changes.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(changes.length, 2);
    assert.ok(changes.every(change => Number(change.rowId) === Number(id)));
} finally {
    database.removeTableObserver('StrictCodegenProbe', observer);
    database.delete();
}
assert.equal(networkCalls, 0);
const record = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
console.log(JSON.stringify({
    schema: 'lattice.wasm.no-dynamic-codegen/1', status: 'passed',
    javascriptStringCodeGeneration: false, wasmCodeGeneration: true,
    loader: record(Buffer.from(loader)), wasm: record(wasm),
    inMemoryCRUD: true, tableObserverCallbacks: changes.length, networkCalls, runtimeLogLines: logs.length,
    browserCSPQualified: false, remoteSyncQualified: false,
}, null, 2));
