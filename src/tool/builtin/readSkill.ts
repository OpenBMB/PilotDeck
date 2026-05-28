import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ReadSkillInput = {
  skillName: string;
};

export type ReadSkillDeps = {
  loader: (name: string) => Promise<string | undefined>;
  lister: () => { name: string; description?: string }[];
};

export function createReadSkillTool(deps: ReadSkillDeps): PilotDeckToolDefinition<ReadSkillInput> {
  return {
    name: "read_skill",
    aliases: ["ReadSkill"],
    description:
      "Load a skill recipe by name and return its full SKILL.md content. " +
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
      if (content) {
        return { content: [{ type: "text", text: content }] };
      }
      const available = deps.lister();
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
