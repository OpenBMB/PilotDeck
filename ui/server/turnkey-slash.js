const TURNKEY_SUBCOMMANDS = [
  'start',
  'onboard',
  'clarify',
  'design',
  'spec',
  'tdd',
  'develop',
  'test',
  'review',
  'ship',
];

function buildUsageMarkdown() {
  return [
    '# Turnkey Slash',
    '',
    'Usage:',
    '- `/turnkey start <ticket text>`',
    '- `/turnkey onboard`',
    '- `/turnkey clarify`',
    '- `/turnkey design`',
    '- `/turnkey spec`',
    '- `/turnkey tdd`',
    '- `/turnkey develop`',
    '- `/turnkey test`',
    '- `/turnkey review`',
    '- `/turnkey ship`',
    '- `/turnkey help`',
  ].join('\n');
}

function buildHelpResponse(content) {
  return {
    type: 'builtin',
    action: 'help',
    data: {
      content,
      format: 'markdown',
    },
  };
}

export function parseTurnkeySlashArgs(args = []) {
  const [subcommandRaw, ...rest] = Array.isArray(args) ? args : [];
  const subcommand = String(subcommandRaw || '').trim().toLowerCase();

  if (!subcommand || subcommand === 'help') {
    return { action: 'help' };
  }

  if (!TURNKEY_SUBCOMMANDS.includes(subcommand)) {
    return {
      action: 'help',
      error: `Unknown /turnkey action: \`${subcommand}\``,
    };
  }

  return {
    action: 'forward',
    subcommand,
    args: rest,
  };
}

export async function executeTurnkeySlashCommand(args = []) {
  const parsed = parseTurnkeySlashArgs(args);
  if (parsed.action === 'help') {
    const content = parsed.error
      ? `${parsed.error}\n\n${buildUsageMarkdown()}`
      : buildUsageMarkdown();
    return buildHelpResponse(content);
  }

  const forwarded = [`/turnkey:${parsed.subcommand}`, ...parsed.args]
    .join(' ')
    .trim();
  return {
    type: 'custom',
    content: forwarded,
    hasFileIncludes: false,
    hasBashCommands: false,
  };
}

export { buildUsageMarkdown as getTurnkeySlashUsage };
