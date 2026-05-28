import { createHash } from "node:crypto";

export function hashText(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildL0IndexId(sessionKey: string, timestamp: string, payload: string): string {
  const key = sessionKey || "session";
  return `${key}_${hashText(`${timestamp}:${payload}`)}_raw`;
}

export function buildL1IndexId(timestamp: string, sourceIds: string[]): string {
  return `l1_${hashText(`${timestamp}:${sourceIds.sort().join(",")}`)}`;
}

export function buildL2TimeIndexId(dateKey: string): string {
  return `time_${hashText(dateKey)}`;
}

export function buildL2ProjectIndexId(projectKey: string): string {
  return `project_${hashText(projectKey.toLowerCase())}`;
}

export function buildFactId(factKey: string): string {
  return `fact_${hashText(factKey.toLowerCase())}`;
}

export function buildLinkId(fromLevel: string, fromId: string, toLevel: string, toId: string): string {
  return `link_${hashText(`${fromLevel}:${fromId}->${toLevel}:${toId}`)}`;
}
