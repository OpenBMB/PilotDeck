import { useTranslation } from 'react-i18next';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Check, ChevronLeft, HelpCircle } from 'lucide-react';
import type { PermissionPanelProps } from '../../configs/permissionPanelRegistry';
import type { Question } from '../../../types/types';
import { Button } from '../../../../ui/button';
import { Input } from '../../../../ui/input';
import { cn } from '../../../../../lib/utils.js';
import { isImeEnterEvent } from '../../../../../utils/ime';

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

  return {
    question: text,
    header: typeof raw.header === 'string' ? raw.header : undefined,
    options: Array.isArray(raw.options)
      ? raw.options.map(normalizeOption).filter((option): option is NonNullable<ReturnType<typeof normalizeOption>> => Boolean(option))
      : [],
    multiSelect: Boolean(raw.multiSelect),
  };
}

function normalizeQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeQuestion).filter((question): question is Question => Boolean(question));
}

export const AskUserQuestionPanel: React.FC<PermissionPanelProps> = ({
  request,
  onDecision,
}) => {
  const { t } = useTranslation('common');
  const input = request.input as { questions?: unknown } | undefined;
  const questions = normalizeQuestions(input?.questions);

  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(() => new Map());
  const [otherActive, setOtherActive] = useState<Map<number, boolean>>(() => new Map());
  const [mounted, setMounted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Focus the container for keyboard events when step changes
  useEffect(() => {
    if (!otherActive.get(currentStep)) {
      containerRef.current?.focus();
    }
  }, [currentStep, otherActive]);

  useEffect(() => {
    if (otherActive.get(currentStep)) {
      otherInputRef.current?.focus();
    }
  }, [otherActive, currentStep]);

  const toggleOption = useCallback((qIdx: number, label: string, multiSelect: boolean) => {
    setSelections(prev => {
      const next = new Map(prev);
      const current = new Set(next.get(qIdx) || []);
      if (multiSelect) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
        setOtherActive(p => { const n = new Map(p); n.set(qIdx, false); return n; });
      }
      next.set(qIdx, current);
      return next;
    });
  }, []);

  const toggleOther = useCallback((qIdx: number, multiSelect: boolean) => {
    setOtherActive(prev => {
      const next = new Map(prev);
      const wasActive = next.get(qIdx) || false;
      next.set(qIdx, !wasActive);
      if (!multiSelect && !wasActive) {
        setSelections(p => { const n = new Map(p); n.set(qIdx, new Set()); return n; });
      }
      return next;
    });
  }, []);

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts(prev => { const next = new Map(prev); next.set(qIdx, text); return next; });
  }, []);

  const buildAnswers = useCallback(() => {
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, idx) => {
      const selected = Array.from(selections.get(idx) || []);
      const isOther = otherActive.get(idx) || false;
      const otherText = (otherTexts.get(idx) || '').trim();
      if (isOther && otherText) selected.push(otherText);
      if (selected.length > 0) answers[q.question] = q.multiSelect ? selected : selected[0];
    });
    return answers;
  }, [questions, selections, otherActive, otherTexts]);

  const hasSelectionForStep = useCallback((qIdx: number) => {
    const selected = selections.get(qIdx) || new Set<string>();
    const isOther = otherActive.get(qIdx) || false;
    const otherText = (otherTexts.get(qIdx) || '').trim();
    return selected.size > 0 || (isOther && otherText.length > 0);
  }, [selections, otherActive, otherTexts]);

  const handleSubmit = useCallback(() => {
    const answers = buildAnswers();
    if (Object.keys(answers).length !== questions.length) return;
    onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers } });
  }, [onDecision, request.requestId, input, buildAnswers, questions.length]);

  const handleSkip = useCallback(() => {
    onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: {} } });
  }, [onDecision, request.requestId, input]);

  // Keyboard handler for number keys and navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't capture keys when typing in the "Other" input
    if (e.target instanceof HTMLInputElement) return;

    const q = questions[currentStep];
    if (!q) return;
    const multi = q.multiSelect || false;
    const optCount = q.options.length;

    // Number keys 1-9 for options
    const num = parseInt(e.key);
    if (!isNaN(num) && num >= 1 && num <= optCount) {
      e.preventDefault();
      toggleOption(currentStep, q.options[num - 1].label, multi);
      return;
    }

    // 0 for "Other"
    if (e.key === '0') {
      e.preventDefault();
      toggleOther(currentStep, multi);
      return;
    }

    // Enter to advance / submit
    if (e.key === 'Enter') {
      if (isImeEnterEvent(e)) {
        return;
      }
      e.preventDefault();
      if (!hasSelectionForStep(currentStep)) return;
      const isLast = currentStep === questions.length - 1;
      if (isLast) handleSubmit();
      else setCurrentStep(s => s + 1);
      return;
    }

    // Escape to skip
    if (e.key === 'Escape') {
      e.preventDefault();
      handleSkip();
      return;
    }
  }, [currentStep, questions, toggleOption, toggleOther, handleSubmit, handleSkip, hasSelectionForStep]);

  if (questions.length === 0) return null;

  const total = questions.length;
  const isSingle = total === 1;
  const q = questions[currentStep];
  const multi = q.multiSelect || false;
  const selected = selections.get(currentStep) || new Set<string>();
  const isOtherOn = otherActive.get(currentStep) || false;
  const isLast = currentStep === total - 1;
  const isFirst = currentStep === 0;
  const hasCurrentSelection = hasSelectionForStep(currentStep);
  const allQuestionsAnswered = questions.every((_, idx) => hasSelectionForStep(idx));

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'w-full outline-none transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
        mounted ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
      )}
    >
      <div data-question-panel className="overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-sm">
        {/* Header */}
        <div className="px-3 pb-2.5 pt-3">
          <div className="mb-1.5 flex items-center gap-2">
            <HelpCircle className="h-4 w-4 flex-shrink-0 text-muted-foreground" strokeWidth={1.75} />

            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-[12px] font-medium leading-5 text-muted-foreground">
                {t('common:uiText.questionTitle')}
              </span>
              {q.header && (
                <span className="inline-flex max-w-full items-center truncate rounded-md bg-muted px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
                  {q.header}
                </span>
              )}
            </div>

            {!isSingle && (
              <span className="flex-shrink-0 text-[12px] tabular-nums text-muted-foreground">
                {currentStep + 1}/{total}
              </span>
            )}
          </div>

          {/* Progress dots */}
          {!isSingle && (
            <div className="mb-2 flex items-center gap-1">
              {questions.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setCurrentStep(i)}
                  aria-label={t("common:uiText.goToQuestion", { number: i + 1 })}
                  className={cn(
                    'h-[3px] rounded-full transition-all duration-200 motion-reduce:transition-none',
                    i === currentStep
                      ? 'w-5 bg-foreground'
                      : i < currentStep
                        ? 'w-2.5 bg-foreground/40'
                        : 'w-2.5 bg-muted',
                  )}
                />
              ))}
            </div>
          )}

          {/* Question text */}
          <p className="text-[14px] font-medium leading-[22px] text-foreground">
            {q.question}
          </p>
          {multi && (
            <span className="text-[12px] leading-5 text-muted-foreground">{t('common:uiText.selectMultiple')}</span>
          )}
        </div>

        {/* Options */}
        <div
          className="scrollbar-thin max-h-[min(38vh,280px)] overflow-y-auto overscroll-contain px-3 pb-2.5"
          role="group"
          aria-label={q.question}
        >
          <div className="space-y-1.5">
            {q.options.map((opt, optIdx) => {
              const isSelected = selected.has(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => toggleOption(currentStep, opt.label, multi)}
                  aria-pressed={isSelected}
                  className={cn(
                    'group flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]',
                    isSelected
                      ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-foreground'
                      : 'border-border/60 hover:border-border hover:bg-muted/60',
                  )}
                >
                  <kbd
                    className={cn(
                      'mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-[11px] tabular-nums transition-colors duration-150',
                      isSelected
                        ? 'bg-[var(--brand)] font-medium text-white'
                        : 'border border-border bg-muted text-muted-foreground',
                    )}
                  >
                    {optIdx + 1}
                  </kbd>

                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'text-[13px] leading-5',
                        isSelected ? 'font-medium text-foreground' : 'text-foreground/80',
                      )}
                    >
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div className="mt-0.5 text-[12px] leading-[18px] text-muted-foreground">
                        {opt.description}
                      </div>
                    )}
                  </div>

                  {isSelected && (
                    <Check className="h-4 w-4 flex-shrink-0 text-foreground" strokeWidth={2.5} />
                  )}
                </button>
              );
            })}

            {/* "Other" option */}
            <button
              type="button"
              onClick={() => toggleOther(currentStep, multi)}
              aria-pressed={isOtherOn}
              className={cn(
                'group flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]',
                isOtherOn
                  ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-foreground'
                  : 'border-dashed border-border/60 hover:border-border hover:bg-muted/60',
              )}
            >
              <kbd
                className={cn(
                  'mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-[11px] tabular-nums transition-colors duration-150',
                  isOtherOn
                    ? 'bg-[var(--brand)] font-medium text-white'
                    : 'border border-border bg-muted text-muted-foreground',
                )}
              >
                0
              </kbd>
              <span
                className={cn(
                  'text-[13px] leading-5',
                  isOtherOn ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {t('common:uiText.other')}
              </span>
              {isOtherOn && (
                <Check className="ml-auto h-4 w-4 flex-shrink-0 text-foreground" strokeWidth={2.5} />
              )}
            </button>

            {/* Other text input */}
            {isOtherOn && (
              <div className="pl-8 pr-0.5">
                <div className="relative">
                  <Input
                    ref={otherInputRef}
                    type="text"
                    value={otherTexts.get(currentStep) || ''}
                    onChange={(e) => setOtherText(currentStep, e.target.value)}
                    onKeyDown={(e) => {
                      if (isImeEnterEvent(e)) {
                        e.stopPropagation();
                        return;
                      }
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (!hasSelectionForStep(currentStep)) {
                          e.stopPropagation();
                          return;
                        }
                        if (isLast) handleSubmit();
                        else setCurrentStep(s => s + 1);
                      }
                      // Prevent container keydown from firing
                      e.stopPropagation();
                    }}
                    placeholder={t("common:uiText.typeAnswer")}
                    className="h-9 pr-14 text-[13px]"
                  />
                  <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {t('common:keyboard.enter')}
                  </kbd>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            className="h-8 px-2 text-[13px] text-muted-foreground hover:text-foreground"
          >
            {isSingle ? t('common:uiText.skip') : t('common:uiText.skipAll')}
            <span className="ml-1 font-mono text-[11px] opacity-60">{t('common:keyboard.escape')}</span>
          </Button>

          <div className="flex items-center gap-1.5">
            {!isSingle && !isFirst && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCurrentStep(s => s - 1)}
                className="h-8 gap-1 px-2 text-[13px]"
              >
                <ChevronLeft className="!h-3 !w-3" />
                {t('common:uiText.back')}
              </Button>
            )}

            <Button
              type="button"
              size="sm"
              onClick={isLast ? handleSubmit : () => setCurrentStep(s => s + 1)}
              disabled={!hasCurrentSelection || (isLast && !allQuestionsAnswered)}
              className="h-8 gap-2 px-3 text-[13px] font-medium"
            >
              {isLast ? t('common:uiText.submit') : t('common:uiText.next')}
              <span className="font-mono text-[11px] opacity-60">{t('common:keyboard.enter')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
