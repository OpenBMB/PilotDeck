import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolSchema,
} from "../../model/index.js";
import {
  DEFAULT_ORCHESTRATION_PROMPT,
  type RouterAutoOrchestrateConfig,
} from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";

export type OrchestrationInput = {
  request: CanonicalModelRequest;
  config: RouterAutoOrchestrateConfig;
  isMainAgent: boolean;
  tier?: string;
  alreadyOrchestrating?: boolean;
  skillPrompt?: string;
};

export type OrchestrationResult = {
  request: CanonicalModelRequest;
  mutations: RouterMutationsLog;
  applied: boolean;
};

export function applyOrchestration(input: OrchestrationInput): OrchestrationResult {
  const { config, request } = input;
  if (!config.enabled || !input.isMainAgent) {
    return { request, mutations: {}, applied: false };
  }
  if (!input.alreadyOrchestrating) {
    const tiers = config.triggerTiers ?? [];
    if (tiers.length > 0 && (!input.tier || !tiers.includes(input.tier))) {
      return { request, mutations: {}, applied: false };
    }
  }

  const tier = input.tier ?? "main";
  let messages = request.messages;
  let tools = request.tools;
  let systemPrompt = request.systemPrompt;
  let mutations: RouterMutationsLog = {
    orchestrationActivated: { tier, continued: input.alreadyOrchestrating === true },
  };

  const prompt = input.skillPrompt ?? config.orchestrationPrompt ?? DEFAULT_ORCHESTRATION_PROMPT;
  if (prompt.length > 0) {
    messages = injectOrchestrationPrompt(messages, prompt);
    mutations = {
      ...mutations,
      orchestrationPromptInjected: { tier, chars: prompt.length },
    };
  }

  if (tools && config.allowedTools !== undefined) {
    const allowed = new Set(config.allowedTools.map(name => name.toLowerCase()));
    const filtered = tools.filter((tool: CanonicalToolSchema) => allowed.has(tool.name.toLowerCase()));
    if (filtered.length !== tools.length) {
      mutations = {
        ...mutations,
        toolsStripped: {
          before: tools.length,
          after: filtered.length,
          mode: "allowlist",
          patterns: config.allowedTools,
        },
      };
    }
    tools = filtered;
  } else if (tools && config.blockedTools && config.blockedTools.length > 0) {
    const blocked = new Set(config.blockedTools.map(name => name.toLowerCase()));
    const filtered = tools.filter((tool: CanonicalToolSchema) => !blocked.has(tool.name.toLowerCase()));
    if (filtered.length !== tools.length) {
      mutations = {
        ...mutations,
        toolsStripped: {
          before: tools.length,
          after: filtered.length,
          mode: "blocklist",
          patterns: config.blockedTools,
        },
      };
      tools = filtered;
    }
  }

  if (config.slimSystemPrompt && systemPrompt) {
    const slimmed = slimSystemPrompt(systemPrompt);
    if (slimmed.text !== systemPrompt) {
      mutations = {
        ...mutations,
        systemPromptSlim: {
          from: systemPrompt.length,
          to: slimmed.text.length,
          preservedKeywords: slimmed.preservedKeywords,
        },
      };
      systemPrompt = slimmed.text;
    }
  }

  return {
    request: { ...request, messages, tools, systemPrompt },
    mutations,
    applied: true,
  };
}

function injectOrchestrationPrompt(messages: CanonicalMessage[], prompt: string): CanonicalMessage[] {
  return [{
    role: "user",
    content: [{ type: "text", text: `<system-reminder>\n${prompt}\n</system-reminder>` }],
  }, ...messages];
}

const SLIM_HEADER = "You are an orchestration agent. Use the agent tool to delegate all work to sub-agents.";
const PRESERVED_KEYWORDS = [
  "memory_search",
  "memory_overview",
  "memory_get",
  "memory_list",
  "memory_flush",
  "memory_dream",
  "clawxmemory",
  "cache_control",
];
const PRESERVED_TAGS = [
  ["<user-context", "</user-context>"],
  ["<project-instructions", "</project-instructions>"],
  ["<memory-context", "</memory-context>"],
  ["<available-skills", "</available-skills>"],
] as const;

function slimSystemPrompt(prompt: string): { text: string; preservedKeywords: string[] } {
  const preserved: string[] = [];
  const found: string[] = [];
  let activeTag: (typeof PRESERVED_TAGS)[number] | undefined;

  for (const line of prompt.split("\n")) {
    const lower = line.toLowerCase();
    activeTag ??= PRESERVED_TAGS.find(([open]) => lower.includes(open));
    if (activeTag) {
      preserved.push(line);
      if (lower.includes(activeTag[1])) {
        found.push(activeTag[0].slice(1));
        activeTag = undefined;
      }
      continue;
    }
    const keyword = PRESERVED_KEYWORDS.find(value => lower.includes(value));
    if (keyword) {
      preserved.push(line);
      found.push(keyword);
    }
  }

  return {
    text: preserved.length > 0 ? `${SLIM_HEADER}\n\n${preserved.join("\n")}` : SLIM_HEADER,
    preservedKeywords: found,
  };
}
