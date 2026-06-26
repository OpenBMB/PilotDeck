import { describe, expect, it } from 'vitest';
import { removeActiveSlashQueryForTest } from './useSlashCommands';

describe('useSlashCommands dismiss behavior', () => {
  it('removes a trailing slash query without leaving toolbar spacing behind', () => {
    expect(removeActiveSlashQueryForTest('please review /', 14)).toBe('please review');
    expect(removeActiveSlashQueryForTest('please review /skill', 14)).toBe('please review');
  });

  it('keeps the text after a slash query without adding double spaces', () => {
    expect(removeActiveSlashQueryForTest('please /skill this file', 7)).toBe('please this file');
    expect(removeActiveSlashQueryForTest('/skill this file', 0)).toBe('this file');
  });

  it('leaves input unchanged when there is no active slash query', () => {
    expect(removeActiveSlashQueryForTest('please review', -1)).toBe('please review');
    expect(removeActiveSlashQueryForTest('please review', 4)).toBe('please review');
  });
});
