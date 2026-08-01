import { randomUUID } from "node:crypto";
import { PilotDeckToolRuntimeError } from "../../tool/protocol/errors.js";
import type {
  GroupChatMessage,
  GroupChatParticipant,
  GroupChatParticipantInvoker,
  GroupChatParticipantReply,
  GroupChatRoom,
} from "../protocol/types.js";

const MAX_PARTICIPANTS = 8;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 20_000;
const REMOTE_TOKEN_ENV_PATTERN = /^PILOTDECK_GROUP_[A-Z0-9_]+$/u;

export type GroupChatRuntimeOptions = {
  now?: () => Date;
  uuid?: () => string;
};

export class GroupChatRuntime {
  private readonly rooms = new Map<string, GroupChatRoom>();
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(options: GroupChatRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  createRoom(input: {
    ownerSessionId: string;
    title: string;
    participants?: GroupChatParticipant[];
  }): GroupChatRoom {
    const title = requiredText(input.title, "title");
    const participants = (input.participants ?? []).map(normalizeParticipant);
    ensureParticipantSet(participants);
    const createdAt = this.now().toISOString();
    const room: GroupChatRoom = {
      id: `room-${this.uuid()}`,
      ownerSessionId: input.ownerSessionId,
      title,
      status: "active",
      participants,
      messages: [],
      createdAt,
      updatedAt: createdAt,
    };
    this.rooms.set(room.id, room);
    return cloneRoom(room);
  }

  listRooms(ownerSessionId: string): GroupChatRoom[] {
    return [...this.rooms.values()]
      .filter((room) => room.ownerSessionId === ownerSessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneRoom);
  }

  getRoom(ownerSessionId: string, roomId: string): GroupChatRoom {
    return cloneRoom(this.getOwnedRoom(ownerSessionId, roomId));
  }

  inviteParticipant(
    ownerSessionId: string,
    roomId: string,
    participant: GroupChatParticipant,
  ): GroupChatRoom {
    const room = this.getActiveRoom(ownerSessionId, roomId);
    const normalized = normalizeParticipant(participant);
    ensureParticipantSet([...room.participants, normalized]);
    room.participants.push(normalized);
    this.touch(room);
    return cloneRoom(room);
  }

  closeRoom(ownerSessionId: string, roomId: string): GroupChatRoom {
    const room = this.getOwnedRoom(ownerSessionId, roomId);
    room.status = "closed";
    this.touch(room);
    return cloneRoom(room);
  }

  async sendMessage(input: {
    ownerSessionId: string;
    roomId: string;
    content: string;
    targetParticipantIds?: string[];
    invoke: GroupChatParticipantInvoker;
  }): Promise<{ room: GroupChatRoom; replies: GroupChatParticipantReply[] }> {
    const room = this.getActiveRoom(input.ownerSessionId, input.roomId);
    const content = requiredText(input.content, "message");
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new PilotDeckToolRuntimeError(
        "invalid_tool_input",
        `Group chat message exceeds ${MAX_MESSAGE_CHARS} characters.`,
      );
    }

    const targets = resolveTargets(room, input.targetParticipantIds);
    if (targets.length === 0) {
      throw new PilotDeckToolRuntimeError(
        "invalid_tool_input",
        "The group chat has no target participants. Invite a participant first or provide valid targetParticipantIds.",
      );
    }

    const sourceMessage = this.appendMessage(room, {
      senderId: "main",
      senderName: "PilotDeck main agent",
      senderKind: "pilotdeck_main",
      content,
    });
    const transcript = formatGroupChatTranscript(room);
    const settled = await Promise.allSettled(
      targets.map((participant) => input.invoke({
        room: cloneRoom(room),
        participant: { ...participant },
        sourceMessage: { ...sourceMessage },
        transcript,
      })),
    );

    const replies: GroupChatParticipantReply[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const participant = targets[index]!;
      const result = settled[index]!;
      if (result.status === "rejected") {
        replies.push({
          participantId: participant.id,
          participantName: participant.name,
          participantKind: participant.kind,
          ok: false,
          error: errorMessage(result.reason),
        });
        continue;
      }
      const responseText = result.value.trim();
      if (!responseText) {
        replies.push({
          participantId: participant.id,
          participantName: participant.name,
          participantKind: participant.kind,
          ok: false,
          error: "Participant returned an empty response.",
        });
        continue;
      }
      const message = this.appendMessage(room, {
        senderId: participant.id,
        senderName: participant.name,
        senderKind: participant.kind,
        content: responseText.slice(0, MAX_MESSAGE_CHARS),
        replyToId: sourceMessage.id,
      });
      replies.push({
        participantId: participant.id,
        participantName: participant.name,
        participantKind: participant.kind,
        ok: true,
        message: { ...message },
      });
    }

    return { room: cloneRoom(room), replies };
  }

  private getOwnedRoom(ownerSessionId: string, roomId: string): GroupChatRoom {
    const room = this.rooms.get(roomId);
    if (!room || room.ownerSessionId !== ownerSessionId) {
      throw new PilotDeckToolRuntimeError(
        "invalid_tool_input",
        `Group chat room ${JSON.stringify(roomId)} was not found in this session.`,
      );
    }
    return room;
  }

