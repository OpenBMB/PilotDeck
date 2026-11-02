import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { format } from 'node:util';
import { classifyRuntimeError, redactDiagnostic, registerDiagnosticSecrets, resolveConfigHome } from '@pilotdeck/config';

type RuntimeLogging = { logPath: string; report: (error: unknown, phase?: string) => string };
let installed: RuntimeLogging | undefined;
export function installRuntimeLogging(service: string, redactOutput = true): RuntimeLogging {
  if (installed) return installed;
  const logPath = process.env.PILOTDECK_LOG_PATH || path.join(resolveConfigHome(), 'logs', 'runtime.log');
  const captured = process.env.PILOTDECK_LOG_CAPTURED === '1';
  registerDiagnosticSecrets(process.env);
  let writable = !captured;
  if (writable) { try { fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 }); } catch { writable = false; } }
  const append = (message: string) => {
    if (!writable) return;
    try { fs.appendFileSync(logPath, `${new Date().toISOString()} [${service}] ${message.replace(/\u001b\[[0-9;]*m/g, '')}\n`, { mode: 0o600 }); }
    catch { writable = false; }
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const message = redactDiagnostic(format(...args)); append(message);
      if (redactOutput) original(message); else original(...args);
    };
  }
  const report = (error: unknown, phase = 'startup') => {
    const id = randomUUID(), code = classifyRuntimeError(error);
    const chain: string[] = [], seen = new Set<unknown>();
    let current = error;
    while (current && !seen.has(current) && chain.length < 8) {
      seen.add(current);
      chain.push(current instanceof Error ? `${current.stack || current.message}${'code' in current ? `\nOriginal code: ${String(current.code)}` : ''}` : String(current));
      current = current instanceof Error ? current.cause : undefined;
    }
    const detail = redactDiagnostic(chain.length ? chain.join('\nCaused by: ') : error);
    const text = `[${code}] service=${service} phase=${phase} diagnostic=${id}\n${detail}\nRuntime log: ${logPath}${!writable && !captured ? ' (file unavailable; see process stderr)' : ''}`;
    console.error(text); return text;
  };
  process.on('uncaughtExceptionMonitor', error => { report(error, 'uncaught'); });
  installed = { logPath, report };
  return installed;
}
