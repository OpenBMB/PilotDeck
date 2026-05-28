import type {
  Project,
  ProjectSession,
  SessionProvider,
} from '../../../types/app';

export type Provider = SessionProvider;

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
export type ChatRunMode = 'agent' | 'plan';

export interface ChatImage {
  data: string;
  name: string;
  mimeType?: string;
}

export interface ChatAttachment {
  name: string;
  path?: string;
  size?: number;
  mimeType?: string;
}

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  /**
   * `PilotDeckToolErrorCode` from the backend (e.g. `permission_denied`,
   * `permission_required`, `tool_execution_failed`, `file_not_found`).
   * Optional because legacy / replayed messages may not carry it. Used by
   * `getPilotDeckPermissionSuggestion` to gate the "Add to Allowed Tools"
   * affordance so it only fires for genuine permission failures.
   */
  errorCode?: string;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  /**
   * Inline images returned by the tool (e.g. `read_file` on a PNG/JPG, PDF
   * page renders). Each entry's `data` is a ready-to-render data URL. These
   * render alongside the tool row instead of in a stray user-side bubble.
   */
  images?: ChatImage[];
  [key: string]: unknown;
}

export interface SubagentChildTool {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  timestamp: Date;
}

export interface ChatMessage {
  id?: string;
  type: string;
  content?: string;
  timestamp: string | number | Date;
  images?: ChatImage[];
  attachments?: ChatAttachment[];
  reasoning?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isInteractivePrompt?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  taskStatus?: string;
  taskId?: string;
  outputFile?: string;
  taskResult?: string;
  isSubagentContainer?: boolean;
  isTaskNotification?: boolean;
  isInterruptedNotice?: boolean;
  isAgentActivity?: boolean;
  isAgentActivitySummary?: boolean;
  isCompactBoundary?: boolean;
  activityId?: string;
  runId?: string;
  compactTrigger?: string;
  preTokens?: number;
  compactLevel?: number;
  compactStage?: string;
  compactStageLabel?: string;
  title?: string;
  detail?: string;
  phase?: string;
  state?: string;
  severity?: string;
  startedAt?: string;
  endedAt?: string | null;
  durationMs?: number | null;
  toolCallCount?: number;
  toolErrorCount?: number;
  ragSearchCount?: number;
  editedFileCount?: number;
  exploredFileCount?: number;
  commandCount?: number;
  subagentCount?: number;
  compactCount?: number;
  thinkingCount?: number;
  otherToolCount?: number;
  keySteps?: unknown[];
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
    isFailed?: boolean;
  };
  [key: string]: unknown;
}

export interface CompactProgress {
  level: number;
  stage: string;
  label: string;
  state: 'started' | 'running' | 'failed' | 'completed';
  pre_tokens?: number;
  reason?: string;
}

export interface ClaudeWorkStatus {
  text: string;
  tokens: number;
  can_interrupt: boolean;
  compactProgress?: CompactProgress | null;
}

export interface PilotDeckWorkStatus {
  text: string;
  tokens: number;
  can_interrupt: boolean;
  compactProgress?: CompactProgress | null;
}

export interface PilotDeckSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface PilotDeckPermissionSuggestion {
  toolName: string;
  entry: string;
  isAllowed: boolean;
}

export interface PermissionGrantResult {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: PilotDeckSettings;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
  /**
   * True when this request originated from a gateway elicitation channel
   * (e.g. `ask_user_question`) rather than the permission bus. The decision
   * needs to round-trip through `elicitation-response` instead of the
   */
  isElicitation?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface ChatInterfaceProps {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: any;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  // Optimistic sidebar refresh fired the instant the user submits a
  // message — lets the sidebar reorder / show a placeholder row without
  // waiting on the server's debounced `projects_updated` round-trip.
  onSessionActivityBump?: (
    projectName: string,
    sessionId: string,
    optimisticTitle?: string,
  ) => void;
  processingSessions?: Set<string>;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (targetSessionId: string) => void;
  onShowSettings?: () => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  autoScrollToBottom?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
  // V2 only: when true, ignore session/messages and render the welcome layout:
  // centered headline + big composer in the middle of the pane.
  forceWelcome?: boolean;
  // Fired the moment the user submits their first message from welcome
  // mode so the parent can leave any legacy welcome-only state.
  onExitWelcome?: () => void;
}
