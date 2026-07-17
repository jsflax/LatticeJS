// TypeScript decorators for LatticeJS model definitions
import 'reflect-metadata';
import {
    ColumnType,
    PropertyDescriptor,
    SchemaEntry,
    Constraint,
    ModelConstructor,
    LATTICE_TABLE,
    LATTICE_FIELDS,
    LATTICE_LINKS,
    LATTICE_LISTS,
} from './types';
import {
    DYNAMIC_OBJECT,
    PROPERTY_SCHEMA,
    LATTICE_REF,
    PropertySchema,
    getWasmModule,
    isWasmReady,
} from './storage';

// ============================================================================
// Link Marker
// ============================================================================

const LINK_MARKER = Symbol('lattice:link');

interface LinkMarker<T> {
    [LINK_MARKER]: true;
    target: ModelConstructor<T>;
}

/**
 * Creates a link property (to-one relationship) pointing to another model.
 */
export function link<T>(target: ModelConstructor<T>): T | null {
    const marker: LinkMarker<T> = {
        [LINK_MARKER]: true,
        target,
    };
    return marker as unknown as T | null;
}

/** Check if a value is a link marker */
export function isLinkMarker(value: unknown): value is LinkMarker<unknown> {
    return typeof value === 'object' && value !== null && LINK_MARKER in value;
}

/** Get the target model from a link marker */
export function getLinkTarget(value: LinkMarker<unknown>): ModelConstructor {
    return value.target;
}

// ============================================================================
// List Marker
// ============================================================================

const LIST_MARKER = Symbol('lattice:list');

interface ListMarker<T> {
    [LIST_MARKER]: true;
    target: ModelConstructor<T>;
    items: T[];
}

/**
 * Creates a list property (to-many relationship) pointing to another model.
 */
export function list<T>(target: ModelConstructor<T>): T[] {
    const marker: ListMarker<T> = {
        [LIST_MARKER]: true,
        target,
        items: [],
    };
    return marker as unknown as T[];
}

/** Check if a value is a list marker */
export function isListMarker(value: unknown): value is ListMarker<unknown> {
    return typeof value === 'object' && value !== null && LIST_MARKER in value;
}

/** Get the target model from a list marker */
export function getListTarget(value: ListMarker<unknown>): ModelConstructor {
    return value.target;
}

// ============================================================================
// Nullable Marker
// ============================================================================

const NULLABLE_MARKER = Symbol('lattice:nullable');

/** Supported nullable type constructors */
type NullableTypeConstructor = typeof Date | typeof String | typeof Number | typeof Boolean;

interface NullableMarker {
    [NULLABLE_MARKER]: true;
    typeConstructor: NullableTypeConstructor;
}

/**
 * Creates a nullable property with explicit type.
 * Use this for nullable fields where the default is null.
 *
 * @example
 * ```typescript
 * @model
 * class Event {
 *     title = '';
 *     createdAt = new Date();
 *     updatedAt = nullable(Date);  // Date | null, defaults to null
 * }
 * ```
 */
export function nullable<T extends NullableTypeConstructor>(typeConstructor: T): null {
    const marker: NullableMarker = {
        [NULLABLE_MARKER]: true,
        typeConstructor,
    };
    return marker as unknown as null;
}

/** Check if a value is a nullable marker */
export function isNullableMarker(value: unknown): value is NullableMarker {
    return typeof value === 'object' && value !== null && NULLABLE_MARKER in value;
}

/** Get the column type from a nullable marker */
function getNullableColumnType(marker: NullableMarker): ColumnType {
    switch (marker.typeConstructor) {
        case Date: return 'date';
        case String: return 'string';
        case Number: return 'float';
        case Boolean: return 'bool';
        default: return 'string';
    }
}

// ============================================================================
// Indexed Marker
// ============================================================================

const INDEXED_MARKER = Symbol('lattice:indexed');

interface IndexedMarker {
    [INDEXED_MARKER]: true;
    innerValue: unknown;
}

/**
 * Marks a property as indexed for faster queries.
 * Wrap a default value: `name = indexed('')`
 */
export function indexed<T>(defaultValue: T): T {
    const marker: IndexedMarker = {
        [INDEXED_MARKER]: true,
        innerValue: defaultValue,
    };
    return marker as unknown as T;
}

