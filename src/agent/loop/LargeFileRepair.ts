import type {
  CanonicalToolCall,
} from "../../model/index.js";
import type { PilotDeckToolResult } from "../../tool/index.js";

export type LargeFileRepairDecision =
  | { type: "continue"; prompt: string; purpose: string; strip?: "assistant" | "error_pair" }
  | { type: "stop"; reason: string };

export type LargeFileRepairToolContext = {
  outputTruncated: boolean;
  repairedToolCalls: boolean;
  finishReason?: string;
};

const MAX_PRE_DRAFT_REPAIR_ATTEMPTS = 5;
const MAX_POST_DRAFT_REPAIR_ATTEMPTS = 5;
const MAX_TRUNCATION_RECOVERIES = 10;
const LARGE_FILE_OUTPUT_RETRY_TOKENS = 16_384;
const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const INTERNAL_RECOVERY_HINT = "INTERNAL RECOVERY HINT - not a user request. Continue the original task.";

export class LargeFileRepair {
  private preDraftAttempts = 0;
  private postDraftAttempts = 0;
  private truncationRecoveries = 0;
  private wroteFile = false;
  private pendingLargeFileRepair = false;
  private recentFilePaths: string[] = [];

  get recommendedMaxOutputTokens(): number {
    return LARGE_FILE_OUTPUT_RETRY_TOKENS;
  }

  get hasPendingRepair(): boolean {
    return this.pendingLargeFileRepair;
  }

  onInvalidToolInput(): LargeFileRepairDecision | undefined {
    if (!this.pendingLargeFileRepair) {
      return undefined;
    }
    if (this.wroteFile) {
      return this.tryPostDraft("large_file_invalid_input_after_write");
    }
    return this.tryPreDraft("large_file_invalid_input", "error_pair");
  }

  onNoToolCalls(): LargeFileRepairDecision | undefined {
    if (!this.pendingLargeFileRepair || this.wroteFile) {
      return undefined;
    }
    return this.tryPreDraft("large_file_no_tool_call", "assistant");
  }

  analyzeToolResults(
    results: PilotDeckToolResult[],
    context: LargeFileRepairToolContext,
  ): LargeFileRepairDecision | undefined {
    this.recordWrites(results);

    if (this.wroteFile) {
      const risk = hasPostDraftRisk(results, context, this.pendingLargeFileRepair);
      if (!risk) {
        if (
          results.every((result) => result.type === "success") ||
          results.some(isSuccessfulFileWrite)
        ) {
          this.pendingLargeFileRepair = false;
        }
        return undefined;
      }
      this.pendingLargeFileRepair = true;
      return this.tryPostDraft("large_file_post_draft_repair");
    }

    if (hasPreDraftLargeFileRisk(results, context)) {
      this.pendingLargeFileRepair = true;
      return this.tryPreDraft("large_file_pre_draft_repair", "error_pair");
    }

    return undefined;
  }

  recoverFromRepairedTruncation(toolCalls: CanonicalToolCall[]): LargeFileRepairDecision | undefined {
    if (!toolCalls.some((call) => FILE_WRITE_TOOLS.has(call.name))) {
      return undefined;
    }
    if (this.truncationRecoveries >= MAX_TRUNCATION_RECOVERIES) {
      return undefined;
    }
    this.truncationRecoveries++;
    this.pendingLargeFileRepair = true;
    if (this.wroteFile) {
      return this.truncationRecovery("large_file_repaired_truncation_after_write", "post");
    }
    return this.truncationRecovery("large_file_repaired_truncation", "pre");
  }

  private truncationRecovery(
    purpose: string,
    phase: "pre" | "post",
  ): LargeFileRepairDecision {
    if (phase === "post") {
      return {
        type: "continue",
        purpose,
        strip: "assistant" as const,
        prompt: postDraftPrompt(this.recentFilePaths, this.postDraftAttempts),
      };
    }
    return {
      type: "continue",
      purpose,
      strip: "assistant" as const,
      prompt: preDraftPrompt(this.preDraftAttempts + 1),
    };
  }

  private tryPreDraft(purpose: string, strip: "assistant" | "error_pair"): LargeFileRepairDecision {
    if (this.preDraftAttempts >= MAX_PRE_DRAFT_REPAIR_ATTEMPTS) {
      return {
        type: "stop",
        reason:
          `Large file repair failed before any workspace file was created after ${this.preDraftAttempts} attempts.`,
      };
    }
    this.preDraftAttempts++;
    return {
      type: "continue",
      purpose,
      strip,
      prompt: preDraftPrompt(this.preDraftAttempts),
    };
  }

  private tryPostDraft(purpose: string): LargeFileRepairDecision {
    if (this.postDraftAttempts >= MAX_POST_DRAFT_REPAIR_ATTEMPTS) {
      return {
        type: "stop",
        reason:
          `Large file repair stopped after ${this.postDraftAttempts} post-draft attempts. A workspace file already exists; report the current file path and remaining gap.`,
      };
    }
    this.postDraftAttempts++;
    return {
      type: "continue",
      purpose,
      prompt: postDraftPrompt(this.recentFilePaths, this.postDraftAttempts),
    };
  }

