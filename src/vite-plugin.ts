import type { Plugin } from 'vite';

export function latticePlugin(): Plugin {
    return {
        name: 'lattice-keep-names',
        config() {
            return {
                esbuild: { keepNames: true },
            };
        },
    };
}
