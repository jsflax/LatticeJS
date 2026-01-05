/**
 * Simple sync server for testing.
 * Replicates the Python LatticeServer sync protocol:
 * - Token-based authentication (?token=... or Authorization: Bearer ...)
 * - Per-user Lattice databases
 * - Proper sync protocol with receive() and events_after()
 *
 * Run with: npx tsx test/browser/test-sync-server.ts
 */

import 'reflect-metadata';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';
import { IncomingMessage, createServer, ServerResponse } from 'http';
import { model, buildSchemas } from '../../src/decorators';

// Note model - same as notes.ts
@model
class Note {
    text = '';
    createdAt = new Date();
}

const PORT = 5050;
const DATA_DIR = path.join(process.cwd(), '.test-sync-data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// WASM module
let wasmModule: any = null;

// Simple in-memory user/token store (for testing)
const usersByEmail: Map<string, { id: number; email: string; password: string }> = new Map();
const tokenToUserId: Map<string, number> = new Map();
let nextUserId = 1;

// Register a new user or return null if email exists
function registerUser(email: string, password: string): { user: { id: number; email: string }; token: string } | null {
    if (usersByEmail.has(email)) {
        return null; // Already exists
    }
    const id = nextUserId++;
    const user = { id, email, password };
    usersByEmail.set(email, user);
    const token = generateToken();
    tokenToUserId.set(token, id);
    return { user: { id, email }, token };
}

// Login and return token, or null if invalid
function loginUser(email: string, password: string): { user: { id: number; email: string }; token: string } | null {
    const user = usersByEmail.get(email);
    if (!user || user.password !== password) {
        return null;
    }
    const token = generateToken();
    tokenToUserId.set(token, user.id);
    return { user: { id: user.id, email: user.email }, token };
}

// Get user by token
function getUserByToken(token: string): { id: number; email: string } | null {
    const userId = tokenToUserId.get(token);
    if (userId === undefined) return null;
    for (const user of usersByEmail.values()) {
        if (user.id === userId) {
            return { id: user.id, email: user.email };
        }
    }
    return null;
}

// Per-user Lattice databases
const userDatabases: Map<number, any> = new Map();

// Per-user socket tracking
const userSockets: Map<number, Set<WebSocket>> = new Map();

// Build schema from model class (same as notes app does)
const testSchemas = buildSchemas([Note]);

async function loadWasm() {
    const wasmJsPath = path.join(__dirname, '../../wasm/build/lattice.js');
    const wasmBinaryPath = path.join(__dirname, '../../wasm/build/lattice.wasm');

    console.log('[TestSyncServer] Loading WASM from:', wasmJsPath);

    // Read the .wasm binary file for Node.js
    const wasmBinary = fs.readFileSync(wasmBinaryPath);

    // Import the Emscripten-generated JS module
    const module = await import(wasmJsPath);

    // Initialize with the wasmBinary option for Node.js
    wasmModule = await module.default({
        wasmBinary: wasmBinary,
        locateFile: (filePath: string) => {
            if (filePath.endsWith('.wasm')) {
                return wasmBinaryPath;
            }
            return path.join(__dirname, '../../wasm/build/', filePath);
        }
    });
    console.log('[TestSyncServer] WASM module loaded');

    // Mount real filesystem using NODEFS for persistent storage
    try {
        const FS = wasmModule.FS;
        if (FS && FS.filesystems && FS.filesystems.NODEFS) {
            // Create mount point for data directory
            try {
                FS.mkdir('/data');
            } catch (e: any) {
                if (e.code !== 'EEXIST') throw e;
            }
            FS.mount(FS.filesystems.NODEFS, { root: DATA_DIR }, '/data');
            console.log('[TestSyncServer] NODEFS mounted at /data ->', DATA_DIR);
        } else {
            console.log('[TestSyncServer] NODEFS not available in this build');
        }
    } catch (e) {
        console.error('[TestSyncServer] Failed to mount NODEFS:', e);
    }
}

function getUserDatabase(userId: number): any {
    if (userDatabases.has(userId)) {
        return userDatabases.get(userId)!;
    }

    // Use in-memory database (NODEFS not available in current build)
    const dbPath = `:memory:`;
    console.log(`[TestSyncServer] Creating in-memory database for user ${userId}`);

    try {
        const db = new wasmModule.Lattice(dbPath, testSchemas);
        console.log(`[TestSyncServer] Database created successfully`);
        userDatabases.set(userId, db);
        return db;
    } catch (e: any) {
        console.error(`[TestSyncServer] Failed to create database:`, e.message || e);
        throw e;
    }
}

function addSocket(userId: number, ws: WebSocket): void {
    if (!userSockets.has(userId)) {
        userSockets.set(userId, new Set());
    }
    userSockets.get(userId)!.add(ws);
}

function removeSocket(userId: number, ws: WebSocket): void {
    userSockets.get(userId)?.delete(ws);
}

function broadcastToUser(userId: number, data: string | Buffer, exclude?: WebSocket): void {
    const sockets = userSockets.get(userId);
    if (!sockets) return;

    for (const ws of sockets) {
        if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
            console.log(`[TestSyncServer] Broadcasting to other client of user ${userId}`);
            ws.send(data);
        }
    }
}

function extractToken(req: IncomingMessage): string | null {
    // Try query string: ?token=...
    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    const token = url.searchParams.get('token');
    if (token) {
        return token;
    }

    // Try Authorization header: Bearer ...
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    return null;
}

