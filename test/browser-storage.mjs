// Browser public-open/OPFS gate against a previously qualified exact Wasm image.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hud = process.env.HUD_BROWSER_REPO;
const out = process.env.LATTICE_BROWSER_EVIDENCE;
const runtimeReceipt = process.env.LATTICE_NATIVE_RECEIPT;
for (const value of [hud, out, runtimeReceipt]) assert.ok(value?.startsWith('/Users/jason/localdev/') && path.isAbsolute(value));
assert.ok(!fs.existsSync(out), 'Use a new evidence directory');
fs.mkdirSync(out, { recursive: false });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const describe = file => { const bytes = fs.readFileSync(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; };
const wasm = describe(path.join(repo, 'wasm/build/lattice.wasm'));
const loader = describe(path.join(repo, 'wasm/build/lattice.js'));
const prior = JSON.parse(fs.readFileSync(runtimeReceipt, 'utf8'));
assert.equal(prior.passed, true); assert.equal(prior.tests.length, 33);
assert.equal(prior.receipt.wasm.sha256, wasm.sha256); assert.equal(prior.receipt.js.sha256, loader.sha256);
const fixture = path.join(repo, 'test/fixtures/browser-storage-runtime.ts');
const bundle = await build({ entryPoints: [fixture], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    plugins: [{ name: 'browser-gate-inputs', setup(api) {
        api.onResolve({ filter: /lattice\.(js|wasm)\?url$/ }, args => ({ path: args.path, namespace: 'loader-url' }));
        api.onLoad({ filter: /.*/, namespace: 'loader-url' }, args => ({ contents:
            `export default ${JSON.stringify(args.path.includes('.wasm') ? '/lattice.wasm' : '/lattice.js')};` }));
        api.onResolve({ filter: /^hud-browser-gate-adapter$/ }, () => ({ path: 'hud-adapter', namespace: 'hud-adapter' }));
        api.onLoad({ filter: /.*/, namespace: 'hud-adapter' }, () => ({ resolveDir: hud, loader: 'ts', contents:
            `export { createHUDLatticeDefinition } from './Browser/src/lattice-models.ts'; export { HUD_REGISTRY_HASH } from './Browser/src/registry.ts';` }));
    } }] });
const script = Buffer.from(bundle.outputFiles[0].contents);
fs.writeFileSync(path.join(out, 'browser-runtime.mjs'), script);
const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const routes = new Map([
    ['/', ['text/html', Buffer.from('<!doctype html><title>Lattice browser storage qualification</title><script type="module" src="/runtime.mjs"></script>')]],
    ['/runtime.mjs', ['text/javascript', script]],
    ['/lattice.js', ['text/javascript', fs.readFileSync(loader.path)]],
    ['/lattice.wasm', ['application/wasm', fs.readFileSync(wasm.path)]],
]);
const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const route = routes.get(req.url);
    res.writeHead(route ? 200 : 404, { 'Content-Type': route?.[0] ?? 'text/plain', 'Content-Security-Policy': policy,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(route?.[1] ?? 'Not found');
});
const { chromium } = createRequire(path.join(hud, 'Browser/package.json'))('@playwright/test');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const receipt = { passed: false, startedAt: new Date().toISOString(), publicOpenLoader: true, realBrowser: true,
    remoteSync: false, nativeFileParity: false, crossPlatformMatrix: false, releaseQualification: false,
    policy, runtimeGate: describe(runtimeReceipt), wasm, loader, fixture: describe(fixture),
    bundle: describe(path.join(out, 'browser-runtime.mjs')), checks: [], errors: [], externalRequests: [] };
let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    receipt.browser = browser.version();
    const context = await browser.newContext();
    async function pageForTest() {
        const page = await context.newPage();
        page.on('pageerror', error => receipt.errors.push(error.message));
        page.on('request', request => { if (!request.url().startsWith(origin + '/')) receipt.externalRequests.push(request.url()); });
        await page.goto(origin);
        await page.waitForFunction(() => !!window.storageGate);
        return page;
    }
    const filename = `hud-browser-${randomUUID()}.lattice`;
    let page = await pageForTest();
    const seed = await page.evaluate(name => window.storageGate.seed(name), filename);
    assert.equal(seed.closed.snapshot, 'saved'); assert.deepEqual(seed.violations, []);
    receipt.checks.push({ name: 'public loader under Wasm-only eval CSP; generated HUD schema and native disposal', result: seed });
    await page.close();
    page = await pageForTest();
    const restored = await page.evaluate(name => window.storageGate.read(name), filename);
    assert.equal(restored.closed.snapshot, 'saved'); assert.deepEqual(restored.violations, []);
    receipt.checks.push({ name: 'fresh page restores OPFS with exact wide integers, union, parent, null and epoch zero', result: restored });
    await page.close();
    page = await pageForTest();
    const downgrade = await page.evaluate(name => window.storageGate.downgrade(name), filename);
    assert.equal(downgrade.refused, true); assert.deepEqual(downgrade.violations, []);
    const afterRefusal = await page.evaluate(name => window.storageGate.read(name), filename);
    assert.equal(afterRefusal.result.restored, true);
    receipt.checks.push({ name: 'restored schema downgrade refuses while current version reopens preserved data', result: downgrade });
    await page.close();
    for (const mode of ['denied', 'missing']) {
        page = await pageForTest();
        const result = await page.evaluate(({ mode, name }) => window.storageGate[mode](name), { mode, name: `${mode}-${filename}` });
        assert.equal(result.closed.snapshot, mode === 'denied' ? 'error' : 'unavailable'); assert.deepEqual(result.violations, []);
        receipt.checks.push({ name: `${mode} OPFS preserves usable memory storage and reports unsaved status`, result });
        await page.close();
    }
    assert.deepEqual(receipt.errors, []); assert.deepEqual(receipt.externalRequests, []);
    assert.equal(describe(wasm.path).sha256, wasm.sha256); assert.equal(describe(loader.path).sha256, loader.sha256);
    await context.close(); receipt.passed = true;
} catch (error) { receipt.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
    const cleanup = await Promise.allSettled([
        browser?.close(),
        new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    ]);
    const failures = cleanup.filter(result => result.status === 'rejected').map(result => String(result.reason));
    if (failures.length) { receipt.cleanupErrors = failures; receipt.passed = false; process.exitCode = 1; }
    receipt.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, evidence: path.join(out, 'receipt.json'), failure: receipt.failure }));
}
