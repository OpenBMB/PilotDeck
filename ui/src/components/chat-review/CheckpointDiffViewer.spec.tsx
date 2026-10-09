import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import CheckpointDiffViewer, { numberedDiffLines, type CheckpointDiff } from './CheckpointDiffViewer';

afterEach(cleanup);
const diff = {
  path: 'config.json', oldContent: '{"enabled": false}\n', newContent: '{"enabled": true}\n',
  hunks: [{ oldStart: 5, oldLines: 3, newStart: 7, newLines: 4, lines: [
    { type: 'context', text: 'before' }, { type: 'delete', text: 'old' },
    { type: 'add', text: 'new' }, { type: 'add', text: 'extra' }, { type: 'context', text: 'after' },
  ] }],
} as CheckpointDiff;

it('numbers old and new sides independently across additions, deletions and hunk gaps', () => {
  const result = numberedDiffLines(diff);
  expect(result.map(({ oldLine, newLine }) => [oldLine, newLine])).toEqual([[5, 7], [6, null], [null, 8], [null, 9], [7, 10]]);
  const next = numberedDiffLines({ hunks: [...diff.hunks!, { oldStart: 90, oldLines: 0, newStart: 95, newLines: 1, lines: [{ type: 'add', text: 'later' }] }] });
  expect(next.at(-1)?.newLine).toBe(95);
});

it('preserves indentation, highlights full JSON versions, and enables wrapping only when requested', () => {
  const actual = { ...diff, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: 'delete' as const, text: '{"enabled": false}' }, { type: 'add' as const, text: '{"enabled": true}' }] }] };
  const { container } = render(<CheckpointDiffViewer diff={actual} />);
  expect(container.querySelector('.tok-propertyName')).not.toBeNull();
  expect(container.querySelector('[data-diff-line="delete"]')?.textContent).toContain('false');
  expect(container.querySelector('[data-diff-line="add"]')?.textContent).toContain('true');
  expect(container.querySelector('code')?.classList.contains('whitespace-pre')).toBe(true);
  fireEvent.click(screen.getByLabelText('切换自动换行'));
  expect(container.querySelector('code')?.classList.contains('whitespace-pre-wrap')).toBe(true);
});
