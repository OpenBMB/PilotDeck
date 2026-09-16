import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectUpdateScheduler } from './projectUpdateScheduler.js';

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('project update scheduling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('debounces a burst into one scan with the latest change', async () => {
        const scan = vi.fn().mockResolvedValue('snapshot');
        const publish = vi.fn();
        const scheduler = createProjectUpdateScheduler({ scan, publish, onError: vi.fn() });
        scheduler.schedule('a');
        await vi.advanceTimersByTimeAsync(200);
        scheduler.schedule('b');
        await vi.advanceTimersByTimeAsync(299);
        expect(scan).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(scan).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith('snapshot', 'b');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('coalesces changes during each scan and drains them without overlapping scans', async () => {
        const first = deferred();
        const second = deferred();
        const scan = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue('third');
        const publish = vi.fn();
        const scheduler = createProjectUpdateScheduler({ scan, publish, onError: vi.fn() });
        scheduler.schedule('a');
        await vi.advanceTimersByTimeAsync(300);
        scheduler.schedule('b');
        scheduler.schedule('c');
        await vi.advanceTimersByTimeAsync(300);
        expect(scan).toHaveBeenCalledTimes(1);
        first.resolve('first');
        await vi.advanceTimersByTimeAsync(0);
        expect(scan).toHaveBeenCalledTimes(2);
        scheduler.schedule('d');
        await vi.advanceTimersByTimeAsync(300);
        expect(scan).toHaveBeenCalledTimes(2);
        second.resolve('second');
        await vi.advanceTimersByTimeAsync(0);
        expect(scan).toHaveBeenCalledTimes(3);
        expect(publish.mock.calls).toEqual([['first', 'a'], ['second', 'c'], ['third', 'd']]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waits for an unexpired debounce when the current scan completes', async () => {
        const first = deferred();
        const scan = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('second');
        const scheduler = createProjectUpdateScheduler({ scan, publish: vi.fn(), onError: vi.fn() });
        scheduler.schedule('a');
        await vi.advanceTimersByTimeAsync(300);
        scheduler.schedule('b');
        await vi.advanceTimersByTimeAsync(100);
        first.resolve('first');
        await vi.advanceTimersByTimeAsync(199);
        expect(scan).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(scan).toHaveBeenCalledTimes(2);
    });

    it('still runs a pending change after the active scan fails', async () => {
        const first = deferred();
        const scan = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('recovered');
        const onError = vi.fn();
        const publish = vi.fn();
        const scheduler = createProjectUpdateScheduler({ scan, publish, onError });
        scheduler.schedule('a');
        await vi.advanceTimersByTimeAsync(300);
        scheduler.schedule('b');
        await vi.advanceTimersByTimeAsync(300);
        const error = new Error('scan failed');
        first.reject(error);
        await vi.advanceTimersByTimeAsync(0);
        expect(onError).toHaveBeenCalledWith(error);
        expect(scan).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenCalledWith('recovered', 'b');
    });

    it('disposes pending work and suppresses publication from an obsolete watcher', async () => {
        const first = deferred();
        const scan = vi.fn().mockReturnValue(first.promise);
        const publish = vi.fn();
        const scheduler = createProjectUpdateScheduler({ scan, publish, onError: vi.fn() });
        scheduler.schedule('a');
        await vi.advanceTimersByTimeAsync(300);
        scheduler.schedule('b');
        scheduler.dispose();
        scheduler.schedule('c');
        first.resolve('obsolete');
        await vi.advanceTimersByTimeAsync(300);
        expect(scan).toHaveBeenCalledTimes(1);
        expect(publish).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
