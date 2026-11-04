import 'reflect-metadata';
import { defineModelIdentity, definePropertyAccessor, extractSchema, LATTICE_CONSTRAINTS } from './decorators';
import { DYNAMIC_OBJECT, EXPLICIT_MODEL, PROPERTY_SCHEMA, getWasmModule, isWasmReady, type PropertySchema } from './storage';
import { validateExplicitValue } from './explicit-values';
import { LATTICE_TABLE, type Constraint, type LatticeObject, type UnionCaseDescriptor, type UnionValue } from './types';

interface ExplicitPropertyBase {
    readonly name: string;
    readonly nullable: boolean;
    readonly isIndexed?: boolean;
    readonly isFullText?: boolean;
}
export type ExplicitPropertyDescriptor = ExplicitPropertyBase & (
    | ({ readonly noHistory?: boolean } & (
        | { readonly kind: 'primitive'; readonly type: 'string' | 'float' | 'bool' | 'blob' }
        | { readonly kind: 'primitive'; readonly type: 'int'; readonly representation: 'bigint' }
        | { readonly kind: 'primitive'; readonly type: 'date'; readonly representation: 'unixSeconds' }))
    | { readonly kind: 'link'; readonly type: 'int'; readonly targetTable: string }
    | { readonly kind: 'union'; readonly type: 'string'; readonly nullable: true;
        readonly logicalNullable: boolean; readonly targetTable: string;
        readonly unionCases: readonly UnionCaseDescriptor[] }
);
export interface ExplicitModelDescriptor {
    readonly tableName: string;
    readonly properties: readonly ExplicitPropertyDescriptor[];
    readonly constraints?: readonly { readonly columns: readonly string[]; readonly allowsUpsert?: boolean }[];
}
export interface ExplicitModelsDefinition {
    readonly formatVersion: 1;
    readonly models: readonly ExplicitModelDescriptor[];
}
type Scalar<P> = P extends { kind: 'union' } ? UnionValue
    : P extends { kind: 'link' } ? LatticeObject
    : P extends { type: 'int' } ? bigint
    : P extends { type: 'float' | 'date' } ? number
    : P extends { type: 'bool' } ? boolean
    : P extends { type: 'blob' } ? Uint8Array : string;
export type ExplicitValues<M extends ExplicitModelDescriptor> = {
    [P in M['properties'][number] as P['name']]: Scalar<P> |
        (P extends { kind: 'union'; logicalNullable: infer N } ? N extends false ? never : null
            : P['nullable'] extends false ? never : null)
};
export type ExplicitModelConstructor<M extends ExplicitModelDescriptor = ExplicitModelDescriptor> =
    new (values: ExplicitValues<M>) => ExplicitValues<M> & LatticeObject;
export type DefinedModels<D extends ExplicitModelsDefinition> = {
    readonly [M in D['models'][number] as M['tableName']]: ExplicitModelConstructor<M>
};

