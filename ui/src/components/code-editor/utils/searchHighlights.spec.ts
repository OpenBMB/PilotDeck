import { EditorState } from '@codemirror/state';
import { expect, it } from 'vitest';
import { fileSearchHighlights, setFileSearchHighlights } from './searchHighlights';

it('highlights the chosen result without mounting a CodeMirror search panel', () => {
  let state = EditorState.create({ doc: 'needle one\nneedle two', extensions: [fileSearchHighlights] });
  state = state.update({ effects: setFileSearchHighlights.of({ matches: [{ from: 0, to: 6 }, { from: 11, to: 17 }], activeIndex: 1 }) }).state;
  const ranges: { from: number; className: string }[] = [];
  state.field(fileSearchHighlights).between(0, state.doc.length, (from, _to, value) => { ranges.push({ from, className: value.spec.class }); });
  expect(ranges).toEqual([{ from: 0, className: 'cm-searchMatch' }, { from: 11, className: 'cm-searchMatch cm-searchMatch-selected' }]);
  state = state.update({ effects: setFileSearchHighlights.of({ matches: [], activeIndex: 0 }) }).state;
  expect(state.field(fileSearchHighlights).size).toBe(0);
});

it('maps highlights through edits and ignores ranges outside the current buffer', () => {
  let state = EditorState.create({ doc: 'needle', extensions: [fileSearchHighlights] });
  state = state.update({ effects: setFileSearchHighlights.of({ matches: [{ from: 0, to: 6 }], activeIndex: 0 }) }).state;
  state = state.update({ changes: { from: 0, insert: 'new ' } }).state;
  expect(state.field(fileSearchHighlights).iter().from).toBe(4);
  state = state.update({ effects: setFileSearchHighlights.of({ matches: [{ from: 99, to: 105 }], activeIndex: 0 }) }).state;
  expect(state.field(fileSearchHighlights).size).toBe(0);
});
