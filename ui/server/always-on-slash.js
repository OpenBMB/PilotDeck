import {
  extractProjectDirectory,
  getProjectCronJobsOverview,
} from './projects.js';
import {
  getProjectDiscoveryPlansOverview,
  rerunDiscoveryPlan,
} from './discovery-plans.js';
import { getPilotDeckGateway } from './pilotdeck-bridge.js';

const TARGET_ALIASES = new Map([
  ['cron', 'cron'],
  ['crons', 'cron'],
  ['job', 'cron'],
  ['jobs', 'cron'],
  ['cron-job', 'cron'],
  ['cron-jobs', 'cron'],
  ['plan', 'plan'],
  ['plans', 'plan'],
]);

function normalizeTargetType(value) {
  if (typeof value !== 'string') {
    return null;
  }

  return TARGET_ALIASES.get(value.trim().toLowerCase()) || null;
}

function formatDateTime(value, fallback = '-') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return date.toLocaleString();
}

function formatText(value, fallback = '-') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function summarizeText(value, maxLength = 140, fallback = '-') {
  const text = formatText(value, '');
  if (!text) {
    return fallback;
  }

  const collapsed = text.replace(/\s+/g, ' ');
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 3)}...`
    : collapsed;
}

function buildUsageMarkdown() {
  return [
    '# Always-On Slash',
    '',
    'Usage:',
    '- `/ao list [cron|plan]`',
    '- `/ao status <cron|plan> <id>`',
    '- `/ao run <cron|plan> <id>`',
    '- `/ao help`',
  ].join('\n');
}

function buildResponse(content, extraData = {}) {
  return {
    type: 'builtin',
    action: 'ao',
    data: {
      mode: 'message',
      content,
      ...extraData,
    },
  };
}

export function parseAlwaysOnSlashArgs(args = []) {
  const [actionRaw = 'help', targetRaw, idRaw, ...extra] = Array.isArray(args) ? args : [];
  const action = String(actionRaw).trim().toLowerCase();

  if (!action || action === 'help') {
    return { action: 'help' };
  }

  if (action === 'list') {
    if (!targetRaw) {
      return { action: 'list', target: 'all' };
    }

    const target = normalizeTargetType(targetRaw);
    if (!target || extra.length > 0 || idRaw) {
      return {
        action: 'help',
        error: 'Usage: `/ao list [cron|plan]`',
      };
    }

    return { action: 'list', target };
  }

  if (action === 'status' || action === 'run') {
    const target = normalizeTargetType(targetRaw);
    const id = typeof idRaw === 'string' ? idRaw.trim() : '';
    if (!target || !id || extra.length > 0) {
      return {
        action: 'help',
        error: `Usage: \`/ao ${action} <cron|plan> <id>\``,
      };
    }

    return { action, target, id };
  }

  return {
    action: 'help',
    error: `Unknown /ao action: \`${action}\``,
  };
}

function getProjectContext(context) {
  const projectName =
    typeof context?.projectName === 'string' ? context.projectName.trim() : '';
  const projectPath =
    typeof context?.projectPath === 'string' ? context.projectPath.trim() : '';

  if (!projectName) {
    return null;
  }

  return {
    projectName,
    projectPath,
  };
}

function buildCronListMarkdown(projectPath, jobs) {
  const lines = [
    `## Cron jobs (${jobs.length})`,
    '',
  ];

  if (projectPath) {
    lines.push(`Workspace: \`${projectPath}\``);
    lines.push('');
  }

  if (jobs.length === 0) {
    lines.push('No cron jobs found.');
    return lines.join('\n');
  }

  for (const job of jobs) {
    const kind = [
      job.durable === false ? 'session' : 'durable',
      job.recurring ? 'recurring' : 'one-shot',
      job.manualOnly ? 'manual-only' : null,
    ].filter(Boolean).join(', ');

    lines.push(`- \`${job.id}\` - ${summarizeText(job.prompt)}`);
    lines.push(`  - Status: \`${job.status}\``);
    lines.push(`  - Kind: ${kind}`);
    lines.push(`  - Schedule: \`${job.cron}\``);
    lines.push(`  - Last fired: ${formatDateTime(job.lastFiredAt)}`);
    if (job.latestRun?.summary) {
      lines.push(`  - Latest summary: ${summarizeText(job.latestRun.summary, 180)}`);
    }
  }

  return lines.join('\n');
}

