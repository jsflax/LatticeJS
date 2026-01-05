import 'reflect-metadata';
import { Lattice, model } from '../src/index';

// Note model
@model
class Note {
    text = '';
    createdAt = new Date();
}

// UI elements
const statusEl = document.getElementById('status')!;
const inputEl = document.getElementById('noteInput') as HTMLInputElement;
const addBtn = document.getElementById('addBtn') as HTMLButtonElement;
const listEl = document.getElementById('notesList')!;
const logEl = document.getElementById('log')!;
const instanceIdEl = document.getElementById('instanceId')!;

// Server sync UI elements
const syncHeader = document.getElementById('syncHeader')!;
const syncToggle = document.getElementById('syncToggle')!;
const syncBody = document.getElementById('syncBody')!;
const syncDot = document.getElementById('syncDot')!;
const syncStatusText = document.getElementById('syncStatusText')!;
const authSection = document.getElementById('authSection')!;
const userSection = document.getElementById('userSection')!;
const serverUrlInput = document.getElementById('serverUrl') as HTMLInputElement;
const authEmailInput = document.getElementById('authEmail') as HTMLInputElement;
const authPasswordInput = document.getElementById('authPassword') as HTMLInputElement;
const authError = document.getElementById('authError')!;
const loginBtn = document.getElementById('loginBtn') as HTMLButtonElement;
const registerBtn = document.getElementById('registerBtn') as HTMLButtonElement;
const logoutBtn = document.getElementById('logoutBtn') as HTMLButtonElement;
const userEmailEl = document.getElementById('userEmail')!;

let lattice: Lattice | null = null;
let observer: any | null = null;

// Auth state (persisted in localStorage)
interface AuthState {
    serverUrl: string;
    email: string;
    token: string;
}

function getAuthState(): AuthState | null {
    const stored = localStorage.getItem('lattice-notes-auth');
    return stored ? JSON.parse(stored) : null;
}

function setAuthState(state: AuthState | null) {
    if (state) {
        localStorage.setItem('lattice-notes-auth', JSON.stringify(state));
    } else {
        localStorage.removeItem('lattice-notes-auth');
    }
}

// Logging helper
function log(message: string, type = 'normal') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.insertBefore(entry, logEl.firstChild);
    // Keep only last 50 entries
    while (logEl.children.length > 50) {
        logEl.removeChild(logEl.lastChild!);
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Render notes list
async function renderNotes() {
    if (!lattice) return;

    const notes = await lattice.objectsArray(Note, { orderBy: 'createdAt DESC' });

    if (notes.length === 0) {
        listEl.innerHTML = '<li class="empty">No notes yet. Add one!</li>';
        return;
    }

    listEl.innerHTML = notes.map(note => `
        <li class="note" data-id="${note.id}">
            <div class="note-content">
                <div>${escapeHtml(note.text)}</div>
                <div class="note-time">${note.createdAt.toLocaleString()}</div>
            </div>
            <button class="note-delete" data-note-id="${note.id}">Delete</button>
        </li>
    `).join('');
}

// Add note
async function addNote() {
    const text = inputEl.value.trim();
    if (!text || !lattice) return;

    const note = new Note();
    note.text = text;
    note.createdAt = new Date();
    await lattice.add(note);

    log(`Added note: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`, 'local');
    inputEl.value = '';
    await renderNotes();
}

// Delete note
async function deleteNote(id: number) {
    if (!lattice) return;
    await lattice.remove(Note, id);
    log(`Deleted note #${id}`, 'local');
    await renderNotes();
}

// Initialize Lattice (optionally with sync)
async function initLattice(syncConfig?: { websocketUrl: string; authToken: string }) {
    console.log('[initLattice] Called with syncConfig:', syncConfig);

    // Clean up existing observer
    if (observer) {
        console.log('[initLattice] Removing existing observer');
        observer();
        observer = null;
    }

    // Close existing lattice
    if (lattice) {
        console.log('[initLattice] Closing existing lattice');
        await lattice.close();
        lattice = null;
    }

    log('Initializing Lattice...');

    // Open with or without sync
    if (syncConfig) {
        console.log('[initLattice] Opening WITH sync:', syncConfig.websocketUrl);
        log(`Connecting to server: ${syncConfig.websocketUrl}`, 'server');
        lattice = await Lattice.open('notes-demo', [Note], {
            sync: syncConfig
        });
        console.log('[initLattice] Lattice opened with sync');
    } else {
        console.log('[initLattice] Opening WITHOUT sync');
        lattice = await Lattice.open('notes-demo', [Note]);
        console.log('[initLattice] Lattice opened without sync');
    }

    // Show instance ID (for debugging)
    instanceIdEl.textContent = (lattice as any)['instanceId']?.substring(0, 8) || 'unknown';

    statusEl.textContent = syncConfig
        ? 'Connected with server sync enabled'
        : 'Connected (cross-tab sync only)';
    statusEl.className = 'status ready';

    // Enable input
    inputEl.disabled = false;
    addBtn.disabled = false;

    // Observe changes (including from other tabs and server)
    observer = lattice.observe((entries) => {
        const ops = entries.map(e => e.operation).join(', ');
        const isRemote = entries.some(e => e.isFromRemote);
        log(`Observed: ${entries.length} change(s) [${ops}]${isRemote ? ' (from sync)' : ''}`, isRemote ? 'sync' : 'local');
        renderNotes();
    });

    // Initial render
    await renderNotes();
}

// Update sync status UI
function updateSyncUI(state: AuthState | null) {
    if (state) {
        // Logged in
        authSection.style.display = 'none';
        userSection.style.display = 'block';
        userEmailEl.textContent = state.email;
        syncDot.className = 'sync-dot connected';
        syncStatusText.textContent = 'Connected to server';
        serverUrlInput.value = state.serverUrl;
    } else {
        // Not logged in
        authSection.style.display = 'block';
        userSection.style.display = 'none';
        syncDot.className = 'sync-dot';
        syncStatusText.textContent = 'Not connected';
    }
}

// Auth: Login
async function login() {
    const serverUrl = serverUrlInput.value.trim();
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;

    if (!serverUrl || !email || !password) {
        showAuthError('Please fill in all fields');
        return;
    }

    try {
        loginBtn.disabled = true;
        registerBtn.disabled = true;
        syncDot.className = 'sync-dot connecting';
        syncStatusText.textContent = 'Logging in...';
        hideAuthError();

        const response = await fetch(`${serverUrl}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Login failed: ${response.status}`);
        }

        const data = await response.json();
        const token = data.token;

        // Save auth state
        const authState: AuthState = { serverUrl, email, token };
        setAuthState(authState);
        updateSyncUI(authState);

        // Reconnect with sync
        const wsUrl = serverUrl.replace(/^http/, 'ws') + '/sync';
        await initLattice({ websocketUrl: wsUrl, authToken: token });

        log(`Logged in as ${email}`, 'server');
        authPasswordInput.value = '';

    } catch (err: any) {
        showAuthError(err.message);
        syncDot.className = 'sync-dot error';
        syncStatusText.textContent = 'Login failed';
    } finally {
        loginBtn.disabled = false;
        registerBtn.disabled = false;
    }
}