export function isIndexedMarker(value: unknown): value is IndexedMarker {
    return typeof value === 'object' && value !== null && INDEXED_MARKER in value;
}

// ============================================================================
// Full Text Marker
// ============================================================================

const FULL_TEXT_MARKER = Symbol('lattice:fullText');

interface FullTextMarker {
    [FULL_TEXT_MARKER]: true;
    innerValue: unknown;
}

/**
 * Marks a string property for FTS5 full-text search.
 * Wrap a default value: `content = fullText('')`
 */
export function fullText<T extends string>(defaultValue: T): T {
    const marker: FullTextMarker = {
        [FULL_TEXT_MARKER]: true,
        innerValue: defaultValue,
    };
    return marker as unknown as T;
}

export function isFullTextMarker(value: unknown): value is FullTextMarker {
    return typeof value === 'object' && value !== null && FULL_TEXT_MARKER in value;
}

// ============================================================================
// Vector Marker
// ============================================================================

const VECTOR_MARKER = Symbol('lattice:vector');

interface VectorMarker {
    [VECTOR_MARKER]: true;
    dimensions: number;
}

/**
 * Marks a property as a vector column for nearest-neighbor search.
 * @param dimensions - The fixed dimensionality of the vector
 *
 * @example
 * ```typescript
 * @model
 * class Document {
 *     title = '';
 *     embedding = vector(384);
 * }
 * ```
 */
export function vector(dimensions: number): Float32Array {
    const marker: VectorMarker = {
        [VECTOR_MARKER]: true,
        dimensions,
    };
    return marker as unknown as Float32Array;
}

export function isVectorMarker(value: unknown): value is VectorMarker {
    return typeof value === 'object' && value !== null && VECTOR_MARKER in value;
}

// ============================================================================
// Embedded Model Marker
// ============================================================================

const EMBEDDED_MARKER = Symbol('lattice:embedded');

interface EmbeddedMarker<T> {
    [EMBEDDED_MARKER]: true;
    embeddedClass: new () => T;
}

/**
 * Marks a property as an embedded model (stored as JSON TEXT).
 *
 * @example
 * ```typescript
 * class Address {
 *     street = '';
 *     city = '';
 *     zip = '';
 * }
 *
 * @model
 * class Person {
 *     name = '';
 *     address = embedded(Address);
 * }
 * ```
 */
export function embedded<T>(embeddedClass: new () => T): T | null {
    const marker: EmbeddedMarker<T> = {
        [EMBEDDED_MARKER]: true,
        embeddedClass,
    };
    return marker as unknown as T | null;
}

export function isEmbeddedMarker(value: unknown): value is EmbeddedMarker<any> {
    return typeof value === 'object' && value !== null && EMBEDDED_MARKER in value;
}

// ============================================================================
// Enum Value Marker
// ============================================================================

const ENUM_MARKER = Symbol('lattice:enum');

interface EnumMarker {
    [ENUM_MARKER]: true;
    enumObj: Record<string, string | number>;
    defaultValue?: string | number;
}

/**
 * Marks a property as an enum value.
 * Numeric enums are stored as INT, string enums as TEXT.
 *
 * @example
 * ```typescript
 * enum Status { Active = 'active', Inactive = 'inactive' }
 *
 * @model
 * class Task {
 *     status = enumValue(Status, Status.Active);
 * }
 * ```
 */
export function enumValue<T extends Record<string, string | number>>(
    enumObj: T,
    defaultValue?: T[keyof T]
): T[keyof T] {
    const marker: EnumMarker = {
        [ENUM_MARKER]: true,
        enumObj,
        defaultValue,
    };
    return marker as unknown as T[keyof T];
}

export function isEnumMarker(value: unknown): value is EnumMarker {
    return typeof value === 'object' && value !== null && ENUM_MARKER in value;
}

function isNumericEnum(enumObj: Record<string, string | number>): boolean {
    return Object.values(enumObj).some(v => typeof v === 'number');
}

// ============================================================================
// Unique Constraint Metadata
// ============================================================================

const LATTICE_CONSTRAINTS = Symbol('lattice:constraints');

/**
 * Apply a unique constraint to a single property.
 * Use as a decorator: `@unique() name = ''`
 * Or as a function passed to the model.
 */
