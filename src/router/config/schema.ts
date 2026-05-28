import type { ModelConfig } from "../../model/index.js";
import type { RouterScenarioType } from "../protocol/decision.js";

export type RouterModelRef = {
  /** Original "provider/model" string. */
  id: string;
  provider: string;
  model: string;
};

export type RouterScenariosConfig = {
  default: RouterModelRef;
};

export type RouterTierConfig = {
  model: RouterModelRef;
  description?: string;
};

export type RouterTokenSaverSubagentPolicy = "skip" | "judge";

export const DEFAULT_SUBAGENT_POLICY: RouterTokenSaverSubagentPolicy = "judge";

export type RouterTokenSaverConfig = {
  enabled: boolean;
  judge: RouterModelRef;
  defaultTier: string;
  tiers: Record<string, RouterTierConfig>;
  rules?: string[];
  subagent?: {
    policy: RouterTokenSaverSubagentPolicy;
  };
  judgeTimeoutMs: number;
};

export type RouterAutoOrchestrateConfig = {
  enabled: boolean;
  mainAgentModel?: RouterModelRef;
  /** Force subagents spawned during orchestration to use this model instead of the tier-resolved one. */
  subagentModel?: RouterModelRef;
  skillExtensionId?: string;
  /** Inline orchestration prompt injected when skillExtensionId is absent. */
  orchestrationPrompt?: string;
  triggerTiers: string[];
  /** Whitelist — only these tools are kept for the orchestrator. Takes precedence over blockedTools. */
  allowedTools?: string[];
  /** Blacklist — these tools are removed. Ignored when allowedTools is set. */
  blockedTools?: string[];
  slimSystemPrompt: boolean;
  subagentMaxTokens?: number;
};

export const DEFAULT_SUBAGENT_MAX_TOKENS = 48000;

export type RouterStatsConfig = {
  enabled: boolean;
  modelPricing?: Record<string, { input?: number; output?: number; cacheRead?: number }>;
  /** Override the default ~/.pilotdeck/router/stats.json path (useful for tests). */
  filePath?: string;
  /** Provider/model ref used as the "no-router" baseline for savedCost calculation. */
  baselineModel?: { provider: string; model: string };
};

export type RouterFallbackConfig = Partial<Record<RouterScenarioType, RouterModelRef[]>>;

export type RouterCustomRouterConfig = {
  extensionId: string;
};

