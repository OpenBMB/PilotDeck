import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type { PilotDeckToolDefinition } from "../../tool/protocol/types.js";
import { parseReportMarkdown, type ReportMetadata } from "../contracts/ReportContract.js";
import type { AlwaysOnRunContextRegistry } from "../runtime/AlwaysOnRunContextRegistry.js";

export type AlwaysOnReportInput = {
  content: string;
};

export type AlwaysOnReportOutput = {
  ok: true;
  reportFilePath: string;
  fallbacks: string[];
};

export type CreateAlwaysOnReportToolOptions = {
  runContexts: AlwaysOnRunContextRegistry;
  now?: () => Date;
};

export const ALWAYS_ON_REPORT_TOOL_NAME = "always_on_report";

export function createAlwaysOnReportTool(
  options: CreateAlwaysOnReportToolOptions,
): PilotDeckToolDefinition<AlwaysOnReportInput, AlwaysOnReportOutput> {
  const now = options.now ?? (() => new Date());

  return {
    name: ALWAYS_ON_REPORT_TOOL_NAME,
    aliases: ["AlwaysOnReport"],
    description:
      "Persist the work-report markdown for the current Always-On execution turn. Missing required sections are filled by the runtime fallback; do not fight the contract.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["content"],
      additionalProperties: false,
      properties: {
        content: { type: "string", description: "Full work-report markdown body." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const reportCtx = options.runContexts.getReport(context.sessionId);
      const execCtx = options.runContexts.getExecution(context.sessionId);
      const ctx = reportCtx ?? execCtx;
      if (!ctx) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `${ALWAYS_ON_REPORT_TOOL_NAME} called outside of an Always-On report or execution turn.`,
        );
      }

      if (!("reportStore" in ctx)) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `${ALWAYS_ON_REPORT_TOOL_NAME} called in a context without a reportStore.`,
        );
      }

      ctx.reportCallCount += 1;
      const finishedAt = now();
      const metadata: ReportMetadata = {
        runId: ctx.runId,
        planId: ctx.plan.id,
        startedAt: ctx.workspace.metadata.startedAt ?? finishedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        outcome: "executed",
        workspaceStrategy: ctx.workspace.strategy,
        workspaceHandle: ctx.workspace.cwd,
      };
      const parsed = parseReportMarkdown(input.content, metadata);
      const filePath = await ctx.reportStore.writeReport(ctx.runId, parsed.rawContent);
      ctx.report = { markdown: parsed.rawContent, filePath, finishedAt };

      const data: AlwaysOnReportOutput = {
        ok: true,
        reportFilePath: filePath,
        fallbacks: parsed.fallbacks,
      };
      return {
        content: [
          { type: "text", text: `Work report saved at ${filePath}.` },
          { type: "json", value: data },
        ],
        data,
        metadata: { runId: ctx.runId, planId: ctx.plan.id },
      };
    },
  };
}
