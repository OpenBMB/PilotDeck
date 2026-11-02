export function resolveConfigHome(env?: Record<string,string|undefined>): string;
export function classifyRuntimeError(error: unknown,evidence?: string,status?: number): string;
export function redactDiagnostic(value: unknown): string;
export function registerDiagnosticSecrets(value: unknown): void;
