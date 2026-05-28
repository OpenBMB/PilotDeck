import React, { memo, useMemo, useCallback } from 'react';
import type { Project } from '../../../types/app';
import type { SubagentChildTool } from '../types/types';
import { getCanonicalToolName, getToolConfig } from './configs/toolConfigs';
import { OneLineDisplay, CollapsibleDisplay, ToolDiffViewer, MarkdownContent, FileListContent, TodoListContent, TaskListContent, TextContent, QuestionAnswerContent, SubagentContainer, PlanApprovedCard } from './components';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface ToolRendererProps {
  toolName: string;
  toolInput: any;
  toolResult?: any;
  toolId?: string;
  mode: 'input' | 'result';
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  createDiff?: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  rawToolInput?: string;
  isSubagentContainer?: boolean;
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
  };
}

type ToolRendererErrorBoundaryState = {
  error: Error | null;
};

class ToolRendererErrorBoundary extends React.Component<
  { toolName: string; toolId?: string; children: React.ReactNode },
  ToolRendererErrorBoundaryState
> {
  state: ToolRendererErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ToolRendererErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.warn('[ToolRenderer] Failed to render tool block:', {
      toolName: this.props.toolName,
      toolId: this.props.toolId,
      error,
      errorInfo,
    });
  }

  componentDidUpdate(prevProps: { toolName: string; toolId?: string }) {
    if (
      this.state.error &&
      (prevProps.toolName !== this.props.toolName || prevProps.toolId !== this.props.toolId)
    ) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="my-1 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/20 dark:text-amber-200">
          <div className="font-medium">Tool output could not be rendered.</div>
          <div className="mt-0.5 opacity-80">{this.props.toolName}</div>
        </div>
      );
    }

    return this.props.children;
  }
}

function safeCall<T>(label: string, toolName: string, callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch (error) {
    console.warn(`[ToolRenderer] ${label} failed for ${toolName}:`, error);
    return fallback;
  }
}

function toDisplayString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return fallback;
  }
}

function toObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function getToolCategory(toolName: string): string {
  if (['Edit', 'Write', 'ApplyPatch'].includes(toolName)) return 'edit';
  if (['Grep', 'Glob'].includes(toolName)) return 'search';
  if (toolName === 'Bash') return 'bash';
  if (['TodoWrite', 'TodoRead', 'todo_write', 'todo_read'].includes(toolName)) return 'todo';
  if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(toolName)) return 'task';
  if (toolName === 'Task' || toolName === 'agent' || toolName === 'Agent') return 'agent';
  if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') return 'plan';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'default';
}

/**
 * Main tool renderer router
 * Routes to OneLineDisplay or CollapsibleDisplay based on tool config
 */
