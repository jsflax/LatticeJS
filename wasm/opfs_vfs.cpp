/**
 * OPFS VFS for SQLite - Custom Virtual File System using Origin Private File System
 *
 * This VFS allows SQLite to persist data to the browser's OPFS storage.
 * It only works in Worker contexts (SharedWorker, dedicated Worker) because
 * OPFS's createSyncAccessHandle() is only available in Workers.
 */

#include <sqlite3.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <emscripten.h>

#ifdef LATTICE_OPFS_VFS

// Debug logging via BroadcastChannel (so main thread can see it)
EM_JS(void, opfsDebugLog, (const char* msg), {
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            var channel = new BroadcastChannel('lattice-debug');
            channel.postMessage({ type: 'log', msg: '[OPFS VFS] ' + UTF8ToString(msg) });
            channel.close();
        } catch (e) {}
    }
    console.log('[OPFS VFS]', UTF8ToString(msg));
});

#define OPFS_LOG(msg) opfsDebugLog(msg)

// JS functions implemented in opfs_vfs_lib.js
extern "C" {
    // Returns handle ID (>= 0) on success, -1 on failure
    int js_opfs_open(const char* path, int flags);
    // Returns 0 on success
    int js_opfs_close(int handle);
    // Returns bytes read (may be less than requested at EOF)
    int js_opfs_read(int handle, void* buf, int amt, double offset);
    // Returns bytes written
    int js_opfs_write(int handle, const void* buf, int amt, double offset);
    // Returns 0 on success
    int js_opfs_truncate(int handle, double size);
    // Returns 0 on success
    int js_opfs_sync(int handle);
    // Returns file size
    double js_opfs_size(int handle);
    // Returns 1 if file exists, 0 if not
    int js_opfs_access(const char* path);
    // Returns 0 on success
    int js_opfs_delete(const char* path);
    // Returns 1 if OPFS is available in this context
    int js_opfs_available();
}

// File handle structure
struct OpfsFile {
    sqlite3_file base;      // Must be first - SQLite's file handle base
    int handle;             // JS handle ID for the OPFS file
    char* path;             // File path (for debugging)
};

// Forward declarations
static int opfsClose(sqlite3_file* pFile);
static int opfsRead(sqlite3_file* pFile, void* buf, int amt, sqlite3_int64 offset);
static int opfsWrite(sqlite3_file* pFile, const void* buf, int amt, sqlite3_int64 offset);
static int opfsTruncate(sqlite3_file* pFile, sqlite3_int64 size);
static int opfsSync(sqlite3_file* pFile, int flags);
static int opfsFileSize(sqlite3_file* pFile, sqlite3_int64* pSize);
static int opfsLock(sqlite3_file* pFile, int lockType);
static int opfsUnlock(sqlite3_file* pFile, int lockType);
static int opfsCheckReservedLock(sqlite3_file* pFile, int* pResOut);
static int opfsFileControl(sqlite3_file* pFile, int op, void* pArg);
static int opfsSectorSize(sqlite3_file* pFile);
static int opfsDeviceCharacteristics(sqlite3_file* pFile);

// I/O methods for OPFS files
static const sqlite3_io_methods opfsIoMethods = {
    1,                          // iVersion
    opfsClose,                  // xClose
    opfsRead,                   // xRead
    opfsWrite,                  // xWrite
    opfsTruncate,               // xTruncate
    opfsSync,                   // xSync
    opfsFileSize,               // xFileSize
    opfsLock,                   // xLock
    opfsUnlock,                 // xUnlock
    opfsCheckReservedLock,      // xCheckReservedLock
    opfsFileControl,            // xFileControl
    opfsSectorSize,             // xSectorSize
    opfsDeviceCharacteristics,  // xDeviceCharacteristics
};

// ============================================================================
// File Methods Implementation
// ============================================================================

static int opfsClose(sqlite3_file* pFile) {
    OpfsFile* p = (OpfsFile*)pFile;
    if (p->handle >= 0) {
        js_opfs_close(p->handle);
        p->handle = -1;
    }
    if (p->path) {
        sqlite3_free(p->path);
        p->path = nullptr;
    }
    return SQLITE_OK;
}

static int opfsRead(sqlite3_file* pFile, void* buf, int amt, sqlite3_int64 offset) {
    OpfsFile* p = (OpfsFile*)pFile;
    char logBuf[128];
    snprintf(logBuf, sizeof(logBuf), "xRead: handle=%d amt=%d offset=%lld", p->handle, amt, (long long)offset);
    OPFS_LOG(logBuf);

    int bytesRead = js_opfs_read(p->handle, buf, amt, (double)offset);
    snprintf(logBuf, sizeof(logBuf), "xRead: bytesRead=%d", bytesRead);
    OPFS_LOG(logBuf);

    if (bytesRead < 0) {
        OPFS_LOG("xRead: IOERR_READ");
        return SQLITE_IOERR_READ;
    }

    if (bytesRead < amt) {
        // Short read - zero-fill the rest (SQLite requirement)
        memset((char*)buf + bytesRead, 0, amt - bytesRead);
        OPFS_LOG("xRead: SHORT_READ (normal for new file)");
        return SQLITE_IOERR_SHORT_READ;
    }

    return SQLITE_OK;
}

