import i18n, { type TFunction } from 'i18next';
/**
 * Centralized tool configuration registry
 * Defines display behavior for all tool types 
 */

export interface ToolDisplayConfig {
  input: {
    type: 'one-line' | 'collapsible' | 'hidden';
    // One-line config
    icon?: string;
    label?: string;
    getValue?: (input: any) => string;
    getSecondary?: (input: any) => string | undefined;
    action?: 'copy' | 'open-file' | 'jump-to-results' | 'none';
    style?: string;
    wrapText?: boolean;
    colorScheme?: {
      primary?: string;
      secondary?: string;
      background?: string;
      border?: string;
      icon?: string;
    };
    // Collapsible config
    title?: string | ((input: any) => string);
    defaultOpen?: boolean;
    contentType?: 'diff' | 'markdown' | 'file-list' | 'todo-list' | 'text' | 'task' | 'question-answer';
    getContentProps?: (input: any, helpers?: any) => any;
    actionButton?: 'file-button' | 'none';
  };
  result?: {
    hidden?: boolean;
    hideOnSuccess?: boolean;
    type?: 'one-line' | 'collapsible' | 'special' | 'card';
    title?: string | ((result: any) => string);
    defaultOpen?: boolean;
    // Special result handlers
    contentType?: 'markdown' | 'file-list' | 'todo-list' | 'text' | 'success-message' | 'task' | 'question-answer' | 'plan-card';
    getMessage?: (result: any) => string;
    getContentProps?: (result: any) => any;
  };
}

type ParsedTodoItem = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

type SearchToolResultData = {
  files?: unknown;
  filenames?: unknown;
  count?: unknown;
  numFiles?: unknown;
};

const TODO_LINE_PATTERN = /^\s*[-*]\s+\[( |x|X)\]\s+(.*?)\s*$/u;

function parseTodoMarkdown(markdown: unknown): ParsedTodoItem[] {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    return [];
  }

  const parsed: Array<{ checked: boolean; content: string }> = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = TODO_LINE_PATTERN.exec(line);
    if (!match) continue;
    const content = match[2]?.trim();
    if (!content) continue;
    parsed.push({
      checked: match[1].toLowerCase() === 'x',
      content,
    });
  }

  let assignedInProgress = false;
  return parsed.map((todo, index) => {
    let status: ParsedTodoItem['status'];
    if (todo.checked) {
      status = 'completed';
    } else if (!assignedInProgress) {
      status = 'in_progress';
      assignedInProgress = true;
    } else {
      status = 'pending';
    }
    return {
      id: `todo-${index + 1}`,
      content: todo.content,
      status,
    };
  });
}

export function getSearchToolResultFiles(result: unknown): unknown[] {
  const toolData = ((result as { toolUseResult?: SearchToolResultData } | undefined)?.toolUseResult || {}) as SearchToolResultData;
  if (Array.isArray(toolData.files)) return toolData.files;
  if (Array.isArray(toolData.filenames)) return toolData.filenames;
  return [];
}

export function getSearchToolResultCount(result: unknown): number {
  const toolData = ((result as { toolUseResult?: SearchToolResultData } | undefined)?.toolUseResult || {}) as SearchToolResultData;
  if (typeof toolData.count === 'number') return toolData.count;
  if (typeof toolData.numFiles === 'number') return toolData.numFiles;
  return getSearchToolResultFiles(result).length;
}

export function getSearchToolResultFileCount(result: unknown): number {
  const toolData = ((result as { toolUseResult?: SearchToolResultData } | undefined)?.toolUseResult || {}) as SearchToolResultData;
  if (typeof toolData.numFiles === 'number') return toolData.numFiles;
  return getSearchToolResultFiles(result).length;
}

