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
    isFullText?: boolean;
    isIndexed?: boolean;
}

export interface Constraint {
    columns: string[];
    allowsUpsert?: boolean;
}

export interface SchemaEntry {
    tableName: string;
    properties: PropertyDescriptor[];
    constraints?: Constraint[];
}

export interface CollectionChange {
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    rowId: number;
    globalRowId: string;
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
    isFullText: boolean;
    isIndexed: boolean;
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
        offset: number | null,
        groupBy?: string | null,
        distinctBy?: string | null
    ): Record<string, any>[];
    count(
        tableName: string,
        whereClause: string | null,
        groupBy?: string | null,
        distinctBy?: string | null
    ): number;
    remove(tableName: string, id: number): boolean;
    beginWrite(): void;
    commitWrite(): void;
    path: string;
    debugListTables(): string;
    debugQueryCount(sql: string): number;

    // Bulk insert
    addBulk(tableName: string, objects: Record<string, any>[]): { id: number; globalId: string }[];

    // Audit log / sync methods
    getPendingAuditLog(): string;
    /** The rows this store still OWES upstream (unsynced AND unmarked in
     *  _lattice_sync_state) — downloads excluded, stranded local writes and
     *  drained-in rows included. The drain predicate, in SQL. */
    getUnshippedAuditLog(): string;
    /** Release this handle's native store reference. Shared holders retain
     *  storage. Legacy bindings only support read-only audit release and return
     *  void. Idempotent; no store method is valid on this handle afterwards. */
    releaseStorage?(): 'closed' | 'shared' | 'already-released' | 'pending' | void;
    applyRemoteChanges(json: string): string;
    markEntriesSynced(idsJson: string): void;
    observeAuditLog(callback: (json: string) => void): number;
    removeAuditLogObserver(observerId: number): void;

    // Fine-grained observation
    observeTable(tableName: string, callback: (change: CollectionChange) => void): number;
    removeTableObserver(tableName: string, observerId: number): void;
    observeObject(tableName: string, rowId: number, callback: (changedFields: string) => void): number;
    removeObjectObserver(tableName: string, rowId: number, observerId: number): void;

    // FTS5 full-text search
    ftsQuery(tableName: string, columnName: string, searchText: string, limit: number): Record<string, any>[];

    // Vector search
    nearestNeighbors(
        tableName: string,
        columnName: string,
        queryVector: Float32Array,
        k: number,
        metric: number,
        whereClause: string | null
    ): { globalId: string; distance: number }[];

    // Sync progress / filters / compaction
    getSyncProgress(): SyncProgress;
    /** Lifecycle bindings are absent from older generated WASM assets. */
    getSyncSocket?(): import('./sync-socket').TrackedSyncSocket | null;
    watchSyncSocket?(callback: (socket: import('./sync-socket').TrackedSyncSocket | null) => void): number;
    unwatchSyncSocket?(observerId: number): void;
    prepareClose?(): 'exclusive' | 'shared' | 'already-released';
    requestSyncUpload?(): void;
    getPendingSyncUploadCount?(): number;
    onSyncProgress(callback: (progress: SyncProgress) => void): number;
    removeSyncProgress?(observerId: number): void;
    updateSyncFilter(filterJson: string): void;
    clearSyncFilter(): void;
    compactAuditLog(): void;
    safeCompactAuditLog(staleSeconds: number): void;
    generateHistory(): void;
    walCheckpoint(): void;
}

/// WS lifecycle for the sync connection. A rejected handshake (401/402
/// upstream) surfaces as {state:'closed', code:1006} — browsers hide the
/// HTTP status, so pair this with an HTTP preflight for auth decisions.
export interface SyncStateInfo {
    readonly state: 'connecting' | 'open' | 'closed' | 'error';
    /** Identifies this Lattice wrapper, including when native storage is shared. */
    readonly instanceId: string;
    /** Monotonic within this instance; zero means sync was not configured. */
    readonly connectionGeneration: number;
    readonly code: number;
    readonly reason: string;
}

export interface LatticeCloseOptions {
    /** Opt-in upload drain. Zero (the default) does not promise upload delivery. */
    uploadTimeoutMs?: number;
    /** Wait for browser socket CLOSED, default 2000ms. */
    transportTimeoutMs?: number;
    /** Wait for the final persistent save, default 2000ms. */
    snapshotTimeoutMs?: number;
}

export interface LatticeCloseResult {
    readonly native: 'closed' | 'shared' | 'unsupported' | 'error' | 'pending';
    readonly transport: 'closed' | 'timeout' | 'shared' | 'not-configured' | 'unavailable';
    readonly uploads: 'drained' | 'timeout' | 'not-requested' | 'unavailable';
    readonly snapshot: 'saved' | 'timeout' | 'unavailable' | 'not-persistent' | 'error';
}

export interface SyncProgress {
    pendingUpload: number;
    totalUpload: number;
    acked: number;
    received: number;
}

export interface SyncFilter {
    tableName: string;
    whereClause?: string;
}

export interface MigrationContext {
    pendingChanges(): TableChanges[];
    hasChangesFor(tableName: string): boolean;
    renameProperty(tableName: string, oldName: string, newName: string): void;
    deleteAll(tableName: string): void;
    executeSql(sql: string): void;
    enumerateObjects(tableName: string, callback: (oldRow: Record<string, any>, newRow: Record<string, any>) => void): void;
}

export interface TableChanges {
    tableName: string;
    addedColumns: string[];
    removedColumns: string[];
    changedColumns: string[];
}

// Type inference helpers
export type InferModelType<T> = T extends ModelConstructor<infer U> ? U : never;