function record(value: unknown, label: string): Record<string, any> {
    if (typeof value !== 'object' || value === null ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} must be a plain record`);
    for (const desc of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in desc) || !desc.enumerable) throw new TypeError(`${label} cannot contain accessors or hidden fields`);
    }
    return value as Record<string, any>;
}
function keys(value: Record<string, any>, allowed: string[], label: string): void {
    for (const key of Object.getOwnPropertyNames(value)) {
        if (!allowed.includes(key)) throw new TypeError(`Unsupported ${label} field: ${key}`);
    }
}
function identifier(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ||
        ['__proto__', 'prototype', 'constructor', 'id', 'globalId'].includes(value)) {
        throw new TypeError(`Invalid ${label} identifier`);
    }
}

function dataArray(input: unknown, maximum: number, label: string): unknown[] {
    if (!Array.isArray(input) || input.length > maximum || Object.getOwnPropertyNames(input).length !== input.length + 1 || Object.getOwnPropertySymbols(input).length) throw new TypeError(`${label} requires a dense bounded data array`);
    const values: unknown[] = [];
    for (let index = 0; index < input.length; ++index) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`${label} cannot contain sparse, hidden or accessor elements`);
        values.push(descriptor.value);
    }
    return values;
}

function unionCases(input: unknown): readonly UnionCaseDescriptor[] {
    const rawCases = dataArray(input, 128, 'unionCases');
    if (rawCases.length === 0) throw new TypeError('unionCases must contain 1 to 128 cases');
    const names = new Set<string>(), columns = new Set(['id', 'globalid', 'case']);
    return Object.freeze(rawCases.map(raw => {
        const c = record(raw, 'union case');
        keys(c, ['name', 'values'], 'union case');
        identifier(c.name, 'union case');
        if (names.has(c.name)) throw new TypeError(`Duplicate union case: ${c.name}`);
        names.add(c.name);
        const rawValues = dataArray(c.values, 64, 'Union case values');
        const fields = new Set<string>();
        const values = rawValues.map((rawValue: unknown, index: number) => {
            const value = record(rawValue, 'union associated value');
            keys(value, ['paramName', 'type'], 'union associated value');
            if (value.paramName !== '') identifier(value.paramName, 'union parameter');
            if (value.paramName === '' && rawValues.length !== 1) throw new TypeError('Multi-value union cases require named parameters');
            if (value.type !== 'string' && value.type !== 'int') throw new TypeError('Union fields support only string or int storage');
            const key = value.paramName || `_${index}`;
            if (fields.has(key)) throw new TypeError(`Duplicate union field: ${key}`);
            fields.add(key);
            const column = rawValues.length === 1 && value.paramName === '' ? c.name : `${c.name}__${key}`;
            identifier(column, 'derived union column');
            if (columns.has(column.toLowerCase())) throw new TypeError(`Ambiguous union column: ${column}`);
            columns.add(column.toLowerCase());
            return Object.freeze({ paramName: value.paramName as string, type: value.type as 'string' | 'int' });
        });
        return Object.freeze({ name: c.name as string, values: Object.freeze(values) });
    }));
}

/** Validate and copy everything before installing metadata or touching WASM. */
function validateDefinition(input: unknown): ExplicitModelDescriptor[] {
    const definition = record(input, 'definition');
    keys(definition, ['formatVersion', 'models'], 'definition');
    if (definition.formatVersion !== 1) throw new TypeError('Unsupported explicit model formatVersion');
    if (!Array.isArray(definition.models) || definition.models.length === 0) throw new TypeError('models must be a nonempty array');
    const tables = new Set<string>();
    const physicalTables = new Set<string>();
    const models: ExplicitModelDescriptor[] = [];
    for (const rawModel of definition.models) {
        const model = record(rawModel, 'model');
        keys(model, ['tableName', 'properties', 'constraints'], 'model');
        identifier(model.tableName, 'table');
        if (physicalTables.has(model.tableName.toLowerCase())) throw new TypeError(`Duplicate table: ${model.tableName}`);
        tables.add(model.tableName);
        physicalTables.add(model.tableName.toLowerCase());
        if (!Array.isArray(model.properties)) throw new TypeError('properties must be an array');
        const names = new Set<string>();
        const physicalNames = new Set<string>(['id', 'globalid']);
        const properties: ExplicitPropertyDescriptor[] = [];
        for (const rawProperty of model.properties) {
            const p = record(rawProperty, 'property');
            keys(p, ['name', 'kind', 'type', 'nullable', 'isIndexed', 'isFullText', 'noHistory', 'representation', 'targetTable', 'logicalNullable', 'unionCases'], 'property');
            identifier(p.name, 'property');
            if (physicalNames.has(p.name.toLowerCase())) throw new TypeError(`Duplicate property: ${p.name}`);
            names.add(p.name);
            physicalNames.add(p.name.toLowerCase());
            if (typeof p.nullable !== 'boolean') throw new TypeError(`${p.name} requires explicit nullable`);
            for (const flag of ['isIndexed', 'isFullText']) {
                if (Object.hasOwn(p, flag) && typeof p[flag] !== 'boolean') throw new TypeError(`${flag} must be boolean`);
            }
            if (Object.hasOwn(p, 'noHistory') && (p.kind !== 'primitive' || typeof p.noHistory !== 'boolean')) throw new TypeError('noHistory requires a primitive property and boolean flag');
            if (p.kind !== 'union' && (Object.hasOwn(p, 'logicalNullable') || Object.hasOwn(p, 'unionCases'))) throw new TypeError('Union metadata requires a union property');
            if (p.kind === 'union') {
                if (p.type !== 'string' || p.nullable !== true || typeof p.logicalNullable !== 'boolean' || Object.hasOwn(p, 'representation')) throw new TypeError('Unions require string storage, physical nullable:true and explicit logicalNullable');
                identifier(p.targetTable, 'union table');
                if (p.isFullText || p.isIndexed) throw new TypeError('Index flags are not supported for union references');
                properties.push(Object.freeze({ ...p, unionCases: unionCases(p.unionCases) }) as ExplicitPropertyDescriptor);
                continue;
            } else if (p.kind === 'link') {
                if (p.type !== 'int' || Object.hasOwn(p, 'representation')) throw new TypeError('Links require int storage and targetTable');
                identifier(p.targetTable, 'link target');
                if (p.isFullText) throw new TypeError('Full text requires a primitive string');
            } else if (p.kind === 'primitive') {
                if (!['string', 'int', 'float', 'bool', 'date', 'blob'].includes(p.type) || Object.hasOwn(p, 'targetTable')) throw new TypeError('Unsupported primitive descriptor');
                const representation = p.type === 'int' ? 'bigint' : p.type === 'date' ? 'unixSeconds' : undefined;
                if (representation ? p.representation !== representation : Object.hasOwn(p, 'representation')) throw new TypeError(`Unsupported representation for ${p.name}`);
                if (p.isFullText && p.type !== 'string') throw new TypeError('Full text requires a primitive string');
            } else throw new TypeError(`Unsupported property kind: ${p.kind}`);
            properties.push(Object.freeze({ ...p }) as ExplicitPropertyDescriptor);
        }
        const constraints: Constraint[] = [];
        if (Object.hasOwn(model, 'constraints') && !Array.isArray(model.constraints)) throw new TypeError('constraints must be an array');
        for (const rawConstraint of model.constraints ?? []) {
            const c = record(rawConstraint, 'constraint');
            keys(c, ['columns', 'allowsUpsert'], 'constraint');
            if (!Array.isArray(c.columns) || c.columns.length === 0 || new Set(c.columns).size !== c.columns.length || c.columns.some((name: unknown) => typeof name !== 'string' || !names.has(name))) throw new TypeError('Constraint columns must name distinct declared properties');
            if (Object.hasOwn(c, 'allowsUpsert') && typeof c.allowsUpsert !== 'boolean') throw new TypeError('allowsUpsert must be boolean');
            constraints.push(Object.freeze({ columns: Object.freeze([...c.columns]) as unknown as string[], allowsUpsert: c.allowsUpsert ?? false }));
        }
        models.push(Object.freeze({ tableName: model.tableName, properties: Object.freeze(properties), constraints: Object.freeze(constraints) }));
    }
    const unionTables = new Map<string, string>();
    for (const model of models) for (const p of model.properties) {
        if (p.kind === 'link' && !tables.has(p.targetTable)) throw new TypeError(`Unknown link target: ${p.targetTable}`);
        if (p.kind === 'union') {
            const physicalTable = p.targetTable.toLowerCase();
            if ([...tables].some(table => table.toLowerCase() === physicalTable)) throw new TypeError(`Union table conflicts with model: ${p.targetTable}`);
            const encoded = p.targetTable + ':' + JSON.stringify(p.unionCases);
            if (unionTables.has(physicalTable) && unionTables.get(physicalTable) !== encoded) throw new TypeError(`Conflicting union table descriptor: ${p.targetTable}`);
            unionTables.set(physicalTable, encoded);
        }
    }
    return models;
}

/**
 * Define storage-backed models without constructors, inferred types or defaults.
 * Lists remain unsupported; unions and NoHistory require explicit capabilities.
 */
export function defineModels<const D extends ExplicitModelsDefinition>(definition: D): DefinedModels<D> {
    const descriptors = validateDefinition(definition);
    const models: Record<string, ExplicitModelConstructor> = Object.create(null);
    const schemas = new Map<string, PropertySchema[]>();
    for (const descriptor of descriptors) {
        const tableName = descriptor.tableName;
        const Model = class {
            constructor(values: Record<string, unknown>) {
                const fields = schemas.get(tableName)!;
                const supplied = record(values, `${tableName} creation values`);
                keys(supplied, fields.map(f => f.name), 'creation');
                for (const field of fields) {
                    if (!Object.hasOwn(supplied, field.name)) throw new TypeError(`Missing creation value: ${field.name}`);
                    validateExplicitValue(field, supplied[field.name]);
                }
                if (!isWasmReady()) throw new Error(`Cannot create ${tableName} - WASM not loaded. Call Lattice.open() first.`);
                if (fields.some(field => field.kind === 'union') && getWasmModule().explicitUnionVersion?.() !== 1) throw new Error('Native explicitUnionVersion 1 capability required');
                if (fields.some(field => field.noHistory === true) && getWasmModule().explicitNoHistoryVersion?.() !== 1) throw new Error('Native explicitNoHistoryVersion 1 capability required');
                const properties = extractSchema(Model, new Set()).properties;
                const dynObj = getWasmModule().createDynamicObject(tableName, properties);
                if (!dynObj?.isValid()) {
                    dynObj?.delete?.();
                    throw new Error(`Cannot create native object for ${tableName}`);
                }
                (this as any)[DYNAMIC_OBJECT] = dynObj;
                try {
                    for (const field of fields) (this as any)[field.name] = supplied[field.name];
                    defineModelIdentity(this, dynObj, true);
                } catch (error) {
                    dynObj.delete?.();
                    throw error;
                }
            }
        };
        Object.defineProperty(Model, 'name', { value: tableName });
        Reflect.defineMetadata(LATTICE_TABLE, tableName, Model);
        Reflect.defineMetadata(EXPLICIT_MODEL, true, Model);
        Reflect.defineMetadata(LATTICE_CONSTRAINTS, descriptor.constraints, Model);
        models[tableName] = Model as unknown as ExplicitModelConstructor;
    }
    for (const descriptor of descriptors) {
        const Model = models[descriptor.tableName];
        const fields = descriptor.properties.map(p => Object.freeze({
            name: p.name, kind: p.kind, type: p.type, nullable: p.nullable,
            isIndexed: p.isIndexed ?? false, isFullText: p.isFullText ?? false,
            ...(p.kind === 'primitive' && Object.hasOwn(p, 'noHistory') ? { noHistory: p.noHistory } : {}),
            defaultValue: undefined,
            explicit: p.kind === 'union' ? 'union' : p.kind === 'link' ? 'link' : 'representation' in p ? p.representation : 'scalar',
            ...(p.kind === 'link' ? { targetModel: models[p.targetTable] } : {}),
            ...(p.kind === 'union' ? { targetTable: p.targetTable, logicalNullable: p.logicalNullable, unionCases: p.unionCases } : {}),
        }) as PropertySchema);
        schemas.set(descriptor.tableName, fields);
        Reflect.defineMetadata(PROPERTY_SCHEMA, Object.freeze(fields), Model);
        for (const field of fields) definePropertyAccessor(Model.prototype, field);
    }
    return Object.freeze(models) as DefinedModels<D>;
}
