import { useState, type ReactNode, type JSX } from 'react';
import CodeBlock from './FormalCodeBlock';
const CHAT_MARKDOWN_IMAGE_LINK_CLASS =
  'my-[10px] block w-fit max-w-full overflow-hidden rounded-[12px] border border-[#e3e7f1] bg-[#f7f8fa] no-underline shadow-[0_8px_24px_rgba(30,45,70,0.08)] transition hover:border-[#c9d2e4] hover:shadow-[0_10px_28px_rgba(30,45,70,0.12)]';
const CHAT_MARKDOWN_IMAGE_CLASS =
  'block max-h-[420px] max-w-full object-contain';
const CHAT_MD_TABLE_SCROLL_CLASS = 'my-[10px] max-w-full overflow-x-auto';
const CHAT_MD_TABLE_CLASS =
  'w-full border-collapse text-[13px] [&_th]:border [&_th]:border-[#e3e7f1] [&_th]:bg-[#f7f8fa] [&_th]:px-[10px] [&_th]:py-[6px] [&_th]:font-semibold [&_td]:border [&_td]:border-[#e3e7f1] [&_td]:px-[10px] [&_td]:py-[6px]';
function renderBareLinks(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  const trailingPunctuation = /[.,!?;:\uff0c\u3002\uff01\uff1f\uff1b\uff1a\u3001)\]}>]+$/;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[0];
    const label = candidate.replace(trailingPunctuation, '');
    if (!label) continue;
    const href = safeExternalHttpUrl(/^www\./i.test(label) ? `https://${label}` : label);
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (href) {
      nodes.push(
        <a key={`${keyPrefix}-url-${index}`} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else {
      nodes.push(label);
    }
    const trailing = candidate.slice(label.length);
    if (trailing) nodes.push(trailing);
    cursor = match.index + candidate.length;
    index += 1;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export type MarkdownRenderOptions = {
  renderInternalLink?: (link: { label: string; href: string; key: string }) => ReactNode;
};

function safeExternalHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function ExternalMarkdownImage({ alt, src }: { alt: string; src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span title={src}>{alt}</span>;
  }

  return (
    <a
      className={CHAT_MARKDOWN_IMAGE_LINK_CLASS}
      href={src}
      target="_blank"
      rel="noreferrer"
      aria-label={`查看图片：${alt}`}
    >
      <img
        className={CHAT_MARKDOWN_IMAGE_CLASS}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

export function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  options: MarkdownRenderOptions = {},
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]*`|\*\*[^*]+?\*\*|!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))+\))/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(...renderBareLinks(text.slice(cursor, match.index), `${keyPrefix}-${index}`));
    }
    const token = match[0];
    const key = `${keyPrefix}-inline-${index}`;
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), key, options)}</strong>);
    } else {
      const image = token.match(/^!\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)$/);
      if (image) {
        const alt = image[1].trim() || '图片';
        const src = safeExternalHttpUrl(image[2].trim());
        if (src) {
          nodes.push(
            <ExternalMarkdownImage key={key} src={src} alt={alt} />,
          );
        } else {
          nodes.push(<span key={key}>{alt}</span>);
        }
        cursor = match.index + token.length;
        index += 1;
        continue;
      }
      const link = token.match(/^\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)$/);
      if (link) {
        const href = link[2].trim();
        const label = link[1] || href;
        const safeHref = safeExternalHttpUrl(href);
        if (safeHref) {
          nodes.push(
            <a key={key} href={safeHref} target="_blank" rel="noreferrer">
              {label}
            </a>,
          );
        } else if (options.renderInternalLink) {
          nodes.push(options.renderInternalLink({ label, href, key }));
        } else {
          nodes.push(
            <span key={key} className="md-link-label" title={href}>
              {label}
            </span>,
          );
        }
      } else {
        nodes.push(token);
      }
    }
    cursor = match.index + token.length;
    index += 1;
  }

  if (cursor < text.length) {
    nodes.push(...renderBareLinks(text.slice(cursor), `${keyPrefix}-${index}`));
  }
  return nodes;
}

function softLineBreakSeparator(previousLine: string, currentLine: string): string {
  const previous = previousLine.trimEnd();
  const current = currentLine.trimStart();
  if (!previous || !current) return '';

  const previousCharacter = previous.charAt(previous.length - 1);
  const currentCharacter = current.charAt(0);
  const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  return cjkCharacter.test(previousCharacter) || cjkCharacter.test(currentCharacter) ? '' : ' ';
}

function renderInlineLines(
  lines: string[],
  keyPrefix: string,
  preserveLineBreaks: boolean,
  options: MarkdownRenderOptions,
): ReactNode[] {
  return lines.flatMap((line, lineIndex) => {
    const renderedLine = preserveLineBreaks ? line : line.trim();
    const nodes = renderInlineMarkdown(renderedLine, `${keyPrefix}-line-${lineIndex}`, options);
    if (lineIndex === 0) return nodes;
    const separator = preserveLineBreaks
      ? <br key={`${keyPrefix}-br-${lineIndex}`} />
      : softLineBreakSeparator(lines[lineIndex - 1], line);
    return [separator, ...nodes];
  });
}

type MarkdownTableAlign = 'left' | 'center' | 'right';

function splitMarkdownTableRow(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === '\\' && text[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function markdownTableAlign(separatorCell: string): MarkdownTableAlign {
  const normalized = separatorCell.replace(/\s+/g, '');
  if (normalized.startsWith(':') && normalized.endsWith(':')) return 'center';
  if (normalized.endsWith(':')) return 'right';
  return 'left';
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index].trim();
  if (!header.includes('|')) return false;
  return splitMarkdownTableRow(header).length >= 2 && isMarkdownTableSeparator(lines[index + 1]);
}

function renderMarkdownTable(
  lines: string[],
  startIndex: number,
  key: string,
  options: MarkdownRenderOptions,
): { node: ReactNode; nextIndex: number } {
  const header = splitMarkdownTableRow(lines[startIndex]);
  const separator = splitMarkdownTableRow(lines[startIndex + 1]);
  const aligns = separator.map(markdownTableAlign);
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length) {
    const row = lines[index].trim();
    if (!row || !row.includes('|') || isMarkdownTableSeparator(row)) break;
    const cells = splitMarkdownTableRow(row);
    if (cells.length < 2) break;
    rows.push(cells);
    index += 1;
  }

  const columnCount = Math.max(header.length, separator.length, ...rows.map((row) => row.length));
  const cellStyle = (cellIndex: number) => ({ textAlign: (aligns[cellIndex] || 'left') as MarkdownTableAlign });
  const renderCells = (cells: string[], rowKey: string) =>
    Array.from({ length: columnCount }, (_, cellIndex) => (
      <td key={`${rowKey}-${cellIndex}`} style={cellStyle(cellIndex)}>
        {renderInlineMarkdown(cells[cellIndex] || '', `${rowKey}-${cellIndex}`, options)}
      </td>
    ));

  return {
    nextIndex: index,
    node: (
      <div key={key} className={CHAT_MD_TABLE_SCROLL_CLASS}>
        <table className={CHAT_MD_TABLE_CLASS}>
          <thead>
            <tr>
              {Array.from({ length: columnCount }, (_, cellIndex) => (
                <th key={`${key}-head-${cellIndex}`} style={cellStyle(cellIndex)}>
                  {renderInlineMarkdown(header[cellIndex] || '', `${key}-head-${cellIndex}`, options)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>{renderCells(row, `${key}-row-${rowIndex}`)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  };
}

function isBlockBoundary(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('```') ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
    /^#{1,6}\s+/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^[-*]\s+/.test(trimmed) ||
    /^\d+[.)]\s+/.test(trimmed)
  );
}

