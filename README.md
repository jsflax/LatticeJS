# LatticeJS

A browser-first ORM for JavaScript/TypeScript powered by WebAssembly. SQLite-backed persistence with optional server sync, full-text search, and vector search -- all running client-side.

```typescript
import { Lattice, model, link, list } from '@jsflax/lattice';

@model
class Todo {
    title = '';
    done = false;
    createdAt = new Date();
}

const lattice = await Lattice.open(':memory:', [Todo]);

const todo = new Todo();
todo.title = 'Ship it';
await lattice.add(todo);

const todos = await lattice.objects(Todo)
    .where("done = 0")
    .sorted("createdAt DESC")
    .snapshot();
```

## Features

- **Decorator-based models** -- define schemas with plain class properties
- **C++ core via WebAssembly** -- SQLite runs in-browser, no server required
- **Server sync** -- optional WebSocket sync for multi-device (and multi-tab)
- **OPFS persistence** -- survives page reloads via Origin Private File System
- **Live queries** -- `Results<T>` with async iteration and chainable filters
- **Full-text search** -- FTS5-backed search on string columns
- **Vector search** -- nearest-neighbor queries for embeddings
- **Type-safe query builder** -- write queries with autocomplete, not strings
- **Bulk operations** -- batch inserts in a single transaction
- **Migrations** -- schema versioning with rename/delete/SQL support

## Installation

```bash
npm install --save-exact https://github.com/jsflax/LatticeJS/releases/download/v1.1.0/jsflax-lattice-1.1.0.tgz reflect-metadata
```

Install the built release archive: it includes the compiled JavaScript,
TypeScript declarations, and matching WASM assets. Commit the resulting lockfile.
GitHub's automatic source archives and Git dependencies do not contain these
build outputs. This release is distributed through GitHub rather than the npm
registry.

Add `reflect-metadata` to your entry point:

```typescript
import 'reflect-metadata';
```

### Vite Setup

LatticeJS uses class names for table mapping. Minifiers break this, so add the Vite plugin:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { latticePlugin } from '@jsflax/lattice/vite';

export default defineConfig({
    plugins: [latticePlugin()],
});
```

This build runs WASM on the main thread and does not require `SharedArrayBuffer`
or cross-origin isolation headers. The plugin preserves class names; it does not
configure response headers. Configure any headers required by other parts of your
application in your own server or deployment.

## Defining Models

### Basic Properties

Property types are inferred from default values:

```typescript
import { model, nullable, indexed, fullText } from '@jsflax/lattice';

@model
class Article {
    title = '';              // string
    body = fullText('');     // string with FTS5 index
    views = 0;              // int
    rating = 4.5;           // float
    published = false;       // bool
    slug = indexed('');      // string with B-tree index
    createdAt = new Date();  // date (stored as Unix timestamp)
    deletedAt = nullable(Date); // Date | null
    thumbnail = new Uint8Array(); // blob
}
```

### Relationships

```typescript
import { model, link, list } from '@jsflax/lattice';

@model
class Author {
    name = '';
    articles = list(Article); // to-many
}

@model
class Article {
    title = '';
    author = link(Author);    // to-one (nullable)
}
```

Lists support iteration, `push`, `removeAt`, `clear`, `toArray`, `map`, and `filter`:

```typescript
const author = await lattice.find(Author, 1);
for (const article of author.articles) {
    console.log(article.title);
}
author.articles.push(newArticle);
```

### Enums

```typescript
import { model, enumValue } from '@jsflax/lattice';

enum Priority { Low = 'low', Medium = 'medium', High = 'high' }

@model
class Task {
    title = '';
    priority = enumValue(Priority, Priority.Medium);
}
```

### Embedded Objects

Store complex objects as JSON in a single column:

```typescript
import { model, embedded } from '@jsflax/lattice';

class Address {
    street = '';
    city = '';
    zip = '';
}

@model
class Contact {
    name = '';
    address = embedded(Address); // stored as JSON text
}
```

### Vectors

```typescript
import { model, vector } from '@jsflax/lattice';

