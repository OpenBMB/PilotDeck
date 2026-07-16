import { describe, expect, it } from 'vitest';
import { getDraftInputStorageKey } from './chatStorage';

describe('getDraftInputStorageKey', () => {
  it('scopes drafts to a project and conversation', () => {
    expect(getDraftInputStorageKey('general', 'session-a'))
      .toBe('draft_input_general:session-a');
    expect(getDraftInputStorageKey('general', 'session-b'))
      .toBe('draft_input_general:session-b');
  });

  it('uses a separate key for a new conversation', () => {
    expect(getDraftInputStorageKey('general', null))
      .toBe('draft_input_general:new');
  });
});
