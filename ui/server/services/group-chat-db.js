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
    role: row.role,
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
    triggerMode: row.trigger_mode,
    muted: row.muted === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unreadCount: row.muted === 1 ? 0 : Number(row.unread_count || 0),
    hasSilentUnread: row.muted === 1 && Number(row.raw_unread_count || 0) > 0,
    lastMessagePreview: row.last_message_preview || '',
    members,
  };
}

const createRoomTransaction = db.transaction((userId, input) => {
  const id = newId('group');
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO group_rooms (
      id, user_id, title, project_name, project_path, trigger_mode, muted,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    id,
    userId,
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
      is_active, created_at, updated_at
    ) VALUES ('main', ?, 'pilotdeck_main', 'PilotDeck 主智能体', '群主与协调者',
      '负责理解用户目标，并在其他成员发言后给出综合结论。', 10000, '{}', 1, ?, ?)
  `).run(id, timestamp, timestamp);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  db.prepare(`
    INSERT INTO group_participants (
      room_id, user_id, display_name, bound_member_id, role, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'main', 'owner', 'active', ?, ?)
  `).run(id, userId, user?.username || '你', timestamp, timestamp);
  db.prepare(`
    INSERT INTO group_read_state (user_id, room_id, last_read_at)
    VALUES (?, ?, ?)
  `).run(userId, id, timestamp);
  return id;
});

export const groupChatDb = {
  getRoomOwnerId(roomId) {
    const row = db.prepare('SELECT user_id FROM group_rooms WHERE id = ?').get(roomId);
    return row?.user_id || null;
  },

  createRoom(userId, input) {
    const id = createRoomTransaction(userId, input);
    return this.getRoom(userId, id);
  },

  listRooms(userId) {
    const rows = db.prepare(`
      SELECT r.*,
        (SELECT content FROM group_messages gm
          WHERE gm.room_id = r.id AND gm.message_kind = 'chat'
            AND gm.status IN ('completed', 'failed')
          ORDER BY gm.sequence DESC, gm.rowid DESC LIMIT 1) AS last_message_preview,
        (SELECT COUNT(*) FROM group_messages gm
          WHERE gm.room_id = r.id
            AND gm.sender_type = 'agent'
            AND gm.message_kind = 'chat'
            AND gm.created_at > COALESCE(rs.last_read_at, r.created_at)) AS raw_unread_count,
        CASE WHEN r.muted = 1 THEN 0 ELSE
          (SELECT COUNT(*) FROM group_messages gm
            WHERE gm.room_id = r.id
              AND gm.sender_type = 'agent'
              AND gm.message_kind = 'chat'
              AND gm.created_at > COALESCE(rs.last_read_at, r.created_at))
        END AS unread_count
      FROM group_rooms r
      LEFT JOIN group_read_state rs ON rs.room_id = r.id AND rs.user_id = r.user_id
      WHERE r.user_id = ? AND r.status = 'active'
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
        (SELECT content FROM group_messages gm WHERE gm.room_id = r.id
          AND gm.message_kind = 'chat'
          ORDER BY gm.sequence DESC, gm.rowid DESC LIMIT 1) AS last_message_preview,
        (SELECT COUNT(*) FROM group_messages gm
          WHERE gm.room_id = r.id AND gm.sender_type = 'agent' AND gm.message_kind = 'chat'
            AND gm.created_at > COALESCE(rs.last_read_at, r.created_at)) AS raw_unread_count,
        CASE WHEN r.muted = 1 THEN 0 ELSE
          (SELECT COUNT(*) FROM group_messages gm
            WHERE gm.room_id = r.id AND gm.sender_type = 'agent' AND gm.message_kind = 'chat'
              AND gm.created_at > COALESCE(rs.last_read_at, r.created_at))
        END AS unread_count
      FROM group_rooms r
      LEFT JOIN group_read_state rs ON rs.room_id = r.id AND rs.user_id = ?
      WHERE r.id = ? AND r.user_id = ?
    `).get(userId, roomId, userId);
    if (!row) return null;
    const members = this.listMembers(userId, roomId);
    return mapRoom(row, members);
  },

  updateRoom(userId, roomId, patch) {
    const current = this.getRoom(userId, roomId);
    if (!current) return null;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE group_rooms SET title = ?, trigger_mode = ?, muted = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      patch.title ?? current.title,
      patch.triggerMode ?? current.triggerMode,
      patch.muted === undefined ? (current.muted ? 1 : 0) : (patch.muted ? 1 : 0),
      timestamp,
      roomId,
      userId,
    );
    return this.getRoom(userId, roomId);
  },

  archiveRoom(userId, roomId) {
    return db.prepare(`
      UPDATE group_rooms SET status = 'archived', updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(nowIso(), roomId, userId).changes > 0;
  },

  getParticipant(userId, roomId) {
    return mapParticipant(db.prepare(`
      SELECT * FROM group_participants
      WHERE room_id = ? AND user_id = ? AND status = 'active'
    `).get(roomId, userId));
  },

  createTurn(userId, roomId, input) {
    const participant = this.getParticipant(userId, roomId);
    if (!participant) return null;
    const id = input.id || newId('round');
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO group_turns (
        id, room_id, sender_user_id, entry_member_id, trigger_source,
        status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      roomId,
      userId,
      input.entryMemberId,
      input.triggerSource,
      input.status || 'queued',
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

  getTurn(userId, roomId, turnId) {
    return mapTurn(db.prepare(`
      SELECT * FROM group_turns
      WHERE id = ? AND room_id = ? AND sender_user_id = ?
    `).get(turnId, roomId, userId));
  },

  listMembers(userId, roomId) {
    const owned = db.prepare('SELECT 1 FROM group_rooms WHERE id = ? AND user_id = ?').get(roomId, userId);
    if (!owned) return [];
    return db.prepare(`
      SELECT * FROM group_members WHERE room_id = ? AND is_active = 1
      ORDER BY position ASC, created_at ASC
    `).all(roomId).map(mapMember);
  },

  addMember(userId, roomId, input) {
    const room = this.getRoom(userId, roomId);
    if (!room) return null;
    const timestamp = nowIso();
    const id = input.id || newId('member');
    const maxPosition = db.prepare(`
      SELECT COALESCE(MAX(position), -1) AS max_position FROM group_members
      WHERE room_id = ? AND id != 'main'
    `).get(roomId).max_position;
    db.prepare(`
      INSERT INTO group_members (
        id, room_id, kind, name, role, description, position, config_json,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(room_id, id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        role = excluded.role,
        description = excluded.description,
        position = excluded.position,
        config_json = excluded.config_json,
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
      timestamp,
      timestamp,
    );
    db.prepare('UPDATE group_rooms SET updated_at = ? WHERE id = ?').run(timestamp, roomId);
    return this.listMembers(userId, roomId).find((member) => member.id === id) || null;
  },

  removeMember(userId, roomId, memberId) {
    if (memberId === 'main') return false;
    const room = this.getRoom(userId, roomId);
    if (!room) return false;
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
    if (!room) return null;
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
    if (!room) return null;
    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE group_members SET config_json = ?, updated_at = ?
      WHERE room_id = ? AND id = ? AND is_active = 1
    `).run(JSON.stringify(config || {}), timestamp, roomId, memberId);
    if (result.changes === 0) return null;
    return this.listMembers(userId, roomId).find((member) => member.id === memberId) || null;
  },

  listMessages(userId, roomId, limit = 100, before = null) {
    const owned = db.prepare('SELECT 1 FROM group_rooms WHERE id = ? AND user_id = ?').get(roomId, userId);
    if (!owned) return null;
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