export function unique(opts?: { allowsUpsert?: boolean }): PropertyDecorator {
    return (target: any, propertyKey: string | symbol) => {
        const constraints: Constraint[] = Reflect.getMetadata(LATTICE_CONSTRAINTS, target.constructor) || [];
        constraints.push({
            columns: [String(propertyKey)],
            allowsUpsert: opts?.allowsUpsert,
        });
        Reflect.defineMetadata(LATTICE_CONSTRAINTS, constraints, target.constructor);
    };
}

/**
 * Apply a compound unique constraint across multiple fields.
 * Call before @model decorator or store on the class.
 */
export function compoundUnique(fields: string[], opts?: { allowsUpsert?: boolean }): ClassDecorator {
    return (target: any) => {
        const constraints: Constraint[] = Reflect.getMetadata(LATTICE_CONSTRAINTS, target) || [];
        constraints.push({
            columns: fields,
            allowsUpsert: opts?.allowsUpsert,
        });
        Reflect.defineMetadata(LATTICE_CONSTRAINTS, constraints, target);
    };
}

// ============================================================================
// @model Decorator
// ============================================================================

/**
 * Marks a class as a Lattice model with C++ backing storage.
 *
 * Properties become getters/setters that read/write to C++ dynamic_object.
 */
export function model<T extends ModelConstructor>(target: T): T;
export function model(tableName: string): <T extends ModelConstructor>(target: T) => T;
export function model<T extends ModelConstructor>(targetOrName: T | string) {
    if (typeof targetOrName === 'string') {
        return function (target: T): T {
            return transformModelClass(target, targetOrName);
        };
    }
    const name = targetOrName.name;
    if (name.length <= 2) {
        throw new Error(
            `[Lattice] @model applied to class with minified name "${name}". ` +
            `Add latticePlugin() from '@jsflax/lattice/vite' to your Vite config, ` +
            `or use @model('ClassName') with an explicit name.`
        );
    }
    return transformModelClass(targetOrName, name);
}

/**
 * Transform a class to use C++ backing storage.
 */
