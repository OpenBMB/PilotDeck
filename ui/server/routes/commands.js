import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CURSOR_MODELS, CODEX_MODELS } from '../../shared/modelConstants.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { getClaudeRuntimeModelConfig, getClaudeRuntimeModelValues } from '../utils/claude-runtime-config.js';
import { readPilotDeckConfigFile, resolveModel } from '../services/pilotdeckConfig.js';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { executeTurnkeySlashCommand } from '../turnkey-slash.js';
import { getRegisteredCommands } from '../../../src/adapters/channel/protocol/ChannelCommandRegistry.js';
import { runChatSearchFormatted } from '../../../src/cli/commands/chatSearch.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

/**
 * Slash commands curated to always appear at the top of the menu in this exact
 * order, regardless of usage history. Names that don't resolve to a real
 * on-disk command/skill or a bundled stub below are silently dropped.
 */
const PINNED_COMMAND_NAMES = [
  '/skill_install',
  '/projects',
  '/switch-project',
];

/**
 * Bundled skills registered via the skill registry in the CLI binary.
 * They are not on disk, so the directory scanners can't see them — we surface stub
 * entries so the UI menu can suggest them. The actual execution still happens
 * agent-side: typing `/projects` sends the slash text through, the proxy hands
 * it to the bundled-skill registry, and the result streams back.
 */
const BUNDLED_SKILL_STUBS = [
  {
    name: '/projects',
    description:
      'List every PilotDeck project visible to the TUI, gateway, and UI.',
    metadata: { type: 'bundled-skill' },
  },
  {
    name: '/switch-project',
    description:
      'Switch the active project for the current gateway/IM conversation (no-op in TUI — those manage active project themselves).',
    metadata: { type: 'bundled-skill', argumentHint: '<project name>' },
  },
];

/**
 * Recursively scan directory for command files (.md)
 * @param {string} dir - Directory to scan
 * @param {string} baseDir - Base directory for relative paths
 * @param {string} namespace - Namespace for commands (e.g., 'project', 'user')
 * @returns {Promise<Array>} Array of command objects
 */
async function scanCommandsDirectory(dir, baseDir, namespace) {
  const commands = [];

  try {
    // Check if directory exists
    await fs.access(dir);

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        const subCommands = await scanCommandsDirectory(fullPath, baseDir, namespace);
        commands.push(...subCommands);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Parse markdown file for metadata
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          const { data: frontmatter, content: commandContent } = parseFrontmatter(content);

          // Calculate relative path from baseDir for command name
          const relativePath = path.relative(baseDir, fullPath);
          // Remove .md extension and convert to command name
          const commandName = '/' + relativePath.replace(/\.md$/, '').replace(/\\/g, '/');

          // Extract description from frontmatter or first line of content
          let description = frontmatter.description || '';
          if (!description) {
            const firstLine = commandContent.trim().split('\n')[0];
            description = firstLine.replace(/^#+\s*/, '').trim();
          }

          commands.push({
            name: commandName,
            path: fullPath,
            relativePath,
            description,
            namespace,
            metadata: frontmatter
          });
        } catch (err) {
          console.error(`Error parsing command file ${fullPath}:`, err.message);
        }
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be accessed - this is okay
    if (err.code !== 'ENOENT' && err.code !== 'EACCES') {
      console.error(`Error scanning directory ${dir}:`, err.message);
    }
  }

  return commands;
}

/**
 * subdirectory `<dir>/<name>/SKILL.md` becomes the slash command `/<name>`.
 * Mirrors the upstream `loadSkillsFromSkillsDir` convention
 * so disk semantics stay aligned: directory format only, name = parent dir,
 * frontmatter parsed for description/metadata.
 *
 * @param {string} namespace - 'project' or 'user'
 * @returns {Promise<Array>} Skill command objects
 */
