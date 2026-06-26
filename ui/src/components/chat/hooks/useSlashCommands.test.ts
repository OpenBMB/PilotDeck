import { describe, expect, it } from 'vitest';
import {
  buildSlashCommandInsertion,
  removeActiveSlashQueryForTest,
} from './useSlashCommands';

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

describe('useSlashCommands command insertion behavior', () => {
  it('replaces a partial slash query with the selected command', () => {
    expect(buildSlashCommandInsertion('please /skill_inst', 7, '/skill_install')).toEqual({
      value: 'please /skill_install ',
      caret: 22,
    });
  });

  it('keeps trailing text with a single separator after the selected command', () => {
    expect(buildSlashCommandInsertion('please /skill_inst this file', 7, '/skill_install')).toEqual({
      value: 'please /skill_install this file',
      caret: 22,
    });
    expect(buildSlashCommandInsertion('/skill this file', 0, '/skill_install')).toEqual({
      value: '/skill_install this file',
      caret: 15,
    });
  });

  it('preserves multiline tail text when replacing the query', () => {
    expect(buildSlashCommandInsertion('/skill\nthis file', 0, '/skill_install')).toEqual({
      value: '/skill_install \nthis file',
      caret: 15,
    });
  });

  it('falls back to appending the command with safe spacing when no slash is active', () => {
    expect(buildSlashCommandInsertion('please review', -1, '/skill_install')).toEqual({
      value: 'please review /skill_install ',
      caret: 29,
    });
    expect(buildSlashCommandInsertion('please review ', -1, '/skill_install')).toEqual({
      value: 'please review /skill_install ',
      caret: 29,
    });
  });
});
