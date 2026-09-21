import type { ComponentType } from 'react';
import type { PendingPermissionRequest } from '../../types/types';

export interface PermissionPanelProps {
  request: PendingPermissionRequest;
  onDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; updatedInput?: unknown },
  ) => void;
  onPlanExecutionApproved?: () => void;
}

const registry: Record<string, ComponentType<PermissionPanelProps>> = {};

export function registerPermissionPanel(
  toolName: string,
  component: ComponentType<PermissionPanelProps>,
): void {
  registry[toolName] = component;
}

export function unregisterPermissionPanel(toolName: string, component?: ComponentType<PermissionPanelProps>): void {
  if (!component || registry[toolName] === component) delete registry[toolName];
}

export function registerPermissionPanels(
  panels: Array<{ toolNames?: string[]; component: ComponentType<PermissionPanelProps> }>,
): () => void {
  const registered: Array<[string, ComponentType<PermissionPanelProps>]> = [];
  for (const panel of panels) {
    for (const toolName of panel.toolNames ?? []) {
      registerPermissionPanel(toolName, panel.component);
      registered.push([toolName, panel.component]);
    }
  }
  return () => registered.forEach(([toolName, component]) => unregisterPermissionPanel(toolName, component));
}

export function getPermissionPanel(
  toolName: string,
): ComponentType<PermissionPanelProps> | null {
  return registry[toolName] || null;
}
