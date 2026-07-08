const LINKABLE_INLINE_FILE_EXTENSIONS = new Set([
  'pdf', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'txt', 'md', 'csv', 'json', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'py', 'js', 'ts', 'tsx', 'css',
]);

const escapeMarkdownLinkText = (value: string): string => value.replace(/([\\\]\[])/g, '\\$1');

const toFileHref = (pathValue: string): string => {
  if (/^file:\/\//i.test(pathValue)) return pathValue;
  if (pathValue.startsWith('/')) return `file://${encodeURI(pathValue)}`;
  return encodeURI(pathValue.replace(/\\/g, '/'));
};

function linkifyFilePaths(content: string): string {
  const pattern = /((?:file:\/\/)?\/(?:[^\s`'"<>])+\.[A-Za-z0-9]{1,10}|(?:\.\/)?\b[A-Za-z0-9._-][A-Za-z0-9._/-]*\.[A-Za-z0-9]{1,10}\b)/gu;
  return content.replace(pattern, (match, pathValue: string, offset: number, fullText: string) => {
    const before = fullText.slice(Math.max(0, offset - 2), offset);
    const after = fullText.slice(offset + match.length, offset + match.length + 1);
    if (before.includes('](') || after === ')') return match;
    const extension = pathValue.split('.').pop()?.toLowerCase() || '';
    if (!LINKABLE_INLINE_FILE_EXTENSIONS.has(extension)) return match;
    return `[${escapeMarkdownLinkText(pathValue)}](${toFileHref(pathValue)})`;
  });
}

function linkifyInlineMarkdownText(content: string): string {
  let result = '';
  let index = 0;

  while (index < content.length) {
    const codeStart = content.indexOf('`', index);
    if (codeStart === -1) {
      result += linkifyFilePaths(content.slice(index));
      break;
    }

    result += linkifyFilePaths(content.slice(index, codeStart));

    const fenceEnd = content.slice(codeStart).match(/^`+/)?.[0] ?? '`';
    const codeEnd = content.indexOf(fenceEnd, codeStart + fenceEnd.length);
    if (codeEnd === -1) {
      result += linkifyFilePaths(content.slice(codeStart));
      break;
    }

    result += content.slice(codeStart, codeEnd + fenceEnd.length);
    index = codeEnd + fenceEnd.length;
  }

  return result;
}

export function linkifyFilePathsOutsideCode(content: string): string {
  const lines = content.split(/(\n)/);
  let inFencedCodeBlock = false;
  let atLineStart = true;

  return lines.map((segment) => {
    if (segment === '\n') {
      atLineStart = true;
      return segment;
    }

    const fenceMatch = atLineStart ? segment.match(/^\s*(`{3,}|~{3,})/) : null;
    if (fenceMatch) {
      inFencedCodeBlock = !inFencedCodeBlock;
      atLineStart = false;
      return segment;
    }

    atLineStart = false;
    if (inFencedCodeBlock) return segment;

    return linkifyInlineMarkdownText(segment);
  }).join('');
}
