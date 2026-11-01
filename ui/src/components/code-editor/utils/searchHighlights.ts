import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { TextSearchMatch } from './fileSearch';

export const setFileSearchHighlights = StateEffect.define<{ matches: TextSearchMatch[]; activeIndex: number }>();

/** Decorations stay visible when the legacy search panel is absent. */
export const fileSearchHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setFileSearchHighlights)) continue;
      value = Decoration.set(effect.value.matches.flatMap((match, index) => (
        match.from < match.to && match.to <= transaction.state.doc.length
          ? [Decoration.mark({ class: index === effect.value.activeIndex
            ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch' }).range(match.from, match.to)] : []
      )), true);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});
