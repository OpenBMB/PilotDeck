import { describe, it, expect } from 'vitest';
import { WebhookSessionMapper } from '../../../src/adapters/channel/webhook/WebhookSessionMapper.js';

describe('WebhookSessionMapper', () => {
  it('creates a general session for first-time chats', () => {
    const mapper = new WebhookSessionMapper(
      { activeByChatId: {} },
      () => 'fixed-uuid',
    );
    const result = mapper.resolve({
      chatId: 'chat_001',
      text: 'Hello',
    });
    expect(result.sessionKey).toBe('webhook:chat=chat_001:general');
    expect(result.message).toBe('Hello');
    expect(result.command).toBeUndefined();
  });

  it('creates a new session on /new command', () => {
    const mapper = new WebhookSessionMapper(
      { activeByChatId: {} },
      () => 'new-session-uuid',
    );
    const result = mapper.resolve({
      chatId: 'chat_002',
      text: '/new',
    });
    expect(result.sessionKey).toBe('webhook:chat=chat_002:s_new-session-uuid');
    expect(result.command).toBe('new');
    expect(result.message).toBe('');
  });

  it('creates a new session with message on /new <text>', () => {
    const mapper = new WebhookSessionMapper(
      { activeByChatId: {} },
      () => 'session-abc',
    );
    const result = mapper.resolve({
      chatId: 'chat_003',
      text: '/new initialize project',
    });
    expect(result.sessionKey).toBe('webhook:chat=chat_003:s_session-abc');
    expect(result.command).toBe('new');
    expect(result.message).toBe('initialize project');
  });

  it('reuses an existing active session', () => {
    const mapper = new WebhookSessionMapper(
      { activeByChatId: { chat_004: 'existing-session-key' } },
    );
    const result = mapper.resolve({
      chatId: 'chat_004',
      text: 'Second message',
    });
    expect(result.sessionKey).toBe('existing-session-key');
    expect(result.message).toBe('Second message');
  });

  it('trims whitespace from messages', () => {
    const mapper = new WebhookSessionMapper();
    const result = mapper.resolve({
      chatId: 'chat_005',
      text: '  Hello World  ',
    });
    expect(result.message).toBe('Hello World');
  });

  it('snapshot returns copy of state', () => {
    const mapper = new WebhookSessionMapper(
      { activeByChatId: { chat_a: 'session_a' } },
    );
    const snapshot = mapper.snapshot();
    expect(snapshot.activeByChatId).toEqual({ chat_a: 'session_a' });
    // Mutating snapshot should not affect original
    snapshot.activeByChatId.chat_b = 'session_b';
    expect(mapper.snapshot().activeByChatId.chat_b).toBeUndefined();
  });
});
