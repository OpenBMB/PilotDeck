import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MemoryBundleValidationError,
} from '../../../src/context/memory/edgeclaw-memory-core/lib/index.js';
import {
  readPilotDeckConfigFile,
  writePilotDeckConfig,
} from '../services/pilotdeckConfig.js';
import { reloadPilotDeckConfig } from '../services/pilotdeckConfigReloader.js';
import { suppressNextWatchEvent } from '../services/pilotdeckConfigWatcher.js';
import {
  clearAllMemoryData,
  exportAllProjectsMemoryBundle,
  getMemoryServiceForRequest,
  getMemorySchedulerStatus,
  importAllProjectsMemoryBundle,
  rollbackLastMemoryDream,
  runManualMemoryDream,
  runManualMemoryFlush,
} from '../services/memoryService.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MEMORY_DASHBOARD_DIR = path.resolve(
  __dirname,
  '../../../src/context/memory/edgeclaw-memory-core/ui-source',
);

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, parsed));
}

function parseOffset(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function parseMemoryKind(value) {
  return value === 'user' || value === 'feedback' || value === 'project' || value === 'general_project_meta'
    ? value
    : 'all';
}

function normalizeMemoryInterval(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(10_080, Math.floor(parsed)));
}

function getGlobalMemorySettingsFromConfig(config) {
  const memory = config?.memory ?? {};
  const reasoningMode = memory.reasoningMode === 'accuracy_first' ? 'accuracy_first' : 'answer_first';
  return {
    reasoningMode,
    autoIndexIntervalMinutes: normalizeMemoryInterval(memory.autoIndexIntervalMinutes, 30),
    autoDreamIntervalMinutes: normalizeMemoryInterval(memory.autoDreamIntervalMinutes, 60),
  };
}

function getGlobalMemorySettings() {
  return getGlobalMemorySettingsFromConfig(readPilotDeckConfigFile().config);
}

