import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { resolveMarkdownFileHref } from '../../../../chat/utils/resolveMarkdownFileHref';
import MarkdownCodeBlock from './MarkdownCodeBlock';

type MarkdownPreviewProps = {
  content: string;
  baseFilePath?: string;
  onFileOpen?: (filePath: string) => void;
};

const linkClassName = 'text-[var(--pd-accent-strong,#2563eb)] hover:underline dark:text-[var(--pd-accent-strong,#60a5fa)]';

function createMarkdownPreviewComponents(
  onFileOpen?: (filePath: string) => void,
  baseFilePath?: string,
): Components {
  return {
    code: MarkdownCodeBlock,
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-4 border-gray-300 pl-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
        {children}
      </blockquote>
    ),
    a: ({ href, children, ...props }) => {
      const filePath = resolveMarkdownFileHref(href, { baseFilePath });
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
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
    th: ({ children }) => (
      <th className="border border-gray-200 px-3 py-2 text-left text-sm font-semibold dark:border-gray-700">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700">{children}</td>
    ),
  };
}

export default function MarkdownPreview({ content, baseFilePath, onFileOpen }: MarkdownPreviewProps) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const components = useMemo(
    () => createMarkdownPreviewComponents(onFileOpen, baseFilePath),
    [onFileOpen, baseFilePath],
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
