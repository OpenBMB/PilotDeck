import {
  extractStructuredOutput,
  type CanonicalModelRequest,
  type CanonicalModelResponse,
  type ModelRuntime,
} from "../../model/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";
import { SkillManagerError } from "./SkillManager.js";
import type {
  SkillEvolutionDraft,
  SkillEvolutionGeneratorInput,
} from "./skillEvolutionTypes.js";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "rationale", "content"],
  properties: {
    summary: { type: "string" },
    rationale: { type: "string" },
    content: { type: "string" },
  },
};

const SYSTEM_PROMPT = `You maintain PilotDeck skills using evidence from real usage.

Produce a conservative revision of the supplied SKILL.md. Improve trigger clarity, procedural accuracy, failure handling, and reusable knowledge. Preserve correct material and referenced supporting files. Do not add claims that are not supported by the current skill or feedback. Do not turn one incident into an overly narrow one-task skill.

Return exactly one JSON object with summary, rationale, and content fields. The content field must contain the complete replacement SKILL.md, including valid YAML frontmatter with name and description. If the current frontmatter has a semantic version, increment its patch component once. Never return a patch, Markdown fence, or commentary inside content. summary and rationale must be concise.`;

export type GenerateSkillEvolutionOptions = {
  modelRuntime: Pick<ModelRuntime, "complete" | "getCapabilities">;
  agentModel: PilotAgentModelSelection;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export async function generateSkillEvolutionWithModel(
  options: GenerateSkillEvolutionOptions,
  input: SkillEvolutionGeneratorInput,
): Promise<SkillEvolutionDraft> {
  const capabilities = options.modelRuntime.getCapabilities(
    options.agentModel.provider,
    options.agentModel.model,
  );
  const configuredMax = options.maxOutputTokens ?? capabilities.maxOutputTokens;
  const maxOutputTokens = Math.min(configuredMax, capabilities.maxOutputTokens);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const baseRequest: CanonicalModelRequest = {
    provider: options.agentModel.provider,
    model: options.agentModel.model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: buildEvolutionPrompt(input) }],
      },
    ],
    maxOutputTokens,
    temperature: 0.2,
    metadata: {
      purpose: "skill_evolution",
      scope: input.scope,
      slug: input.slug,
    },
  };
  let response: CanonicalModelResponse;
  if (capabilities.supportsJsonSchema) {
    try {
      response = await options.modelRuntime.complete(
        {
          ...baseRequest,
          outputSchema: {
            name: "skill_evolution",
            description: "A proposed full revision of one PilotDeck skill.",
            schema: OUTPUT_SCHEMA,
            strict: true,
          },
        },
        { signal: timeoutSignal },
      );
    } catch (error) {
      if (!isStructuredOutputUnavailable(error)) throw error;
      response = await options.modelRuntime.complete(baseRequest, { signal: timeoutSignal });
    }
  } else {
    response = await options.modelRuntime.complete(baseRequest, { signal: timeoutSignal });
  }

  if (response.finishReason === "length") {
    throw new SkillManagerError(
      "evolution_output_truncated",
      "The model response was truncated before it could return a complete SKILL.md.",
    );
  }

  const extracted = extractDraft(response);
  if (!extracted.ok) {
    throw new SkillManagerError(
      "evolution_invalid_output",
      `The model returned an invalid skill evolution payload (${extracted.reason}).`,
    );
  }
  return extracted.value as SkillEvolutionDraft;
}

function extractDraft(response: CanonicalModelResponse) {
  const extracted = extractStructuredOutput(response, { validate: isDraft });
  if (extracted.ok || extracted.reason !== "invalid_json") return extracted;
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? block.text : "")
    .join("")
    .trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text);
  try {
    const value = JSON.parse((fenced?.[1] ?? text).trim()) as unknown;
    return isDraft(value)
      ? { ok: true as const, value }
      : { ok: false as const, reason: "schema_mismatch" as const };
  } catch {
    return extracted;
  }
}

function isStructuredOutputUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(response[_ -]?format|json[_ -]?schema|structured output)/iu.test(message)
    && /(unavailable|unsupported|not supported|does not support|invalid)/iu.test(message);
}

function buildEvolutionPrompt(input: SkillEvolutionGeneratorInput): string {
  const evidence = input.recentEvents.length > 0
    ? input.recentEvents.map((event) => {
        const fields = [event.at, event.type];
        if (event.outcome) fields.push(`outcome=${event.outcome}`);
        if (event.feedback) fields.push(`feedback=${JSON.stringify(event.feedback)}`);
        return `- ${fields.join(" ")}`;
      }).join("\n")
    : "- No explicit feedback has been recorded. Review conservatively.";

  return [
    `Skill: ${input.scope}/${input.slug}`,
    `Usage: reads=${input.stats.useCount}, success=${input.stats.successCount}, failure=${input.stats.failureCount}, corrections=${input.stats.correctionCount}`,
    input.instructions ? `Maintainer guidance: ${input.instructions}` : "",
    "",
    "Recent evidence:",
    evidence,
    "",
    "Current SKILL.md:",
    "<skill-content>",
    input.currentContent,
    "</skill-content>",
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}

function isDraft(value: unknown): value is SkillEvolutionDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.summary === "string"
    && draft.summary.trim().length > 0
    && typeof draft.rationale === "string"
    && draft.rationale.trim().length > 0
    && typeof draft.content === "string"
    && draft.content.trim().length > 0;
}