async function saveGlobalMemorySettings(partial = {}) {
  const { config } = readPilotDeckConfigFile();
  const current = getGlobalMemorySettingsFromConfig(config);
  const next = {
    reasoningMode: partial.reasoningMode === 'accuracy_first'
      ? 'accuracy_first'
      : partial.reasoningMode === 'answer_first'
        ? 'answer_first'
        : current.reasoningMode,
    autoIndexIntervalMinutes: normalizeMemoryInterval(
      partial.autoIndexIntervalMinutes,
      current.autoIndexIntervalMinutes,
    ),
    autoDreamIntervalMinutes: normalizeMemoryInterval(
      partial.autoDreamIntervalMinutes,
      current.autoDreamIntervalMinutes,
    ),
  };
  const nextConfig = {
    ...config,
    memory: {
      ...(config.memory ?? {}),
      ...next,
    },
  };
  suppressNextWatchEvent();
  const saved = await writePilotDeckConfig(nextConfig);
  await reloadPilotDeckConfig(saved.config);
  return getGlobalMemorySettingsFromConfig(saved.config);
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isExternalRecordPath(relativePath) {
  return typeof relativePath === 'string' && relativePath.startsWith('external:');
}

function summarizeEntries(entries) {
  const projectEntries = entries.filter((entry) => entry.type === 'project');
  const feedbackEntries = entries.filter((entry) => entry.type === 'feedback');
  const latestMemoryAt = entries
    .map((entry) => entry.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    totalEntries: entries.length,
    projectEntries: projectEntries.length,
    feedbackEntries: feedbackEntries.length,
    ...(latestMemoryAt ? { latestMemoryAt } : {}),
  };
}

function normalizeGeneralDisplayProject(repository, project) {
  const localEntries = repository.listReadableProjectEntries(project.logicalProjectId, {
    kinds: ['project', 'feedback'],
    includeDeprecated: false,
    includeExternal: false,
  });
  const {
    sourceWorkspacePath,
    sourceProjectId,
    externalLogicalProjectId,
    localMirrorProjectId,
    ...rest
  } = project;
  return {
    ...rest,
    sourceType: 'general_local',
    readOnly: false,
    hasLocalMirror: false,
    summary: summarizeEntries(localEntries),
  };
}

function annotateWorkspaceEntries(entries) {
  return entries.map((entry) => ({
    ...entry,
    sourceType: 'general_local',
    readOnly: false,
  }));
}

function buildWorkspaceSnapshot(repository, { query = '', limit = 100, offset = 0, selectedProjectId = '' } = {}) {
  const store = repository.getFileMemoryStore();
  const workspaceMode = typeof repository.getWorkspaceMode === 'function'
    ? repository.getWorkspaceMode()
    : store.getWorkspaceMode();
  const manifestPath = path.join(store.getRootDir(), 'MEMORY.md');

  if (workspaceMode === 'general') {
    const generalProjects = repository
      .listReadableProjectCatalog()
      .filter((entry) => entry.sourceType !== 'workspace_external')
      .map((entry) => normalizeGeneralDisplayProject(repository, entry));
    const selectedProject = generalProjects.find((entry) => entry.logicalProjectId === selectedProjectId)
      || generalProjects[0]
      || null;
    const allEntries = selectedProject
      ? repository.listReadableProjectEntries(selectedProject.logicalProjectId, {
          kinds: ['project', 'feedback'],
          includeDeprecated: true,
          includeExternal: false,
          ...(query ? { query } : {}),
        })
      : [];
    const activeEntries = allEntries.filter((entry) => !entry.deprecated);
    const deprecatedEntries = allEntries.filter((entry) => entry.deprecated);
    const activePage = annotateWorkspaceEntries(
      activeEntries
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(offset, offset + limit),
    );
    const deprecatedPage = annotateWorkspaceEntries(
      deprecatedEntries
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(offset, offset + limit),
    );

    return {
      workspaceMode,
      generalProjects,
      selectedProjectId: selectedProject?.logicalProjectId ?? null,
      selectedProjectSource: selectedProject ? 'general_local' : null,
      selectedProject,
      projectMetaPath: selectedProject && !selectedProject.readOnly ? selectedProject.relativePath : null,
      projectMeta: selectedProject && !selectedProject.readOnly ? selectedProject : null,
      manifestPath: 'MEMORY.md',
      manifestContent: (() => {
        try {
          return fs.readFileSync(manifestPath, 'utf-8');
        } catch {
          return '';
        }
      })(),
      totalFiles: activeEntries.length,
      totalProjects: activeEntries.filter((record) => record.type === 'project').length,
      totalFeedback: activeEntries.filter((record) => record.type === 'feedback').length,
      projectEntries: activePage.filter((record) => record.type === 'project'),
      feedbackEntries: activePage.filter((record) => record.type === 'feedback'),
      deprecatedProjectEntries: deprecatedPage.filter((record) => record.type === 'project'),
      deprecatedFeedbackEntries: deprecatedPage.filter((record) => record.type === 'feedback'),
    };
  }

  const projectMeta = store.getProjectMeta() ?? null;
  const manifestEntries = repository.listMemoryEntries({
    scope: 'project',
    includeDeprecated: true,
    limit: 1000,
  });
  const records = repository.getMemoryRecordsByIds(
    manifestEntries.map((entry) => entry.relativePath),
    5000,
  );
  const normalizedQuery = normalizeSearchText(query);
  const filtered = !normalizedQuery
    ? records
    : records.filter((record) =>
        normalizeSearchText(
          [
            record.name,
            record.description,
            record.relativePath,
            record.preview,
            record.sourceSessionKey ?? '',
          ].join(' '),
        ).includes(normalizedQuery),
      );
  const activeFiltered = filtered.filter((record) => !record.deprecated);
  const page = filtered
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(offset, offset + limit);

  return {
    workspaceMode,
    projectMetaPath: projectMeta ? 'project.meta.md' : null,
    projectMeta,
    manifestPath: 'MEMORY.md',
    manifestContent: (() => {
      try {
        return fs.readFileSync(manifestPath, 'utf-8');
      } catch {
        return '';
      }
    })(),
    totalFiles: activeFiltered.length,
    totalProjects: activeFiltered.filter((record) => record.type === 'project').length,
    totalFeedback: activeFiltered.filter((record) => record.type === 'feedback').length,
    projectEntries: page.filter((record) => record.type === 'project' && !record.deprecated),
    feedbackEntries: page.filter((record) => record.type === 'feedback' && !record.deprecated),
    deprecatedProjectEntries: page.filter((record) => record.type === 'project' && record.deprecated),
    deprecatedFeedbackEntries: page.filter((record) => record.type === 'feedback' && record.deprecated),
  };
}

function buildDashboardSnapshot(service, repository, { query = '', selectedProjectId = '' } = {}) {
  return {
    overview: {
      ...service.overview(),
      scheduler: getMemorySchedulerStatus(),
    },
    settings: getGlobalMemorySettings(),
    workspace: buildWorkspaceSnapshot(repository, {
      query,
      limit: 200,
      offset: 0,
      selectedProjectId,
    }),
    userSummary: service.getUserSummary(),
    caseTraces: service.listCaseTraces(12),
    indexTraces: service.listIndexTraces(10),
    dreamTraces: service.listDreamTraces(10),
  };
}

function getQuery(req) {
  return typeof req.query.q === 'string' ? req.query.q.trim() : '';
}

function getSelectedProjectId(req) {
  return typeof req.query.selectedProjectId === 'string'
    ? req.query.selectedProjectId.trim()
    : '';
}

async function withMemoryService(req, res, fn) {
  try {
    const { projectPath, dataDir, service } = await getMemoryServiceForRequest(req);
    return await fn({ projectPath, dataDir, service, repository: service.repository });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: message });
  }
}