function transformModelClass<T extends ModelConstructor>(target: T, tableName: string): T {
    // Create a prototype instance to discover properties and defaults
    const prototypeInstance = new target();
    const propertySchemas: PropertySchema[] = [];

    // Collect property information
    for (const key of Object.keys(prototypeInstance)) {
        if (key === 'id' || key === 'globalId') continue;

        const value = (prototypeInstance as any)[key];

        if (isLinkMarker(value)) {
            propertySchemas.push({
                name: key,
                type: 'int',
                kind: 'link',
                defaultValue: null,
                targetModel: getLinkTarget(value),
            });
        } else if (isListMarker(value)) {
            propertySchemas.push({
                name: key,
                type: 'int',
                kind: 'list',
                defaultValue: [],
                targetModel: getListTarget(value),
            });
        } else if (isNullableMarker(value)) {
            propertySchemas.push({
                name: key,
                type: getNullableColumnType(value),
                kind: 'primitive',
                defaultValue: null,
                nullable: true,
            });
        } else if (isVectorMarker(value)) {
            propertySchemas.push({
                name: key,
                type: 'blob',
                kind: 'primitive',
                defaultValue: null,
                nullable: true,
                isVector: true,
                vectorDimensions: value.dimensions,
            });
        } else if (isEmbeddedMarker(value)) {
            propertySchemas.push({
                name: key,
                type: 'string',
                kind: 'primitive',
                defaultValue: null,
                nullable: true,
                embeddedClass: value.embeddedClass,
            });
        } else if (isEnumMarker(value)) {
            const isNumeric = isNumericEnum(value.enumObj);
            propertySchemas.push({
                name: key,
                type: isNumeric ? 'int' : 'string',
                kind: 'primitive',
                defaultValue: value.defaultValue ?? (isNumeric ? 0 : ''),
                enumObj: value.enumObj,
            });
        } else {
            // Check for indexed/fullText wrappers
            let actualValue = value;
            let isIndexedProp = false;
            let isFullTextProp = false;

            if (isIndexedMarker(value)) {
                actualValue = value.innerValue;
                isIndexedProp = true;
            } else if (isFullTextMarker(value)) {
                actualValue = value.innerValue;
                isFullTextProp = true;
            }

            const isNullable = actualValue === null || actualValue === undefined;
            const inferredType = inferTypeFromValue(actualValue);
            propertySchemas.push({
                name: key,
                type: inferredType,
                kind: 'primitive',
                defaultValue: actualValue,
                nullable: isNullable,
                isIndexed: isIndexedProp,
                isFullText: isFullTextProp,
            });
        }
    }

    // Store the original constructor
    const OriginalClass = target;

    // Build schema properties array for C++ (needed for createDynamicObject)
    // Note: For self-referencing models (e.g. Dog.puppies: list(Dog)), the target
    // class isn't decorated yet, so we use the class name directly
    const cxxProperties = propertySchemas.map(s => {
        let targetTable = '';
        if (s.targetModel) {
            // Try to get table name, fall back to class name for self-references
            try {
                targetTable = getTableName(s.targetModel);
            } catch {
                targetTable = s.targetModel.name;
            }
        }
        return {
            name: s.name,
            type: s.type,
            kind: s.kind,
            targetTable,
            nullable: s.nullable ?? true,
            isVector: s.isVector ?? false,
            isFullText: s.isFullText ?? false,
            isIndexed: s.isIndexed ?? false,
        };
    });

    // Create wrapper class
    const NewClass = class extends (OriginalClass as any) {
        constructor(...args: any[]) {
            super(...args);

            // Capture default values before deleting properties
            const defaults: Record<string, any> = {};
            for (const schema of propertySchemas) {
                if (schema.kind === 'primitive') {
                    defaults[schema.name] = (this as any)[schema.name] ?? schema.defaultValue;
                }
            }

            // Remove instance properties - we'll use accessors instead
            for (const schema of propertySchemas) {
                delete (this as any)[schema.name];
            }

            // Create C++ backing object
            if (!isWasmReady()) {
                throw new Error(`Cannot create ${tableName} - WASM not loaded. Call Lattice.open() first.`);
            }

            const wasm = getWasmModule();
            (this as any)[DYNAMIC_OBJECT] = wasm.createDynamicObject(tableName, cxxProperties);

            // Set default values in C++ storage
            const dynObj = (this as any)[DYNAMIC_OBJECT];
            for (const schema of propertySchemas) {
                if (schema.kind === 'primitive' && defaults[schema.name] !== undefined) {
                    const value = defaults[schema.name];
                    switch (schema.type) {
                        case 'string':
                            dynObj.setString(schema.name, String(value));
                            break;
                        case 'int':
                            dynObj.setInt(schema.name, BigInt(Math.floor(value)));
                            break;
                        case 'float':
                            dynObj.setDouble(schema.name, Number(value));
                            break;
                        case 'bool':
                            dynObj.setBool(schema.name, Boolean(value));
                            break;
                    }
                }
            }

            // Define id and globalId getters (these read from C++ after object is managed)
            Object.defineProperty(this, 'id', {
                get() {
                    const id = dynObj.getInt('id');
                    return id ? Number(id) : undefined;
                },
                enumerable: true,
                configurable: true,
            });
            Object.defineProperty(this, 'globalId', {
                get() {
                    return dynObj.getString('globalId') || undefined;
                },
                enumerable: true,
                configurable: true,
            });
        }
    };

    // Copy static properties and name
    Object.defineProperty(NewClass, 'name', { value: OriginalClass.name, writable: false });

    // Define property accessors on prototype
    for (const schema of propertySchemas) {
        definePropertyAccessor(NewClass.prototype, schema);
    }

    // Update self-referencing targetModel to point to NewClass instead of original class
    for (const schema of propertySchemas) {
        if (schema.targetModel === target) {
            schema.targetModel = NewClass;
        }
    }

    // Store metadata on both the new class AND original (for link/list references)
    Reflect.defineMetadata(LATTICE_TABLE, tableName, NewClass);
    Reflect.defineMetadata(PROPERTY_SCHEMA, propertySchemas, NewClass);
    Reflect.defineMetadata(LATTICE_TABLE, tableName, target);
    Reflect.defineMetadata(PROPERTY_SCHEMA, propertySchemas, target);

    return NewClass as unknown as T;
}

/**
 * Define getter/setter for a property that uses C++ storage.
 */
function definePropertyAccessor(prototype: any, schema: PropertySchema): void {
    Object.defineProperty(prototype, schema.name, {
        get() {
            return getPropertyValue(this, schema.name, schema);
        },
        set(value: any) {
            setPropertyValue(this, schema.name, value, schema);
        },
        enumerable: true,
        configurable: true,
    });
}

