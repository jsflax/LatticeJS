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
// Diagnostic: sync sockets still CONNECTING/OPEN. Must not grow across
// open/close cycles — see ./sync-socket.
export { liveSyncSocketCount } from './sync-socket';
// Orphaned-write drain — see ./pending-drain. The entry points live on
// Lattice (`Lattice.pendingUploads`, `instance.drainPendingFrom`); these are
// the pure pieces, exported for apps that keep their own journal.
export { selectPendingUploads, drainPendingUploads } from './pending-drain';
export type {
    PendingUploadRow,
    PendingSelectOptions,
    DrainOptions,
    DrainReport,
} from './pending-drain';
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
