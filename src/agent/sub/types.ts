/**
 * Subagent report summary (the 5 mandatory fields produced at the end of a
 * forked subagent run). See {@link buildChildMessage} for the rendering
 * contract; both the legacy and PilotDeck subagent prompts emit these
 * verbatim.
 */
export type CanonicalAssistantTextSummary = {
  Scope: string;
  Result: string;
  "Key files": string;
  "Files changed": string;
  Issues: string;
};
