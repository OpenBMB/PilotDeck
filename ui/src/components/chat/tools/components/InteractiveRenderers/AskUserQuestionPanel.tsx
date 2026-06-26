import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Check, ChevronLeft, HelpCircle } from 'lucide-react';
import type { PermissionPanelProps } from '../../configs/permissionPanelRegistry';
import type { ElicitationField, Question } from '../../../types/types';
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

function normalizeField(field: unknown): ElicitationField | null {
  if (!field || typeof field !== 'object') return null;
  const raw = field as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const label = typeof raw.label === 'string' ? raw.label : '';
  const kind = raw.kind === 'secret' || raw.kind === 'multiline' ? raw.kind : 'text';
  if (!id.trim() || !label.trim()) return null;
  return {
    id,
    label,
    kind,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : undefined,
    required: Boolean(raw.required),
  };
}

function normalizeFields(value: unknown): ElicitationField[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeField).filter((field): field is ElicitationField => Boolean(field));
}

export const AskUserQuestionPanel: React.FC<PermissionPanelProps> = ({
  request,
  onDecision,
}) => {
  const input = request.input as { questions?: unknown; fields?: unknown } | undefined;
  const questions = normalizeQuestions(input?.questions);
  const fields = normalizeFields(input?.fields);

  if (fields.length > 0) {
    return (
      <ElicitationInputPanel
        requestId={request.requestId}
        input={input}
        fields={fields}
        onDecision={onDecision}
      />
    );
  }

  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(() => new Map());
  const [otherActive, setOtherActive] = useState<Map<number, boolean>>(() => new Map());
  const [mounted, setMounted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
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
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      const selected = Array.from(selections.get(idx) || []);
      const isOther = otherActive.get(idx) || false;
      const otherText = (otherTexts.get(idx) || '').trim();
      if (isOther && otherText) selected.push(otherText);
      if (selected.length > 0) answers[q.question] = selected.join(', ');
    });
    return answers;
  }, [questions, selections, otherActive, otherTexts]);

  const handleSubmit = useCallback(() => {
    onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: buildAnswers() } });
  }, [onDecision, request.requestId, input, buildAnswers]);

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
  }, [currentStep, questions, toggleOption, toggleOther, handleSubmit, handleSkip]);

  if (questions.length === 0) return null;

  const total = questions.length;
  const isSingle = total === 1;
  const q = questions[currentStep];
  const multi = q.multiSelect || false;
  const selected = selections.get(currentStep) || new Set<string>();
  const isOtherOn = otherActive.get(currentStep) || false;
  const isLast = currentStep === total - 1;
  const isFirst = currentStep === 0;
  const hasCurrentSelection = selected.size > 0 || (isOtherOn && (otherTexts.get(currentStep) || '').trim().length > 0);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'w-full outline-none transition-all duration-300 ease-out',
        mounted ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
      )}
    >
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        {/* Header */}
        <div className="px-4 pb-2 pt-3">
          <div className="mb-1.5 flex items-center gap-2">
            <HelpCircle className="h-4 w-4 flex-shrink-0 text-muted-foreground" strokeWidth={1.75} />

            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Agent needs your input
              </span>
              {q.header && (
                <span className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {q.header}
                </span>
              )}
            </div>

            {!isSingle && (
              <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground">
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
                  aria-label={`Go to question ${i + 1}`}
                  className={cn(
                    'h-[3px] rounded-full transition-all duration-300',
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
          <p className="text-[14px] font-medium leading-snug text-foreground">
            {q.question}
          </p>
          {multi && (
            <span className="text-[10px] text-muted-foreground">Select all that apply</span>
          )}
        </div>

        {/* Options */}
        <div
          className="scrollbar-thin max-h-48 overflow-y-auto px-4 pb-2"
          role={multi ? 'group' : 'radiogroup'}
          aria-label={q.question}
        >
          <div className="space-y-1">
            {q.options.map((opt, optIdx) => {
              const isSelected = selected.has(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => toggleOption(currentStep, opt.label, multi)}
                  aria-pressed={isSelected}
                  className={cn(
                    'group flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                    isSelected
                      ? 'border-foreground/40 bg-accent text-accent-foreground'
                      : 'border-border hover:border-foreground/30 hover:bg-accent/50',
                  )}
                >
                  <kbd
                    className={cn(
                      'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-[10px] transition-colors duration-150',
                      isSelected
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : 'border border-border bg-muted text-muted-foreground',
                    )}
                  >
                    {optIdx + 1}
                  </kbd>

                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'text-[13px] leading-tight',
                        isSelected ? 'font-medium text-foreground' : 'text-foreground/80',
                      )}
                    >
                      {opt.label}
                    </div>
                    {opt.description && (
                      <div className="text-[11px] leading-snug text-muted-foreground">
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
                'group flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                isOtherOn
                  ? 'border-foreground/40 bg-accent text-accent-foreground'
                  : 'border-dashed border-border hover:border-foreground/30 hover:bg-accent/50',
              )}
            >
              <kbd
                className={cn(
                  'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-[10px] transition-colors duration-150',
                  isOtherOn
                    ? 'bg-primary font-semibold text-primary-foreground'
                    : 'border border-border bg-muted text-muted-foreground',
                )}
              >
                0
              </kbd>
              <span
                className={cn(
                  'text-[13px] leading-tight',
                  isOtherOn ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                Other...
              </span>
              {isOtherOn && (
                <Check className="ml-auto h-4 w-4 flex-shrink-0 text-foreground" strokeWidth={2.5} />
              )}
            </button>

            {/* Other text input */}
            {isOtherOn && (
              <div className="pl-[30px] pr-0.5">
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
                        if (isLast) handleSubmit();
                        else setCurrentStep(s => s + 1);
                      }
                      // Prevent container keydown from firing
                      e.stopPropagation();
                    }}
                    placeholder="Type your answer..."
                    className="h-8 pr-14 text-[13px]"
                  />
                  <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                    Enter
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
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {isSingle ? 'Skip' : 'Skip all'}
            <span className="ml-1 font-mono text-[9px] opacity-60">Esc</span>
          </Button>

          <div className="flex items-center gap-1.5">
            {!isSingle && !isFirst && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCurrentStep(s => s - 1)}
                className="h-7 gap-0.5 px-2 text-[11px]"
              >
                <ChevronLeft className="!h-3 !w-3" />
                Back
              </Button>
            )}

            <Button
              type="button"
              size="sm"
              onClick={isLast ? handleSubmit : () => setCurrentStep(s => s + 1)}
              disabled={isLast && !hasCurrentSelection && !Object.keys(buildAnswers()).length}
              className="h-7 gap-1 px-3 text-[11px] font-medium"
            >
              {isLast ? 'Submit' : 'Next'}
              <span className="font-mono text-[9px] opacity-60">Enter</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

type ElicitationInputPanelProps = {
  requestId: string;
  input: { questions?: unknown; fields?: unknown } | undefined;
  fields: ElicitationField[];
  onDecision: PermissionPanelProps['onDecision'];
};

function ElicitationInputPanel({
  requestId,
  input,
  fields,
  onDecision,
}: ElicitationInputPanelProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const inputs: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.id] ?? '';
      if (field.required && value.trim().length === 0) {
        return;
      }
      inputs[field.id] = value;
    }
    onDecision(requestId, { allow: true, updatedInput: { ...input, answers: {}, inputs } });
  }, [fields, input, onDecision, requestId, values]);

  const handleCancel = useCallback(() => {
    onDecision(requestId, { allow: false, message: 'declined' });
  }, [onDecision, requestId]);

  return (
    <div className="w-full rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <HelpCircle className="h-4 w-4 flex-shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Agent needs your input
          </div>
          <div className="text-sm font-medium text-foreground">
            Continue the running command
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {fields.map((field, index) => {
          const commonProps = {
            id: `${requestId}-${field.id}`,
            value: values[field.id] ?? '',
            placeholder: field.placeholder,
            onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
              setValues((current) => ({ ...current, [field.id]: event.target.value })),
            onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
              if (event.key === 'Enter' && field.kind !== 'multiline' && !isImeEnterEvent(event)) {
                event.preventDefault();
                handleSubmit();
              }
            },
          };
          return (
            <label key={field.id} htmlFor={`${requestId}-${field.id}`} className="block space-y-1.5">
              <span className="block text-sm font-medium leading-snug text-foreground">
                {field.label}
              </span>
              {field.description ? (
                <span className="block text-xs leading-snug text-muted-foreground">
                  {field.description}
                </span>
              ) : null}
              {field.kind === 'multiline' ? (
                <textarea
                  {...commonProps}
                  rows={3}
                  className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              ) : (
                <Input
                  {...commonProps}
                  ref={index === 0 ? firstInputRef : undefined}
                  type={field.kind === 'secret' ? 'password' : 'text'}
                  autoComplete={field.kind === 'secret' ? 'current-password' : 'off'}
                />
              )}
            </label>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={handleSubmit}>
          <Check className="h-3.5 w-3.5" />
          Continue
        </Button>
      </div>
    </div>
  );
}
