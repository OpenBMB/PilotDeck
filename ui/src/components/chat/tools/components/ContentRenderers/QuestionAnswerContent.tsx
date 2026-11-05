import { useTranslation } from 'react-i18next';
import React, { useId, useState } from 'react';
import { Check, ChevronRight, HelpCircle, MessageCircleQuestion } from 'lucide-react';
import { AnimatedDisclosure } from '../../../../ui/AnimatedDisclosure';
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

function normalizeAnswers(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key.trim())
      .filter(([, answer]) => (typeof answer === 'string' && Boolean(answer.trim())) || Array.isArray(answer))
      .map(([key, answer]) => [key, typeof answer === 'string' ? answer
        : (answer as unknown[]).filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))]),
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
  const [view, setView] = useState({ resolved, open: false, expandedIdx: null as number | null });
  let phase = view;
  if (view.resolved !== resolved) {
    phase = { resolved, open: false, expandedIdx: null };
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

  const answerCount = normalizedQuestions.filter(question => normalizedAnswers[question.question]?.length).length;
  const status = !resolved ? t('common:uiText.waitingForAnswer') : answerCount
    ? t('common:uiText.answersProgress', { answered: answerCount, count: normalizedQuestions.length }) : t('common:uiText.skipped');
  const toolBodyId = `${id}-tool`;
  return (
    <div data-question-tool className={`w-full min-w-0 ${className}`}>
      <button type="button" className="chat-process-trigger hover-brand-text" aria-expanded={phase.open} aria-controls={toolBodyId}
        onClick={() => setView({ ...phase, open: !phase.open })}>
        <MessageCircleQuestion aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
        <span>{t('common:uiText.questionTool')}</span>
        <span className="text-muted-foreground">{t('common:uiText.questionsCount', { count: normalizedQuestions.length })}</span>
        <span className="tabular-nums text-muted-foreground">{status}</span>
        <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${phase.open ? 'rotate-90' : ''}`} />
      </button>
      <AnimatedDisclosure id={toolBodyId} expanded={phase.open} contentClassName="ml-[22px] mt-2">
        <div data-question-transcript className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card text-foreground">
      {normalizedQuestions.map((q, idx) => {
        const rawAnswer = normalizedAnswers[q.question];
        const answerLabels = Array.isArray(rawAnswer) ? rawAnswer : typeof rawAnswer === 'string' && rawAnswer.trim()
          ? q.multiSelect && !q.options.some(option => option.label === rawAnswer) ? rawAnswer.split(', ') : [rawAnswer] : [];
        const answer = answerLabels.length ? answerLabels.join(', ') : undefined;
        const expanded = expandedIdx === idx;
        const contentId = `${id}-${idx}`;
        return <div key={q.question} className="min-w-0 border-b border-border/50 last:border-b-0">
          <button type="button" aria-expanded={expanded} aria-controls={contentId}
            onClick={() => setView({ ...phase, expandedIdx: expanded ? null : idx })}
            className="flex w-full min-w-0 items-start gap-2 px-3 py-1.5 text-left text-[13px] leading-5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
            {answer ? <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--brand-strong)]" />
              : <HelpCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">{q.header || q.question}</span>
            {answer && <span className="max-w-[60%] truncate text-foreground" title={answer}>{answer}</span>}
            {(normalizedQuestions.length === 1 || (resolved && !answer)) && <span className="shrink-0 text-[12px] text-muted-foreground">
              {answer ? t('common:uiText.questionAnswered')
                : resolved ? t('common:uiText.skipped') : t('common:uiText.waitingForAnswer')}
            </span>}
            <ChevronRight aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
          </button>
          <AnimatedDisclosure id={contentId} expanded={expanded} keepMounted
            contentClassName="space-y-2 border-t border-border/60 px-3 py-3 text-[13px] leading-5">
              <p>{q.question}</p>
              {answer && <p className="whitespace-pre-wrap break-words font-medium text-foreground">{answer}</p>}
              {q.options.map(option => <div key={option.label} data-answer-selected={answerLabels.includes(option.label)} className={`rounded-lg px-3 py-2 ${answerLabels.includes(option.label) ? 'bg-[var(--brand-soft)] text-foreground' : 'bg-muted/40 text-muted-foreground'}`}>
                <div className="font-medium">{option.label}</div>
                {option.description && <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{option.description}</p>}
              </div>)}
          </AnimatedDisclosure>
        </div>;
      })}
        </div>
      </AnimatedDisclosure>
    </div>
  );
};
