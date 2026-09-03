const WINDOWS_CMD_SHIMS = new Set([
  'claude',
  'clawhub',
  'npm',
  'npx',
  'task-master',
  'task-master-ai',
]);

function isWindows(platform = process.platform) {
  return platform === 'win32';
}

function hasWindowsExecutableExtension(command) {
  return /\.(?:cmd|exe|bat|com)$/i.test(command);
}

function isWindowsCommandScript(command) {
  return /\.(?:cmd|bat)$/i.test(command);
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  return `"${text.replace(/(["^&|<>()%!])/g, '^$1')}"`;
}

function buildWindowsCmdLine(command, args) {
  return [command, ...args].map(quoteWindowsCmdArg).join(' ');
}

export function resolveWindowsCliCommand(command, platform = process.platform) {
  if (!isWindows(platform)) return command;

  const normalized = String(command).toLowerCase();
  if (normalized === 'which') return 'where.exe';
  if (WINDOWS_CMD_SHIMS.has(normalized) && !hasWindowsExecutableExtension(command)) {
    return `${command}.cmd`;
  }
  return command;
}

export function prepareCliSpawn(command, args = [], options = {}, platform = process.platform) {
  const windows = isWindows(platform);
  const resolvedCommand = resolveWindowsCliCommand(command, platform);
  const windowsOptions = windows
    ? { ...options, shell: false, windowsHide: true }
    : { ...options, shell: options.shell };

  if (windows && isWindowsCommandScript(resolvedCommand)) {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${buildWindowsCmdLine(resolvedCommand, args)}"`],
      options: {
        ...windowsOptions,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    command: resolvedCommand,
    args,
    options: windowsOptions,
  };
}

export function prepareBackgroundSpawnOptions(options = {}, platform = process.platform) {
  const windows = isWindows(platform);
  return {
    ...options,
    detached: windows ? false : options.detached,
    windowsHide: windows ? true : options.windowsHide,
  };
}

export function getOpenUrlSpawnCommand(url, platform = process.platform) {
  if (isWindows(platform)) {
    return { command: 'explorer.exe', args: [url] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  return { command: 'xdg-open', args: [url] };
}