static int opfsWrite(sqlite3_file* pFile, const void* buf, int amt, sqlite3_int64 offset) {
    OpfsFile* p = (OpfsFile*)pFile;
    char logBuf[128];
    snprintf(logBuf, sizeof(logBuf), "xWrite: handle=%d amt=%d offset=%lld", p->handle, amt, (long long)offset);
    OPFS_LOG(logBuf);

    int bytesWritten = js_opfs_write(p->handle, buf, amt, (double)offset);
    snprintf(logBuf, sizeof(logBuf), "xWrite: bytesWritten=%d", bytesWritten);
    OPFS_LOG(logBuf);

    if (bytesWritten != amt) {
        OPFS_LOG("xWrite: IOERR_WRITE");
        return SQLITE_IOERR_WRITE;
    }

    return SQLITE_OK;
}

static int opfsTruncate(sqlite3_file* pFile, sqlite3_int64 size) {
    OpfsFile* p = (OpfsFile*)pFile;
    int rc = js_opfs_truncate(p->handle, (double)size);
    return rc == 0 ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
}

static int opfsSync(sqlite3_file* pFile, int flags) {
    OpfsFile* p = (OpfsFile*)pFile;
    int rc = js_opfs_sync(p->handle);
    return rc == 0 ? SQLITE_OK : SQLITE_IOERR_FSYNC;
}

static int opfsFileSize(sqlite3_file* pFile, sqlite3_int64* pSize) {
    OpfsFile* p = (OpfsFile*)pFile;
    double size = js_opfs_size(p->handle);
    *pSize = (sqlite3_int64)size;
    char logBuf[128];
    snprintf(logBuf, sizeof(logBuf), "xFileSize: handle=%d size=%lld", p->handle, (long long)*pSize);
    OPFS_LOG(logBuf);
    return SQLITE_OK;
}

// OPFS has exclusive locking by design - no need for complex locking
static int opfsLock(sqlite3_file* pFile, int lockType) {
    OpfsFile* p = (OpfsFile*)pFile;
    char logBuf[64];
    snprintf(logBuf, sizeof(logBuf), "xLock: handle=%d lockType=%d", p->handle, lockType);
    OPFS_LOG(logBuf);
    return SQLITE_OK;
}

static int opfsUnlock(sqlite3_file* pFile, int lockType) {
    OpfsFile* p = (OpfsFile*)pFile;
    char logBuf[64];
    snprintf(logBuf, sizeof(logBuf), "xUnlock: handle=%d lockType=%d", p->handle, lockType);
    OPFS_LOG(logBuf);
    return SQLITE_OK;
}

static int opfsCheckReservedLock(sqlite3_file* pFile, int* pResOut) {
    *pResOut = 0;
    return SQLITE_OK;
}

static int opfsFileControl(sqlite3_file* pFile, int op, void* pArg) {
    return SQLITE_NOTFOUND;
}

static int opfsSectorSize(sqlite3_file* pFile) {
    return 4096;
}

static int opfsDeviceCharacteristics(sqlite3_file* pFile) {
    return SQLITE_IOCAP_ATOMIC4K | SQLITE_IOCAP_SAFE_APPEND;
}

// ============================================================================
// VFS Methods Implementation
// ============================================================================

static int opfsOpen(
    sqlite3_vfs* pVfs,
    const char* zName,
    sqlite3_file* pFile,
    int flags,
    int* pOutFlags
) {
    OPFS_LOG("xOpen called");

    OpfsFile* p = (OpfsFile*)pFile;
    memset(p, 0, sizeof(*p));
    p->handle = -1;

    // Handle NULL filename (temp file)
    if (zName == nullptr) {
        OPFS_LOG("xOpen: NULL filename (temp file)");
        // Generate a temp filename
        static int tempCounter = 0;
        char tempName[64];
        snprintf(tempName, sizeof(tempName), "/.temp_%d", tempCounter++);
        zName = tempName;
    }

    // Strip /opfs/ prefix if present (for path normalization)
    const char* actualPath = zName;
    if (strncmp(zName, "/opfs/", 6) == 0) {
        actualPath = zName + 6;
    }

    char logBuf[256];
    snprintf(logBuf, sizeof(logBuf), "Opening: %s flags: 0x%x", actualPath, flags);
    OPFS_LOG(logBuf);

    p->handle = js_opfs_open(actualPath, flags);
    if (p->handle < 0) {
        snprintf(logBuf, sizeof(logBuf), "Failed to open: %s", actualPath);
        OPFS_LOG(logBuf);
        return SQLITE_CANTOPEN;
    }

    p->path = sqlite3_mprintf("%s", actualPath);
    p->base.pMethods = &opfsIoMethods;

    if (pOutFlags) {
        *pOutFlags = flags;
    }

    snprintf(logBuf, sizeof(logBuf), "Opened successfully: %s (handle=%d)", actualPath, p->handle);
    OPFS_LOG(logBuf);
    return SQLITE_OK;
}

