// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it } from 'vitest';
import { createTestI18n } from '../../../../i18n/testInstance';
import MessageRowV2 from '../../../chat-v2/MessageRowV2';
import MessageComponent from './MessageComponent';
import { conversationError } from '../../utils/conversationErrors';

afterEach(cleanup);
it.each([
  ['401 invalid_api_key', 'auth'], ['429 insufficient_quota', 'billing'],
  ['429 Too Many Requests', 'rateLimit'], ['context_length_exceeded', 'context'],
  ['413 Request Entity Too Large', 'payload'], ['content_filter', 'filtered'],
  ['model_not_found', 'model'], ['stream idle timeout', 'timeout'],
  ['ECONNRESET socket hang up', 'network'], ['503 Service Unavailable', 'server'],
  ['Unexpected provider failure', 'generic'],
])('explains %s without displaying the provider response as the summary', async (content, kind) => {
  const i18n = await createTestI18n('zh-CN');
  const t = i18n.getFixedT('zh-CN', 'chat');
  const error = conversationError({ type: 'error', content, timestamp: 0 }, t);
  expect(error.title).toBe(t(`conversationError.${kind}.title`));
  if (kind === 'auth') {
    expect(error.details).toContain('HTTP 401');
    expect(error.details).not.toContain('invalid_api_key');
  } else expect(error.details).toBe(content);
});

it.each(['current', 'legacy'])('keeps raw diagnostic details collapsed in the %s chat renderer', async renderer => {
  const i18n = await createTestI18n();
  const message = { type: 'error', content: 'HTTP 429: provider response\nrequest_id=diagnostic-123\n{"error":"rate_limit"}', timestamp: 0 };
  render(<I18nextProvider i18n={i18n}>{renderer === 'current'
    ? <MessageRowV2 message={message} prevMessage={null} provider="pilotdeck" selectedProject={null} createDiff={() => []} />
    : <MessageComponent message={message} prevMessage={null} provider="pilotdeck" createDiff={() => []} />}</I18nextProvider>);
  expect(screen.getByRole('alert').textContent).toContain('The model service is limiting requests');
  const disclosure = document.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('pre')!.textContent).toBe(message.content);
  fireEvent.click(screen.getByText('Error details'));
  expect(disclosure.open).toBe(true);
  expect(disclosure.querySelector('pre')!.textContent).toContain('diagnostic-123');
});

it('keeps an unrecognized echoed credential out of authentication diagnostics', async () => {
  const i18n = await createTestI18n();
  const error = conversationError({ type: 'error', timestamp: 0, errorCode: 'AUTH',
    content: '401 Incorrect API key provided: secret-with-no-known-prefix',
    details: { request: { apiKey: 'another-private-value' } } }, i18n.getFixedT('en', 'chat'));
  expect(error.code).toBe('AUTH');
  expect(error.details).toContain('HTTP 401');
  expect(JSON.stringify(error)).not.toMatch(/secret-with-no-known-prefix|another-private-value/);
});

it('redacts credentials in non-auth diagnostics while preserving the request ID', async () => {
  const i18n = await createTestI18n();
  const content = '503 request_id=trace-123\nAuthorization: Bearer private-bearer-value\n{"api_key":"private-json-value","password":"private multiword password"}\nhttps://user:private-password@example.invalid/v1?token=private-query-value';
  const error = conversationError({ type: 'error', timestamp: 0, errorCode: 'PROVIDER_UNAVAILABLE', content }, i18n.getFixedT('en', 'chat'));
  expect(error.details).toContain('trace-123');
  expect(error.details).toContain('[redacted]');
  expect(error.details).not.toMatch(/private-bearer-value|private-json-value|private-password|private-query-value|multiword password/);
});

it('keeps classified server explanations and their localized hint', async () => {
  const i18n = await createTestI18n('zh-CN');
  const t = i18n.getFixedT('zh-CN', 'chat');
  const error = conversationError({ type: 'error', timestamp: 0, content: 'empty_response',
    contentI18n: { key: 'agentStatus.emptyResponse.message' }, userHintI18n: { key: 'agentStatus.emptyResponse.hint' } }, t);
  expect(error.title).toBe(t('agentStatus.emptyResponse.message'));
  expect(error.hint).toBe(t('agentStatus.emptyResponse.hint'));
});
