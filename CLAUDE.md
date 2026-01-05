# LatticeJS

A browser-first ORM for JavaScript/TypeScript with WebAssembly, providing SQLite-backed persistence with cross-tab sync and optional server sync.

## Project Overview

LatticeJS is a TypeScript ORM that uses a C++ core compiled to WebAssembly. It provides:
- **Decorator-based models** (`@model`, `link()`, `list()`, `nullable()`)
- **C++ backing storage** via Emscripten-compiled WASM
- **Cross-tab sync** using SharedWorker + BroadcastChannel
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
└── worker/
    ├── index.ts           # Standard Web Worker entry
    ├── shared-bootstrap.ts # SharedWorker bootstrap (polyfills)
    └── shared-impl.ts      # SharedWorker implementation
```

### Key Patterns

1. **C++ Backing Objects**: Model instances use `DynamicObject` (C++) for storage. Properties are getters/setters that read/write to C++.

2. **Symbols for Internal State**:
   - `DYNAMIC_OBJECT` - C++ DynamicObject reference on instances
   - `LATTICE_REF` - Lattice instance reference for link/list resolution
   - `PROPERTY_SCHEMA` - Property metadata on model classes

3. **Hydration**: `hydrateInstance()` creates model instances from C++ objects without running constructors (uses `Object.create()`).

4. **Persistence Architecture**:
   - In-memory (`:memory:`): WASM runs on main thread
   - Persistent: Main thread has in-memory WASM + SharedWorker has OPFS-backed WASM, synced via BroadcastChannel

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
import { model, link, list, nullable } from 'lattice-js';

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
import { Lattice, model, link, list } from 'lattice-js';

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

**Runtime:**
- `comlink` - Web Worker RPC

**Development:**
- `typescript` - Type checking and compilation
- `vite` - Dev server and bundling
- `vitest` - Testing framework
- `reflect-metadata` - Decorator metadata (peer dependency)

## Important Notes

1. **WASM must load before creating models**: Call `Lattice.open()` before instantiating `@model` classes.

2. **COOP/COEP Headers**: Required for SharedArrayBuffer (WASM threading). Vite config sets these.

3. **SharedWorker Limitations**: OPFS with WASMFS has compatibility issues in SharedWorker context. Falls back to in-memory if unavailable.

4. **BigInt Handling**: C++ returns BigInt for integers; code converts to Number for convenience.

5. **Sync Architecture**: Changes propagate via audit log entries. `isFromRemote` flag prevents infinite sync loops.

6. **List/Link Resolution**: Accessing a `link()` or `list()` property automatically resolves to hydrated model instances.

## File Locations

- **WASM Output**: `wasm/build/lattice.js`, `wasm/build/lattice.wasm`
- **TS Output**: `dist/`
- **Example App**: `examples/notes.html` (notes app with cross-tab + optional server sync)
