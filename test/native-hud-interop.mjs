// Actual native HUD file -> candidate Wasm -> closed SQLite copy. The separate
// Swift verify-returned test is required before claiming bidirectional parity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';

const args = new Map();
const required = ['--fixture', '--output-dir', '--hud-repo', '--core-repo', '--build', '--runtime-receipt'];
for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    assert.ok(required.includes(key) && value && !value.startsWith('--') && !args.has(key), `Invalid argument ${key}`);
    assert.ok(path.isAbsolute(value), `${key} requires an absolute localdev path`);
    args.set(key, path.resolve(value));
}
assert.equal(args.size, required.length, `Required: ${required.join(', ')}`);
const localdev = fs.realpathSync('/Users/jason/localdev');
function inLocaldev(file, existing = true) {
    const actual = existing ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    assert.ok(actual.startsWith(localdev + path.sep), `Path must stay under localdev: ${file}`);
    return actual;
}
for (const [key, value] of args) inLocaldev(value, key !== '--output-dir');
const fixture = args.get('--fixture'), out = args.get('--output-dir'), hud = args.get('--hud-repo');
const core = args.get('--core-repo'), build = args.get('--build');
assert.ok(!fs.existsSync(out), 'Output directory must be new; never overwrite a prior receipt');
const destination = path.join(fixture, 'wasm-returned.lattice');
assert.ok(!fs.existsSync(destination), 'Returned fixture already exists; preserve the prior evidence');
fs.mkdirSync(out);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const describe = file => { const bytes = fs.readFileSync(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (directory, ...argv) => execFileSync('git', ['-C', directory, ...argv], { encoding: 'utf8' }).trim();
const source = directory => ({ path: directory, head: git(directory, 'rev-parse', 'HEAD'),
    branch: git(directory, 'branch', '--show-current'), status: git(directory, 'status', '--short'),
    trackedDiffSHA256: sha(git(directory, 'diff', '--binary', 'HEAD')) });
const inputNames = ['manifest.json', 'portable-contract.json', 'baseline.lattice', 'native-reference.lattice'];
const inputs = Object.fromEntries(inputNames.map(name => [name, describe(path.join(fixture, name))]));
const manifest = readJSON(inputs['manifest.json'].path), contract = readJSON(inputs['portable-contract.json'].path);
assert.equal(inputs['baseline.lattice'].sha256, manifest.baselineSHA256);
assert.equal(inputs['native-reference.lattice'].sha256, manifest.nativeReferenceSHA256);
for (const name of ['baseline.lattice', 'native-reference.lattice']) {
    for (const suffix of ['-wal', '-journal']) {
        const pending = path.join(fixture, name + suffix);
        assert.ok(!fs.existsSync(pending) || fs.statSync(pending).size === 0, `Fixture is not checkpointed: ${pending}`);
    }
}
const js = describe(path.join(build, 'lattice.js')), wasm = describe(path.join(build, 'lattice.wasm'));
const prior = readJSON(args.get('--runtime-receipt'));
assert.equal(prior.passed, true, 'First qualify the same artifact with the combined 39-case runtime harness');
assert.equal(prior.tests.length, 39);
assert.ok(prior.tests.every(test => test.passed === true), 'Every native case must pass');
for (const name of [
    'detached native capture preserves primitive codecs and linked cycles without wrappers',
    'detached capture refuses outer transactions and preflight failures then allows ordinary writes',
    'detached capture refuses malformed junctions and table observers invalidate links and NoHistory',
]) assert.ok(prior.tests.some(test => test.name === name), `Missing native qualification: ${name}`);
assert.equal(prior.receipt.js.sha256, js.sha256);
assert.equal(prior.receipt.wasm.sha256, wasm.sha256);
const sourcePaths = ['src/lattice.ts', 'src/decorators.ts', 'src/explicit-models.ts', 'src/explicit-values.ts',
    'src/storage.ts', 'src/types.ts', 'src/capture-values.ts', 'wasm/bindings.cpp', 'wasm/capture-values.hpp', 'test/native-hud-interop.mjs',
    'test/fixtures/native-hud-interop-runtime.ts', 'test/fixtures/native-hud-interop-values.ts', 'test/fixtures/native-hud-junctions.py'];
const receipt = { startedAt: new Date().toISOString(), inputs, candidate: { js, wasm, runtimeGate: describe(args.get('--runtime-receipt')),
    latticeJS: source(repo), core: source(core), hud: source(hud),
    files: sourcePaths.map(name => describe(path.join(repo, name))),
    hudAdapter: describe(path.join(hud, 'Browser/src/lattice-models.ts')),
    hudGeneratedStorage: describe(path.join(hud, 'Browser/src/generated/storage.ts')),
    coreFiles: ['Sources/LatticeSwiftCppBridge/src/dynamic_object.cpp', 'Sources/LatticeSwiftCppBridge/include/dynamic_object.hpp',
        'Sources/LatticeSwiftCppBridge/include/lattice.hpp', 'Sources/LatticeCore/src/sync.cpp',
        'Sources/LatticeCore/include/lattice/sync.hpp', 'Sources/LatticeCore/include/lattice/lattice.hpp'].map(name => describe(path.join(core, name))) },
    native: { pins: manifest.nativeDependencyPins, recordedHUDDependencyPins: manifest.recordedHUDDependencyPins,
        packageResolvedRole: manifest.packageResolvedRole, candidateBuildManifestSHA256: manifest.candidateBuildManifestSHA256,
        candidateSourceProvenanceSHA256: manifest.candidateSourceProvenanceSHA256, sourceCommit: manifest.callerRecordedSourceCommit,
        registryHash: manifest.registryHash, contractHash: manifest.contractHash, packageResolvedSHA256: manifest.packageResolvedSHA256 } };
const logs = [], asyncErrors = [], fatalLogs = [];
let droppedLogs = 0, module, observations, baseline, final, failure, output;
const previousConsole = { log: console.log, warn: console.warn, error: console.error };
const recordLog = (...values) => {
    const text = values.map(String).join(' ').slice(0, 1800);
    if (/SCHEDULER EXCEPTION|Aborted\(|RuntimeError:|Deferred Lattice release failed|Lattice release failed/.test(text)) fatalLogs.push(text);
    if (logs.length < 240) logs.push(text); else ++droppedLogs;
};
const diagnosticKeys = ['nativeOwners', 'retainedHandles', 'schedulers', 'pendingCallbacks', 'nativeDatabases'];
const diagnostics = () => Object.fromEntries(diagnosticKeys.map(key => [key, Number(module._lifecycleDiagnostics()[key])]));
const settle = async () => { for (let i = 0; i < 10; ++i) await new Promise(resolve => setTimeout(resolve, 0)); };
const onError = error => asyncErrors.push(error?.stack ?? String(error));
const reportPath = path.join(out, 'receipt.json');
const scope = { actualNativeHUDFile: true, exactGeneratedModels: true, actualWasmSQLite: true,
    nativeSwiftReadOnlyOracle: 'pending; run verify-returned separately', browser: false, publicOpenLoader: false,
    opfs: false, network: false, ownerStores: false, installedRuntimeParity: false, releaseQualification: false };
const writeReport = passed => fs.writeFileSync(reportPath, JSON.stringify({ passed, scope, receipt, observations, output,
    baseline, final, failure, asyncErrors, fatalLogs, boundedLogs: { retained: logs, dropped: droppedLogs } }, null, 2) + '\n');
process.on('uncaughtException', onError); process.on('unhandledRejection', onError);
const watchdog = setTimeout(() => { failure = 'Consumer exceeded 45-second bound'; writeReport(false); process.exit(2); }, 45000);
try {
    const built = await bundle({ entryPoints: [path.join(repo, 'test/fixtures/native-hud-interop-runtime.ts')],
        bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false,
        plugins: [{ name: 'native-hud-fixture-imports', setup(api) {
            api.onResolve({ filter: /^hud-native-fixture-adapter$/ }, () => ({ path: 'adapter', namespace: 'native-hud' }));
            api.onLoad({ filter: /.*/, namespace: 'native-hud' }, () => ({ contents:
                `export { createHUDLatticeDefinition } from ${JSON.stringify(path.join(hud, 'Browser/src/lattice-models.ts'))};\n` +
                `export { HUD_REGISTRY_HASH } from ${JSON.stringify(path.join(hud, 'Browser/src/generated/registry.ts'))};`, resolveDir: hud }));
            api.onResolve({ filter: /lattice\.(js|wasm)\?url$/ }, args => ({ path: args.path, namespace: 'unused-url' }));
            api.onLoad({ filter: /.*/, namespace: 'unused-url' }, () => ({ contents: 'export default "unused-native-fixture-loader";' }));
        } }] });
    const prepared = path.join(out, 'native-hud-runtime.mjs');
    fs.writeFileSync(prepared, built.outputFiles[0].contents);
    receipt.bundle = describe(prepared);
    const runtime = await import(pathToFileURL(prepared).href);
    // Reject stale descriptors and unsupported mutation shapes before any native open.
    runtime.prepareNativeHUDInterop(manifest, contract);
    globalThis.window = globalThis; globalThis.self = globalThis;
    globalThis.location = new URL('https://native-hud-fixture.invalid/');
    globalThis.document = { currentScript: { src: pathToFileURL(js.path).href } };
    globalThis.fetch = async () => { throw new Error('Network disabled in native HUD fixture consumer'); };
    globalThis.WebSocket = class { constructor() { throw new Error('No sync socket is authorized by the fixture'); } };
    console.log = console.warn = console.error = recordLog;
    const savedProcess = globalThis.process;
    try {
        globalThis.process = undefined;
        const imported = await import(pathToFileURL(js.path).href + `?sha256=${js.sha256}`);
        module = await imported.default({ wasmBinary: fs.readFileSync(wasm.path),
            locateFile: name => pathToFileURL(path.join(build, name)).href,
            print: recordLog, printErr: recordLog, onAbort: reason => fatalLogs.push(`Aborted(${reason})`) });
    } finally { globalThis.process = savedProcess; }
    module._lattice_set_log_level(0); module.FS.mkdir('/native-hud-fixture');
    const filePath = '/native-hud-fixture/consumer.lattice';
    const baselineBytes = fs.readFileSync(inputs['baseline.lattice'].path);
    module.FS.writeFile(filePath, baselineBytes);
    await settle(); baseline = diagnostics();
    const inspectJunctions = async ({ stage, snapshot, tables, filePath }) => {
        assert.ok(['baseline', 'returned'].includes(stage));
        for (const suffix of ['-wal', '-journal']) {
            const pending = filePath + suffix;
            assert.ok(!module.FS.analyzePath(pending).exists || module.FS.stat(pending).size === 0, 'Junction inspection requires a checkpointed copy');
        }
        const copy = path.join(out, `junction-${stage}.lattice`), request = path.join(out, `junction-${stage}-request.json`);
        fs.writeFileSync(copy, module.FS.readFile(filePath), { flag: 'wx' });
        const expected = snapshot.rows.filter(row => tables.includes(row.table));
        fs.writeFileSync(request, JSON.stringify({ tables, rows: expected }), { flag: 'wx' });
        const inspected = JSON.parse(execFileSync('python3', [path.join(repo, 'test/fixtures/native-hud-junctions.py'), copy, request],
            { encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TMPDIR: out } }));
        const normalized = rows => rows.map(row => ({ table: row.table, globalId: row.globalId ?? null, localId: row.localId ?? null,
            fields: Object.fromEntries(Object.entries(row.fields).map(([name, cell]) => [name,
                ['float64', 'unixSeconds'].includes(cell.kind) ? { kind: cell.kind, bits: cell.bits } : cell]))
        })).sort((a, b) => `${a.table}|${a.globalId ?? a.localId}`.localeCompare(`${b.table}|${b.globalId ?? b.localId}`));
        assert.deepEqual(normalized(inspected.rows), normalized(expected), `${stage} actual physical junction rows`);
        assert.equal(inspected.fileSHA256, describe(copy).sha256);
        fs.writeFileSync(path.join(out, `junction-${stage}-inspection.json`), JSON.stringify(inspected, null, 2) + '\n', { flag: 'wx' });
        return { rows: inspected.rows.length, tables, readOnlySQLiteCopy: true, sqliteVersion: inspected.sqliteVersion,
            checkpointedCopy: describe(copy), noInventedRowIDs: true };
    };
    observations = await runtime.runNativeHUDInterop({ module, manifest, contract, filePath, inspectJunctions });
    await settle(); final = diagnostics();
    assert.deepEqual(final, baseline, 'Consumer retained native resources after close');
    assert.equal(asyncErrors.length, 0); assert.equal(fatalLogs.length, 0);
    const returned = module.FS.readFile(filePath);
    for (const suffix of ['-wal', '-journal']) {
        const pending = filePath + suffix;
        assert.ok(!module.FS.analyzePath(pending).exists || module.FS.stat(pending).size === 0, 'Returned file retains uncheckpointed changes');
    }
    assert.equal(Buffer.from(returned).subarray(0, 16).toString(), 'SQLite format 3\u0000');
    for (const record of Object.values(inputs)) assert.equal(describe(record.path).sha256, record.sha256, 'Original native fixture changed');
    assert.equal(describe(js.path).sha256, js.sha256); assert.equal(describe(wasm.path).sha256, wasm.sha256);
    fs.writeFileSync(destination, returned, { flag: 'wx' });
    output = describe(destination);
} catch (error) { failure = error?.stack ?? String(error); }
finally {
    clearTimeout(watchdog);
    process.off('uncaughtException', onError); process.off('unhandledRejection', onError);
    Object.assign(console, previousConsole);
    for (const record of Object.values(inputs)) if (describe(record.path).sha256 !== record.sha256) failure = `${failure ?? ''}\nOriginal input changed: ${record.path}`;
    const passed = !failure && asyncErrors.length === 0 && fatalLogs.length === 0 && !!output;
    writeReport(passed);
    process.stdout.write(JSON.stringify({ passed, report: reportPath, returned: output?.path, failure }) + '\n');
    process.exitCode = passed ? 0 : 1;
}
