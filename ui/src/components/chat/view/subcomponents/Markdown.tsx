import React, { useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { resolveMarkdownFileHref } from '../../utils/resolveMarkdownFileHref';
import {
  createRemarkArtifactFileTextPlugin,
  type MarkdownArtifactFile,
} from '../../utils/remarkArtifactFileText';
import { remarkPreviewLinks } from '../../utils/remarkPreviewLinks';
import { MarkdownCodeBlock, MarkdownTable } from './MarkdownCopyBlocks';
import { MarkdownSourceContext } from './MarkdownContext';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  projectName?: string;
  isStreaming?: boolean;
  onFileOpen?: (filePath: string) => void;
  artifactFiles?: MarkdownArtifactFile[];
};

const fullRehypePlugins = [rehypeKatex];
const baseRemarkPlugins = [remarkGfm, remarkMath, remarkPreviewLinks];

const linkClassName = 'text-[var(--pd-accent-strong,#2563eb)] hover:underline dark:text-[var(--pd-accent-strong,#60a5fa)]';

function createMarkdownComponents(onFileOpen?: (filePath: string) => void): Components {
  return {
    pre: MarkdownCodeBlock,
    table: MarkdownTable,
    a: ({ href, children, ...props }) => {
      const filePath = resolveMarkdownFileHref(href);
      if (filePath && onFileOpen) {
        return (
          <a
            href={href}
            className={`${linkClassName} cursor-pointer`}
            onClick={(event) => {
              event.preventDefault();
              onFileOpen(filePath);
            }}
            {...props}
          >
            {children}
          </a>
        );
      }

      const isExternal = Boolean(href && /^https?:\/\//i.test(href));
      return (
        <a
          href={href}
          className={linkClassName}
          {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          {...props}
        >
          {children}
        </a>
      );
    },
  };
}

export const Markdown = React.memo(function Markdown({
  children,
  className,
  isStreaming,
  onFileOpen,
  artifactFiles,
}: MarkdownProps) {
  const content = String(children ?? '');
  const sourceContext = useMemo(() => ({ source: content, isStreaming: Boolean(isStreaming) }), [content, isStreaming]);

  const components = useMemo(
    () => createMarkdownComponents(onFileOpen),
    [onFileOpen],
  );
  const remarkPlugins = useMemo(() => {
    if (isStreaming || artifactFiles === undefined) return baseRemarkPlugins;
    return [...baseRemarkPlugins, createRemarkArtifactFileTextPlugin(artifactFiles)];
  }, [artifactFiles, isStreaming]);

  // Only apply streaming-fade-in on the initial mount while streaming.
  // Once streaming ends, never re-apply it — prevents old content from
  // briefly re-animating when sibling messages cause a re-render.
  const wasStreamingRef = useRef(!!isStreaming);
  if (!isStreaming) wasStreamingRef.current = false;
  const showFadeIn = isStreaming && wasStreamingRef.current;

  return (
    <div className={`chat-markdown ${className || ''} ${showFadeIn ? 'streaming-fade-in' : ''}`.trim()}>
      <MarkdownSourceContext.Provider value={sourceContext}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={fullRehypePlugins}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </MarkdownSourceContext.Provider>
    </div>
  );
});
