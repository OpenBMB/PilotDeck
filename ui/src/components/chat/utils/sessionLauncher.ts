import type { Project, ProjectSession } from '../../../types/app';
import type { ChatAttachment, PilotDeckSettings, PermissionMode } from '../types/types';
import { getPilotDeckSettings, safeLocalStorage } from './chatStorage';

type StartSessionOptions = {
  sendMessage: (message: unknown) => void;
  selectedProject: Project;
  command: string;
  sessionId?: string | null;
  temporarySessionId?: string;
  permissionMode?: PermissionMode | string;
  model?: string;
  sessionSummary?: string | null;
  toolsSettings?: PilotDeckSettings;
  images?: unknown[];
  attachments?: ChatAttachment[];
  alwaysOnPlanId?: string;
  alwaysOnExecutionToken?: string;
  workspaceCwd?: string;
};

const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]);

export const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

export function createTemporarySessionId(): string {
  return `new-session-${Date.now()}`;
}

export function getNotificationSessionSummary(
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null {
  const sessionSummary =
    selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80
      ? `${normalized.slice(0, 77)}...`
      : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80
    ? `${normalizedFallback.slice(0, 77)}...`
    : normalizedFallback;
}

export function getStoredPermissionMode(
  selectedSession: ProjectSession | null,
): PermissionMode {
  if (!selectedSession?.id) {
    return 'default';
  }

  const stored = safeLocalStorage.getItem(`permissionMode-${selectedSession.id}`);
  if (stored && VALID_PERMISSION_MODES.has(stored as PermissionMode)) {
    return stored as PermissionMode;
  }

  return 'default';
}

export function getSelectedProjectPath(selectedProject: Project): string {
  return selectedProject.fullPath || selectedProject.path || '';
}

export function startSessionCommand({
  sendMessage,
  selectedProject,
  command,
  sessionId,
  temporarySessionId,
  permissionMode = 'default',
  model,
  sessionSummary,
  toolsSettings = getPilotDeckSettings(),
  images,
  attachments,
  alwaysOnPlanId,
  alwaysOnExecutionToken,
  workspaceCwd,
}: StartSessionOptions): string {
  const sessionToActivate =
    sessionId || temporarySessionId || createTemporarySessionId();
  const resolvedProjectPath = getSelectedProjectPath(selectedProject);

  sendMessage({
    type: 'pilotdeck-command',
    command,
    options: {
      ...(sessionId ? { sessionId, resume: true } : {}),
      projectPath: resolvedProjectPath,
      cwd: resolvedProjectPath,
      toolsSettings,
      permissionMode,
      ...(model ? { model } : {}),
      sessionSummary,
      ...(alwaysOnPlanId ? { alwaysOnPlanId } : {}),
      ...(alwaysOnExecutionToken ? { alwaysOnExecutionToken } : {}),
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
      ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
      ...(workspaceCwd ? { workspaceCwd } : {}),
    },
  });

  return sessionToActivate;
}