@model
class Document {
    title = '';
    content = '';
    embedding = vector(384); // Float32Array, 384 dimensions
}
```

### Constraints

```typescript
import { model, unique, compoundUnique } from '@jsflax/lattice';

@compoundUnique(['owner', 'slug'])
@model
class Page {
    @unique() slug = '';
    owner = '';
    content = '';
}
```

### Custom Table Names

```typescript
@model('blog_posts')
class BlogPost {
    title = '';
}
```

## Opening a Database

```typescript
import { Lattice } from '@jsflax/lattice';

// In-memory (no persistence)
const lattice = await Lattice.open(':memory:', [Todo, Author, Article]);

// Persistent (OPFS-backed, survives refresh)
const lattice = await Lattice.open('myapp', [Todo, Author, Article]);

// With server sync
const lattice = await Lattice.open('myapp', [Todo, Author, Article], {
    sync: {
        websocketUrl: 'wss://api.example.com/sync',
        authToken: 'bearer-token',
    },
});

// With migrations
const lattice = await Lattice.open('myapp', [Todo], {
    schemaVersion: 2,
    migration: (ctx) => {
        if (ctx.hasChangesFor('Todo')) {
            ctx.renameProperty('Todo', 'text', 'title');
        }
    },
});
```

## CRUD Operations

```typescript
// Create
const todo = new Todo();
todo.title = 'Buy groceries';
await lattice.add(todo);
console.log(todo.id);       // auto-assigned local ID
console.log(todo.globalId); // UUID for sync

// Read
const found = await lattice.find(Todo, todo.id);
const byGlobal = await lattice.findByGlobalId(Todo, todo.globalId);

// Update -- mutate properties directly, they write through to C++
found.title = 'Buy organic groceries';
found.done = true;

// Delete
await lattice.remove(Todo, todo.id);

// Bulk insert
const todos = Array.from({ length: 1000 }, (_, i) => {
    const t = new Todo();
    t.title = `Task ${i}`;
    return t;
});
await lattice.addAll(todos);
```

## Querying

### String Queries

```typescript
const results = lattice.objects(Todo);

// Filter + sort
const pending = results
    .where("done = 0")
    .sorted("createdAt DESC");

// Get all as array
const todos = await pending.snapshot();

// Get count
const count = await pending.count();

// Get first
const first = await pending.first();

// Get by index
const third = await pending.at(2);

// Limit
const top5 = await results.sorted("views DESC").limit(5).snapshot();

// Group / distinct
const byCategory = results.groupBy("category");
const uniqueTitles = results.distinct("title");
```

### Type-Safe Query Builder

```typescript
const adults = await lattice.objects(Person)
    .where(q => q.age.gte(18))
    .snapshot();

const results = await lattice.objects(Person)
    .where(q => q.name.startsWith('J').and(q.age.between(20, 30)))
    .snapshot();

const active = await lattice.objects(Task)
    .where(q => q.status.eq('active').or(q.priority.eq('high')))
    .sorted("createdAt DESC")
    .snapshot();
```

Available operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `like`, `in`, `between`, `isNull`, `isNotNull`. Combine with `.and()`, `.or()`, `.not()`.

### Async Iteration

Results implement `AsyncIterable` and fetch in batches of 100:

```typescript
for await (const todo of lattice.objects(Todo).where("done = 0")) {
    console.log(todo.title);
}

// Functional methods
const titles = await lattice.objects(Todo).map(t => t.title);
const urgent = await lattice.objects(Todo).filter(t => t.priority === 'high');
```

### Full-Text Search

```typescript
@model
class Note {
    title = '';
    body = fullText(''); // enable FTS5 on this column
}

const matches = await lattice.objects(Note).matching('body', 'typescript wasm');
```

### Vector Search

```typescript
@model
class Document {
    title = '';
    embedding = vector(384);
}

const query = new Float32Array(384); // your embedding
const nearest = await lattice.objects(Document)
    .nearest('embedding', query, 10, { distance: 'cosine' });