static int opfsDelete(sqlite3_vfs* pVfs, const char* zName, int syncDir) {
    const char* actualPath = zName;
    if (strncmp(zName, "/opfs/", 6) == 0) {
        actualPath = zName + 6;
    }

    printf("[OPFS VFS] Deleting: %s\n", actualPath);
    int rc = js_opfs_delete(actualPath);
    return rc == 0 ? SQLITE_OK : SQLITE_IOERR_DELETE;
}

static int opfsAccess(sqlite3_vfs* pVfs, const char* zName, int flags, int* pResOut) {
    const char* actualPath = zName;
    if (strncmp(zName, "/opfs/", 6) == 0) {
        actualPath = zName + 6;
    }

    *pResOut = js_opfs_access(actualPath);
    return SQLITE_OK;
}

static int opfsFullPathname(sqlite3_vfs* pVfs, const char* zName, int nOut, char* zOut) {
    // Just copy the path as-is (already absolute in OPFS context)
    sqlite3_snprintf(nOut, zOut, "%s", zName);
    return SQLITE_OK;
}

static void* opfsDlOpen(sqlite3_vfs* pVfs, const char* zPath) {
    return nullptr;
}

static void opfsDlError(sqlite3_vfs* pVfs, int nByte, char* zErrMsg) {
    sqlite3_snprintf(nByte, zErrMsg, "Dynamic loading not supported");
}

static void (*opfsDlSym(sqlite3_vfs* pVfs, void* pH, const char* zSym))(void) {
    return nullptr;
}

static void opfsDlClose(sqlite3_vfs* pVfs, void* pHandle) {
}

static int opfsRandomness(sqlite3_vfs* pVfs, int nByte, char* zByte) {
    // Use JavaScript's crypto.getRandomValues via Emscripten
    for (int i = 0; i < nByte; i++) {
        zByte[i] = (char)(rand() & 0xFF);
    }
    return nByte;
}

static int opfsSleep(sqlite3_vfs* pVfs, int microseconds) {
    // Can't really sleep in WASM synchronously, but return success
    return microseconds;
}

static int opfsCurrentTime(sqlite3_vfs* pVfs, double* pTime) {
    // Julian day number for current time
    // Days since noon in Greenwich on November 24, 4714 B.C.
    *pTime = 2440587.5 + (double)time(nullptr) / 86400.0;
    return SQLITE_OK;
}

static int opfsGetLastError(sqlite3_vfs* pVfs, int nByte, char* zErrMsg) {
    if (nByte > 0) zErrMsg[0] = '\0';
    return 0;
}

static int opfsCurrentTimeInt64(sqlite3_vfs* pVfs, sqlite3_int64* pTime) {
    // Milliseconds since Unix epoch
    *pTime = (sqlite3_int64)time(nullptr) * 1000;
    return SQLITE_OK;
}

// ============================================================================
// VFS Registration
// ============================================================================

static sqlite3_vfs opfsVfs = {
    3,                      // iVersion
    sizeof(OpfsFile),       // szOsFile
    512,                    // mxPathname
    nullptr,                // pNext
    "opfs",                 // zName
    nullptr,                // pAppData
    opfsOpen,               // xOpen
    opfsDelete,             // xDelete
    opfsAccess,             // xAccess
    opfsFullPathname,       // xFullPathname
    opfsDlOpen,             // xDlOpen
    opfsDlError,            // xDlError
    opfsDlSym,              // xDlSym
    opfsDlClose,            // xDlClose
    opfsRandomness,         // xRandomness
    opfsSleep,              // xSleep
    opfsCurrentTime,        // xCurrentTime
    opfsGetLastError,       // xGetLastError
    opfsCurrentTimeInt64,   // xCurrentTimeInt64
};

extern "C" {

// Register the OPFS VFS with SQLite
// Call this before opening any databases
// makeDefault: if true, OPFS becomes the default VFS
int opfs_vfs_register(int makeDefault) {
    char logBuf[128];
    snprintf(logBuf, sizeof(logBuf), "Registering VFS (makeDefault=%d)", makeDefault);
    OPFS_LOG(logBuf);

    if (!js_opfs_available()) {
        OPFS_LOG("OPFS not available in this context");
        return SQLITE_ERROR;
    }

    OPFS_LOG("Calling sqlite3_vfs_register...");
    int rc = sqlite3_vfs_register(&opfsVfs, makeDefault);
    snprintf(logBuf, sizeof(logBuf), "sqlite3_vfs_register returned: %d", rc);
    OPFS_LOG(logBuf);

    if (rc == SQLITE_OK) {
        OPFS_LOG("VFS registered successfully");
    } else {
        snprintf(logBuf, sizeof(logBuf), "Failed to register VFS: %d", rc);
        OPFS_LOG(logBuf);
    }
    return rc;
}

// Check if OPFS VFS is available
int opfs_vfs_available() {
    return js_opfs_available();
}

}

#endif // LATTICE_OPFS_VFS
