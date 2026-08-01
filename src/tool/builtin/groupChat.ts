import { randomUUID } from "node:crypto";
import type { PermissionResult } from "../../permission/index.js";
import {
  formatGroupChatTranscript,
  type GroupChatInvocation,
  type GroupChatParticipant,
  type GroupChatParticipantKind,
  type GroupChatParticipantReply,
  type GroupChatRoom,
  type GroupChatRuntime,
  type StaffDeckEmployeeSummary,
} from "../../collaboration/index.js";
import { RemotePilotDeckClient } from "../../collaboration/participants/RemotePilotDeckClient.js";
import {
  MOCK_STAFFDECK_EMPLOYEES,
  StaffDeckClient,
  getMockStaffDeckEmployee,
} from "../../collaboration/participants/StaffDeckClient.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckJsonSchema } from "../protocol/schema.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";

export type GroupChatAction =
  | "create_room"
  | "invite_participant"
  | "send_message"
  | "inspect_room"
  | "list_rooms"
  | "close_room"
  | "list_staffdeck_employees";

export type GroupChatParticipantInput = {
  id: string;
  kind: GroupChatParticipantKind;
  name: string;
  role?: string;
  description?: string;
  endpoint?: string;
  tokenEnv?: string;
  employeeId?: string;
};

export type GroupChatInput = {
  action: GroupChatAction;
  roomId?: string;
  title?: string;
  participant?: GroupChatParticipantInput;
  participants?: GroupChatParticipantInput[];
  message?: string;
  targetParticipantIds?: string[];
};

export type GroupChatOutput = {
  action: GroupChatAction;
  room?: GroupChatRoom;
  rooms?: GroupChatRoom[];
  replies?: GroupChatParticipantReply[];
  employees?: StaffDeckEmployeeSummary[];
  employeeSource?: "staffdeck" | "mock";
};

export type CreateGroupChatToolOptions = {
  runtime: GroupChatRuntime;
  fetchImpl?: typeof fetch;
  remoteTimeoutMs?: number;
  staffDeckTimeoutMs?: number;
};

const PARTICIPANT_SCHEMA: PilotDeckJsonSchema = {
  type: "object",
  required: ["id", "kind", "name"],
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Stable room-local participant id. Use a short slug such as reviewer or remote-pilot-2.",
    },
    kind: {
      type: "string",
      enum: ["pilotdeck_local", "pilotdeck_remote", "staffdeck", "staffdeck_mock"],
      description: "Participant adapter kind.",
    },
    name: { type: "string", description: "Human-readable participant or employee name." },
    role: { type: "string", description: "Role in this group, such as researcher, engineer, or reviewer." },
    description: { type: "string", description: "Capabilities, responsibilities, and response expectations." },
    endpoint: {
      type: "string",
      description: "Base URL for pilotdeck_remote, for example http://127.0.0.1:8642. Do not include credentials.",
    },
    tokenEnv: {
      type: "string",
      description: "Optional dedicated environment variable that contains the remote PilotDeck bearer token. Its name must start with PILOTDECK_GROUP_.",
    },
    employeeId: {
      type: "string",
      description: "Required StaffDeck AgentProfile id for staffdeck or staffdeck_mock participants.",
    },
  },
};

