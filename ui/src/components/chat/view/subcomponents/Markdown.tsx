import React, { useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  projectName?: string;
  isStreaming?: boolean;
};

const streamingPlugins = [remarkGfm];
const fullRemarkPlugins = [remarkGfm, remarkMath];
const fullRehypePlugins = [rehypeKatex];

export function Markdown({ children, className, isStreaming }: MarkdownProps) {
  const content = useMemo(
    () => normalizeInlineCodeFences(String(children ?? '')),
    [children],
  ).replace(/\\\((.*?)\\\)/g, '$$$1$')
   .replace(/\\\[(.*?)\\\]/g, '$$$1$$');

  // Only apply streaming-fade-in on the initial mount while streaming.
  // Once streaming ends, never re-apply it — prevents old content from
  // briefly re-animating when sibling messages cause a re-render.
  const wasStreamingRef = useRef(!!isStreaming);
  if (!isStreaming) wasStreamingRef.current = false;
  const showFadeIn = isStreaming && wasStreamingRef.current;
  console.log(rehypeKatex);

  return (
    <div className={`${className || ''} ${showFadeIn ? 'streaming-fade-in' : ''}`.trim()}>
      <ReactMarkdown
        remarkPlugins={isStreaming ? streamingPlugins : fullRemarkPlugins}
        rehypePlugins={isStreaming ? undefined : fullRehypePlugins}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
