import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ToolNameRepairResult = {
  name: string;
  reason: "configured_alias" | "builtin_alias" | "normalized_match" | "fuzzy_match";
};

export type ToolNameRepairTarget = Pick<PilotDeckToolDefinition, "name" | "aliases">;

const BUILTIN_ALIASES: Record<string, string[]> = {
  run: ["bash"],
  shell: ["bash"],
  sh: ["bash"],
  terminal: ["bash"],
  command: ["bash"],
  exec: ["bash"],
  execute: ["bash"],

  write: ["write_file", "write"],
  write_file: ["write_file", "write"],
  writefile: ["write_file", "write"],
  create_file: ["write_file", "write"],
  createfile: ["write_file", "write"],
  save_file: ["write_file", "write"],
  savefile: ["write_file", "write"],

  read: ["read_file", "read"],
  read_file: ["read_file", "read"],
  readfile: ["read_file", "read"],
  open_file: ["read_file", "read"],
  openfile: ["read_file", "read"],
  cat_file: ["read_file", "read"],
  catfile: ["read_file", "read"],

  edit: ["edit_file", "edit"],
  edit_file: ["edit_file", "edit"],
  editfile: ["edit_file", "edit"],
  modify_file: ["edit_file", "edit"],
  modifyfile: ["edit_file", "edit"],
  patch_file: ["edit_file", "edit"],
  patchfile: ["edit_file", "edit"],
  replace_file: ["edit_file", "edit"],
  replacefile: ["edit_file", "edit"],

  web_fetch: ["web_fetch", "webfetch"],
  webfetch: ["web_fetch", "webfetch"],
  fetch_url: ["web_fetch"],
  fetchurl: ["web_fetch"],
  url_fetch: ["web_fetch"],
  urlfetch: ["web_fetch"],

  web_search: ["web_search", "websearch"],
  websearch: ["web_search", "websearch"],
  search_web: ["web_search"],
  searchweb: ["web_search"],

  todo_write: ["todo_write", "todowrite"],
  todowrite: ["todo_write", "todowrite"],
  todo: ["todo_write"],
  update_todo: ["todo_write"],
  updatetodo: ["todo_write"],

  ask_user: ["ask_user_question", "ask_user"],
  ask_user_question: ["ask_user_question", "ask_user"],
  askuser: ["ask_user_question"],
  ask_question: ["ask_user_question"],
  askquestion: ["ask_user_question"],

  task: ["agent"],
  subagent: ["agent"],

  edit_notebook: ["edit_notebook", "notebook_edit"],
  notebook_edit: ["edit_notebook", "notebook_edit"],
  notebookedit: ["edit_notebook", "notebook_edit"],
  editnotebook: ["edit_notebook"],

  enter_plan_mode: ["enter_plan_mode", "enterplanmode"],
  enterplanmode: ["enter_plan_mode", "enterplanmode"],
  exit_plan_mode: ["exit_plan_mode", "exitplanmode"],
  exitplanmode: ["exit_plan_mode", "exitplanmode"],

  list_mcp_resources: ["list_mcp_resources", "listmcpresources"],
  listmcpresources: ["list_mcp_resources", "listmcpresources"],
  read_mcp_resource: ["read_mcp_resource", "readmcpresource"],
  readmcpresource: ["read_mcp_resource", "readmcpresource"],
};

export function repairToolName(
  rawName: string,
  tools: PilotDeckToolDefinition[],
  configuredAliases?: Record<string, string>,
  additionalTools: ToolNameRepairTarget[] = [],
): ToolNameRepairResult | undefined {
  const index = buildToolNameIndex([...tools, ...additionalTools]);
  const variants = normalizedVariants(rawName);
  if (variants.length === 0) {
    return undefined;
  }

  const configuredAlias = resolveConfiguredAlias(rawName, variants, configuredAliases, index);
  if (configuredAlias) {
    return { name: configuredAlias, reason: "configured_alias" };
  }

  for (const variant of variants) {
    const exact = uniqueCandidate(index.byNormalizedName.get(variant));
    if (exact) {
      return { name: exact, reason: "normalized_match" };
    }
  }

  for (const variant of variants) {
    const aliasTargets = BUILTIN_ALIASES[variant];
    if (!aliasTargets) continue;
    const resolved = resolveAliasTargets(aliasTargets, index);
    if (resolved) {
      return { name: resolved, reason: "builtin_alias" };
    }
  }

  const fuzzy = findFuzzyMatch(variants, index);
  if (fuzzy) {
    return { name: fuzzy, reason: "fuzzy_match" };
  }

  return undefined;
}