function getLastEventId(req: IncomingMessage): string | null {
    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    return url.searchParams.get('last-event-id');
}

// Simple token generator
function generateToken(): string {
    return Array.from({ length: 32 }, () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('');
}

// Handle HTTP requests (login/register)
function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url || '', `http://localhost:${PORT}`);

    if (req.method === 'POST' && url.pathname === '/register') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { email, password } = JSON.parse(body);
                if (!email || !password) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Email and password required');
                    return;
                }

                const result = registerUser(email, password);
                if (!result) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Email already registered');
                    return;
                }

                console.log(`[TestSyncServer] Registered: ${email} (id=${result.user.id})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ token: result.token, userId: result.user.id }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid JSON');
            }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { email, password } = JSON.parse(body);
                if (!email || !password) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Email and password required');
                    return;
                }

                const result = loginUser(email, password);
                if (!result) {
                    res.writeHead(401, { 'Content-Type': 'text/plain' });
                    res.end('Invalid email or password');
                    return;
                }

                console.log(`[TestSyncServer] Logged in: ${email} (id=${result.user.id})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ token: result.token, userId: result.user.id }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid JSON');
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
}

async function startServer() {
    await loadWasm();

    // Create HTTP server for login/register
    const httpServer = createServer(handleHttpRequest);

    // Create WebSocket server attached to HTTP server
    const wss = new WebSocketServer({ server: httpServer });

    httpServer.listen(PORT, () => {
        console.log(`[TestSyncServer] Listening on http://localhost:${PORT}`);
        console.log(`[TestSyncServer] WebSocket at ws://localhost:${PORT}/sync`);
        console.log(`[TestSyncServer] Data directory: ${DATA_DIR}`);
    });

    wss.on('connection', (ws, req) => {
        console.log(`[TestSyncServer] Connection attempt from ${req.url}`);

        // Extract and validate token
        const token = extractToken(req);
        if (!token) {
            console.log(`[TestSyncServer] No token provided, closing connection`);
            ws.close(1008, 'Authentication required');
            return;
        }

        const user = getUserByToken(token);
        if (!user) {
            console.log(`[TestSyncServer] Invalid token: ${token}`);
            ws.close(1008, 'Invalid token');
            return;
        }

        const userId = user.id;
        console.log(`[TestSyncServer] Client authenticated: user_id=${userId}, email=${user.email}`);

        // Get user's database
        const latticeDb = getUserDatabase(userId);

        // Register socket
        addSocket(userId, ws);

        // Send pending changes to client (all events after last-event-id, or all if not provided)
        const lastEventId = getLastEventId(req);
        console.log(`[TestSyncServer] last-event-id: ${lastEventId}`);

        try {
            const eventsJson = latticeDb.eventsAfter(lastEventId || '');
            const events = JSON.parse(eventsJson);
            if (events.length > 0) {
                console.log(`[TestSyncServer] Sending ${events.length} pending events to client`);
                const syncMsg = wasmModule.createSyncMessage(eventsJson);
                if (syncMsg) {
                    ws.send(syncMsg);
                }
            } else {
                console.log(`[TestSyncServer] No pending events`);
            }
        } catch (e) {
            console.error(`[TestSyncServer] Error sending pending changes:`, e);
        }

        ws.on('message', (data) => {
            try {
                const str = data.toString();
                console.log(`[TestSyncServer] Received from user ${userId}: ${str.substring(0, 200)}...`);

                const parsed = JSON.parse(str);

                // Handle ACK messages - don't process these
                if (parsed.kind === 'ack' || parsed.ack) {
                    console.log(`[TestSyncServer] Received ACK for ${parsed.ack?.length || 0} entries`);
                    return;
                }

                // Handle auditLog messages
                if (parsed.auditLog && Array.isArray(parsed.auditLog)) {
                    // Use the C++ receive() method to apply changes
                    const appliedIdsJson = latticeDb.receive(str);
                    const appliedIds = JSON.parse(appliedIdsJson);
                    console.log(`[TestSyncServer] Applied ${appliedIds.length} entries via receive()`);

                    // Send ACK
                    if (appliedIds.length > 0) {
                        const ackMsg = wasmModule.createAckMessage(JSON.stringify(appliedIds));
                        if (ackMsg) {
                            console.log(`[TestSyncServer] Sending ACK for ${appliedIds.length} entries`);
                            ws.send(ackMsg);
                        }

                        // Broadcast to other clients of same user
                        broadcastToUser(userId, str, ws);
                    }
                }
            } catch (e) {
                console.error(`[TestSyncServer] Error processing message:`, e);
            }
        });

        ws.on('close', () => {
            console.log(`[TestSyncServer] Client disconnected: user_id=${userId}`);
            removeSocket(userId, ws);
        });

        ws.on('error', (err) => {
            console.error(`[TestSyncServer] WebSocket error for user ${userId}:`, err);
            removeSocket(userId, ws);
        });
    });

    console.log(`[TestSyncServer] Ready. Press Ctrl+C to stop.`);
    console.log(`[TestSyncServer] Connect with: ws://localhost:${PORT}/sync?token=test-token-1`);
}

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('\n[TestSyncServer] Shutting down...');
    for (const [userId, db] of userDatabases) {
        try {
            db.delete();
            console.log(`[TestSyncServer] Closed database for user ${userId}`);
        } catch (e) {
            // Ignore
        }
    }
    process.exit(0);
});

startServer().catch(console.error);
