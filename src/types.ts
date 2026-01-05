// Core types for LatticeJS

export type ColumnType = 'string' | 'int' | 'float' | 'bool' | 'blob' | 'date';
export type PropertyKind = 'primitive' | 'link' | 'list';

export interface PropertyDescriptor {
    name: string;
    type: ColumnType;
    kind: PropertyKind;
    targetTable?: string;
    nullable?: boolean;
    isVector?: boolean;
}

export interface SchemaEntry {
    tableName: string;
    properties: PropertyDescriptor[];
}

export interface CollectionChange {
    insertions: number[];
    deletions: number[];
    modifications: number[];
}

export interface LatticeObject {
    id?: number;
    globalId?: string;
}

// Metadata keys for decorators
export const LATTICE_TABLE = Symbol('lattice:table');
export const LATTICE_FIELDS = Symbol('lattice:fields');
export const LATTICE_LINKS = Symbol('lattice:links');
export const LATTICE_LISTS = Symbol('lattice:lists');

// Field metadata stored by decorators
export interface FieldMetadata {
    name: string;
    type: ColumnType;
    nullable: boolean;
    isVector: boolean;
}

export interface LinkMetadata {
    name: string;
    targetFactory: () => ModelConstructor;
}

export interface ListMetadata {
    name: string;
    targetFactory: () => ModelConstructor;
}

// Type for model constructors
export type ModelConstructor<T = any> = new (...args: any[]) => T;

// WASM module interface (what Embind exports)
export interface LatticeWasmModule {
    Lattice: new (path: string, schemas: SchemaEntry[]) => LatticeWasm;
}

export interface LatticeWasm {
    add(tableName: string, obj: Record<string, any>): number;
    addObject(tableName: string, dynamicObject: any): any;
    createObject(tableName: string): any; // Returns DynamicObject
    find(tableName: string, id: number): Record<string, any> | null;
    findObject(tableName: string, id: number): any; // Returns DynamicObject
    findByGlobalId(tableName: string, globalId: string): Record<string, any> | null;
    objects(
        tableName: string,
        whereClause: string | null,
        orderBy: string | null,
        limit: number | null,
        offset: number | null
    ): Record<string, any>[];
    count(tableName: string, whereClause: string | null): number;
    remove(tableName: string, id: number): boolean;
    beginWrite(): void;
    commitWrite(): void;
    path: string;
    debugListTables(): string;
    debugQueryCount(sql: string): number;

    // Audit log / sync methods
    getPendingAuditLog(): string;
    applyRemoteChanges(json: string): string;
    markEntriesSynced(idsJson: string): void;
    observeAuditLog(callback: (json: string) => void): number;
    removeAuditLogObserver(observerId: number): void;
}

// Type inference helpers
export type InferModelType<T> = T extends ModelConstructor<infer U> ? U : never;