type ToolNameIndex = {
  byNormalizedName: Map<string, Set<string>>;
  spellings: { normalized: string; canonicalName: string }[];
};

function buildToolNameIndex(tools: ToolNameRepairTarget[]): ToolNameIndex {
  const byNormalizedName = new Map<string, Set<string>>();
  const spellings: { normalized: string; canonicalName: string }[] = [];

  for (const tool of tools) {
    addSpelling(tool.name, tool.name, byNormalizedName, spellings);
    for (const alias of tool.aliases ?? []) {
      addSpelling(alias, tool.name, byNormalizedName, spellings);
    }
  }

  return { byNormalizedName, spellings };
}

function addSpelling(
  spelling: string,
  canonicalName: string,
  byNormalizedName: Map<string, Set<string>>,
  spellings: { normalized: string; canonicalName: string }[],
): void {
  for (const normalized of normalizedVariants(spelling)) {
    const existing = byNormalizedName.get(normalized) ?? new Set<string>();
    existing.add(canonicalName);
    byNormalizedName.set(normalized, existing);
    spellings.push({ normalized, canonicalName });
  }
}

function resolveConfiguredAlias(
  rawName: string,
  variants: string[],
  aliases: Record<string, string> | undefined,
  index: ToolNameIndex,
): string | undefined {
  if (!aliases) {
    return undefined;
  }

  for (const [source, target] of Object.entries(aliases)) {
    const sourceVariants = new Set(normalizedVariants(source));
    const sourceMatches = rawName === source || variants.some((variant) => sourceVariants.has(variant));
    if (!sourceMatches) {
      continue;
    }
    return resolveAliasTargets([target], index);
  }

  return undefined;
}

function resolveAliasTargets(targets: string[], index: ToolNameIndex): string | undefined {
  for (const target of targets) {
    for (const variant of normalizedVariants(target)) {
      const resolved = uniqueCandidate(index.byNormalizedName.get(variant));
      if (resolved) {
        return resolved;
      }
    }
  }
  return undefined;
}

function findFuzzyMatch(variants: string[], index: ToolNameIndex): string | undefined {
  let best: { canonicalName: string; distance: number } | undefined;
  let tied = false;

  for (const variant of variants) {
    for (const candidate of index.spellings) {
      const distance = levenshtein(variant, candidate.normalized);
      if (distance > maxFuzzyDistance(variant, candidate.normalized)) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { canonicalName: candidate.canonicalName, distance };
        tied = false;
      } else if (distance === best.distance && candidate.canonicalName !== best.canonicalName) {
        tied = true;
      }
    }
  }

  return best && !tied ? best.canonicalName : undefined;
}

function maxFuzzyDistance(left: string, right: string): number {
  const minLength = Math.min(left.length, right.length);
  if (minLength <= 2) {
    return 0;
  }
  if (minLength <= 4) {
    return 1;
  }
  return 2;
}

function uniqueCandidate(candidates: Set<string> | undefined): string | undefined {
  if (!candidates || candidates.size !== 1) {
    return undefined;
  }
  return [...candidates][0];
}

function normalizedVariants(name: string): string[] {
  const values = new Set<string>();
  const trimmed = name.trim();
  if (!trimmed) {
    return [];
  }

  addNormalized(values, trimmed);

  for (const part of trimmed.split(/::|[./\\]/u)) {
    addNormalized(values, part);
  }

  for (const value of [...values]) {
    addNormalized(values, stripToolAffixes(value));
  }

  return [...values].filter(Boolean);
}

function addNormalized(values: Set<string>, value: string): void {
  const normalized = normalizeToolName(value);
  if (normalized) {
    values.add(normalized);
  }
}

function normalizeToolName(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
}

function stripToolAffixes(normalizedName: string): string {
  let current = normalizedName;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of ["tool_", "tools_", "function_", "functions_", "pilotdeck_", "builtin_"]) {
      if (current.startsWith(prefix) && current.length > prefix.length) {
        current = current.slice(prefix.length);
        changed = true;
      }
    }
    for (const suffix of ["_tool", "_tools", "_function", "_functions"]) {
      if (current.endsWith(suffix) && current.length > suffix.length) {
        current = current.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return current;
}

function levenshtein(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= right.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}
