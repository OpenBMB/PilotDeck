import type { AlwaysOnSubTab, AppTab, Project, ProjectSession } from '../../../types/app';
import type { ComponentType } from 'react';
import type { ChatInterfaceProps } from '../../chat/types/types';

export type SessionLifecycleHandler = (sessionId?: string | null) => void;

export type SessionNavigationOptions = {
  preserveActiveTab?: boolean;
};

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
  alwaysOnSubTab?: AlwaysOnSubTab;
  onAlwaysOnSubTabChange?: (tab: AlwaysOnSubTab) => void;
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
    inputId?: string,
  ) => void | (() => void);
  processingSessions: Set<string>;
  unreadSessionIds: Set<string>;
  onReplaceTemporarySession: SessionLifecycleHandler;
  onNavigateToSession: (targetSessionId: string) => void;
  onStartNewSession: (project: Project, options?: SessionNavigationOptions) => void;
  onCreateProject?: () => void;
  onSelectWorkspace?: (project: Project) => void;
  workspaceBinding?: Project | null;
  // Used by session lists to jump to the Agent tab and select
  // (project, sessionId). Optional because legacy MainContent
  // consumers don't need it.
  onSelectSession?: (
    project: Project,
    sessionId: string,
    fallbackSession?: ProjectSession,
    options?: SessionNavigationOptions,
  ) => void;
  onShowSettings: () => void;
  onSelectProjectByName?: (projectName: string) => void;
  externalMessageUpdate: number;
  /** When the URL uses /session/<file> by mistake, open the file in the editor. */
  misroutedFileFromUrl?: string | null;
  onMisroutedFileUrlHandled?: () => void;
  /** Selected AgentLoop implementation; the shell does not import a chat client. */
  chatSurface?: ComponentType<ChatInterfaceProps> | null;
  /** Runtime capability verification is pending, so no module surface is active yet. */
  chatUnavailableMessage?: string | null;
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
