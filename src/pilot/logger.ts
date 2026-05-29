import { AsyncLocalStorage } from 'node:async_hooks';

/* ------------------------------------------------------------------ */
/*  Log levels                                                         */
/* ------------------------------------------------------------------ */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/* ------------------------------------------------------------------ */
/*  Log entry shape                                                    */
/* ------------------------------------------------------------------ */

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
  error?: { message: string; stack?: string };
  requestId?: string;
}

/* ------------------------------------------------------------------ */
/*  Request-ID context (AsyncLocalStorage)                             */
/* ------------------------------------------------------------------ */

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string {
  return requestContext.getStore()?.requestId ?? 'unknown';
}

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

export async function withRequestIdAsync<T>(
  requestId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return requestContext.run({ requestId }, fn);
}

/* ------------------------------------------------------------------ */
/*  Global level control                                               */
/* ------------------------------------------------------------------ */

let globalLevel: LogLevel | undefined;

export function setGlobalLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/* ------------------------------------------------------------------ */
/*  Logger class                                                       */
/* ------------------------------------------------------------------ */

class PilotLogger {
  private readonly module: string;

  constructor(module: string) {
    this.module = module;
  }

  /* ---- internal -------------------------------------------------- */

  private shouldLog(level: LogLevel): boolean {
    const effective = globalLevel ?? LogLevel.INFO;
    return level >= effective;
  }

  private format(level: LogLevel, message: string, data?: Record<string, unknown>, error?: Error): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      requestId: getRequestId(),
    };
    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }
    if (error) {
      entry.error = { message: error.message, stack: error.stack };
    }
    return entry;
  }

  private write(entry: LogEntry): void {
    const prefix = `[${entry.timestamp}] [${LogLevel[entry.level]}] [${entry.module}]`;

    // Use the appropriate console method based on level.
    switch (entry.level) {
      case LogLevel.ERROR: {
        const args: unknown[] = [prefix, entry.message];
        if (entry.data) args.push(entry.data);
        if (entry.error) args.push(entry.error);
        console.error(...args);
        break;
      }
      case LogLevel.WARN: {
        const args: unknown[] = [prefix, entry.message];
        if (entry.data) args.push(entry.data);
        console.warn(...args);
        break;
      }
      case LogLevel.DEBUG: {
        const args: unknown[] = [prefix, entry.message];
        if (entry.data) args.push(entry.data);
        console.debug(...args);
        break;
      }
      default: {
        const args: unknown[] = [prefix, entry.message];
        if (entry.data) args.push(entry.data);
        console.log(...args);
        break;
      }
    }
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>, error?: Error): void {
    if (!this.shouldLog(level)) return;
    const entry = this.format(level, message, data, error);
    this.write(entry);
  }

  /* ---- public API ------------------------------------------------ */

  debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, data, error);
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createLogger(module: string): PilotLogger {
  return new PilotLogger(module);
}
