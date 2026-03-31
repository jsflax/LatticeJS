/**
 * OPFS VFS JavaScript Library for Emscripten
 *
 * Provides synchronous file operations using OPFS's createSyncAccessHandle().
 * Only works in Worker contexts (SharedWorker, dedicated Worker).
 *
 * Key insight: We can't use Atomics.wait to block on async operations in the same thread.
 * Instead, we pre-open files asynchronously during init, then use synchronous handles.
 */

mergeInto(LibraryManager.library, {
    // NOTE: We store handles on Module object to ensure they're shared between
    // async JS calls (opfsPreOpen) and synchronous C++ calls (js_opfs_open).
    // Library-level variables can have scoping issues with Emscripten.

    // Initialize storage on Module object
    $opfsInitStorage__deps: [],
    $opfsInitStorage__postset: 'Module._opfsHandles = {}; Module._opfsHandleCounter = 0; Module._opfsRoot = null; Module._opfsReady = false; Module._opfsInitPromise = null; Module._opfsDirCache = {};',
    $opfsInitStorage: function() {
        // This function exists just to trigger the __postset initialization
    },

    // Debug logging helper that sends to BroadcastChannel (visible in main thread)
    $opfsLog__deps: [],
    $opfsLog: function(msg) {
        if (typeof BroadcastChannel !== 'undefined') {
            try {
                var channel = new BroadcastChannel('lattice-debug');
                channel.postMessage({ type: 'log', msg: '[OPFS JS] ' + msg });
                channel.close();
            } catch (e) {}
        }
        console.log('[OPFS JS]', msg);
    },

    // Check if OPFS is available (synchronous check)
    js_opfs_available__deps: ['$opfsInitStorage', '$initOpfsRoot', '$opfsPreOpen', '$opfsFileExists', '$opfsDeleteFile'],
    js_opfs_available: function() {
        // Check if we're in a Worker context with OPFS support
        if (typeof navigator === 'undefined') {
            console.log('[OPFS JS] navigator not available');
            return 0;
        }
        if (typeof navigator.storage === 'undefined') {
            console.log('[OPFS JS] navigator.storage not available');
            return 0;
        }
        if (typeof navigator.storage.getDirectory !== 'function') {
            console.log('[OPFS JS] navigator.storage.getDirectory not available');
            return 0;
        }

        console.log('[OPFS JS] OPFS APIs available');
        return 1;
    },

    // Initialize OPFS root - called from JS before any file operations
    // This is exposed to Module so it can be called before VFS registration
    $initOpfsRoot__deps: ['$opfsInitStorage', '$opfsLog'],
    $initOpfsRoot__postset: 'Module["initOpfsRoot"] = initOpfsRoot;',
    $initOpfsRoot: async function() {
        if (Module._opfsReady) return true;
        if (Module._opfsInitPromise) return Module._opfsInitPromise;

        Module._opfsInitPromise = (async () => {
            try {
                opfsLog('Initializing OPFS root...');
                Module._opfsRoot = await navigator.storage.getDirectory();
                Module._opfsReady = true;
                opfsLog('OPFS root initialized');
                return true;
            } catch (e) {
                opfsLog('ERROR: Failed to initialize OPFS root: ' + e.message);
                return false;
            }
        })();

        return Module._opfsInitPromise;
    },

    // Pre-open a file and return handle - ASYNC, call from JS before SQLite operations
    $opfsPreOpen__deps: ['$opfsInitStorage', '$opfsLog'],
    $opfsPreOpen__postset: 'Module["opfsPreOpen"] = opfsPreOpen;',
    $opfsPreOpen: async function(path, create) {
        opfsLog('Pre-opening: ' + path + ' create: ' + create);

        if (!Module._opfsReady || !Module._opfsRoot) {
            opfsLog('ERROR: OPFS not initialized!');
            return -1;
        }

        try {
            // Navigate to/create parent directories
            const parts = path.split('/').filter(p => p.length > 0);
            const fileName = parts.pop();
            let dir = Module._opfsRoot;

            for (const part of parts) {
                // Cache directory handles to speed up future opens
                const dirKey = parts.slice(0, parts.indexOf(part) + 1).join('/');
                if (Module._opfsDirCache[dirKey]) {
                    dir = Module._opfsDirCache[dirKey];
                } else {
                    dir = await dir.getDirectoryHandle(part, { create: true });
                    Module._opfsDirCache[dirKey] = dir;
                }
            }

            // Get file handle
            const fileHandle = await dir.getFileHandle(fileName, { create: create });

            // Get synchronous access handle (Worker-only API)
            const accessHandle = await fileHandle.createSyncAccessHandle();

            // Store and return handle ID
            const handleId = Module._opfsHandleCounter++;
            Module._opfsHandles[handleId] = {
                accessHandle: accessHandle,
                path: path,
                fileHandle: fileHandle
            };

            opfsLog('Pre-opened successfully, handle: ' + handleId + ' path: ' + path);
            opfsLog('Module._opfsHandles now has ' + Object.keys(Module._opfsHandles).length + ' entries: ' + Object.keys(Module._opfsHandles).join(','));
            return handleId;
        } catch (e) {
            if (e.name === 'NotFoundError' && !create) {
                opfsLog('File not found (no create): ' + path);
                return -1;
            }
            opfsLog('ERROR: Pre-open failed: ' + path + ' - ' + e.message);
            return -1;
        }
    },

    // Open a file - synchronous version that uses pre-opened handles or tries sync open
    // Note: For new files, caller should use opfsPreOpen first
    // Exception: Temp files (starting with /.temp_) are created on-demand
    js_opfs_open__deps: ['$opfsInitStorage', '$opfsLog'],
    js_opfs_open: function(pathPtr, flags) {
        const path = UTF8ToString(pathPtr);
        opfsLog('Opening: ' + path + ' flags: 0x' + flags.toString(16));

        if (!Module._opfsReady || !Module._opfsRoot) {
            opfsLog('ERROR: OPFS not initialized! Call initOpfsRoot() first.');
            return -1;
        }

        // Debug: show all pre-opened handles
        const handleCount = Object.keys(Module._opfsHandles).length;
        opfsLog('Checking ' + handleCount + ' pre-opened handles...');
        for (const [id, entry] of Object.entries(Module._opfsHandles)) {
            opfsLog('  Handle ' + id + ': path="' + entry.path + '"');
            if (entry.path === path) {
                opfsLog('  -> MATCH! Returning handle ' + id);
                return parseInt(id);
            }
        }

        // For temp files or files that need to be created on-demand,
        // we need to use Asyncify to handle the async OPFS operations synchronously
        // Since we can't do that without Asyncify, return error for non-pre-opened files
        opfsLog('ERROR: File not pre-opened: ' + path);

        return -1;
    },

    // Close a file handle (synchronous)
    // NOTE: We don't actually close pre-opened handles - we keep them open for reuse
    // This is because SQLite may close and reopen files multiple times during a session
    js_opfs_close__deps: ['$opfsInitStorage', '$opfsLog'],
    js_opfs_close: function(handle) {
        opfsLog('Close requested for handle: ' + handle);

        const entry = Module._opfsHandles[handle];
        if (!entry) {
            opfsLog('ERROR: Close: invalid handle ' + handle);
            return -1;
        }

        // Don't actually close the handle - keep it open for potential reopening
        // SQLite will close and reopen files, especially when changing journal modes
        opfsLog('Keeping handle open for reuse: ' + handle + ' ' + entry.path);
        return 0;
    },

    // Read from file (synchronous via SyncAccessHandle)
    js_opfs_read__deps: ['$opfsInitStorage'],
    js_opfs_read: function(handle, bufPtr, amt, offset) {
        const entry = Module._opfsHandles[handle];
        if (!entry) {
            console.error('[OPFS JS] Read: invalid handle', handle);
            return -1;
        }

        try {
            const buffer = new Uint8Array(HEAPU8.buffer, bufPtr, amt);
            const bytesRead = entry.accessHandle.read(buffer, { at: offset });
            return bytesRead;
        } catch (e) {
            console.error('[OPFS JS] Read failed:', e);
            return -1;
        }
    },

    // Write to file (synchronous via SyncAccessHandle)
    js_opfs_write__deps: ['$opfsInitStorage'],
    js_opfs_write: function(handle, bufPtr, amt, offset) {
        const entry = Module._opfsHandles[handle];
        if (!entry) {
            console.error('[OPFS JS] Write: invalid handle', handle);
            return -1;
        }

        try {
            const buffer = new Uint8Array(HEAPU8.buffer, bufPtr, amt);
            const bytesWritten = entry.accessHandle.write(buffer, { at: offset });
            return bytesWritten;
        } catch (e) {
            console.error('[OPFS JS] Write failed:', e);
            return -1;
        }
    },

    // Truncate file (synchronous via SyncAccessHandle)
    js_opfs_truncate__deps: ['$opfsInitStorage'],
    js_opfs_truncate: function(handle, size) {
        const entry = Module._opfsHandles[handle];
        if (!entry) {
            console.error('[OPFS JS] Truncate: invalid handle', handle);
            return -1;
        }

        try {
            entry.accessHandle.truncate(size);
            return 0;
        } catch (e) {
            console.error('[OPFS JS] Truncate failed:', e);
            return -1;
        }
    },

    // Sync/flush file (synchronous via SyncAccessHandle)
    js_opfs_sync__deps: ['$opfsInitStorage'],
    js_opfs_sync: function(handle) {
        const entry = Module._opfsHandles[handle];
        if (!entry) {
            console.error('[OPFS JS] Sync: invalid handle', handle);
            return -1;
        }

        try {
            entry.accessHandle.flush();
            return 0;
        } catch (e) {
            console.error('[OPFS JS] Sync failed:', e);
            return -1;
        }
    },

    // Get file size (synchronous via SyncAccessHandle)
    js_opfs_size__deps: ['$opfsInitStorage'],
    js_opfs_size: function(handle) {
        const entry = Module._opfsHandles[handle];
        if (!entry) {
            console.error('[OPFS JS] Size: invalid handle', handle);
            return 0;
        }

        try {
            return entry.accessHandle.getSize();
        } catch (e) {
            console.error('[OPFS JS] Size failed:', e);
            return 0;
        }
    },

    // Check if file exists - ASYNC exposed to JS
    $opfsFileExists__deps: ['$opfsInitStorage'],
    $opfsFileExists__postset: 'Module["opfsFileExists"] = opfsFileExists;',
    $opfsFileExists: async function(path) {
        if (!Module._opfsReady || !Module._opfsRoot) {
            return false;
        }

        try {
            const parts = path.split('/').filter(p => p.length > 0);
            const fileName = parts.pop();
            let dir = Module._opfsRoot;

            for (const part of parts) {
                dir = await dir.getDirectoryHandle(part, { create: false });
            }

            await dir.getFileHandle(fileName, { create: false });
            return true;
        } catch (e) {
            return false;
        }
    },

    // Synchronous access check - returns cached info or 0 for unknown
    js_opfs_access__deps: ['$opfsInitStorage'],
    js_opfs_access: function(pathPtr) {
        const path = UTF8ToString(pathPtr);

        if (!Module._opfsReady || !Module._opfsRoot) {
            return 0;
        }

        // Check if file is in our open handles and has content
        for (const entry of Object.values(Module._opfsHandles)) {
            if (entry.path === path) {
                // A file truncated to 0 by js_opfs_delete is logically deleted
                // Reporting it as "exists" would cause SQLite to think there's
                // a hot journal and attempt recovery, which fails on the empty file
                try {
                    if (entry.accessHandle.getSize() === 0) {
                        return 0;
                    }
                } catch (e) {
                    return 0;
                }
                return 1;
            }
        }

        // Can't do async check synchronously - return 0 (file might exist but we don't know)
        // SQLite will try to open it and handle the error
        return 0;
    },

    // Delete a file - ASYNC exposed to JS
    $opfsDeleteFile__deps: ['$opfsInitStorage', '$opfsLog'],
    $opfsDeleteFile__postset: 'Module["opfsDeleteFile"] = opfsDeleteFile;',
    $opfsDeleteFile: async function(path) {
        opfsLog('Deleting: ' + path);

        if (!Module._opfsReady || !Module._opfsRoot) {
            return false;
        }

        // Close handle if open
        for (const [id, entry] of Object.entries(Module._opfsHandles)) {
            if (entry.path === path) {
                try {
                    entry.accessHandle.close();
                } catch (e) {}
                delete Module._opfsHandles[id];
            }
        }

        try {
            const parts = path.split('/').filter(p => p.length > 0);
            const fileName = parts.pop();
            let dir = Module._opfsRoot;

            for (const part of parts) {
                dir = await dir.getDirectoryHandle(part, { create: false });
            }

            await dir.removeEntry(fileName);
            opfsLog('Deleted successfully: ' + path);
            return true;
        } catch (e) {
            opfsLog('ERROR: Delete failed: ' + path + ' - ' + e.message);
            return false;
        }
    },

    // Synchronous delete - truncates file to simulate deletion while keeping
    // the pre-opened SyncAccessHandle alive. We can't actually close and reopen
    // handles synchronously (createSyncAccessHandle is async), so we truncate
    // to 0 bytes instead. SQLite will see an empty file on next open.
    js_opfs_delete__deps: ['$opfsInitStorage', '$opfsLog'],
    js_opfs_delete: function(pathPtr) {
        const path = UTF8ToString(pathPtr);
        opfsLog('Delete requested: ' + path);

        // Truncate instead of closing - keeps handle alive for reuse
        for (const [id, entry] of Object.entries(Module._opfsHandles)) {
            if (entry.path === path) {
                try {
                    opfsLog('Truncating for delete: ' + id + ' ' + path);
                    entry.accessHandle.truncate(0);
                } catch (e) {
                    opfsLog('ERROR: Error truncating handle: ' + e.message);
                }
            }
        }

        opfsLog('Delete completed for: ' + path);
        return 0;
    },
});
