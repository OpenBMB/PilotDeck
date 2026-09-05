import type { ChatModelSelection } from '../hooks/useChatProviderState';
import type { ChatAttachment } from './types';

export type QueuedInputStatus = 'queued' | 'steering' | 'dispatching' | 'delivery_uncertain' | 'failed';
export type InputQueuePauseReason = 'user_stopped' | 'previous_turn_failed' | 'restart_recovery';

export type QueuedInputSummary = {
  id: string;
  displayText: string;
  createdAt: string;
  status: QueuedInputStatus;
  attachmentCount?: number;
};

export type InputQueueState = {
  sessionId: string;
  revision: number;
  paused: boolean;
  pauseReason?: InputQueuePauseReason;
  activeRunId?: string;
  items: QueuedInputSummary[];
};

export type PreparedQueuedInput = {
  id: string;
  runId?: string;
  command: string;
  displayText: string;
  createdAt: string;
  options: {
    sessionId: string;
    projectPath: string;
    cwd: string;
    runMode?: string;
    permissionMode?: string;
    basePermissionMode?: string;
    model?: string;
    modelSelection?: ChatModelSelection;
    modelOverride?: {
      mode: 'model';
      provider: string;
      model: string;
      reasoning?: number;
      temperature?: number;
      speed?: number;
    };
    thinking?: unknown;
    sessionSummary?: string | null;
    toolsSettings?: unknown;
    userVisibleInput?: string;
    images?: unknown[];
    attachments?: ChatAttachment[];
    uploadedAttachments?: Array<{ uploadId: string; attachmentIds?: string[] }>;
  };
};