// Auth: Register
async function register() {
    const serverUrl = serverUrlInput.value.trim();
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;

    if (!serverUrl || !email || !password) {
        showAuthError('Please fill in all fields');
        return;
    }

    try {
        loginBtn.disabled = true;
        registerBtn.disabled = true;
        syncDot.className = 'sync-dot connecting';
        syncStatusText.textContent = 'Registering...';
        hideAuthError();

        const response = await fetch(`${serverUrl}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `Registration failed: ${response.status}`);
        }

        const data = await response.json();
        const token = data.token;

        // Save auth state
        const authState: AuthState = { serverUrl, email, token };
        setAuthState(authState);
        updateSyncUI(authState);

        // Reconnect with sync
        const wsUrl = serverUrl.replace(/^http/, 'ws') + '/sync';
        await initLattice({ websocketUrl: wsUrl, authToken: token });

        log(`Registered and logged in as ${email}`, 'server');
        authPasswordInput.value = '';

    } catch (err: any) {
        showAuthError(err.message);
        syncDot.className = 'sync-dot error';
        syncStatusText.textContent = 'Registration failed';
    } finally {
        loginBtn.disabled = false;
        registerBtn.disabled = false;
    }
}

// Auth: Logout
async function logout() {
    setAuthState(null);
    updateSyncUI(null);
    authEmailInput.value = '';
    authPasswordInput.value = '';

    // Reconnect without sync
    await initLattice();
    log('Logged out, using cross-tab sync only', 'server');
}

function showAuthError(message: string) {
    authError.textContent = message;
    authError.style.display = 'block';
}

function hideAuthError() {
    authError.style.display = 'none';
}

// Toggle sync section visibility
function toggleSyncSection() {
    const isOpen = syncBody.classList.contains('open');
    syncBody.classList.toggle('open');
    syncToggle.textContent = isOpen ? '+' : '−';
}

// Main init
async function init() {
    try {
        // Check for existing auth state
        const authState = getAuthState();
        updateSyncUI(authState);

        // Initialize with or without sync
        if (authState) {
            const wsUrl = authState.serverUrl.replace(/^http/, 'ws') + '/sync';
            await initLattice({ websocketUrl: wsUrl, authToken: authState.token });
        } else {
            await initLattice();
        }

        log('Ready! Open this page in another tab to test cross-tab sync.', 'sync');

    } catch (err: any) {
        console.error('Init failed:', err);
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.className = 'status error';
        log(`Error: ${err.message}`);
    }
}

// Event listeners
addBtn.addEventListener('click', addNote);
inputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addNote();
});

// Delete button handler (event delegation)
listEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('note-delete')) {
        const id = parseInt(target.dataset.noteId || '0', 10);
        if (id) deleteNote(id);
    }
});

// Server sync event listeners
syncHeader.addEventListener('click', toggleSyncSection);
loginBtn.addEventListener('click', login);
registerBtn.addEventListener('click', register);
logoutBtn.addEventListener('click', logout);

// Start
init();