for (const { item, distance } of nearest) {
    console.log(`${item.title} (distance: ${distance})`);
}
```

## Transactions

```typescript
await lattice.write(async () => {
    const author = new Author();
    author.name = 'Jane';
    await lattice.add(author);

    const article = new Article();
    article.title = 'Hello World';
    article.author = author;
    await lattice.add(article);
});
```

## Observation

### Table-Level

```typescript
const unsubscribe = lattice.observeTable(Todo, (change) => {
    console.log(change.operation, change.rowId); // 'INSERT' | 'UPDATE' | 'DELETE'
});

// Stop observing
unsubscribe();
```

### Object-Level

```typescript
const todo = await lattice.find(Todo, 1);
const unsubscribe = lattice.observeObject(Todo, todo, (changedFields) => {
    console.log('Changed:', changedFields); // ['title', 'done']
});
```

### Audit Log

```typescript
const unsubscribe = lattice.observe((entries) => {
    for (const entry of entries) {
        console.log(`${entry.operation} on ${entry.tableName}: ${entry.globalRowId}`);
    }
});
```

## Sync

### Server Sync

LatticeJS syncs via WebSocket using an audit log. Local changes are sent to the server; remote changes are applied automatically.

```typescript
const lattice = await Lattice.open('myapp', [Todo], {
    sync: {
        websocketUrl: 'wss://api.example.com/sync',
        authToken: 'my-jwt',
    },
});

// Monitor sync progress
const unsubscribe = lattice.onSyncProgress((progress) => {
    console.log(`Pending: ${progress.pendingUpload}, Received: ${progress.received}`);
});

// Filter what syncs
lattice.updateSyncFilter([
    { tableName: 'Todo' },
    { tableName: 'Article', whereClause: "published = 1" },
]);

// Clear filters (sync everything)
lattice.clearSyncFilter();
```

### Per-instance connection lifecycle

Register during `open` to observe startup, or subscribe later to receive the
current immutable state immediately:

```typescript
const lattice = await Lattice.open('myapp', [Todo], {
    sync: { websocketUrl, authToken },
    onSyncState(info) {
        console.log(info.instanceId, info.connectionGeneration, info.state,
                    info.code, info.reason);
    },
});
const unsubscribe = lattice.onSyncState(info => updateConnectionBadge(info.state));
unsubscribe(); // Idempotent; removes only this registration.

