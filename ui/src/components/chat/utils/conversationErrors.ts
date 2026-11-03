import type { TFunction } from 'i18next';
import type { ChatMessage } from '../types/types';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function translated(t: TFunction, descriptor: unknown, fallback: string): string {
  if (!descriptor || typeof descriptor !== 'object') return fallback;
  const { key, params } = descriptor as { key?: unknown; params?: unknown };
  if (typeof key !== 'string') return fallback;
  return t(key, { ...(params && typeof params === 'object' ? params : {}), defaultValue: fallback });
}

// Provider diagnostics can contain request headers or a URL with credentials.
// Keep useful status/request IDs while keeping those values out of the DOM.
function redactCredentials(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
    .replace(/(["']?\b(?:api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|password|authorization)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'&,;}]+)/gi,
      (_match, label: string, value: string) => label + (/^["']/.test(value) ? `${value[0]}[redacted]${value[0]}` : '[redacted]'))
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s"']+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

// Prefer the server's classified action; older providers only supply raw text.
export function conversationError(message: ChatMessage, t: TFunction) {
  const raw = text(message.content).trim();
  const action = text((message.userHintI18n as { key?: string } | undefined)?.key).split('.').pop();
  const evidence = `${message.errorCode || ''} ${action || ''} ${raw}`;
  const kind = /billing|insufficient[_ ]quota|payment[_ ]required|\b402\b|余额不足|欠费/i.test(evidence) ? 'billing'
    : /context[_ ]?(?:length|window|overflow)|maximum context|too many tokens|上下文.{0,8}(?:超|不足)/i.test(evidence) ? 'context'
    : /payloadTooLarge|payload[_ ]too[_ ]large|\b413\b|request entity too large/i.test(evidence) ? 'payload'
    : /content[_ ]filter|content[_ ]policy|safety violation/i.test(evidence) ? 'filtered'
    : /\b40[13]\b|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?)?key|authentication|\bauth\b/i.test(evidence) ? 'auth'
    : /rateLimit|rate[_ -]limit|too many requests|\b429\b|usage limit reached|限流/i.test(evidence) ? 'rateLimit'
    : /modelNotFound|model[_ -]not[_ -]found|unknown model|model.{0,60}(?:does not exist|not found)/i.test(evidence) ? 'model'
    : /timeout|timed? out|ETIMEDOUT|超时/i.test(evidence) ? 'timeout'
    : /ECONN(?:RESET|REFUSED|ABORTED)|ENOTFOUND|fetch failed|network|socket hang up|网络|连接中断/i.test(evidence) ? 'network'
    : /\b(?:500|502|503|504|529)\b|overloaded|service unavailable|internal server error/i.test(evidence) ? 'server'
    : 'generic';
  const descriptor = message.contentI18n as { key?: string } | undefined;
  // These server messages are already concise. Model-request failures embed the
  // provider response and belong in the disclosure along with the raw details.
  const concise = kind !== 'auth' && typeof descriptor?.key === 'string'
    && descriptor.key.startsWith('agentStatus.')
    && !descriptor.key.startsWith('agentStatus.modelRequestFailed.');
  const title = concise ? translated(t, descriptor, t('conversationError.generic.title'))
    : t(`conversationError.${kind}.title`);
  const hint = concise ? translated(t, message.userHintI18n, text(message.userHint)) || t(`conversationError.${kind}.hint`)
    : t(`conversationError.${kind}.hint`);
  const suppliedCode = text(message.errorCode);
  const code = /^[A-Z][A-Z0-9_:-]{1,63}$/i.test(suppliedCode) && !/^sk-/i.test(suppliedCode) ? suppliedCode : undefined;
  const originalHint = translated(t, message.userHintI18n, text(message.userHint));
  const status = raw.match(/\b(?:401|403)\b/)?.[0];
  // Authentication responses can echo arbitrary partial keys without a
  // recognizable format, so masking known key patterns is insufficient.
  const details = kind === 'auth'
    ? [code, status && `HTTP ${status}`, t('conversationError.authDetails')].filter(Boolean).join('\n\n')
    : redactCredentials([raw, originalHint !== hint && !raw.includes(originalHint) ? originalHint : '', code && !raw.includes(code) ? code : '', text(message.details)].filter(Boolean).join('\n\n'));
  return { title: redactCredentials(title), hint: redactCredentials(hint), details, code };
}
