// Regression: Lattice must open on engines that have no SharedWorker.
//
// `openPersistent` used to call `createSharedWorker()` — an unguarded
// `new SharedWorker(...)` — outside any try/catch, and this module used to
// construct a `lattice-debug` BroadcastChannel at IMPORT time. On Safari
// < 16.4, in iOS WKWebView and in embedded webviews generally, those globals
// do not exist: the constructor threw ReferenceError and `Lattice.open()` on
// any persistent path REJECTED. The worker it was reaching for did nothing
// anywhere (no-op `init`, a BroadcastChannel nobody listened on or posted to,
// and a bootstrap Vite inlined as a `data:` URL, from which its relative
// `import('./shared-impl')` could never resolve), so the path was removed
// rather than guarded.
//
// These tests pin that: a persistent open with SharedWorker stubbed away, no
// SharedWorker constructed even where one exists, a clean import with
// BroadcastChannel stubbed away too, and the surviving teardown.
//
// The wasm module is a fixture (test/fixtures/fake-wasm.js) — vitest runs in
// node, where the real Emscripten build cannot instantiate. What is under test
// is the TypeScript layer's platform assumptions, not sqlite.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'reflect-metadata';

// `?url` under vitest resolves to an absolute filesystem path, which is what
// `ensureWasm()` then dynamic-imports. Point both at the fixture.
const { fakeWasmPath } = vi.hoisted(() => ({
    fakeWasmPath: new URL('./fixtures/fake-wasm.js', import.meta.url).pathname,
}));
vi.mock('../wasm/build/lattice.js?url', () => ({ default: fakeWasmPath }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/fake/lattice.wasm' }));

/**
 * Re-import the library with the current globals in force.
 *
 * Every test here resets the module registry, because what is under test
 * includes IMPORT-time behavior. The model class has to be built from the same
 * fresh registry: `@model` records its table name in reflect-metadata under a
 * key that decorators.ts owns per module instance, so a class decorated by an
 * older copy is invisible to `buildSchemas()` in the new one.
 */
async function freshLattice() {
    vi.resetModules();
    const { model } = await import('../src/decorators');
    const { Lattice } = await import('../src/lattice');

    class Note {
        title = '';
        body = '';
    }

    return { Lattice, Note: model(Note) };
}

/** The engines this test exists for: no SharedWorker at all. */
function stubAwaySharedWorker() {
    vi.stubGlobal('SharedWorker', undefined);
    // stubGlobal defines the property; make it genuinely absent as well, so
    // `'SharedWorker' in globalThis` is false the way it is in WKWebView.
    delete (globalThis as Record<string, unknown>).SharedWorker;
}

beforeEach(() => {
    stubAwaySharedWorker();
    // Node < 21 has no `navigator`; the OPFS helpers reference it bare. Give
    // them one with no `storage` — "OPFS unavailable", the same shape an old
    // webview presents.
    vi.stubGlobal('navigator', {});
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('SharedWorker-free operation', () => {
    it('opens a persistent database when SharedWorker is undefined', async () => {
        expect(typeof (globalThis as { SharedWorker?: unknown }).SharedWorker).toBe('undefined');

        const { Lattice, Note } = await freshLattice();

        // The bug: this rejected with "ReferenceError: SharedWorker is not
        // defined" before the wasm handle was ever returned.
        const lattice = await Lattice.open('regression-no-shared-worker.db', [Note]);

        expect(lattice).toBeDefined();
        await expect(lattice.close()).resolves.toBeUndefined();
    });

    it('constructs no SharedWorker even where one is available', async () => {
        // A tab that HAS SharedWorker must not get one either — the relay is
        // gone, not merely skipped on old engines. Any construction attempt
        // fails the test loudly.
        const attempts: unknown[] = [];
        vi.stubGlobal('SharedWorker', class {
            port = { start() {}, close() {}, postMessage() {} };
            constructor(url: unknown) {
                attempts.push(url);
            }
        });

        const { Lattice, Note } = await freshLattice();
        const lattice = await Lattice.open('regression-worker-present.db', [Note]);
        await lattice.close();

        expect(attempts).toEqual([]);
    });

    it('imports and opens with BroadcastChannel undefined too', async () => {
        // The module-level `new BroadcastChannel('lattice-debug')` made merely
        // IMPORTING this library throw on engines without it.
        vi.stubGlobal('BroadcastChannel', undefined);
        delete (globalThis as Record<string, unknown>).BroadcastChannel;

        const { Lattice, Note } = await freshLattice();
        const lattice = await Lattice.open('regression-no-broadcast-channel.db', [Note]);

        expect(lattice).toBeDefined();
        await lattice.close();
    });

    it('still retires the snapshot listeners on close', async () => {
        // openPersistent's housekeeping is what the removed worker block sat
        // next to; prove the surviving teardown is intact.
        const added: string[] = [];
        const removed: string[] = [];
        vi.stubGlobal('document', {
            visibilityState: 'visible',
            addEventListener: (t: string) => { added.push(t); },
            removeEventListener: (t: string) => { removed.push(t); },
        });
        vi.stubGlobal('window', {
            addEventListener: (t: string) => { added.push(t); },
            removeEventListener: (t: string) => { removed.push(t); },
        });

        const { Lattice, Note } = await freshLattice();
        const lattice = await Lattice.open('regression-teardown.db', [Note]);
        expect(added).toEqual(['visibilitychange', 'pagehide']);

        await lattice.close();
        expect(removed).toEqual(['visibilitychange', 'pagehide']);
    });
});
