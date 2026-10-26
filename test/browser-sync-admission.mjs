// Loopback actual Chromium + public Lattice.open + single-use HttpOnly cookie.
// The server is an admission fixture, not a production gateway or identity provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.LATTICE_ADMISSION_EVIDENCE;
const hud = process.env.HUD_BROWSER_REPO;
for (const value of [out, hud]) assert.ok(value?.startsWith('/Users/jason/localdev/') && path.isAbsolute(value));
assert.ok(!fs.existsSync(out), 'Use a fresh evidence directory');
fs.mkdirSync(out, { recursive: false });
const sha = value => createHash('sha256').update(value).digest('hex');
const describe = file => { const value = fs.readFileSync(file); return { path: file, bytes: value.length, sha256: sha(value) }; };
const loader = describe(path.join(repo, 'wasm/build/lattice.js'));
const wasm = describe(path.join(repo, 'wasm/build/lattice.wasm'));
const fixture = path.join(repo, 'test/fixtures/browser-sync-admission-runtime.ts');
const bundled = await build({ entryPoints: [fixture], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false,
    plugins: [{ name: 'native-loader', setup(api) {
        api.onResolve({ filter: /lattice\.(js|wasm)\?url$/ }, args => ({ path: args.path, namespace: 'loader' }));
        api.onLoad({ filter: /.*/, namespace: 'loader' }, args => ({ contents:
            `export default ${JSON.stringify(args.path.includes('.wasm') ? '/lattice.wasm' : '/lattice.js')}` }));
    } }] });
const script = Buffer.from(bundled.outputFiles[0].contents);
fs.writeFileSync(path.join(out, 'runtime.mjs'), script);
const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'";
const routes = new Map([
    ['/', ['text/html', Buffer.from('<!doctype html><title>Local sync admission test</title><script type="module" src="/runtime.mjs"></script>')]],
    ['/runtime.mjs', ['text/javascript', script]],
    ['/lattice.js', ['text/javascript', fs.readFileSync(loader.path)]],
    ['/lattice.wasm', ['application/wasm', fs.readFileSync(wasm.path)]],
]);
const counts = { tickets: 0, refusedTickets: 0, upgrades: 0, rejectedUpgrades: 0, resumeCursors: 0, authorizationHeaders: 0, credentialQueries: 0, live: 0, closed: 0, maxOpen: 0 };
// These opaque fixture cookies stay in process memory and never enter the receipt.
const tickets = new Set();
const serverErrors = [];
const eventId = '7f432120-29b1-4826-94f4-e22ad59e2ba7';
let origin;
const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', policy);
    if (req.url === '/browser/sync-ticket' && req.method === 'POST') {
        if (req.headers['x-csrf-token'] !== 'synthetic-csrf-fixture' || req.headers.origin !== origin || req.headers['x-fixture-mode'] === 'refused') {
            ++counts.refusedTickets; res.writeHead(403); res.end('Refused'); return;
        }
        const ticket = randomUUID(); tickets.add(ticket); ++counts.tickets;
        // HTTP loopback only. Production requires HTTPS + Secure; this fixture
        // qualifies HttpOnly/path/single-use behavior, not TLS deployment policy.
        res.setHeader('Set-Cookie', `lattice_admission=${ticket}; HttpOnly; SameSite=Strict; Path=/browser/sync`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ready":true}'); return;
    }
    if (req.url === '/test/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(counts)); return; }
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const route = routes.get(req.url);
    res.writeHead(route ? 200 : 404, { 'Content-Type': route?.[0] ?? 'text/plain', 'X-Content-Type-Options': 'nosniff' });
    res.end(route?.[1] ?? 'Not found');
});
const ws = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);
    if (req.headers.authorization) ++counts.authorizationHeaders;
    if ([...url.searchParams.keys()].some(key => key !== 'last-event-id')) ++counts.credentialQueries;
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('lattice_admission='))?.slice(18);
    const ready = url.pathname === '/browser/sync' && req.headers.origin === origin && cookie && tickets.delete(cookie) &&
        [...url.searchParams.keys()].every(key => key === 'last-event-id') && url.searchParams.getAll('last-event-id').length <= 1;
    if (!ready) { ++counts.rejectedUpgrades; socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    if (url.searchParams.has('last-event-id')) {
        if (url.searchParams.get('last-event-id') !== eventId) {
            serverErrors.push('Unexpected resume cursor'); ++counts.rejectedUpgrades;
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
        }
        ++counts.resumeCursors;
    }
    ++counts.upgrades;
    ws.handleUpgrade(req, socket, head, client => {
        ++counts.live;
        counts.maxOpen = Math.max(counts.maxOpen, [...ws.clients].filter(peer => peer.readyState === 1).length);
        client.once('close', () => { --counts.live; ++counts.closed; });
        ws.emit('connection', client, req);
        client.send(JSON.stringify({ kind: 'auditLog', auditLog: [{ id: 1, globalId: eventId, tableName: 'AdmissionNote',
            operation: 'INSERT', rowId: 1, globalRowId: '0545ebef-4dd3-471b-aa84-c7eef28ff3cb',
            changedFields: { title: 'Synthetic loopback row' }, changedFieldsNames: ['title'],
            timestamp: 1792836000, isFromRemote: false, isSynchronized: true }] }));
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = createRequire(path.join(hud, 'Browser/package.json'))('@playwright/test');
const receipt = { passed: false, startedAt: new Date().toISOString(), actualBrowser: true, actualWasm: true, actualLoopbackWebSocket: true,
    externalAccount: false, productionGateway: false, tlsSecureCookieQualified: false, releaseQualification: false,
    loader, wasm, fixture: describe(fixture), bundle: describe(path.join(out, 'runtime.mjs')), policy, errors: [], externalRequests: [] };
let browser, watchdog;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    receipt.browser = browser.version();
    const context = await browser.newContext(); const page = await context.newPage();
    page.on('pageerror', error => receipt.errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(origin + '/')) receipt.externalRequests.push(request.url()); });
    await page.goto(origin); await page.waitForFunction(() => !!window.admissionGate);
    receipt.result = await Promise.race([
        page.evaluate(() => window.admissionGate.run()),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Admission gate exceeded 60 seconds')), 60000); }),
    ]);
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(receipt.errors, []); assert.deepEqual(receipt.externalRequests, []);
    assert.equal(receipt.result.checks.length, 5); assert.equal(receipt.result.cookieReadable, false);
    assert.equal(describe(loader.path).sha256, loader.sha256); assert.equal(describe(wasm.path).sha256, wasm.sha256);
    receipt.passed = true; await context.close();
} catch (error) { receipt.failure = error.stack ?? String(error); process.exitCode = 1; }
finally {
    clearTimeout(watchdog); receipt.serverErrors = serverErrors;
    await browser?.close(); for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    receipt.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(out, 'receipt.json') }));
}
