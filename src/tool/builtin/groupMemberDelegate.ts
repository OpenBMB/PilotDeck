import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

export const GROUP_MEMBER_DELEGATE_TOOL_NAME = "group_member_delegate";

export type GroupMemberDelegateInput = {
  memberId: string;
  message: string;
};

export type GroupMemberDelegateOutput = {
  memberId: string;
  memberName: string;
  reply: string;
  messageId: string;
};

export type CreateGroupMemberDelegateToolOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function createGroupMemberDelegateTool(
  options: CreateGroupMemberDelegateToolOptions = {},
): PilotDeckToolDefinition<GroupMemberDelegateInput, GroupMemberDelegateOutput> {
  return {
    name: GROUP_MEMBER_DELEGATE_TOOL_NAME,
    title: "Delegate to Group Member",
    description: [
      "Ask one concrete member of the current persistent PilotDeck group to answer, then return that member's real reply to the main agent.",
      "Use this when the user asks the main agent to consult, ask, introduce, or obtain information from a named group member, or when that member's specialty is materially needed.",
      "Use the exact member id from the group roster in the system context. Never answer on a member's behalf when this tool can obtain their response.",
      "Do not call the main member itself. You may call multiple members one at a time when the request needs them.",
    ].join("\n"),
    kind: "agent",
    inputSchema: {
      type: "object",
      required: ["memberId", "message"],
      additionalProperties: false,
      properties: {
        memberId: {
          type: "string",
          description: "Exact non-main member id from the current group roster.",
        },
        message: {
          type: "string",
          description: "The focused question or task to send to that member.",
        },
      },
    },
    maxResultBytes: 300_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    execute: async (input, context) => {
      const match = /^group:(.+):main$/u.exec(context.sessionId);
      if (!match) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "This tool is only available to the main agent of a persistent group.",
        );
      }
      const roomId = match[1];
      const memberId = input.memberId?.trim();
      const message = input.message?.trim();
      if (!memberId || !message) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "memberId and message are required.",
        );
      }
      if (memberId === "main") {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "Delegate to a non-main group member.",
        );
      }

      const env = context.env ?? process.env;
      const baseUrl = (options.baseUrl
        ?? env.PILOTDECK_GROUP_API_URL
        ?? `http://127.0.0.1:${env.SERVER_PORT || "3001"}`).replace(/\/$/u, "");
      const tokenPath = env.PILOTDECK_GATEWAY_TOKEN_PATH
        ?? join(env.PILOT_HOME || join(homedir(), ".pilotdeck"), "server-token");
      let token: string;
      try {
        token = (await readFile(tokenPath, "utf8")).trim();
      } catch (error) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          "Unable to read the local group delegation token.",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }

      const fetchImpl = options.fetchImpl ?? fetch;
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/api/groups/${encodeURIComponent(roomId)}/delegate`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-PilotDeck-Group-Token": token,
              ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
            },
            body: JSON.stringify({
              sourceSessionId: context.sessionId,
              sourceTurnId: context.turnId,
              memberId,
              message,
            }),
            signal: context.abortSignal,
          },
        );
      } catch (error) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `Could not reach the local group service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        member?: { id?: string; name?: string };
        message?: { id?: string; content?: string };
      };
      if (!response.ok) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          payload.error || `Group member delegation failed with HTTP ${response.status}.`,
        );
      }
      const reply = payload.message?.content?.trim();
      const memberName = payload.member?.name?.trim();
      const messageId = payload.message?.id?.trim();
      if (!reply || !memberName || !messageId) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          "The delegated member returned an invalid response.",
        );
      }
      const output: GroupMemberDelegateOutput = {
        memberId: payload.member?.id?.trim() || memberId,
        memberName,
        reply,
        messageId,
      };
      return {
        content: [{ type: "text", text: `${memberName} replied:\n\n${reply}` }],
        data: output,
      };
    },
  };
}
