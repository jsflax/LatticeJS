import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pinFields = ['admission', 'baseline', 'fixtureContract', 'manifest', 'nativeReference', 'producerSource', 'sourceReceipt'];
const fields = [...pinFields, 'callerRecordedSourceCommit', 'dependencyAdmissionSHA256', 'sourceLayout'].sort();
const layouts = ['direct-checkout', 'q2-copied-source'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Data admission only: exact pins still compare to every actual input in the consumer.
export function nativeInvocationQualification(value) {
    assert.ok(record(value), 'Native17 invocation binding must be an object');
    assert.deepEqual(Object.keys(value).sort(), fields, 'Native17 invocation binding fields changed');
    assert.ok(layouts.includes(value.sourceLayout), 'Native17 source layout is unsupported');
    assert.match(value.callerRecordedSourceCommit ?? '', /^[a-f0-9]{40}$/, 'Native17 caller lineage is unbound');
    assert.match(value.dependencyAdmissionSHA256 ?? '', /^[a-f0-9]{64}$/, 'Native17 dependency admission is unbound');
    const result = { ...value };
    for (const name of pinFields) {
        const pin = value[name];
        assert.ok(record(pin), `Native17 ${name} pin is unbound`);
        assert.deepEqual(Object.keys(pin).sort(), ['bytes', 'sha256'], `Native17 ${name} pin fields changed`);
        assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0, `Native17 ${name} byte bound changed`);
        assert.match(pin.sha256 ?? '', /^[a-f0-9]{64}$/, `Native17 ${name} digest changed`);
        result[name] = Object.freeze({ ...pin });
    }
    return Object.freeze(result);
}

export function localdevPaths(home = process.env.HOME) {
    assert.ok(typeof home === 'string' && path.isAbsolute(home), 'Native17 requires an absolute HOME');
    const localdev = fs.realpathSync(path.join(home, 'localdev'));
    return (file, existing = true) => {
        assert.ok(typeof file === 'string' && path.isAbsolute(file), 'Native17 paths must be absolute');
        const actual = existing ? fs.realpathSync(file)
            : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
        assert.ok(actual.startsWith(localdev + path.sep), `Path must stay under localdev: ${file}`);
        return actual;
    };
}

export function nativeSourcePrefix(source, nativeHUD, layout, inLocaldev) {
    assert.ok(record(source), 'Native source receipt must be an object');
    assert.equal(source.version, 1);
    assert.equal(typeof source.root, 'string');
    assert.ok(layouts.includes(layout), 'Native17 source layout is unsupported');
    const prefix = layout === 'q2-copied-source' ? 'Sources/HUD/' : '';
    assert.equal(inLocaldev(path.join(source.root, prefix)), inLocaldev(nativeHUD),
        'Native source receipt does not describe the native producer repository');
    return prefix;
}
