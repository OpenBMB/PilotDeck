export type GroupTriggerMode = 'auto' | 'mentions';

export type GroupMemberCategory = 'pilotdeck_instance' | 'agent' | 'employee';

export type GroupMemberKind =
  | 'pilotdeck_main'
  | 'pilotdeck_local'
  | 'pilotdeck_remote'
  | 'staffdeck'
  | 'staffdeck_mock';

export interface AgentGroupMember {
  id: string;
  roomId: string;
  kind: GroupMemberKind;
  category: GroupMemberCategory;
  name: string;
  role?: string;
  description?: string;
  position: number;
  config: Record<string, unknown>;
  instanceId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroup {
  id: string;
  title: string;
  projectName: string;
  projectPath: string;
  triggerMode: GroupTriggerMode;
  muted: boolean;
  ownerUserId?: number;
  coordinatorInstanceId?: string;
  participantRole?: 'owner' | 'moderator' | 'member';
  status: 'active' | 'archived';
  unreadCount: number;
  hasSilentUnread: boolean;
  lastMessagePreview: string;
  members: AgentGroupMember[];
  conversations: AgentGroupConversation[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupConversation {
  id: string;
  roomId: string;
  title: string;
  status: 'active' | 'archived';
  unreadCount: number;
  hasSilentUnread: boolean;
  lastMessagePreview: string;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupParticipant {
  roomId: string;
  userId: number;
  displayName: string;
  boundMemberId: string;
  boundInstanceId?: string;
  role: 'owner' | 'moderator' | 'member';
  muted: boolean;
  status: 'active' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupMessage {
  id: string;
  roomId: string;
  conversationId?: string;
  roundId?: string;
  sequence: number;
  kind: 'chat' | 'delegation' | 'activity';
  senderType: 'user' | 'agent' | 'system';
  senderUserId?: number;
  senderMemberId?: string;
  senderName: string;
  replyToMessageId?: string;
  content: string;
  metadata: Record<string, unknown>;
  status: 'queued' | 'thinking' | 'completed' | 'failed';
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupImageAttachment {
  name: string;
  data?: string;
  path?: string;
  size?: number;
  mimeType?: string;
}

export interface AgentGroupFileAttachment {
  name: string;
  path: string;
  size?: number;
  mimeType?: string;
}

export interface AvailableGroupMember {
  id: string;
  kind: Exclude<GroupMemberKind, 'pilotdeck_main'>;
  category: GroupMemberCategory;
  name: string;
  role?: string;
  description?: string;
  employeeId?: string;
  staffdeckAccess?: 'owned' | 'public' | 'accessible';
  creatorUserId?: string;
  creatorUsername?: string;
  creatorDisplayName?: string;
  publishedToGallery?: boolean;
  usedByCurrentUser?: boolean;
  expertiseTags?: string[];
  workStyles?: string[];
  workModes?: string[];
}

export interface AvailableGroupMembers {
  local: AvailableGroupMember[];
  staffdeck: AvailableGroupMember[];
  mocks: AvailableGroupMember[];
  staffdeckConfigured: boolean;
  staffdeckError?: string | null;
}
