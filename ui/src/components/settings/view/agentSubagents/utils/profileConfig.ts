import type { PilotDeckConfig } from "../../modelPool/types";
import { DEFAULT_CUSTOM_TOOLS, type SubagentProfileConfig } from "../../../../../../../src/agent/sub/subagentProfiles.js";

export type { SubagentProfileConfig };

export const MAX_DESCRIPTION_LENGTH = 2000;
export { DEFAULT_CUSTOM_TOOLS };
export const NESTED_DISPATCH_TOOL = "agent";
export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_PROFILE_IDS = new Set([
  "general_purpose",
  "explorer",
  "__proto__",
  "constructor",
  "prototype",
]);

const ERRORS = {
  idRequired: "pilotDeckConfig.panels.agentSubagents.errors.idRequired",
  idInvalid: "pilotDeckConfig.panels.agentSubagents.errors.idInvalid",
  idReserved: "pilotDeckConfig.panels.agentSubagents.errors.idReserved",
  idTaken: "pilotDeckConfig.panels.agentSubagents.errors.idTaken",
  descriptionRequired:
    "pilotDeckConfig.panels.agentSubagents.errors.descriptionRequired",
  descriptionTooLong:
    "pilotDeckConfig.panels.agentSubagents.errors.descriptionTooLong",
  modelUnconfigured:
    "pilotDeckConfig.panels.agentSubagents.errors.modelUnconfigured",
  toolWhitespace: "pilotDeckConfig.panels.agentSubagents.errors.toolWhitespace",
  toolDuplicate: "pilotDeckConfig.panels.agentSubagents.errors.toolDuplicate",
  toolWidening: "pilotDeckConfig.panels.agentSubagents.errors.toolWidening",
  depthInvalid: "pilotDeckConfig.panels.agentSubagents.errors.depthInvalid",
} as const;

export type ProfileDraftErrors = {
  id?: string;
  description?: string;
  model?: string;
  tools?: string;
  maxDepth?: string;
};

export type SubagentsSection = {
  default?: string;
  timeoutMs?: number;
  maxDepth?: number;
  profiles?: Record<string, SubagentProfileConfig>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getSubagents(
  config: PilotDeckConfig,
): SubagentsSection | undefined {
  const section = (config.agent as { subagents?: unknown } | undefined)
    ?.subagents;
  return isRecord(section) ? (section as SubagentsSection) : undefined;
}

export function getProfiles(
  config: PilotDeckConfig,
): Record<string, SubagentProfileConfig> | undefined {
  const profiles = getSubagents(config)?.profiles;
  return isRecord(profiles)
    ? (profiles as Record<string, SubagentProfileConfig>)
    : undefined;
}

export function getMaxDepth(config: PilotDeckConfig): number | undefined {
  const value = getSubagents(config)?.maxDepth;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function withSubagents(
  config: PilotDeckConfig,
  section: SubagentsSection | undefined,
): PilotDeckConfig {
  const agent = { ...(config.agent ?? {}) } as Record<string, unknown>;
  if (!section || Object.keys(section).length === 0) {
    delete agent.subagents;
  } else {
    agent.subagents = section;
  }
  const next: PilotDeckConfig = { ...config };
  if (Object.keys(agent).length > 0) {
    next.agent = agent as PilotDeckConfig["agent"];
  } else {
    delete next.agent;
  }
  return next;
}

export function withProfiles(
  config: PilotDeckConfig,
  profiles: Record<string, SubagentProfileConfig> | undefined,
): PilotDeckConfig {
  const section = { ...(getSubagents(config) ?? {}) };
  if (!profiles || Object.keys(profiles).length === 0) {
    delete section.profiles;
  } else {
    section.profiles = profiles;
  }
  return withSubagents(config, section);
}

export function withMaxDepth(
  config: PilotDeckConfig,
  maxDepth: number | undefined,
): PilotDeckConfig {
  const section = { ...(getSubagents(config) ?? {}) };
  if (maxDepth === undefined) {
    delete section.maxDepth;
  } else {
    section.maxDepth = maxDepth;
  }
  return withSubagents(config, section);
}

export function sanitizeTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((tool): tool is string => typeof tool === "string");
}

export function profileModelRef(
  profile: SubagentProfileConfig | undefined,
): string | undefined {
  const model = (profile as { model?: unknown } | undefined)?.model;
  return typeof model === "string" &&
    model !== "inherit" &&
    model.trim().length > 0
    ? model
    : undefined;
}

export function newCustomProfileId(existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  for (let n = 1; ; n += 1) {
    const candidate = `profile-${n}`;
    if (!taken.has(candidate) && !RESERVED_PROFILE_IDS.has(candidate)) {
      return candidate;
    }
  }
}

export function makeCustomProfile(
  description = "",
): SubagentProfileConfig {
  return {
    description,
    tools: [...DEFAULT_CUSTOM_TOOLS],
    readOnly: true,
    enabled: true,
  };
}

export function validateMaxDepth(
  value: unknown,
  limit: number,
): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > limit
  ) {
    return ERRORS.depthInvalid;
  }
  return null;
}

export function validateProfileId(
  id: string,
  otherIds: Iterable<string>,
): string | null {
  if (!id) return ERRORS.idRequired;
  if (RESERVED_PROFILE_IDS.has(id)) return ERRORS.idReserved;
  if (!PROFILE_ID_PATTERN.test(id)) return ERRORS.idInvalid;
  if (Array.from(otherIds).includes(id)) return ERRORS.idTaken;
  return null;
}

export function validateProfileDraft(args: {
  id: string;
  profile: SubagentProfileConfig;
  otherIds?: Iterable<string>;
  configuredModelRefs?: Iterable<string>;
  idEditable?: boolean;
  descriptionRequired?: boolean;
  permittedTools?: Iterable<string>;
}): ProfileDraftErrors {
  const errors: ProfileDraftErrors = {};
  const {
    id,
    profile,
    otherIds = [],
    configuredModelRefs = [],
    idEditable = true,
    descriptionRequired = false,
    permittedTools,
  } = args;

  if (idEditable) {
    const idError = validateProfileId(id, otherIds);
    if (idError) errors.id = idError;
  }

  const description =
    typeof profile.description === "string" ? profile.description : "";
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description = ERRORS.descriptionTooLong;
  } else if (descriptionRequired && description.trim().length === 0) {
    errors.description = ERRORS.descriptionRequired;
  }

  const model = profileModelRef(profile);
  if (model && !Array.from(configuredModelRefs).includes(model)) {
    errors.model = ERRORS.modelUnconfigured;
  }

  const tools = sanitizeTools(profile.tools);
  if (tools) {
    if (tools.some((tool) => tool.trim().length === 0)) {
      errors.tools = ERRORS.toolWhitespace;
    } else if (new Set(tools).size !== tools.length) {
      errors.tools = ERRORS.toolDuplicate;
    } else if (permittedTools) {
      const allowed = new Set([...Array.from(permittedTools), NESTED_DISPATCH_TOOL]);
      if (tools.some((tool) => !allowed.has(tool))) {
        errors.tools = ERRORS.toolWidening;
      }
    }
  }
  return errors;
}
