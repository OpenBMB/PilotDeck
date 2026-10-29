/** Consume fetch SSE incrementally; JSON remains supported for older servers. */
export async function readSearchResponse<T>(response: Response, onSnapshot: (value: T) => void, signal: AbortSignal): Promise<T> {
  if (!response.ok) throw new Error('Search failed');
  if (!response.headers?.get('content-type')?.includes('text/event-stream') || !response.body) {
    const result = await response.json() as T;
    signal.throwIfAborted(); onSnapshot(result); return result;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', latest: T | undefined, complete = false;
  const abort = () => { void reader.cancel(); };
  signal.addEventListener('abort', abort, { once: true });
  const consume = () => {
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const value = JSON.parse(data);
      if (event === 'error') throw new Error(value.error || 'Search failed');
      if (event === 'snapshot' || event === 'done') {
        signal.throwIfAborted(); latest = value; onSnapshot(value);
        if (event === 'done') complete = true;
      }
    }
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // Our server emits LF. Normalize CRLF as well, retaining a split trailing CR.
      buffer = buffer.replace(/\r\n/g, '\n'); consume();
      if (done) break;
    }
    signal.throwIfAborted();
    if (!complete || latest === undefined) throw new Error('Incomplete search response');
    return latest;
  } finally { signal.removeEventListener('abort', abort); void reader.cancel(); reader.releaseLock(); }
}
