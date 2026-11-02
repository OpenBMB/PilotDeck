export function resolveConfigHome(env?: Record<string,string|undefined>): string;
export function classifyRuntimeError(error: unknown,evidence?: string,status?: number): string;
export function redactDiagnostic(value: unknown): string;
export function registerDiagnosticSecrets(value: unknown): void;
export const LOG_RETENTION_DAYS: readonly number[];
export function normalizeLogRetentionDays(value: unknown): number;
export function setRuntimeLogRetention(value: unknown): number;
export type RuntimeLogWriter = { write(text: string): boolean; setRetentionDays(value: unknown): void; close(): void };
export function createRuntimeLogWriter(logPath: string, options?: { retentionDays?: unknown; now?: () => Date }): RuntimeLogWriter;
