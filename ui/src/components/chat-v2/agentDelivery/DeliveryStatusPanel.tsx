import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Copy,
  FileText,
  XCircle,
} from 'lucide-react';
import type { DeliveryAttemptView, DeliveryResultView } from './deliveryStatus';

type DeliveryStatusPanelProps = {
  delivery: DeliveryResultView;
  deliveryFile?: string;
};

type Tone = 'passed' | 'failed' | 'neutral' | 'warning';

function statusTone(status: string): Tone {
  if (status === 'passed' || status === 'accepted') return 'passed';
  if (status === 'failed' || status === 'rejected' || status === 'error') return 'failed';
  if (status === 'inconclusive') return 'warning';
  return 'neutral';
}

const TONE_ICON_CLASS: Record<Tone, string> = {
  passed: 'text-green-500 dark:text-green-400',
  failed: 'text-red-500 dark:text-red-400',
  warning: 'text-amber-500 dark:text-amber-400',
  neutral: 'text-neutral-400 dark:text-neutral-500',
};

function StatusIcon({ status }: { status: string }) {
  const tone = statusTone(status);
  const className = `h-3 w-3 shrink-0 ${TONE_ICON_CLASS[tone]}`;
  if (tone === 'passed') return <CheckCircle2 className={className} strokeWidth={2} />;
  if (tone === 'failed') return <XCircle className={className} strokeWidth={2} />;
  if (tone === 'warning') return <AlertCircle className={className} strokeWidth={2} />;
  return <CircleSlash className={className} strokeWidth={2} />;
}

/**
 * Compact, expandable delivery receipt for a finished subagent.
 *
 * Shows program checks and the optional model review separately, keeps the
 * receipt path copyable, and defaults to the latest attempt only — history
 * stays behind an explicit toggle. `skipped`/`inconclusive` are rendered
 * neutral/amber and never look accepted; task completion alone never
 * implies acceptance.
 */
