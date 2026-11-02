import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const MAX_STDERR_CHARS = 16_384;
const MAX_EXCERPT_CHARS = 4_000;
const MAX_REPORT_CHARS = 1_048_576;

export function runtimeReportDirectory(logPath: string): string {
  return path.join(path.dirname(logPath), 'diagnostics');
}

// Set these before loading the CLI: a fatal error can happen during imports,
// before any JavaScript initialization or exception handler has run.
export function runtimeReportArguments(): string[] {
  return [
    '--report-on-fatalerror',
    '--report-exclude-env',
    '--report-compact',
    // Node 22's native report writer cannot open some Unicode paths on Windows.
    // The healthy parent persists this stream using Node's Unicode-aware fs API.
    '--report-filename=stderr',
  ];
}

export class RuntimeProcessDiagnostics {
  readonly id = randomUUID();
  private readonly decoder = new StringDecoder('utf8');
  private stderr = '';
  private fatalLine = '';
  private partialLine = '';
  private reportPath = '';
  private reportError = '';
  private phase: 'startup' | 'running' = 'startup';

  constructor(private readonly name: string, private readonly logPath: string) {}

  captureStderr(chunk: Buffer): void {
    const lines = (this.partialLine + this.decoder.write(chunk)).split('\n');
    this.partialLine = lines.pop() ?? '';
    if (this.partialLine.length > MAX_REPORT_CHARS) {
      this.partialLine = this.partialLine.slice(-MAX_STDERR_CHARS);
    }
    const ordinary = lines.filter(line => !this.saveReport(line));
    const text = this.stderr + ordinary.map(line => `${line}\n`).join('');
    const fatal = text.match(/(?:FATAL ERROR:|Assertion failed:|Check failed:|# Fatal error in )[^\r\n]*/i)?.[0];
    this.fatalLine = fatal?.slice(0, 1_000) ?? this.fatalLine;
    this.stderr = text.slice(-MAX_STDERR_CHARS);
  }

  private saveReport(line: string): boolean {
    if (!line.startsWith('{"header":') || line.length > MAX_REPORT_CHARS) return false;
    let report: { header?: { nodejsVersion?: string }; javascriptHeap?: unknown };
    try { report = JSON.parse(line); } catch { return false; }
    if (typeof report?.header?.nodejsVersion !== 'string' || !report.javascriptHeap) return false;
    try {
      const directory = runtimeReportDirectory(this.logPath);
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${this.name}-${this.id}.json`);
      fs.writeFileSync(file, `${line}\n`, { mode: 0o600 });
      this.reportPath = file;
    } catch (error) {
      // The original stderr stream is also written to runtime.log by the owner.
      this.reportError = `Could not save separate fatal report: ${String(error)}`;
    }
    return true;
  }

  markReady(): void {
    this.phase = 'running';
  }

  exited(code: number | null, signal: string | null, startupError?: string): string {
    return this.failure([
      `${this.name} exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      startupError,
    ].filter(Boolean).join('\n'));
  }

  failure(detail: string): string {
    const stderr = this.stderr + this.partialLine;
    const evidence = `${this.fatalLine}\n${stderr}`;
    // Exit 134 alone does not distinguish OOM from aborts/assertions, notably
    // on Windows. Classify only when the child actually reported the cause.
    const oom = /FATAL ERROR:[^\r\n]*(?:heap out of memory|process out of memory)/i.test(evidence);
    const assertion = /Assertion failed:|Check failed:|# Fatal error in /i.test(evidence);
    const category = oom ? 'OUT_OF_MEMORY' : assertion ? 'NATIVE_FAILURE' : 'PROCESS_FAILED';
    const cause = oom ? 'Node.js ran out of memory.'
      : assertion ? 'The runtime reported a native fatal error or assertion.' : '';
    const fatal = this.fatalLine.slice(0, 1_000);
    const tail = stderr.trim().slice(-MAX_EXCERPT_CHARS);
    const excerpt = fatal && !tail.includes(fatal) ? `${fatal}\n…\n${tail}` : tail;
    return redactDiagnostic([
      `[${this.name.toUpperCase()}_${category}] phase=${this.phase} diagnostic=${this.id}`,
      detail,
      cause,
      excerpt,
      this.reportError,
      `Runtime log: ${this.logPath}`,
      this.reportPath ? `Fatal report: ${this.reportPath}` : '',
    ].filter(Boolean).join('\n'));
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(Bearer\s+)[\w.+/~=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'\r\n]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}
