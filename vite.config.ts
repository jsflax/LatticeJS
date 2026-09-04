import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    // Required headers for SharedArrayBuffer (needed for OPFS sync access)
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'LatticeJS',
            fileName: 'lattice',
        },
    },
});
