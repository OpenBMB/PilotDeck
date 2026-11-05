import { useTranslation } from 'react-i18next';
import React, { useId, useState } from 'react';
import { Check, ChevronRight, HelpCircle } from 'lucide-react';
import type { Question } from '../../../types/types';

interface QuestionAnswerContentProps {
  questions: unknown;
  answers: unknown;
  resolved?: boolean;
  className?: string;
}

function normalizeOption(option: unknown) {
  if (!option || typeof option !== 'object') return null;
  const raw = option as Record<string, unknown>;
  const label = typeof raw.label === 'string' ? raw.label : '';
  if (!label.trim()) return null;
  return {
    label,
    description: typeof raw.description === 'string' ? raw.description : undefined,
  };
}

function normalizeQuestion(question: unknown): Question | null {
  if (!question || typeof question !== 'object') return null;
  const raw = question as Record<string, unknown>;
  const text = typeof raw.question === 'string' ? raw.question : '';
  if (!text.trim()) return null;

  const options = Array.isArray(raw.options)
    ? raw.options.map(normalizeOption).filter((option): option is NonNullable<ReturnType<typeof normalizeOption>> => Boolean(option))
    : [];

  return {
    question: text,
    header: typeof raw.header === 'string' ? raw.header : undefined,
    options,
    multiSelect: Boolean(raw.multiSelect),
  };
}

function normalizeQuestions(value: unknown): Question[] {
  if (Array.isArray(value)) {
    return value.map(normalizeQuestion).filter((question): question is Question => Boolean(question));
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== value) return normalizeQuestions(parsed);
    } catch {
      // Invalid tool payloads are rendered as a non-fatal warning below.
    }
  }

  return [];
}

function normalizeAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.trim())
      .map(([key, answer]) => [key, typeof answer === 'string' ? answer : String(answer ?? '')]),
  );
}

function formatInvalidPayload(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Exception to the stateless ContentRenderer pattern: multi-question navigation requires local state.
export const QuestionAnswerContent: React.FC<QuestionAnswerContentProps> = ({
  questions,
  answers,
  resolved = false,
  className = '',
}) => {
  const { t } = useTranslation('common');
  const id = useId();
  const [view, setView] = useState({ resolved, expandedIdx: null as number | null });
  let phase = view;
  if (view.resolved !== resolved) {
    phase = { resolved, expandedIdx: null };
    setView(phase);
  }
  const { expandedIdx } = phase;
  const normalizedQuestions = normalizeQuestions(questions);
  const normalizedAnswers = normalizeAnswers(answers);

  if (normalizedQuestions.length === 0) {
    if (questions === undefined || questions === null || questions === '') {
      return null;
    }

    return (
      <div className={`rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-200 ${className}`}>
        <div className="font-medium">{t('common:uiText.invalidQuestion')}</div>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] opacity-80">
          {formatInvalidPayload(questions)}
        </pre>
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      {normalizedQuestions.map((q, idx) => {
        const answer = normalizedAnswers[q.question];
        const expanded = expandedIdx === idx;
        const contentId = `${id}-${idx}`;
        return <div key={q.question} className="min-w-0 rounded-xl border border-border/70 bg-card text-foreground">
          <button type="button" aria-expanded={expanded} aria-controls={contentId}
            onClick={() => setView({ ...phase, expandedIdx: expanded ? null : idx })}
            className="flex w-full min-w-0 items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] leading-5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
            {answer ? <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--brand-strong)]" />
              : <HelpCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{q.header || q.question}</span>
              {answer && <span className="mt-1 block whitespace-pre-wrap break-words text-muted-foreground">{answer}</span>}
            </span>
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {answer ? t('common:uiText.questionAnswered')
                : resolved ? t('common:uiText.skipped') : t('common:uiText.waitingForAnswer')}
            </span>
            <ChevronRight aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
          </button>
          <div id={contentId} className="chat-process-disclosure" data-expanded={expanded} aria-hidden={!expanded}
            {...(!expanded ? { inert: '' } : {})}>
            <div className="min-h-0 overflow-hidden"><div className="space-y-2 border-t border-border/60 px-3 py-3 text-[13px] leading-5">
              <p>{q.question}</p>
              {q.options.map(option => <div key={option.label} className={`rounded-lg px-3 py-2 ${answer?.split(', ').includes(option.label) ? 'bg-[var(--brand-soft)] text-foreground' : 'bg-muted/40 text-muted-foreground'}`}>
                <div className="font-medium">{option.label}</div>
                {option.description && <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{option.description}</p>}
              </div>)}
            </div></div>
          </div>
        </div>;
      })}
    </div>
  );
};