function buildDownloadFileName(prefix, exportedAt) {
  const safe = String(exportedAt || '')
    .replace(/[^\dTZ-]/g, '-')
    .replace(/-+/g, '-');
  return `${prefix}-${safe || 'export'}.json`;
}

function sendBundleDownload(res, bundle, prefix) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${buildDownloadFileName(prefix, bundle.exportedAt)}"`,
  );
  res.send(JSON.stringify(bundle, null, 2));
}

router.get('/overview', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    res.json({
      ...service.overview(),
      scheduler: getMemorySchedulerStatus(),
    });
  }),
);

router.route('/settings')
  .get(async (req, res) =>
    withMemoryService(req, res, async () => {
      res.json(getGlobalMemorySettings());
    }))
  .post(async (req, res) =>
    withMemoryService(req, res, async () => {
      res.json(await saveGlobalMemorySettings(req.body ?? {}));
    }));

router.post('/index/run', async (req, res) =>
  withMemoryService(req, res, async ({ dataDir, service, repository }) => {
    const result = await runManualMemoryFlush(service, dataDir, { reason: 'manual' });
    res.json({
      ...result,
      dashboard: buildDashboardSnapshot(service, repository, {
        query: getQuery(req),
        selectedProjectId: getSelectedProjectId(req),
      }),
    });
  }),
);

router.post('/dream/run', async (req, res) =>
  withMemoryService(req, res, async ({ dataDir, service, repository }) => {
    const result = await runManualMemoryDream(service, dataDir);
    res.json({
      ...result,
      dashboard: buildDashboardSnapshot(service, repository, {
        query: getQuery(req),
        selectedProjectId: getSelectedProjectId(req),
      }),
    });
  }),
);

router.post('/dream/rollback-last', async (req, res) =>
  withMemoryService(req, res, async ({ dataDir, service, repository }) => {
    const result = await rollbackLastMemoryDream(service, dataDir);
    res.json({
      ...result,
      dashboard: buildDashboardSnapshot(service, repository, {
        query: getQuery(req),
        selectedProjectId: getSelectedProjectId(req),
      }),
    });
  }),
);

router.get('/snapshot', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    res.json(service.snapshot(parseLimit(req.query.limit, 24)));
  }),
);

router.get('/memory/list', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    const kind = parseMemoryKind(req.query.kind);
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    const limit = parseLimit(req.query.limit, 10);
    const offset = parseOffset(req.query.offset, 0);
    const items = service.list({
      ...(kind !== 'all' ? { kinds: [kind] } : {}),
      ...(query ? { query } : {}),
      limit,
      offset,
    });
    res.json(items);
  }),
);