export function createGroupChatTool(
  options: CreateGroupChatToolOptions,
): PilotDeckToolDefinition<GroupChatInput, GroupChatOutput> {
  const remoteClient = new RemotePilotDeckClient({
    fetchImpl: options.fetchImpl,
    timeoutMs: options.remoteTimeoutMs,
  });
  const staffDeckClient = new StaffDeckClient({
    fetchImpl: options.fetchImpl,
    timeoutMs: options.staffDeckTimeoutMs,
  });

  return {
    name: "group_chat",
    aliases: ["GroupChat"],
    title: "Group Chat",
    description: [
      "Create and operate a session-scoped collaboration room led by the current PilotDeck main agent.",
      "Invite local PilotDeck collaborators, remote PilotDeck instances, or real/mock StaffDeck employees, then send a message to selected participants and receive their replies in one shared transcript.",
      "Use this only when the user's request materially benefits from multiple specialties, explicit collaboration, or a StaffDeck employee. Do not create a room or call employees for simple questions or tasks the main agent can handle directly.",
      "For a quick local demo, create a room with staffdeck_mock employees such as mock-researcher, mock-engineer, or mock-reviewer, then call send_message. Use list_staffdeck_employees to discover real employees when STAFFDECK_BASE_URL and STAFFDECK_TENANT_ID are configured; otherwise it returns mock employees.",
      "Remote PilotDeck participants use the existing OpenAI-compatible /v1/chat/completions API-server channel. Credentials are referenced by a dedicated PILOTDECK_GROUP_* tokenEnv and are never stored in room state.",
      "Rooms are kept in memory for the current PilotDeck project runtime in this MVP.",
    ].join("\n"),
    kind: "agent",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "create_room",
            "invite_participant",
            "send_message",
            "inspect_room",
            "list_rooms",
            "close_room",
            "list_staffdeck_employees",
          ],
        },
        roomId: { type: "string", description: "Room id returned by create_room." },
        title: { type: "string", description: "Group title. Required for create_room." },
        participant: PARTICIPANT_SCHEMA,
        participants: {
          type: "array",
          items: PARTICIPANT_SCHEMA,
          description: "Optional participants to invite while creating the room.",
        },
        message: {
          type: "string",
          description: "Message from the PilotDeck main agent. Required for send_message.",
        },
        targetParticipantIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional participant ids to address. Omit to ask every invited participant in parallel.",
        },
      },
    },
    maxResultBytes: 300_000,
    isReadOnly: (input) => ["inspect_room", "list_rooms", "list_staffdeck_employees"].includes(input.action),
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: (input) => input.action === "send_message" || input.action === "list_staffdeck_employees",
    checkPermissions: (input, context) => checkGroupChatPermissions(
      options.runtime,
      staffDeckClient,
      input,
      context,
    ),
    execute: async (input, context) => {
      switch (input.action) {
        case "create_room": {
          const room = options.runtime.createRoom({
            ownerSessionId: context.sessionId,
            title: required(input.title, "title"),
            participants: input.participants?.map(toParticipant),
          });
          const output: GroupChatOutput = { action: input.action, room };
          return toolOutput(formatRoomSummary("Created group chat", room), output);
        }
        case "invite_participant": {
          const room = options.runtime.inviteParticipant(
            context.sessionId,
            required(input.roomId, "roomId"),
            toParticipant(requiredParticipant(input.participant)),
          );
          const output: GroupChatOutput = { action: input.action, room };
          return toolOutput(formatRoomSummary("Participant invited", room), output);
        }
        case "send_message": {
          const sent = await options.runtime.sendMessage({
            ownerSessionId: context.sessionId,
            roomId: required(input.roomId, "roomId"),
            content: required(input.message, "message"),
            targetParticipantIds: input.targetParticipantIds,
            invoke: (invocation) => invokeParticipant({
              invocation,
              context,
              remoteClient,
              staffDeckClient,
            }),
          });
          const output: GroupChatOutput = {
            action: input.action,
            room: sent.room,
            replies: sent.replies,
          };
          return toolOutput(formatRoundResult(sent.room, sent.replies), output);
        }
        case "inspect_room": {
          const room = options.runtime.getRoom(context.sessionId, required(input.roomId, "roomId"));
          const output: GroupChatOutput = { action: input.action, room };
          return toolOutput(`${formatRoomSummary("Group chat", room)}\n\n${formatGroupChatTranscript(room)}`, output);
        }
        case "list_rooms": {
          const rooms = options.runtime.listRooms(context.sessionId);
          const output: GroupChatOutput = { action: input.action, rooms };
          return toolOutput(formatRoomList(rooms), output);
        }
        case "close_room": {
          const room = options.runtime.closeRoom(context.sessionId, required(input.roomId, "roomId"));
          const output: GroupChatOutput = { action: input.action, room };
          return toolOutput(formatRoomSummary("Closed group chat", room), output);
        }
        case "list_staffdeck_employees": {
          const connection = staffDeckClient.resolveConnection(context.env ?? process.env);
          const employees = connection
            ? await staffDeckClient.listEmployees(connection, context.abortSignal)
            : MOCK_STAFFDECK_EMPLOYEES.map((employee) => ({ ...employee }));
          const employeeSource = connection ? "staffdeck" : "mock";
          const output: GroupChatOutput = { action: input.action, employees, employeeSource };
          return toolOutput(formatEmployeeList(employees, employeeSource), output);
        }
        default:
          throw new PilotDeckToolRuntimeError(
            "invalid_tool_input",
            `Unsupported group_chat action: ${String((input as GroupChatInput).action)}`,
          );
      }
    },
  };
}

