// Synthetic visual fixture. Never sends a conversation or calls a model.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../src/i18n/testInstance';
import ConversationError from '../../src/components/chat/view/subcomponents/ConversationError';
export async function mountPreview() {
  const i18n = await createTestI18n('zh-CN');
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;z-index:9999;overflow:auto;background:hsl(var(--background));padding:48px 24px';
  document.body.append(container);
  createRoot(container).render(<I18nextProvider i18n={i18n}><main style={{ maxWidth: 720, margin: '0 auto' }}>
    <h1 className="mb-6 text-xl font-semibold text-foreground">对话错误示例</h1>
    <div className="space-y-5">{[
      'HTTP 429 Too Many Requests\nrequest_id=local-preview-123\n{"error":{"code":"rate_limit_exceeded","message":"Requests exceeded the current provider limit"}}',
      'context_length_exceeded: maximum context length exceeded',
      '401 invalid_api_key: demo-auth-value-not-for-display', 'ECONNRESET socket hang up',
    ].map((content, index) => <ConversationError key={index} message={{ type: 'error', content, timestamp: 0,
      errorCode: ['RATE_LIMIT', 'CONTEXT_LENGTH_EXCEEDED', 'AUTH', 'ECONNRESET'][index] }} />)}</div>
  </main></I18nextProvider>);
}
