import type { ComponentType, ReactNode } from 'react';
import type { ChatInterfaceProps } from '../components/chat/types/types';
import type { PublicApprovalHost } from './modules/staffdeck/public-approval-inbox-mount';

export const slots = ['agentLoop', 'skills', 'tools', 'context', 'modelProvider', 'sop', 'knowledge'] as const;
export type Slot = typeof slots[number];
export type Binding = {
  enabled: boolean;
  provider?: string;
  implementationId?: string;
  frontendModule?: string;
  contract?: string;
  transport?: string;
  methods?: string[];
  management?: {
    enabled?: boolean;
    methods?: string[];
    agentId?: string;
  };
};
export type BusinessBinding = {
  /** Installed in this browser product build. Omission means not installed. */
  enabled?: boolean;
  /** Replaces the public business capability implementation. */
  frontendModule?: string;
};
export type CompositionProfile = {
  modules?: Partial<Record<Slot, Binding>>;
  frontend?: {
    businessModules?: Record<string, BusinessBinding>;
  };
};

export type SurfaceProps = {
  sessionId?: string;
  projectKey?: string;
  refreshKey?: string;
  disabled?: boolean;
  host?: {
    selectedProject?: unknown;
    selectedSession?: unknown;
    projects?: unknown[];
    navigate?: (path: string) => void;
    approval?: PublicApprovalHost;
  };
  children?: ReactNode;
  onPrepared?: (message: string) => void;
  onError?: (message: string) => void;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  mode?: 'input' | 'result';
  artifact?: unknown;
  permissionRequest?: unknown;
  request?: { requestId?: string; toolName?: string };
  onDecision?: (requestIds: string | string[], decision: { allow?: boolean; message?: string; updatedInput?: unknown }) => void;
  onPlanExecutionApproved?: () => void;
  onClose?: () => void;
};
export type ModuleLifecycle = {
  init?: (host: unknown) => void | (() => void) | Promise<void | (() => void)>;
  dispose?: () => void | Promise<void>;
};
export type Contribution = {
  id: string;
  /** Optional i18n key for the user-facing label; label remains the fallback. */
  labelKey?: string;
  label: string;
  component: ComponentType<SurfaceProps>;
  settingsSection?: string;
  toolNames?: string[];
  artifactMimeTypes?: string[];
  fileExtensions?: string[];
  /** Requires an operational runtime, rather than only a valid module profile. */
  requiresRuntime?: boolean;
};
export type PageContribution = Contribution & { path: string };
export type ChatSurfaceContribution = {
  id: string;
  component: ComponentType<ChatInterfaceProps>;
};
export type MarkdownLinkContribution = {
  id: string;
  protocol: string;
  component: ComponentType<{ href: string; children?: ReactNode }>;
};
export type FrontendModule = {
  id: string;
  /** Backend-slot adapters have a slot; product capabilities have businessModuleId. */
  slot?: Slot;
  businessModuleId?: string;
  contract: string;
  compatibleContracts?: string[];
  source?: 'pilotdeck' | 'staffdeck' | 'third-party' | 'fixture';
  frontendApiVersion?: string;
  /** Stable emitted marker used by composition build-exclusion verification. */
  buildMarker?: string;
  requiresCapabilities?: string[];
  lifecycle?: ModuleLifecycle;
  requires?: Slot[];
  pages?: PageContribution[];
  settings?: Contribution[];
  chatSurface?: ChatSurfaceContribution;
  /** Optional host view supplied by the SOP module when that module is installed. */
  approvalInbox?: PublicApprovalHost['Inbox'];
  chatExtensions?: Contribution[];
  permissionPanels?: Contribution[];
  toolRenderers?: Contribution[];
  artifactRenderers?: Contribution[];
  fileRenderers?: Contribution[];
  markdownLinkRenderers?: MarkdownLinkContribution[];
  historyFallback?: Contribution;
};
export type Selection = { slot: Slot; binding: Binding; frontend: FrontendModule };
export type BusinessSelection = { businessModuleId: string; binding: BusinessBinding; frontend: FrontendModule };
export type Assembly = {
  bindings: Record<Slot, Binding>;
  selections: Selection[];
  businessBindings: Record<string, BusinessBinding>;
  businessSelections: BusinessSelection[];
  pages: PageContribution[];
  settings: Contribution[];
  chatSurface: ChatSurfaceContribution | null;
  approvalInbox: PublicApprovalHost['Inbox'] | null;
  chatExtensions: Contribution[];
  permissionPanels: Contribution[];
  toolRenderers: Contribution[];
  artifactRenderers: Contribution[];
  fileRenderers: Contribution[];
  markdownLinkRenderers?: MarkdownLinkContribution[];
  historyFallbacks: Array<{ moduleId: string; contribution: Contribution }>;
};

export type ModuleNavigation = PageContribution & { icon?: ComponentType<{ className?: string }> };