const ToolRendererInner: React.FC<ToolRendererProps> = ({
  toolName,
  toolInput,
  toolResult,
  toolId,
  mode,
  onFileOpen,
  createDiff,
  selectedProject,
  autoExpandTools = false,
  showRawParameters = false,
  rawToolInput,
  isSubagentContainer,
  subagentState
}) => {
  const canonicalToolName = getCanonicalToolName(toolName);
  const config = getToolConfig(toolName);
  const displayConfig: any = mode === 'input' ? config.input : config.result;

  const parsedData = useMemo(() => {
    try {
      const rawData = mode === 'input' ? toolInput : toolResult;
      return typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    } catch {
      return mode === 'input' ? toolInput : toolResult;
    }
  }, [mode, toolInput, toolResult]);

  const handleAction = useCallback(() => {
    if (displayConfig?.action === 'open-file' && onFileOpen) {
      const value = toDisplayString(
        safeCall('action value', toolName, () => displayConfig.getValue?.(parsedData), ''),
      );
      onFileOpen(value);
    }
  }, [displayConfig, parsedData, onFileOpen, toolName]);

  // Route subagent containers to dedicated component (after hooks to satisfy Rules of Hooks)
  if (isSubagentContainer && subagentState) {
    if (mode === 'result') {
      return null;
    }
    return (
      <SubagentContainer
        toolInput={toolInput}
        toolResult={toolResult}
        subagentState={subagentState}
      />
    );
  }

  if (!displayConfig) return null;

  if (displayConfig.type === 'one-line') {
    const value = toDisplayString(
      safeCall('value getter', toolName, () => displayConfig.getValue?.(parsedData), ''),
    );
    const secondaryValue = safeCall('secondary getter', toolName, () => displayConfig.getSecondary?.(parsedData), undefined);
    const secondary = secondaryValue === undefined ? undefined : toDisplayString(secondaryValue);

    return (
      <OneLineDisplay
        toolName={toolName}
        toolResult={toolResult}
        toolId={toolId}
        icon={displayConfig.icon}
        label={displayConfig.label}
        value={value}
        secondary={secondary}
        action={displayConfig.action}
        onAction={handleAction}
        style={displayConfig.style}
        wrapText={displayConfig.wrapText}
        colorScheme={displayConfig.colorScheme}
        resultId={mode === 'input' ? `tool-result-${toolId}` : undefined}
      />
    );
  }

  if (displayConfig.type === 'collapsible') {
    const title = toDisplayString(
      safeCall(
        'title getter',
        toolName,
        () => typeof displayConfig.title === 'function'
          ? displayConfig.title(parsedData)
          : displayConfig.title,
        'Details',
      ),
      'Details',
    );

    const defaultOpen = displayConfig.defaultOpen !== undefined
      ? displayConfig.defaultOpen
      : autoExpandTools;

    const contentProps = toObject(safeCall(
      'content props getter',
      toolName,
      () => displayConfig.getContentProps?.(parsedData, {
        selectedProject,
        createDiff,
        onFileOpen
      }),
      {},
    ));

    // Build the content component based on contentType
    let contentComponent: React.ReactNode = null;

    switch (displayConfig.contentType) {
      case 'diff':
        if (createDiff) {
          contentComponent = (
            <ToolDiffViewer
              oldContent={contentProps.oldContent}
              newContent={contentProps.newContent}
              filePath={contentProps.filePath}
              badge={contentProps.badge}
              badgeColor={contentProps.badgeColor}
              createDiff={createDiff}
              onFileClick={() => onFileOpen?.(contentProps.filePath)}
            />
          );
        }
        break;

      case 'markdown':
        contentComponent = <MarkdownContent content={contentProps.content || ''} />;
        break;

      case 'file-list':
        contentComponent = (
          <FileListContent
            files={contentProps.files || []}
            onFileClick={onFileOpen}
            title={contentProps.title}
          />
        );
        break;

      case 'todo-list':
        if (contentProps.todos?.length > 0) {
          contentComponent = (
            <TodoListContent
              todos={contentProps.todos}
              isResult={contentProps.isResult}
            />
          );
        }
        break;

      case 'task':
        contentComponent = <TaskListContent content={contentProps.content || ''} />;
        break;

      case 'question-answer':
        contentComponent = (
          <QuestionAnswerContent
            questions={contentProps.questions || []}
            answers={contentProps.answers || {}}
          />
        );
        break;

      case 'text':
        contentComponent = (
          <TextContent
            content={contentProps.content || ''}
            format={contentProps.format || 'plain'}
          />
        );
        break;

      case 'plan-card':
        contentComponent = (
          <PlanApprovedCard
            planTitle={contentProps.planTitle || ''}
            planSummary={contentProps.planSummary || ''}
            planFilePath={contentProps.planFilePath || ''}
            onViewPlan={() => onFileOpen?.(contentProps.planFilePath)}
          />
        );
        break;

      case 'success-message': {
        const msg = toDisplayString(
          safeCall('success message getter', toolName, () => displayConfig.getMessage?.(parsedData), 'Success'),
          'Success',
        );
        contentComponent = (
          <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {msg}
          </div>
        );
        break;
      }
    }

    // For edit tools, make the title (filename) clickable to open the file
    const handleTitleClick = (canonicalToolName === 'Edit' || canonicalToolName === 'Write' || canonicalToolName === 'ApplyPatch') && contentProps.filePath && onFileOpen
      ? () => onFileOpen(contentProps.filePath, {
          old_string: contentProps.oldContent,
          new_string: contentProps.newContent
        })
      : undefined;

    return (
      <CollapsibleDisplay
        toolName={toolName}
        toolId={toolId}
        title={title}
        defaultOpen={defaultOpen}
        onTitleClick={handleTitleClick}
        showRawParameters={mode === 'input' && showRawParameters}
        rawContent={rawToolInput}
        toolCategory={getToolCategory(canonicalToolName)}
      >
        {contentComponent}
      </CollapsibleDisplay>
    );
  }

  if (displayConfig.type === 'card') {
    const contentProps = toObject(safeCall(
      'content props getter',
      toolName,
      () => displayConfig.getContentProps?.(parsedData, { selectedProject, createDiff, onFileOpen }),
      {},
    ));

    let cardComponent: React.ReactNode = null;
    switch (displayConfig.contentType) {
      case 'plan-card':
        cardComponent = (
          <PlanApprovedCard
            planTitle={contentProps.planTitle || ''}
            planSummary={contentProps.planSummary || ''}
            planFilePath={contentProps.planFilePath || ''}
            onViewPlan={() => onFileOpen?.(contentProps.planFilePath)}
          />
        );
        break;
    }

    return cardComponent;
  }

  return null;
};

ToolRendererInner.displayName = 'ToolRendererInner';

export const ToolRenderer: React.FC<ToolRendererProps> = memo((props) => (
  <ToolRendererErrorBoundary toolName={props.toolName} toolId={props.toolId}>
    <ToolRendererInner {...props} />
  </ToolRendererErrorBoundary>
));

ToolRenderer.displayName = 'ToolRenderer';