router.get('/memory/get', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'ids query parameter is required' });
    }
    res.json(service.get(ids, 5000));
  }),
);

router.post('/memory/actions', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    try {
      res.json(service.act(req.body ?? {}));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }),
);

router.get('/memory/user-summary', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    res.json(service.getUserSummary());
  }),
);

router.route('/project-meta')
  .get(async (req, res) =>
    withMemoryService(req, res, async ({ service, repository }) => {
      const selected = getSelectedProjectId(req);
      if (service.getWorkspaceMode() === 'general' && selected) {
        const readableProject = service.getReadableProject(selected);
        if (!readableProject || readableProject.readOnly) {
          return res.json(null);
        }
        return res.json(repository.getFileMemoryStore().getProjectMeta(readableProject.projectId) ?? readableProject);
      }
      res.json(service.getProjectMeta());
    }))
  .post(async (req, res) =>
    withMemoryService(req, res, async ({ service }) => {
      try {
        res.json(service.updateProjectMeta(req.body ?? {}));
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));

router.get('/workspace', async (req, res) =>
  withMemoryService(req, res, async ({ repository }) => {
    res.json(
      buildWorkspaceSnapshot(repository, {
        query: getQuery(req),
        limit: parseLimit(req.query.limit, 100),
        offset: parseOffset(req.query.offset, 0),
        selectedProjectId: getSelectedProjectId(req),
      }),
    );
  }),
);

router.get('/cases', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    res.json(service.listCaseTraces(parseLimit(req.query.limit, 12)));
  }),
);

router.get('/cases/:caseId', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    const record = service.getCaseTrace(req.params.caseId);
    if (!record) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(record);
  }),
);

router.get('/index-traces', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    res.json(service.listIndexTraces(parseLimit(req.query.limit, 30)));
  }),
);

router.get('/index-traces/:indexTraceId', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    const record = service.getIndexTrace(req.params.indexTraceId);
    if (!record) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(record);
  }),
);

router.get('/dream-traces', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    res.json(service.listDreamTraces(parseLimit(req.query.limit, 30)));
  }),
);

router.get('/dream-traces/:dreamTraceId', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    const record = service.getDreamTrace(req.params.dreamTraceId);
    if (!record) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(record);
  }),
);

router.get('/export/current-project', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    const bundle = service.exportBundle();
    sendBundleDownload(res, bundle, 'pilotdeck-memory-current-project');
  }),
);

router.get('/export/all-projects', async (_req, res) => {
  try {
    const bundle = await exportAllProjectsMemoryBundle();
    sendBundleDownload(res, bundle, 'pilotdeck-memory-all-projects');
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.post('/import/current-project', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    try {
      res.json(service.importBundle(req.body));
    } catch (error) {
      const status = error instanceof MemoryBundleValidationError ? 400 : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }),
);

router.post('/import/all-projects', async (req, res) => {
  try {
    res.json(await importAllProjectsMemoryBundle(req.body));
  } catch (error) {
    const status = error instanceof MemoryBundleValidationError ? 400 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/export', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    const bundle = service.exportBundle();
    sendBundleDownload(res, bundle, 'pilotdeck-memory-current-project');
  }),
);

router.post('/import', async (req, res) =>
  withMemoryService(req, res, async ({ service }) => {
    try {
      res.json(service.importBundle(req.body));
    } catch (error) {
      const status = error instanceof MemoryBundleValidationError ? 400 : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }),
);

router.post('/clear', async (req, res) => {
  const scope = req.body?.scope === 'all_memory' ? 'all_memory' : 'current_project';
  if (scope === 'all_memory') {
    try {
      res.json(await clearAllMemoryData());
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  return withMemoryService(req, res, async ({ service, repository }) => {
    const result = service.clear(scope);
    res.json({
      ...result,
      dashboard: buildDashboardSnapshot(service, repository, {
        query: getQuery(req),
        selectedProjectId: getSelectedProjectId(req),
      }),
    });
  });
});

export default router;
