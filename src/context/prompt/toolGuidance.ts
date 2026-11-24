import type { CanonicalToolSchema } from "../../model/index.js";

/** Guidance must describe the same capabilities as the request's tool inventory. */
export function toolGuidance(tools: CanonicalToolSchema[], mode: { permissionMode?: string; runMode?: string } = {}): string[] {
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
  if (mode.permissionMode !== "plan" && mode.runMode !== "plan" && mode.runMode !== "ask" && ["task_create", "task_output", "task_preview", "task_stop"].every(name => names.has(name))) {
    parts.push("", "Web application delivery:",
      "When building or changing a runnable website, complete the preview handoff unless the user requests source-only work or prohibits starting a service. Reuse an appropriate existing service or launch one with task_create lifecycle='service', then inspect task_output for its announced HTTP origin and startup errors. For a reused service, start reading at offset 0 to recover retained origins after log turnover. Verify owned services via task_preview using the service's announced port, exact page path, and a project-specific initial-HTML marker matched verbatim (for client-rendered SPAs, set a project-specific <title> in index.html rather than scaffold defaults or JS-rendered text). Use the exact URL returned by task_preview for the browser check. Inspect the rendered page and core interaction with an available browser capability. HTTP success alone does not prove the app renders, and unavailable browser checks must be stated. Finish by copying the clickable Markdown URL from task_preview and reporting the checks performed and the taskId for task_stop. Leave the preview running. Never invent an address, claim readiness after failed checks, or stop an unrelated service. Loopback belongs to the executing Gateway, so explain required port forwarding for remote/Docker deployments.");
  }
  return parts;
}
