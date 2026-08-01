export type GroupTriggerMode = 'auto' | 'mentions';

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
  name: string;
  role?: string;
  description?: string;
  position: number;
  config: Record<string, unknown>;
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
  status: 'active' | 'archived';
  unreadCount: number;
  hasSilentUnread: boolean;
  lastMessagePreview: string;
  members: AgentGroupMember[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupMessage {
  id: string;
  roomId: string;
  roundId?: string;
  senderType: 'user' | 'agent' | 'system';
  senderMemberId?: string;
  senderName: string;
  content: string;
  status: 'queued' | 'thinking' | 'completed' | 'failed';
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AvailableGroupMember {
  id: string;
  kind: Exclude<GroupMemberKind, 'pilotdeck_main'>;
  name: string;
  role?: string;
  description?: string;
  employeeId?: string;
}

export interface AvailableGroupMembers {
  local: AvailableGroupMember[];
  staffdeck: AvailableGroupMember[];
  mocks: AvailableGroupMember[];
  staffdeckConfigured: boolean;
  staffdeckError?: string | null;
}
