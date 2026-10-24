// Real browser/public loader against the loopback cookie gate. No external account.
import { Lattice, LogLevel } from '../../src/lattice';
import { defineModels } from '../../src/explicit-models';
import { getWasmModule } from '../../src/storage';
import type { SyncAdmissionContext, SyncStateInfo } from '../../src/types';

const { AdmissionNote } = defineModels({ formatVersion: 1, models: [{ tableName: 'AdmissionNote', properties: [
    { name: 'title', kind: 'primitive', type: 'string', nullable: false },
] }] } as const);
const violations: string[] = [];
document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
    const limit = performance.now() + 6000;
    while (!await predicate()) {
        if (performance.now() > limit) throw new Error(`Timeout: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
const endpoint = location.origin.replace(/^http/, 'ws') + '/browser/sync';
const checks: { name: string; [key: string]: unknown }[] = [];
const attemptContexts: { instanceId: string; generation: number; url: string; signal: AbortSignal }[] = [];
async function ticket(context: SyncAdmissionContext, mode = 'ready') {
    check(context.websocketUrl === endpoint, 'Hook must receive the stable endpoint');
    attemptContexts.push({ instanceId: context.instanceId, generation: context.connectionGeneration,
        url: context.websocketUrl, signal: context.signal });
    const response = await fetch('/browser/sync-ticket', { method: 'POST', credentials: 'same-origin',
        headers: { 'x-csrf-token': 'synthetic-csrf-fixture', 'x-fixture-mode': mode }, signal: context.signal });
    check(response.ok, 'Ticket refused');
    const value = await response.json();
    check(JSON.stringify(value) === '{"ready":true}', 'No credential may be returned to JavaScript');
}
function cookieReadableAtEndpoint(): boolean {
    const previous = location.href;
    history.replaceState(null, '', '/browser/sync');
    try { return document.cookie !== ''; }
    finally { history.replaceState(null, '', previous); }
}
async function stats() { return fetch('/test/stats').then(response => response.json()); }
async function released() {
    await until(() => Object.values(getWasmModule()._lifecycleDiagnostics()).every(value => value === 0), 'native teardown');
    check(violations.length === 0, 'CSP violation');
}
async function opened(path: string, beforeConnect = ticket, signal?: AbortSignal) {
    const states: SyncStateInfo[] = [];
    const db = await Lattice.open(path, [AdmissionNote], { sync: { websocketUrl: endpoint, authToken: '', beforeConnect, signal },
        onSyncState: info => states.push(info) });
    return { db, states };
}
const gate = {
    async run() {
        await Lattice.setLogLevel(LogLevel.Off);
        check(getWasmModule().syncAdmissionVersion?.() === 1, 'New admitted native artifact is required');
        // Named MEMFS fixture bypasses OPFS; reopening still retains the actual SQLite cursor.
        const store = ':memory:browser-admission-reopen';
        const first = await opened(store);
        try {
            await until(() => first.states.some(state => state.state === 'open'), 'first admitted connection');
            await until(async () => await first.db.count(AdmissionNote) === 1, 'actual received fixture row');
            const before = await stats();
            let refused = false;
            try { await opened(store); } catch (error) { refused = /one live Lattice owner/.test(String(error)); }
            check(refused, 'Second admitted owner must refuse');
            check((await stats()).upgrades === before.upgrades, 'Refused owner attempted an upgrade');
            // Raw legacy opens cannot steal or alias the same native sync owner either.
            const module = getWasmModule();
            const raw = module._openVersioned(store, [], endpoint, '', 1, null);
            check(raw.ok === false && /one live Lattice owner/.test(raw.error), 'Legacy owner bypassed admitted path guard');
            const alias = module._openVersioned('./' + store, [], endpoint, '', 1, null);
            check(alias.ok === false && /one live Lattice owner/.test(alias.error), 'MEMFS alias bypassed admitted path guard');
            // Real OPFS alias restore must refuse before truncating the live MEMFS file.
            const opfs = await navigator.storage.getDirectory();
            const snapshots = await opfs.getDirectoryHandle('lattice-snapshots', { create: true });
            const aliasPath = './' + store;
            const safeName = aliasPath.replace(/[^a-z0-9._-]/gi, '_');
            const saved = await snapshots.getFileHandle(safeName, { create: true });
            const writer = await saved.createWritable(); await writer.write(new Uint8Array([1, 2, 3])); await writer.close();
            let restoreRefused = false;
            try { await Lattice.open(aliasPath, [AdmissionNote]); } catch (error) { restoreRefused = /one live Lattice owner/.test(String(error)); }
            check(restoreRefused && await first.db.count(AdmissionNote) === 1, 'Legacy alias restore damaged the live admitted store');
            await snapshots.removeEntry(safeName);
            const uri = module._openVersioned('file:' + store, [], endpoint, '', 1, null);
            check(uri.ok === false && /file: URI/.test(uri.error), 'SQLite URI alias bypassed admitted path guard');
        } finally { await first.db.close(); }
        await released();
        // The browser still holds the consumed HttpOnly cookie. A bare repeat
        // upgrade must fail; only the next admitted open can obtain a new one.
        await new Promise<void>((resolve, reject) => {
            const replay = new WebSocket(endpoint);
            replay.addEventListener('open', () => { replay.close(); reject(new Error('Consumed ticket was reused')); });
            replay.addEventListener('error', () => {});
            replay.addEventListener('close', () => resolve(), { once: true });
        });
        check((await stats()).rejectedUpgrades === 1, 'Consumed ticket was not refused');
        const second = await opened(store);
        try { await until(() => second.states.some(state => state.state === 'open'), 'reopened admitted connection'); }
        finally { await second.db.close(); }
        await released();
        const resumed = await stats();
        check(resumed.tickets === 2 && resumed.upgrades === 2, 'Every upgrade needs its own ticket');
        check(resumed.resumeCursors === 1, 'Actual Core resume cursor was not preserved');
        check(attemptContexts[0].instanceId !== attemptContexts[1].instanceId, 'Reopen reused a retired owner identity');
        check(!cookieReadableAtEndpoint(), 'HttpOnly admission cookie leaked to JavaScript at matching cookie path');
        checks.push({ name: 'fresh ticket on reopen, actual Core cursor, same-path refusal, HttpOnly isolation' });

        const beforeFailure = await stats();
        const failed = await opened(':memory:admission-refused', context => ticket(context, 'refused'));
        try { await until(() => failed.states.some(state => state.state === 'closed'), 'refused admission'); }
        finally { await failed.db.close(); }
        await released();
        check((await stats()).upgrades === beforeFailure.upgrades, 'Refused admission constructed a WebSocket');
        checks.push({ name: 'failed ticket never constructs transport' });

        let finish!: () => void;
        const waiting = new Promise<void>(resolve => { finish = resolve; });
        let captured: SyncAdmissionContext | null = null;
        const delayed = await opened(':memory:admission-late', async context => { captured = context; await waiting; });
        const closing = delayed.db.close();
        check(captured !== null && (captured as SyncAdmissionContext).signal.aborted, 'Close did not cancel pending admission synchronously');
        finish(); await closing; await released();
        check((await stats()).upgrades === beforeFailure.upgrades, 'Late admission resurrected a closed owner');
        checks.push({ name: 'close cancels pending admission; late completion is inert' });

        const controller = new AbortController();
        const revoked = await opened(':memory:admission-revoke', ticket, controller.signal);
        try {
            await until(() => revoked.states.some(state => state.state === 'open'), 'pre-revocation connection');
            controller.abort();
            await until(() => revoked.states.some(state => state.state === 'closed'), 'external revocation');
        } finally { await revoked.db.close(); }
        await released();
        check(attemptContexts.every(context => context.signal.aborted), 'Attempt retained a live cancellation scope');
        checks.push({ name: 'external revocation closes admitted transport and native owners release' });
        const final = await stats();
        check(final.upgrades === 3 && final.rejectedUpgrades === 1, 'Unexpected upgrade or retry');
        check(final.authorizationHeaders === 0 && final.credentialQueries === 0, 'Credentials reached the upgrade URL/header');
        return { checks, stats: final, violations, diagnostics: getWasmModule()._lifecycleDiagnostics(),
            contextCount: attemptContexts.length, cookieReadable: cookieReadableAtEndpoint() };
    },
};
Object.assign(window, { admissionGate: gate });
