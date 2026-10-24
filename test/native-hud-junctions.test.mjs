import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'tmp');
const inspector = path.join(repo, 'test/fixtures/native-hud-junctions.py');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture() {
    const directory = fs.mkdtempSync(path.join(root, 'junction-inspection-'));
    const store = path.join(directory, 'junction-baseline.lattice'), request = path.join(directory, 'request.json');
    execFileSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('CREATE TABLE "_HUDNode_HUDNode_parent" (lhs INTEGER, rhs INTEGER, globalId TEXT)')
 db.execute('INSERT INTO "_HUDNode_HUDNode_parent" VALUES (?,?,?)',(9007199254740993,9223372036854775807,'fixture-junction'))
`, store], { env: { ...process.env, TMPDIR: directory, PYTHONDONTWRITEBYTECODE: '1' } });
    const rows = [{ table: '_HUDNode_HUDNode_parent', globalId: 'fixture-junction', localId: null,
        fields: { lhs: { kind: 'int64', value: '9007199254740993' }, rhs: { kind: 'int64', value: '9223372036854775807' } } }];
    fs.writeFileSync(request, JSON.stringify({ tables: ['_HUDNode_HUDNode_parent'], rows }));
    return { directory, store, request, rows };
}
test('test-only SQLite extraction reads actual id-less junction columns and exact Int64 without modifying bytes', () => {
    const input = fixture(), before = sha(input.store);
    const result = JSON.parse(execFileSync('python3', [inspector, input.store, input.request], { encoding: 'utf8' }));
    assert.deepEqual(result.rows, input.rows);
    assert.deepEqual(result.schemas._HUDNode_HUDNode_parent, { lhs: 'INTEGER', rhs: 'INTEGER', globalId: 'TEXT' });
    assert.equal(result.rows[0].localId, null); assert.equal(result.readOnlySQLiteCopy, true);
    assert.equal(sha(input.store), before); assert.equal(result.fileSHA256, before);
});
test('test-only junction extraction refuses invented identity/columns instead of filling placeholders', () => {
    const input = fixture(), before = sha(input.store);
    input.rows[0].localId = '0';
    fs.writeFileSync(input.request, JSON.stringify({ tables: ['_HUDNode_HUDNode_parent'], rows: input.rows }));
    assert.throws(() => execFileSync('python3', [inspector, input.store, input.request], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /Actual junction schema differs from manifest/);
    assert.equal(sha(input.store), before);
});
test('test-only union-side extraction quotes reserved case and keeps exact physical values', () => {
    const input = fixture();
    execFileSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('CREATE TABLE "_HUDSource_spec" (id INTEGER, globalId TEXT, "case" TEXT, n INTEGER, value REAL)')
 db.execute('INSERT INTO "_HUDSource_spec" VALUES (?,?,?,?,?)',(7,'fixture-union','literal',9007199254740993,0.0))
`, input.store], { env: { ...process.env, TMPDIR: input.directory, PYTHONDONTWRITEBYTECODE: '1' } });
    const union = { table: '_HUDSource_spec', globalId: 'fixture-union', localId: '7', fields: {
        case: { kind: 'text', value: 'literal' }, n: { kind: 'int64', value: '9007199254740993' },
        value: { kind: 'float64', bits: '0000000000000000' },
    } };
    const rows = [...input.rows, union], before = sha(input.store);
    fs.writeFileSync(input.request, JSON.stringify({ tables: ['_HUDNode_HUDNode_parent', '_HUDSource_spec'], rows }));
    const result = JSON.parse(execFileSync('python3', [inspector, input.store, input.request], { encoding: 'utf8' }));
    assert.deepEqual(result.rows, rows);
    assert.equal(sha(input.store), before); assert.equal(result.fileSHA256, before);
});
