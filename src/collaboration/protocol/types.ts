export type GroupChatParticipantKind =
  | "pilotdeck_local"
  | "pilotdeck_remote"
  | "staffdeck"
  | "staffdeck_mock";

export type GroupChatParticipant = {
  id: string;
  kind: GroupChatParticipantKind;
  name: string;
  role?: string;
  description?: string;
  /** Base URL of a remote PilotDeck API-server channel. Never contains credentials. */
  endpoint?: string;
  /** Environment variable holding the remote PilotDeck bearer token. */
  tokenEnv?: string;
  /** StaffDeck AgentProfile id for real or mock employees. */
  employeeId?: string;
};

export type GroupChatMessageSenderKind =
  | "pilotdeck_main"
  | GroupChatParticipantKind;

export type GroupChatMessage = {
  id: string;
  roomId: string;
  conversationId?: string;
  senderId: string;
  senderName: string;
  senderKind: GroupChatMessageSenderKind;
  content: string;
  createdAt: string;
  replyToId?: string;
};

export type GroupChatRoomStatus = "active" | "closed";

export type GroupChatRoom = {
  id: string;
  ownerSessionId: string;
  title: string;
  status: GroupChatRoomStatus;
  participants: GroupChatParticipant[];
  messages: GroupChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type GroupChatParticipantReply = {
  participantId: string;
  participantName: string;
  participantKind: GroupChatParticipantKind;
  ok: boolean;
  message?: GroupChatMessage;
  error?: string;
};

export type GroupChatInvocationAttachment = {
  type: "image" | "file";
  name: string;
  path?: string;
  /** Base64 payload without a data-URL prefix. Used for inline images. */
  content?: string;
  mimeType?: string;
  bytes?: number;
};

export type GroupChatInvocation = {
  room: GroupChatRoom;
  participant: GroupChatParticipant;
  sourceMessage: GroupChatMessage;
  transcript: string;
  attachments?: GroupChatInvocationAttachment[];
};

export type GroupChatParticipantInvoker = (
  invocation: GroupChatInvocation,
) => Promise<string>;

export type StaffDeckEmployeeSummary = {
  id: string;
  name: string;
  description?: string;
  source: "staffdeck";
  access: "owned" | "public" | "accessible";
  creatorUserId?: string;
  creatorUsername?: string;
  creatorDisplayName?: string;
  publishedToGallery: boolean;
  usedByCurrentUser?: boolean;
  roleName?: string;
  expertiseTags?: string[];
  workStyles?: string[];
  workModes?: string[];
};
