/** Additive primitive-only scoped reads. These functions never emulate native capabilities. */
export interface AuditReadFence { readonly head: bigint; readonly floor: bigint; readonly headGlobalID: string | null; readonly historyGeneration: string | null }
export interface ScopedSelection { readonly table: string; readonly properties: readonly string[] }
export interface ScopedIDRequest extends ScopedSelection { readonly globalIDs: readonly string[] }
export interface ScopedIndexedRequest extends ScopedSelection { readonly property: string; readonly equalTo: string; readonly afterID: bigint; readonly limit: number }
export type ScopedValue = null | bigint | number | string | Uint8Array;
export interface ScopedRow { readonly table: string; readonly globalId: string; readonly values: Readonly<Record<string, ScopedValue>> }
export interface ScopedIndexedRow extends ScopedRow { readonly id: bigint }
export interface ScopedCapture { readonly formatVersion: 1; readonly rows: readonly ScopedRow[]; readonly fence: AuditReadFence }
export interface ScopedPage { readonly formatVersion: 1; readonly rows: readonly ScopedIndexedRow[]; readonly hasMore: boolean; readonly nextID: bigint | null; readonly fence: AuditReadFence }
export interface ScopedNative {
  scopedCaptureVersion?: () => number;
  captureByIDsSync?: (request: ScopedIDRequest) => unknown;
  captureByIndexedUUIDSync?: (request: ScopedIndexedRequest) => unknown;
  readFenceSync?: () => unknown;
}
const encoder = new TextEncoder();
function fail(message: string): never { throw new Error(message); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Invalid scoped record');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(k => !fields[k] || !('value' in fields[k]!))) fail('Invalid scoped fields');
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail('Scoped array bound exceeded');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== value.length + 1) fail('Invalid scoped array fields');
  for (let i = 0; i < value.length; ++i) if (!fields[i] || !('value' in fields[i]!)) fail('Invalid scoped array');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) fail('Invalid scoped identifier');
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) fail('Invalid scoped UUID');
  return value;
}
// Core audit/history UUIDs retain their stored spelling, including uppercase hex.
function auditUUID(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) fail('Invalid scoped audit UUID');
  return value;
}
function integer(value: unknown, nonnegative = false): bigint {
  if (typeof value !== 'bigint' || value < (nonnegative ? 0n : -(1n << 63n)) || value > (1n << 63n) - 1n) fail('Invalid scoped Int64');
  return value;
}
function selection(raw: Record<string, unknown>): ScopedSelection {
  const table = identifier(raw.table), seen = new Set<string>();
  const properties = list(raw.properties, 32).map(p => { const name = identifier(p), key = name.toLowerCase();
    if (key === 'id' || key === 'globalid' || seen.has(key)) fail('Invalid scoped property'); seen.add(key); return name;
  });
  if (!properties.length) fail('Missing scoped properties'); return Object.freeze({ table, properties: Object.freeze(properties) });
}
export function copyScopedIDRequest(input: ScopedIDRequest): ScopedIDRequest {
  const raw = record(input, ['table', 'properties', 'globalIDs']), base = selection(raw);
  const globalIDs = list(raw.globalIDs, 4).map(uuid);
  if (!globalIDs.length || new Set(globalIDs).size !== globalIDs.length) fail('Invalid scoped IDs');
  return Object.freeze({ ...base, globalIDs: Object.freeze(globalIDs) });
}
export function copyScopedIndexedRequest(input: ScopedIndexedRequest): ScopedIndexedRequest {
  const raw = record(input, ['table', 'properties', 'property', 'equalTo', 'afterID', 'limit']), base = selection(raw);
  const property = identifier(raw.property), equalTo = uuid(raw.equalTo), afterID = integer(raw.afterID, true), limit = raw.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 256) fail('Invalid scoped page size');
  return Object.freeze({ ...base, property, equalTo, afterID, limit });
}
export function copyAuditReadFence(input: unknown): AuditReadFence {
  const raw = record(input, ['head', 'floor', 'headGlobalID', 'historyGeneration']);
  const head = integer(raw.head, true), floor = integer(raw.floor, true), headGlobalID = raw.headGlobalID === null ? null : auditUUID(raw.headGlobalID);
  if (head === 0n ? floor !== 0n || headGlobalID !== null : floor < 1n || floor > head || headGlobalID === null) fail('Invalid scoped audit bounds');
  return Object.freeze({ head, floor, headGlobalID, historyGeneration: raw.historyGeneration === null ? null : auditUUID(raw.historyGeneration) });
}
function available(native: ScopedNative): void { if (native.scopedCaptureVersion?.() !== 1) fail('Native scoped capture version1 is required'); }
function rows(input: unknown, request: ScopedSelection, exact: readonly string[] | undefined, page?: ScopedIndexedRequest): readonly ScopedIndexedRow[] {
  let bytes = 0, blobs = 0, previous = page?.afterID ?? 0n; const seen = new Set<string>();
  return Object.freeze(list(input, exact?.length ?? page!.limit).map(input => {
    const row = record(input, page ? ['id', 'table', 'globalId', 'values'] : ['table', 'globalId', 'values']);
    const globalId = uuid(row.globalId), id = page ? integer(row.id, true) : 0n;
    if (row.table !== request.table || seen.has(globalId) || (exact && !exact.includes(globalId)) || (page && id <= previous)) fail('Foreign/duplicate/unordered scoped row');
    seen.add(globalId); previous = id; bytes += 36;
    const fields = record(row.values, request.properties), values: Record<string, ScopedValue> = Object.create(null);
    for (const name of request.properties) {
      const cell = fields[name];
      if (cell === null) values[name] = null;
      else if (typeof cell === 'bigint') { values[name] = integer(cell); bytes += 8; }
      else if (typeof cell === 'number') { if (!Number.isFinite(cell)) fail('Invalid scoped number'); values[name] = cell; bytes += 8; }
      else if (typeof cell === 'string') {
        if (cell.length > 4096) fail('Scoped text bound exceeded'); const length = encoder.encode(cell).length;
        if (length > 4096) fail('Scoped text bound exceeded'); bytes += length; values[name] = cell;
      } else if (cell instanceof Uint8Array && Object.getPrototypeOf(cell) === Uint8Array.prototype &&
        !Object.prototype.hasOwnProperty.call(cell, 'byteLength') && !Object.prototype.hasOwnProperty.call(cell, 'buffer') &&
        cell.buffer instanceof ArrayBuffer && !page) {
        if (cell.byteLength > 262144 || cell.byteLength > 1048576 - blobs) fail('Scoped blob bound exceeded');
        blobs += cell.byteLength; values[name] = new Uint8Array(cell); // owns bytes even if a native implementation accidentally reuses an ArrayBuffer
      } else fail('Unsupported scoped physical value');
      if (bytes > (page ? 262144 : 65536)) fail('Scoped metadata bound exceeded');
    }
    return Object.freeze({ ...(page ? { id } : {}), table: request.table, globalId, values: Object.freeze(values) }) as ScopedIndexedRow;
  }));
}
export function captureByIDsSync(native: ScopedNative, input: ScopedIDRequest): ScopedCapture {
  const request = copyScopedIDRequest(input); available(native);
  if (!native.captureByIDsSync) fail('Native scoped exact read is unavailable');
  const raw = record(native.captureByIDsSync(request), ['formatVersion', 'rows', 'fence']);
  if (raw.formatVersion !== 1) fail('Unsupported scoped format');
  return Object.freeze({ formatVersion: 1, rows: rows(raw.rows, request, request.globalIDs), fence: copyAuditReadFence(raw.fence) });
}
export function captureByIndexedUUIDSync(native: ScopedNative, input: ScopedIndexedRequest): ScopedPage {
  const request = copyScopedIndexedRequest(input); available(native);
  if (!native.captureByIndexedUUIDSync) fail('Native scoped indexed read is unavailable');
  const raw = record(native.captureByIndexedUUIDSync(request), ['formatVersion', 'rows', 'hasMore', 'nextID', 'fence']);
  if (raw.formatVersion !== 1 || typeof raw.hasMore !== 'boolean') fail('Invalid scoped page');
  const copied = rows(raw.rows, request, undefined, request), nextID = raw.nextID === null ? null : integer(raw.nextID, true);
  if (nextID !== (copied.length ? copied[copied.length - 1]!.id : null) || (raw.hasMore && copied.length !== request.limit)) fail('Invalid scoped continuation');
  return Object.freeze({ formatVersion: 1, rows: copied, hasMore: raw.hasMore, nextID, fence: copyAuditReadFence(raw.fence) });
}
export function readFenceSync(native: ScopedNative): AuditReadFence {
  available(native); if (!native.readFenceSync) fail('Native scoped fence is unavailable'); return copyAuditReadFence(native.readFenceSync());
}
