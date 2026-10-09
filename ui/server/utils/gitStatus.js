/** Porcelain -z keeps filenames verbatim, including whitespace, newlines and quotes. */
export function gitStatusError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const notRepository = /not a git repository|does not contain a \.git/i.test(message);
  return { ...(notRepository ? { isRepository: false, code: 'NOT_GIT_REPOSITORY' } : {}), error: notRepository ? message : 'Git operation failed', details: `Failed to get git status: ${message}` };
}

export function parseGitStatus(output) {
  const records = output.split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const indexStatus = record[0], worktreeStatus = record[1], filePath = record.slice(3);
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C';
    const originalPath = renamed ? records[++index] : undefined;
    const conflicted = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(record.slice(0, 2));
    entries.push({ path: filePath, indexStatus, worktreeStatus, originalPath, conflicted,
      staged: indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!' && !conflicted,
      unstaged: worktreeStatus !== ' ' && worktreeStatus !== '!' && !conflicted,
      untracked: indexStatus === '?' });
  }
  return entries;
}
