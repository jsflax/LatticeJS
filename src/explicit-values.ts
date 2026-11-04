import { DYNAMIC_OBJECT, EXPLICIT_MODEL, type PropertySchema } from './storage';
import type { ModelConstructor } from './types';

const MIN_INT64 = -(1n << 63n);
const MAX_INT64 = (1n << 63n) - 1n;

export function isExplicitModel(model: ModelConstructor): boolean {
    return Reflect.getMetadata(EXPLICIT_MODEL, model) === true;
}

/** The current find/remove bridge accepts safe Number IDs, not all Int64 IDs. */
export function checkedRowId(value: unknown): number {
    if (typeof value === 'bigint') {
        if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Row ID exceeds the supported safe integer range');
        return Number(value);
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new RangeError('Row ID must be a positive safe integer');
    }
    return value;
}

function int64(value: unknown): bigint {
    if (typeof value !== 'bigint') throw new TypeError('Int64 values require bigint');
    if (value < MIN_INT64 || value > MAX_INT64) throw new RangeError('Int64 value out of range');
    return value;
}

export function validateExplicitValue(schema: PropertySchema, value: unknown): void {
    const label = `Invalid ${schema.name}`;
    if (schema.kind === 'union') { copyExplicitUnion(schema, value); return; }
    if (value === null && schema.nullable) return;
    if (value === null || value === undefined) throw new TypeError(`${label}: explicit ${schema.nullable ? 'value or null' : 'non-null value'} required`);
    if (schema.kind === 'link') {
        if (!(value instanceof schema.targetModel) || !(value as any)[DYNAMIC_OBJECT]?.isValid()) {
            throw new TypeError(`${label}: expected an instance of the declared link target`);
        }
        return;
    }
    switch (schema.type) {
        case 'int': int64(value); return;
        case 'date':
        case 'float':
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label}: finite ${schema.type === 'date' ? 'Unix seconds' : 'number'} required`);
            return;
        case 'string': if (typeof value !== 'string') throw new TypeError(`${label}: string required`); return;
        case 'bool': if (typeof value !== 'boolean') throw new TypeError(`${label}: boolean required`); return;
        case 'blob': if (!(value instanceof Uint8Array)) throw new TypeError(`${label}: Uint8Array required`); return;
    }
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} must be a plain record`);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`${label} cannot contain accessors or hidden fields`);
    }
    return value as Record<string, unknown>;
}

/** Copy active fields so neither caller mutation nor native DTO reuse changes a read. */
export function copyExplicitUnion(schema: PropertySchema, input: unknown): import('./types').UnionValue | null {
    if (input === null && schema.logicalNullable === true) return null;
    if (input === null || input === undefined) throw new TypeError(`Invalid ${schema.name}: non-null union required`);
    const value = plainRecord(input, 'Union value');
    if (Object.getOwnPropertyNames(value).some(key => !['case', 'fields'].includes(key)) || !Object.hasOwn(value, 'case') || !Object.hasOwn(value, 'fields')) throw new TypeError('Union value requires exactly case and fields');
    const active = schema.unionCases?.find(item => item.name === value.case);
    if (!active) throw new TypeError(`Unknown union case for ${schema.name}`);
    const supplied = plainRecord(value.fields, 'Union fields');
    const expected = active.values.map((field, index) => field.paramName || `_${index}`);
    if (Object.getOwnPropertyNames(supplied).length !== expected.length || expected.some(key => !Object.hasOwn(supplied, key))) throw new TypeError('Union fields must exactly match the active case');
    const fields: Record<string, string | bigint> = {};
    for (let index = 0; index < active.values.length; ++index) {
        const field = active.values[index], key = expected[index], raw = supplied[key];
        if (field.type === 'int') fields[key] = int64(raw);
        else {
            if (typeof raw !== 'string') throw new TypeError(`Union field ${key} requires string`);
            fields[key] = raw;
        }
    }
    return Object.freeze({ case: active.name, fields: Object.freeze(fields) });
}

export function readExplicitUnion(dynObj: any, name: string, schema: PropertySchema): unknown {
    if (typeof dynObj.getUnion !== 'function') throw new Error('Native getUnion capability required');
    return copyExplicitUnion(schema, dynObj.getUnion(name));
}

export function readExplicitScalar(dynObj: any, name: string, schema: PropertySchema): unknown {
    if (!dynObj.hasValue(name)) {
        if (schema.nullable) return null;
        throw new TypeError(`Missing required stored value: ${name}`);
    }
    let value: unknown;
    switch (schema.type) {
        case 'int': {
            const raw = dynObj.getInt(name);
            // Some bindings expose small integers as Number. Never round one.
            value = typeof raw === 'number' && Number.isSafeInteger(raw) ? BigInt(raw) : raw;
            break;
        }
        case 'float':
        case 'date': value = dynObj.getDouble(name); break;
        case 'string': value = dynObj.getString(name); break;
        case 'bool': value = dynObj.getBool(name); break;
        case 'blob': value = dynObj.getData(name); break;
    }
    validateExplicitValue(schema, value);
    return value;
}
