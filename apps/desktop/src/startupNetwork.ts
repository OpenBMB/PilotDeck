import net from 'node:net';

function probePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => {});
      reject(error);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error('Loopback port probe timed out'), { code: 'ETIMEDOUT' })), 2_000);
    server.once('error', fail);
    server.once('listening', () => {
      if (settled) { server.close(); return; }
      const address = server.address();
      if (!address || typeof address === 'string') { fail(new Error('Loopback port was not assigned')); return; }
      settled = true;
      clearTimeout(timer);
      server.close(error => error ? reject(error) : resolve(address.port));
    });
    try { server.listen(port, '127.0.0.1'); } catch (error) { fail(error as Error); }
  });
}

/** Prefer the usual port, then let Windows avoid occupied/excluded port ranges. */
export async function findFreePort(preferred: number, excluded: readonly number[] = [], probe = probePort): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 0 || preferred > 65535) throw new RangeError('Invalid runtime port');
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const port = await probe(attempt === 0 && !excluded.includes(preferred) ? preferred : 0);
      if (!excluded.includes(port)) return port;
      lastError = Object.assign(new Error('Port already reserved for another runtime'), { code: 'EADDRINUSE' });
    } catch (error) {
      lastError = error;
      if (!['EADDRINUSE', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) break;
    }
  }
  const code = (lastError as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
  throw Object.assign(new Error(`Cannot reserve a local runtime port on 127.0.0.1 (${code}). Check the runtime log for details.`, { cause: lastError }), { code });
}
