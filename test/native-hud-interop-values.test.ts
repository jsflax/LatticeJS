import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { localdevPaths, nativeInvocationQualification, nativeSourcePrefix } from './fixtures/native-hud-interop-inputs.mjs';
import { assertScalar, doubleBits, expectedUnion, fromDoubleBits, integer, mutationUnion, rowID, scalar } from './fixtures/native-hud-interop-values';

describe('native HUD oracle exact value transport', () => {
    it('preserves native Int64 extrema and refuses unsafe row identity conversion', () => {
        for (const value of [-(1n << 63n), -(1n << 53n) - 1n, 0n, (1n << 53n) + 1n, (1n << 63n) - 1n]) {
            expect(integer(String(value))).toBe(value);
            expect(scalar({ kind: 'int64', value: String(value) }, 'int')).toBe(value);
        }
        expect(rowID('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
        expect(() => rowID('9007199254740992')).toThrow(/Unsafe/);
        expect(() => integer('9223372036854775808')).toThrow(/Int64/);
        expect(() => integer(9007199254740992)).toThrow(/decimal text/);
        expect(() => integer('01')).toThrow();
    });
    it('compares floating bits, including zero, independently of native display spelling', () => {
        for (const number of [0, -0, 0.125, -0.125, 1700000000.125]) {
            const bits = doubleBits(number);
            expect(Object.is(fromDoubleBits(bits), number)).toBe(true);
            expect(() => assertScalar(number, { kind: 'unixSeconds', value: 'unused native display spelling', bits }, 'date', 'date')).not.toThrow();
        }
        expect(() => assertScalar(-0, { kind: 'float64', bits: doubleBits(0) }, 'float', 'zero')).toThrow();
        expect(() => fromDoubleBits('7ff0000000000000')).toThrow(/Nonfinite/);
    });
    it('keeps embedded JSON opaque and distinguishes epoch zero, false and null', () => {
        const text = '{"wide":9007199254740993,"escaped":"\\u0061"}';
        expect(scalar({ kind: 'embeddedJSON', value: text }, 'string')).toBe(text);
        expect(scalar({ kind: 'int64', value: '0' }, 'bool')).toBe(false);
        expect(scalar({ kind: 'null' }, 'date')).toBeNull();
        expect(scalar({ kind: 'unixSeconds', bits: doubleBits(0) }, 'date')).toBe(0);
        expect(() => scalar({ kind: 'int64', value: '2' }, 'bool')).toThrow();
    });
    it('derives exact union expectations from physical decimal cells without parsing Codable JSON', () => {
        const owner = { table: 'HUDHandler', globalId: 'owner', fields: { action: { kind: 'unionRef', table: '_HUDAction', value: 'side' } } };
        const property = { name: 'action', targetTable: '_HUDAction', logicalNullable: false, unionCases: [
            { name: 'claim', values: [{ paramName: 'ttlMs', type: 'int' }] },
            { name: 'emitEvent', values: [{ paramName: 'name', type: 'string' }] },
        ] };
        const snapshot = { rows: [{ table: '_HUDAction', globalId: 'side', fields: {
            case: { kind: 'text', value: 'claim' }, claim__ttlMs: { kind: 'int64', value: '9223372036854775807' }, emitEvent__name: { kind: 'null' },
        } }], logicalUnions: [{ ownerTable: 'HUDHandler', ownerGlobalId: 'owner', property: 'action', caseName: 'claim', codableJSON: '{"claim":{"ttlMs":9223372036854775807}}' }] };
        expect(expectedUnion(snapshot, owner, property)).toEqual({ case: 'claim', fields: { ttlMs: 9223372036854775807n } });
        snapshot.rows[0].fields.emitEvent__name = { kind: 'text', value: 'must be cleared' } as any;
        expect(() => expectedUnion(snapshot, owner, property)).toThrow(/Inactive union/);
    });
    it('supports manifest bare/string mutations and refuses integer union decoding through Number', () => {
        const property = { unionCases: [{ name: 'noop', values: [] },
            { name: 'setProp', values: [{ paramName: 'value', type: 'string' }] },
            { name: 'claim', values: [{ paramName: 'ttlMs', type: 'int' }] }] };
        expect(mutationUnion({ kind: 'unionCodableJSON', value: '{"noop":{}}' }, property)).toEqual({ case: 'noop', fields: {} });
        expect(mutationUnion({ kind: 'unionCodableJSON', value: '{"setProp":{"value":"9007199254740993"}}' }, property))
            .toEqual({ case: 'setProp', fields: { value: '9007199254740993' } });
        expect(() => mutationUnion({ kind: 'unionCodableJSON', value: '{"claim":{"ttlMs":9223372036854775807}}' }, property)).toThrow(/exact JSON decoder/);
        expect(() => mutationUnion({ kind: 'unionCodableJSON', value: '{"setProp":{"value":3}}' }, property)).toThrow();
    });
});


describe('native HUD current invocation input admission', () => {
    const binding = () => ({
        admission: { bytes: 10, sha256: '1'.repeat(64) },
        baseline: { bytes: 20, sha256: '2'.repeat(64) },
        fixtureContract: { bytes: 30, sha256: '3'.repeat(64) },
        manifest: { bytes: 40, sha256: '4'.repeat(64) },
        nativeReference: { bytes: 50, sha256: '5'.repeat(64) },
        producerSource: { bytes: 60, sha256: '6'.repeat(64) },
        sourceReceipt: { bytes: 70, sha256: '7'.repeat(64) },
        callerRecordedSourceCommit: 'a'.repeat(40),
        dependencyAdmissionSHA256: 'b'.repeat(64),
        sourceLayout: 'direct-checkout',
    });
    it('admits only a closed complete actual binding in either explicit source layout', () => {
        for (const sourceLayout of ['direct-checkout', 'q2-copied-source']) {
            const input = { ...binding(), sourceLayout };
            const admitted = nativeInvocationQualification(input);
            expect(admitted).toEqual(input);
            expect(Object.isFrozen(admitted)).toBe(true);
            expect(Object.isFrozen(admitted.baseline)).toBe(true);
        }
        for (const value of [null, [], {}, { ...binding(), extra: true }, { ...binding(), sourceLayout: 'guess' }]) {
            expect(() => nativeInvocationQualification(value)).toThrow();
        }
        for (const key of Object.keys(binding())) {
            const input: Record<string, unknown> = binding();
            delete input[key];
            expect(() => nativeInvocationQualification(input)).toThrow();
        }
        for (const key of ['admission', 'baseline', 'fixtureContract', 'manifest', 'nativeReference', 'producerSource', 'sourceReceipt']) {
            for (const pin of [null, { bytes: 0, sha256: '1'.repeat(64) }, { bytes: 1.5, sha256: '1'.repeat(64) },
                { bytes: 1, sha256: 'wrong' }, { bytes: 1, sha256: '1'.repeat(64), path: '/unbound' }]) {
                expect(() => nativeInvocationQualification({ ...binding(), [key]: pin })).toThrow();
            }
        }
        expect(() => nativeInvocationQualification({ ...binding(), callerRecordedSourceCommit: 'a'.repeat(39) })).toThrow();
        expect(() => nativeInvocationQualification({ ...binding(), dependencyAdmissionSHA256: null })).toThrow();
    });
    it('keeps direct and Q2 roots and exact admitted row prefixes distinct', () => {
        const native = '/fixture/localdev/qualification/Sources/HUD';
        const identity = (value: string) => value;
        const direct = { version: 1, root: native };
        const q2 = { version: 1, root: '/fixture/localdev/qualification' };
        expect(nativeSourcePrefix(direct, native, 'direct-checkout', identity)).toBe('');
        expect(nativeSourcePrefix(q2, native, 'q2-copied-source', identity)).toBe('Sources/HUD/');
        expect(() => nativeSourcePrefix(direct, native, 'q2-copied-source', identity)).toThrow();
        expect(() => nativeSourcePrefix(q2, native, 'direct-checkout', identity)).toThrow();
        expect(() => nativeSourcePrefix({ ...q2, version: 2 }, native, 'q2-copied-source', identity)).toThrow();
        expect(() => nativeSourcePrefix(q2, native, 'guess', identity)).toThrow();
    });
    it('admits existing and fresh child paths but refuses traversal, siblings and symlink escapes', () => {
        const home = process.env.HOME!;
        const owner = path.join(home, 'localdev');
        fs.mkdirSync(owner, { recursive: true });
        const scratch = fs.mkdtempSync(path.join(owner, 'native17-input-test-'));
        try {
            const testHome = path.join(scratch, 'home');
            const root = path.join(testHome, 'localdev');
            const outside = path.join(scratch, 'outside');
            fs.mkdirSync(root, { recursive: true });
            fs.mkdirSync(outside);
            const file = path.join(root, 'input');
            fs.writeFileSync(file, 'synthetic input', { flag: 'wx' });
            fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
            const admitted = localdevPaths(testHome);
            expect(admitted(file)).toBe(fs.realpathSync(file));
            expect(admitted(path.join(root, 'fresh-output'), false)).toBe(path.join(fs.realpathSync(root), 'fresh-output'));
            for (const refused of [root, outside, path.join(root, '..', '..', 'outside'), path.join(root, 'escape')]) {
                expect(() => admitted(refused)).toThrow();
            }
            expect(() => admitted(path.join(root, 'escape', 'new-output'), false)).toThrow();
            expect(() => admitted(root + '-other/new-output', false)).toThrow();
            expect(() => admitted('relative')).toThrow();
            expect(() => localdevPaths('relative')).toThrow();
            expect(() => localdevPaths('')).toThrow();
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });
});
