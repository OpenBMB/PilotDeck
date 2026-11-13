import type { ReactNode } from 'react';

type TokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'builtin'
  | 'function'
  | 'operator'
  | 'punctuation'
  | 'property'
  | 'boolean';

type CodeToken = {
  text: string;
  type: TokenType;
};

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
]);

const PYTHON_BUILTINS = new Set([
  'dict', 'list', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'len', 'range', 'print',
  'open', 'enumerate', 'zip', 'map', 'filter', 'sum', 'min', 'max', 'json', 'Path',
  'Exception', 'ValueError', 'TypeError',
]);

function appendPlain(tokens: CodeToken[], text: string) {
  if (text) tokens.push({ text, type: 'plain' });
}

function tokenizeJson(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const pattern = /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,])/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    appendPlain(tokens, code.slice(cursor, match.index));
    const value = match[0];
    if (value.startsWith('"') && code.slice(pattern.lastIndex).trimStart().startsWith(':')) {
      tokens.push({ text: value, type: 'property' });
    } else if (value.startsWith('"')) {
      tokens.push({ text: value, type: 'string' });
    } else if (/^(true|false|null)$/.test(value)) {
      tokens.push({ text: value, type: 'boolean' });
    } else if (/^-?\d/.test(value)) {
      tokens.push({ text: value, type: 'number' });
    } else {
      tokens.push({ text: value, type: 'punctuation' });
    }
    cursor = pattern.lastIndex;
  }
  appendPlain(tokens, code.slice(cursor));
  return tokens;
}

function tokenizePython(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const pattern = /(#.*$|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|[+\-*/%=<>!&|^~]+|[(){}\[\],.:;])/gm;
  let cursor = 0;
  let expectFunctionName = false;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    appendPlain(tokens, code.slice(cursor, match.index));
    const value = match[0];
    let type: TokenType = 'plain';
    if (value.startsWith('#')) type = 'comment';
    else if (value.startsWith('"') || value.startsWith("'")) type = 'string';
    else if (/^\d/.test(value)) type = 'number';
    else if (expectFunctionName && /^[A-Za-z_]\w*$/.test(value)) {
      type = 'function';
      expectFunctionName = false;
    } else if (PYTHON_KEYWORDS.has(value)) {
      type = 'keyword';
      expectFunctionName = value === 'def' || value === 'class';
    } else if (PYTHON_BUILTINS.has(value)) type = 'builtin';
    else if (/^[+\-*/%=<>!&|^~]+$/.test(value)) type = 'operator';
    else if (/^[(){}\[\],.:;]$/.test(value)) type = 'punctuation';
    tokens.push({ text: value, type });
    cursor = pattern.lastIndex;
  }
  appendPlain(tokens, code.slice(cursor));
  return tokens;
}

function tokenizeMarkdown(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const pattern = /(^#{1,6}\s.*$|^[-*+]\s+|^>\s.*$|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)]+\)|https?:\/\/[^\s)]+|\b\d+(?:\.\d+)?\b)/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    appendPlain(tokens, code.slice(cursor, match.index));
    const value = match[0];
    let type: TokenType = 'plain';
    if (value.startsWith('#') || value.startsWith('>')) type = 'keyword';
    else if (/^[-*+]\s+$/.test(value)) type = 'operator';
    else if (value.startsWith('`') || value.startsWith('**')) type = 'string';
    else if (value.startsWith('[') || value.startsWith('http')) type = 'function';
    else if (/^\d/.test(value)) type = 'number';
    tokens.push({ text: value, type });
    cursor = pattern.lastIndex;
  }
  appendPlain(tokens, code.slice(cursor));
  return tokens;
}

function tokenize(code: string, language?: string): CodeToken[] {
  const normalized = (language || '').toLowerCase();
  if (['text', 'txt', 'log', 'stdout', 'stderr', 'plain'].includes(normalized)) return [{ text: code, type: 'plain' }];
  if (normalized.includes('json')) return tokenizeJson(code);
  if (normalized.includes('python') || normalized === 'py') return tokenizePython(code);
  if (normalized.includes('markdown') || normalized === 'md') return tokenizeMarkdown(code);
  return tokenizePython(code);
}

export function renderCodeTokens(code: string, language?: string) {
  const tokens = tokenize(code, language);
  return tokens.map((token, index): ReactNode => (
    token.type === 'plain'
      ? token.text
      : <span key={`${token.type}-${index}`} className={`code-token ${token.type}`}>{token.text}</span>
  ));
}

export default function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
  return (
    <pre className={['code-block-vscode', className].filter(Boolean).join(' ')} data-language={language || undefined}>
      <code>
        {renderCodeTokens(code, language)}
      </code>
    </pre>
  );
}