const result = await lattice.close({
    uploadTimeoutMs: 1000, // Optional; default 0 means no upload drain requested.
    transportTimeoutMs: 2000,
    snapshotTimeoutMs: 2000,
});
console.log(result.native, result.transport, result.uploads, result.snapshot);
```

Each opened wrapper has its own `instanceId`, including wrappers sharing native
storage. A configured connection begins at generation **1**, in `connecting`,
before native construction. An unconfigured instance reports `closed`, generation
**0**, reason `sync-not-configured`. A native replacement socket advances the
generation even if its state is unchanged; a late first socket remains generation
1. Events from the retired socket are ignored. Two stores using the same endpoint
are distinguished by the actual native socket object, never by their URL.

`Lattice.open()` returns the local store before the handshake or catch-up finishes.
`state: 'open'` means the browser WebSocket opened. It does **not** certify server
catch-up, a durable snapshot, or delivery of local writes. A browser error may be followed
by `closed`; rejected handshakes commonly expose code 1006 without the HTTP status.
No heartbeat or bounded outage-detection timer is added. The app owns retry policy,
authentication refresh, and the close/reopen sequence; the library does not redial.
`onSyncState(null)` clears only this instance's registrations.

`close()` immediately retires this instance's state, row, audit, and progress
callbacks and cancels its background resume waits. Native teardown starts on a
later browser task, so closing from a callback cannot destroy its active C++ call
stack. Repeated calls return the same promise and result; the first options win.
An already-running callback can finish, but no further callback begins after
retirement. This wrapper must not be used for further database operations. Finish application
write callbacks and other application-owned asynchronous work before closing;
close does not join arbitrary application promises or commit unfinished writes.

Close reports independent outcomes:

| Field | Outcomes and meaning |
| --- | --- |
| `native` | `closed`: handle storage released; `shared`: another owner retains storage; `pending`: cleanup awaits an active save/native callback; `unsupported`: older WASM cannot establish cleanup; `error`: cleanup failed. |
| `transport` | `closed`: actual browser CLOSED observed; `shared`: another native owner keeps the transport; `timeout`: CLOSED was not observed by the deadline; `not-configured`; `unavailable`. |
| `uploads` | `drained`: authoritative unshipped count reached zero; `timeout`: rows remain at the deadline; `not-requested` (default); `unavailable`: no supported count/request capability or count failed. |
| `snapshot` | `saved`: final OPFS write closed successfully; `timeout`; `unavailable`: OPFS/snapshot unavailable; `not-persistent`; `error`. |

Each timeout accepts finite milliseconds from 0 through 30000. Upload waiting
happens first; transport and snapshot waits then overlap. These are cooperative
bounds: browser task scheduling and synchronous native work cannot be preempted.
A snapshot timeout retains native storage until that save settles, and the returned
`pending` result remains unchanged. If that save never settles, the retained
storage cannot be reclaimed by this close. Shared owners remain active and may
continue writing. `uploads: drained` does not certify a remote fsync or durable
snapshot beyond the existing server ACK contract.

Full cleanup, exact native handoff tracking, and native progress unsubscription
require the matching rebuilt WASM assets. Older assets get only a conservative
fresh-socket attribution fallback and report `native: unsupported`; cached legacy
transports cannot be safely adopted by URL. On old assets a progress disposer stops
JS delivery but cannot remove its native registration. This API adds no socket
admission cap or inbound/outbound queue byte limit.

### Rescuing Orphaned Writes

Browser builds never redial: when the sync socket dies, the store keeps
accepting writes and journalling them for an uploader whose transport is gone.
Detecting the death is app-side and never instantaneous, so a write can land in
a store that can no longer ship it. If an app recovers by reopening under a
**fresh store name**, that store starts empty and catches up from the server,
so it does not contain those stranded writes. An opt-in close drain cannot
deliver through an already-dead socket.

Point the new store at the one it replaces and those writes are re-offered on
the live socket:

```typescript
const lattice = await Lattice.open(freshName, [Todo], {
    sync: { websocketUrl, authToken },
    resumePendingFrom: previousName,          // the store this one replaces
    onResumePending: (r) => console.log(`rescued ${r.applied.length} write(s)`),
});
```

The drain runs once the new store's socket is open **and** its catch-up has
gone quiet, so rescued rows land on top of the server's authoritative replay
rather than under it. It never blocks `open()`.

Or drive it by hand -- inspect first, drain when you choose:

```typescript
// Storage-only read of an abandoned store: no socket, no writes.
const pending = await Lattice.pendingUploads(previousName, [Todo]);
console.log(`${pending.length} write(s) never reached the server`, pending);