function buildPlanListMarkdown(projectPath, plans) {
  const lines = [
    `## Discovery plans (${plans.length})`,
    '',
  ];

  if (projectPath) {
    lines.push(`Workspace: \`${projectPath}\``);
    lines.push('');
  }

  if (plans.length === 0) {
    lines.push('No discovery plans found.');
    return lines.join('\n');
  }

  for (const plan of plans) {
    lines.push(`- \`${plan.id}\` - ${formatText(plan.title)}`);
    lines.push(`  - Status: \`${plan.status}\``);
    lines.push(`  - Updated: ${formatDateTime(plan.updatedAt)}`);
    lines.push(`  - Summary: ${summarizeText(plan.summary, 180)}`);
  }

  return lines.join('\n');
}

function buildCombinedListMarkdown(projectPath, { jobs, plans }) {
  return [
    '# Always-On',
    '',
    buildPlanListMarkdown(projectPath, plans),
    '',
    buildCronListMarkdown(projectPath, jobs),
  ].join('\n');
}

function buildCronStatusMarkdown(projectPath, job) {
  const latestRun = job.latestRun || null;

  return [
    `# Cron job \`${job.id}\``,
    '',
    projectPath ? `Workspace: \`${projectPath}\`` : '',
    projectPath ? '' : '',
    `- Status: \`${job.status}\``,
    `- Schedule: \`${job.cron}\``,
    `- Scope: \`${job.durable === false ? 'session' : 'durable'}\``,
    `- Type: \`${job.recurring ? 'recurring' : 'one-shot'}\``,
    `- Manual only: \`${job.manualOnly ? 'yes' : 'no'}\``,
    `- Created: ${formatDateTime(job.createdAt)}`,
    `- Last fired: ${formatDateTime(job.lastFiredAt)}`,
    `- Origin session: ${formatText(job.originSessionId)}`,
    `- Transcript key: ${formatText(job.transcriptKey)}`,
    '',
    '## Prompt',
    '',
    formatText(job.prompt),
    '',
    '## Latest run',
    '',
    `- Last activity: ${formatDateTime(latestRun?.lastActivity)}`,
    `- Summary: ${formatText(latestRun?.summary)}`,
    `- Task ID: ${formatText(latestRun?.taskId)}`,
    `- Transcript: ${formatText(latestRun?.relativeTranscriptPath)}`,
    `- Output file: ${formatText(latestRun?.outputFile)}`,
  ].filter(Boolean).join('\n');
}

function buildPlanStatusMarkdown(projectPath, plan) {
  return [
    `# Discovery plan \`${plan.id}\``,
    '',
    projectPath ? `Workspace: \`${projectPath}\`` : '',
    projectPath ? '' : '',
    `- Title: ${formatText(plan.title)}`,
    `- Status: \`${plan.status}\``,
    `- Updated: ${formatDateTime(plan.updatedAt)}`,
    `- Execution session: ${formatText(plan.executionSessionId)}`,
    `- Execution started: ${formatDateTime(plan.executionStartedAt)}`,
    `- Last activity: ${formatDateTime(plan.executionLastActivityAt)}`,
    `- Plan file: ${formatText(plan.planFilePath)}`,
    '',
    '## Summary',
    '',
    formatText(plan.summary),
    '',
    '## Rationale',
    '',
    formatText(plan.rationale),
    '',
    '## Latest summary',
    '',
    formatText(plan.latestSummary),
  ].filter(Boolean).join('\n');
}

function buildCronRunMarkdown(jobId, result) {
  if (result?.reason === 'already_running' || result?.started === false) {
    return [
      '# Always-On',
      '',
      `Cron job \`${jobId}\` is already running.`,
      '',
      `Use \`/ao status cron ${jobId}\` to inspect the current state.`,
    ].join('\n');
  }

  return [
    '# Always-On',
    '',
    `Started cron job \`${jobId}\` immediately.`,
    '',
    `Use \`/ao status cron ${jobId}\` to inspect the latest state.`,
  ].join('\n');
}

