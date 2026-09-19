import { describe, expect, it } from 'vitest';
import { InstanceSyncState, type TrackedSyncSocket } from '../src/sync-socket';
import type { SyncStateInfo } from '../src/types';

class Socket implements TrackedSyncSocket {
    readonly url = 'wss://same-host/sync';
    readyState = 0;
    listeners = new Map<string, Set<(event: any) => void>>();
    close() { this.readyState = 3; this.emit('close', { code: 1000, reason: '' }); }
    addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener); this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
    }
    emit(type: string, event: any = {}) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }
}

describe('per-instance sync state', () => {
    it('registers before construction and replays the exact current immutable state', () => {
        const lifecycle = new InstanceSyncState('first', true);
        const states: SyncStateInfo[] = [];
        lifecycle.subscribe(value => states.push(value));
        expect(states).toEqual([{ state: 'connecting', instanceId: 'first', connectionGeneration: 1, code: 0, reason: '' }]);
        const socket = new Socket(); socket.readyState = 1;
        lifecycle.bind(socket);
        const current: SyncStateInfo[] = [];
        lifecycle.subscribe(value => current.push(value));
        expect(current[0]).toBe(states[1]);
        expect(Object.isFrozen(current[0])).toBe(true);
        expect(current[0].state).toBe('open');
    });

    it('does not confuse stores on the same URL or expose another instance identity', () => {
        const first = new InstanceSyncState('a', true), second = new InstanceSyncState('b', true);
        const a = new Socket(), b = new Socket();
        const eventsA: SyncStateInfo[] = [], eventsB: SyncStateInfo[] = [];
        first.subscribe(value => eventsA.push(value)); second.subscribe(value => eventsB.push(value));
        first.bind(a); second.bind(b);
        a.emit('error'); b.emit('close', { code: 1006, reason: '' });
        expect(eventsA.map(value => value.state)).toEqual(['connecting', 'error']);
        expect(eventsB.map(value => value.state)).toEqual(['connecting', 'closed']);
        expect(eventsA.every(value => value.instanceId === 'a')).toBe(true);
        expect(eventsB.every(value => value.instanceId === 'b')).toBe(true);
    });

    it('independently unsubscribes repeated registrations and keeps siblings alive', () => {
        const first = new InstanceSyncState('a', true), second = new InstanceSyncState('b', true);
        const socket = new Socket(); first.bind(socket); second.bind(socket);
        let count = 0, sibling = 0;
        const callback = () => count++;
        const off = first.subscribe(callback); first.subscribe(callback);
        second.subscribe(() => sibling++);
        off(); off(); socket.emit('open');
        expect(count).toBe(3); expect(sibling).toBe(2);
        first.retire(); socket.emit('error');
        expect(count).toBe(3); expect(sibling).toBe(3);
    });

    it('null clears only this instance and no callback starts after retirement', () => {
        const first = new InstanceSyncState('a', true), second = new InstanceSyncState('b', true);
        const socket = new Socket(); first.bind(socket); second.bind(socket);
        let a = 0, b = 0;
        first.subscribe(() => a++); second.subscribe(() => b++);
        first.subscribe(null)(); socket.emit('open');
        expect(a).toBe(1); expect(b).toBe(2);
        second.retire(); second.retire(); socket.emit('error');
        second.subscribe(() => b++);
        expect(b).toBe(2);
    });

    it('reentrant disposal retires the rest of an already-copied delivery list', () => {
        const lifecycle = new InstanceSyncState('a', true), socket = new Socket();
        lifecycle.bind(socket);
        const delivered: string[] = [];
        lifecycle.subscribe(info => { if (info.state === 'open') lifecycle.retire(); });
        lifecycle.subscribe(info => delivered.push(info.state));
        socket.emit('open'); socket.emit('close', { code: 1006 });
        expect(delivered).toEqual(['connecting']);
    });

    it('does not publish stale outer state after a callback triggers a newer event', () => {
        const lifecycle = new InstanceSyncState('a', true), socket = new Socket();
        lifecycle.bind(socket);
        const delivered: string[] = [];
        lifecycle.subscribe(info => { if (info.state === 'open') socket.emit('close', { code: 1006 }); });
        lifecycle.subscribe(info => delivered.push(info.state));
        socket.emit('open');
        expect(delivered).toEqual(['connecting', 'closed']);
    });

    it('rejects stale socket events after rebinding and advances generation', () => {
        const lifecycle = new InstanceSyncState('a', true), first = new Socket(), next = new Socket();
        const events: SyncStateInfo[] = []; lifecycle.subscribe(info => events.push(info));
        lifecycle.bind(first);
        const queued = [...first.listeners.get('error')!];
        next.readyState = 1; lifecycle.bind(next);
        for (const callback of queued) callback({});
        expect(events.at(-1)?.state).toBe('open');
        expect(events.at(-1)?.connectionGeneration).toBe(2);
    });

    it.each([0, 1])('publishes a same-state replacement generation (readyState %i)', readyState => {
        const lifecycle = new InstanceSyncState('a', true), first = new Socket(), next = new Socket();
        first.readyState = readyState; next.readyState = readyState;
        const events: SyncStateInfo[] = []; lifecycle.subscribe(info => events.push(info));
        lifecycle.bind(first);
        const queued = [...first.listeners.get('error')!];
        const count = events.length;
        lifecycle.bind(next);
        expect(events).toHaveLength(count + 1);
        expect(events.at(-1)).toMatchObject({ state: readyState === 1 ? 'open' : 'connecting', connectionGeneration: 2 });
        for (const callback of queued) callback({});
        expect(events).toHaveLength(count + 1);
    });

    it('isolates callback exceptions and reports absent sync without a connection generation', () => {
        const off = new InstanceSyncState('off', false); const values: SyncStateInfo[] = [];
        off.subscribe(() => { throw new Error('consumer'); });
        off.subscribe(value => values.push(value));
        off.bind(null);
        expect(values).toEqual([{ state: 'closed', instanceId: 'off', connectionGeneration: 0, code: 0, reason: 'sync-not-configured' }]);
    });
});
