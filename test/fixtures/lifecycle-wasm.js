// Pure JS stand-in for the agreed per-handle native lifecycle binding.
export default async function lifecycleWasm() {
    const control = globalThis.__latticeLifecycleTest;
    control.factories = (control.factories ?? 0) + 1;
    if (control.factoryError) throw new Error('factory failure');
    return {
        Lattice: class {
            constructor(path, schemas, syncUrl = '') {
                this.path = path; this.observers = new Map(); this.watchers = new Map(); this.nextId = 1;
                let store = control.stores.get(path);
                if (!store) {
                    const socket = syncUrl ? new WebSocket(syncUrl) : null;
                    if (socket) socket._lattice_client = control.nextClient++;
                    store = { socket, holders: 0 };
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
        FS: { analyzePath: () => ({ exists: true }), readFile: () => control.snapshotBytes ?? new Uint8Array(0), writeFile() {} },
        _ws_purge_client() { control.purges++; },
    };
}
