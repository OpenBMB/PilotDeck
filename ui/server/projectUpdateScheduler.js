/** Debounce file events without losing changes that arrive during a scan. */
export function createProjectUpdateScheduler({ scan, publish, onError, debounceMs = 300 }) {
    let timer = null;
    let pending = null;
    let running = false;
    let disposed = false;

    async function run() {
        if (disposed || running || pending === null) return;
        const change = pending;
        pending = null;
        running = true;
        try {
            const snapshot = await scan();
            if (!disposed) publish(snapshot, change);
        } catch (error) {
            if (!disposed) onError(error);
        } finally {
            running = false;
            // If the debounce already expired during the scan, drain the
            // accumulated change now. Otherwise let its timer finish first.
            if (!disposed && pending !== null && timer === null) void run();
        }
    }

    return {
        schedule(change) {
            if (disposed) return;
            pending = change;
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                void run();
            }, debounceMs);
        },
        dispose() {
            disposed = true;
            pending = null;
            if (timer !== null) clearTimeout(timer);
            timer = null;
        },
    };
}
