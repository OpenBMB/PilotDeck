export const ADD_WORKSPACE_FILE_MENTION_EVENT = 'pilotdeck:add-workspace-file-mention';

export type WorkspaceFileMentionRequest = {
  projectName: string;
  relativePath: string;
};

export function isWorkspaceFileMentionRequest(
  value: unknown,
): value is WorkspaceFileMentionRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<WorkspaceFileMentionRequest>;
  return Boolean(
    typeof request.projectName === 'string'
      && request.projectName.trim()
      && typeof request.relativePath === 'string'
      && request.relativePath.trim(),
  );
}

const normalizeSlashes = (value: string) => value.replace(/\\/g, '/');

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function hasWorkspaceFileMention(input: string, relativePath: string): boolean {
  if (!input || !relativePath) return false;
  return new RegExp(`(?:^|\\s)${escapeRegExp(relativePath)}(?=$|\\s)`).test(input);
}

const isAbsolutePath = (value: string) =>
  value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.startsWith('//');

const trimTrailingSlashes = (value: string) => {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) return value;
  return value.replace(/\/+$/, '');
};

const normalizeRelativePath = (value: string): string | null => {
  const segments = value
    .split('/')
    .filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments.join('/');
};

export function getWorkspaceRelativePath(
  filePath: string,
  workspaceRoot: string,
): string | null {
  const normalizedFilePath = trimTrailingSlashes(normalizeSlashes(filePath));
  const normalizedRoot = trimTrailingSlashes(normalizeSlashes(workspaceRoot));

  if (!normalizedFilePath || !normalizedRoot) return null;

  if (!isAbsolutePath(normalizedFilePath)) {
    return normalizeRelativePath(normalizedFilePath);
  }

  const caseInsensitive = /^[A-Za-z]:\//.test(normalizedRoot);
  const comparableFilePath = caseInsensitive ? normalizedFilePath.toLowerCase() : normalizedFilePath;
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;

  const rootPrefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  if (!comparableFilePath.startsWith(rootPrefix)) return null;

  const relativePath = normalizedFilePath.slice(rootPrefix.length);
  return normalizeRelativePath(relativePath);
}

export type FileMentionInsertion = {
  input: string;
  cursorPosition: number;
  alreadyPresent: boolean;
};

export function insertWorkspaceFileMention(
  input: string,
  relativePath: string,
  requestedCursorPosition: number,
): FileMentionInsertion {
  if (hasWorkspaceFileMention(input, relativePath)) {
    return {
      input,
      cursorPosition: Math.max(0, Math.min(requestedCursorPosition, input.length)),
      alreadyPresent: true,
    };
  }

  const cursorPosition = Math.max(0, Math.min(requestedCursorPosition, input.length));
  const before = input.slice(0, cursorPosition);
  const after = input.slice(cursorPosition);
  const leadingSpace = before && !/\s$/.test(before) ? ' ' : '';
  const trailingSpace = after && /^\s/.test(after) ? '' : ' ';
  const insertedText = `${leadingSpace}${relativePath}${trailingSpace}`;

  return {
    input: `${before}${insertedText}${after}`,
    cursorPosition: before.length + insertedText.length,
    alreadyPresent: false,
  };
}
