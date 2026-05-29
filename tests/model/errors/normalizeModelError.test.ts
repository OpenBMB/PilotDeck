import { describe, it, expect } from 'vitest';
import { normalizeModelError } from '../../../src/model/errors/normalizeModelError.js';

describe('normalizeModelError', () => {
  describe('semantic error classification', () => {
    it('classifies Anthropic "prompt is too long" as prompt_too_long', () => {
      const result = normalizeModelError('anthropic', 'anthropic', {
        message: 'This prompt is too long. Please shorten it.',
      });
      expect(result.code).toBe('prompt_too_long');
      expect(result.retryable).toBe(false);
      expect(result.recoverableViaCompact).toBe(true);
    });

    it('classifies OpenAI "input length and max_tokens exceed context limit" as prompt_too_long', () => {
      const result = normalizeModelError('openai', 'openai', {
        message: "This model's maximum context length is 128000 tokens. Your input length and max_tokens exceed context limit.",
      });
      expect(result.code).toBe('prompt_too_long');
      expect(result.recoverableViaCompact).toBe(true);
    });

    it('classifies "request too large" errors', () => {
      const result = normalizeModelError('openai', 'openai', {
        message: 'Request too large: the total request size exceeds the limit.',
      });
      expect(result.code).toBe('request_too_large');
    });

    it('classifies max output reached errors', () => {
      const result = normalizeModelError('anthropic', 'anthropic', {
        message: 'Maximum output tokens exceeded.',
      });
      expect(result.code).toBe('max_output_reached');
    });

    it('classifies max completion tokens reached errors', () => {
      const result = normalizeModelError('openai', 'openai', {
        message: 'The max completion tokens have been reached.',
      });
      expect(result.code).toBe('max_output_reached');
    });
  });

  describe('status code classification', () => {
    it('classifies 401 as auth_error', () => {
      const result = normalizeModelError('openai', 'openai', {}, 401);
      expect(result.code).toBe('auth_error');
      expect(result.retryable).toBe(false);
    });

    it('classifies 403 as auth_error', () => {
      const result = normalizeModelError('anthropic', 'anthropic', {}, 403);
      expect(result.code).toBe('auth_error');
    });

    it('classifies 429 as rate_limit_error (retryable)', () => {
      const result = normalizeModelError('openai', 'openai', {}, 429);
      expect(result.code).toBe('rate_limit_error');
      expect(result.retryable).toBe(true);
    });

    it('classifies 408 as retryable', () => {
      const result = normalizeModelError('anthropic', 'anthropic', {}, 408);
      expect(result.code).toBe('provider_error');
      expect(result.retryable).toBe(true);
    });

    it('classifies 500+ as server_error (retryable)', () => {
      const result = normalizeModelError('openai', 'openai', {}, 502);
      expect(result.code).toBe('server_error');
      expect(result.retryable).toBe(true);
    });

    it('classifies 413 as request_too_large', () => {
      const result = normalizeModelError('anthropic', 'anthropic', {}, 413);
      expect(result.code).toBe('request_too_large');
    });
  });

  describe('error message extraction', () => {
    it('extracts message from Error instance', () => {
      const result = normalizeModelError('openai', 'openai', new Error('Connection timeout'));
      expect(result.message).toBe('Connection timeout');
    });

    it('extracts nested error.message', () => {
      const result = normalizeModelError('openai', 'openai', {
        error: { message: 'Rate limit exceeded' },
      });
      expect(result.message).toBe('Rate limit exceeded');
    });

    it('falls back to default message when no message found', () => {
      const result = normalizeModelError('openai', 'openai', 42);
      expect(result.message).toBe('Model provider request failed.');
    });

    it('extracts code from nested error', () => {
      const result = normalizeModelError('openai', 'openai', {
        error: { code: 'rate_limit_error', message: 'Too fast' },
      });
      expect(result.code).toBe('rate_limit_error');
    });

    it('extracts type as fallback code', () => {
      const result = normalizeModelError('anthropic', 'anthropic', {
        type: 'overloaded_error',
        message: 'Server overloaded',
      });
      expect(result.code).toBe('overloaded_error');
    });
  });

  describe('retryable error via code', () => {
    it('marks rate_limit_error as retryable', () => {
      const result = normalizeModelError('openai', 'openai', {
        error: { code: 'rate_limit_error', message: 'Too many requests' },
      });
      expect(result.retryable).toBe(true);
    });

    it('marks overloaded_error as retryable', () => {
      const result = normalizeModelError('anthropic', 'anthropic', {
        error: { code: 'overloaded_error', message: 'Overloaded' },
      });
      expect(result.retryable).toBe(true);
    });

    it('marks timeout as retryable', () => {
      const result = normalizeModelError('openai', 'openai', {
        error: { code: 'timeout', message: 'Request timed out' },
      });
      expect(result.retryable).toBe(true);
    });

    it('marks server_error as retryable', () => {
      const result = normalizeModelError('openai', 'openai', {
        error: { code: 'server_error', message: 'Internal error' },
      });
      expect(result.retryable).toBe(true);
    });
  });

  describe('multimodal processor recovery', () => {
    it('marks multimodal processor errors as recoverable via image strip', () => {
      const result = normalizeModelError('openai', 'openai', {
        message: 'Failed to apply multimodal processor to image data',
      });
      expect(result.recoverableViaImageStrip).toBe(true);
    });
  });

  describe('protocol and provider passthrough', () => {
    it('preserves provider and protocol fields', () => {
      const result = normalizeModelError('my-provider', 'openai', {
        message: 'Something went wrong',
      }, 500);
      expect(result.provider).toBe('my-provider');
      expect(result.protocol).toBe('openai');
      expect(result.status).toBe(500);
    });
  });
});
