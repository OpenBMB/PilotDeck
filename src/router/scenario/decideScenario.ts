import type { RouterModelRef, RouterScenariosConfig } from "../config/schema.js";
import type { RouterDecisionInput, RouterScenarioType } from "../protocol/decision.js";
import { detectSubagent } from "./subagentDetector.js";

export type ScenarioResolution = {
  scenarioType: RouterScenarioType;
  selection: RouterModelRef | undefined;
  isSubagent: boolean;
  subagentModelHint?: string;
};

export function decideScenario(
  input: RouterDecisionInput,
  scenarios: RouterScenariosConfig,
): ScenarioResolution {
  const { request, isMainAgent, metadata } = input;
  const explicit = readExplicit(input);
  if (explicit) {
    return {
      scenarioType: "explicit",
      selection: explicit,
      isSubagent: !isMainAgent,
    };
  }

  const subagent = detectSubagent(request.messages, request.tools, isMainAgent);

  if (subagent.modelHint) {
    return {
      scenarioType: "subagent",
      selection: undefined,
      isSubagent: true,
      subagentModelHint: subagent.modelHint,
    };
  }

  return {
    scenarioType: "default",
    selection: scenarios.default,
    isSubagent: subagent.isSubagent,
    subagentModelHint: subagent.modelHint,
  };
}

function readExplicit(input: RouterDecisionInput): RouterModelRef | undefined {
  const provider = input.metadata?.explicitProvider;
  const model = input.metadata?.explicitModel;
  if (provider && model) {
    return { id: `${provider}/${model}`, provider, model };
  }
  return undefined;
}
