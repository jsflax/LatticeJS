// Prepare the real TypeScript API for the native harness. Only Vite's loader URL
// imports are inert: the test passes the receipt-hashed native module directly.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export async function prepareExplicitRuntime(outputDirectory) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const result = await build({
        entryPoints: [path.join(here, 'fixtures/explicit-models-runtime.ts')],
        bundle: true, platform: 'node', format: 'esm', target: 'es2022', write: false,
        plugins: [{ name: 'unused-wasm-loader-urls', setup(api) {
            api.onResolve({ filter: /lattice\.(js|wasm)\?url$/ }, args => ({ path: args.path, namespace: 'unused-url' }));
            api.onLoad({ filter: /.*/, namespace: 'unused-url' }, () => ({ contents: 'export default "unused-native-harness-loader";' }));
        } }],
    });
    const bytes = result.outputFiles[0].contents;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const output = path.join(outputDirectory, 'explicit-models-runtime.mjs');
    fs.writeFileSync(output, bytes);
    const runtime = await import(pathToFileURL(output).href + `?sha256=${sha256}`);
    return { run: runtime.runExplicitModelCases, receipt: { path: output, bytes: bytes.length, sha256, actualTypeScriptApi: true, publicOpenLoaderCovered: false, hudSchemaCovered: false } };
}
