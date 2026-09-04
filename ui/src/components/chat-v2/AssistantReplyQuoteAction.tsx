import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { createAssistantReplyContentReference } from '../../types/assistantReplyReference';

const floatingQuoteActionClassName = [
  'border border-neutral-200 bg-white text-neutral-900 shadow-lg',
  'dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100',
  'rounded-full px-3 py-1.5 text-[12px] font-medium transition',
  'hover:bg-neutral-50 dark:hover:bg-neutral-900',
].join(' ');

type QuoteAction = {
  top: number;
  left: number;
  reference: ReturnType<typeof createAssistantReplyContentReference>;
};

function surroundingText(text: string, selectedText: string, radius = 300) {
  const index = text.indexOf(selectedText);
  if (index < 0) return text.slice(0, radius * 2);
  return text.slice(
    Math.max(0, index - radius),
    Math.min(text.length, index + selectedText.length + radius),
  );
}

function getQuoteSource(range: Range): HTMLElement | null {
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const source = element?.closest<HTMLElement>('[data-assistant-quote-source]');
  if (!source) return null;
  if (!source.contains(range.startContainer) || !source.contains(range.endContainer)) {
    return null;
  }
  return source;
}

function positionQuoteAction(rangeRect: DOMRect) {
  const actionWidth = 220;
  const actionHeight = 36;
  const gap = 8;
  const padding = 8;
  const left = Math.min(
    window.innerWidth - actionWidth - padding,
    Math.max(padding, rangeRect.left + rangeRect.width / 2 - actionWidth / 2),
  );
  const below = rangeRect.bottom + gap;
  const above = rangeRect.top - actionHeight - gap;
  const top = below + actionHeight <= window.innerHeight - padding
    ? below
    : Math.max(padding, above);
  return { top, left };
}

export default function AssistantReplyQuoteAction() {
  const { t } = useTranslation('chat');
  const [action, setAction] = useState<QuoteAction | null>(null);
  const timerRef = useRef<number | null>(null);

  const updateAction = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const source = getQuoteSource(range);
    if (!source) {
      setAction(null);
      return;
    }
    const selectedText = selection.toString().replace(/\u00a0/g, ' ').trim();
    if (!selectedText) {
      setAction(null);
      return;
    }
    const rangeRect = range.getBoundingClientRect();
    if (rangeRect.width === 0 && rangeRect.height === 0) {
      setAction(null);
      return;
    }
    const documentText = source.textContent?.replace(/\s+/g, ' ').trim() || selectedText;
    const { top, left } = positionQuoteAction(rangeRect);
    setAction({
      top,
      left,
      reference: createAssistantReplyContentReference({
        selectedText,
        surroundingText: surroundingText(documentText, selectedText),
        messageId: source.getAttribute('data-assistant-quote-message-id') || undefined,
      }),
    });
  }, []);

  useEffect(() => {
    const schedule = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(updateAction, 40);
    };
    const clear = () => setAction(null);
    document.addEventListener('selectionchange', clear);
    document.addEventListener('mouseup', schedule);
    document.addEventListener('touchend', schedule);
    document.addEventListener('keyup', schedule);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      document.removeEventListener('selectionchange', clear);
      document.removeEventListener('mouseup', schedule);
      document.removeEventListener('touchend', schedule);
      document.removeEventListener('keyup', schedule);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, [updateAction]);

  if (!action || typeof document === 'undefined') return null;

  return createPortal(
    <button
      type="button"
      data-assistant-quote-action=""
      className={`fixed z-[10050] whitespace-nowrap ${floatingQuoteActionClassName}`}
      style={{ top: action.top, left: action.left }}
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        window.dispatchEvent(new CustomEvent('pilotdeck:add-chat-reference', {
          detail: action.reference,
        }));
        window.getSelection()?.removeAllRanges();
        setAction(null);
      }}
    >
      {t('replyQuotes.addToChat', { defaultValue: '添加到PilotDeck对话' })}
    </button>,
    document.body,
  );
}