  private getActiveRoom(ownerSessionId: string, roomId: string): GroupChatRoom {
    const room = this.getOwnedRoom(ownerSessionId, roomId);
    if (room.status !== "active") {
      throw new PilotDeckToolRuntimeError(
        "invalid_tool_input",
        `Group chat room ${JSON.stringify(roomId)} is closed.`,
      );
    }
    return room;
  }

  private appendMessage(
    room: GroupChatRoom,
    input: Omit<GroupChatMessage, "id" | "roomId" | "createdAt">,
  ): GroupChatMessage {
    const message: GroupChatMessage = {
      id: `msg-${this.uuid()}`,
      roomId: room.id,
      createdAt: this.now().toISOString(),
      ...input,
    };
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    }
    this.touch(room);
    return message;
  }

  private touch(room: GroupChatRoom): void {
    room.updatedAt = this.now().toISOString();
  }
}

export function formatGroupChatTranscript(room: GroupChatRoom): string {
  const lines = [`Group: ${room.title}`];
  if (room.messages.length === 0) {
    lines.push("(no messages yet)");
    return lines.join("\n");
  }
  for (const message of room.messages) {
    lines.push(`[${message.senderName} | ${message.senderKind}] ${message.content}`);
  }
  return lines.join("\n");
}

function normalizeParticipant(participant: GroupChatParticipant): GroupChatParticipant {
  const normalized: GroupChatParticipant = {
    id: requiredText(participant.id, "participant.id"),
    kind: participant.kind,
    name: requiredText(participant.name, "participant.name"),
  };
  if (participant.role?.trim()) normalized.role = participant.role.trim();
  if (participant.description?.trim()) normalized.description = participant.description.trim();
  if (participant.endpoint?.trim()) normalized.endpoint = normalizeEndpoint(participant.endpoint);
  if (participant.tokenEnv?.trim()) normalized.tokenEnv = participant.tokenEnv.trim();
  if (participant.employeeId?.trim()) normalized.employeeId = participant.employeeId.trim();

  if (normalized.kind === "pilotdeck_remote" && !normalized.endpoint) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Remote PilotDeck participant ${JSON.stringify(normalized.id)} requires endpoint.`,
    );
  }
  if (normalized.tokenEnv && !REMOTE_TOKEN_ENV_PATTERN.test(normalized.tokenEnv)) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "Remote PilotDeck tokenEnv must be a dedicated variable whose name starts with PILOTDECK_GROUP_.",
    );
  }
  if ((normalized.kind === "staffdeck" || normalized.kind === "staffdeck_mock") && !normalized.employeeId) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `StaffDeck participant ${JSON.stringify(normalized.id)} requires employeeId.`,
    );
  }
  return normalized;
}

function ensureParticipantSet(participants: GroupChatParticipant[]): void {
  if (participants.length > MAX_PARTICIPANTS) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `A group chat supports at most ${MAX_PARTICIPANTS} invited participants in this MVP.`,
    );
  }
  const ids = new Set<string>();
  for (const participant of participants) {
    if (participant.id === "main") {
      throw new PilotDeckToolRuntimeError(
        "invalid_tool_input",
        'Participant id "main" is reserved for the PilotDeck main agent.',
      );
    }
    if (ids.has(participant.id)) {
      throw new PilotDeckToolRuntimeError(
        "invalid_tool_input",
        `Duplicate group chat participant id ${JSON.stringify(participant.id)}.`,
      );
    }
    ids.add(participant.id);
  }
}

function resolveTargets(
  room: GroupChatRoom,
  requested: string[] | undefined,
): GroupChatParticipant[] {
  if (!requested || requested.length === 0) return [...room.participants];
  const requestedSet = new Set(requested.map((id) => id.trim()).filter(Boolean));
  const targets = room.participants.filter((participant) => requestedSet.has(participant.id));
  const found = new Set(targets.map((participant) => participant.id));
  const missing = [...requestedSet].filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Unknown group chat participant id(s): ${missing.join(", ")}.`,
    );
  }
  return targets;
}

function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `Invalid participant endpoint: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      `Participant endpoint must use http or https: ${value}`,
    );
  }
  if (url.username || url.password) {
    throw new PilotDeckToolRuntimeError(
      "invalid_tool_input",
      "Participant endpoint must not embed credentials; use a dedicated PILOTDECK_GROUP_* tokenEnv.",
    );
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function requiredText(value: string | undefined, field: string): string {
  const text = value?.trim();
  if (!text) {
    throw new PilotDeckToolRuntimeError("invalid_tool_input", `${field} cannot be empty.`);
  }
  return text;
}

function cloneRoom(room: GroupChatRoom): GroupChatRoom {
  return {
    ...room,
    participants: room.participants.map((participant) => ({ ...participant })),
    messages: room.messages.map((message) => ({ ...message })),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
