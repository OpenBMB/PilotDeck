import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolSchema,
} from "../../model/index.js";
import { DEFAULT_ORCHESTRATION_PROMPT, type RouterAutoOrchestrateConfig } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";

export type OrchestrationInput = {
  request: CanonicalModelRequest;
  config: RouterAutoOrchestrateConfig;
  isMainAgent: boolean;
  tier?: string;
  /** When true the session was already orchestrating on a prior turn. */
  alreadyOrchestrating?: boolean;
  /**
   * Optional skill prompt loaded by the caller (typically through extension).
   * The router does not load files directly — it just receives prepared text.
   */
  skillPrompt?: string;
};

export type OrchestrationResult = {
  request: CanonicalModelRequest;
  mutations: RouterMutationsLog;
  /** True when orchestration actually mutated the request. */
  applied: boolean;
};

export function applyOrchestration(input: OrchestrationInput): OrchestrationResult {
  const { config, request, skillPrompt } = input;
  console.log(
    `[autoOrch] input: tier=${input.tier}, isMain=${input.isMainAgent}, alreadyOrch=${input.alreadyOrchestrating}, triggerTiers=${config.triggerTiers}`,
  );
  if (!config.enabled || !input.isMainAgent) {
    return { request, mutations: {}, applied: false };
  }

  if (!input.alreadyOrchestrating) {
    const triggerTiers = config.triggerTiers ?? [];
    if (triggerTiers.length > 0 && (!input.tier || !triggerTiers.includes(input.tier))) {
      console.log(`[autoOrch] tier "${input.tier}" not in triggerTiers, skipping`);
      return { request, mutations: {}, applied: false };
    }
  }

  let messages = request.messages;
  let mutations: RouterMutationsLog = {};
  let mutated = false;

  const effectivePrompt = skillPrompt ?? config.orchestrationPrompt ?? DEFAULT_ORCHESTRATION_PROMPT;
  if (effectivePrompt && effectivePrompt.length > 0) {
    messages = injectOrchestrationPrompt(messages, effectivePrompt);
    mutations = {
      ...mutations,
      orchestrationPromptInjected: { tier: input.tier ?? "main", chars: effectivePrompt.length },
    };
    mutated = true;
  }

  let tools = request.tools;
  if (tools && config.allowedTools && config.allowedTools.length > 0) {
    const before = tools.length;
    const allowed = new Set(config.allowedTools.map(n => n.toLowerCase()));
    const filtered = tools.filter((tool: CanonicalToolSchema) => allowed.has(tool.name.toLowerCase()));
    if (filtered.length !== before) {
      tools = filtered;
      mutations = {
        ...mutations,
        toolsStripped: { before, after: filtered.length, mode: "allowlist", patterns: config.allowedTools },
      };
      mutated = true;
    }
    if (filtered.length === 0 && before > 0) {
      console.warn(`[autoOrch] WARNING: allowedTools filter matched 0 of ${before} tools — falling back to unfiltered to preserve API tools param`);
      tools = request.tools;
    }
  } else if (tools && config.blockedTools && config.blockedTools.length > 0) {
    const before = tools.length;
    const blocked = new Set(config.blockedTools.map(n => n.toLowerCase()));
    const filtered = tools.filter((tool: CanonicalToolSchema) => !blocked.has(tool.name.toLowerCase()));
    if (filtered.length !== before) {
      tools = filtered;
      mutations = {
        ...mutations,
        toolsStripped: { before, after: filtered.length, mode: "blocklist", patterns: config.blockedTools },
      };
      mutated = true;
    }
  }

  let systemPrompt = request.systemPrompt;
  if (config.slimSystemPrompt && systemPrompt && systemPrompt.length > 0) {
    const trimmed = trimSystemPrompt(systemPrompt);
    if (trimmed.text !== systemPrompt) {
      mutations = {
        ...mutations,
        systemPromptSlim: {
          from: systemPrompt.length,
          to: trimmed.text.length,
          preservedKeywords: trimmed.preservedKeywords,
        },
      };
      systemPrompt = trimmed.text;
      mutated = true;
    }
  }

  if (!mutated) {
    console.log("[autoOrch] no mutations applied, orchestration skipped");
    return { request, mutations: {}, applied: false };
  }

  console.log(`[autoOrch] orchestration applied: promptInjected=${"orchestrationPromptInjected" in mutations}, toolsStripped=${"toolsStripped" in mutations}, sysPromptSlim=${"systemPromptSlim" in mutations}`);
  return {
    request: {
      ...request,
      messages,
      tools,
      systemPrompt,
    },
    mutations,
    applied: true,
  };
}

function injectOrchestrationPrompt(
  messages: CanonicalMessage[],
  prompt: string,
): CanonicalMessage[] {
  const reminder: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: `<system-reminder>\n${prompt}\n</system-reminder>` }],
  };
  return [reminder, ...messages];
}

const SLIM_HEADER = "You are an orchestration agent. Use the agent tool to delegate all work to sub-agents.";
const MEMORY_KEYWORDS = [
  "memory_search", "memory_overview", "memory_get",
  "memory_list", "memory_flush", "memory_dream",
  "ClawXMemory", "cache_control",
];

const PRESERVED_TAGS: { open: string; close: string }[] = [
  { open: "<user-context", close: "</user-context>" },
  { open: "<project-instructions", close: "</project-instructions>" },
  { open: "<memory-context", close: "</memory-context>" },
  { open: "<available-skills", close: "</available-skills>" },
];

function trimSystemPrompt(prompt: string): { text: string; preservedKeywords: string[] } {
  const lines = prompt.split("\n");
  const preservedKeywords: string[] = [];
  const preserved: string[] = [];
  let activeTag: (typeof PRESERVED_TAGS)[number] | null = null;
  let inMemoryBlock = false;

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (!activeTag) {
      const match = PRESERVED_TAGS.find(tag => lower.includes(tag.open));
      if (match) {
        activeTag = match;
        preserved.push(line);
        if (lower.includes(match.close)) {
          preservedKeywords.push(match.open.slice(1));
          activeTag = null;
        }
        continue;
      }
    }

    if (activeTag) {
      preserved.push(line);
      if (lower.includes(activeTag.close)) {
        preservedKeywords.push(activeTag.open.slice(1));
        activeTag = null;
      }
      continue;
    }

    const isMemory = MEMORY_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    if (isMemory) {
      inMemoryBlock = true;
      preserved.push(line);
      preservedKeywords.push(line.trim().slice(0, 40));
    } else if (inMemoryBlock && line.trim().length > 0) {
      preserved.push(line);
    } else {
      inMemoryBlock = false;
    }
  }

  const text = preserved.length > 0
    ? SLIM_HEADER + "\n\n" + preserved.join("\n")
    : SLIM_HEADER;
  return { text, preservedKeywords };
}