/**
 * Get a property value from C++ storage.
 */
function getPropertyValue(instance: any, name: string, schema: PropertySchema): any {
    const dynObj = instance[DYNAMIC_OBJECT];
    if (!dynObj) return schema.defaultValue;

    // Handle embedded model — deserialize JSON
    if (schema.embeddedClass) {
        const json = dynObj.getString(name);
        if (!json) return null;
        try {
            const data = JSON.parse(json);
            const obj = new schema.embeddedClass();
            Object.assign(obj, data);
            return obj;
        } catch {
            return null;
        }
    }

    // Handle enum — convert stored value back to enum value
    if (schema.enumObj) {
        if (schema.type === 'int') {
            const val = dynObj.getInt(name);
            return typeof val === 'bigint' ? Number(val) : val;
        }
        return dynObj.getString(name);
    }

    // Handle vector — read blob, return Float32Array
    if (schema.isVector) {
        const data = dynObj.getData(name);
        if (!data || data.byteLength === 0) return null;
        return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    }

    // Handle link properties - use getObject to get linked DynamicObject
    if (schema.kind === 'link') {
        // Get linked object directly from C++
        const linkedDynObj = dynObj.getObject(name);
        if (!linkedDynObj || !linkedDynObj.isValid()) {
            console.log("invalid link")
            return null;
        }

        // Get the target model and lattice reference
        const targetModel = schema.targetModel;
        const lattice = instance[LATTICE_REF];
        if (!targetModel || !lattice) {
            console.log("no target model")
            return null;
        }

        // Create a model instance with the linked DynamicObject as backing
        console.log("AHHH HYDRATING");
        const linkedInstance = hydrateInstance(targetModel, linkedDynObj, lattice);

        return linkedInstance;
    }

    // Handle list properties - return List<T> wrapping C++ LinkList
    if (schema.kind === 'list') {
        // Check if we have a cached list
        if (!instance._resolvedLists) instance._resolvedLists = {};
        if (instance._resolvedLists[name]) {
            return instance._resolvedLists[name];
        }

        const lattice = instance[LATTICE_REF];
        if (!lattice) {
            return [];
        }

        // Debug: Check parent's id before getting link list
        const parentId = dynObj.getInt('id');
        console.log(`[getPropertyValue] Getting list '${name}' from parent id=${parentId}`);

        // Get LinkList from C++
        const linkList = dynObj.getLinkList(name);
        if (!linkList || !linkList.isValid()) {
            console.log(`[getPropertyValue] LinkList is invalid or null`);
            return [];
        }

        // Create List wrapper - we can't import List directly due to circular deps,
        // so we construct it inline here using the same logic
        const list = createListWrapper(linkList, schema.targetModel, lattice);

        // Cache and return
        instance._resolvedLists[name] = list;
        return list;
    }

    switch (schema.type) {
        case 'string':
            return dynObj.getString(name);
        case 'int':
            const intVal = dynObj.getInt(name);
            // Convert BigInt to Number for convenience
            return typeof intVal === 'bigint' ? Number(intVal) : intVal;
        case 'float':
            return dynObj.getDouble(name);
        case 'bool':
            return dynObj.getBool(name);
        case 'date':
            if (!dynObj.hasValue(name)) return null;
            const timestamp = dynObj.getDouble(name);
            return timestamp ? new Date(timestamp * 1000) : null;
        case 'blob':
            return dynObj.getData(name);
        default:
            return dynObj.getString(name);
    }
}

/**
 * Set a property value in C++ storage.
 */
