/** Environment-independent contract identifiers shared by module consumers. */
export const MODULE_SLOT_CONTRACTS = {
  agentLoop: "pilotdeck.agent-loop/v1",
  skills: "pilotdeck.skills/v1",
  tools: "pilotdeck.tools/v1",
  context: "pilotdeck.context/v1",
  modelProvider: "pilotdeck.model/v1",
  knowledge: "staffdeck.knowledge/v1",
} as const;
