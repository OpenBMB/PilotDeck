import type { PilotDeckToolValidationIssue } from "../protocol/schema.js";

export type FormatValidationErrorOptions = {
  maxOutputTokens?: number;
  outputTruncated?: boolean;
};

/**
 * Format validation issues into a human-readable (and LLM-friendly) error
 * message. Formats missing, mistyped, and unexpected parameters so the
 * model sees exactly which parameters are missing, have the wrong type, or
 * are unexpected — enabling effective self-correction on the next turn.
 */
export function formatValidationError(
  toolName: string,
  issues: PilotDeckToolValidationIssue[],
  options?: FormatValidationErrorOptions,
): string {
  const errorParts: string[] = [];

  for (const issue of issues) {
    const param = issue.path.replace(/^\$\.?/, "");
    switch (issue.code) {
      case "required":
        errorParts.push(`The required parameter \`${param}\` is missing`);
        break;
      case "invalid_type":
        errorParts.push(`The parameter \`${param}\` has an invalid type: ${issue.message}`);
        break;
      case "unknown_property":
        errorParts.push(`An unexpected parameter \`${param}\` was provided`);
        break;
      case "invalid_enum":
        errorParts.push(`The parameter \`${param}\` has an invalid value: ${issue.message}`);
        break;
      default:
        errorParts.push(issue.message);
        break;
    }
  }

  if (errorParts.length === 0) {
    return `Tool ${toolName} input is invalid.`;
  }

  const label = errorParts.length > 1 ? "issues" : "issue";
  let message = `${toolName} failed due to the following ${label}:\n${errorParts.join("\n")}`;

  const FILE_TOOLS = new Set(["write_file", "edit_file", "edit_notebook", "bash"]);
  const hasRequiredMissing = issues.some((i) => i.code === "required");
  const tokenBudget = options?.maxOutputTokens;
  const tokenInfo = tokenBudget ? ` (current max_output_tokens: ${tokenBudget})` : "";

  if (hasRequiredMissing && FILE_TOOLS.has(toolName)) {
    if (options?.outputTruncated) {
      message += `\n\nThis was caused by your output being truncated (output token limit reached${tokenInfo}). `
        + "Keep each tool call's arguments well within the output token budget.";
    } else {
      message += "\n\nPlease ensure all required parameters are provided in the tool call.";
    }
  }

  if (
    toolName === "write_file" &&
    issues.some((i) => i.code === "required" && i.path.includes("content"))
    && options?.outputTruncated
  ) {
    message +=
      "\n\nHint: Please use an incremental, multi-step approach to write large files:\n"
      + "Step 1: Create the file with the first section using write_file (keep content short, ~50-100 lines max per call).\n"
      + "Step 2: Append subsequent sections using bash({command: \"cat <<'SECTION' >> /path/to/file\\n...next section...\\nSECTION\"}).\n"
      + "Step 3: Repeat Step 2 until the full file is written.\n"
      + "Important: Break the file into logical sections (imports, classes, functions, etc.) and write one section per step.";
  }

  return message;
}
