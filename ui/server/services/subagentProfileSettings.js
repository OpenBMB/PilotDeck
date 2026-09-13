import {
  MAX_SUBAGENT_DEPTH,
  parseSubagentProfiles,
  resolveSubagentProfiles,
} from '../../../src/agent/sub/subagentProfiles.js';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate settings with the same profile rules used by the agent runtime. */
export function validateSubagentProfileSettings(config, errors) {
  const settings = config.agent?.subagents;
  if (settings === undefined) return;
  if (!isRecord(settings)) {
    errors.push('agent.subagents must be an object');
    return;
  }
  if (settings.maxDepth !== undefined
    && (!Number.isInteger(settings.maxDepth) || settings.maxDepth < 0 || settings.maxDepth > MAX_SUBAGENT_DEPTH)) {
    errors.push(`agent.subagents.maxDepth must be an integer between 0 and ${MAX_SUBAGENT_DEPTH}`);
  }
  try {
    const profiles = resolveSubagentProfiles(parseSubagentProfiles(settings.profiles));
    const configured = new Set();
    for (const [providerId, provider] of Object.entries(config.model?.providers ?? {})) {
      for (const modelId of Object.keys(provider?.models ?? {})) configured.add(`${providerId}/${modelId}`);
    }
    for (const profile of profiles) {
      if (profile.model && !configured.has(profile.model)) {
        errors.push(`agent.subagents.profiles.${profile.id}.model="${profile.model}" doesn't resolve to a configured provider/model`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Invalid subagent profiles');
  }
}
