import type { AppTab, Project, ProjectSession } from '../../../types/app';

export type SessionLifecycleHandler = (sessionId?: string | null) => void;

export type TaskMasterTask = {
  id: string | number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  details?: string;
  testStrategy?: string;
  parentId?: string | number;
  dependencies?: Array<string | number>;
  subtasks?: TaskMasterTask[];
  [key: string]: unknown;
};

export type TaskReference = {
  id: string | number;
  title?: string;
  [key: string]: unknown;
};

export type TaskSelection = TaskMasterTask | TaskReference;

export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

export type MainContentProps = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: unknown;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionActive: SessionLifecycleHandler;
  onSessionInactive: SessionLifecycleHandler;
  onSessionProcessing: SessionLifecycleHandler;
  onSessionNotProcessing: SessionLifecycleHandler;
  // See ChatInterfaceProps.onSessionActivityBump.
  onSessionActivityBump?: (
    projectName: string,
    sessionId: string,
    optimisticTitle?: string,
  ) => void;
  processingSessions: Set<string>;
  onReplaceTemporarySession: SessionLifecycleHandler;
  onNavigateToSession: (targetSessionId: string) => void;
  onStartNewSession: (project: Project) => void;
  // Used by session lists to jump to the Agent tab and select
  // (project, sessionId). Optional because legacy MainContent
  // consumers don't need it.
  onSelectSession?: (project: Project, sessionId: string, fallbackSession?: ProjectSession) => void;
  onShowSettings: () => void;
  onSelectProjectByName?: (projectName: string) => void;
  externalMessageUpdate: number;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};

export type TaskMasterPanelProps = {
  isVisible: boolean;
};
