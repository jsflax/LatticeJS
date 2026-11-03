import { describe, expect, it, vi } from 'vitest';
import { captureByIDsSync, captureByIndexedUUIDSync, copyScopedIDRequest, readFenceSync } from '../src/scoped-capture';
const id = '00000000-0000-0000-0000-000000000001';
const upperAuditID = 'AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA';
const mixedAuditID = 'bBbBbBbB-bBbB-4bBb-bBbB-bBbBbBbBbBbB';
const request = { table: 'Chunk', properties: ['payload', 'ordinal'], globalIDs: [id] };
const fence = { head: (1n << 63n) - 1n, floor: 1n, headGlobalID: id, historyGeneration: null };
const result = () => ({ formatVersion: 1, rows: [{ table: 'Chunk', globalId: id, values: { payload: new Uint8Array([1, 2, 255]), ordinal: 1n } }], fence });
describe('scoped native read boundary', () => {
  it('copies byte ownership and preserves exact Int64 with one checked native call', () => {
    const raw = result(), native = { scopedCaptureVersion: () => 1, captureByIDsSync: vi.fn(() => raw) };
    const copied = captureByIDsSync(native, request); raw.rows[0]!.values.payload[0] = 99;
    expect(copied.rows[0]!.values.payload).toEqual(new Uint8Array([1, 2, 255])); expect(copied.fence.head).toBe((1n << 63n) - 1n);
    expect(native.captureByIDsSync).toHaveBeenCalledTimes(1); expect(Object.isFrozen(copied.rows[0]!.values)).toBe(true);
  });
  it('refuses missing capability, native failures and malformed history instead of empty success', () => {
    expect(() => captureByIDsSync({}, request)).toThrow(/version1/);
    expect(() => captureByIDsSync({ scopedCaptureVersion: () => 1, captureByIDsSync: () => { throw new Error('query denied'); } }, request)).toThrow('query denied');
    expect(() => readFenceSync({ scopedCaptureVersion: () => 1, readFenceSync: () => ({ ...fence, head: 0n }) })).toThrow(/bounds/);
    expect(() => readFenceSync({ scopedCaptureVersion: () => 1, readFenceSync: () => ({ ...fence, historyGeneration: 'bad' }) })).toThrow(/UUID/);
    for (const [headGlobalID, historyGeneration] of [[upperAuditID, mixedAuditID], [mixedAuditID, upperAuditID]]) {
      const raw = { ...fence, headGlobalID, historyGeneration };
      const copied = readFenceSync({ scopedCaptureVersion: () => 1, readFenceSync: () => raw });
      expect(copied).toEqual(raw); expect(Object.isFrozen(copied)).toBe(true);
    }
    for (const malformed of [
      { ...fence, headGlobalID: upperAuditID.replace('A', 'G') },
      { ...fence, headGlobalID: `${upperAuditID}0` }, { ...fence, headGlobalID: null },
      { ...fence, historyGeneration: 1n }, { ...fence, historyGeneration: upperAuditID.replace('-', '_') },
      { ...fence, head: 1 }, { ...fence, floor: 0n }, { ...fence, floor: 1n << 63n },
    ]) expect(() => readFenceSync({ scopedCaptureVersion: () => 1, readFenceSync: () => malformed })).toThrow();

  });
  it('rejects accessors, duplicate IDs and broad predicates before native work', () => {
    const getter = vi.fn(() => 'Chunk');
    expect(() => copyScopedIDRequest({ get table() { return getter(); }, properties: ['payload'], globalIDs: [id] })).toThrow();expect(getter).not.toHaveBeenCalled();
    for (const input of [{ ...request, globalIDs: [upperAuditID] }, { ...request, globalIDs: [id, id] }, { ...request, where: '1=1' }, { ...request, properties: new Array(1) }, { ...request, globalIDs: Array(5).fill(id) }]) expect(() => copyScopedIDRequest(input)).toThrow();
  });
  it('refuses foreign, duplicate, oversized or unsupported physical outputs', () => {
    const native = (raw: unknown) => ({ scopedCaptureVersion: () => 1, captureByIDsSync: () => raw });
    for (const change of [(r: any) => r.rows[0].globalId = upperAuditID, (r: any) => r.rows.push(r.rows[0]), (r: any) => r.rows[0].table = 'Other', (r: any) => r.rows[0].values.payload = [1, 2],
      (r: any) => r.rows[0].values.payload = new Uint8Array(262145), (r: any) => r.rows[0].values.ordinal = 1n << 63n]) {
      const raw = result();change(raw);expect(() => captureByIDsSync(native(raw), request)).toThrow();
    }
  });
  it('metadata continuation refers to the last returned row and never the extra probe', () => {
    const selection = { table: 'Chunk', properties: ['ordinal'], property: 'ownerID', equalTo: id, afterID: 7n, limit: 1 };
    const raw = { formatVersion: 1, rows: [{ table: 'Chunk', globalId: id, id: 9n, values: { ordinal: 1n } }], hasMore: true, nextID: 9n, fence };
    const native = { scopedCaptureVersion: () => 1, captureByIndexedUUIDSync: () => raw };
    expect(() => captureByIndexedUUIDSync(native, { ...selection, equalTo: upperAuditID })).toThrow(/UUID/);
    expect(captureByIndexedUUIDSync(native, selection).nextID).toBe(9n);raw.nextID = 10n;expect(() => captureByIndexedUUIDSync(native, selection)).toThrow(/continuation/);
    raw.nextID = 9n;raw.rows[0]!.id = 7n;expect(() => captureByIndexedUUIDSync(native, selection)).toThrow(/unordered/);
  });
  it('metadata refuses bytes and checks cumulative UTF8 before copying more cells', () => {
    const selection = { table: 'Chunk', properties: ['payload'], property: 'ownerID', equalTo: id, afterID: 0n, limit: 1 };
    const raw = { formatVersion: 1, rows: [{ table: 'Chunk', globalId: id, id: 1n, values: { payload: new Uint8Array([1]) } }], hasMore: false, nextID: 1n, fence };
    expect(() => captureByIndexedUUIDSync({ scopedCaptureVersion: () => 1, captureByIndexedUUIDSync: () => raw }, selection)).toThrow(/physical/);
    const wide = result() as any;wide.rows[0].values.payload = '😀'.repeat(1025);
    expect(() => captureByIDsSync({ scopedCaptureVersion: () => 1, captureByIDsSync: () => wide }, request)).toThrow(/text bound/);
  });
});
