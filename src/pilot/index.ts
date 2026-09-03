export {
  DEFAULT_PILOT_HOME,
  PILOT_CONFIG_FILE_NAME,
  PILOT_PROJECT_DIR_NAME,
  createProjectId,
  createProjectIdAsync,
  createCollisionResistantProjectId,
  resolveProjectStorageId,
  getPilotConfigFilePath,
  getPilotExtensionPaths,
  getPilotProjectConfigFilePath,
  getPilotProjectChatDir,
  getPilotProjectChatDirAsync,
  resolvePilotHome,
  type PilotExtensionPaths,
  type PilotPathEnv,
} from "./paths.js";
export {
  ensureWritableDirectory,
  isDesktopRuntimeProjectRoot,
  isVirtualProjectRoot,
  resolvePilotHomeProjectArtifactDir,
  resolveRuntimeArtifactFallbackDir,
  type EnsureWritableDirectoryInput,
  type EnsureWritableDirectoryResult,
} from "./writablePaths.js";
export * from "./config/index.js";
