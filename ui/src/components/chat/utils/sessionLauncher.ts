import type { Project, ProjectSession } from '../../../types/app';
import type { ChatAttachment, ChatRunMode, PilotDeckSettings, PermissionMode } from '../types/types';
import { getPilotDeckSettings, safeLocalStorage } from './chatStorage';

type StartSessionOptions = {
  sendMessage: (message: unknown) => void;
  selectedProject: Project;
  command: string;
  runId?: string;
  userVisibleInput?: string;
  sessionId?: string | null;
  temporarySessionId?: string;
  permissionMode?: PermissionMode | string;
  basePermissionMode?: PermissionMode | string;
  runMode?: ChatRunMode | string;
  model?: string;
  thinking?: unknown;
  sessionSummary?: string | null;
  toolsSettings?: PilotDeckSettings;
  modelOverride?: {
    mode: 'model';
    provider: string;
    model: string;
    reasoning?: number;
    temperature?: number;
    speed?: number;
  };
  images?: unknown[];
  attachments?: ChatAttachment[];
  uploadedAttachments?: Array<{ uploadId: string; attachmentIds?: string[] }>;
  alwaysOnPlanId?: string;
  alwaysOnExecutionToken?: string;
  workspaceCwd?: string;
  forceStart?: boolean;
};

const VALID_PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'bypassPermissions',
  'plan',
]);
let fallbackRunIdCounter = 0;

export const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

export function createTemporarySessionId(): string {
  return `new-session-${Date.now()}`;
}

export function createUserTurnRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  fallbackRunIdCounter += 1;
  return `web-turn-${Date.now()}-${fallbackRunIdCounter}`;
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
  runId,
  userVisibleInput,
  sessionId,
  temporarySessionId,
  permissionMode = 'default',
  basePermissionMode,
  runMode,
  model,
  thinking,
  sessionSummary,
  toolsSettings = getPilotDeckSettings(),
  modelOverride,
  images,
  attachments,
  uploadedAttachments,
  alwaysOnPlanId,
  alwaysOnExecutionToken,
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
      ...(sessionId ? { sessionId, resume: true } : {}),
      projectPath: resolvedProjectPath,
      cwd: resolvedProjectPath,
      ...(runId ? { runId } : {}),
      toolsSettings,
      ...(runMode ? { runMode } : {}),
      permissionMode,
      ...(basePermissionMode ? { basePermissionMode } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      sessionSummary,
      ...(modelOverride ? { modelOverride } : {}),
      ...(typeof userVisibleInput === 'string' && userVisibleInput.trim()
        ? { userVisibleInput: userVisibleInput.trim() }
        : {}),
      ...(alwaysOnPlanId ? { alwaysOnPlanId } : {}),
      ...(alwaysOnExecutionToken ? { alwaysOnExecutionToken } : {}),
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
