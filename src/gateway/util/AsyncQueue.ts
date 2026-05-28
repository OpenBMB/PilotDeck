/**
 * Minimal single-producer-multi-(or single-)consumer FIFO queue with an
 * async iterator surface. Used by `InProcessGateway.submitTurn` to fan-in
 * events from two sources:
 *   1. The agent session's event stream (mapped through `mapAgentEvent`).
 *   2. The elicitation channel's downstream emits (B1).
 *
 * Closing the queue terminates the iterator; pending `dequeue()` resolves
 * to `{ done: true }`. Pushing after close is a no-op.
 */
export class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  private closed = false;
  private error: Error | undefined;

  enqueue(value: T): void {
    if (this.closed) return;
    if (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  fail(error: Error): void {
    this.error = error;
    this.closed = true;
    // Reject all pending waiters with the error
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.error) {
          const err = this.error;
          this.error = undefined;
          return Promise.reject(err);
        }
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
