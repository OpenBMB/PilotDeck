import React from 'react';
import { ClipboardList, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Markdown } from '../../../view/subcomponents/Markdown';

interface PlanApprovedCardProps {
  planTitle: string;
  planSummary: string;
  planFilePath: string;
  onViewPlan: () => void;
}

export const PlanApprovedCard: React.FC<PlanApprovedCardProps> = ({
  planTitle,
  planSummary,
  planFilePath,
  onViewPlan,
}) => {
  const { t } = useTranslation('chat');
  const hasFilePath = Boolean(planFilePath);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--pd-accent-border,#c7d2fe)] bg-white dark:border-indigo-900/60 dark:bg-neutral-900">
      <div className="flex items-center gap-2.5 border-b border-[var(--pd-accent-border,#e0e7ff)] bg-[var(--pd-accent-soft,#eef2ff)]/50 px-4 py-2.5 dark:border-indigo-900/50 dark:bg-indigo-950/20">
        <ClipboardList className="h-4 w-4 shrink-0 text-[var(--pd-accent-strong,#4f46e5)] dark:text-indigo-400" strokeWidth={2} />
        <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {planTitle}
        </span>
      </div>

      {planSummary && (
        <div className="max-h-28 overflow-hidden px-4 py-2.5">
          <Markdown className="prose prose-sm max-w-none text-xs leading-relaxed text-neutral-600 dark:prose-invert dark:text-neutral-400 prose-table:my-0 prose-th:px-2 prose-th:py-0.5 prose-td:px-2 prose-td:py-0.5">
            {planSummary}
          </Markdown>
        </div>
      )}

      <div className="flex items-center justify-end border-t border-[var(--pd-accent-border,#e0e7ff)] px-4 py-2 dark:border-indigo-900/50">
        <button
          type="button"
          onClick={onViewPlan}
          disabled={!hasFilePath}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--pd-accent-border,#c7d2fe)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--pd-accent-strong,#4338ca)] transition hover:bg-[var(--pd-accent-soft,#eef2ff)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-indigo-800 dark:bg-neutral-900 dark:text-indigo-300 dark:hover:bg-indigo-950/30"
        >
          <FileText className="h-3.5 w-3.5" strokeWidth={2} />
          {t('plan.approvedCard.viewPlan', { defaultValue: 'View Plan' })}
        </button>
      </div>
    </div>
  );
};
