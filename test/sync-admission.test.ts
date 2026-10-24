import { describe, expect, it, vi } from 'vitest';
import { SyncAdmissionOwner, validateSyncAdmission } from '../src/sync-admission';
import type { SyncAdmissionContext } from '../src/types';

const url = 'wss://companion.test/browser/sync';
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function deferred() {
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
class Socket extends EventTarget {
    readyState = 0;
    binaryType = 'blob';
    sent: unknown[] = [];
    close = vi.fn(() => { this.readyState = 3; });
    send(data: unknown) { this.sent.push(data); }
    fire(type: string, values = {}) {
        const event = new Event(type);
        for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
        if (type === 'open') this.readyState = 1;
        this.dispatchEvent(event);
    }
}
function setup(beforeConnect: (context: SyncAdmissionContext) => Promise<void>, signal?: AbortSignal) {
    const sockets: Socket[] = [];
    const factory = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const owner = new SyncAdmissionOwner({ websocketUrl: url, authToken: '', beforeConnect, signal }, 'owner-a', factory);
    return { owner, factory, sockets };
}

describe('per-owner sync admission', () => {
    it('waits for admission before constructing a socket and passes a frozen attempt context', async () => {
        const admission = deferred(), calls: SyncAdmissionContext[] = [];
        const { owner, factory, sockets } = setup(context => { calls.push(context); return admission.promise; });
        const transport = owner.createSocket(url);
        expect(calls).toHaveLength(0);
        await tick();
        expect(calls[0]).toMatchObject({ websocketUrl: url, instanceId: 'owner-a', connectionGeneration: 1 });
        expect(Object.isFrozen(calls[0])).toBe(true);
        expect(factory).not.toHaveBeenCalled();
        admission.resolve(); await tick();
        expect(factory).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledWith(url);
        expect(sockets[0].binaryType).toBe('arraybuffer');
        const opened = vi.fn(); transport.addEventListener('open', opened);
        sockets[0].fire('open');
        expect(opened).toHaveBeenCalledOnce(); expect(transport.readyState).toBe(1);
        owner.dispose();
    });

    it('preserves only a bounded Core resume cursor while admitting the stable endpoint', async () => {
        const calls: SyncAdmissionContext[] = [];
        const { owner, factory } = setup(async context => { calls.push(context); });
        const resumed = url + '?last-event-id=7f432120-29b1-4826-94f4-e22ad59e2ba7';
        const socket = owner.createSocket(resumed); await tick();
        expect(socket.url).toBe(resumed); expect(calls[0].websocketUrl).toBe(url);
        expect(factory).toHaveBeenCalledWith(resumed);
        for (const bad of [url + '?token=secret', url + '?last-event-id=a&last-event-id=b',
            url + '?last-event-id=a&token=x', url + '?last-event-id=', url + '#fragment',
            url + '?last-event-id=' + 'x'.repeat(257), url + '?last-event-id=%26token=x',
            url.replace('companion.test', 'other.test'), url + '/other']) {
            expect(() => owner.createSocket(bad)).toThrow(/URL/);
        }
        expect(socket.readyState).toBe(0); // Invalid attempts do not retire the valid attempt.
        owner.dispose();
    });

    it('requests a fresh generation for every attempt without reusing settled admission', async () => {
        const calls: SyncAdmissionContext[] = [];
        const { owner, sockets } = setup(async context => { calls.push(context); });
        const first = owner.createSocket(url); await tick();
        const second = owner.createSocket(url); await tick();
        expect(first.readyState).toBe(3); expect(second.readyState).toBe(0);
        expect(calls.map(call => call.connectionGeneration)).toEqual([1, 2]);
        expect(calls[0].signal.aborted).toBe(true);
        expect(sockets[0].close).toHaveBeenCalledOnce();
        owner.dispose();
    });

    it.each(['resolve', 'reject'] as const)('close cancels pending admission and late %s never constructs', async settle => {
        const admission = deferred(); let signal!: AbortSignal;
        const { owner, factory } = setup(context => { signal = context.signal; return admission.promise; });
        const socket = owner.createSocket(url); await tick();
        const close = vi.fn(); socket.addEventListener('close', close);
        owner.dispose(); owner.dispose();
        expect(signal.aborted).toBe(true); expect(socket.readyState).toBe(3);
        if (settle === 'resolve') admission.resolve(); else admission.reject(new Error('private failure'));
        await tick();
        expect(factory).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
        expect(() => owner.createSocket(url)).toThrow('closed');
    });

    it('superseded admission cannot consume a later generation ticket', async () => {
        const first = deferred(), second = deferred(); let calls = 0;
        const { owner, factory } = setup(() => ++calls === 1 ? first.promise : second.promise);
        owner.createSocket(url); await tick(); owner.createSocket(url); await tick();
        first.resolve(); await tick(); expect(factory).not.toHaveBeenCalled();
        second.resolve(); await tick(); expect(factory).toHaveBeenCalledOnce(); owner.dispose();
    });

    it('cannot resurrect an owner disposed reentrantly during old socket retirement', async () => {
        const hook = vi.fn(async () => {});
        const { owner, factory } = setup(hook);
        const first = owner.createSocket(url); await tick();
        first.addEventListener('close', () => owner.dispose());
        expect(() => owner.createSocket(url)).toThrow(/closed/);
        await tick(); expect(hook).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce();
        expect(first.readyState).toBe(3);
    });

    it('does not overwrite a newer attempt created reentrantly by the old close listener', async () => {
        const { owner, factory } = setup(async () => {});
        const first = owner.createSocket(url); await tick();
        let replacement: ReturnType<typeof owner.createSocket> | undefined;
        first.addEventListener('close', () => { replacement = owner.createSocket(url); });
        expect(() => owner.createSocket(url)).toThrow(/superseded/);
        await tick(); expect(factory).toHaveBeenCalledTimes(2); expect(replacement?.readyState).toBe(0);
        owner.dispose(); expect(replacement?.readyState).toBe(3);
    });

    it('external revocation closes only its owner and removes its abort listener', async () => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const a = setup(async () => {}, controller.signal), b = setup(async () => {});
        a.owner.createSocket(url); b.owner.createSocket(url); await tick();
        controller.abort();
        expect(a.sockets[0].close).toHaveBeenCalledOnce(); expect(b.sockets[0].close).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        b.owner.dispose();
    });

    it.each([
        () => { throw new Error('sensitive server response'); },
        () => Promise.reject(new Error('sensitive server response')),
        () => undefined,
        () => Promise.resolve('secret'),
    ])('admission failure constructs nothing and emits only a fixed failure', async callback => {
        const { owner, factory } = setup(callback as () => Promise<void>);
        const socket = owner.createSocket(url), events: unknown[] = [];
        socket.addEventListener('error', () => events.push('error'));
        socket.addEventListener('close', event => events.push([(event as CloseEvent).code, (event as CloseEvent).reason]));
        await tick();
        expect(factory).not.toHaveBeenCalled(); expect(events).toEqual(['error', [1008, 'sync admission failed']]);
        owner.dispose();
    });

    it('forwards native data and detaches old events on disposal', async () => {
        const { owner, sockets } = setup(async () => {});
        const transport = owner.createSocket(url); await tick();
        const messages: unknown[] = []; transport.addEventListener('message', event => messages.push((event as MessageEvent).data));
        sockets[0].fire('open'); const bytes = new Uint8Array([1, 2]);
        transport.send(bytes); sockets[0].fire('message', { data: bytes.buffer });
        expect(sockets[0].sent).toEqual([bytes]); expect(messages).toEqual([bytes.buffer]);
        owner.dispose(); sockets[0].fire('message', { data: 'late' });
        expect(messages).toHaveLength(1); expect(() => transport.send('late')).toThrow('not open');
    });

    it('closes a socket when configuration fails after construction', async () => {
        const socket = new Socket();
        Object.defineProperty(socket, 'binaryType', { set() { throw new Error('unsupported'); } });
        const owner = new SyncAdmissionOwner({ websocketUrl: url, beforeConnect: async () => {} }, 'a', () => socket as unknown as WebSocket);
        const transport = owner.createSocket(url); await tick();
        expect(transport.readyState).toBe(3); expect(socket.close).toHaveBeenCalledOnce(); owner.dispose();
    });

    it('rejects credential URLs, bearer tokens, missing hooks, and pre-aborted lifetimes', () => {
        for (const websocketUrl of [`${url}?token=private`, `${url}#private`, 'wss://u:p@companion.test/browser/sync', 'https://companion.test/browser/sync']) {
            expect(() => validateSyncAdmission({ websocketUrl, beforeConnect: async () => {} })).toThrow();
        }
        expect(() => validateSyncAdmission({ websocketUrl: url, authToken: 'private', beforeConnect: async () => {} })).toThrow('empty');
        expect(() => validateSyncAdmission({ websocketUrl: url, signal: new AbortController().signal })).toThrow('beforeConnect');
        const controller = new AbortController(); controller.abort();
        expect(() => setup(async () => {}, controller.signal)).toThrow('cancelled');
        expect(() => validateSyncAdmission({ websocketUrl: `${url}?token=legacy`, authToken: 'legacy' })).not.toThrow();
    });
});
