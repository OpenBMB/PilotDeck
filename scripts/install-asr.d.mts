export function resolveInstallerProxy(input?: {
  env?: Record<string, string | undefined>;
  configText?: string;
}): { url: string; noProxy: string; source: "env" | "config" } | undefined;
export function downloadFile(url: string, destination: string): Promise<{ bytes: number }>;
