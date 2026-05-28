import React from 'react';
import type { PendingPermissionRequest } from '../../types/types';
import { buildPilotDeckToolPermissionEntry, formatToolInputForDisplay } from '../../utils/chatPermissions';
import { getPilotDeckSettings } from '../../utils/chatStorage';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel, ExitPlanModePanel } from '../../tools/components/InteractiveRenderers';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);
registerPermissionPanel('ask_user_question', AskUserQuestionPanel);
registerPermissionPanel('ExitPlanMode', ExitPlanModePanel);
registerPermissionPanel('exit_plan_mode', ExitPlanModePanel);
registerPermissionPanel('ExitPlanModeV2', ExitPlanModePanel);

interface PermissionRequestsBannerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  onPlanExecutionApproved?: () => void;
}

export default function PermissionRequestsBanner({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  onPlanExecutionApproved,
}: PermissionRequestsBannerProps) {
  if (!pendingPermissionRequests.length) {
    return null;
  }

  const customPanelRequests: PendingPermissionRequest[] = [];
  const grouped = new Map<string, PendingPermissionRequest[]>();

  for (const request of pendingPermissionRequests) {
    if (getPermissionPanel(request.toolName)) {
      customPanelRequests.push(request);
      continue;
    }
    const rawInput = formatToolInputForDisplay(request.input);
    const entry = buildPilotDeckToolPermissionEntry(request.toolName, rawInput) ?? request.requestId;
    const group = grouped.get(entry);
    if (group) {
      group.push(request);
    } else {
      grouped.set(entry, [request]);
    }
  }

  return (
    <div className="mb-3 space-y-2">
      {customPanelRequests.map((request) => {
        const CustomPanel = getPermissionPanel(request.toolName)!;
        return (
          <CustomPanel
            key={request.requestId}
            request={request}
            onDecision={handlePermissionDecision}
            onPlanExecutionApproved={onPlanExecutionApproved}
          />
        );
      })}

      {Array.from(grouped.entries()).map(([entry, requests]) => {
        const first = requests[0];
        const allIds = requests.map((r) => r.requestId);
        const rawInput = formatToolInputForDisplay(first.input);
        const permissionEntry = buildPilotDeckToolPermissionEntry(first.toolName, rawInput);
        const settings = getPilotDeckSettings();
        const alreadyAllowed = permissionEntry ? settings.allowedTools.includes(permissionEntry) : false;
        const rememberLabel = alreadyAllowed ? 'Allow (saved)' : 'Allow & remember';

        return (
          <div
            key={entry}
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 shadow-sm dark:border-amber-800 dark:bg-amber-900/20"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  Permission required{requests.length > 1 ? ` (${requests.length})` : ''}
                </div>
                <div className="text-xs text-amber-800 dark:text-amber-200">
                  Tool: <span className="font-mono">{first.toolName}</span>
                </div>
              </div>
              {permissionEntry && (
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  Allow rule: <span className="font-mono">{permissionEntry}</span>
                </div>
              )}
            </div>

            {requests.length <= 1 && rawInput && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100">
                  View tool input
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-amber-200/60 bg-white/80 p-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-gray-900/60 dark:text-amber-100">
                  {rawInput}
                </pre>
              </details>
            )}

            {requests.length > 1 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-amber-800 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100">
                  View {requests.length} tool inputs
                </summary>
                <div className="mt-2 space-y-1">
                  {requests.map((r) => {
                    const inp = formatToolInputForDisplay(r.input);
                    return inp ? (
                      <pre key={r.requestId} className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md border border-amber-200/60 bg-white/80 p-2 text-xs text-amber-900 dark:border-amber-800/60 dark:bg-gray-900/60 dark:text-amber-100">
                        {inp}
                      </pre>
                    ) : null;
                  })}
                </div>
              </details>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handlePermissionDecision(allIds, { allow: true })}
                className="inline-flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700"
              >
                Allow once
              </button>
              <button
                type="button"
                onClick={() => {
                  if (permissionEntry && !alreadyAllowed) {
                    handleGrantToolPermission({ entry: permissionEntry, toolName: first.toolName });
                  }
                  handlePermissionDecision(allIds, { allow: true, rememberEntry: permissionEntry });
                }}
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  permissionEntry
                    ? 'border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/30'
                    : 'cursor-not-allowed border-gray-300 text-gray-400'
                }`}
                disabled={!permissionEntry}
              >
                {rememberLabel}
              </button>
              <button
                type="button"
                onClick={() => handlePermissionDecision(allIds, { allow: false, message: 'User denied tool use' })}
                className="inline-flex items-center gap-2 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/30"
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
