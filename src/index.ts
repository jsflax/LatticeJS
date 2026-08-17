// LatticeJS - Browser-first Lattice client
export { Lattice, LogLevel } from './lattice';
export { Results } from './results';
export { List } from './list';
export {
    model, link, list, nullable,
    indexed,
    float, fullText, vector, embedded, enumValue,
    unique, compoundUnique,
    isModel, getTableName, getPropertySchemas, buildSchemas, discoverModels, hydrateInstance,
} from './decorators';
export { DYNAMIC_OBJECT, PROPERTY_SCHEMA, isWasmReady } from './storage';
export { QueryNode, createQueryProxy } from './query';
export type { QueryProxy } from './query';
export type { PropertySchema } from './storage';
export type { QueryOptions } from './results';
export type { AuditLogEntry } from './lattice';
export type {
    ColumnType,
    PropertyKind,
    PropertyDescriptor,
    Constraint,
    SchemaEntry,
    CollectionChange,
    LatticeObject,
    ModelConstructor,
    LatticeWasm,
    LatticeWasmModule,
    SyncProgress,
    SyncFilter,
    MigrationContext,
    TableChanges,
} from './types';