export default function DeliveryStatusPanel({ delivery, deliveryFile }: DeliveryStatusPanelProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  const latest = delivery.attempts.length > 0 ? delivery.attempts[delivery.attempts.length - 1] : undefined;
  const olderAttempts = useMemo(
    () => (latest && delivery.attempts.length > 1 ? delivery.attempts.slice(0, -1) : []),
    [delivery.attempts, latest],
  );
  const receiptPath = deliveryFile || delivery.deliveryFile || latest?.deliveryFile || '';

  const overallLabel = delivery.status === 'passed'
    // "passed" is scoped: applicable program checks passed (plus review when
    // requested). It is never a blanket claim about overall task quality.
    ? t('subagent.delivery.status.passedScoped', { defaultValue: '已执行检查通过' })
    : t(`subagent.delivery.status.${delivery.status}`, { defaultValue: delivery.status });
  const checksLabel = latest
    ? t('subagent.delivery.summaryLine', {
        defaultValue: '程序检查 {{checks}} · 模型评审 {{review}}',
        checks: t(`subagent.delivery.checkStatus.${latest.checks.status}`, { defaultValue: latest.checks.status }),
        review: latest.review
          ? t(`subagent.delivery.reviewStatus.${latest.review.status}`, { defaultValue: latest.review.status })
          : t('subagent.delivery.reviewNotRequested', { defaultValue: '未请求' }),
      })
    : t('subagent.delivery.noAttempts', { defaultValue: '无尝试记录' });

  const copyReceipt = async () => {
    if (!receiptPath) return;
    try {
      await navigator.clipboard.writeText(receiptPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions); the path stays visible/selectable.
    }
  };

  return (
    <div
      className="mt-1 ml-[22px] cursor-default overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-neutral-600 transition-colors hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800/60"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <StatusIcon status={delivery.status} />
        <span className={`shrink-0 font-medium ${
          statusTone(delivery.status) === 'passed'
            ? 'text-green-600 dark:text-green-400'
            : statusTone(delivery.status) === 'failed'
              ? 'text-red-600 dark:text-red-400'
              : ''
        }`}>
          {t('subagent.delivery.title', { defaultValue: '交付验收' })}: {overallLabel}
        </span>
        <span className="min-w-0 flex-1 truncate text-neutral-400 dark:text-neutral-500">{checksLabel}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          strokeWidth={2}
        />
      </button>

      {expanded ? (
        <div className="border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
          {receiptPath ? (
            <div className="mb-1.5 flex items-start gap-1.5 text-[11px]">
              <FileText className="mt-0.5 h-3 w-3 shrink-0 text-neutral-400" strokeWidth={2} />
              {/* Selectable + wrapped so the full workspace path stays
                  readable even when it is long; title mirrors the full text. */}
              <code
                title={receiptPath}
                className="min-w-0 flex-1 select-all break-all rounded bg-neutral-100 px-1 py-0.5 font-mono leading-relaxed text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {receiptPath}
              </code>
              <button
                type="button"
                className="mt-0.5 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                aria-label={t('subagent.delivery.copyReceipt', { defaultValue: '复制回执路径' })}
                onClick={() => void copyReceipt()}
              >
                {copied ? (
                  <Check className="h-3 w-3 text-green-500" strokeWidth={2} />
                ) : (
                  <Copy className="h-3 w-3" strokeWidth={2} />
                )}
              </button>
            </div>
          ) : null}

          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('subagent.delivery.repairs', { defaultValue: '修复次数' })}: {delivery.repairs}
            {delivery.producerTotalTokens !== undefined
              ? ` · ${t('subagent.delivery.producerTokens', { defaultValue: '生成 {{count}} tokens', count: delivery.producerTotalTokens })}`
              : ''}
          </span>

          {latest ? <AttemptDetail attempt={latest} /> : null}

          {olderAttempts.length > 0 ? (
            <div className="mt-1">
              <button
                type="button"
                className="text-[11px] text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
                aria-expanded={showHistory}
                onClick={() => setShowHistory((value) => !value)}
              >
                {showHistory
                  ? t('subagent.delivery.hideHistory', { defaultValue: '收起历史尝试' })
                  : t('subagent.delivery.showHistory', {
                      defaultValue: '查看全部 {{count}} 次尝试',
                      count: delivery.attempts.length,
                    })}
              </button>
              {showHistory ? (
                <div className="mt-1 space-y-1.5">
                  {olderAttempts.map((attempt) => (
                    <AttemptDetail key={attempt.attempt} attempt={attempt} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AttemptDetail({ attempt }: { attempt: DeliveryAttemptView }) {
  const { t } = useTranslation('chat');
  const review = attempt.review;
  return (
    <div className="mt-1.5 space-y-1 border-l border-neutral-200 pl-2 dark:border-neutral-700">
      <div className="flex items-center gap-1.5 text-[11px]">
        <StatusIcon status={attempt.checks.status} />
        <span className="font-medium text-neutral-600 dark:text-neutral-300">
          {t('subagent.delivery.programChecks', { defaultValue: '程序检查' })}
          {' '}· #{attempt.attempt}
        </span>
        <span className="text-neutral-500 dark:text-neutral-400">
          {t(`subagent.delivery.checkStatus.${attempt.checks.status}`, { defaultValue: attempt.checks.status })}
          {attempt.checks.checked > 0
            ? ` · ${t('subagent.delivery.checkedCount', { defaultValue: '{{count}} 项', count: attempt.checks.checked })}`
            : ''}
        </span>
      </div>
      {attempt.checks.reason ? (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{attempt.checks.reason}</p>
      ) : null}
      {attempt.checks.issues.map((issue, index) => (
        <p key={`${issue.path}-${index}`} className="text-[11px] text-red-600 dark:text-red-400">
          {issue.path || issue.code}: {issue.message}
        </p>
      ))}

      <div className="flex items-center gap-1.5 text-[11px]">
        <StatusIcon status={review?.status ?? 'skipped'} />
        <span className="font-medium text-neutral-600 dark:text-neutral-300">
          {t('subagent.delivery.modelReview', { defaultValue: '模型评审' })}
        </span>
        <span className="text-neutral-500 dark:text-neutral-400">
          {review
            ? t(`subagent.delivery.reviewStatus.${review.status}`, { defaultValue: review.status })
            : t('subagent.delivery.reviewNotRequested', { defaultValue: '未请求' })}
          {review?.modelLabel ? ` · ${review.modelLabel}` : ''}
          {review?.durationMs !== undefined
            ? ` · ${(review.durationMs / 1000).toFixed(1)}s`
            : ''}
          {review?.totalTokens !== undefined
            ? ` · ${t('subagent.delivery.reviewTokens', { defaultValue: '评审 {{count}} tokens', count: review.totalTokens })}`
            : ''}
        </span>
      </div>
      {review?.summary ? (
        <p className="whitespace-pre-wrap break-words text-[11px] text-neutral-500 dark:text-neutral-400">
          {review.summary}
        </p>
      ) : null}
      {(review?.issues ?? []).map((issue, index) => (
        <p key={`${issue.path}-${index}`} className="text-[11px] text-red-600 dark:text-red-400">
          {issue.path || issue.code}: {issue.message}
        </p>
      ))}
    </div>
  );
}