export function renderMarkdownBlocks(
  content: string,
  preserveLineBreaks = true,
  options: MarkdownRenderOptions = {},
): ReactNode[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;
  let continuedOrderedListStart: number | null = null;

  const resetOrderedListSequence = () => {
    continuedOrderedListStart = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const key = `md-${blockIndex}`;
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      resetOrderedListSequence();
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <CodeBlock key={key} className="md-code-block" code={codeLines.join('\n')} language={language || undefined} />,
      );
      blockIndex += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      resetOrderedListSequence();
      blocks.push(<hr key={key} />);
      index += 1;
      blockIndex += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      resetOrderedListSequence();
      const level = Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={key}>{renderInlineMarkdown(heading[2], key, options)}</Tag>);
      index += 1;
      blockIndex += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      resetOrderedListSequence();
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={key}>
          {renderMarkdownBlocks(quoteLines.join('\n'), preserveLineBreaks, options)}
        </blockquote>,
      );
      blockIndex += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      resetOrderedListSequence();
      const table = renderMarkdownTable(lines, index, key, options);
      blocks.push(table.node);
      index = table.nextIndex;
      blockIndex += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={key}>
          {items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>
              {renderInlineMarkdown(item, `${key}-${itemIndex}`, options)}
            </li>
          ))}
        </ul>,
      );
      blockIndex += 1;
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: Array<{ marker: number; content: string }> = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        const item = lines[index].trim().match(/^(\d+)[.)]\s+(.+)$/);
        if (!item) break;
        items.push({ marker: Number(item[1]), content: item[2] });
        index += 1;
      }
      const explicitStart = items[0]?.marker || 1;
      const listStart: number = explicitStart === 1 && continuedOrderedListStart !== null
        ? continuedOrderedListStart
        : explicitStart;
      blocks.push(
        <ol key={key} start={listStart === 1 ? undefined : listStart}>
          {items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>
              {renderInlineMarkdown(item.content, `${key}-${itemIndex}`, options)}
            </li>
          ))}
        </ol>,
      );
      continuedOrderedListStart = listStart + items.length;
      blockIndex += 1;
      continue;
    }

    resetOrderedListSequence();
    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockBoundary(lines[index]) &&
      !isMarkdownTableStart(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={key}>{renderInlineLines(paragraphLines, key, preserveLineBreaks, options)}</p>,
    );
    blockIndex += 1;
  }

  return blocks;
}
