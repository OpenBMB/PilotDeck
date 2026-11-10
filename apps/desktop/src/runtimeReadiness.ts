import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { clearTimeout, setTimeout } from 'node:timers';

/** Own every readiness probe until success, process failure, cancellation or timeout. */
export function waitForPortOrProcessExit(
  child: ChildProcess,
  name: string,
  port: number,
  host: string,
  timeoutMs: number,
  logPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: net.Socket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const disposeSocket = () => {
      const current = socket;
      socket = undefined;
      current?.off('connect', onConnect);
      current?.off('error', onSocketError);
      current?.destroy();
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(retry);
      clearTimeout(deadline);
      disposeSocket();
      child.off('managed-exit', onExit);
      child.off('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onConnect = () => finish();
    const onSocketError = () => {
      if (settled) return;
      disposeSocket();
      retry = setTimeout(attempt, 250);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null, startupError?: string) => finish(new Error(
      startupError || `${name} exited before it was ready (code=${code ?? 'null'} signal=${signal ?? 'null'}). See runtime log: ${logPath}`,
    ));
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(options.signal!.reason);
    const attempt = () => {
      retry = undefined;
      if (settled) return;
      try {
        socket = net.createConnection({ host, port });
        socket.once('connect', onConnect);
        socket.once('error', onSocketError);
      } catch (error) { finish(error); }
    };

    if (options.signal?.aborted) { onAbort(); return; }
    if (typeof child.exitCode === 'number' || child.signalCode) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once('managed-exit', onExit);
    child.once('error', onError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    deadline = setTimeout(() => finish(new Error(`Timed out waiting for ${host}:${port}`)), timeoutMs);
    attempt();
  });
}
