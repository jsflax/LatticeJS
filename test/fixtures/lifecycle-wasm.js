// Pure JS stand-in for the agreed per-handle native lifecycle binding.
export default async function lifecycleWasm() {
    const control = globalThis.__latticeLifecycleTest;
    control.factories = (control.factories ?? 0) + 1;
    if (control.factoryError) throw new Error('factory failure');
    const module = {
        Lattice: class {
            constructor(path, schemas, syncUrl = '', authToken = '', schemaVersion, migration, socketFactory = url => new WebSocket(url)) {
                control.onConstruct?.({ path, schemas, syncUrl, authToken, schemaVersion, migration });
                this.path = path; this.observers = new Map(); this.watchers = new Map(); this.nextId = 1;
                let store = control.stores.get(path);
                if (!store) {
                    const socket = syncUrl ? socketFactory(syncUrl) : null;
                    if (socket) socket._lattice_client = control.nextClient++;
                    store = { socket, socketFactory, syncUrl, holders: 0 };
                    control.stores.set(path, store);
                }
                this.store = store; store.holders++;
                control.handles.push(this);
            }
            getSyncSocket() { if (control.getterError) throw new Error('getter failure'); return this.store.socket; }
            watchSyncSocket(callback) {
                if (control.watchError) throw new Error('watch failure');
                const id = this.nextId++; this.watchers.set(id, callback); callback(this.store.socket); return id;
            }
            unwatchSyncSocket(id) { this.watchers.delete(id); }
            requireExclusiveSyncOwner() {
                if (this.released || !this.store.socket) throw new Error('Sync owner is unavailable');
                if (this.store.holders !== 1) throw new Error('Sync reconnect requires an exclusive native owner');
                if (control.executing) throw new Error('Sync reconnect requires a later browser task');
            }
            disconnectSync() {
                this.requireExclusiveSyncOwner();
                control.disconnects = (control.disconnects ?? 0) + 1;
                this.store.socket.close();
            }
            connectSync() {
                this.requireExclusiveSyncOwner();
                control.connects = (control.connects ?? 0) + 1;
                const socket = this.store.socketFactory(this.store.syncUrl);
                socket._lattice_client = control.nextClient++;
                this.store.socket = socket;
                // The public code also adopts the exact native socket before
                // relying on the real scheduler's later watcher delivery.
                for (const callback of this.watchers.values()) callback(socket);
            }
            prepareClose() {
                this.watchers.clear(); this.observers.clear();
                if (this.released) return 'already-released';
                if (this.store.holders > 1) return 'shared';
                control.stores.delete(this.path);
                this.store.socket?.close();
                return 'exclusive';
            }
            requestSyncUpload() { control.requests++; control.request?.(); }
            getPendingSyncUploadCount() { return control.pending(); }
            getSyncProgress() { control.progressReads = (control.progressReads ?? 0) + 1; return { pendingUpload: 0, totalUpload: 0, acked: 0, received: 0 }; }
            observeTable(table, callback) { if (control.observeError) throw new Error('observe failure'); const id = this.nextId++; this.observers.set(id, callback); return id; }
            removeTableObserver(table, id) { this.observers.delete(id); }
            onSyncProgress(callback) { const id = this.nextId++; this.observers.set(id, callback); return id; }
            removeSyncProgress(id) { control.progressRemoved = (control.progressRemoved ?? 0) + 1; this.observers.delete(id); }
            getPendingAuditLog() { if (this.released) throw new Error('read after release'); return '[]'; }
            getUnshippedAuditLog() { return JSON.stringify(control.pendingRows ?? []); }
            getUnshippedAuditFrames(localOnly, maxEntries) {
                if (this.released) throw new Error('read after release');
                const rows = (control.pendingRows ?? []).filter(row => !row.isSynchronized && (!localOnly || !row.isFromRemote));
                const frames = [];
                for (let i = 0; i < rows.length; i += maxEntries) {
                    const chunk = rows.slice(i, i + maxEntries);
                    frames.push({ formatVersion: 1, entries: chunk.map(({ globalId, tableName }) => ({ globalId, tableName })), json: JSON.stringify(chunk) });
                }
                return frames;
            }
            importPendingFrame(json) {
                return { imported: JSON.parse(this.applyRemoteChanges(json)), alreadyPresent: [], rejected: [] };
            }
            applyRemoteChanges(json) {
                if (this.released) throw new Error('apply after release');
                control.applies = (control.applies ?? 0) + 1;
                control.onApply?.();
                return JSON.stringify(JSON.parse(json).map(row => row.globalId));
            }
            walCheckpoint() { if (this.released) throw new Error('released during save'); }
            isDeleted() { return !!this.deleted; }
            releaseStorage() {
                if (this.released) return 'already-released';
                this.released = true; control.releases++;
                if (--this.store.holders) return 'shared';
                this.store.socket?.close();
                return 'closed';
            }
            delete() { this.deleted = true; control.deletes++; this.releaseStorage(); }
        },
        FS: { analyzePath: () => ({ exists: true }), readFile: () => control.snapshotBytes ?? new Uint8Array(0), writeFile(path, bytes) { control.restoreWrites = (control.restoreWrites ?? 0) + 1; control.onRestoreWrite?.(path, bytes); } },
        _assertRestoreAllowed(path) { return control.restoreCheck?.(path) ?? { ok: true }; },
        syncAdmissionVersion: control.admissionSupported ? () => 1 : undefined,
        _openAdmitted(path, schemas, syncUrl, schemaVersion, migration, socketFactory) {
            try { return { ok: true, db: new module.Lattice(path, schemas, syncUrl, '', schemaVersion, migration, socketFactory) }; }
            catch (error) { return { ok: false, error: error.message }; }
        },
        _ws_purge_client() { control.purges++; },
        _migration_execute_sql(...args) { return control.migrationOperation?.('executeSql', ...args) ?? { ok: true }; },
        _migration_delete_all(...args) { return control.migrationOperation?.('deleteAll', ...args) ?? { ok: true }; },
        _migration_rename_property(...args) { return control.migrationOperation?.('renameProperty', ...args) ?? { ok: true }; },
        _openVersioned(...args) {
            try { return { ok: true, db: new module.Lattice(...args) }; }
            catch (error) { return { ok: false, error: error.message }; }
        },
    };
    return module;
}
