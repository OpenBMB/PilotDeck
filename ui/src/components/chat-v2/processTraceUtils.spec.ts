import { describe, expect, it } from 'vitest';
import { formatProcessDuration } from './processTraceUtils';

describe('formatProcessDuration', () => {
  it.each([
    { label: 'missing duration', ms: undefined, expected: '0s' },
    { label: 'negative duration', ms: -1_000, expected: '0s' },
    { label: 'non-finite duration', ms: Number.POSITIVE_INFINITY, expected: '0s' },
    { label: 'under one second', ms: 999, expected: '0s' },
    { label: 'under one minute', ms: 59_999, expected: '59s' },
    { label: 'exact minute', ms: 60_000, expected: '1m' },
    { label: 'minutes and seconds', ms: 82_000, expected: '1m 22s' },
    { label: 'under one hour', ms: 3_599_999, expected: '59m 59s' },
    { label: 'exact hour', ms: 3_600_000, expected: '1h' },
    { label: 'hours, minutes, and seconds', ms: 4_931_000, expected: '1h 22m 11s' },
    { label: 'hours with a zero middle unit', ms: 3_611_000, expected: '1h 11s' },
    { label: 'under one day', ms: 86_399_999, expected: '23h 59m 59s' },
    { label: 'exact day', ms: 86_400_000, expected: '1d' },
    { label: 'days omit second-level noise', ms: 98_159_000, expected: '1d 3h 15m' },
    { label: 'days omit zero-value hours', ms: 87_300_000, expected: '1d 15m' },
  ])('formats $label', ({ ms, expected }) => {
    expect(formatProcessDuration(ms)).toBe(expected);
  });
});
