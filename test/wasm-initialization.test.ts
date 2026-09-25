import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
    path: new URL('./fixtures/controlled-wasm.js', import.meta.url).pathname,
    factory: vi.fn(),
}));
vi.mock('../wasm/build/lattice.js?url', () => ({ default: fixture.path }));
vi.mock('../wasm/build/lattice.wasm?url', () => ({ default: '/fake/lattice.wasm' }));
beforeEach(() => { vi.resetModules(); fixture.factory.mockReset(); vi.stubGlobal('__latticeTestModuleFactory', fixture.factory); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('WASM module initialization', () => {
    it('shares one in-flight module across concurrent public entry points', async () => {
        const module = { _lattice_set_log_level: vi.fn() };
        fixture.factory.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 25));
            return module;
        });
        const { Lattice, LogLevel } = await import('../src/lattice');
        await Promise.all([Lattice.setLogLevel(LogLevel.Info), Lattice.setLogLevel(LogLevel.Warn)]);
        expect(fixture.factory).toHaveBeenCalledTimes(1);
        expect(module._lattice_set_log_level.mock.calls).toEqual([[LogLevel.Info], [LogLevel.Warn]]);
        await Lattice.setLogLevel(LogLevel.Error);
        expect(fixture.factory).toHaveBeenCalledTimes(1);
    });

    it('retries after a failed initialization without poisoning later callers', async () => {
        fixture.factory.mockRejectedValueOnce(new Error('initial load failed'));
        const { Lattice, LogLevel } = await import('../src/lattice');
        await expect(Lattice.setLogLevel(LogLevel.Info)).rejects.toThrow('initial load failed');
        const module = { _lattice_set_log_level: vi.fn() };
        fixture.factory.mockResolvedValueOnce(module);
        await Lattice.setLogLevel(LogLevel.Warn);
        expect(fixture.factory).toHaveBeenCalledTimes(2);
        expect(module._lattice_set_log_level).toHaveBeenCalledWith(LogLevel.Warn);
    });
});
