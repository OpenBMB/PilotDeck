import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, ClipboardList, MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PermissionPanelProps } from '../../configs/permissionPanelRegistry';
import { MarkdownContent } from '../ContentRenderers/MarkdownContent';

const EXIT_PLAN_MODE_QUESTION = 'What should happen next?';

function normalizePlanText(text: string): string {
  return text.replace(/\\n/g, '\n').trim();
}

function stringifyPlanCandidate(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = normalizePlanText(value);
    return normalized || null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => stringifyPlanCandidate(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['plan', 'planContent', 'content', 'markdown', 'text', 'body']) {
    const candidate = stringifyPlanCandidate(record[key]);
    if (candidate) return candidate;
  }

  return null;
}

export function extractPlanMarkdown(input: unknown): string {
  const plan = stringifyPlanCandidate(input);
  if (plan) return plan;

  if (input === undefined || input === null) {
    return '';
  }

  if (typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    const onlyPermissionHints = keys.length === 0 || keys.every((key) => (
      key === 'allowedPrompts' ||
      key === 'planFilePath'
    ));
    if (onlyPermissionHints) {
      return '';
    }
  }

  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export const ExitPlanModePanel: React.FC<PermissionPanelProps> = ({
  request,
  onDecision,
  onPlanExecutionApproved,
}) => {
  const { t } = useTranslation('chat');
  const [feedback, setFeedback] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const plan = useMemo(() => {
    const extracted = extractPlanMarkdown(request.input);
    return extracted || t('plan.exitMode.syncingPlan');
  }, [request.input, t]);

  const handleExecute = () => {
    onPlanExecutionApproved?.();
    onDecision(request.requestId, {
      allow: true,
      updatedInput: {
        answers: {
          [EXIT_PLAN_MODE_QUESTION]: 'execute_plan',
        },
      },
    });
  };

  const handleContinuePlanning = () => {
    const trimmed = feedback.trim();
    onDecision(request.requestId, {
      allow: true,
      updatedInput: {
        answers: {
          [EXIT_PLAN_MODE_QUESTION]: 'continue_planning',
        },
        ...(trimmed
          ? {
              annotations: {
                [EXIT_PLAN_MODE_QUESTION]: {
                  notes: trimmed,
                },
              },
            }
          : {}),
      },
    });
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--pd-accent-border,#bfdbfe)] bg-white shadow-lg dark:border-[var(--pd-accent-border,#1e3a8a)] dark:bg-neutral-900">
      <div className="border-b border-[var(--pd-accent-border,#dbeafe)] bg-[var(--pd-accent-soft,#eff6ff)] px-4 py-3 dark:border-[var(--pd-accent-border,#1e3a8a)] dark:bg-[var(--pd-accent-selected,#172554)]">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--pd-accent-soft,#dbeafe)] text-[var(--pd-accent-strong,#1d4ed8)] dark:bg-[var(--pd-accent-soft,#1e3a8a)] dark:text-[var(--pd-accent-strong,#93c5fd)]">
            <ClipboardList className="h-4 w-4" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-neutral-950 dark:text-neutral-50">
              {t('plan.exitMode.header')}
            </div>
            <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
              {t('plan.exitMode.subtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            className="ml-auto shrink-0 rounded-md p-1 text-neutral-500 transition hover:bg-neutral-200/60 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label={collapsed ? 'Expand plan' : 'Collapse plan'}
          >
            {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="min-h-[200px] max-h-[50vh] overflow-y-auto px-4 py-3">
          <MarkdownContent
            content={plan}
            className="prose prose-sm max-w-none text-neutral-800 dark:prose-invert dark:text-neutral-200"
          />
        </div>
      )}

      <div className="border-t border-neutral-100 bg-neutral-50/70 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950/40">
        <label className="mb-2 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
          {t('plan.exitMode.feedbackLabel')}
        </label>
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={3}
          placeholder={t('plan.exitMode.feedbackPlaceholder')}
          className="block w-full resize-none rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-[var(--pd-focus,#93c5fd)] focus:ring-2 focus:ring-[var(--pd-focus,#dbeafe)] dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-[var(--pd-focus,#1d4ed8)] dark:focus:ring-[var(--pd-focus,#172554)]"
        />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={handleContinuePlanning}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            <MessageSquareText className="h-3.5 w-3.5" strokeWidth={2} />
            {t('plan.exitMode.continueButton')}
          </button>
          <button
            type="button"
            onClick={handleExecute}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--pd-accent,#2563eb)] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[var(--pd-button-hover,#1d4ed8)] dark:bg-[var(--pd-accent,#3b82f6)] dark:hover:bg-[var(--pd-button-hover,#2563eb)]"
          >
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
            {t('plan.exitMode.executeButton')}
          </button>
        </div>
      </div>
    </div>
  );
};
