/** Bounded, synchronous detached reads. Native qualification is required;
 * older runtimes must refuse instead of emulating capture with multiple calls. */
export interface CaptureSelector {
    readonly table: string;
    readonly properties: readonly string[];
    readonly maxRows?: number;
}
export interface CapturedLink { readonly table: string; readonly globalId: string }
/** Physical codecs: INTEGER is BigInt; REAL (including Unix-second dates) is
 * Number; embedded JSON/enums remain text. No constructor/type inference. */
export type CapturedValue = null | bigint | number | string | readonly number[] | CapturedLink;
export interface CapturedRow {
    readonly table: string;
    readonly globalId: string;
    readonly values: Readonly<Record<string, CapturedValue>>;
}
export interface CapturedValues { readonly formatVersion: 1; readonly rows: readonly CapturedRow[] }
export interface CaptureNative { captureValuesSync?: (selectors: readonly CaptureSelector[]) => unknown }
export const CAPTURE_LIMITS = Object.freeze({ selectors: 16, properties: 64, rows: 16384,
    cellBytes: 262144, totalBytes: 8 * 1024 * 1024, workCells: 262144 });
const encoder = new TextEncoder();
const own = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);

function record(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`Invalid ${name}`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in descriptors[key]))) throw new Error(`Invalid ${name} data fields`);
    return value as Record<string, unknown>;
}
function list(value: unknown, limit: number, name: string): readonly unknown[] {
    if (!Array.isArray(value) || value.length > limit) throw new Error(`Invalid ${name} bounds`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || !('value' in descriptors[key])))) throw new Error(`Invalid ${name} data elements`);
    for (let i = 0; i < value.length; ++i) if (!own(value, i)) throw new Error(`Invalid ${name} sparse array`);
    return value;
}
function name(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || encoder.encode(value).length > 128) throw new Error(`Invalid capture ${label}`);
    return value;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
    if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unsupported ${label} field`);
}
export function copyCaptureSelectors(input: readonly CaptureSelector[]): readonly CaptureSelector[] {
    const tables = new Set<string>();
    const selectors = list(input, CAPTURE_LIMITS.selectors, 'capture selectors');
    if (!selectors.length) throw new Error('Capture requires a selector');
    return Object.freeze(selectors.map(value => {
        const selector = record(value, 'capture selector'); exactKeys(selector, ['table', 'properties', 'maxRows'], 'capture selector');
        const table = name(selector.table, 'table'), folded = table.toLowerCase();
        if (tables.has(folded)) throw new Error('Duplicate capture table'); tables.add(folded);
        const seen = new Set<string>();
        const properties = list(selector.properties, CAPTURE_LIMITS.properties, 'capture properties').map(value => {
            const property = name(value, 'property');
            if (['id', 'globalid'].includes(property.toLowerCase()) || seen.has(property.toLowerCase())) throw new Error('Duplicate or reserved capture property');
            seen.add(property.toLowerCase()); return property;
        });
        if (!properties.length) throw new Error('Capture requires a property');
        const maxRows = own(selector, 'maxRows') ? selector.maxRows : CAPTURE_LIMITS.rows;
        if (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > CAPTURE_LIMITS.rows) throw new Error('Invalid capture maxRows');
        return Object.freeze({ table, properties: Object.freeze(properties), maxRows });
    }));
}

/** Exactly one native call. No await, callbacks, lazy models, SQL or URL fetches. */
export function captureValuesSync(native: CaptureNative, input: readonly CaptureSelector[]): CapturedValues {
    const selectors = copyCaptureSelectors(input);
    if (typeof native.captureValuesSync !== 'function') throw new Error('Native captureValuesSync capability is required');
    const result = record(native.captureValuesSync(selectors), 'capture result');
    exactKeys(result, ['formatVersion', 'rows'], 'capture result');
    if (result.formatVersion !== 1) throw new Error('Unsupported capture format');
    const byTable = new Map(selectors.map(selector => [selector.table, selector]));
    const counts = new Map<string, number>(), identities = new Set<string>();
    let bytes = 0, work = 0;
    const take = (amount: number) => {
        if (amount > CAPTURE_LIMITS.cellBytes) throw new Error('Capture cell byte bound exceeded');
        bytes += amount;
        if (bytes > CAPTURE_LIMITS.totalBytes) throw new Error('Capture aggregate byte bound exceeded');
    };
    const text = (value: unknown, label: string, nonempty = false): string => {
        if (typeof value !== 'string' || (nonempty && !value.length)) throw new Error(`Invalid capture ${label}`);
        take(encoder.encode(value).length); return value;
    };
    const rows = list(result.rows, CAPTURE_LIMITS.rows, 'capture rows').map(value => {
        const row = record(value, 'capture row'); exactKeys(row, ['table', 'globalId', 'values'], 'capture row');
        const table = name(row.table, 'row table'), selector = byTable.get(table);
        if (!selector) throw new Error('Unexpected capture table');
        take(encoder.encode(table).length);
        const globalId = text(row.globalId, 'globalId', true), identity = JSON.stringify([table, globalId]);
        if (identities.has(identity)) throw new Error('Duplicate captured row'); identities.add(identity);
        const count = (counts.get(table) ?? 0) + 1; counts.set(table, count);
        if (count > selector.maxRows!) throw new Error('Capture table row bound exceeded');
        const values = record(row.values, 'captured values'); exactKeys(values, selector.properties, 'captured values');
        const copied: Record<string, CapturedValue> = Object.create(null);
        for (const property of selector.properties) {
            if (!own(values, property)) throw new Error('Missing captured property');
            if (++work > CAPTURE_LIMITS.workCells) throw new Error('Capture work bound exceeded');
            const cell = values[property];
            if (cell === null) copied[property] = null;
            else if (typeof cell === 'bigint') {
                if (cell < -(1n << 63n) || cell > (1n << 63n) - 1n) throw new Error('Captured Int64 out of range');
                copied[property] = cell;
            } else if (typeof cell === 'number') {
                if (!Number.isFinite(cell)) throw new Error('Captured REAL must be finite');
                copied[property] = cell;
            } else if (typeof cell === 'string') copied[property] = text(cell, 'text');
            else if (Array.isArray(cell)) {
                const blob = list(cell, CAPTURE_LIMITS.cellBytes, 'capture blob'); take(blob.length);
                if (blob.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Invalid captured byte');
                copied[property] = Object.freeze([...blob]) as readonly number[];
            } else {
                const link = record(cell, 'captured link'); exactKeys(link, ['table', 'globalId'], 'captured link');
                const target = name(link.table, 'link table');
                if (!byTable.has(target)) throw new Error('Captured link target must be selected');
                take(encoder.encode(target).length);
                copied[property] = Object.freeze({ table: target, globalId: text(link.globalId, 'link globalId', true) });
            }
        }
        return Object.freeze({ table, globalId, values: Object.freeze(copied) });
    });
    return Object.freeze({ formatVersion: 1, rows: Object.freeze(rows) });
}
