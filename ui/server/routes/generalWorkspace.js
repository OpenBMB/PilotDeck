import express from 'express';
import { buildRuntimeEnv, readPilotDeckConfigFile, updatePilotDeckConfig } from '../services/pilotdeckConfig.js';
import { assertGeneralWorkspaceSwitchAllowed, ensureGeneralWorkspaceDirectory, generalWorkspaceIdentity, generalWorkspaceNotice, resolveGeneralWorkspaceDirectory } from '../utils/generalWorkspace.js';

const router = express.Router();
function workspaceSettings(config) {
  const env = { ...process.env, ...buildRuntimeEnv(config) };
  let defaultDirectory = '', effectiveDirectory = '', notice = null, unavailable = false;
  try { defaultDirectory = resolveGeneralWorkspaceDirectory({ ...env, PILOTDECK_GENERAL_WORKSPACE_DIRECTORY: '' }); }
  catch { /* A damaged default record must not prevent recovery into a custom folder. */ }
  try { effectiveDirectory = resolveGeneralWorkspaceDirectory(env); notice = generalWorkspaceNotice(env); }
  catch { unavailable = true; }
  return {
    directory: config.webui?.runtime?.generalWorkspaceDirectory || '',
    effectiveDirectory, defaultDirectory, notice, unavailable,
  };
}

router.get('/', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const config = readPilotDeckConfigFile().config;
    let unavailable = false;
    try { await ensureGeneralWorkspaceDirectory({ ...process.env, ...buildRuntimeEnv(config) }); }
    catch { unavailable = true; }
    const settings = workspaceSettings(config);
    res.json({ ...settings, unavailable: unavailable || settings.unavailable });
  } catch { res.status(500).json({ code: 'GENERAL_WORKSPACE_READ_FAILED' }); }
});

router.put('/', async (req, res) => {
  const directory = req.body?.directory;
  if (typeof directory !== 'string') return res.status(400).json({ code: 'GENERAL_WORKSPACE_INVALID' });
  try {
    const saved = await updatePilotDeckConfig(async config => {
      const previousEnv = { ...process.env, ...buildRuntimeEnv(config) };
      let currentDirectory;
      try { currentDirectory = resolveGeneralWorkspaceDirectory(previousEnv); } catch { /* Permit recovery into a new empty directory. */ }
      config.webui ??= {};
      config.webui.runtime ??= {};
      config.webui.runtime.generalWorkspaceDirectory = directory.trim();
      // A new selection receives its own marker identity; never carry the old
      // directory's identity into a newly chosen folder.
      config.webui.runtime.generalWorkspaceId = '';
      const nextEnv = { ...process.env, ...buildRuntimeEnv(config) };
      if (directory.trim()) {
        const selected = resolveGeneralWorkspaceDirectory(nextEnv);
        await assertGeneralWorkspaceSwitchAllowed(currentDirectory, selected);
        try { nextEnv.PILOTDECK_GENERAL_WORKSPACE_ID = await generalWorkspaceIdentity(selected); }
        catch { /* A new empty folder receives its identity during preparation. */ }
      }
      // Validate and create the destination before committing the setting.
      const nextDirectory = await ensureGeneralWorkspaceDirectory(nextEnv, { reclaimEmptyDirectory: Boolean(directory.trim()) });
      await assertGeneralWorkspaceSwitchAllowed(currentDirectory, nextDirectory);
      config.webui.runtime.generalWorkspaceId = directory.trim() ? await generalWorkspaceIdentity(nextDirectory) : '';
    }, {
      paths: [['webui', 'runtime', 'generalWorkspaceDirectory'], ['webui', 'runtime', 'generalWorkspaceId']],
    });
    process.env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY = saved.config.webui.runtime.generalWorkspaceDirectory || '';
    process.env.PILOTDECK_GENERAL_WORKSPACE_ID = saved.config.webui.runtime.generalWorkspaceId || '';
    res.json(workspaceSettings(saved.config));
  } catch (error) {
    const code = error.code || 'GENERAL_WORKSPACE_SAVE_FAILED';
    res.status(code.startsWith('GENERAL_WORKSPACE_') || ['EACCES', 'EPERM', 'ENOTDIR', 'EEXIST'].includes(code) ? 400 : 500).json({ code });
  }
});

export default router;
