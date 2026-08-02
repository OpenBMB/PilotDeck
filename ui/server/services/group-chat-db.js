import crypto from 'node:crypto';
import { db } from '../database/db.js';

let lastTimestampMs = 0;
const nowIso = () => {
  const wallClockMs = Date.now();
  lastTimestampMs = Math.max(wallClockMs, lastTimestampMs + 1);
  return new Date(lastTimestampMs).toISOString();
};
const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function mapMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    category: memberCategory(row.kind),
    name: row.name,
    role: row.role || undefined,
    description: row.description || undefined,
    position: row.position,
    config: parseJson(row.config_json),
    instanceId: row.instance_id || undefined,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memberCategory(kind) {
  if (kind === 'pilotdeck_main' || kind === 'pilotdeck_remote') return 'pilotdeck_instance';
  if (kind === 'pilotdeck_local') return 'agent';
  return 'employee';
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    roundId: row.round_id || undefined,
    sequence: Number(row.sequence || 0),
    kind: row.message_kind || 'chat',
    senderType: row.sender_type,
    senderUserId: row.sender_user_id || undefined,
    senderMemberId: row.sender_member_id || undefined,
    senderName: row.sender_name,
    replyToMessageId: row.reply_to_message_id || undefined,
    content: row.content,
    metadata: parseJson(row.metadata_json),
    status: row.status,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapParticipant(row) {
  if (!row) return null;
  return {
    roomId: row.room_id,
    userId: row.user_id,
    displayName: row.display_name,
    boundMemberId: row.bound_member_id,
    boundInstanceId: row.bound_instance_id || undefined,
    role: row.role,
    muted: row.muted === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTurn(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    senderUserId: row.sender_user_id,
    entryMemberId: row.entry_member_id,
    triggerSource: row.trigger_source,
    messageSequence: row.message_sequence == null ? undefined : Number(row.message_sequence),
    idempotencyKey: row.idempotency_key || undefined,
    requiredDelegates: Array.isArray(parseJson(row.required_delegates_json))
      ? parseJson(row.required_delegates_json)
      : [],
    status: row.status,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoom(row, members = []) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    projectName: row.project_name,
    projectPath: row.project_path,
    ownerUserId: row.owner_user_id || row.user_id,
    coordinatorInstanceId: row.coordinator_instance_id || undefined,
    participantRole: row.participant_role || undefined,
    triggerMode: row.trigger_mode,
    muted: Number(row.participant_muted ?? row.muted) === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unreadCount: Number(row.participant_muted ?? row.muted) === 1 ? 0 : Number(row.unread_count || 0),
    hasSilentUnread: Number(row.participant_muted ?? row.muted) === 1 && Number(row.raw_unread_count || 0) > 0,
    lastMessagePreview: row.last_message_preview || '',
    members,
  };
}

const createRoomTransaction = db.transaction((userId, input) => {
  const id = newId('group');
  const timestamp = nowIso();
  const coordinator = input.coordinatorInstanceId
    ? db.prepare('SELECT kind FROM pilotdeck_instances WHERE id = ?').get(input.coordinatorInstanceId)
    : null;
  const coordinatorMemberKind = coordinator?.kind === 'remote' ? 'pilotdeck_remote' : 'pilotdeck_main';
  db.prepare(`
    INSERT INTO group_rooms (
      id, user_id, owner_user_id, coordinator_instance_id, title, project_name,
      project_path, trigger_mode, muted, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    id,
    userId,
    userId,
    input.coordinatorInstanceId || null,
    input.title,
    input.projectName,
    input.projectPath,
    input.triggerMode,
    input.muted ? 1 : 0,
    timestamp,
    timestamp,
  );
  db.prepare(`
    INSERT INTO group_members (
      id, room_id, kind, name, role, description, position, config_json,
      instance_id, is_active, created_at, updated_at
    ) VALUES ('main', ?, ?, 'PilotDeck 主智能体', '群主与协调者',
      '负责理解用户目标，并在其他成员发言后给出综合结论。', 10000, '{}', ?, 1, ?, ?)
  `).run(id, coordinatorMemberKind, input.coordinatorInstanceId || null, timestamp, timestamp);
  const user = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(userId);
  db.prepare(`
    INSERT INTO group_participants (
      room_id, user_id, display_name, bound_member_id, bound_instance_id, role, muted, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'main', ?, 'owner', 0, 'active', ?, ?)
  `).run(id, userId, user?.display_name || user?.username || '你', input.coordinatorInstanceId || null, timestamp, timestamp);
  db.prepare(`
    INSERT INTO group_read_state (user_id, room_id, last_read_at)
    VALUES (?, ?, ?)
  `).run(userId, id, timestamp);
  return id;
});

export const groupChatDb = {
  getRoomOwnerId(roomId) {
    const row = db.prepare('SELECT COALESCE(owner_user_id, user_id) AS owner_user_id FROM group_rooms WHERE id = ?').get(roomId);
    return row?.owner_user_id || null;
  },

  createRoom(userId, input) {
    const id = createRoomTransaction(userId, input);
    return this.getRoom(userId, id);
  },

  listRooms(userId) {
    const rows = db.prepare(`
      SELECT r.*,
        p.role AS participant_role,
        p.muted AS participant_muted,
        (SELECT content FROM group_messages gm
          WHERE gm.room_id = r.id AND gm.message_kind = 'chat'
            AND gm.status IN ('completed', 'failed')
          ORDER BY gm.sequence DESC, gm.rowid DESC LIMIT 1) AS last_message_preview,
        (SELECT COUNT(*) FROM group_messages gm
          WHERE gm.room_id = r.id
            AND gm.sender_type = 'agent'
            AND gm.message_kind = 'chat'
            AND gm.created_at > COALESCE(rs.last_read_at, r.created_at)) AS raw_unread_count,
        CASE WHEN p.muted = 1 THEN 0 ELSE
          (SELECT COUNT(*) FROM group_messages gm
            WHERE gm.room_id = r.id
              AND gm.sender_type = 'agent'
              AND gm.message_kind = 'chat'
              AND gm.created_at > COALESCE(rs.last_read_at, r.created_at))
        END AS unread_count
      FROM group_rooms r
      JOIN group_participants p ON p.room_id = r.id AND p.user_id = ? AND p.status = 'active'
      LEFT JOIN group_read_state rs ON rs.room_id = r.id AND rs.user_id = p.user_id
      WHERE r.status = 'active'
      ORDER BY r.updated_at DESC
    `).all(userId);
    const memberStmt = db.prepare(`
      SELECT * FROM group_members WHERE room_id = ? AND is_active = 1
      ORDER BY position ASC, created_at ASC
    `);
    return rows.map((row) => mapRoom(row, memberStmt.all(row.id).map(mapMember)));
  },

  getRoom(userId, roomId) {
    const row = db.prepare(`
      SELECT r.*,
        p.role AS participant_role,
        p.muted AS participant_muted,
        (SELECT content FROM group_messages gm WHERE gm.room_id = r.id
          AND gm.message_kind = 'chat'
          ORDER BY gm.sequence DESC, gm.rowid DESC LIMIT 1) AS last_message_preview,
        (SELECT COUNT(*) FROM group_messages gm
          WHERE gm.room_id = r.id AND gm.sender_type = 'agent' AND gm.message_kind = 'chat'
            AND gm.created_at > COALESCE(rs.last_read_at, r.created_at)) AS raw_unread_count,
        CASE WHEN p.muted = 1 THEN 0 ELSE
          (SELECT COUNT(*) FROM group_messages gm
            WHERE gm.room_id = r.id AND gm.sender_type = 'agent' AND gm.message_kind = 'chat'
              AND gm.created_at > COALESCE(rs.last_read_at, r.created_at))
        END AS unread_count
      FROM group_rooms r
      JOIN group_participants p ON p.room_id = r.id AND p.user_id = ? AND p.status = 'active'
      LEFT JOIN group_read_state rs ON rs.room_id = r.id AND rs.user_id = ?
      WHERE r.id = ?
    `).get(userId, userId, roomId);
    if (!row) return null;
    const members = this.listMembers(userId, roomId);
    return mapRoom(row, members);
  },

  updateRoom(userId, roomId, patch) {
    const current = this.getRoom(userId, roomId);
    if (!current || current.participantRole !== 'owner') return null;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE group_rooms SET title = ?, trigger_mode = ?, updated_at = ?
      WHERE id = ? AND COALESCE(owner_user_id, user_id) = ?
    `).run(
      patch.title ?? current.title,
      patch.triggerMode ?? current.triggerMode,
      timestamp,
      roomId,
      userId,
    );
    return this.getRoom(userId, roomId);
  },

  archiveRoom(userId, roomId) {
    return db.prepare(`
      UPDATE group_rooms SET status = 'archived', updated_at = ?
      WHERE id = ? AND COALESCE(owner_user_id, user_id) = ?
    `).run(nowIso(), roomId, userId).changes > 0;
  },

  getParticipant(userId, roomId) {
    return mapParticipant(db.prepare(`
      SELECT * FROM group_participants
      WHERE room_id = ? AND user_id = ? AND status = 'active'
    `).get(roomId, userId));
  },

  listParticipants(userId, roomId) {
    if (!this.getParticipant(userId, roomId)) return null;
    return db.prepare(`
      SELECT p.*, u.username, u.system_role, u.is_active,
        i.name AS instance_name, i.kind AS instance_kind, i.status AS instance_status
      FROM group_participants p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN pilotdeck_instances i ON i.id = p.bound_instance_id
      WHERE p.room_id = ? AND p.status = 'active'
      ORDER BY CASE p.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
        p.created_at ASC, p.user_id ASC
    `).all(roomId).map((row) => ({
      ...mapParticipant(row),
      username: row.username,
      systemRole: row.system_role,
      isActive: row.is_active === 1,
      instanceName: row.instance_name || undefined,
      instanceKind: row.instance_kind || undefined,
      instanceStatus: row.instance_status || undefined,
    }));
  },

  setParticipantMuted(userId, roomId, muted) {
    const result = db.prepare(`
      UPDATE group_participants SET muted = ?, updated_at = ?
      WHERE room_id = ? AND user_id = ? AND status = 'active'
    `).run(muted ? 1 : 0, nowIso(), roomId, userId);
    return result.changes > 0 ? this.getParticipant(userId, roomId) : null;
  },

  addParticipant(actorUserId, roomId, input) {
    const actor = this.getParticipant(actorUserId, roomId);
    if (!actor || !['owner', 'moderator'].includes(actor.role)) return null;
    if (actor.role === 'moderator' && input.role !== 'member') return null;
    const timestamp = nowIso();
    const memberId = input.memberId || `user-${input.userId}`;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO group_participants (
          room_id, user_id, display_name, bound_member_id, bound_instance_id,
          role, muted, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
        ON CONFLICT(room_id, user_id) DO UPDATE SET
          display_name = excluded.display_name,
          bound_member_id = excluded.bound_member_id,
          bound_instance_id = excluded.bound_instance_id,
          role = excluded.role, status = 'active', updated_at = excluded.updated_at
      `).run(roomId, input.userId, input.displayName, memberId, input.instanceId, input.role || 'member', timestamp, timestamp);
      db.prepare(`
        INSERT INTO group_members (
          id, room_id, kind, name, role, description, position, config_json,
          instance_id, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '参与者绑定实例', ?, ?, '{}', ?, 1, ?, ?)
        ON CONFLICT(room_id, id) DO UPDATE SET
          kind = excluded.kind, name = excluded.name, description = excluded.description,
          instance_id = excluded.instance_id, is_active = 1, updated_at = excluded.updated_at
      `).run(
        memberId, roomId, input.instanceKind === 'remote' ? 'pilotdeck_remote' : 'pilotdeck_main',
        input.instanceName, `${input.displayName} 的默认 PilotDeck 实例`, input.position ?? 9000,
        input.instanceId, timestamp, timestamp,
      );
      db.prepare(`
        INSERT INTO group_read_state (user_id, room_id, last_read_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id, room_id) DO UPDATE SET last_read_at = excluded.last_read_at
      `).run(input.userId, roomId, timestamp);
      db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, roomId);
    })();
    return this.getParticipant(input.userId, roomId);
  },

  updateParticipantRole(actorUserId, roomId, targetUserId, role) {
    const actor = this.getParticipant(actorUserId, roomId);
    const target = this.getParticipant(targetUserId, roomId);
    if (!actor || !target || actor.role !== 'owner' || target.role === 'owner') return null;
    const result = db.prepare(`
      UPDATE group_participants SET role = ?, updated_at = ?
      WHERE room_id = ? AND user_id = ? AND status = 'active'
    `).run(role, nowIso(), roomId, targetUserId);
    return result.changes > 0 ? this.getParticipant(targetUserId, roomId) : null;
  },

  removeParticipant(actorUserId, roomId, targetUserId) {
    const actor = this.getParticipant(actorUserId, roomId);
    const target = this.getParticipant(targetUserId, roomId);
    if (!actor || !target || target.role === 'owner') return false;
    if (actor.role !== 'owner' && !(actor.role === 'moderator' && target.role === 'member')) return false;
    const timestamp = nowIso();
    return db.transaction(() => {
      const result = db.prepare(`
        UPDATE group_participants SET status = 'removed', updated_at = ?
        WHERE room_id = ? AND user_id = ?
      `).run(timestamp, roomId, targetUserId);
      if (result.changes > 0) {
        db.prepare(`UPDATE group_members SET is_active = 0, updated_at = ? WHERE room_id = ? AND id = ?`)
          .run(timestamp, roomId, target.boundMemberId);
        db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, roomId);
      }
      return result.changes > 0;
    })();
  },

  switchParticipantInstance(userId, roomId, input) {
    const participant = this.getParticipant(userId, roomId);
    if (!participant) return null;
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(`
        UPDATE group_participants SET bound_instance_id = ?, updated_at = ?
        WHERE room_id = ? AND user_id = ? AND status = 'active'
      `).run(input.instanceId, timestamp, roomId, userId);
      db.prepare(`
        UPDATE group_members SET instance_id = ?, kind = ?, name = ?, updated_at = ?
        WHERE room_id = ? AND id = ?
      `).run(input.instanceId, input.instanceKind === 'remote' ? 'pilotdeck_remote' : 'pilotdeck_main', input.instanceName, timestamp, roomId, participant.boundMemberId);
      if (participant.role === 'owner') {
        db.prepare('UPDATE group_rooms SET coordinator_instance_id = ?, updated_at = ? WHERE id = ?')
          .run(input.instanceId, timestamp, roomId);
      }
    })();
    return this.getParticipant(userId, roomId);
  },

  createTurn(userId, roomId, input) {
    const participant = this.getParticipant(userId, roomId);
    if (!participant) return null;
    const id = input.id || newId('round');
    const timestamp = nowIso();
    if (input.idempotencyKey) {
      const existing = db.prepare(`
        SELECT * FROM group_turns WHERE room_id = ? AND idempotency_key = ?
      `).get(roomId, input.idempotencyKey);
      if (existing) return mapTurn(existing);
    }
    db.prepare(`
      INSERT INTO group_turns (
        id, room_id, sender_user_id, entry_member_id, trigger_source,
        status, message_sequence, idempotency_key, required_delegates_json,
        error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      roomId,
      userId,
      input.entryMemberId,
      input.triggerSource,
      input.status || 'queued',
      input.messageSequence ?? null,
      input.idempotencyKey || null,
      JSON.stringify(input.requiredDelegates || []),
      timestamp,
      timestamp,
    );
    return mapTurn(db.prepare('SELECT * FROM group_turns WHERE id = ?').get(id));
  },

  updateTurn(turnId, patch) {
    const current = db.prepare('SELECT * FROM group_turns WHERE id = ?').get(turnId);
    if (!current) return null;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE group_turns SET status = ?, error = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.status ?? current.status,
      patch.error === undefined ? current.error : patch.error,
      timestamp,
      turnId,
    );
    return mapTurn(db.prepare('SELECT * FROM group_turns WHERE id = ?').get(turnId));
  },

  setTurnMessageSequence(turnId, sequence) {
    db.prepare(`UPDATE group_turns SET message_sequence = ?, updated_at = ? WHERE id = ?`)
      .run(sequence, nowIso(), turnId);
    return mapTurn(db.prepare('SELECT * FROM group_turns WHERE id = ?').get(turnId));
  },

  getTurnById(turnId) {
    return mapTurn(db.prepare('SELECT * FROM group_turns WHERE id = ?').get(turnId));
  },

  getNextQueuedTurn(roomId) {
    return mapTurn(db.prepare(`
      SELECT * FROM group_turns WHERE room_id = ? AND status = 'queued'
      ORDER BY COALESCE(message_sequence, 9223372036854775807) ASC, created_at ASC, rowid ASC
      LIMIT 1
    `).get(roomId));
  },

  claimQueuedTurn(turnId) {
    const result = db.prepare(`
      UPDATE group_turns SET status = 'running', error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(nowIso(), turnId);
    return result.changes > 0 ? this.getTurnById(turnId) : null;
  },

  listPendingRoomIds() {
    return db.prepare(`
      SELECT DISTINCT room_id FROM group_turns WHERE status IN ('queued', 'running')
    `).all().map((row) => row.room_id);
  },

  requeueInterruptedTurns() {
    return db.prepare(`
      UPDATE group_turns SET status = 'queued', error = NULL, updated_at = ? WHERE status = 'running'
    `).run(nowIso()).changes;
  },

  getUserMessageForTurn(turnId) {
    return mapMessage(db.prepare(`
      SELECT * FROM group_messages
      WHERE round_id = ? AND sender_type = 'user' AND message_kind = 'chat'
      ORDER BY sequence ASC, rowid ASC LIMIT 1
    `).get(turnId));
  },

  getTurn(userId, roomId, turnId) {
    return mapTurn(db.prepare(`
      SELECT * FROM group_turns
      WHERE id = ? AND room_id = ? AND sender_user_id = ?
    `).get(turnId, roomId, userId));
  },

  listMembers(userId, roomId) {
    if (!this.getParticipant(userId, roomId)) return [];
    return db.prepare(`
      SELECT * FROM group_members WHERE room_id = ? AND is_active = 1
      ORDER BY position ASC, created_at ASC
    `).all(roomId).map(mapMember);
  },

  addMember(userId, roomId, input) {
    const room = this.getRoom(userId, roomId);
    if (!room || !['owner', 'moderator'].includes(room.participantRole)) return null;
    const timestamp = nowIso();
    const id = input.id || newId('member');
    const maxPosition = db.prepare(`
      SELECT COALESCE(MAX(position), -1) AS max_position FROM group_members
      WHERE room_id = ? AND id != 'main'
    `).get(roomId).max_position;
    db.prepare(`
      INSERT INTO group_members (
        id, room_id, kind, name, role, description, position, config_json,
        instance_id, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(room_id, id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        role = excluded.role,
        description = excluded.description,
        position = excluded.position,
        config_json = excluded.config_json,
        instance_id = excluded.instance_id,
        is_active = 1,
        updated_at = excluded.updated_at
    `).run(
      id,
      roomId,
      input.kind,
      input.name,
      input.role || null,
      input.description || null,
      Number(maxPosition) + 1,
      JSON.stringify(input.config || {}),
      input.instanceId || null,
      timestamp,
      timestamp,
    );
    db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, roomId);
    return this.listMembers(userId, roomId).find((member) => member.id === id) || null;
  },

  removeMember(userId, roomId, memberId) {
    if (memberId === 'main') return false;
    const room = this.getRoom(userId, roomId);
    if (!room || !['owner', 'moderator'].includes(room.participantRole)) return false;
    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE group_members SET is_active = 0, updated_at = ?
      WHERE room_id = ? AND id = ? AND id != 'main'
    `).run(timestamp, roomId, memberId);
    if (result.changes > 0) {
      db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, roomId);
    }
    return result.changes > 0;
  },

  reorderMembers(userId, roomId, memberIds) {
    const room = this.getRoom(userId, roomId);
    if (!room || !['owner', 'moderator'].includes(room.participantRole)) return null;
    const activeSecondaryIds = room.members.filter((member) => member.id !== 'main').map((member) => member.id);
    if (memberIds.length !== activeSecondaryIds.length ||
        new Set(memberIds).size !== memberIds.length ||
        memberIds.some((id) => !activeSecondaryIds.includes(id))) {
      throw new Error('Member order must contain every active non-main member exactly once.');
    }
    const timestamp = nowIso();
    const update = db.prepare(`
      UPDATE group_members SET position = ?, updated_at = ? WHERE room_id = ? AND id = ?
    `);
    db.transaction(() => {
      memberIds.forEach((id, index) => update.run(index, timestamp, roomId, id));
      db.prepare(`UPDATE group_members SET position = 10000, updated_at = ? WHERE room_id = ? AND id = 'main'`)
        .run(timestamp, roomId);
      db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, roomId);
    })();
    return this.listMembers(userId, roomId);
  },

  updateMemberConfig(userId, roomId, memberId, config) {
    const room = this.getRoom(userId, roomId);
    if (!room || !['owner', 'moderator'].includes(room.participantRole)) return null;
    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE group_members SET config_json = ?, updated_at = ?
      WHERE room_id = ? AND id = ? AND is_active = 1
    `).run(JSON.stringify(config || {}), timestamp, roomId, memberId);
    if (result.changes === 0) return null;
    return this.listMembers(userId, roomId).find((member) => member.id === memberId) || null;
  },

  listMessages(userId, roomId, limit = 100, before = null) {
    if (!this.getParticipant(userId, roomId)) return null;
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const anchor = before
      ? db.prepare('SELECT sequence FROM group_messages WHERE room_id = ? AND id = ?').get(roomId, before)
      : null;
    const rows = anchor
      ? db.prepare(`
          SELECT * FROM group_messages WHERE room_id = ? AND sequence < ?
          ORDER BY sequence DESC, rowid DESC LIMIT ?
        `).all(roomId, anchor.sequence, safeLimit)
      : before
        ? db.prepare(`
            SELECT * FROM group_messages WHERE room_id = ? AND created_at < ?
            ORDER BY sequence DESC, rowid DESC LIMIT ?
          `).all(roomId, before, safeLimit)
        : db.prepare(`
          SELECT * FROM group_messages WHERE room_id = ?
          ORDER BY sequence DESC, rowid DESC LIMIT ?
        `).all(roomId, safeLimit);
    return rows.reverse().map(mapMessage);
  },

  createMessage(userId, roomId, input) {
    const room = this.getRoom(userId, roomId);
    if (!room) return null;
    const id = input.id || newId('gmsg');
    const timestamp = nowIso();
    db.transaction(() => {
      const nextSequence = Number(db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM group_messages WHERE room_id = ?
      `).get(roomId).next_sequence);
      db.prepare(`
        INSERT INTO group_messages (
          id, room_id, round_id, sequence, message_kind, sender_type,
          sender_user_id, sender_member_id, sender_name, reply_to_message_id,
          content, metadata_json, status, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        roomId,
        input.roundId || null,
        nextSequence,
        input.kind || 'chat',
        input.senderType,
        input.senderUserId || null,
        input.senderMemberId || null,
        input.senderName,
        input.replyToMessageId || null,
        input.content || '',
        JSON.stringify(input.metadata || {}),
        input.status || 'completed',
        input.error || null,
        timestamp,
        timestamp,
      );
      db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, roomId);
    })();
    return mapMessage(db.prepare('SELECT * FROM group_messages WHERE id = ?').get(id));
  },

  updateMessage(messageId, patch) {
    const current = db.prepare('SELECT * FROM group_messages WHERE id = ?').get(messageId);
    if (!current) return null;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE group_messages SET content = ?, metadata_json = ?, status = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.content ?? current.content,
      patch.metadata === undefined ? current.metadata_json : JSON.stringify(patch.metadata || {}),
      patch.status ?? current.status,
      patch.error === undefined ? current.error : patch.error,
      timestamp,
      messageId,
    );
    db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, current.room_id);
    return mapMessage(db.prepare('SELECT * FROM group_messages WHERE id = ?').get(messageId));
  },

  markRead(userId, roomId) {
    const room = this.getRoom(userId, roomId);
    if (!room) return false;
    db.prepare(`
      INSERT INTO group_read_state (user_id, room_id, last_read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, room_id) DO UPDATE SET last_read_at = excluded.last_read_at
    `).run(userId, roomId, nowIso());
    return true;
  },
};
