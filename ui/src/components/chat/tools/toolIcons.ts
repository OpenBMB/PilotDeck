import {
  AppWindow, Archive, BookOpen, Bot, Brain, Clapperboard, Code2, FilePenLine, FilePlus2,
  FileSearch, FileText, Globe, Image, Layers3, ListTodo, ListTree, MessageCircleQuestion,
  Paperclip, Plug, Search, Terminal, Wrench, type LucideIcon,
} from 'lucide-react';
import type { ChatMessage } from '../types/types';
import { getCanonicalToolName } from './configs/toolConfigs';

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal, shell: Terminal, run_command: Terminal, exec_command: Terminal,
  read: FileText, write: FilePlus2, edit: FilePenLine, applypatch: FilePenLine, apply_patch: FilePenLine,
  grep: Search, glob: FileSearch, web_search: Search, web_fetch: Globe,
  read_skill: BookOpen,
  generate_image: Image, edit_image: Image, save_generated_image: Image,
  generate_video: Clapperboard, save_generated_video: Clapperboard,
  send_attachment: Paperclip,
  todowrite: ListTodo, todoread: ListTodo, todo_write: ListTodo, todo_read: ListTodo,
  taskcreate: ListTodo, taskupdate: ListTodo, tasklist: ListTodo, taskget: ListTodo,
  task_create: ListTodo, task_list: ListTodo, task_output: ListTodo, task_wait: ListTodo, task_stop: ListTodo,
  task: Bot, agent: Bot,
  askuserquestion: MessageCircleQuestion,
  enter_plan_mode: ListTree, exit_plan_mode: ListTree, exitplanmode: ListTree, exitplanmodev2: ListTree,
};

const PHASE_ICONS: Record<string, LucideIcon> = {
  rag: Search, search: Search, read: FileText, edit: FilePenLine, write: FilePlus2,
  command: Terminal, bash: Terminal, think: Brain, thinking: Brain, reasoning: Brain,
  plan: ListTree, subtask: Bot, tool: Wrench, skill: BookOpen, compact: Archive, compaction: Archive,
  code: Code2, review: FileSearch,
};

/** Resolve protocol names, never translated labels or arbitrary tool descriptions. */
export function getToolIcon(toolName: string): LucideIcon {
  const name = getCanonicalToolName(toolName).toLowerCase();
  if (name.startsWith('mcp__')) return Plug;
  if (/^(browser|computer)(_|$)/.test(name)) return AppWindow;
  return TOOL_ICONS[name] ?? Wrench;
}

export function getActivityIcon(phase?: string, toolName?: string): LucideIcon | undefined {
  const toolIcon = toolName ? getToolIcon(toolName) : undefined;
  if (toolIcon && toolIcon !== Wrench) return toolIcon;
  return PHASE_ICONS[phase?.toLowerCase() ?? ''] ?? toolIcon;
}

/** Reasoning does not turn an otherwise single-category tool group into mixed work. */
export function getProcessGroupIcon(messages: ChatMessage[]): LucideIcon {
  const work = messages.filter(message => !message.isThinking);
  if (!work.length) return Brain;
  const icons = new Set(work.map(message => message.isCompactBoundary ? Archive
    : message.isSubagentContainer ? Bot : getToolIcon(message.toolName ?? '')));
  return icons.size === 1 ? [...icons][0] : Layers3;
}
