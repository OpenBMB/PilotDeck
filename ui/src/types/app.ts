export type SessionProvider = 'claude' | 'cursor' | 'codex' | 'gemini' | 'pilotdeck';
export type ProjectSessionKind = 'background_task';

export type AppTab = 'home' | 'chat' | 'always-on' | 'files' | 'shell' | 'git' | 'tasks' | 'memory' | 'skills' | 'preview' | 'dashboard' | `plugin:${string}`;

export type AlwaysOnSessionTarget =
  | {
      kind: 'origin';
      sessionId: string;
      projectName?: string;
    }
  | {
      kind: 'background';
      sessionId: string;
      parentSessionId: string;
      relativeTranscriptPath: string;
      title?: string;
      summary?: string;
      lastActivity?: string;
      transcriptKey?: string;
      taskId?: string;
      taskStatus?: string;
      outputFile?: string;
    };

export type AlwaysOnDashboardEventPhase =
  | 'discovery_started'
  | 'plan_produced'
  | 'no_plan'
  | 'workspace_ready'
  | 'execution_started'
  | 'execution_completed'
  | 'report_produced'
  | 'run_completed'
  | 'run_failed'
  | 'cron_started'
  | 'cron_completed'
  | 'cron_failed';

export interface AlwaysOnDashboardEvent {
  eventId: string;
  runId: string;
  projectKey: string;
  projectName: string;
  projectDisplayName: string;
  phase: AlwaysOnDashboardEventPhase;
  timestamp: string;
  title?: string;
  planId?: string;
  outcome?: string;
  error?: { code: string; message: string };
}

export interface AlwaysOnDashboardEventsResponse {
  events: AlwaysOnDashboardEvent[];
}

export type DiscoveryPlanStatus =
  | 'ready'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'archived';

export interface DiscoveryPlanOverview {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: DiscoveryPlanStatus;
  executionSessionId?: string;
  workCycleId?: string;
  sourceRunId?: string;
  sourceDiscoverySessionId?: string;
}

export interface ProjectDiscoveryPlansResponse {
  plans: DiscoveryPlanOverview[];
}

export type WorkCycleStatus = 'active' | 'applying' | 'applied' | 'archived';

export interface WorkCycleOverview {
  id: string;
  projectKey: string;
  status: WorkCycleStatus;
  workspace: {
    strategy: string;
    cwd: string;
  };
  planIds: string[];
  createdAt: string;
  appliedAt?: string;
  archivedAt?: string;
}

export interface DiscoveryContextMemoryItem {
  path: string;
  modifiedAt: string;
  summary: string;
}

export interface DiscoveryContextPlanItem {
  id: string;
  title: string;
  status: DiscoveryPlanStatus;
  updatedAt: string;
  summary: string;
}

export type CronJobOverviewStatus = 'scheduled' | 'running' | 'completed' | 'failed';

export interface CronJobOverview {
  id: string;
  projectKey: string | null;
  cron: string;
  prompt: string;
  createdAt: string;
  recurring: boolean;
  manualOnly: boolean;
  status: CronJobOverviewStatus;
  lastFiredAt?: number;
}

export interface CronJobsOverviewResponse {
  jobs: CronJobOverview[];
}

export type AlwaysOnSubTab = 'dashboard' | 'plans-cron';

export interface DiscoveryContextCronItem {
  id: string;
  status: CronJobOverviewStatus;
  cron: string;
  recurring: boolean;
  manualOnly: boolean;
  prompt: string;
  latestRunSummary?: string;
}

export interface DiscoveryContextChatItem {
  id: string;
  summary: string;
  lastActivity: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}

export interface ProjectDiscoveryContextResponse {
  generatedAt: string;
  lookbackDays: number;
  workspace: {
    projectName: string;
    projectRoot: string;
    signals: string[];
  };
  memory: DiscoveryContextMemoryItem[];
  existingPlans: DiscoveryContextPlanItem[];
  cronJobs: DiscoveryContextCronItem[];
  recentChats: DiscoveryContextChatItem[];
}

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  sessionKind?: ProjectSessionKind;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
  transcriptKey?: string;
  taskId?: string;
  taskStatus?: string;
  outputFile?: string;
  isReadOnly?: boolean;
  __projectName?: string;
  [key: string]: unknown;
}

export type SessionRequestParams = {
  sessionKind?: ProjectSessionKind;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
};

export function isBackgroundTaskSession(
  session: ProjectSession | null | undefined,
): session is ProjectSession & {
  sessionKind: 'background_task';
  parentSessionId: string;
  relativeTranscriptPath: string;
} {
  return (
    session?.sessionKind === 'background_task' &&
    typeof session.parentSessionId === 'string' &&
    session.parentSessionId.length > 0 &&
    typeof session.relativeTranscriptPath === 'string' &&
    session.relativeTranscriptPath.length > 0
  );
}

export function getSessionRequestParams(
  session: ProjectSession | null | undefined,
): SessionRequestParams {
  if (!isBackgroundTaskSession(session)) {
    return {};
  }

  return {
    sessionKind: session.sessionKind,
    parentSessionId: session.parentSessionId,
    relativeTranscriptPath: session.relativeTranscriptPath,
  };
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProjectAlwaysOnInfo {
  discovery?: {
    triggerEnabled?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface Project {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  alwaysOn?: ProjectAlwaysOnInfo;
  [key: string]: unknown;
}

export interface LoadingProgress {
  type?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}

export interface ProjectsUpdatedMessage {
  type: 'projects_updated';
  projects: Project[];
  changedFile?: string;
  [key: string]: unknown;
}

export interface LoadingProgressMessage extends LoadingProgress {
  type: 'loading_progress';
}

export type AppSocketMessage =
  | LoadingProgressMessage
  | ProjectsUpdatedMessage
  | { type?: string;[key: string]: unknown };
