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

export const TOOL_CONFIGS: Record<string, ToolDisplayConfig> = {
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
      hideOnSuccess: true,
      type: 'special'
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
      getSecondary: (input) => input.path ? `in ${input.path}` : undefined,
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
        const toolData = result.toolUseResult || {};
        const count = toolData.numFiles || toolData.filenames?.length || 0;
        return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        const toolData = result.toolUseResult || {};
        return {
          files: toolData.filenames || []
        };
      }
    }
  },

  Glob: {
    input: {
      type: 'one-line',
      label: 'Glob',
      getValue: (input) => input.pattern,
      getSecondary: (input) => input.path ? `in ${input.path}` : undefined,
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
        const toolData = result.toolUseResult || {};
        const count = toolData.numFiles || toolData.filenames?.length || 0;
        return `Found ${count} ${count === 1 ? 'file' : 'files'}`;
      },
      contentType: 'file-list',
      getContentProps: (result) => {
        const toolData = result.toolUseResult || {};
        return {
          files: toolData.filenames || []
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
      title: 'Updating todo list',
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
      title: 'Updating todo list',
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
      getValue: () => 'reading list',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-violet-400 dark:border-violet-500'
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
      getValue: (input) => input.prompt || 'schedule job',
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
      getValue: (input) => input.id || 'cancel scheduled job',
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
        return job.id ? `Cancelled ${job.id}` : 'Cancelled scheduled job';
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
      getValue: () => 'listing scheduled jobs',
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
        return `${count} scheduled ${count === 1 ? 'job' : 'jobs'}`;
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
      getValue: (input) => input.subject || 'Creating task',
      getSecondary: (input) => input.status || undefined,
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
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
        if (input.status) parts.push(input.status);
        if (input.subject) parts.push(`"${input.subject}"`);
        return parts.join(' → ') || 'updating';
      },
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
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
      getValue: () => 'listing tasks',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-500 dark:text-gray-400',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: 'Task list',
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
      getValue: (input) => input.taskId ? `#${input.taskId}` : 'fetching',
      action: 'none',
      colorScheme: {
        primary: 'text-gray-700 dark:text-gray-300',
        border: 'border-violet-400 dark:border-violet-500',
        icon: 'text-violet-500 dark:text-violet-400'
      }
    },
    result: {
      type: 'collapsible',
      defaultOpen: true,
      title: 'Task details',
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
        const description = input.description || 'Running task';
        return `Subagent / ${subagentType}: ${description}`;
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
        border: 'border-purple-500 dark:border-purple-400',
        icon: 'text-purple-500 dark:text-purple-400'
      }
    },
    result: {
      type: 'collapsible',
      title: 'Subagent result',
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
            return { content: textContent || 'No response text' };
          }
          return { content: String(content) };
        }
        // Fallback to string representation
        return { content: String(result || 'No response') };
      }
    }
  },

  // ============================================================================
  // INTERACTIVE TOOLS
  // ============================================================================

  AskUserQuestion: {
    input: {
      type: 'collapsible',
      title: (input: any) => {
        const questions = Array.isArray(input.questions) ? input.questions : [];
        const count = questions.length;
        const hasAnswers =
          input.answers &&
          typeof input.answers === 'object' &&
          !Array.isArray(input.answers) &&
          Object.keys(input.answers).length > 0;
        if (count === 1) {
          const header = questions[0]?.header || 'Question';
          return hasAnswers ? `${header} — answered` : header;
        }
        if (count === 0 && input.questions) {
          return 'Question payload';
        }
        return hasAnswers ? `${count} questions — answered` : `${count} questions`;
      },
      defaultOpen: true,
      contentType: 'question-answer',
      getContentProps: (input: any) => ({
        questions: input.questions,
        answers: input.answers || {}
      }),
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
      title: 'Parameters',
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
export function getToolConfig(toolName: string): ToolDisplayConfig {
  const canonicalToolName = getCanonicalToolName(toolName);
  return TOOL_CONFIGS[canonicalToolName] || TOOL_CONFIGS.Default;
}

/**
 * Check if a tool result should be hidden
 */
export function shouldHideToolResult(toolName: string, toolResult: any): boolean {
  const config = getToolConfig(toolName);

  if (!config.result) return false;

  // Always hidden
  if (config.result.hidden) return true;

  // Hide on success only
  if (config.result.hideOnSuccess && toolResult && !toolResult.isError) {
    return true;
  }

  return false;
}