function createToolConfigs(t: TFunction): Record<string, ToolDisplayConfig> {
  return {
  // ============================================================================
  // COMMAND TOOLS
  // ============================================================================

  Bash: {
    input: {
      type: 'one-line',
      icon: 'terminal',
      getValue: (input) => input.command,
      getSecondary: (input) => input.description,
      action: 'copy',
      style: 'terminal',
      wrapText: true,
      colorScheme: {
        primary: 'text-green-400 font-mono',
        secondary: 'text-gray-400',
        background: '',
        border: 'border-green-500 dark:border-green-400',
        icon: 'text-green-500 dark:text-green-400'
      }
    },
    result: {
      type: 'collapsible',
      title: (data) => {
        const content = typeof data === 'string' ? data : data?.content;
        if (!content) return t('common:uiText.emptyOutput');
        const lines = content.split('\n').length;
        return t('common:uiText.outputLines', { count: lines });
      },
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (data) => {
        const content = typeof data === 'string' ? data : data?.content || '';
        return { content };
      }
    }
  },

  // ============================================================================
  // FILE OPERATION TOOLS
  // ============================================================================

  Read: {
    input: {
      type: 'one-line',
      label: 'Read',
      getValue: (input) => input.file_path || '',
      action: 'open-file',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        background: '',
        border: 'border-gray-300 dark:border-gray-600',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      hidden: true
    }
  },

  Edit: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: input.old_string,
        newContent: input.new_string,
        filePath: input.file_path,
        badge: 'Edit',
        badgeColor: 'gray'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  Write: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: '',
        newContent: input.content,
        filePath: input.file_path,
        badge: 'New',
        badgeColor: 'green'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  ApplyPatch: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const filename = input.file_path?.split('/').pop() || input.file_path || 'file';
        return `${filename}`;
      },
      defaultOpen: false,
      contentType: 'diff',
      actionButton: 'none',
      getContentProps: (input) => ({
        oldContent: input.old_string,
        newContent: input.new_string,
        filePath: input.file_path,
        badge: 'Patch',
        badgeColor: 'gray'
      })
    },
    result: {
      hideOnSuccess: true
    }
  },

  // ============================================================================
  // SEARCH TOOLS
  // ============================================================================

  Grep: {
    input: {
      type: 'one-line',
      label: 'Grep',
      getValue: (input) => input.pattern,
      getSecondary: (input) => input.path ? t('common:uiText.inPath', { path: input.path }) : undefined,
      action: 'jump-to-results',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        background: '',
        border: 'border-gray-400 dark:border-gray-500',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const count = getSearchToolResultFileCount(result);
        return t('common:uiText.foundFiles', { count });
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        return {
          files: getSearchToolResultFiles(result)
        };
      }
    }
  },

  Glob: {
    input: {
      type: 'one-line',
      label: 'Glob',
      getValue: (input) => input.pattern,
      getSecondary: (input) => input.path ? t('common:uiText.inPath', { path: input.path }) : undefined,
      action: 'jump-to-results',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        background: '',
        border: 'border-gray-400 dark:border-gray-500',
        icon: 'text-gray-500 dark:text-gray-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const count = getSearchToolResultCount(result);
        return t('common:uiText.foundFiles', { count });
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        return {
          files: getSearchToolResultFiles(result)
        };
      }
    }
  },

  // ============================================================================
  // TODO TOOLS
  // ============================================================================

  TodoWrite: {
    input: {
      type: 'collapsible',
      title: () => t('common:uiText.updatingTodos'),
      defaultOpen: false,
      contentType: 'todo-list',
      getContentProps: (input) => ({
        todos: parseTodoMarkdown(input.markdown)
      })
    },
    result: {
      type: 'collapsible',
      contentType: 'success-message',
      getMessage: () => 'Todo list updated'
    }
  },

  todo_write: {
    input: {
      type: 'collapsible',
      title: () => t('common:uiText.updatingTodos'),
      defaultOpen: false,
      contentType: 'todo-list',
      getContentProps: (input) => ({
        todos: parseTodoMarkdown(input.markdown)
      })
    },
    result: {
      type: 'collapsible',
      contentType: 'success-message',
      getMessage: () => 'Todo list updated'
    }
  },

  TodoRead: {
    input: {
      type: 'one-line',
      label: 'TodoRead',
      getValue: () => t('common:uiText.readingList'),
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-[var(--pd-accent,#a78bfa)] dark:border-violet-500'
      }
    },
    result: {
      type: 'collapsible',
      contentType: 'todo-list',
      getContentProps: (result) => {
        try {
          const content = String(result.content || '');
          let todos = null;
          if (content.startsWith('[')) {
            todos = JSON.parse(content);
          }
          return { todos, isResult: true };
        } catch (e) {
          console.warn('Failed to parse todo list content:', e);
          return { todos: [], isResult: true };
        }
      }
    }
  },

  // ============================================================================
  // CRON TOOLS
  // ============================================================================

  CronCreate: {
    input: {
      type: 'one-line',
      label: 'CronCreate',
      getValue: (input) => input.prompt || t('common:uiText.scheduleJob'),
      getSecondary: (input) => {
        const cadence = input.recurring === false ? 'one-shot' : 'recurring';
        const storage = input.durable ? 'durable' : 'session';
        return input.cron
          ? `${input.cron} · ${cadence} · ${storage}`
          : `${cadence} · ${storage}`;
      },
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        secondary: 'text-gray-500 dark:text-gray-400',
        border: 'border-amber-400 dark:border-amber-500',
        icon: 'text-amber-500 dark:text-amber-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const toolData = result?.toolUseResult || {};
        const job = toolData.data || toolData;
        const id = job.id ? `Scheduled ${job.id}` : 'Scheduled job';
        return job.humanSchedule ? `${id} · ${job.humanSchedule}` : id;
      },
      contentType: 'text',
      getContentProps: (result) => ({
        content: String(result?.content || ''),
        format: 'plain'
      })
    }
  },

  CronDelete: {
    input: {
      type: 'one-line',
      label: 'CronDelete',
      getValue: (input) => input.id || t('common:uiText.cancelJob'),
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-amber-400 dark:border-amber-500',
        icon: 'text-amber-500 dark:text-amber-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const toolData = result?.toolUseResult || {};
        const job = toolData.data || toolData;
        return job.id ? t('common:uiText.cancelledJobId', { id: job.id }) : t('common:uiText.cancelledJob');
      },
      contentType: 'text',
      getContentProps: (result) => ({
        content: String(result?.content || ''),
        format: 'plain'
      })
    }
  },

  CronList: {
    input: {
      type: 'one-line',
      label: 'CronList',
      getValue: () => t('common:uiText.listingJobs'),
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-amber-400 dark:border-amber-500',
        icon: 'text-amber-500 dark:text-amber-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: false,
      title: (result) => {
        const toolData = result?.toolUseResult || {};
        const jobs = toolData.data?.jobs || toolData.jobs || [];
        const count = Array.isArray(jobs) ? jobs.length : 0;
        return t('common:uiText.scheduledJobs', { count });
      },
      contentType: 'text',
      getContentProps: (result) => ({
        content: String(result?.content || ''),
        format: 'plain'
      })
    }
  },

  // ============================================================================
  // TASK TOOLS (TaskCreate, TaskUpdate, TaskList, TaskGet)
  // ============================================================================

  TaskCreate: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => input.subject || t('common:uiText.creatingTask'),
      getSecondary: (input) => input.status ? t(`common:uiText.taskStatus.${input.status}`, { defaultValue: input.status }) : undefined,
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-[var(--pd-accent,#a78bfa)] dark:border-violet-500',
        icon: 'text-[var(--pd-accent,#8b5cf6)] dark:text-violet-400'
      }
    },
    result: {
      hideOnSuccess: true
    }
  },

  TaskUpdate: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => {
        const parts = [];
        if (input.taskId) parts.push(`#${input.taskId}`);
        if (input.status) parts.push(t(`common:uiText.taskStatus.${input.status}`, { defaultValue: input.status }));
        if (input.subject) parts.push(`"${input.subject}"`);
        return parts.join(' → ') || t('common:uiText.updating');
      },
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-[var(--pd-accent,#a78bfa)] dark:border-violet-500',
        icon: 'text-[var(--pd-accent,#8b5cf6)] dark:text-violet-400'
      }
    },
    result: {
      hideOnSuccess: true
    }
  },

  TaskList: {
    input: {
      type: 'one-line',
      label: 'Tasks',
      getValue: () => t('common:uiText.listingTasks'),
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-[var(--pd-accent,#a78bfa)] dark:border-violet-500',
        icon: 'text-[var(--pd-accent,#8b5cf6)] dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: () => t('common:uiText.taskList'),
      contentType: 'task',
      getContentProps: (result) => ({
        content: String(result?.content || '')
      })
    }
  },

  TaskGet: {
    input: {
      type: 'one-line',
      label: 'Task',
      getValue: (input) => input.taskId ? `#${input.taskId}` : t('common:uiText.fetching'),
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-[var(--pd-accent,#a78bfa)] dark:border-violet-500',
        icon: 'text-[var(--pd-accent,#8b5cf6)] dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: () => t('common:uiText.taskDetails'),
      contentType: 'task',
      getContentProps: (result) => ({
        content: String(result?.content || '')
      })
    }
  },

  // ============================================================================
  // SUBAGENT TASK TOOL
  // ============================================================================

  Task: {
    input: {
      type: 'collapsible',
      title: (input) => {
        const subagentType = input.subagent_type || 'Agent';
        const description = input.description || t('common:uiText.runningTask');
        return t('common:uiText.subagentTitle', { type: subagentType, description });
      },
      defaultOpen: false,
      contentType: 'markdown',
      getContentProps: (input) => {
        // If only prompt exists (and required fields), show just the prompt
        // Otherwise show all available fields
        const hasOnlyPrompt = input.prompt &&
          !input.model &&
          !input.resume;

        if (hasOnlyPrompt) {
          return {
            content: input.prompt || ''
          };
        }

        // Format multiple fields
        const parts = [];

        if (input.model) {
          parts.push(`**Model:** ${input.model}`);
        }

        if (input.prompt) {
          parts.push(`**Prompt:**\n${input.prompt}`);
        }

        if (input.resume) {
          parts.push(`**Resuming from:** ${input.resume}`);
        }

        return {
          content: parts.join('\n\n')
        };
      },
      colorScheme: {
        border: 'border-[var(--pd-accent,#a855f7)] dark:border-purple-400',
        icon: 'text-[var(--pd-accent,#a855f7)] dark:text-purple-400'
      }
    },
    result: {
      type: 'collapsible',
      title: () => t('common:uiText.subagentResult'),
      defaultOpen: false,
      contentType: 'markdown',
      getContentProps: (result) => {
        // Handle agent results which may have complex structure
        if (result && result.content) {
          let content = result.content;
          // If content is a JSON string, try to parse it (agent results may arrive serialized)
          if (typeof content === 'string') {
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) {
                content = parsed;
              }
            } catch {
              // Not JSON — use as-is
              return { content };
            }
          }
          // If content is an array (typical for agent responses with multiple text blocks)
          if (Array.isArray(content)) {
            const textContent = content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join('\n\n');
            return { content: textContent || t('common:uiText.noResponseText') };
          }
          return { content: String(content) };
        }
        // Fallback to string representation
        return { content: String(result || t('common:uiText.noResponse')) };
      }
    }
  },

  // ============================================================================
  // INTERACTIVE TOOLS
  // ============================================================================

  AskUserQuestion: {
    input: {
      type: 'collapsible',
      title: (input: any, helpers?: any) => {
        const questions = Array.isArray(input.questions) ? input.questions : [];
        const count = questions.length;
        const resultAnswers = helpers?.toolResult?.toolUseResult?.answers;
        const answers = input.answers || resultAnswers;
        const hasAnswers =
          answers &&
          typeof answers === 'object' &&
          !Array.isArray(answers) &&
          Object.keys(answers).length > 0;
        if (count === 1) {
          const header = questions[0]?.header || t('common:uiText.question');
          return hasAnswers ? t('common:uiText.answeredHeader', { header }) : header;
        }
        if (count === 0 && input.questions) {
          return t('common:uiText.questionPayload');
        }
        return hasAnswers ? t('common:uiText.answeredQuestions', { count }) : t('common:uiText.questionsCount', { count });
      },
      defaultOpen: true,
      contentType: 'question-answer',
      getContentProps: (input: any, helpers?: any) => {
        const resultAnswers = helpers?.toolResult?.toolUseResult?.answers;
        return {
          questions: input.questions,
          answers: input.answers || resultAnswers || {},
        };
      },
    },
    result: {
      hideOnSuccess: true
    }
  },

  // ============================================================================
  // PLAN TOOLS
  // ============================================================================

  exit_plan_mode: {
    input: {
      type: 'hidden',
    },
    result: {
      type: 'card',
      contentType: 'plan-card',
      getContentProps: (result: any) => ({
        planTitle: result.planTitle || 'Implementation Plan',
        planSummary: result.planSummary || '',
        planFilePath: result.planFilePath || '',
      }),
    }
  },

  ExitPlanMode: {
    input: {
      type: 'hidden',
    },
    result: {
      type: 'card',
      contentType: 'plan-card',
      getContentProps: (result: any) => ({
        planTitle: result.planTitle || 'Implementation Plan',
        planSummary: result.planSummary || '',
        planFilePath: result.planFilePath || '',
      }),
    }
  },

  // ============================================================================
  // DEFAULT FALLBACK
  // ============================================================================

  Default: {
    input: {
      type: 'collapsible',
      title: () => t('common:uiText.parameters'),
      defaultOpen: false,
      contentType: 'text',
      getContentProps: (input) => ({
        content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        format: 'code'
      })
    },
    result: {
      type: 'collapsible',
      contentType: 'text',
      getContentProps: (result) => ({
        content: String(result?.content || ''),
        format: 'plain'
      })
    }
  }
};

}

