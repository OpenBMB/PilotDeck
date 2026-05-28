import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkspaceMemoryMode } from "./types.js";
import { hashText } from "./utils/id.js";

export const GENERAL_PROJECT_META_DIR = "GeneralProjects";
export const GENERAL_PROJECT_MEMORY_DIR = "Project";
export const GENERAL_FEEDBACK_MEMORY_DIR = "Feedback";
export const GENERAL_WORKSPACE_DIR = join(homedir(), ".pilotdeck");
export const EXTERNAL_RECORD_PREFIX = "external:" as const;
export const EXTERNAL_PROJECT_PREFIX = "external-project:" as const;

export function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath);
}

export function isGeneralWorkspaceDir(workspaceDir: string): boolean {
  return normalizeWorkspacePath(workspaceDir) === normalizeWorkspacePath(GENERAL_WORKSPACE_DIR);
}

export function getWorkspaceMemoryMode(workspaceDir: string): WorkspaceMemoryMode {
  return isGeneralWorkspaceDir(workspaceDir) ? "general" : "single";
}

export function buildExternalProjectLogicalId(workspacePath: string, projectId: string): string {
  return `${EXTERNAL_PROJECT_PREFIX}${hashText(`${normalizeWorkspacePath(workspacePath)}::${projectId}`)}`;
}

export function buildExternalRecordId(workspacePath: string, relativePath: string): string {
  return `${EXTERNAL_RECORD_PREFIX}${hashText(normalizeWorkspacePath(workspacePath))}:${relativePath.replace(/\\/g, "/")}`;
}

export function parseExternalRecordId(
  value: string,
): { workspaceKey: string; relativePath: string } | null {
  if (!value.startsWith(EXTERNAL_RECORD_PREFIX)) return null;
  const payload = value.slice(EXTERNAL_RECORD_PREFIX.length);
  const separator = payload.indexOf(":");
  if (separator <= 0) return null;
  const workspaceKey = payload.slice(0, separator).trim();
  const relativePath = payload.slice(separator + 1).trim().replace(/\\/g, "/");
  if (!workspaceKey || !relativePath) return null;
  return { workspaceKey, relativePath };
}

export function isExternalRecordId(value: string): boolean {
  return value.startsWith(EXTERNAL_RECORD_PREFIX);
}