async function invokeParticipant(args: {
  invocation: GroupChatInvocation;
  context: PilotDeckToolRuntimeContext;
  remoteClient: RemotePilotDeckClient;
  staffDeckClient: StaffDeckClient;
}): Promise<string> {
  const { invocation, context } = args;
  const prompt = buildParticipantPrompt(invocation);
  switch (invocation.participant.kind) {
    case "pilotdeck_local":
      return invokeLocalParticipant(invocation, prompt, context);
    case "pilotdeck_remote":
      return args.remoteClient.invoke(invocation, prompt, context.env ?? process.env, context.abortSignal);
    case "staffdeck": {
      const connection = args.staffDeckClient.resolveConnection(context.env ?? process.env);
      if (!connection) {
        throw new Error(
          "Real StaffDeck access requires STAFFDECK_BASE_URL and STAFFDECK_TENANT_ID; configure STAFFDECK_API_TOKEN when authentication is enabled.",
        );
      }
      return args.staffDeckClient.invoke(invocation, prompt, connection, context.abortSignal);
    }
    case "staffdeck_mock": {
      const employee = getMockStaffDeckEmployee(invocation.participant.employeeId ?? "");
      if (!employee) {
        throw new Error(
          `Unknown mock StaffDeck employee ${JSON.stringify(invocation.participant.employeeId)}. ` +
          `Available: ${MOCK_STAFFDECK_EMPLOYEES.map((item) => item.id).join(", ")}.`,
        );
      }
      const mockInvocation = {
        ...invocation,
        participant: {
          ...invocation.participant,
          name: invocation.participant.name || employee.name,
          description: invocation.participant.description || employee.description,
        },
      };
      return invokeLocalParticipant(mockInvocation, buildParticipantPrompt(mockInvocation), context);
    }
  }
}

async function invokeLocalParticipant(
  invocation: GroupChatInvocation,
  prompt: string,
  context: PilotDeckToolRuntimeContext,
): Promise<string> {
  const fork = context.subagent;
  if (!fork) {
    throw new Error("Local group chat participants require PilotDeck subagent support.");
  }
  if (fork.depth >= fork.maxSubagentDepth) {
    throw new Error(
      `Local group chat participant cannot be launched at subagent depth ${fork.depth}; maximum depth is ${fork.maxSubagentDepth}.`,
    );
  }
  const report = await fork.fork({
    definitionId: "general-purpose",
    directive: [
      prompt,
      "Return the standard structured subagent report. Put only the message you want to send to the group in the Result field; keep the other fields minimal.",
    ].join("\n\n"),
    subagentId: `group-${randomUUID()}`,
    toolCallId: context.currentToolCallId,
    abortSignal: context.abortSignal,
    timeoutMs: context.subagentTimeoutMs,
  });
  const result = report.parsed?.Result ?? report.parsed?.result;
  return result?.trim() || report.markdown.trim();
}

