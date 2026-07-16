import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ReadSkillInput = {
  skillName: string;
};

export type ReadSkillDeps = {
  loader: (name: string) => Promise<string | undefined>;
  lister: () => { name: string; description?: string; path: string }[];
};

export function createReadSkillTool(deps: ReadSkillDeps): PilotDeckToolDefinition<ReadSkillInput> {
  return {
    name: "read_skill",
    aliases: ["ReadSkill"],
    description:
      "Load a skill recipe by name and return its resolved SKILL.md path with the full content. " +
      "Use this when the system prompt lists an available skill relevant to the current task.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["skillName"],
      additionalProperties: false,
      properties: {
        skillName: {
          type: "string",
          description: "The skill name as listed in <available-skills>.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const content = await deps.loader(input.skillName);
      const available = deps.lister();
      if (content) {
        const skill = available.find((entry) => entry.name === input.skillName);
        if (!skill) {
          return { content: [{ type: "text", text: content }] };
        }
        const text = [
          "<skill>",
          `<name>${escapeXmlText(skill.name)}</name>`,
          `<path>${escapeXmlText(skill.path)}</path>`,
          content,
          "</skill>",
        ].join("\n");
        return { content: [{ type: "text", text }] };
      }
      if (available.length === 0) {
        return {
          content: [{ type: "text", text: `Skill '${input.skillName}' not found. No skills are currently loaded.` }],
        };
      }
      const names = available.map((s) => s.name).join(", ");
      return {
        content: [{ type: "text", text: `Skill '${input.skillName}' not found. Available skills: ${names}` }],
      };
    },
  };
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