// Re-offer them through a live, connected instance.
const report = await lattice.drainPendingFrom(previousName);
```

Draining is **idempotent** at three levels -- rows the target already has are
skipped before any write, the replayed SQL upserts on `globalId` behind a value
guard, and the server drops changes it has already seen -- so re-draining the
same store, or draining it into two different stores, delivers once.

### Tabs

There is no cross-tab relay, and no worker of any kind -- everything runs on the
main thread. Two tabs that open the same path each hold their **own** database
(the same OPFS snapshot, restored twice) and do not see each other's local
writes directly.

Where tabs need to converge, sync does it: tabs pointed at the same
`websocketUrl` converge through the server, on the same path that carries other
devices. Without sync, treat a store as tab-local.

(Versions before this one advertised a SharedWorker + BroadcastChannel relay.
It never relayed anything -- and constructing it broke `Lattice.open()`
outright on engines with no `SharedWorker`: Safari &lt; 16.4, iOS WKWebView,
embedded webviews. It was removed rather than repaired.)

## Framework Integration

### React

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Lattice, model, Results } from '@jsflax/lattice';

// --- Models ---

@model
class Todo {
    title = '';
    done = false;
    createdAt = new Date();
}

// --- Hook: useLattice ---

let latticePromise: Promise<Lattice> | null = null;

function useLattice(): Lattice | null {
    const [lattice, setLattice] = useState<Lattice | null>(null);

    useEffect(() => {
        if (!latticePromise) {
            latticePromise = Lattice.open('myapp', [Todo]);
        }
        latticePromise.then(setLattice);
    }, []);

    return lattice;
}

// --- Hook: useQuery ---

function useQuery<T>(
    lattice: Lattice | null,
    factory: (db: Lattice) => Results<T>,
    deps: any[] = []
): T[] {
    const [items, setItems] = useState<T[]>([]);

    const reload = useCallback(async () => {
        if (!lattice) return;
        const results = factory(lattice);
        setItems(await results.snapshot());
    }, [lattice, ...deps]);

    useEffect(() => { reload(); }, [reload]);

    // Re-query when the table changes
    useEffect(() => {
        if (!lattice) return;
        // Observe the model used in the query
        const modelClass = (factory(lattice) as any).modelClass;
        if (!modelClass) return;
        const unsub = lattice.observeTable(modelClass, () => reload());
        return unsub;
    }, [lattice, reload]);

    return items;
}

// --- Component ---

function TodoApp() {
    const lattice = useLattice();
    const [title, setTitle] = useState('');

    const todos = useQuery(
        lattice,
        (db) => db.objects(Todo).sorted('createdAt DESC'),
    );

    const addTodo = async () => {
        if (!lattice || !title.trim()) return;
        const todo = new Todo();
        todo.title = title.trim();
        await lattice.add(todo);
        setTitle('');
    };

    const toggleTodo = async (todo: Todo) => {
        todo.done = !todo.done;
    };

    const removeTodo = async (todo: Todo) => {
        if (!lattice || !todo.id) return;
        await lattice.remove(Todo, todo.id);
    };

    if (!lattice) return <div>Loading...</div>;

    return (
        <div>
            <h1>Todos</h1>
            <form onSubmit={(e) => { e.preventDefault(); addTodo(); }}>
                <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="What needs to be done?"
                />
                <button type="submit">Add</button>
            </form>
            <ul>
                {todos.map((todo) => (
                    <li key={todo.id}>
                        <label>
                            <input
                                type="checkbox"
                                checked={todo.done}
                                onChange={() => toggleTodo(todo)}
                            />
                            <span style={{
                                textDecoration: todo.done ? 'line-through' : 'none',
                            }}>
                                {todo.title}
                            </span>
                        </label>
                        <button onClick={() => removeTodo(todo)}>Delete</button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default TodoApp;
```

### Vue

```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { Lattice, model } from '@jsflax/lattice';

@model
class Todo {
    title = '';
    done = false;
    createdAt = new Date();
}

const lattice = ref<Lattice | null>(null);
const todos = ref<Todo[]>([]);
const title = ref('');
let unsubscribe: (() => void) | null = null;

async function reload() {
    if (!lattice.value) return;
    todos.value = await lattice.value
        .objects(Todo)
        .sorted('createdAt DESC')
        .snapshot();
}

onMounted(async () => {
    lattice.value = await Lattice.open('myapp', [Todo]);
    await reload();

    // Re-query when data changes (local edits, server sync)
    unsubscribe = lattice.value.observeTable(Todo, () => reload());
});

onUnmounted(() => {
    unsubscribe?.();
});

async function addTodo() {
    if (!lattice.value || !title.value.trim()) return;
    const todo = new Todo();
    todo.title = title.value.trim();
    await lattice.value.add(todo);
    title.value = '';
}

function toggleTodo(todo: Todo) {
    todo.done = !todo.done;
}

async function removeTodo(todo: Todo) {
    if (!lattice.value || !todo.id) return;
    await lattice.value.remove(Todo, todo.id);
}
</script>

<template>
    <div>
        <h1>Todos</h1>
        <form @submit.prevent="addTodo">
            <input v-model="title" placeholder="What needs to be done?" />
            <button type="submit">Add</button>
        </form>
        <ul>
            <li v-for="todo in todos" :key="todo.id">
                <label>
                    <input
                        type="checkbox"
                        :checked="todo.done"
                        @change="toggleTodo(todo)"
                    />
                    <span :style="{
                        textDecoration: todo.done ? 'line-through' : 'none',
                    }">
                        {{ todo.title }}
                    </span>
                </label>
                <button @click="removeTodo(todo)">Delete</button>
            </li>
        </ul>
    </div>
</template>
```

