/** Stop awaiting cooperative or legacy preparation work without retaining listeners. */
export async function awaitWithAbort<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
      operation(),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