  private recordWrites(results: PilotDeckToolResult[]): void {
    for (const result of results) {
      if (result.type !== "success" || !FILE_WRITE_TOOLS.has(result.toolName)) {
        continue;
      }
      this.wroteFile = true;
      const filePath = readResultFilePath(result.data);
      if (filePath) {
        this.recentFilePaths = [
          filePath,
          ...this.recentFilePaths.filter((path) => path !== filePath),
        ].slice(0, 5);
      }
    }
  }
}

function preDraftPrompt(attempt: number): string {
  const lastAttempt = attempt >= MAX_PRE_DRAFT_REPAIR_ATTEMPTS;
  const maxLines = attempt <= 2 ? 80 : attempt <= 4 ? 40 : 20;
  return [
    INTERNAL_RECOVERY_HINT,
    "",
    `The previous file write/edit attempt appears incomplete or invalid, likely because the model output was truncated. Recovery attempt ${attempt}/${MAX_PRE_DRAFT_REPAIR_ATTEMPTS}.`,
    `Use one small direct file tool call. Keep write_file content under ${maxLines} lines.`,
    "",
    "Recovery guidance:",
    "1. Continue the original task; do not treat this hint as a new user request.",
    "2. Provide the required tool parameters such as file_path and content.",
    "3. Create a minimal structurally valid skeleton first:",
    "   - HTML: doctype, head, minimal style, body with one section, closing tags.",
    "   - Code: imports, one function/class stub, exports if needed.",
    "   - Prose/report: title, first paragraph, and a clear continuation marker.",
    "4. After a file exists, extend it incrementally with focused edit_file calls.",
    "5. Do not attempt to generate the complete artifact in one oversized call.",
    "",
    "Prefer write_file for the initial skeleton. Avoid shell heredocs or echo for this recovery step.",
    lastAttempt ? "Final recovery attempt: write the smallest viable skeleton, even if it only establishes the file structure." : "",
  ].filter(Boolean).join("\n");
}

function postDraftPrompt(filePaths: string[], attempt: number): string {
  const fileText = filePaths.length > 0
    ? `Recent file path context for orientation only: ${filePaths.join(", ")}.`
    : "A workspace draft already exists.";
  const lastAttempt = attempt >= MAX_POST_DRAFT_REPAIR_ATTEMPTS;
  return [
    INTERNAL_RECOVERY_HINT,
    "",
    fileText,
    "",
    `Post-draft recovery attempt ${attempt}/${MAX_POST_DRAFT_REPAIR_ATTEMPTS}: continue the original task from the current workspace state.`,
    "",
    "Recovery guidance:",
    "1. If current content matters, inspect the file first with read_file.",
    "2. Add or replace one small section at a time with edit_file; keep new content under 60 lines.",
    "3. Do not rewrite the whole file or regenerate from scratch.",
    "4. If you just wrote a script or generator, run it and verify the produced output before asking for clarification.",
    "5. Ask the user only for a real blocker that cannot be resolved from the workspace or the original task.",
    "",
    "Use a focused edit_file replacement or insertion point such as a continuation marker when available.",
    lastAttempt ? "Final recovery attempt: make one focused edit, run/verify if applicable, or explain the concrete blocker." : "",
  ].filter(Boolean).join("\n");
}

function hasPreDraftLargeFileRisk(
  results: PilotDeckToolResult[],
  context: LargeFileRepairToolContext,
): boolean {
  return results.some((result) => {
    if (result.type !== "error") {
      return false;
    }
    if (!FILE_WRITE_TOOLS.has(result.toolName)) {
      return false;
    }
    const issues = readIssues(result);
    if (
      result.toolName === "write_file" &&
      issues.some((issue) => issue.code === "required")
    ) {
      return true;
    }
    if (context.outputTruncated && issues.some((issue) => issue.code === "required")) {
      return true;
    }
    return looksLikeLargeFileError(result.error.message);
  });
}

function hasPostDraftRisk(
  results: PilotDeckToolResult[],
  context: LargeFileRepairToolContext,
  pendingLargeFileRepair: boolean,
): boolean {
  const hasExplicitTruncationEvidence =
    context.outputTruncated ||
    context.repairedToolCalls ||
    context.finishReason === "length";

  return results.some((result) => {
    if (result.type !== "error") {
      return false;
    }
    if (!FILE_WRITE_TOOLS.has(result.toolName)) {
      return false;
    }
    if (
      result.error.code === "permission_denied" ||
      result.error.code === "permission_required" ||
      result.error.code === "permission_cancelled"
    ) {
      return false;
    }
    return (
      pendingLargeFileRepair ||
      hasExplicitTruncationEvidence ||
      result.error.code === "result_too_large" ||
      looksLikeLargeFileError(result.error.message)
    );
  });
}

function isSuccessfulFileWrite(result: PilotDeckToolResult): boolean {
  return result.type === "success" && FILE_WRITE_TOOLS.has(result.toolName);
}

function readIssues(result: PilotDeckToolResult): { path: string; code: string }[] {
  if (result.type !== "error") {
    return [];
  }
  const issues = result.error.details?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    if (!isRecord(issue)) {
      return [];
    }
    const path = typeof issue.path === "string" ? issue.path : "";
    const code = typeof issue.code === "string" ? issue.code : "";
    return [{ path, code }];
  });
}


function readResultFilePath(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const filePath = data.filePath;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function looksLikeLargeFileError(message: string): boolean {
  return /(?:output token|truncated|too large|large file|large artifact|max_output|missing required parameter `content`|required parameter `content` is missing)/iu.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