function buildParticipantPrompt(invocation: GroupChatInvocation): string {
  const participant = invocation.participant;
  return [
    `You are ${participant.name}, a participant in a PilotDeck group chat named ${JSON.stringify(invocation.room.title)}.`,
    participant.role ? `Your group role: ${participant.role}.` : undefined,
    participant.description ? `Your capabilities and responsibilities: ${participant.description}` : undefined,
    "Read the shared transcript and respond to the latest message from the PilotDeck main agent.",
    "Contribute your own specialty, mention important uncertainty, and avoid repeating other participants. Address the group directly and do not mention internal adapter or subagent mechanics.",
    "",
    invocation.transcript,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function checkGroupChatPermissions(
  runtime: GroupChatRuntime,
  staffDeckClient: StaffDeckClient,
  input: GroupChatInput,
  context: PilotDeckToolRuntimeContext,
): Promise<PermissionResult> {
  if (input.action === "list_staffdeck_employees" && staffDeckClient.resolveConnection(context.env ?? process.env)) {
    return Promise.resolve(networkPermission("List StaffDeck employees"));
  }
  if (input.action === "send_message" && input.roomId) {
    try {
      const room = runtime.getRoom(context.sessionId, input.roomId);
      const targets = input.targetParticipantIds?.length
        ? room.participants.filter((participant) => input.targetParticipantIds!.includes(participant.id))
        : room.participants;
      if (targets.some((participant) => participant.kind === "pilotdeck_remote" || participant.kind === "staffdeck")) {
        return Promise.resolve(networkPermission("Send a group message to remote PilotDeck or StaffDeck participants"));
      }
    } catch {
      // Execution returns the precise room validation error.
    }
  }
  return Promise.resolve({
    type: "allow",
    reason: {
      type: "tool",
      toolName: "group_chat",
      message: "Local group collaboration is allowed without prompting.",
    },
  });
}

function networkPermission(summary: string): PermissionResult {
  return {
    type: "ask",
    reason: {
      type: "tool",
      toolName: "group_chat",
      message: "Remote group collaboration requires network access.",
    },
    request: {
      toolCallId: "",
      toolName: "group_chat",
      inputSummary: summary,
      reason: {
        type: "tool",
        toolName: "group_chat",
        message: "Remote group collaboration requires network access.",
      },
      options: [
        { id: "allow_once", label: "Allow collaboration" },
        { id: "deny", label: "Deny" },
      ],
    },
  };
}

function toParticipant(input: GroupChatParticipantInput): GroupChatParticipant {
  return { ...input };
}

function requiredParticipant(input: GroupChatParticipantInput | undefined): GroupChatParticipantInput {
  if (!input) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", "participant is required for invite_participant.");
  }
  return input;
}

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `${field} is required for this action.`);
  }
  return trimmed;
}

function toolOutput(text: string, data: GroupChatOutput) {
  return {
    content: [{ type: "text" as const, text }],
    data,
    metadata: {
      groupChat: true,
      action: data.action,
      roomId: data.room?.id,
      replyCount: data.replies?.filter((reply) => reply.ok).length,
    },
  };
}

function formatRoomSummary(prefix: string, room: GroupChatRoom): string {
  const participants = room.participants.length > 0
    ? room.participants.map((participant) => `${participant.name} (${participant.kind}, id=${participant.id})`).join(", ")
    : "none";
  return `${prefix}: ${room.title}\nroomId=${room.id} status=${room.status}\nParticipants: ${participants}`;
}

function formatRoomList(rooms: GroupChatRoom[]): string {
  if (rooms.length === 0) return "No group chat rooms exist in this session.";
  return [
    `Group chat rooms: ${rooms.length}`,
    ...rooms.map((room) => `- ${room.title} roomId=${room.id} status=${room.status} participants=${room.participants.length} messages=${room.messages.length}`),
  ].join("\n");
}

function formatRoundResult(room: GroupChatRoom, replies: GroupChatParticipantReply[]): string {
  const lines = [
    `Group chat round completed: ${room.title}`,
    `roomId=${room.id} replies=${replies.filter((reply) => reply.ok).length}/${replies.length}`,
  ];
  for (const reply of replies) {
    lines.push("");
    lines.push(`### ${reply.participantName} (${reply.participantKind}, id=${reply.participantId})`);
    lines.push(reply.ok ? reply.message?.content ?? "(empty response)" : `Error: ${reply.error ?? "unknown error"}`);
  }
  lines.push("");
  lines.push("The PilotDeck main agent should now synthesize these contributions for the user.");
  return lines.join("\n");
}

function formatEmployeeList(
  employees: StaffDeckEmployeeSummary[],
  source: "staffdeck" | "mock",
): string {
  const header = source === "staffdeck"
    ? `StaffDeck employees: ${employees.length}`
    : `Mock StaffDeck employees: ${employees.length} (real StaffDeck is not configured)`;
  return [
    header,
    ...employees.map((employee) => `- ${employee.name} employeeId=${employee.id}${employee.description ? ` — ${employee.description}` : ""}`),
  ].join("\n");
}