## API Reference

### `Lattice`

| Method | Description |
|--------|-------------|
| `Lattice.open(path, models, options?)` | Open a database. Use `':memory:'` or a name for OPFS persistence. |
| `Lattice.setLogLevel(level)` | Set C++ log verbosity (`Off`, `Error`, `Warn`, `Info`, `Debug`). |
| `Lattice.pendingUploads(path, models, options?)` | Storage-only read of a store's un-ACKed writes, as plain JSON. Opens no socket. |
| `drainPendingFrom(previousPath, options?)` | Re-offer an abandoned store's un-ACKed writes through this live instance. Idempotent. |
| `add(instance)` | Insert a model instance. Returns it with `id` and `globalId` set. |
| `addAll(instances)` | Bulk insert in a single transaction. |
| `find(Model, id)` | Find by primary key. |
| `findByGlobalId(Model, globalId)` | Find by sync UUID. |
| `objects(Model)` | Returns `Results<T>` for querying. |
| `count(Model, where?)` | Count matching rows. |
| `remove(Model, id)` | Delete by primary key. |
| `write(fn)` | Execute a write transaction. |
| `observe(callback)` | Observe all audit log changes. Returns unsubscribe function. |
| `observeTable(Model, callback)` | Observe INSERT/UPDATE/DELETE on a table. Returns unsubscribe function. |
| `observeObject(Model, instance, callback)` | Observe field changes on a specific object. Returns unsubscribe function. |
| `onSyncProgress(callback)` | Monitor sync upload/download progress. Returns unsubscribe function. |
| `updateSyncFilter(filters)` | Limit which tables/rows sync. |
| `clearSyncFilter()` | Sync everything. |
| `close(options?)` | Retire callbacks and return explicit native, transport, upload, and snapshot outcomes. |
| `onSyncState(callback)` | Subscribe to this instance with immediate current-state replay; returns unsubscribe. |

### `Results<T>`

| Method | Description |
|--------|-------------|
| `.where(clause)` | Filter with SQL string or type-safe builder `(q => q.age.gte(18))`. |
| `.sorted(clause)` | Order results (`"name ASC"`, `"age DESC"`). |
| `.limit(n)` | Cap the number of results. |
| `.groupBy(field)` | Group results by a column. |
| `.distinct(field)` | Deduplicate by a column. |
| `.snapshot()` | Get all matching results as an array. |
| `.count()` | Get the count of matching results. |
| `.first()` | Get the first result. |
| `.at(index)` | Get result at a specific index. |
| `.matching(column, text)` | Full-text search (requires `fullText()` column). |
| `.nearest(column, vector, k, opts?)` | Vector nearest-neighbor search. |
| `.map(fn)` / `.filter(fn)` | In-memory functional operations. |
| `for await (const item of results)` | Async iteration in batches of 100. |

### Decorators

| Decorator | Description |
|-----------|-------------|
| `@model` / `@model('table_name')` | Mark a class as a Lattice model. |
| `link(Model)` | To-one relationship (nullable). |
| `list(Model)` | To-many relationship. |
| `nullable(Type)` | Nullable field with explicit type (`nullable(Date)`). |
| `indexed(defaultValue)` | Add a B-tree index. |
| `fullText(defaultValue)` | Enable FTS5 full-text search. |
| `vector(dimensions)` | Vector column for nearest-neighbor search. |
| `embedded(Class)` | Store as JSON text. |
| `enumValue(Enum, default?)` | Map to a TypeScript enum. |
| `@unique()` | Unique constraint on a property. |
| `@compoundUnique(fields)` | Compound unique constraint on the class. |

## Building from Source

```bash
# Requires Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source emsdk_env.sh

# Build everything
npm install
npm run build        # WASM + TypeScript

# Development
npm run dev          # Vite dev server with hot reload

# Tests
npm test             # Unit tests (Node.js)
npm run test:browser # Browser integration tests
```

## License

MIT
