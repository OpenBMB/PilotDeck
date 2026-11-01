import { Children, isValidElement, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { copyTextToClipboard } from '../../utils/clipboard';

function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children)[0];
  const props = isValidElement<{ children?: ReactNode; className?: string }>(child)
    ? child.props
    : {};
  const content = String(props.children ?? '');
  const language = props.className?.replace(/^language-/, '') || 'text';
  return (
    <div className="skills-code-block">
      <div className="skills-code-toolbar">
        <span>{language}</span>
        <button
          type="button"
          className="skills-icon-button"
          aria-label={t('skillsTab.copyCode')}
          onClick={async () => {
            if (await copyTextToClipboard(content)) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{t(copied ? 'skillsTab.copied' : 'skillsTab.copy')}</span>
        </button>
      </div>
      <pre>
        <code>{content}</code>
      </pre>
    </div>
  );
}

type MarkdownNode = {
  type?: string;
  tagName?: string;
  value?: string;
  children?: MarkdownNode[];
  properties?: Record<string, unknown>;
};
const nodeText = (node: MarkdownNode): string =>
  node.value ?? node.children?.map(nodeText).join('') ?? '';
function headingAnchors() {
  return (tree: MarkdownNode) => {
    const counts = new Map<string, number>();
    const walk = (node: MarkdownNode) => {
      if (/^h[1-6]$/.test(node.tagName ?? '')) {
        const base =
          nodeText(node)
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s/g, '-') || 'section';
        const count = counts.get(base) ?? 0;
        counts.set(base, count + 1);
        node.properties = { ...node.properties, id: count ? `${base}-${count}` : base };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

export default function SkillMarkdown({
  content,
  onReference,
  onAnchor,
}: {
  content: string;
  onReference?: (href: string) => void;
  onAnchor?: (anchor: string) => void;
}) {
  return (
    <article className="skills-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, headingAnchors]}
        components={{
          pre: CodeBlock,
          code: ({ children, className }) => {
            const value = String(children);
            return onReference &&
              !className &&
              !value.includes('\n') &&
              /^(?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt)$/.test(value) ? (
              <button
                type="button"
                className="skills-reference-link"
                onClick={() => onReference(value)}
              >
                <code>{children}</code>
              </button>
            ) : (
              <code className={className}>{children}</code>
            );
          },
          table: ({ children }) => (
            <div className="skills-markdown-table">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => {
            if (href && /^(https?:|mailto:)/i.test(href))
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            if (href?.startsWith('#'))
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    if (onAnchor) {
                      event.preventDefault();
                      onAnchor(href.slice(1));
                    }
                  }}
                >
                  {children}
                </a>
              );
            if (href && onReference)
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onReference(href);
                  }}
                >
                  {children}
                </a>
              );
            // Reference files are displayed without navigating away from the skill.
            return (
              <span className="skills-file-reference" title={href}>
                {children}
              </span>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
