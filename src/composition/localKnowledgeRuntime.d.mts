export type LocalKnowledgeRuntimeConfig = Readonly<{
  python: string;
  dataDirectory?: string;
  configFile?: string;
  modelConfig?: string;
  identityFile?: string;
  capabilitiesFile?: string;
  startupTimeoutMs?: number;
}>;
export function validateLocalKnowledgeRuntime(value: unknown, endpoint: string): LocalKnowledgeRuntimeConfig;
export function startLocalKnowledgeRuntime(binding: unknown, options?: {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  onExit?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<{ stop(): Promise<void>; pid?: number; directory?: string }>;
