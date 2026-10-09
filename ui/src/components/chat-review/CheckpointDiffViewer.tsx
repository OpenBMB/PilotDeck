import { useMemo, useState } from 'react';
import { WrapText } from 'lucide-react';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import type { FileChange } from '../../../../src/session/checkpoints/types';
import './checkpoint-diff.css';

export type CheckpointDiff = FileChange & {
  oldContent: string | null;
  newContent: string | null;
  hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<{ type: 'context' | 'add' | 'delete'; text: string }> }> | null;
};
type Token = { text: string; classes: string };

function languageFor(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': case 'ts': case 'tsx': return javascript({ jsx: extension === 'jsx' || extension === 'tsx', typescript: extension === 'ts' || extension === 'tsx' }).language;
    case 'json': return json().language;
    case 'py': return python().language;
    case 'css': case 'scss': case 'less': return css().language;
    case 'html': case 'htm': return html().language;
    case 'md': case 'markdown': return markdown().language;
    default: return null;
  }
}

function highlightedLines(content: string | null, path: string): Token[][] {
  if (!content) return [];
  const language = languageFor(path);
  if (!language || content.length > 200_000) return [];
  const lines: Token[][] = [[]];
  highlightCode(content, language.parser.parse(content), classHighlighter,
    (text, classes) => { lines[lines.length - 1].push({ text, classes }); },
    () => { lines.push([]); });
  return lines;
}

export function numberedDiffLines(diff: Pick<CheckpointDiff, 'hunks'>) {
  return (diff.hunks ?? []).flatMap((hunk, hunkIndex) => {
    let oldLine = hunk.oldStart, newLine = hunk.newStart;
    return hunk.lines.map((line, index) => ({ ...line, hunkIndex, first: index === 0,
      oldLine: line.type === 'add' ? null : oldLine++, newLine: line.type === 'delete' ? null : newLine++,
    }));
  });
}

export default function CheckpointDiffViewer({ diff, versionLabel = '本轮保存的版本' }: { diff: CheckpointDiff; versionLabel?: string }) {
  const [wrap, setWrap] = useState(false), [limit, setLimit] = useState(1000);
  const lines = useMemo(() => numberedDiffLines(diff), [diff]);
  const oldLines = useMemo(() => highlightedLines(diff.oldContent, diff.path), [diff.oldContent, diff.path]);
  const newLines = useMemo(() => highlightedLines(diff.newContent, diff.path), [diff.newContent, diff.path]);
  if (!diff.hunks) return <div className="flex flex-1 items-center justify-center p-8 text-center text-xs leading-6 text-neutral-500">该文件不提供文本差异。<br />可从聊天文件菜单预览当前文件，恢复能力以预览为准。</div>;
  return <div className="checkpoint-diff flex min-h-0 flex-1 flex-col" data-testid="checkpoint-diff-viewer">
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-neutral-100 px-3 text-[11px] text-neutral-400 dark:border-neutral-800"><span>修改前 / 修改后 · {versionLabel}</span><button type="button" aria-label="切换自动换行" aria-pressed={wrap} onClick={() => setWrap(value => !value)} title={wrap ? '关闭自动换行' : '自动换行'} className={`rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${wrap ? 'text-violet-600 dark:text-violet-400' : ''}`}><WrapText className="h-3.5 w-3.5" /></button></div>
    <div className="min-h-0 flex-1 overflow-auto pb-6" data-testid="checkpoint-diff-scroll">
      {!lines.length ? <p className="p-6 text-center text-xs text-neutral-400">没有文本内容差异。</p> : <div className={`min-w-full font-mono text-xs leading-6 ${wrap ? 'w-full' : 'w-max'}`}>
        {lines.slice(0, limit).map((line, index) => {
          const hunk = diff.hunks![line.hunkIndex];
          const tokens = line.type === 'delete' ? oldLines[(line.oldLine ?? 1) - 1] : newLines[(line.newLine ?? 1) - 1];
          return <div key={index}>
            {line.first && <div className="sticky left-0 flex h-8 items-center border-y border-neutral-100 bg-neutral-50 px-3 text-[11px] text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>}
            <div className={`grid ${line.type === 'add' ? 'bg-emerald-500/[0.09]' : line.type === 'delete' ? 'bg-red-500/[0.07]' : ''}`} style={{ gridTemplateColumns: `44px 44px 22px ${wrap ? 'minmax(0, 1fr)' : 'minmax(max-content, 1fr)'}` }} data-diff-line={line.type}>
              <span className="select-none border-r border-neutral-200/50 pr-2 text-right tabular-nums text-neutral-400 dark:border-neutral-800/50" aria-hidden="true">{line.oldLine}</span>
              <span className="select-none pr-2 text-right tabular-nums text-neutral-400" aria-hidden="true">{line.newLine}</span>
              <span className={`select-none text-center ${line.type === 'add' ? 'text-emerald-600' : line.type === 'delete' ? 'text-red-500' : 'text-neutral-300'}`} aria-hidden="true">{line.type === 'add' ? '+' : line.type === 'delete' ? '−' : ''}</span>
              <code className={`block min-w-0 pr-4 ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>{tokens?.length ? tokens.map((token, tokenIndex) => <span className={token.classes || undefined} key={tokenIndex}>{token.text}</span>) : line.text || ' '}</code>
            </div>
          </div>;
        })}
        {lines.length > limit && <button type="button" onClick={() => setLimit(value => value + 1000)} className="sticky left-0 m-3 rounded-md border border-neutral-200 px-3 py-1.5 font-sans text-xs text-neutral-500 dark:border-neutral-700">继续显示剩余 {lines.length - limit} 行</button>}
      </div>}
    </div>
  </div>;
}
