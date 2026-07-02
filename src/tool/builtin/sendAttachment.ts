import { stat } from "node:fs/promises";
import path from "node:path";
import type { PermissionResult, PermissionRule } from "../../permission/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { resolvePilotDeckWorkspacePath } from "./filesystem/pathSafety.js";

export type SendAttachmentInput = {
  file_path: string;
  name?: string;
  mime_type?: string;
};

export type SendAttachmentOutput = {
  filePath: string;
  name: string;
  bytes: number;
  mimeType?: string;
};

export function createSendAttachmentTool(): PilotDeckToolDefinition<SendAttachmentInput, SendAttachmentOutput> {
  return {
    name: "send_attachment",
    aliases: ["send_file"],
    title: "Send attachment",
    description:
      "Send a local file back to the user through the current host/channel when supported. "
      + "Use this when the user asks you to send, upload, return, or share an existing local file. "
      + "Do not call read_file first just to send binary files; this tool sends the file bytes as an attachment without parsing them. "
      + "Workspace files and registered IM attachment files can be sent directly; paths outside the workspace require explicit user permission before execution.",
    kind: "filesystem",
    inputSchema: {
      type: "object",
      required: ["file_path"],
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description: "Workspace-relative or absolute path to the file to send.",
        },
        name: {
          type: "string",
          description: "Optional filename to display to the recipient.",
        },
        mime_type: {
          type: "string",
          description: "Optional MIME type for the file.",
        },
      },
    },
    outputSchema: {
      type: "object",
      required: ["filePath", "name", "bytes"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string" },
        name: { type: "string" },
        bytes: { type: "integer" },
        mimeType: { type: "string" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    checkPermissions: async (input, context): Promise<PermissionResult> =>
      checkSendAttachmentPermission(input.file_path, context),
    execute: async (input, context) => {
      const resolved = resolvePilotDeckWorkspacePath(input.file_path, context, {
        mustExist: true,
        allowRegisteredReadFiles: true,
        allowOutsideWorkspace: context.currentPermissionDecision?.type === "allow",
      });
      if (!resolved.ok) {
        throw new PilotDeckToolRuntimeError(resolved.error.code, resolved.error.message, resolved.error.details);
      }
      const fileStat = await stat(resolved.absolutePath);
      if (!fileStat.isFile()) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", `Path ${input.file_path} is not a file.`);
      }
      const name = sanitizeAttachmentName(input.name) ?? path.basename(resolved.absolutePath);
      const output: SendAttachmentOutput = {
        filePath: resolved.absolutePath,
        name,
        bytes: fileStat.size,
        ...(input.mime_type ? { mimeType: input.mime_type } : {}),
      };
      return {
        content: [
          { type: "text", text: `Sending attachment: ${name}` },
          {
            type: "file",
            path: resolved.absolutePath,
            ...(input.mime_type ? { mimeType: input.mime_type } : {}),
            description: `Attachment requested for channel delivery: ${name}`,
          },
        ],
        data: output,
        metadata: { attachmentDelivery: true },
      };
    },
  };
}

function checkSendAttachmentPermission(inputPath: string, context: PilotDeckToolRuntimeContext): PermissionResult {
  const workspaceResolved = resolvePilotDeckWorkspacePath(inputPath, context, {
    mustExist: true,
    allowRegisteredReadFiles: true,
  });
  if (workspaceResolved.ok) {
    return { type: "passthrough" };
  }
  if (workspaceResolved.error.code !== "path_not_allowed") {
    return {
      type: "deny",
      reason: { type: "safety", message: workspaceResolved.error.message },
      message: workspaceResolved.error.message,
    };
  }

  const outsideResolved = resolvePilotDeckWorkspacePath(inputPath, context, {
    mustExist: true,
    allowOutsideWorkspace: true,
  });
  if (!outsideResolved.ok) {
    return {
      type: "deny",
      reason: { type: "safety", message: outsideResolved.error.message },
      message: outsideResolved.error.message,
    };
  }

  const rule = buildRecursiveSendAttachmentRule(outsideResolved.absolutePath);
  const reason = {
    type: "tool" as const,
    toolName: "send_attachment",
    message: "send_attachment targets a path outside the workspace.",
  };
  return {
    type: "ask",
    reason,
    request: {
      toolCallId: "",
      toolName: "send_attachment",
      inputSummary: JSON.stringify({ file_path: outsideResolved.absolutePath }),
      reason,
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "allow_session", label: "Allow this folder for this session", rules: [rule] },
        { id: "deny", label: "Deny" },
        { id: "cancel", label: "Cancel" },
      ],
      metadata: {
        externalPath: outsideResolved.absolutePath,
        allowedDirectory: path.dirname(outsideResolved.absolutePath),
        pattern: rule.pattern,
      },
    },
  };
}

function buildRecursiveSendAttachmentRule(absolutePath: string): PermissionRule {
  return {
    source: "session",
    behavior: "allow",
    toolName: "send_attachment",
    pattern: path.join(path.dirname(absolutePath), "*"),
  };
}

function sanitizeAttachmentName(name: string | undefined): string | undefined {
  const cleaned = name?.trim().replace(/[\\/\0]/g, "_");
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}
