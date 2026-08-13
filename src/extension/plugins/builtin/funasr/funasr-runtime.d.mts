export type FunAsrRuntimeAsset = {
  key: string;
  file: string;
  format: "tar.gz" | "zip";
  url: string;
};

export type FunAsrModel = {
  repo: string;
  file: string;
  revision: string;
};

export const FUNASR_RUNTIME_VERSION: string;
export const FUNASR_RELEASE_BASE: string;
export const SENSEVOICE_MODEL: string;
export const FSMN_VAD_MODEL: string;
export const FUNASR_MODELS: FunAsrModel[];
export function resolveRuntimeAsset(platform?: string, arch?: string): FunAsrRuntimeAsset;
export function runtimeDirectory(runtimeRoot: string, platform?: string, arch?: string): string;
export function modelDirectory(runtimeRoot: string): string;
export function findSenseVoiceBinary(runtimeRoot: string, platform?: string, arch?: string): string | undefined;
export function findSenseVoiceBinaryIn(root: string, platform?: string): string | undefined;
export function runtimePaths(runtimeRoot: string, platform?: string, arch?: string): {
  binary: string | undefined;
  model: string;
  vad: string;
};
