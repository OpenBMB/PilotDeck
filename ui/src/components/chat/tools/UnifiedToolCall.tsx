import { useId, useMemo, useState } from 'react';
import { Check, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimatedDisclosure } from '../../ui/AnimatedDisclosure';
import type { ChatMessage } from '../types/types';
import type { Project } from '../../../types/app';
import GeneratedVideoCard from './GeneratedVideoCard';
import { videoAttachment } from './videoPresentation';
import GeneratedImageCard from './GeneratedImageCard';
import { hasImageAttachment, isDrawingTool } from './imagePresentation';
import { isMediaSurfaceVisible } from './mediaPresentation';
import { getCanonicalToolName, getToolConfig } from './configs/toolConfigs';
import { getToolIcon } from './toolIcons';
import { ToolRenderer } from './ToolRenderer';
import { ToolDiffViewer } from './components/ToolDiffViewer';
import { ToolDetails } from './components/ToolDetails';
import { needsLargeChangePreview } from './fileChangePreview';
import { displayText, objectValue, resultText, shellOutput } from './toolPresentation';

type DiffLine = { type: string; content: string; lineNum: number };

export function usesUnifiedToolCall(message: ChatMessage): boolean {
  return !message.isSubagentContainer && !['TodoWrite', 'TodoRead', 'todo_write', 'todo_read', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Task', 'Agent', 'AskUserQuestion', 'exit_plan_mode', 'ExitPlanMode', 'ExitPlanModeV2'].includes(getCanonicalToolName(message.toolName || ''));
}

export function UnifiedToolCall({ message, createDiff, onFileOpen, selectedProject, defaultOpen = false, open, onOpenChange, externalError = false, running = false }: {
  message: ChatMessage;
  createDiff: (oldText: string, newText: string) => DiffLine[];
  onFileOpen?: (path: string, diffInfo?: unknown) => void;
  selectedProject?: Project | null;
  defaultOpen?: boolean; open?: boolean; onOpenChange?: (value: boolean) => void;
  externalError?: boolean; running?: boolean;
}) {
  const { t } = useTranslation('chat');
  const { t: commonT } = useTranslation('common');
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const expanded = open ?? localOpen;
  const contentId = useId();
  const name = getCanonicalToolName(message.toolName || 'Tool');
  const input = useMemo(() => objectValue(message.toolInput), [message.toolInput]);
  const config = getToolConfig(message.toolName || '', commonT);
  const result = message.toolResult;
  const shell = useMemo(() => shellOutput(result), [result]);
  const isShell = name === 'Bash';
  const isEdit = ['Edit', 'Write', 'ApplyPatch'].includes(name);
  const isRead = name === 'Read';
  const isSkill = name === 'read_skill';
  const isSearch = ['Grep', 'Glob', 'web_search'].includes(name);
  const isFetch = /^web[_-]?fetch$/i.test(name);
  const pending = result == null;
  const active = pending && running;
  const separateMedia = isMediaSurfaceVisible(message, running);
  const file = displayText(input.file_path || input.path);
  const target = isShell ? displayText(input.description || input.command)
    : isSkill ? displayText(input.skillName || input.skill_name || input.name)
    : isEdit || isRead ? file.split('/').pop() || file
    : displayText(input.query || input.pattern || input.url || input.description || message.toolName);
  const action = isShell ? 'command' : isEdit ? (name === 'Write' ? 'write' : 'edit') : isRead ? 'read' : isSkill ? 'skill' : isSearch ? 'search' : isFetch ? 'fetch' : 'tool';
  const label = isFetch && result?.isError ? t('toolDisplay.fetchFailed')
    : t(`toolDisplay.${active ? 'running' : pending || result?.isError ? 'pending' : 'done'}.${action}`);
  const Icon = getToolIcon(name);
  const rawResult = resultText(result?.content);
  const displayError = rawResult.includes('<tool_use_error>') ? rawResult.replace(/<\/?tool_use_error>/g, '').replace(/^InputValidationError:\s*/i, '').trim() : rawResult;
  const output = result?.isError ? displayError : isShell ? shell.output : rawResult;
  const duration = shell.durationMs ?? message.durationMs;
  const oldContent = input.old_string;
  const newContent = name === 'Write' ? input.content : input.new_string;
  const diff = useMemo(() => isEdit && name !== 'Write' && typeof oldContent === 'string' && typeof newContent === 'string'
    && !needsLargeChangePreview(oldContent, newContent)
    ? createDiff(oldContent, newContent) : [], [isEdit, name, oldContent, newContent, createDiff]);
  const hasDiff = isEdit && typeof newContent === 'string' && (name === 'Write' || typeof oldContent === 'string');
  const inputDetails = !isSkill && config.input.type === 'collapsible' && config.input.contentType !== 'diff';
  const resultDetails = !config.result?.hidden && !config.result?.hideOnSuccess && config.result?.type === 'collapsible' && !['text', 'success-message', 'file-list'].includes(config.result.contentType || '');
  const files = objectValue(result?.toolUseResult);
  const hasFileList = [files.files, files.filenames].some(value => Array.isArray(value) && value.length > 0);
  const footer = result && !externalError ? <>
    {result.isError ? <X className="h-3.5 w-3.5 text-red-500" /> : <Check className="h-3.5 w-3.5" />}
    <span>{t(result.isError ? 'toolDisplay.failed' : 'toolDisplay.success')}</span>
    {isShell && shell.exitCode !== undefined && <span>· {t('toolDisplay.exitCode', { code: shell.exitCode })}</span>}
    {typeof duration === 'number' && duration >= 0 && <span>· {t('toolDisplay.duration', { seconds: (duration / 1000).toFixed(1) })}</span>}
  </> : <span>{t(active ? 'toolDisplay.executing' : externalError ? 'toolDisplay.actionRequired' : 'toolDisplay.noResult')}</span>;
  return (
    <div className="tool-call min-w-0" data-tool-id={message.toolId}>
      <div className="flex min-w-0 items-center gap-2 text-[13px] leading-6 text-neutral-500 dark:text-neutral-400">
        <button type="button" aria-expanded={expanded} aria-controls={contentId} aria-label={`${label} ${target}`} onClick={() => { setLocalOpen(!expanded); onOpenChange?.(!expanded); }} className="chat-process-trigger hover-brand-text group flex-1">
          <Icon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${active ? 'motion-safe:animate-pulse' : ''}`} strokeWidth={1.8} />
          <span className="shrink-0">{label}</span>
          <span className="min-w-0 truncate" title={target}>{target}</span>
          {diff.length > 0 && !result?.isError && <span className="shrink-0 text-xs tabular-nums"><span className="text-green-600 dark:text-green-400">+{diff.filter(line => line.type === 'added').length}</span>{' '}<span className="text-red-500 dark:text-red-400">−{diff.filter(line => line.type === 'removed').length}</span></span>}
          <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
        </button>
      </div>
      <AnimatedDisclosure id={contentId} expanded={expanded} contentClassName="ml-[22px] mt-2 space-y-2">
        {hasDiff ? <>
          <ToolDiffViewer oldContent={oldContent} newContent={newContent} filePath={file} createDiff={createDiff} onFileClick={onFileOpen ? () => onFileOpen(file, name === 'Write' ? undefined : { old_string: oldContent, new_string: newContent }) : undefined} badge={name === 'Write' ? 'Write' : 'Diff'} />
          <div className="flex justify-end gap-2 text-xs text-neutral-500 dark:text-neutral-400">{footer}</div>
          {result?.isError && !externalError && <ToolDetails title={t('toolDisplay.output')} copyContent={rawResult}><pre className="whitespace-pre-wrap break-words font-mono">{displayError}</pre></ToolDetails>}
        </> : <ToolDetails title={isShell ? commonT('tabs.shell') : isSkill ? `${label} ${target}` : isRead && file ? <button type="button" className="hover:text-[var(--pd-accent-strong,#7c3aed)] hover:underline" title={file} onClick={() => onFileOpen?.(file)}>{file}</button> : message.toolName || t('toolDisplay.tool')} copyLabel={isShell ? t('toolDisplay.copyCommand') : undefined} copyContent={isShell ? displayText(input.command) : output || displayText(message.toolInput)} footer={footer}>
          {isShell ? <pre className="mb-3 whitespace-pre-wrap break-words font-mono"><span className="select-none text-neutral-400">$ </span>{displayText(input.command)}</pre>
            : inputDetails ? <ToolRenderer toolName={message.toolName || ''} toolInput={message.toolInput} toolResult={result} mode="input" contentOnly createDiff={createDiff} onFileOpen={onFileOpen} selectedProject={selectedProject} />
            : <pre className="mb-3 whitespace-pre-wrap break-words font-mono">{isRead ? file : isSkill ? target : displayText(Object.keys(input).length ? input : message.toolInput)}</pre>}
          {name === 'generate_video' && Boolean(message.videoJob) && !separateMedia && <GeneratedVideoCard message={message} running={running} />}
          {!externalError && (result ? <>
            {!message.videoJob && !result.isError && name === 'generate_video' && videoAttachment(message) && !separateMedia ? <GeneratedVideoCard message={message} running={running} />
              : !result.isError && isDrawingTool(name) && hasImageAttachment(message) && !separateMedia ? <GeneratedImageCard message={message} running={running} />
              : !result.isError && (resultDetails || hasFileList) ? <ToolRenderer toolName={message.toolName || ''} toolInput={message.toolInput} toolResult={result} mode="result" contentOnly onFileOpen={onFileOpen} selectedProject={selectedProject} />
              : <pre className="whitespace-pre-wrap break-words font-mono">{output || t('toolDisplay.noOutput')}</pre>}
          </> : <span className="text-neutral-400">{t(active ? 'toolDisplay.executing' : 'toolDisplay.noResult')}</span>)}
        </ToolDetails>}
      </AnimatedDisclosure>
    </div>
  );
}
