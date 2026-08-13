import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const FUNASR_RUNTIME_VERSION = "v0.2.0";
export const FUNASR_RELEASE_BASE =
  `https://github.com/modelscope/FunASR/releases/download/runtime-llamacpp-${FUNASR_RUNTIME_VERSION}`;
export const SENSEVOICE_MODEL = "sensevoice-small-q8.gguf";
export const FSMN_VAD_MODEL = "fsmn-vad.gguf";
export const FUNASR_MODELS = [
  {
    repo: "FunAudioLLM/SenseVoiceSmall-GGUF",
    file: SENSEVOICE_MODEL,
    revision: "master",
  },
  {
    repo: "FunAudioLLM/fsmn-vad-GGUF",
    file: FSMN_VAD_MODEL,
    revision: "master",
  },
];

const ASSETS = {
  "darwin-arm64": {
    file: "funasr-llamacpp-macos-arm64.tar.gz",
    format: "tar.gz",
  },
  "linux-arm64": {
    file: "funasr-llamacpp-linux-arm64.tar.gz",
    format: "tar.gz",
  },
  "linux-x64": {
    file: "funasr-llamacpp-linux-x64.tar.gz",
    format: "tar.gz",
  },
  "win32-x64": {
    file: "funasr-llamacpp-windows-x64.zip",
    format: "zip",
  },
};

export function resolveRuntimeAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    throw new Error(
      `unsupported-platform: FunASR local runtime supports macOS ARM64, Linux ARM64/x64, and Windows x64; received ${platform}/${arch}`,
    );
  }
  return { key, ...asset, url: `${FUNASR_RELEASE_BASE}/${asset.file}` };
}

export function runtimeDirectory(runtimeRoot, platform = process.platform, arch = process.arch) {
  return join(runtimeRoot, "runtime", FUNASR_RUNTIME_VERSION, `${platform}-${arch}`);
}

export function modelDirectory(runtimeRoot) {
  return join(runtimeRoot, "models");
}

export function findSenseVoiceBinary(runtimeRoot, platform = process.platform, arch = process.arch) {
  const root = runtimeDirectory(runtimeRoot, platform, arch);
  return findSenseVoiceBinaryIn(root, platform);
}

export function findSenseVoiceBinaryIn(root, platform = process.platform) {
  const executable = platform === "win32" ? "llama-funasr-sensevoice.exe" : "llama-funasr-sensevoice";
  return findNamedFile(root, executable);
}

export function runtimePaths(runtimeRoot, platform = process.platform, arch = process.arch) {
  return {
    binary: findSenseVoiceBinary(runtimeRoot, platform, arch),
    model: join(modelDirectory(runtimeRoot), SENSEVOICE_MODEL),
    vad: join(modelDirectory(runtimeRoot), FSMN_VAD_MODEL),
  };
}

function findNamedFile(root, name) {
  if (!existsSync(root)) return undefined;
  const direct = join(root, name);
  if (existsSync(direct)) return direct;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isFile() && entry.name === name) return path;
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return undefined;
}
