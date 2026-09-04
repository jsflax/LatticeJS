# LatticeJS

A browser-first ORM for JavaScript/TypeScript with WebAssembly, providing SQLite-backed persistence and optional server sync.

## Project Overview

LatticeJS is a TypeScript ORM that uses a C++ core compiled to WebAssembly. It provides:
- **Decorator-based models** (`@model`, `link()`, `list()`, `nullable()`)
- **C++ backing storage** via Emscripten-compiled WASM
- **OPFS persistence** (Origin Private File System) when available
- **Server sync** via WebSocket for multi-device synchronization
- **Live queries** via `Results<T>` with async iteration

## Architecture

```
src/
├── index.ts          # Public API exports
├── lattice.ts        # Main Lattice class - database operations
├── decorators.ts     # @model, link(), list(), nullable() decorators
├── types.ts          # TypeScript type definitions
├── storage.ts        # WASM module reference management
├── results.ts        # Live query Results<T> class
├── list.ts           # List<T> for to-many relationships
├── sync-socket.ts    # Sync WebSocket tracking / teardown
├── pending-drain.ts  # Orphaned-write rescue
└── vite-plugin.ts    # keepNames plugin (minified @model names)
```

There is no `worker/` directory and no worker of any kind. The SharedWorker
relay that used to live there was inert (no-op `init`, a BroadcastChannel
nobody listened on, a bootstrap Vite inlined as a `data:` URL whose relative
`import()` never resolved) and its unguarded `new SharedWorker(...)` made
`Lattice.open()` reject outright wherever `SharedWorker` is undefined
(Safari < 16.4, iOS WKWebView, embedded webviews). Do not reintroduce a
worker path without a consumer that actually needs one — and if one is ever
needed, feature-detect it and keep it optional.

### Key Patterns

1. **C++ Backing Objects**: Model instances use `DynamicObject` (C++) for storage. Properties are getters/setters that read/write to C++.

2. **Symbols for Internal State**:
   - `DYNAMIC_OBJECT` - C++ DynamicObject reference on instances
   - `LATTICE_REF` - Lattice instance reference for link/list resolution
   - `PROPERTY_SCHEMA` - Property metadata on model classes

3. **Hydration**: `hydrateInstance()` creates model instances from C++ objects without running constructors (uses `Object.create()`).

4. **Persistence Architecture**: WASM runs on the main thread in both modes.
   - In-memory (`:memory:`): lives for the page's lifetime only
   - Persistent: the same MEMFS database, snapshotted to OPFS every 15s when
     dirty, on `visibilitychange`/`pagehide`, and at `close()`; restored from
     that snapshot on the next open, so sync only has to fetch the delta

## Build Commands

```bash
# Install dependencies
npm install

# Build WASM (requires Emscripten)
npm run build:wasm
# Or manually: cd wasm && mkdir -p build && cd build && emcmake cmake .. && emmake make

# Build TypeScript
npm run build:ts

# Build everything
npm run build

# Development server (with hot reload)
npm run dev

# Clean build artifacts
npm run clean
```

### WASM Build Requirements

Requires Emscripten SDK:
```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source emsdk_env.sh
```

The WASM build expects a C++ project at `~/Documents/LatticeCpp` with the core Lattice implementation.

## Testing

```bash
# Run unit tests (TypeScript layer, no WASM required)
npm test

# Watch mode
npm run test:watch

# Browser integration tests (requires WASM build)
npm run test:browser
```

### Test Types

1. **Unit Tests** (`test/lattice.test.ts`): Decorator and schema extraction tests, run in Node.js with Vitest.

2. **Browser Tests** (`test/browser/`): Full integration tests requiring WASM + browser environment. Accessible at `/test/browser/index.html`.

## Model Definition

```typescript
import { model, link, list, nullable } from '@jsflax/lattice';

@model
class Dog {
    name = '';
    puppies = list(Dog);  // Self-referencing list
}

@model
class Person {
    name = '';
    age = 0;
    dog = link(Dog);           // To-one relationship
    createdAt = new Date();
    deletedAt = nullable(Date); // Nullable with explicit type
}

@model('custom_table')  // Custom table name
class CustomModel {
    value = '';
}
```

### Type Inference

- `string` default → `'string'` column
- Integer default → `'int'` column
- Float default → `'float'` column
- `boolean` default → `'bool'` column
- `Date` default → `'date'` column (stored as Unix timestamp)
- `Uint8Array` default → `'blob'` column
- `null` default → nullable column (use `nullable(Type)` for explicit type)

## Usage

```typescript
import { Lattice, model, link, list } from '@jsflax/lattice';

// Open database
const lattice = await Lattice.open('mydb', [Person, Dog]);

// With server sync
const lattice = await Lattice.open('mydb', [Person, Dog], {
    sync: { websocketUrl: 'ws://localhost:8080/sync', authToken: 'token' }
});

// CRUD
const person = new Person();
person.name = 'John';
await lattice.add(person);

const found = await lattice.find(Person, person.id!);
const all = await lattice.objects(Person).where("age > 18").snapshot();

await lattice.remove(Person, person.id!);

// Transactions
await lattice.write(async () => {
    await lattice.add(person1);
    await lattice.add(person2);
});

// Observation
const unsubscribe = lattice.observe((entries) => {
    console.log('Changes:', entries);
});
```

## Dependencies

**Runtime:** none. (`comlink` was the worker RPC layer and went with the
worker.)

**Development:**
- `typescript` - Type checking and compilation
- `vite` - Dev server and bundling
- `vitest` - Testing framework
- `reflect-metadata` - Decorator metadata (peer dependency)

## Important Notes

1. **WASM must load before creating models**: Call `Lattice.open()` before instantiating `@model` classes.

2. **COOP/COEP Headers**: Required for SharedArrayBuffer (WASM threading). Vite config sets these.

3. **No SharedWorker, no BroadcastChannel**: neither is touched, at import time or after. Both are absent on real target engines (Safari < 16.4, iOS WKWebView), and reaching for one unguarded used to make `Lattice.open()` reject there. Persistence uses the async OPFS API from the main thread, which those engines do have.

4. **BigInt Handling**: C++ returns BigInt for integers; code converts to Number for convenience.

5. **Sync Architecture**: Changes propagate via audit log entries. `isFromRemote` flag prevents infinite sync loops.

6. **List/Link Resolution**: Accessing a `link()` or `list()` property automatically resolves to hydrated model instances.

## File Locations

- **WASM Output**: `wasm/build/lattice.js`, `wasm/build/lattice.wasm`
- **TS Output**: `dist/`
- **Example App**: `examples/notes.html` (notes app with optional server sync)
