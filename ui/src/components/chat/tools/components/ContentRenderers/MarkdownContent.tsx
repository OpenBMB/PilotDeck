import React from 'react';
import { Markdown } from '../../../view/subcomponents/Markdown';

interface MarkdownContentProps {
  content: unknown;
  className?: string;
}

function stringifyMarkdown(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try {
    return typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
  } catch {
    return String(content);
  }
}

/**
 * Renders markdown content with proper styling
 * Used by: exit_plan_mode, long text results, etc.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className = 'mt-1 prose prose-sm max-w-none dark:prose-invert'
}) => {
  return (
    <Markdown className={className}>
      {stringifyMarkdown(content)}
    </Markdown>
  );
};
