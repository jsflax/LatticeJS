import type { SyncAdmissionContext, SyncConfiguration } from './types';

type SocketFactory = (url: string) => WebSocket;

function socketEvent(type: string, values: Record<string, unknown> = {}): Event {
    const event = new Event(type);
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
    return event;
}

/** A transport attempt retains no native pointer in its asynchronous continuations. */
class AdmittedSocket extends EventTarget {
    readonly url: string;
    readyState = 0;
    _lattice_client = 0;
    binaryType: BinaryType = 'arraybuffer';
    private socket: WebSocket | null = null;
    private readonly controller = new AbortController();
    private detach: (() => void) | null = null;
    private retired = false;

    constructor(
        context: Omit<SyncAdmissionContext, 'signal'>,
        beforeConnect: NonNullable<SyncConfiguration['beforeConnect']>,
        private readonly makeSocket: SocketFactory,
        private readonly onRetire: () => void,
        attemptUrl: string,
    ) {
        super();
        this.url = attemptUrl;
        const attempt = Object.freeze({ ...context, signal: this.controller.signal });
        void Promise.resolve().then(async () => {
            if (this.retired) return;
            const admitted = beforeConnect(attempt);
            if (!admitted || typeof admitted.then !== 'function') throw new TypeError('beforeConnect must return a Promise');
            const result = await admitted;
            if (this.retired || this.controller.signal.aborted) return;
            if (result !== undefined) throw new TypeError('beforeConnect must resolve without a value');
            const socket = this.makeSocket(this.url);
            // A test factory or host shim may dispose the owner reentrantly.
            if (this.retired) { socket.close(1000, 'lattice admission cancelled'); return; }
            this.socket = socket;
            socket.binaryType = this.binaryType;
            const open = () => {
                if (this.retired || this.socket !== socket) return;
                this.readyState = 1;
                this.dispatchEvent(socketEvent('open'));
            };
            const message = (event: MessageEvent) => {
                if (!this.retired && this.socket === socket) this.dispatchEvent(socketEvent('message', { data: event.data }));
            };
            const error = () => {
                if (!this.retired && this.socket === socket) this.dispatchEvent(socketEvent('error'));
            };
            const close = (event: CloseEvent) => this.finish(event.code, event.reason, event.wasClean);
            socket.addEventListener('open', open);
            socket.addEventListener('message', message);
            socket.addEventListener('error', error);
            socket.addEventListener('close', close);
            this.detach = () => {
                socket.removeEventListener('open', open);
                socket.removeEventListener('message', message);
                socket.removeEventListener('error', error);
                socket.removeEventListener('close', close);
            };
        }).catch(() => {
            if (this.retired) return;
            const socket = this.socket;
            this.dispatchEvent(socketEvent('error'));
            this.finish(1008, 'sync admission failed', false);
            try { socket?.close(1000, 'sync admission failed'); } catch { /* Retired locally. */ }
        });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (this.retired || this.readyState !== 1 || !this.socket) throw new Error('Sync transport is not open');
        this.socket.send(data);
    }

    close(code = 1000, reason = 'lattice admission cancelled'): void {
        if (this.retired) return;
        const socket = this.socket;
        this.finish(code, reason, true);
        try { socket?.close(code, reason); } catch { /* The local attempt is already retired. */ }
    }

    private finish(code: number, reason: string, wasClean: boolean): void {
        if (this.retired) return;
        this.retired = true;
        this.controller.abort();
        this.detach?.(); this.detach = null;
        this.socket = null;
        this.readyState = 3;
        this.onRetire();
        this.dispatchEvent(socketEvent('close', { code, reason, wasClean }));
    }
}

export function validateSyncAdmission(config: SyncConfiguration | undefined): void {
    if (!config || (config.beforeConnect === undefined && config.signal === undefined)) return;
    if (typeof config.beforeConnect !== 'function') throw new TypeError('Sync signal requires beforeConnect');
    if (config.authToken !== undefined && config.authToken !== '') throw new TypeError('Admitted sync requires an empty authToken');
    const url = new URL(config.websocketUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new TypeError('Admitted sync requires a stable WebSocket URL without credentials, query, or fragment');
    }
    if (config.signal !== undefined && !(config.signal instanceof AbortSignal)) throw new TypeError('Sync signal must be an AbortSignal');
    if (config.signal?.aborted) throw new Error('Sync admission cancelled');
}

/** One native scheduler owns one controller; no URL or global callback registry. */
export class SyncAdmissionOwner {
    private generation = 0;
    private disposed = false;
    private current: AdmittedSocket | null = null;
    private readonly beforeConnect: NonNullable<SyncConfiguration['beforeConnect']>;
    private readonly externalSignal?: AbortSignal;
    private readonly externalAbort = () => this.dispose();
    private readonly url: string;

    constructor(
        config: SyncConfiguration,
        private readonly instanceId: string,
        private readonly makeSocket: SocketFactory = url => new WebSocket(url),
    ) {
        validateSyncAdmission(config);
        if (!config.beforeConnect) throw new TypeError('Missing beforeConnect');
        this.url = config.websocketUrl;
        this.beforeConnect = config.beforeConnect;
        this.externalSignal = config.signal;
        this.externalSignal?.addEventListener('abort', this.externalAbort, { once: true });
    }

    readonly createSocket = (url: string): AdmittedSocket => {
        if (this.disposed) throw new Error('Sync admission owner is closed');
        // Core emits an unescaped UUID audit cursor. Preserve its resume semantics,
        // while rejecting arbitrary query keys, duplicates, fragments and credentials.
        const suffix = url.startsWith(this.url) ? url.slice(this.url.length) : null;
        if (suffix !== '' && (suffix === null || !/^\?last-event-id=[A-Za-z0-9._~:-]{1,256}$/.test(suffix))) {
            throw new Error('Sync admission URL changed or resume cursor is invalid');
        }
        const previousGeneration = this.generation;
        this.current?.close();
        // Retirement delivers close synchronously; listeners may revoke this
        // owner or start a newer attempt before control returns here.
        if (this.disposed) throw new Error('Sync admission owner is closed');
        if (this.generation !== previousGeneration) throw new Error('Sync admission attempt was superseded during retirement');
        let socket: AdmittedSocket;
        socket = new AdmittedSocket({ websocketUrl: this.url, instanceId: this.instanceId,
            connectionGeneration: ++this.generation }, this.beforeConnect, this.makeSocket,
        () => { if (this.current === socket) this.current = null; }, url);
        this.current = socket;
        return socket;
    };

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.externalSignal?.removeEventListener('abort', this.externalAbort);
        this.current?.close();
        this.current = null;
    }
}
