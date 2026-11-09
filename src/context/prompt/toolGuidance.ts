import type { CanonicalToolSchema } from "../../model/index.js";

/** Guidance must describe the same capabilities as the request's tool inventory. */
export function toolGuidance(tools: CanonicalToolSchema[]): string[] {
  const names = new Set(tools.map(tool => tool.name));
  const localLookup = "When implementing code against an API, SDK, framework, CLI, config schema, or file format whose usage is not clear, prefer installed types, local source, examples, and project docs.";
  const webLookup = names.has("web_search")
    ? `Search for versioned official documentation with web_search before guessing unfamiliar signatures or options.${names.has("web_fetch") ? " Inspect the relevant page with web_fetch." : " Use the returned documentation and identify anything the search did not establish."}`
    : names.has("web_fetch")
      ? "If a relevant official documentation URL is known, inspect it with web_fetch."
      : "";
  const parts = ["Documentation lookup policy:",
    [localLookup, webLookup, "State remaining uncertainty and proceed conservatively when documentation is unavailable."].filter(Boolean).join(" ")];

  if (names.has("agent")) {
    parts.push("", "Parallel delegation policy:",
      "For independent workstreams, launch subagents together with distinct scopes, self-contained instructions and expected outputs. Do not delegate overlapping writes or work that depends on another result or user approval. Review and synthesize their results before proceeding.");
  }
  if (names.has("write_file") && names.has("bash")) {
    parts.push("", "Reusable script workflow:",
      "For substantial or repeatable code, use write_file to save a workspace script, then run it with bash. Prefer explicit arguments or a small configuration section over large inline programs. Inspect the output before reporting success." +
      (names.has("edit_file") ? " Use edit_file to adjust the existing script for subsequent runs." : ""));
  }
  return parts;
}
