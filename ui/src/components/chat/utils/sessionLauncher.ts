import type { Project, ProjectSession } from '../../../types/app';
import type { ChatAttachment, ChatRunMode, PermissionMode } from '../types/types';
import { safeLocalStorage } from './chatStorage';

type StartSessionOptions = {
  sendMessage: (message: unknown) => void;
  selectedProject: Project;
  command: string;
  userVisibleInput?: string;
  sessionId?: string | null;
  temporarySessionId?: string;
  permissionMode?: PermissionMode | string;
  basePermissionMode?: PermissionMode | string;
  runMode?: ChatRunMode | string;
  modelOverride?: {
    mode: 'model';
    provider: string;
    model: string;
    reasoning?: number;
    temperature?: number;
  };
  images?: unknown[];
  attachments?: ChatAttachment[];
  uploadedAttachments?: Array<{ uploadId: string; attachmentIds?: string[] }>;
  workspaceCwd?: string;
  forceStart?: boolean;
};

const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'bypassPermissions',
  'plan',
]);

export const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

export function createTemporarySessionId(): string {
  return `new-session-${Date.now()}`;
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
  userVisibleInput,
  sessionId,
  temporarySessionId,
  permissionMode = 'default',
  basePermissionMode,
  runMode,
  modelOverride,
  images,
  attachments,
  uploadedAttachments,
  workspaceCwd,
  forceStart,
}: StartSessionOptions): string {
  const sessionToActivate =
    sessionId || temporarySessionId || createTemporarySessionId();
  const resolvedProjectPath = getSelectedProjectPath(selectedProject);

  sendMessage({
    type: 'pilotdeck-command',
    command,
    options: {
      ...(sessionId ? { sessionId } : {}),
      projectPath: resolvedProjectPath,
      ...(runMode ? { runMode } : {}),
      permissionMode,
      ...(basePermissionMode ? { basePermissionMode } : {}),
      ...(modelOverride ? { modelOverride } : {}),
      ...(typeof userVisibleInput === 'string' && userVisibleInput.trim()
        ? { userVisibleInput: userVisibleInput.trim() }
        : {}),
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
      ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
      ...(Array.isArray(uploadedAttachments) && uploadedAttachments.length > 0
        ? { uploadedAttachments }
        : {}),
      ...(workspaceCwd ? { workspaceCwd } : {}),
      ...(forceStart ? { forceStart: true } : {}),
    },
  });

  return sessionToActivate;
}
