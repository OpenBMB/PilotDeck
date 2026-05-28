import { describe, expect, it } from 'vitest';
import { isImeCompositionEvent, isImeEnterEvent } from './ime';

describe('IME keyboard helpers', () => {
  it('detects active composition from the DOM event', () => {
    expect(isImeCompositionEvent({ key: 'Enter', isComposing: true })).toBe(true);
  });

  it('detects active composition from the native event', () => {
    expect(isImeCompositionEvent({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(true);
  });

  it('detects IME process keyCode 229', () => {
    expect(isImeCompositionEvent({ key: 'Enter', keyCode: 229 })).toBe(true);
    expect(isImeCompositionEvent({ key: 'Enter', nativeEvent: { keyCode: 229 } })).toBe(true);
  });

  it('only treats composing Enter as an IME Enter event', () => {
    expect(isImeEnterEvent({ key: 'Enter', keyCode: 229 })).toBe(true);
    expect(isImeEnterEvent({ key: 'Enter', keyCode: 13 })).toBe(false);
    expect(isImeEnterEvent({ key: 'a', keyCode: 229 })).toBe(false);
  });
});