function buildNotFoundMarkdown(target, id) {
  return [
    '# Always-On',
    '',
    `No ${target} found with id \`${id}\`.`,
  ].join('\n');
}

function buildErrorMarkdown(message) {
  return [
    '# Always-On',
    '',
    message,
  ].join('\n');
}

function sortCronJobs(jobs) {
  return [...jobs].sort((left, right) => right.createdAt - left.createdAt);
}

export async function executeAlwaysOnSlashCommand(args = [], context = {}) {
  const project = getProjectContext(context);
  if (!project) {
    return buildResponse(
      'Please select a project before using `/ao`.',
    );
  }

  const parsed = parseAlwaysOnSlashArgs(args);
  if (parsed.action === 'help') {
    const content = parsed.error
      ? `${buildErrorMarkdown(parsed.error)}\n\n${buildUsageMarkdown()}`
      : buildUsageMarkdown();
    return buildResponse(content);
  }

  try {
    if (parsed.action === 'list') {
      if (parsed.target === 'cron') {
        const overview = await getProjectCronJobsOverview(project.projectName);
        return buildResponse(
          buildCronListMarkdown(project.projectPath, sortCronJobs(overview.jobs || [])),
        );
      }

      if (parsed.target === 'plan') {
        const overview = await getProjectDiscoveryPlansOverview(project.projectName);
        return buildResponse(
          buildPlanListMarkdown(project.projectPath, overview.plans || []),
        );
      }

      const [cronOverview, planOverview] = await Promise.all([
        getProjectCronJobsOverview(project.projectName),
        getProjectDiscoveryPlansOverview(project.projectName),
      ]);

      return buildResponse(
        buildCombinedListMarkdown(project.projectPath, {
          jobs: sortCronJobs(cronOverview.jobs || []),
          plans: planOverview.plans || [],
        }),
      );
    }

    if (parsed.action === 'status' && parsed.target === 'cron') {
      const overview = await getProjectCronJobsOverview(project.projectName);
      const job = (overview.jobs || []).find((candidate) => candidate.id === parsed.id);
      if (!job) {
        return buildResponse(buildNotFoundMarkdown('cron job', parsed.id));
      }

      return buildResponse(buildCronStatusMarkdown(project.projectPath, job));
    }

    if (parsed.action === 'status' && parsed.target === 'plan') {
      const overview = await getProjectDiscoveryPlansOverview(project.projectName);
      const plan = (overview.plans || []).find((candidate) => candidate.id === parsed.id);
      if (!plan) {
        return buildResponse(buildNotFoundMarkdown('discovery plan', parsed.id));
      }

      return buildResponse(buildPlanStatusMarkdown(project.projectPath, plan));
    }

    if (parsed.action === 'run' && parsed.target === 'cron') {
      const gateway = await getPilotDeckGateway();
      const result = await gateway.cronRunNow({ taskId: parsed.id });

      if (result.reason === 'not_found') {
        return buildResponse(buildNotFoundMarkdown('cron job', parsed.id));
      }

      return buildResponse(buildCronRunMarkdown(parsed.id, result));
    }

    if (parsed.action === 'run' && parsed.target === 'plan') {
      const result = await rerunDiscoveryPlan(project.projectName, parsed.id);

      return buildResponse(
        `Plan \`${parsed.id}\` has been queued for re-execution (runId: \`${result.runId}\`).`,
      );
    }

    return buildResponse(buildUsageMarkdown());
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Always-On slash command failed.';

    if (parsed.action === 'run' && parsed.target === 'plan' && /not found/i.test(message)) {
      return buildResponse(buildNotFoundMarkdown('discovery plan', parsed.id));
    }

    return buildResponse(buildErrorMarkdown(message));
  }
}

export {
  buildUsageMarkdown as getAlwaysOnSlashUsage,
};
