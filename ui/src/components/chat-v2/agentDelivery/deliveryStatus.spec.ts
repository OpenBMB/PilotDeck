import { describe, expect, it } from 'vitest';
import { parseAgentDelivery } from './deliveryStatus';

// Mirrors the real parent Agent tool output: gateway-sanitized
// AgentToolOutput with `delivery` (DeliveryResult) + `delivery_file`.
const REAL_PAYLOAD = {
  subagentType: 'general-purpose',
  description: '采集任务',
  text: 'Done.',
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  turns: 3,
  durationMs: 4200,
  delivery_file: '.pilotdeck/deliveries/sub-1/attempt-2.json',
  delivery: {
    status: 'passed',
    deliveryFile: '.pilotdeck/deliveries/sub-1/attempt-2.json',
    repairs: 1,
    producerUsage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
    reviewUsage: { inputTokens: 210, outputTokens: 40, totalTokens: 250 },
    attempts: [
      {
        attempt: 1,
        deliveryFile: '.pilotdeck/deliveries/sub-1/attempt-1.json',
        checks: {
          status: 'failed',
          checked: 4,
          issues: [{ path: 'changes.0.file', code: 'file_missing', message: 'src/util.ts does not exist' }],
        },
        review: { status: 'skipped', summary: 'Checks failed; review skipped.', issues: [], durationMs: 12 },
      },
      {
        attempt: 2,
        deliveryFile: '.pilotdeck/deliveries/sub-1/attempt-2.json',
        checks: { status: 'passed', checked: 5, issues: [] },
        review: {
          status: 'accepted',
          summary: 'Report matches the schema and files exist.',
          issues: [],
          model: { provider: 'openai', model: 'gpt-test' },
          usage: { inputTokens: 210, outputTokens: 40, totalTokens: 250 },
          durationMs: 3120,
        },
      },
    ],
  },
};

describe('parseAgentDelivery', () => {
  it('parses the real structured payload from toolUseResult', () => {
    const parsed = parseAgentDelivery({ toolUseResult: REAL_PAYLOAD });

    expect(parsed.deliveryFile).toBe('.pilotdeck/deliveries/sub-1/attempt-2.json');
    expect(parsed.delivery?.status).toBe('passed');
    expect(parsed.delivery?.repairs).toBe(1);
    expect(parsed.delivery?.producerTotalTokens).toBe(1200);
    expect(parsed.delivery?.attempts).toHaveLength(2);
    expect(parsed.delivery?.attempts[0]?.checks.status).toBe('failed');
    expect(parsed.delivery?.attempts[1]?.review?.modelLabel).toBe('openai/gpt-test');
    expect(parsed.delivery?.attempts[1]?.review?.totalTokens).toBe(250);
    expect(parsed.delivery?.attempts[1]?.review?.durationMs).toBe(3120);
  });

  it('accepts a JSON-string toolUseResult variant', () => {
    const parsed = parseAgentDelivery({ toolUseResult: JSON.stringify(REAL_PAYLOAD) });
    expect(parsed.delivery?.status).toBe('passed');
    expect(parsed.delivery?.attempts).toHaveLength(2);
  });

  it('returns nothing for payloads without delivery information', () => {
    expect(parseAgentDelivery(undefined)).toEqual({});
    expect(parseAgentDelivery({ toolUseResult: { text: 'plain' } })).toEqual({});
    expect(parseAgentDelivery({ toolUseResult: 'not json' })).toEqual({});
  });

  it('downgrades a claimed passed with no attempts to inconclusive (truncated payload)', () => {
    const truncated = {
      ...REAL_PAYLOAD,
      delivery: { ...REAL_PAYLOAD.delivery, status: 'passed', attempts: [] },
    };
    const parsed = parseAgentDelivery({ toolUseResult: truncated });
    expect(parsed.delivery?.status).toBe('inconclusive');
  });

  it('downgrades unknown overall statuses to inconclusive', () => {
    const unknown = {
      ...REAL_PAYLOAD,
      delivery: { ...REAL_PAYLOAD.delivery, status: 'ok-ish' },
    };
    const parsed = parseAgentDelivery({ toolUseResult: unknown });
    expect(parsed.delivery?.status).toBe('inconclusive');
  });

  it('keeps a review skipped with its explanation summary visible', () => {
    const skippedReview = {
      ...REAL_PAYLOAD,
      delivery: {
        ...REAL_PAYLOAD.delivery,
        attempts: REAL_PAYLOAD.delivery.attempts.slice(0, 1),
      },
    };
    const parsed = parseAgentDelivery({ toolUseResult: skippedReview });
    expect(parsed.delivery?.attempts[0]?.review?.status).toBe('skipped');
    expect(parsed.delivery?.attempts[0]?.review?.summary).toContain('review skipped');
  });

  it('treats absent usage totals as unknown instead of zero', () => {
    const noUsage = {
      ...REAL_PAYLOAD,
      delivery: {
        ...REAL_PAYLOAD.delivery,
        producerUsage: {},
        attempts: REAL_PAYLOAD.delivery.attempts.map((attempt) => ({
          ...attempt,
          review: attempt.review ? { ...attempt.review, usage: undefined } : undefined,
        })),
      },
    };
    const parsed = parseAgentDelivery({ toolUseResult: noUsage });
    expect(parsed.delivery?.producerTotalTokens).toBeUndefined();
    expect(parsed.delivery?.attempts[1]?.review?.totalTokens).toBeUndefined();
    expect(parsed.delivery?.attempts[1]?.review?.durationMs).toBe(3120);
  });

  it('tolerates partial or malformed attempt entries', () => {
    const partial = {
      ...REAL_PAYLOAD,
      delivery: {
        status: 'failed',
        repairs: 0,
        attempts: [{ checks: { status: 'failed' } }, 'garbage', null],
      },
    };
    const parsed = parseAgentDelivery({ toolUseResult: partial });
    expect(parsed.delivery?.status).toBe('failed');
    expect(parsed.delivery?.attempts).toHaveLength(1);
    expect(parsed.delivery?.attempts[0]?.attempt).toBe(1);
    expect(parsed.delivery?.attempts[0]?.checks.issues).toEqual([]);
  });
});