function setPropertyValue(instance: any, name: string, value: any, schema: PropertySchema): void {
    const dynObj = instance[DYNAMIC_OBJECT];
    if (!dynObj) return;

    if (value === null || value === undefined) {
        dynObj.setNil(name);
        // Clear resolved link cache
        if (schema.kind === 'link' && instance._resolvedLinks) {
            delete instance._resolvedLinks[name];
        }
        return;
    }

    // Handle embedded model — serialize to JSON
    if (schema.embeddedClass) {
        dynObj.setString(name, JSON.stringify(value));
        return;
    }

    // Handle enum
    if (schema.enumObj) {
        if (schema.type === 'int') {
            dynObj.setInt(name, typeof value === 'bigint' ? value : BigInt(Math.floor(Number(value))));
        } else {
            dynObj.setString(name, String(value));
        }
        return;
    }

    // Handle vector — accept Float32Array, store as blob
    if (schema.isVector) {
        if (value instanceof Float32Array) {
            dynObj.setData(name, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        } else {
            dynObj.setData(name, value);
        }
        return;
    }

    // Handle link properties - use setObject with linked DynamicObject
    if (schema.kind === 'link') {
        console.log('setting link: ' + value);
        dynObj.setObject(name, value[DYNAMIC_OBJECT]);
        return;
    }

    // Handle list properties - not supported for direct assignment yet
    if (schema.kind === 'list') {
        console.warn('Direct list assignment not yet supported. Use list methods instead.');
        return;
    }

    switch (schema.type) {
        case 'string':
            dynObj.setString(name, String(value));
            break;
        case 'int':
            dynObj.setInt(name, typeof value === 'bigint' ? value : BigInt(Math.floor(value)));
            break;
        case 'float':
            dynObj.setDouble(name, Number(value));
            break;
        case 'bool':
            dynObj.setBool(name, Boolean(value));
            break;
        case 'date':
            const timestamp = value instanceof Date ? value.getTime() / 1000 : Number(value);
            dynObj.setDouble(name, timestamp);
            break;
        case 'blob':
            dynObj.setData(name, value);
            break;
        default:
            dynObj.setString(name, String(value));
    }
}

/**
 * Build C++ schema from property schemas.
 */
function buildCxxSchema(tableName: string, schemas: PropertySchema[]): any {
    // This will be converted to the format expected by C++
    return schemas.map(s => ({
        name: s.name,
        type: s.type,
        kind: s.kind,
        targetTable: s.targetModel ? getTableName(s.targetModel) : '',
        nullable: true,
    }));
}

// ============================================================================
// Metadata Utilities
// ============================================================================

/**
 * Checks if a class is decorated with @model
 */
export function isModel(target: ModelConstructor): boolean {
    return Reflect.hasMetadata(LATTICE_TABLE, target);
}

/**
 * Gets the table name for a model class.
 */
export function getTableName(modelClass: ModelConstructor): string {
    const tableName = Reflect.getMetadata(LATTICE_TABLE, modelClass);
    if (!tableName) {
        throw new Error(`Class ${modelClass.name} is not decorated with @model`);
    }
    return tableName;
}

/**
 * Gets the property schemas for a model class.
 */
export function getPropertySchemas(modelClass: ModelConstructor): PropertySchema[] {
    return Reflect.getMetadata(PROPERTY_SCHEMA, modelClass) || [];
}

// ============================================================================
// Schema Extraction (for WASM initialization)
// ============================================================================

/**
 * Extracts schema from a model class.
 */
export function extractSchema(modelClass: ModelConstructor, allModels: Set<ModelConstructor>): SchemaEntry {
    const tableName = getTableName(modelClass);
    const propertySchemas = getPropertySchemas(modelClass);

    const properties: PropertyDescriptor[] = propertySchemas.map(ps => ({
        name: ps.name,
        type: ps.type,
        kind: ps.kind,
        targetTable: ps.targetModel ? getTableName(ps.targetModel) : undefined,
        nullable: ps.nullable ?? (ps.kind !== 'primitive'),
        isVector: ps.isVector,
        isFullText: ps.isFullText,
        isIndexed: ps.isIndexed,
    }));

    // Get constraints from metadata
    const constraints: Constraint[] | undefined = Reflect.getMetadata(LATTICE_CONSTRAINTS, modelClass);

    return { tableName, properties, constraints };
}

/**
 * Infer column type from a default value.
 */
function inferTypeFromValue(value: unknown): ColumnType {
    switch (typeof value) {
        case 'string':
            return 'string';
        case 'number':
            return Number.isInteger(value) ? 'int' : 'float';
        case 'boolean':
            return 'bool';
        case 'object':
            if (value instanceof Date) return 'date';
            if (value instanceof Uint8Array || value instanceof ArrayBuffer) return 'blob';
            if (Array.isArray(value)) return 'blob';
            return 'string';
        default:
            return 'string';
    }
}

/**
 * Discovers all model types by walking links and lists from entry points.
 */
export function discoverModels(entryPoints: ModelConstructor[]): Set<ModelConstructor> {
    const discovered = new Map<string, ModelConstructor>(); // Dedupe by table name
    const queue = [...entryPoints];

    while (queue.length > 0) {
        const modelClass = queue.shift()!;
        const tableName = getTableName(modelClass);

        if (discovered.has(tableName)) continue;
        if (!isModel(modelClass)) {
            throw new Error(`Class ${modelClass.name} is not decorated with @model`);
        }

        discovered.set(tableName, modelClass);

        // Check property schemas for linked models
        const propertySchemas = getPropertySchemas(modelClass);
        for (const schema of propertySchemas) {
            if (schema.targetModel) {
                const targetTableName = getTableName(schema.targetModel);
                if (!discovered.has(targetTableName)) {
                    queue.push(schema.targetModel);
                }
            }
        }
    }

    return new Set(discovered.values());
}

/**
 * Build schema entries for all discovered models.
 */
export function buildSchemas(modelClasses: ModelConstructor[]): SchemaEntry[] {
    const allModels = discoverModels(modelClasses);
    return Array.from(allModels).map(m => extractSchema(m, allModels));
}

/**
 * Create a List-like wrapper around a C++ LinkList.
 * This is defined here to avoid circular dependencies with list.ts.
 */
function createListWrapper(linkList: any, targetModel: any, lattice: any): any {
    return {
        get length() {
            return linkList?.size() ?? 0;
        },
        get isEmpty() {
            return linkList?.empty() ?? true;
        },
        at(index: number) {
            if (!linkList || index < 0 || index >= this.length) {
                return undefined;
            }
            const dynObj = linkList.at(index);
            if (!dynObj || !dynObj.isValid()) {
                return undefined;
            }
            return hydrateInstance(targetModel, dynObj, lattice);
        },
        get first() {
            return this.at(0);
        },
        get last() {
            return this.length > 0 ? this.at(this.length - 1) : undefined;
        },
        push(item: any) {
            if (!linkList) return;
            const dynObj = item[DYNAMIC_OBJECT];
            if (!dynObj) {
                throw new Error('Cannot add item to list - item must be added to database first');
            }
            linkList.push_back(dynObj);
        },
        append(item: any) {
            this.push(item);
        },
        removeAt(index: number) {
            if (!linkList || index < 0 || index >= this.length) {
                return undefined;
            }
            const item = this.at(index);
            linkList.erase(index);
            return item;
        },
        clear() {
            linkList?.clear();
        },
        *[Symbol.iterator]() {
            for (let i = 0; i < this.length; i++) {
                const item = this.at(i);
                if (item) yield item;
            }
        },
        toArray() {
            return Array.from(this);
        },
        map<U>(fn: (item: any, index: number) => U): U[] {
            const result: U[] = [];
            let i = 0;
            for (const item of this) {
                result.push(fn(item, i++));
            }
            return result;
        },
        filter(fn: (item: any, index: number) => boolean): any[] {
            const result: any[] = [];
            let i = 0;
            for (const item of this) {
                if (fn(item, i++)) {
                    result.push(item);
                }
            }
            return result;
        },
    };
}

/**
 * Hydrate a model instance from an existing C++ DynamicObject.
 * This is THE canonical way to create an instance from DB data.
 *
 * Uses Object.create to avoid running the constructor (which would create a new DynamicObject).
 * The prototype accessors handle property access via the provided dynObj.
 */
export function hydrateInstance<T>(
    modelClass: ModelConstructor<T>,
    dynObj: any,
    lattice: any
): T {
    // Create instance with prototype chain but skip constructor
    const instance = Object.create(modelClass.prototype) as any;

    // Set C++ backing - prototype accessors will use this
    instance[DYNAMIC_OBJECT] = dynObj;
    instance[LATTICE_REF] = lattice;

    
    // Define id and globalId getters that read from C++
    Object.defineProperty(instance, 'id', {
        get() {
            const id = dynObj.getInt('id');
            return id ? Number(id) : undefined;
        },
        enumerable: true,
        configurable: true,
    });
    Object.defineProperty(instance, 'globalId', {
        get() {
            return dynObj.getString('globalId') || undefined;
        },
        enumerable: true,
        configurable: true,
    });

    return instance;
}
