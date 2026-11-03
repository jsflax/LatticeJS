// Actual compiled Wasm/SQLite path. Only loader URL imports use the existing inert harness
// adapter; all reads, schema/indexes, BLOB copies and errors come from the native module.
import assert from 'node:assert/strict';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas } from '../../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';
import { captureByIDsSync, captureByIndexedUUIDSync, readFenceSync } from '../../src/scoped-capture';
const ownerID = '00000000-0000-0000-0000-000000000100';
const definition = { formatVersion: 1, models: [{ tableName: 'ScopedChunk', properties: [
  { name: 'ownerID', kind: 'primitive', type: 'string', nullable: false, isIndexed: true },
  { name: 'ordinal', kind: 'primitive', type: 'int', representation: 'bigint', nullable: false },
  { name: 'label', kind: 'primitive', type: 'string', nullable: false },
  { name: 'payload', kind: 'primitive', type: 'blob', nullable: false },
  { name: 'unselected', kind: 'primitive', type: 'blob', nullable: false },
] }] } as const;
export async function runScopedCaptureCases({ module, test, newPath, register, dispose }: any) {
  async function fixture(body: (state: any) => Promise<void>) {
    const { ScopedChunk: Row } = defineModels(definition), wrappers = new Set<any>();
    const native = new module.Lattice(newPath('scoped-chunks'), buildSchemas([Row]));register(native);
    const db = Object.assign(Object.create(Lattice.prototype), { db: native, closing: false, openedReadEpoch: Object.freeze({}) }) as Lattice;
    setWasmModule(module);
    const add = async (ordinal: number, size = 262144) => {
      const row = new Row({ ownerID, ordinal: BigInt(ordinal), label: 'saved', payload: new Uint8Array(size).fill(ordinal), unselected: new Uint8Array(1048576) });
      wrappers.add(row[DYNAMIC_OBJECT]);await db.add(row);return row;
    };
    try { await body({ native, db, add }); }
    finally { setWasmModule(null);for(const wrapper of wrappers)wrapper.delete();dispose(native); }
  }
  await test('scoped actual native four-chunk copy is owned after mutation and final disposal', async () => {
    let bytes: Uint8Array | undefined;
    await fixture(async ({ native, db, add }) => {
      const rows=[];for(let i=1;i<=5;++i)rows.push(await add(i));
      const request={table:'ScopedChunk',properties:['payload','ordinal'],globalIDs:rows.slice(0,4).map(r=>r.globalId)};
      const result=db.captureByIDsSync(request);assert.equal(result.rows.length,4);assert.equal(native.scopedCaptureVersion(),1);
      bytes=result.rows[0]!.values.payload as Uint8Array;assert.equal(bytes.length,262144);assert.equal(bytes[0],1);
      rows[0].payload=new Uint8Array([9]);assert.equal(bytes[0],1);assert.equal(captureByIDsSync(native,request).rows[0]!.values.payload instanceof Uint8Array,true);
      assert.throws(()=>db.captureByIDsSync({...request,globalIDs:rows.map(r=>r.globalId)}),/IDs|bound/);
    });assert.equal(bytes![0],1);
  });
  await test('scoped actual native indexed pages preserve original row order and exact continuation', () => fixture(async ({ native, add }) => {
    const rows=[];for(let i=1;i<=5;++i)rows.push(await add(i,1));
    const request={table:'ScopedChunk',properties:['ordinal'],property:'ownerID',equalTo:ownerID,afterID:0n,limit:2};
    const first=captureByIndexedUUIDSync(native,request);assert.equal(first.rows.length,2);assert.equal(first.hasMore,true);
    const second=captureByIndexedUUIDSync(native,{...request,afterID:first.nextID!});assert.equal(second.rows[0]!.values.ordinal,3n);
    const last=captureByIndexedUUIDSync(native,{...request,afterID:second.nextID!});assert.equal(last.rows.length,1);assert.equal(last.hasMore,false);assert.equal(last.rows[0]!.values.ordinal,5n);
    assert.throws(()=>captureByIndexedUUIDSync(native,{...request,property:'label'}),/index/);
  }));
  await test('scoped actual native preflight and query errors refuse without poisoning following reads', () => fixture(async ({ native, add }) => {
    const row=await add(1,262145),request={table:'ScopedChunk',properties:['payload','ordinal'],globalIDs:[row.globalId]};
    assert.throws(()=>captureByIDsSync(native,request),/bound/);row.payload=new Uint8Array([1]);
    row[DYNAMIC_OBJECT].setString('ordinal','malformed');assert.throws(()=>captureByIDsSync(native,request),/type mismatch/);row.ordinal=1n;
    native.beginWrite();try {assert.throws(()=>captureByIDsSync(native,request),/idle|transaction/);row.label='caller-owned';}finally {native.commitWrite();}
    assert.equal(captureByIDsSync(native,request).rows.length,1);
    assert.equal(captureByIDsSync(native,{...request,globalIDs:['00000000-0000-0000-0000-000000000099']}).rows.length,0);
    assert.throws(()=>captureByIDsSync(native,{...request,table:'Missing'}),/registered/);
  }));
  await test('scoped actual native fence carries exact audit identity and reports closed owner', () => fixture(async ({ native, db, add }) => {
    const row=await add(1,1),first=readFenceSync(native);assert.equal(typeof first.head,'bigint');assert.ok(first.head>0n);assert.equal(first.headGlobalID?.length,36);
    row.label='changed';const next=db.readFenceSync();assert.ok(next.head>first.head);assert.notEqual(next.headGlobalID,first.headGlobalID);
    const uppercase = 'AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA';
    const mixed = 'bBbBbBbB-bBbB-4bBb-bBbB-bBbBbBbBbBbB';
    for (const [headGlobalID, historyGeneration] of [[uppercase, mixed], [mixed, uppercase]]) {
      // Existing fixture-only SQL seam: use the owning writer transaction so the
      // real SQLite audit/history identities have deterministic stored spelling.
      native.beginWrite();
      try {
        assert.equal(native.debugQueryCount(`UPDATE AuditLog SET globalId='${headGlobalID}' WHERE id=(SELECT MAX(id) FROM AuditLog)`), 0);
        assert.equal(native.debugQueryCount(`INSERT OR REPLACE INTO _lattice_meta(key,value) VALUES('history_generation_revision_v1','${historyGeneration}')`), 0);
      } finally { native.commitWrite(); }
      const exact = db.readFenceSync();
      assert.equal(exact.headGlobalID, headGlobalID); assert.equal(exact.historyGeneration, historyGeneration);
      assert.equal(exact.head, next.head); assert.equal(exact.floor, next.floor);
      assert.deepEqual(db.captureByIDsSync({table:'ScopedChunk',properties:['ordinal'],globalIDs:[row.globalId]}).fence, exact);
      assert.deepEqual(captureByIndexedUUIDSync(native,{table:'ScopedChunk',properties:['ordinal'],property:'ownerID',equalTo:ownerID,afterID:0n,limit:1}).fence, exact);
    }
    // Dispose wrappers first in fixture cleanup, so use a separate empty native handle here.
    const closed=new module.Lattice(newPath('scoped-closed'),buildSchemas([defineModels(definition).ScopedChunk]));register(closed);
    try {closed.releaseStorage();assert.throws(()=>readFenceSync(closed),/open database|open owner/);}finally {dispose(closed);}
  }));
}
