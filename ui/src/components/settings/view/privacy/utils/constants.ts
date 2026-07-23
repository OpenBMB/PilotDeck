const IS_WINDOWS =
  typeof navigator !== "undefined" &&
  /win/i.test(navigator.userAgent) &&
  !/darwin/i.test(navigator.userAgent);

export const QUICK_ADD_TOOLS = [
  "bash:git log:*",
  "bash:git diff:*",
  "bash:git status:*",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "agent",
  "task_create",
  "web_fetch",
  "web_search",
];

const QUICK_BLOCK_TOOLS_UNIX = ["bash:rm:*", "bash:sudo:*"];
const QUICK_BLOCK_TOOLS_WINDOWS = [
  "bash:rm:*",
  "bash:Remove-Item:*",
  "bash:del /s:*",
  "bash:rd /s:*",
  "bash:Format-Volume:*",
  "bash:Start-Process:*",
];

export const QUICK_BLOCK_TOOLS = IS_WINDOWS
  ? QUICK_BLOCK_TOOLS_WINDOWS
  : QUICK_BLOCK_TOOLS_UNIX;
