import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

// Neutral zinc palette tuned to match Tailwind neutral-* so the CodeMirror
// surface blends with V2 panels (neutral-950 background, neutral-800 borders).
const zinc = {
  bg: '#0a0a0a',
  bgAlt: '#0a0a0a',
  panel: '#0a0a0a',
  gutterBg: '#0a0a0a',
  gutterFg: '#525252',
  gutterActiveFg: '#e5e5e5',
  fg: '#e5e5e5',
  fgMuted: '#a3a3a3',
  caret: '#fafafa',
  selection: '#262626',
  selectionMatch: '#262626',
  lineHighlight: 'rgba(64,64,64,0.35)',
  border: '#262626',
  cursorHover: '#525252',
  foldMarker: '#737373',
  tooltipBg: '#171717',
  tooltipBorder: '#262626',
  accent: '#e5e5e5',
  string: '#a3e635',
  keyword: '#c4b5fd',
  number: '#fde68a',
  comment: '#737373',
  function: '#7dd3fc',
  variable: '#f5f5f5',
  property: '#d4d4d4',
  typeName: '#fcd34d',
  tag: '#f87171',
  attribute: '#fbbf24',
  punctuation: '#a3a3a3',
};

export const zincDarkTheme: Extension = [
  EditorView.theme(
    {
      '&': {
        color: zinc.fg,
        backgroundColor: zinc.bg,
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-content': {
        caretColor: zinc.caret,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, 'Cascadia Mono', Consolas, monospace",
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: zinc.caret,
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: zinc.selection,
      },
      '.cm-selectionMatch': {
        backgroundColor: zinc.selectionMatch,
      },
      '.cm-activeLine': {
        backgroundColor: zinc.lineHighlight,
      },
      '.cm-activeLineGutter': {
        backgroundColor: zinc.lineHighlight,
        color: zinc.gutterActiveFg,
      },
      '.cm-gutters': {
        backgroundColor: zinc.gutterBg,
        color: zinc.gutterFg,
        border: 'none',
        borderRight: `1px solid ${zinc.border}`,
      },
      '.cm-lineNumbers .cm-gutterElement': {
        color: zinc.gutterFg,
      },
      '.cm-foldPlaceholder': {
        backgroundColor: zinc.panel,
        color: zinc.fgMuted,
        border: `1px solid ${zinc.border}`,
      },
      '.cm-tooltip': {
        backgroundColor: zinc.tooltipBg,
        color: zinc.fg,
        border: `1px solid ${zinc.tooltipBorder}`,
        borderRadius: '6px',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: zinc.selection,
        color: zinc.fg,
      },
      '.cm-panels': {
        backgroundColor: zinc.panel,
        color: zinc.fg,
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: `1px solid ${zinc.border}`,
      },
      '.cm-panels.cm-panels-bottom': {
        borderTop: `1px solid ${zinc.border}`,
      },
      '.cm-searchMatch': {
        backgroundColor: 'rgba(234,179,8,0.2)',
        outline: '1px solid rgba(234,179,8,0.4)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'rgba(234,179,8,0.35)',
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: zinc.selection,
        outline: `1px solid ${zinc.border}`,
      },
      '.cm-scroller': {
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, 'Cascadia Mono', Consolas, monospace",
      },
    },
    { dark: true },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.keyword, color: zinc.keyword },
      { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: zinc.property },
      { tag: [t.function(t.variableName), t.labelName], color: zinc.function },
      { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: zinc.typeName },
      { tag: [t.definition(t.name), t.separator], color: zinc.variable },
      { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: zinc.typeName },
      { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: zinc.keyword },
      { tag: [t.meta, t.comment], color: zinc.comment, fontStyle: 'italic' },
      { tag: t.strong, fontWeight: 'bold' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
      { tag: t.link, color: zinc.function, textDecoration: 'underline' },
      { tag: t.heading, fontWeight: 'bold', color: zinc.tag },
      { tag: [t.atom, t.bool, t.special(t.variableName)], color: zinc.number },
      { tag: [t.processingInstruction, t.string, t.inserted], color: zinc.string },
      { tag: t.invalid, color: zinc.tag },
      { tag: t.punctuation, color: zinc.punctuation },
      { tag: t.tagName, color: zinc.tag },
      { tag: t.attributeName, color: zinc.attribute },
    ]),
  ),
];

