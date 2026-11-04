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
import { localdevPaths, nativeInvocationQualification, nativeSourcePrefix } from './fixtures/native-hud-interop-inputs.mjs';

const args = new Map();
const required = ['--fixture', '--output-dir', '--hud-repo', '--core-repo', '--build', '--runtime-receipt',
    '--native-repo', '--native-source-receipt', '--native-admission', '--native-qualification'];
for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    assert.ok(required.includes(key) && value && !value.startsWith('--') && !args.has(key), `Invalid argument ${key}`);
    assert.ok(path.isAbsolute(value), `${key} requires an absolute localdev path`);
    args.set(key, path.resolve(value));
}
assert.equal(args.size, required.length, `Required: ${required.join(', ')}`);
const inLocaldev = localdevPaths();
for (const [key, value] of args) inLocaldev(value, key !== '--output-dir');
const fixture = args.get('--fixture'), out = args.get('--output-dir'), hud = args.get('--hud-repo');
const core = args.get('--core-repo'), build = args.get('--build'), nativeHUD = args.get('--native-repo');
assert.ok(!fs.existsSync(out), 'Output directory must be new; never overwrite a prior receipt');
const destination = path.join(fixture, 'wasm-returned.lattice');
assert.ok(!fs.existsSync(destination), 'Returned fixture already exists; preserve the prior evidence');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const describe = file => { const bytes = fs.readFileSync(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputNames = ['manifest.json', 'portable-contract.json', 'baseline.lattice', 'native-reference.lattice'];
const inputs = Object.fromEntries(inputNames.map(name => [name, describe(path.join(fixture, name))]));
const manifest = readJSON(inputs['manifest.json'].path), contract = readJSON(inputs['portable-contract.json'].path);
assert.equal(manifest.formatVersion, 2, 'Format1 evidence requires its preserved original consumer');
// Actual53 scoped and repaired-Core runtime qualification; native source/export admission below
// remains independently unbound. Preserve exact receipt, source, artifact pins
// and ordered case identities; historical39/45/49 receipts cannot satisfy this gate.
const NATIVE17_RUNTIME_QUALIFICATION = Object.freeze({
    "receipt": {
        "bytes": 54674,
        "sha256": "b3edf90accbc9b994d5698666a1c33bc9815cf8560be06b551e22d0c904296ee"
    },
    "harness": {
        "bytes": 44215,
        "sha256": "6e453e33e71b3388f2ea89bfc04a29596a5eabee6fdceb04257c77d163b5440d"
    },
    "scopedFixture": {
        "bytes": 8187,
        "sha256": "f99ee70e70e965f8c07d2b7e31d5fbf60c52becdcb8579818beaf15f9475669a"
    },
    "unionFixture": {
        "bytes": 23799,
        "sha256": "fdc8cd7d6b2cd1787b8a4c1705087d888a4e3001e0443e0397457eb6720a9bb2"
    },
    "js": {
        "bytes": 142162,
        "sha256": "d40a8010b371db6034cb897bbebaf64622e420efb9de387551752ac5224572b7"
    },
    "wasm": {
        "bytes": 3768578,
        "sha256": "b49154382e16941047175e1dda5dfc36031c56cbef185b5fa3024d7fea011a86"
    },
    "caseNames": [
        "unknown native descriptor capabilities refuse before opening or migrating a file",
        "queued table and object unsubscribe suppresses real native delivery",
        "table callback self-unsubscribes after first row of a native batch",
        "AuditLog repeated unsubscribe releases once and disables queued copies",
        "closing cached handle A retires only A observers and preserves B",
        "closing older progress subscriber preserves newer cached subscriber",
        "direct native delete inside observer defers final destruction safely",
        "exact cached transport identity excludes another store at identical URL",
        "queued transport messages and old events cannot reach replacement owner",
        "server-closed transport can retire before its queued native close callback",
        "socket watcher delivery may delete its native handle after registration returns",
        "Core handoff binds replacement socket to surviving distinct native scheduler",
        "twenty final closes return native resources and sockets to baseline without blocking drain",
        "managed findObject wrappers release their native owner references",
        "AuditLog memory transaction emits every stored row exactly once",
        "AuditLog named-file transaction emits every stored row exactly once",
        "versioned open refuses a newer schema through a normal JavaScript Error",
        "named-file migration operations update real SQLite and retire the callback context",
        "a throwing JavaScript migration rolls back SQL and expires its context",
        "async migration is refused and its resumed token cannot mutate the store",
        "native SQL errors during migration preserve their error and roll back earlier writes",
        "AuditLog named-file link changes emit every model and junction row exactly once",
        "server receive acknowledges duplicate deliveries without replaying or duplicating observations",
        "server receive applies acknowledgments without emitting an acknowledgment echo",
        "explicit model scalar codecs round-trip actual Wasm SQLite without constructor hydration",
        "explicit row IDs reject unsafe native integers rather than rounding",
        "explicit compound constraints preserve rows and allow a failed insert to retry",
        "explicit model links preserve native presence nullability and target codecs",
        "explicit unions preserve exact cases and Int64 values through actual managed hydration",
        "explicit union switches clear inactive columns and optional values persist across reopen",
        "raw union bridge rejects malformed values and detects unreadable references without corrupting prior data",
        "union parent legacy-real triggers repair on Wasm reopen without losing rows or replay",
        "union parent incomplete-reference triggers repair on Wasm reopen without losing rows or replay",
        "union replay accepts canonical and legacy case spelling and refuses ambiguity before dedupe",
        "NoHistory stores valueless updates and late-binds marked nullable clears through Core receive",
        "Core receive preserves legacy NoHistory placeholders and refuses clears of required columns",
        "opaque pending rescue preserves Int64 extrema through two rescues and Core server receive",
        "pending import late-binds NoHistory clears and retains legacy and required-null guards",
        "pending import deduplicates known IDs and refuses malformed or unknown schema entries",
        "detached native capture preserves primitive codecs and linked cycles without wrappers",
        "detached capture refuses outer transactions and preflight failures then allows ordinary writes",
        "detached capture refuses malformed junctions and table observers invalidate links and NoHistory",
        "detached scalar capture statement work is independent of selected cells and row count",
        "detached cross-table links reuse identities with nullable repeated targets and no per-parent SQL",
        "detached junction aliases preserve canonical stored identity spelling",
        "detached aggregate preflight admits empty wide schemas and exact physical cell limits",
        "detached aggregate preflight enforces one byte budget across selected tables",
        "detached aggregate type admission checks late rows while preserving nullable nulls",
        "scoped actual native four-chunk copy is owned after mutation and final disposal",
        "scoped actual native indexed pages preserve original row order and exact continuation",
        "scoped actual native preflight and query errors refuse without poisoning following reads",
        "scoped actual native fence carries exact audit identity and reports closed owner",
        "scoped empty queries differ from closed-owner failures on both native request paths"
    ]
});
// Exact current remote graph from original10b6 resolution. This is not a fresh
// Native17 invocation or exporter receipt; those separate bindings remain unset.
const NATIVE17_FIXED_DEPENDENCY_PINS = Object.freeze({
    "profile": "hud-native17-sdk918-corec089-v1",
    "remoteLockSHA256": "98930dbee89aafe4cbcfcd41ca905b8ab576e94828480d854c64f4c18e4fdcc8",
    "lattice": "revision@918792d7414dd765e61e89cbe93581331fd3b3c3",
    "latticecore": "revision@c089b94a53f52eda843e9c1480b9c1c79f3921ef",
    "swift-sdk": "revision@82951cc9cd05de216e8dd6425f951ce31d76fa0a"
});
// Exact current Native owner graph at8b2c; independent of the retained c089 Wasm pair.
const NATIVE17_CURRENT_DEPENDENCY_PINS = Object.freeze({
    "profile": "hud-native17-sdk6c6-core2d-v1",
    "remoteLockSHA256": "7f67c05fd3b9ed51c678156cf6124e147cddef3faa769432608201049ae41676",
    "lattice": "revision@6c6e1c120562861a2e26d44f114e963c0209bacd",
    "latticecore": "revision@2d693dcf4f14a32699e02d901480312e3d90cdb4",
    "swift-sdk": "revision@82951cc9cd05de216e8dd6425f951ce31d76fa0a"
});
// Actual invocation data, recorded after native generation; this does not grant execution.
// The original prepared consumer's null pins remain preserved in its source packet.
const invocationBinding = describe(args.get('--native-qualification'));
const NATIVE17_INVOCATION_QUALIFICATION = nativeInvocationQualification(readJSON(invocationBinding.path));
const NATIVE17_SOURCE_PATHS = Object.freeze([
    "Sources/HUDSchema/Models.swift",
    "Sources/HUDSchema/Behaviour.swift",
    "Sources/HUDSchema/PortableContract.swift",
    "Sources/HUDSchema/DateFormat.swift",
    "Sources/HUDSchema/NativeSources.swift",
    "Sources/HUDSchema/StoredNotification.swift",
    "Sources/HUDSchema/Registry.swift",
    "Sources/HUDActivityKit/Notification.swift",
    "Sources/HUDSchema/AssetModels.swift",
    "Sources/HUDSchema/Assets.swift",
    "Sources/HUDSchema/SVGResourceModels.swift",
    "Sources/HUDSchema/SVGResourcePackage.swift",
    "Sources/HUDSchema/NativeDocumentModels.swift",
    "Sources/HUDSchema/NativeDocuments.swift",
    "Sources/HUDSchema/DeterministicID.swift",
    "Sources/HUDCore/AssetStore.swift",
    "Sources/HUDCore/SVGPackageStore.swift",
    "Sources/HUDCore/NativeDocumentStore.swift"
]);
const NATIVE17_MANIFEST_FIELDS = Object.freeze([
    "baseline",
    "baselineAudit",
    "baselineLateBoundAudit",
    "baselineSHA256",
    "callerRecordedSourceCommit",
    "candidateRuntimeQualification",
    "cellEncoding",
    "contractHash",
    "expectedReturned",
    "formatVersion",
    "mutations",
    "nativeDependencyPins",
    "nativeMutationAudit",
    "nativeMutationLateBoundAudit",
    "nativeReferenceSHA256",
    "openConfiguration",
    "packageResolvedSHA256",
    "purpose",
    "registryHash",
    "sourceFileSHA256",
    "unionCaseCoverage"
]);
function native17Profile(value, exportedContract) {
    const qualified = NATIVE17_INVOCATION_QUALIFICATION;
    assert.deepEqual(Object.keys(value).sort(), [...NATIVE17_MANIFEST_FIELDS].sort(), 'Native17 manifest fields changed');
    assert.equal(value.formatVersion, 2);
    assert.equal(exportedContract.formatVersion, 1);
    assert.equal(value.registryHash, "483af47f0aebcdec1d0c32a951fd354d9583f5c20f5319629abdeb3803736241");
    assert.equal(exportedContract.registryHash, value.registryHash);
    assert.equal(value.contractHash, "4db6c1becab0ccb3875fe21bf564a6ea156e633d8050f8d59664c9c43d36fb55");
    assertRuntimePin(inputs['portable-contract.json'], qualified.fixtureContract, 'Native17 actual fixture contract');
    assertRuntimePin(inputs['manifest.json'], qualified.manifest, 'Native17 actual manifest');
    assertRuntimePin(inputs['baseline.lattice'], qualified.baseline, 'Native17 actual baseline');
    assertRuntimePin(inputs['native-reference.lattice'], qualified.nativeReference, 'Native17 actual native reference');
    assert.match(qualified.callerRecordedSourceCommit ?? '', /^[a-f0-9]{40}$/, 'Native17 actual caller lineage is unbound');
    assert.equal(value.callerRecordedSourceCommit, qualified.callerRecordedSourceCommit,
        'Caller-recorded lineage differs; it is not the native invocation source identity');

    const sourceReceipt = describe(args.get('--native-source-receipt'));
    const admission = describe(args.get('--native-admission'));
    assertRuntimePin(sourceReceipt, qualified.sourceReceipt, 'Native17 actual invocation source receipt');
    assertRuntimePin(admission, qualified.admission, 'Native17 actual invocation admission');
    const source = readJSON(sourceReceipt.path), admitted = readJSON(admission.path);
    const sourcePrefix = nativeSourcePrefix(source, nativeHUD, qualified.sourceLayout, inLocaldev);
    assert.equal(admitted.sourceReceiptSHA256, sourceReceipt.sha256);
    assert.match(qualified.dependencyAdmissionSHA256 ?? '', /^[a-f0-9]{64}$/, 'Native17 dependency admission is unbound');
    assert.equal(admitted.dependencies.sha256, qualified.dependencyAdmissionSHA256);
    const dependencyPins = [NATIVE17_FIXED_DEPENDENCY_PINS, NATIVE17_CURRENT_DEPENDENCY_PINS]
        .find(profile => profile.profile === value.nativeDependencyPins?.profile);
    assert.ok(dependencyPins, 'Native17 dependency profile is not admitted');
    assert.deepEqual(value.nativeDependencyPins, dependencyPins,
        'Native17 current dependency field set or values differ');
    assert.equal(Object.keys(value.nativeDependencyPins).length, 5);
    const lock = describe(path.join(nativeHUD, 'Package.resolved'));
    assert.equal(lock.sha256, dependencyPins.remoteLockSHA256);
    assert.equal(value.packageResolvedSHA256, lock.sha256);
    assert.deepEqual(Object.keys(value.sourceFileSHA256).sort(), [...NATIVE17_SOURCE_PATHS, 'producerSource'].sort());
    assert.ok(Array.isArray(source.inputs), 'Native source receipt has no input rows');
    const nativeFiles = NATIVE17_SOURCE_PATHS.map(relative => {
        const file = describe(inLocaldev(path.join(nativeHUD, relative)));
        assert.equal(file.sha256, value.sourceFileSHA256[relative], `Native source differs: ${relative}`);
        return { relative, ...file };
    });
    const producer = describe(inLocaldev(path.join(nativeHUD, 'Tests/HUDSchemaTests/NativeStorageInteropTests.swift')));
    assertRuntimePin(producer, qualified.producerSource, 'Native17 actual invoked producer');
    assert.equal(producer.sha256, value.sourceFileSHA256.producerSource);
    for (const file of [...nativeFiles, { relative: 'Tests/HUDSchemaTests/NativeStorageInteropTests.swift', ...producer }]) {
        const rows = source.inputs.filter(row => row.path === `${sourcePrefix}${file.relative}`);
        assert.equal(rows.length, 1, `Missing or duplicate admitted source: ${file.relative}`);
        assert.equal(rows[0].kind, 'file');
        assert.equal(rows[0].bytes, file.bytes);
        assert.equal(rows[0].sha256, file.sha256, `Admitted native source differs: ${file.relative}`);
    }
    // --hud-repo is the independently generated browser adapter tree. Never use
    // its Git HEAD or source files as proof of the separately admitted native producer.
    const browserContract = describe(path.join(hud, 'Tests/HUDSchemaTests/Fixtures/portable-contract.json'));
    assertRuntimePin(browserContract, {
        bytes: 169220, sha256: '677df8037a10dc865f756198af45e79ea198c43157ae4faa56313107cdd3f56b',
    }, 'Actual native portable contract export');
    assert.deepEqual(exportedContract, readJSON(browserContract.path),
        'Native fixture and Browser export contract values differ');
    return {
        sourceKind: qualified.sourceLayout, repository: nativeHUD, invocationBinding,
        sourceReceipt, admission, producer, sourceFiles: nativeFiles, lock, browserContract,
        callerRecordedLineage: value.callerRecordedSourceCommit,
        pins: value.nativeDependencyPins, registryHash: value.registryHash, contractHash: value.contractHash,
        packageResolvedSHA256: value.packageResolvedSHA256,
    };
}
const nativeProfile = native17Profile(manifest, contract);
const js = describe(path.join(build, 'lattice.js')), wasm = describe(path.join(build, 'lattice.wasm'));
const runtimeRaw = fs.readFileSync(args.get('--runtime-receipt'));
const runtimeGate = { path: args.get('--runtime-receipt'), bytes: runtimeRaw.length, sha256: sha(runtimeRaw) };
const prior = JSON.parse(runtimeRaw.toString('utf8'));
const runtimeQualification = NATIVE17_RUNTIME_QUALIFICATION;
assert.ok(runtimeQualification && typeof runtimeQualification === 'object' && !Array.isArray(runtimeQualification),
    'Native17 runtime qualification is unbound; qualify the actual scoped pair first');
assert.deepEqual(Object.keys(runtimeQualification).sort(),
    ['caseNames', 'harness', 'js', 'receipt', 'scopedFixture', 'unionFixture', 'wasm']);
function assertRuntimePin(actual, expected, label) {
    assert.ok(expected && typeof expected === 'object' && !Array.isArray(expected), `${label} pin is unbound`);
    assert.deepEqual(Object.keys(expected).sort(), ['bytes', 'sha256'], `${label} pin fields changed`);
    assert.ok(Number.isSafeInteger(expected.bytes) && expected.bytes > 0, `${label} byte bound changed`);
    assert.match(expected.sha256, /^[0-9a-f]{64}$/, `${label} digest changed`);
    assert.equal(actual.bytes, expected.bytes, `${label} bytes differ`);
    assert.equal(actual.sha256, expected.sha256, `${label} digest differs`);
}
assertRuntimePin(runtimeGate, runtimeQualification.receipt, 'Qualified runtime receipt');
assert.equal(prior.passed, true, 'The exact bound scoped runtime qualification must pass');
assert.ok(Array.isArray(prior.tests) && prior.tests.every(test => test && test.passed === true),
    'Every bound runtime case must pass');
const caseNames = prior.tests.map(test => test.name);
assert.ok(Array.isArray(runtimeQualification.caseNames) &&
    runtimeQualification.caseNames.every(name => typeof name === 'string' && name.length > 0));
assert.deepEqual(caseNames, runtimeQualification.caseNames, 'Runtime case inventory or order changed');
assert.equal(new Set(caseNames).size, caseNames.length, 'Runtime case identities must be unique');
const scopedCases = [
    "scoped actual native four-chunk copy is owned after mutation and final disposal",
    "scoped actual native indexed pages preserve original row order and exact continuation",
    "scoped actual native preflight and query errors refuse without poisoning following reads",
    "scoped actual native fence carries exact audit identity and reports closed owner",
];
const repairedCoreCases = [
    "union parent legacy-real triggers repair on Wasm reopen without losing rows or replay",
    "union parent incomplete-reference triggers repair on Wasm reopen without losing rows or replay",
    "union replay accepts canonical and legacy case spelling and refuses ambiguity before dedupe",
    "scoped empty queries differ from closed-owner failures on both native request paths"
];
// Preserve the exact baseline45 inventory plus every reviewed actual scoped
// and repaired-Core case, independently of placement in the qualified run order.
assert.equal(sha(JSON.stringify(caseNames.filter(name => !scopedCases.includes(name) && !repairedCoreCases.includes(name)))),
    'e41bd3a3fc8dedc8ea025533502a6a24b1bdc7cbc0a7700da1e4afc441563640',
    'Baseline runtime capabilities changed');
for (const name of [
    "detached native capture preserves primitive codecs and linked cycles without wrappers",
    "detached capture refuses outer transactions and preflight failures then allows ordinary writes",
    "detached capture refuses malformed junctions and table observers invalidate links and NoHistory",
    "detached scalar capture statement work is independent of selected cells and row count",
    "detached cross-table links reuse identities with nullable repeated targets and no per-parent SQL",
    "detached junction aliases preserve canonical stored identity spelling",
    "detached aggregate preflight admits empty wide schemas and exact physical cell limits",
    "detached aggregate preflight enforces one byte budget across selected tables",
    "detached aggregate type admission checks late rows while preserving nullable nulls",
    ...scopedCases, ...repairedCoreCases,
]) assert.ok(caseNames.includes(name), `Missing native qualification: ${name}`);
const runtimeHarness = describe(path.join(repo, 'test/wasm-lifecycle.mjs'));
assertRuntimePin(runtimeHarness, runtimeQualification.harness, 'Runtime harness source');
assert.equal(prior.receipt.harness.sha256, runtimeHarness.sha256, 'Runtime receipt harness source differs');
assertRuntimePin(describe(path.join(repo, 'test/fixtures/scoped-capture-runtime.ts')),
    runtimeQualification.scopedFixture, 'Scoped runtime fixture source');
assertRuntimePin(describe(path.join(repo, 'test/fixtures/explicit-unions-runtime.ts')),
    runtimeQualification.unionFixture, 'Repaired union runtime fixture source');
for (const [name, actual] of [['js', js], ['wasm', wasm]]) {
    assertRuntimePin(actual, runtimeQualification[name], `Qualified ${name} artifact`);
    assert.equal(prior.receipt[name].bytes, actual.bytes, `Runtime receipt ${name} bytes differ`);
    assert.equal(prior.receipt[name].sha256, actual.sha256, `Runtime receipt ${name} digest differs`);
}
assert.equal(inputs['baseline.lattice'].sha256, manifest.baselineSHA256);
assert.equal(inputs['native-reference.lattice'].sha256, manifest.nativeReferenceSHA256);
for (const name of ['baseline.lattice', 'native-reference.lattice']) {
    for (const suffix of ['-wal', '-journal']) {
        const pending = path.join(fixture, name + suffix);
        assert.ok(!fs.existsSync(pending) || fs.statSync(pending).size === 0, `Fixture is not checkpointed: ${pending}`);
    }
}
fs.mkdirSync(out);
const sourcePaths = ['src/lattice.ts', 'src/decorators.ts', 'src/explicit-models.ts', 'src/explicit-values.ts',
    'src/storage.ts', 'src/types.ts', 'src/capture-values.ts', 'wasm/bindings.cpp', 'wasm/capture-values.hpp', 'test/native-hud-interop.mjs',
    'test/fixtures/native-hud-interop-runtime.ts', 'test/fixtures/native-hud-interop-values.ts', 'test/fixtures/native-hud-junctions.py',
    'test/fixtures/native-hud-interop-inputs.mjs',
    'src/scoped-capture.ts', 'wasm/scoped-capture.hpp',
    'test/fixtures/explicit-models-runtime.ts', 'test/fixtures/scoped-capture-runtime.ts',
    'test/fixtures/explicit-unions-runtime.ts'];
const receipt = { startedAt: new Date().toISOString(), inputs, candidate: { js, wasm, runtimeGate,
    latticeJS: { path: repo, publishedBaseRevision: 'de3e322db9982121004fc4d86f22ddcd475422d1',
        identityBasis: 'actual candidate file records and the separately bound runtime receipt; no Git HEAD assumption' },
    core: { path: core, compiledProvenanceRevision: 'c089b94a53f52eda843e9c1480b9c1c79f3921ef',
        identityBasis: 'exact qualified JS/Wasm pair and runtime receipt; selected Core files below are source records, not canonical HEAD' },
    hud: { path: hud, role: 'browser adapter and generated current native descriptors; separate from the native producer repository' },
    files: sourcePaths.map(name => describe(path.join(repo, name))),
    hudAdapter: describe(path.join(hud, 'Browser/src/lattice-models.ts')),
    hudGeneratedStorage: describe(path.join(hud, 'Browser/src/generated/storage.ts')),
    coreFiles: ['Sources/LatticeSwiftCppBridge/src/dynamic_object.cpp', 'Sources/LatticeSwiftCppBridge/include/dynamic_object.hpp',
        'Sources/LatticeSwiftCppBridge/include/lattice.hpp', 'Sources/LatticeCore/src/sync.cpp',
        'Sources/LatticeCore/include/lattice/sync.hpp', 'Sources/LatticeCore/include/lattice/lattice.hpp'].map(name => describe(path.join(core, name))) },
    native: nativeProfile };
const immutableInputs = [...Object.values(inputs), invocationBinding, nativeProfile.sourceReceipt, nativeProfile.admission,
    nativeProfile.producer, nativeProfile.lock, nativeProfile.browserContract, ...nativeProfile.sourceFiles];
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
    fixtureFormat: 2, nativeModelTables: 17,
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
                ['float64', 'unixSeconds'].includes(cell.kind) ? { kind: 'float64', bits: cell.bits }
                    : cell.kind === 'embeddedJSON' ? { kind: 'text', value: cell.value } : cell]))
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
    for (const record of immutableInputs) assert.equal(describe(record.path).sha256, record.sha256, 'Original native fixture/source admission changed');
    assert.equal(describe(js.path).sha256, js.sha256); assert.equal(describe(wasm.path).sha256, wasm.sha256);
    fs.writeFileSync(destination, returned, { flag: 'wx' });
    output = describe(destination);
} catch (error) { failure = error?.stack ?? String(error); }
finally {
    clearTimeout(watchdog);
    if (module) {
        await settle(); final = diagnostics();
        if (baseline && diagnosticKeys.some(key => final[key] !== baseline[key]))
            failure = `${failure ?? ''}\nNative resources were retained after cleanup`;
    }
    process.off('uncaughtException', onError); process.off('unhandledRejection', onError);
    Object.assign(console, previousConsole);
    for (const record of immutableInputs) if (describe(record.path).sha256 !== record.sha256) failure = `${failure ?? ''}\nOriginal input changed: ${record.path}`;
    const passed = !failure && asyncErrors.length === 0 && fatalLogs.length === 0 && !!output;
    writeReport(passed);
    process.stdout.write(JSON.stringify({ passed, report: reportPath, returned: output?.path, failure }) + '\n');
    process.exitCode = passed ? 0 : 1;
}