export type RouterConfig = {
  /**
   * Resolved scenario→model map.
   *
   * Optional at the *parse* boundary so a yaml that lists e.g. only
   * `router.tokenSaver.*` doesn't trip a fatal. `ensureRouterConfig` in
   * `src/cli/createLocalGateway.ts` always fills `scenarios.default` from
   * `agent.model` before the runtime sees the value, so callers downstream
   * of the gateway can keep treating it as required.
   */
  scenarios?: RouterScenariosConfig;
  fallback?: RouterFallbackConfig;
  zeroUsageRetry?: { enabled: boolean; maxAttempts: number };
  transientRetry?: { enabled: boolean; maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  tokenSaver?: RouterTokenSaverConfig;
  autoOrchestrate?: RouterAutoOrchestrateConfig;
  stats?: RouterStatsConfig;
  customRouter?: RouterCustomRouterConfig;
};

export const DEFAULT_JUDGE_TIMEOUT_MS = 15_000;
export const DEFAULT_ZERO_USAGE_MAX_ATTEMPTS = 2;
export const DEFAULT_TRIGGER_TIERS = ["complex"];

/**
 * Default 4-tier classification descriptions, validated against PinchBench
 * 22-task benchmark (95%+ accuracy). COMPLEX is reserved exclusively for
 * sub-agent orchestration; single-agent deep work goes to REASONING.
 */
export const DEFAULT_TIER_DESCRIPTIONS: Record<string, string> = {
  simple: "Simple greetings, confirmations, single-step Q&A, trivial file writes, remembering rules",
  medium: "Single tool call, short text generation, 1-2 file read/write, code generation",
  complex: "Needs sub-agent orchestration: parallel workstreams, delegation to specialized agents",
  reasoning: "Deep single-agent work: multi-file operations, data analysis, multi-step workflows, web research, structured reports from many sources",
};

export const DEFAULT_TIER_RULES: string[] = [
  "complex is ONLY for tasks that need sub-agent orchestration or parallel delegation — do NOT use it for single-agent multi-step work",
  "Multi-file operations, data analysis, and multi-step workflows without orchestration should be reasoning",
  "Simple file creation (1-2 files) or single code generation is medium",
  "Trivial greetings, confirmations, remembering rules, or reading one file and answering a short question is simple",
];

export const DEFAULT_TIER_NAME = "medium";
export const DEFAULT_ALLOWED_TOOLS = [
  "agent", "read_file", "grep", "glob", "read_skill",
];
export const DEFAULT_BLOCKED_TOOLS = [
  "mcp__browser-use__",
  "web_search",
  "web_fetch",
];

export const DEFAULT_ORCHESTRATION_PROMPT = `# Orchestrator mode — plan and delegate

You are an **orchestrator**, not an executor. You plan and coordinate; edge-side
worker models execute atomic sub-tasks as sub-agents you spawn via the \`agent\` tool.

## Hard rules (tool whitelist enforced by router)

You may ONLY call:

- \`agent\`      — delegate one atomic step to a sub-agent
- \`read_file\`  — read protocol / config / spec files for planning
- \`read_skill\` — read a skill definition by name (returns the full SKILL.md content)
- \`grep\`       — search for patterns across the codebase
- \`glob\`       — find files by name pattern

Everything else (\`bash\`, \`write_file\`, \`edit_file\`, \`web_search\`, \`web_fetch\`, …) is
**blocked** for you. Sub-agents inherit your full tool permissions and will execute
on your behalf.

## File reading policy: read protocols, not payloads

- OK: Read files that describe HOW to do the task — specs, configs, READMEs, task
  prompts, schemas, prior sub-agent outputs.
- AVOID: Do NOT read large data files, raw logs, or binary artifacts. Delegate
  data-heavy inspection to a sub-agent.

## Writing a self-contained \`prompt\` string

The sub-agent has **no access** to your conversation history. It sees ONLY the \`prompt\`
string. Therefore:

- Inline all data it needs: absolute paths, file snippets, prior-step outputs, schemas.
- Spell out the exact deliverable path (use \`/tmp_workspace/\` as base).
- Spell out the output format (markdown sections, JSON schema, length cap).
- Do NOT reference "the task above", "as discussed", or "the previous output".
- If the sub-agent must produce a file, put the \`write_file\` step EARLY in the prompt
  (before optional steps like screenshots). The sub-agent may hit its turn limit before
  reaching later steps.
- Ask the sub-agent to echo back key facts in its final reply (file paths, byte counts,
  section headings) so you can verify without re-reading.

## Workflow

1. **Check for relevant skills first.** If the system prompt contains \`<available-skills>\`,
   use \`read_skill\` to read the most relevant skill. Prefer skills with "orchestrator"
   in the name — they contain ready-to-use sub-agent prompt templates. Use these
   templates **verbatim** instead of writing your own prompts from scratch.
2. **Plan in 1-4 atomic steps.** Prefer FEWER, larger steps — each \`agent\` call has
   overhead. One capable sub-agent doing five things beats five sub-agents doing one
   thing each.
3. **Spawn the first execution sub-agent in the SAME reply as your plan.** A plan-only
   reply with no tool call wastes a turn.
4. **Inspect** the sub-agent's returned report. Decide: accept / re-spawn with stricter
   instructions / move to the next step.
5. **Final reply**: short summary pointing to deliverable file paths.

## Failure handling

- Bad sub-agent output -> re-spawn the SAME step with a stricter prompt (more constraints,
  more inlined context, an explicit example of expected output).
- After 2 failed attempts on the same step, attempt the step yourself using only your
  allowed tools, or document the failure and stop.

## Working directory

Use the absolute paths specified in the skill templates (e.g. \`/tmp/xhs-workspace/\`).
If no skill template is available, use \`/tmp_workspace/\` as base. Always pass absolute paths.`;

export type ResolveProviderRefIssue = {
  code: string;
  path: string;
  message: string;
};

/**
 * Parse "provider/model" string into a structured ref and verify it exists in
 * the supplied ModelConfig. Returns either a valid ref or a list of issues
 * (caller is responsible for emitting them as PilotConfigDiagnostic).
 */
export function resolveProviderRef(
  raw: unknown,
  path: string,
  modelConfig: ModelConfig,
): { ref?: RouterModelRef; issues: ResolveProviderRefIssue[] } {
  const issues: ResolveProviderRefIssue[] = [];
  if (typeof raw !== "string" || raw.length === 0) {
    issues.push({
      code: "ROUTER_REF_INVALID",
      path,
      message: `${path} must be a non-empty provider/model string.`,
    });
    return { issues };
  }

  const separator = raw.indexOf("/");
  const provider = separator >= 0 ? raw.slice(0, separator) : "";
  const model = separator >= 0 ? raw.slice(separator + 1) : "";
  if (!provider || !model) {
    issues.push({
      code: "ROUTER_REF_FORMAT",
      path,
      message: `${path} must use provider/model format; got ${raw}.`,
    });
    return { issues };
  }

  const providerEntry = modelConfig.providers[provider];
  if (!providerEntry) {
    issues.push({
      code: "ROUTER_REF_PROVIDER_NOT_FOUND",
      path,
      message: `${path} references unknown provider ${provider}.`,
    });
    return { issues };
  }
  if (!providerEntry.models[model]) {
    issues.push({
      code: "ROUTER_REF_MODEL_NOT_FOUND",
      path,
      message: `${path} references unknown model ${model} for provider ${provider}.`,
    });
    return { issues };
  }

  return { ref: { id: raw, provider, model }, issues };
}