const zincLight = {
  bg: '#ffffff',
  gutterBg: '#ffffff',
  gutterFg: '#a3a3a3',
  gutterActiveFg: '#171717',
  fg: '#171717',
  fgMuted: '#525252',
  caret: '#171717',
  selection: '#e5e5e5',
  selectionMatch: '#e5e5e5',
  lineHighlight: 'rgba(229,229,229,0.45)',
  border: '#e5e5e5',
  panel: '#ffffff',
  tooltipBg: '#ffffff',
  tooltipBorder: '#e5e5e5',
  keyword: '#9333ea',
  function: '#0369a1',
  number: '#b45309',
  string: '#15803d',
  comment: '#737373',
  variable: '#171717',
  property: '#262626',
  typeName: '#b45309',
  tag: '#be123c',
  attribute: '#92400e',
  punctuation: '#525252',
};

export const zincLightTheme: Extension = [
  EditorView.theme(
    {
      '&': {
        color: zincLight.fg,
        backgroundColor: zincLight.bg,
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-content': {
        caretColor: zincLight.caret,
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, 'Cascadia Mono', Consolas, monospace",
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: zincLight.selection,
      },
      '.cm-selectionMatch': {
        backgroundColor: zincLight.selectionMatch,
      },
      '.cm-activeLine': {
        backgroundColor: zincLight.lineHighlight,
      },
      '.cm-activeLineGutter': {
        backgroundColor: zincLight.lineHighlight,
        color: zincLight.gutterActiveFg,
      },
      '.cm-gutters': {
        backgroundColor: zincLight.gutterBg,
        color: zincLight.gutterFg,
        border: 'none',
        borderRight: `1px solid ${zincLight.border}`,
      },
      '.cm-lineNumbers .cm-gutterElement': {
        color: zincLight.gutterFg,
      },
      '.cm-foldPlaceholder': {
        backgroundColor: zincLight.panel,
        color: zincLight.fgMuted,
        border: `1px solid ${zincLight.border}`,
      },
      '.cm-tooltip': {
        backgroundColor: zincLight.tooltipBg,
        color: zincLight.fg,
        border: `1px solid ${zincLight.tooltipBorder}`,
        borderRadius: '6px',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: zincLight.selection,
        color: zincLight.fg,
      },
      '.cm-panels': {
        backgroundColor: zincLight.panel,
        color: zincLight.fg,
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: `1px solid ${zincLight.border}`,
      },
      '.cm-panels.cm-panels-bottom': {
        borderTop: `1px solid ${zincLight.border}`,
      },
      '.cm-searchMatch': {
        backgroundColor: 'rgba(234,179,8,0.25)',
        outline: '1px solid rgba(234,179,8,0.5)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'rgba(234,179,8,0.4)',
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: zincLight.selection,
        outline: `1px solid ${zincLight.border}`,
      },
      '.cm-scroller': {
        fontFamily:
          "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, 'Cascadia Mono', Consolas, monospace",
      },
    },
    { dark: false },
  ),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.keyword, color: zincLight.keyword },
      { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: zincLight.property },
      { tag: [t.function(t.variableName), t.labelName], color: zincLight.function },
      { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: zincLight.typeName },
      { tag: [t.definition(t.name), t.separator], color: zincLight.variable },
      { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: zincLight.typeName },
      { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: zincLight.keyword },
      { tag: [t.meta, t.comment], color: zincLight.comment, fontStyle: 'italic' },
      { tag: t.strong, fontWeight: 'bold' },
      { tag: t.emphasis, fontStyle: 'italic' },
      { tag: t.strikethrough, textDecoration: 'line-through' },
      { tag: t.link, color: zincLight.function, textDecoration: 'underline' },
      { tag: t.heading, fontWeight: 'bold', color: zincLight.tag },
      { tag: [t.atom, t.bool, t.special(t.variableName)], color: zincLight.number },
      { tag: [t.processingInstruction, t.string, t.inserted], color: zincLight.string },
      { tag: t.invalid, color: zincLight.tag },
      { tag: t.punctuation, color: zincLight.punctuation },
      { tag: t.tagName, color: zincLight.tag },
      { tag: t.attributeName, color: zincLight.attribute },
    ]),
  ),
];
