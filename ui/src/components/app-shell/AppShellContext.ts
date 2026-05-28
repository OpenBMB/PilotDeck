import type { Dispatch, SetStateAction } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import type { SessionLifecycleHandler } from '../main-content/types/types';

// Everything the V2 routes need from the shell. Mirrors what legacy
// MainContentProps exposed but carries the route context in a single bag so
// individual route components don't drill through 15 props each.
export type AppShellContextValue = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isLoading: boolean;
  isMobile: boolean;

  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: unknown;
  externalMessageUpdate: number;

  processingSessions: Set<string>;

  // Actions
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  onSessionActive: SessionLifecycleHandler;
  onSessionInactive: SessionLifecycleHandler;
  onSessionProcessing: SessionLifecycleHandler;
  onSessionNotProcessing: SessionLifecycleHandler;
  onReplaceTemporarySession: SessionLifecycleHandler;
  onNavigateToSession: (sessionId: string) => void;
  onStartNewSession: (project: Project) => void;
  onShowSettings: () => void;
  onMenuClick: () => void;
  onInputFocusChange: (focused: boolean) => void;

  // V2-only conveniences
  navigateToProject: (projectName: string) => void;
  navigateToNewChat: () => void;
};

export function useAppShellContext(): AppShellContextValue {
  return useOutletContext<AppShellContextValue>();
}