// The application initializes the shared instance; this registry has no initialization side effects.
export const TOOL_CONFIGS = createToolConfigs(((...args: Parameters<TFunction>) => i18n.t(...args)) as TFunction);
const translatedConfigs = new WeakMap<TFunction, Record<string, ToolDisplayConfig>>();

const TOOL_NAME_ALIASES: Record<string, string> = {
  agent: 'Task',
  ask_user_question: 'AskUserQuestion',
  bash: 'Bash',
  edit_file: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  read_file: 'Read',
  write_file: 'Write',
};

export function getCanonicalToolName(toolName: string): string {
  return TOOL_NAME_ALIASES[toolName] || toolName;
}

/**
 * Get configuration for a tool, with fallback to default
 */
export function getToolConfig(toolName: string, t?: TFunction): ToolDisplayConfig {
  let configs = TOOL_CONFIGS;
  if (t) {
    configs = translatedConfigs.get(t) ?? createToolConfigs(t);
    translatedConfigs.set(t, configs);
  }
  const canonicalToolName = getCanonicalToolName(toolName);
  return configs[canonicalToolName] || configs.Default;
}

/**
 * Check if a tool result should be hidden
 */
export function shouldHideToolResult(toolName: string, toolResult: any): boolean {
  const config = getToolConfig(toolName);

  if (!config.result) return false;

  // Hide successful noise (for example read_file content already appears in
  // the model context), but never hide failures: users need the exact tool
  // error and recovery hint to understand why the turn got stuck.
  if (config.result.hidden && !toolResult?.isError) return true;

  // Hide on success only
  if (config.result.hideOnSuccess && toolResult && !toolResult.isError) {
    return true;
  }

  return false;
}
