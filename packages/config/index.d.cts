export interface ConfigurationDiagnostic {
  code: string;
  path: string;
  field: string;
  message: string;
  recoverable: boolean;
}
export interface ReadOptions<T> {
  defaults?: T;
  legacyPaths?: string[];
  normalize?: (value: T, issue: (field: string, message: string) => void) => T;
  onDiagnostic?: (diagnostic: ConfigurationDiagnostic) => void;
  repair?: boolean;
  create?: boolean;
}
export function resolveConfigHome(env?: Record<string, string | undefined>): string;
export function defaultPilotConfiguration(env?: Record<string, string | undefined>): Record<string, unknown>;
export function normalizeMcpConfiguration(value: unknown, issue?: (field: string, message: string) => void): { mcpServers: Record<string, unknown>; [key: string]: unknown };
export function readConfiguration<T = Record<string, unknown>>(file: string, options?: ReadOptions<T>): {
  value: T; diagnostics: ConfigurationDiagnostic[]; migrated: boolean; source: string | null; path: string;
};
export function writeConfiguration<T>(file: string, value: T): T;
export function updateConfiguration<T>(file: string, update: (current: T) => T, options?: ReadOptions<T>): T;
export function recoverValues<T>(value: unknown, defaults: T, issue: (field: string, message: string) => void, prefix?: string): T;
export function classifyRuntimeError(error: unknown, evidence?: string, status?: number): string;
export function redactDiagnostic(value: unknown): string;
export function registerDiagnosticSecrets(value: unknown): void;
