import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

export function isChinaMirrorPreset(env = process.env) {
  return (env.PILOTDECK_DESKTOP_DOWNLOAD_MIRROR || "").trim().toLowerCase() === "china";
}

export function trimUrlBase(baseUrl) {
  return baseUrl.replace(/\/+$/g, "");
}

export function joinUrl(baseUrl, ...parts) {
  const cleanedParts = parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""));
  return [trimUrlBase(baseUrl), ...cleanedParts].join("/");
}

export function resolveDownloadSource({
  env = process.env,
  archiveEnv,
  urlEnv,
  baseEnv,
  chinaBaseUrl,
  officialBaseUrl,
  relativePath,
}) {
  const archivePath = archiveEnv ? env[archiveEnv]?.trim() : "";
  if (archivePath) {
    return {
      type: "archive",
      path: resolve(archivePath),
      source: archiveEnv,
    };
  }

  const explicitUrl = urlEnv ? env[urlEnv]?.trim() : "";
  if (explicitUrl) {
    return {
      type: "url",
      url: explicitUrl,
      source: urlEnv,
    };
  }

  const configuredBaseUrl = baseEnv ? env[baseEnv]?.trim() : "";
  const baseUrl = configuredBaseUrl || (isChinaMirrorPreset(env) ? chinaBaseUrl : officialBaseUrl);
  return {
    type: "url",
    url: joinUrl(baseUrl, relativePath),
    source: configuredBaseUrl ? baseEnv : isChinaMirrorPreset(env) ? "china-preset" : "official",
  };
}

export async function downloadToFile(url, path) {
  console.log(`[desktop] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(path));
}