async function scanSkillsDirectory(dir, namespace) {
  const skills = [];

  try {
    await fs.access(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const skillDir = path.join(dir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');

      let content;
      try {
        content = await fs.readFile(skillFile, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Error reading SKILL.md at ${skillFile}:`, err.message);
        }
        continue;
      }

      try {
        const { data: frontmatter, content: skillContent } = parseFrontmatter(content);

        const skillName = '/' + entry.name;
        let description = frontmatter.description || '';
        if (!description) {
          const firstLine = skillContent.trim().split('\n')[0];
          description = firstLine.replace(/^#+\s*/, '').trim();
        }

        skills.push({
          name: skillName,
          path: skillFile,
          relativePath: path.join(entry.name, 'SKILL.md'),
          description,
          namespace,
          metadata: { ...frontmatter, type: 'skill' },
        });
      } catch (err) {
        console.error(`Error parsing skill ${skillFile}:`, err.message);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EACCES') {
      console.error(`Error scanning skills directory ${dir}:`, err.message);
    }
  }

  return skills;
}

/**
 * Built-in commands that are always available.
 *
 * Web-UI-only commands (that don't make sense in IM channels) are defined here.
 * Commands shared with IM channels (/update, /projects, /switch-project, /status,
 * /help) are auto-merged from ChannelCommandRegistry — single source of truth.
 */
const webOnlyBuiltInCommands = [
  {
    name: '/clear',
    description: 'Clear the conversation history',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/model',
    description: 'View the current AI model and available options',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/cost',
    description: 'Display token usage and cost information',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/memory',
    description: 'Open PILOTDECK.md memory file for editing',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/config',
    description: 'Open settings and configuration',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/rewind',
    description: 'Rewind the conversation to a previous state',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/ao',
    description: 'List, run, or inspect Always-On cron jobs and discovery plans',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/turnkey',
    description: 'Run turnkey workflow subcommands (for example: /turnkey start)',
    namespace: 'builtin',
    metadata: { type: 'builtin' }
  },
  {
    name: '/skill_install',
    description:
      'Install a skill from clawhub.com. Auto-targets ~/.pilotdeck/skills/<slug> in general chat and <project>/.pilotdeck/skills/<slug> when a project is active. Use --global / --project to override.',
    namespace: 'builtin',
    metadata: {
      type: 'builtin',
      argumentHint: '<slug> [--version <v>] [--force] [--global|--project] [--registry <url>]',
    },
  },
];

// Merge commands from the centralized ChannelCommandRegistry.
// This ensures /update, /projects, /switch-project, etc. appear in the
// Web UI menu automatically when added to the registry.
const registryCommands = getRegisteredCommands()
  .filter((cmd) => cmd.name !== 'new') // /new is implicit (new session button)
  .map((cmd) => ({
    name: '/' + cmd.name,
    description: cmd.description,
    namespace: 'builtin',
    metadata: { type: 'builtin', source: 'registry' },
  }));

const builtInCommands = [
  ...webOnlyBuiltInCommands,
  ...registryCommands.filter(
    (rc) => !webOnlyBuiltInCommands.some((w) => w.name === rc.name),
  ),
];

/**
 * Built-in command handlers
 * Each handler returns { type: 'builtin', action: string, data: any }
 */
async function executeSearchCommand(args, context) {
  const rawArg = (args || []).join(' ').trim();
  if (!rawArg) {
    return {
      type: 'builtin',
      action: 'search',
      data: {
        error: true,
        content: 'Usage: /search <keyword> [--all] [--limit N] [--role user|assistant]\nExample: /search docker deploy',
      },
    };
  }

  const { result, text } = await runChatSearchFormatted({
    arg: rawArg,
    projectRoot: context?.projectPath,
    pilotHome: resolvePilotHome(process.env),
    locale: 'en',
  });

  return {
    type: 'builtin',
    action: 'search',
    data: {
      content: text,
      format: 'markdown',
      query: result.query,
      matches: result.matches,
      truncated: result.truncated,
      sessionsScanned: result.sessionsScanned,
    },
  };
}

const builtInHandlers = {
  '/help': async (args, context) => {
    const helpText = `# PilotDeck Commands

## Built-in Commands

${builtInCommands.map(cmd => `### ${cmd.name}
${cmd.description}
`).join('\n')}

## Custom Commands

Custom commands can be created in:
- Project: \`.pilotdeck/commands/\` (project-specific)
- User: \`~/.pilotdeck/commands/\` (available in all projects)

### Command Syntax

- **Arguments**: Use \`$ARGUMENTS\` for all args or \`$1\`, \`$2\`, etc. for positional
- **File Includes**: Use \`@filename\` to include file contents
- **Bash Commands**: Use \`!command\` to execute bash commands

### Examples

\`\`\`markdown
/mycommand arg1 arg2
\`\`\`
`;

    return {
      type: 'builtin',
      action: 'help',
      data: {
        content: helpText,
        format: 'markdown'
      }
    };
  },

  '/clear': async (args, context) => {
    return {
      type: 'builtin',
      action: 'clear',
      data: {
        message: 'Conversation history cleared'
      }
    };
  },

  '/model': async (args, context) => {
    const { config } = readPilotDeckConfigFile();
    const mainRef = config?.agent?.model || '';
    const resolved = resolveModel(config, mainRef, { allowMissing: true });
    const currentModel = resolved ? resolved.id : mainRef || '(not configured)';

    const providers = config?.model?.providers || {};
    const available = {};
    for (const [pid, provider] of Object.entries(providers)) {
      const models = provider.models;
      if (models && typeof models === 'object') {
        available[pid] = Object.keys(models);
      }
    }

    return {
      type: 'builtin',
      action: 'model',
      data: {
        current: {
          provider: resolved?.providerId || '',
          model: currentModel
        },
        available,
        message: args.length > 0
          ? `Switching to model: ${args[0]}`
          : `Current model: ${currentModel}`
      }
    };
  },

  '/cost': async (args, context) => {
    const tokenUsage = context?.tokenUsage || {};
    const { config: pdConfig } = readPilotDeckConfigFile();
    const mainRef = pdConfig?.agent?.model || '';
    const resolvedMain = resolveModel(pdConfig, mainRef, { allowMissing: true });
    const provider = context?.provider || resolvedMain?.providerId || 'unknown';
    const model = context?.model || (resolvedMain ? resolvedMain.id : mainRef || '(not configured)');

    const used = Number(tokenUsage.used ?? tokenUsage.totalUsed ?? tokenUsage.total_tokens ?? 0) || 0;
    const total =
      Number(
        tokenUsage.total ??
          tokenUsage.contextWindow ??
          parseInt(process.env.CONTEXT_WINDOW || '160000', 10),
      ) || 160000;
    const percentage = total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0;

    const inputTokensRaw =
      Number(
        tokenUsage.inputTokens ??
          tokenUsage.input ??
          tokenUsage.cumulativeInputTokens ??
          tokenUsage.promptTokens ??
          0,
      ) || 0;
    const outputTokens =
      Number(
        tokenUsage.outputTokens ??
          tokenUsage.output ??
          tokenUsage.cumulativeOutputTokens ??
          tokenUsage.completionTokens ??
          0,
      ) || 0;
    const cacheTokens =
      Number(
        tokenUsage.cacheReadTokens ??
          tokenUsage.cacheCreationTokens ??
          tokenUsage.cacheTokens ??
          tokenUsage.cachedTokens ??
          0,
      ) || 0;

    // If we only have total used tokens, treat them as input for display/estimation.
    const inputTokens =
      inputTokensRaw > 0 || outputTokens > 0 || cacheTokens > 0 ? inputTokensRaw + cacheTokens : used;

    // Rough default rates by provider (USD / 1M tokens).
    const pricingByProvider = {
      claude: { input: 3, output: 15 },
      cursor: { input: 3, output: 15 },
      codex: { input: 1.5, output: 6 },
    };
    const rates = pricingByProvider[provider] || pricingByProvider.claude;

    const inputCost = (inputTokens / 1_000_000) * rates.input;
    const outputCost = (outputTokens / 1_000_000) * rates.output;
    const totalCost = inputCost + outputCost;

    return {
      type: 'builtin',
      action: 'cost',
      data: {
        tokenUsage: {
          used,
          total,
          percentage,
        },
        cost: {
          input: inputCost.toFixed(4),
          output: outputCost.toFixed(4),
          total: totalCost.toFixed(4),
        },
        model,
      },
    };
  },

  '/status': async (args, context) => {
    const packageJsonPath = path.join(path.dirname(__dirname), '..', 'package.json');
    let version = 'unknown';
    let packageName = 'pilotdeck';

    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      version = packageJson.version;
      packageName = packageJson.name;
    } catch (err) {
      console.error('Error reading package.json:', err);
    }

    const { config } = readPilotDeckConfigFile();
    const mainRef = config?.agent?.model || '';
    const resolved = resolveModel(config, mainRef, { allowMissing: true });

    const uptime = process.uptime();
    const uptimeMinutes = Math.floor(uptime / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeFormatted = uptimeHours > 0
      ? `${uptimeHours}h ${uptimeMinutes % 60}m`
      : `${uptimeMinutes}m`;

    return {
      type: 'builtin',
      action: 'status',
      data: {
        version,
        packageName,
        uptime: uptimeFormatted,
        uptimeSeconds: Math.floor(uptime),
        model: resolved ? resolved.id : mainRef || '(not configured)',
        provider: resolved?.providerId || '',
        nodeVersion: process.version,
        platform: process.platform
      }
    };
  },

  '/memory': async (args, context) => {
    const projectPath = context?.projectPath;

    if (!projectPath) {
      return {
        type: 'builtin',
        action: 'memory',
        data: {
          error: 'No project selected',
          message: 'Please select a project to access its PILOTDECK.md file'
        }
      };
    }

    const pilotDeckMdPath = path.join(projectPath, 'PILOTDECK.md');

    // Check if PILOTDECK.md exists
    let exists = false;
    try {
      await fs.access(pilotDeckMdPath);
      exists = true;
    } catch (err) {
      // File doesn't exist
    }

    return {
      type: 'builtin',
      action: 'memory',
      data: {
        path: pilotDeckMdPath,
        exists,
        message: exists
          ? `Opening PILOTDECK.md at ${pilotDeckMdPath}`
          : `PILOTDECK.md not found at ${pilotDeckMdPath}. Create it to store project-specific instructions.`
      }
    };
  },

  '/config': async (args, context) => {
    return {
      type: 'builtin',
      action: 'config',
      data: {
        message: 'Opening settings...'
      }
    };
  },

  '/rewind': async (args, context) => {
    const steps = args[0] ? parseInt(args[0]) : 1;

    if (isNaN(steps) || steps < 1) {
      return {
        type: 'builtin',
        action: 'rewind',
        data: {
          error: 'Invalid steps parameter',
          message: 'Usage: /rewind [number] - Rewind conversation by N steps (default: 1)'
        }
      };
    }

    return {
      type: 'builtin',
      action: 'rewind',
      data: {
        steps,
        message: `Rewinding conversation by ${steps} step${steps > 1 ? 's' : ''}...`
      }
    };
  },

  '/turnkey': async (args) => executeTurnkeySlashCommand(args),

  '/search': executeSearchCommand,
  '/find': executeSearchCommand,
  '/grep': executeSearchCommand,

  '/update': async (args, context) => {
    const subcommand = (args && args[0]) || 'apply';

    if (subcommand === 'check') {
      try {
        const result = await execFileAsync('bash', [
          '-c',
          'cd "$(git rev-parse --show-toplevel)" && git fetch origin "$(git branch --show-current)" 2>/dev/null && ' +
          'LOCAL=$(git rev-parse HEAD) && REMOTE=$(git rev-parse "origin/$(git branch --show-current)") && ' +
          'if [ "$LOCAL" = "$REMOTE" ]; then echo "up-to-date"; else echo "update-available"; fi'
        ], { timeout: 30000 });
        const hasUpdate = result.stdout.trim() === 'update-available';
        return {
          type: 'builtin',
          action: 'update',
          data: {
            subcommand: 'check',
            hasUpdate,
            message: hasUpdate
              ? 'New version available! Run `/update` to apply.'
              : 'Already up-to-date.',
          },
        };
      } catch (e) {
        return {
          type: 'builtin',
          action: 'update',
          data: {
            subcommand: 'check',
            error: true,
            message: `Failed to check for updates: ${e.message}`,
          },
        };
      }
    }

    // Default: trigger the update via the API endpoint.
    // The frontend will call /api/update/apply and stream progress.
    return {
      type: 'builtin',
      action: 'update',
      data: {
        subcommand: 'apply',
        message: 'Starting update... pulling latest code, rebuilding, and restarting.',
        triggerApi: '/api/update/apply',
      },
    };
  },

  '/switch-project': async (args) => {
    // Trim quotes / whitespace; the rest of the project resolution (matching
    // against the user's project list, navigating, expanding the sidebar
    // entry) happens on the client where we already have the projects state.
    const requested = (args || []).join(' ').trim().replace(/^["']|["']$/g, '');
    if (!requested) {
      return {
        type: 'builtin',
        action: 'switchProject',
        data: {
          error: true,
          message: 'Usage: /switch-project <project-name>'
        }
      };
    }
    return {
      type: 'builtin',
      action: 'switchProject',
      data: {
        projectName: requested,
        message: `Switching to project: ${requested}`
      }
    };
  },

  // /skill_install — server-side clawhub install. Deterministic, no model in
  // the loop.
  //
  // Scope policy (auto-detected, override-able):
  //   - In general chat (no projectPath in context) → user scope:
  //   - In a project's chat (projectPath set)        → project scope:
  //   - Explicit override: --global forces user scope, --project forces project
  //     scope (errors out if no projectPath available).
  //
  // Any positional after slug is rejected. Slug is validated against a strict
  // regex to block path traversal — execFile already prevents shell injection
  // since args are passed as an array, but we also refuse `..` defensively.
  '/skill_install': async (args, context) => {
    const argList = Array.isArray(args) ? args : [];

    let slug = null;
    let version = null;
    let force = false;
    let scopeOverride = null; // 'user' | 'project' | null
    let registry = null;

    for (let i = 0; i < argList.length; i++) {
      const token = argList[i];
      if (token === '--version' && i + 1 < argList.length) {
        version = argList[++i];
        continue;
      }
      if (token === '--force') { force = true; continue; }
      if (token === '--project') { scopeOverride = 'project'; continue; }
      if (token === '--global' || token === '--user') { scopeOverride = 'user'; continue; }
      if (token === '--registry' && i + 1 < argList.length) {
        registry = argList[++i];
        continue;
      }
      if (token.startsWith('--')) {
        return {
          type: 'builtin',
          action: 'skillInstall',
          data: { error: true, message: `Unknown flag: ${token}` },
        };
      }
      if (slug === null) { slug = token; continue; }
      return {
        type: 'builtin',
        action: 'skillInstall',
        data: { error: true, message: `Unexpected positional argument: ${token}` },
      };
    }

    if (!slug) {
      return {
        type: 'builtin',
        action: 'skillInstall',
        data: {
          error: true,
          message:
            'Usage: /skill_install <slug> [--version <ver>] [--force] [--global|--project] [--registry <url>]',
        },
      };
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug) || slug.includes('..')) {
      return {
        type: 'builtin',
        action: 'skillInstall',
        data: {
          error: true,
          message: `Invalid slug "${slug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
        },
      };
    }

    const projectPath = context?.projectPath || null;

    // PilotDeck's virtual "general" workspace roots at ~/.pilotdeck. It looks
    // like a real projectPath but the user's mental model is general chat →
    // user/global scope. Force user scope with --global when needed.
    const GENERAL_CWD_PATHS = [path.resolve(resolvePilotHome(process.env))];
    const isGeneralCwd =
      projectPath && GENERAL_CWD_PATHS.includes(path.resolve(projectPath));
    const effectiveProjectPath = isGeneralCwd ? null : projectPath;

    const scope = scopeOverride || (effectiveProjectPath ? 'project' : 'user');

    let workdir;
    let dir;
    if (scope === 'project') {
      if (!effectiveProjectPath) {
        return {
          type: 'builtin',
          action: 'skillInstall',
          data: {
            error: true,
            message: isGeneralCwd
              ? '--project cannot be used in general chat (no real project active). Drop --project to install globally, or open a project chat first.'
              : '--project requires an active project (no projectPath in context).',
          },
        };
      }
      workdir = effectiveProjectPath;
      dir = path.join('.pilotdeck', 'skills');
    } else {
      workdir = resolvePilotHome(process.env);
      dir = 'skills';
    }
    const installPath = path.join(workdir, dir, slug);

    // --no-input is a global flag, must come BEFORE the subcommand.
    const clawArgs = ['--no-input', '--workdir', workdir, '--dir', dir];
    if (registry) clawArgs.push('--registry', registry);
    clawArgs.push('install', slug);
    if (version) clawArgs.push('--version', version);
    if (force) clawArgs.push('--force');

    let stdout = '';
    let stderr = '';
    let runError = null;
    try {
      const result = await execFileAsync('clawhub', clawArgs, {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (e) {
      runError = e;
      stdout = e.stdout || '';
      stderr = e.stderr || '';
    }

    let installed = false;
    let skillMeta = null;
    try {
      await fs.access(path.join(installPath, 'SKILL.md'));
      installed = true;
      try {
        const content = await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf8');
        const { data: fm } = parseFrontmatter(content);
        skillMeta = {
          name: fm.name || slug,
          description: fm.description || '',
          version: fm.version || null,
        };
      } catch {
        /* SKILL.md exists but unreadable/unparseable — keep installed=true */
      }
    } catch {
      /* SKILL.md missing — installed stays false */
    }

    if (runError && runError.code === 'ENOENT') {
      return {
        type: 'builtin',
        action: 'skillInstall',
        data: {
          error: true,
          message:
            'clawhub CLI not found in PATH. Install it with `npm install -g clawhub`, then retry.',
        },
      };
    }

    // Detect "suspicious skill, --force required" — clawhub's --no-input mode
    // refuses VirusTotal-flagged skills without explicit consent. Surface a
    // copy-pasteable retry command instead of burying the hint in stderr.
    const needsForce =
      !installed &&
      !force &&
      (stderr || stdout).match(/Use --force to install suspicious/i) !== null;

    let retryCommand = null;
    if (needsForce) {
      const overrideFlag =
        scopeOverride === 'user'
          ? ' --global'
          : scopeOverride === 'project'
            ? ' --project'
            : '';
      const versionFlag = version ? ` --version ${version}` : '';
      const registryFlag = registry ? ` --registry ${registry}` : '';
      retryCommand = `/skill_install ${slug}${overrideFlag} --force${versionFlag}${registryFlag}`;
    }

    return {
      type: 'builtin',
      action: 'skillInstall',
      data: {
        slug,
        version: version || null,
        scope,
        scopeAutoDetected: scopeOverride === null,
        projectPath: effectiveProjectPath,
        rawProjectPath: projectPath,
        isGeneralCwd,
        installPath,
        installed,
        skillMeta,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: runError ? (runError.code === undefined ? 1 : runError.code) : 0,
        errorMessage: runError ? (runError.shortMessage || runError.message) : null,
        needsForce,
        retryCommand,
      },
    };
  },
};

/**
 * POST /api/commands/list
 * List all available commands from project and user directories
 *
 * Discovery layout:
 *   - Built-in commands: hardcoded in this file (handled by builtInHandlers).
 *   - Bundled skills: hardcoded stubs (BUNDLED_SKILL_STUBS) — actual handlers
 *     live in the CLI binary; we only surface them so the UI menu shows them.
 *   - On-disk commands: `.pilotdeck/commands/**\/*.md` (project + user).
 *
 * Dedup: when the same `/<name>` exists in multiple places, project wins over
 * user, and `commands/` wins over `skills/` (first-seen preference).
 * Bundled stubs only surface when no on-disk override exists.
 *
 * Pinning: PINNED_COMMAND_NAMES are reassigned `namespace: 'pinned'` so the
 * frontend menu pulls them into a curated top group, in fixed order.
 */
router.post('/list', async (req, res) => {
  try {
    const { projectPath } = req.body;
    const pilotHome = resolvePilotHome(process.env);

    const customCommandSources = [];

    if (projectPath) {
      const projectCommandsDir = path.join(projectPath, '.pilotdeck', 'commands');
      const projectSkillsDir = path.join(projectPath, '.pilotdeck', 'skills');
      const [projectCommands, projectSkills] = await Promise.all([
        scanCommandsDirectory(projectCommandsDir, projectCommandsDir, 'project'),
        scanSkillsDirectory(projectSkillsDir, 'project'),
      ]);
      customCommandSources.push(...projectCommands, ...projectSkills);
    }

    const userCommandsDir = path.join(pilotHome, 'commands');
    const userSkillsDir = path.join(pilotHome, 'skills');
    const [userCommands, userSkills] = await Promise.all([
      scanCommandsDirectory(userCommandsDir, userCommandsDir, 'user'),
      scanSkillsDirectory(userSkillsDir, 'user'),
    ]);
    customCommandSources.push(...userCommands, ...userSkills);

    // Track every name we've committed so far to a single namespace. Built-in
    // names take precedence over disk customs and bundled stubs (their server-
    // side handlers in `builtInHandlers` are authoritative).
    const seenNames = new Set(builtInCommands.map((cmd) => cmd.name));

    const dedupedCustom = [];
    for (const cmd of customCommandSources) {
      if (seenNames.has(cmd.name)) continue;
      seenNames.add(cmd.name);
      dedupedCustom.push(cmd);
    }

    const builtInsWithBundled = [...builtInCommands];
    for (const stub of BUNDLED_SKILL_STUBS) {
      if (seenNames.has(stub.name)) continue;
      builtInsWithBundled.push({
        ...stub,
        namespace: 'builtin',
      });
      seenNames.add(stub.name);
    }

    dedupedCustom.sort((a, b) => a.name.localeCompare(b.name));

    const pinnedSet = new Set(PINNED_COMMAND_NAMES);
    const promote = (cmd) =>
      pinnedSet.has(cmd.name) ? { ...cmd, namespace: 'pinned' } : cmd;
    const builtIn = builtInsWithBundled.map(promote);
    const custom = dedupedCustom.map(promote);

    const indexByName = new Map();
    for (const cmd of [...builtIn, ...custom]) {
      if (!indexByName.has(cmd.name)) indexByName.set(cmd.name, cmd);
    }
    const pinnedOrdered = PINNED_COMMAND_NAMES
      .map((name) => indexByName.get(name))
      .filter(Boolean);

    res.json({
      builtIn,
      custom,
      pinned: pinnedOrdered,
      count: builtIn.length + custom.length,
    });
  } catch (error) {
    console.error('Error listing commands:', error);
    res.status(500).json({
      error: 'Failed to list commands',
      message: error.message,
    });
  }
});

/**
 * POST /api/commands/load
 * Load a specific command file and return its content and metadata
 */
router.post('/load', async (req, res) => {
  try {
    const { commandPath } = req.body;

    if (!commandPath) {
      return res.status(400).json({
        error: 'Command path is required'
      });
    }

    // Security: Prevent path traversal. Allow paths under any
    const resolvedPath = path.resolve(commandPath);
    const inHome = resolvedPath.startsWith(path.resolve(os.homedir()));
    const inPilotdeckSubdir = /\.pilotdeck\/(commands|skills)\//.test(resolvedPath);
    if (!inHome && !inPilotdeckSubdir) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Command must be in a .pilotdeck/commands or .pilotdeck/skills directory'
      });
    }

    // Read and parse the command file
    const content = await fs.readFile(commandPath, 'utf8');
    const { data: metadata, content: commandContent } = parseFrontmatter(content);

    res.json({
      path: commandPath,
      metadata,
      content: commandContent
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        error: 'Command not found',
        message: `Command file not found: ${req.body.commandPath}`
      });
    }

    console.error('Error loading command:', error);
    res.status(500).json({
      error: 'Failed to load command',
      message: error.message
    });
  }
});

/**
 * POST /api/commands/execute
 * Execute a command with argument replacement
 * This endpoint prepares the command content but doesn't execute bash commands yet
 * (that will be handled in the command parser utility)
 */
router.post('/execute', async (req, res) => {
  try {
    const { commandName, commandPath, args = [], rawArgs, rawInput, context = {} } = req.body;

    if (!commandName) {
      return res.status(400).json({
        error: 'Command name is required'
      });
    }

    // Handle built-in commands
    const handler = builtInHandlers[commandName];
    if (handler) {
      try {
        const result = await handler(args, context);
        return res.json({
          ...result,
          command: commandName
        });
      } catch (error) {
        console.error(`Error executing built-in command ${commandName}:`, error);
        return res.status(500).json({
          error: 'Command execution failed',
          message: error.message,
          command: commandName
        });
      }
    }

    // Bundled-skill stubs (e.g. /projects, /add-project) have no on-disk
    // file — the CLI's `registerBundledSkill` registry handles the
    // actual execution. Send the raw `/<name> <args>` text back as a
    // passthrough so the frontend submits it as normal user input; the proxy's
    // slash parser then routes to the bundled skill.
    const isBundledStub = BUNDLED_SKILL_STUBS.some(
      (stub) => stub.name === commandName,
    );
    const buildPassthroughContent = () => {
      if (typeof rawInput === 'string' && rawInput.trimStart().startsWith(commandName)) {
        return rawInput.trim();
      }
      const argsString = typeof rawArgs === 'string'
        ? rawArgs.trimStart()
        : args.join(' ').trim();
      return argsString ? `${commandName} ${argsString}` : commandName;
    };

    if (isBundledStub) {
      const passthroughContent = buildPassthroughContent();
      return res.json({
        type: 'custom',
        command: commandName,
        content: passthroughContent,
        metadata: { type: 'bundled-skill', passthrough: true },
        hasFileIncludes: false,
        hasBashCommands: false,
      });
    }

    // server-side and submitted as raw user input — that would dump the whole
    // SKILL.md body into chat. Instead, passthrough the slash text so the
    // proxy's slash parser invokes SkillTool with the procedural body.
    if (commandPath && /\/\.pilotdeck\/skills\/[^/]+\/SKILL\.md$/i.test(commandPath)) {
      const passthroughContent = buildPassthroughContent();
      return res.json({
        type: 'custom',
        command: commandName,
        content: passthroughContent,
        metadata: { type: 'skill', passthrough: true },
        hasFileIncludes: false,
        hasBashCommands: false,
      });
    }

    if (!commandPath) {
      return res.status(400).json({
        error: 'Command path is required for custom commands'
      });
    }

    // Load command content
    // Security: validate commandPath is within allowed directories.
    {
      const resolvedPath = path.resolve(commandPath);
      const pilotHome = resolvePilotHome(process.env);
      const allowedBases = [
        path.resolve(path.join(pilotHome, 'commands')),
        path.resolve(path.join(pilotHome, 'skills')),
      ];
      if (context?.projectPath) {
        allowedBases.push(
          path.resolve(path.join(context.projectPath, '.pilotdeck', 'commands')),
          path.resolve(path.join(context.projectPath, '.pilotdeck', 'skills')),
        );
      }
      const isUnder = (base) => {
        const rel = path.relative(base, resolvedPath);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      };
      if (!allowedBases.some(isUnder)) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Command must be in a .pilotdeck/commands or .pilotdeck/skills directory'
        });
      }
    }
    const content = await fs.readFile(commandPath, 'utf8');
    const { data: metadata, content: commandContent } = parseFrontmatter(content);
    // Basic argument replacement (will be enhanced in command parser utility)
    let processedContent = commandContent;

    // Replace $ARGUMENTS with all arguments joined
    const argsString = args.join(' ');
    processedContent = processedContent.replace(/\$ARGUMENTS/g, argsString);

    // Replace $1, $2, etc. with positional arguments
    args.forEach((arg, index) => {
      const placeholder = `$${index + 1}`;
      processedContent = processedContent.replace(new RegExp(`\\${placeholder}\\b`, 'g'), arg);
    });

    res.json({
      type: 'custom',
      command: commandName,
      content: processedContent,
      metadata,
      hasFileIncludes: processedContent.includes('@'),
      hasBashCommands: processedContent.includes('!')
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({
        error: 'Command not found',
        message: `Command file not found: ${req.body.commandPath}`
      });
    }

    console.error('Error executing command:', error);
    res.status(500).json({
      error: 'Failed to execute command',
      message: error.message
    });
  }
});

export default router;
