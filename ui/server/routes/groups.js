import express from 'express';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getProjects } from '../projects.js';
import { groupChatDb } from '../services/group-chat-db.js';
import { groupChatService } from '../services/group-chat-service.js';
import { instancesDb, projectAccessDb, userDb } from '../database/db.js';
import { filterProjectsForUser, hasProjectRole, getProjectRole } from '../services/access-control.js';
import { recordAudit } from '../services/auth-service.js';

const router = express.Router();

const fail = (res, status, error) => res.status(status).json({
  error: error instanceof Error ? error.message : String(error),
});

router.get('/', (req, res) => {
  try {
    res.json({ groups: groupChatDb.listRooms(req.user.id) });
  } catch (error) {
    fail(res, 500, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const projectName = typeof req.body?.projectName === 'string' ? req.body.projectName.trim() : '';
    const triggerMode = req.body?.triggerMode === 'mentions' ? 'mentions' : 'auto';
    if (!title || title.length > 120) return fail(res, 400, '群组名称不能为空且不能超过 120 个字符。');
    const projects = filterProjectsForUser(await getProjects(null, { userId: req.user.id }), req.user);
    const project = projects.find((candidate) => candidate.name === projectName);
    if (!project) return fail(res, 400, '请选择有效的项目工作空间。');
    const projectRole = getProjectRole(project.fullPath, req.user);
    if (!hasProjectRole(projectRole, 'editor')) return fail(res, 403, '该项目角色不能创建群组。');
    const coordinator = instancesDb.getDefault(req.user.id);
    if (!coordinator) return fail(res, 409, '没有可用的 PilotDeck 实例。');
    if (coordinator.kind === 'remote' && !instancesDb.getProjectBinding(coordinator.id, project.fullPath)) {
      return fail(res, 409, '默认远端实例没有绑定当前项目工作区。');
    }
    const group = groupChatDb.createRoom(req.user.id, {
      title,
      projectName: project.name,
      projectPath: project.fullPath,
      triggerMode,
      muted: req.body?.muted === true,
      coordinatorInstanceId: coordinator.id,
    });
    recordAudit(req, { eventType: 'group.created', targetType: 'group', targetId: group.id, metadata: { projectPath: project.fullPath } });
    res.status(201).json({ group });
  } catch (error) {
    fail(res, 400, error);
  }
});

router.get('/available-members', async (_req, res) => {
  try {
    res.json(await groupChatService.listAvailableMembers());
  } catch (error) {
    fail(res, 500, error);
  }
});

router.get('/:groupId', (req, res) => {
  try {
    const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    res.json({ group });
  } catch (error) {
    fail(res, 500, error);
  }
});

router.get('/:groupId/conversations', (req, res) => {
  try {
    const conversations = groupChatDb.listConversations(req.user.id, req.params.groupId);
    if (!conversations) return fail(res, 404, '群组不存在。');
    return res.json({ conversations });
  } catch (error) {
    return fail(res, 500, error);
  }
});

router.post('/:groupId/conversations', (req, res) => {
  try {
    const conversation = groupChatDb.createConversation(req.user.id, req.params.groupId, {
      title: req.body?.title,
    });
    if (!conversation) return fail(res, 404, '群组不存在。');
    return res.status(201).json({ conversation });
  } catch (error) {
    return fail(res, 400, error);
  }
});

router.patch('/:groupId/conversations/:conversationId', (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 120) return fail(res, 400, '会话名称不能为空且不能超过 120 个字符。');
    const conversation = groupChatDb.updateConversation(
      req.user.id,
      req.params.groupId,
      req.params.conversationId,
      { title },
    );
    if (!conversation) return fail(res, 404, '会话不存在。');
    return res.json({ conversation });
  } catch (error) {
    return fail(res, 400, error);
  }
});

router.delete('/:groupId/conversations/:conversationId', (req, res) => {
  try {
    const archived = groupChatDb.archiveConversation(
      req.user.id,
      req.params.groupId,
      req.params.conversationId,
    );
    if (!archived) return fail(res, 404, '会话不存在。');
    return res.status(204).end();
  } catch (error) {
    return fail(res, 400, error);
  }
});

router.patch('/:groupId', (req, res) => {
  try {
    const existing = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!existing) return fail(res, 404, '群组不存在。');
    const patch = {};
    if (req.body?.title !== undefined) {
      const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title || title.length > 120) return fail(res, 400, '群组名称不能为空且不能超过 120 个字符。');
      patch.title = title;
    }
    if (req.body?.triggerMode !== undefined) {
      if (!['auto', 'mentions'].includes(req.body.triggerMode)) return fail(res, 400, '无效的触发模式。');
      patch.triggerMode = req.body.triggerMode;
    }
    if (req.body?.muted !== undefined) {
      const participant = groupChatDb.setParticipantMuted(req.user.id, req.params.groupId, req.body.muted === true);
      if (!participant) return fail(res, 404, '群组不存在。');
    }
    const hasSharedPatch = patch.title !== undefined || patch.triggerMode !== undefined;
    if (hasSharedPatch && existing.participantRole !== 'owner') return fail(res, 403, '只有群主可以修改群组设置。');
    const group = hasSharedPatch
      ? groupChatDb.updateRoom(req.user.id, req.params.groupId, patch)
      : groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    res.json({ group });
  } catch (error) {
    fail(res, 400, error);
  }
});

router.delete('/:groupId', (req, res) => {
  try {
    const existing = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!existing) return fail(res, 404, '群组不存在。');
    if (existing.participantRole !== 'owner') return fail(res, 403, '只有群主可以归档群组。');
    const archived = groupChatDb.archiveRoom(req.user.id, req.params.groupId);
    if (!archived) return fail(res, 404, '群组不存在。');
    res.status(204).end();
  } catch (error) {
    fail(res, 500, error);
  }
});

router.get('/:groupId/messages', (req, res) => {
  try {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
    if (!conversationId) return fail(res, 400, '请指定群组会话。');
    const messages = groupChatDb.listMessages(
      req.user.id,
      req.params.groupId,
      conversationId,
      req.query.limit,
      typeof req.query.before === 'string' ? req.query.before : null,
    );
    if (!messages) return fail(res, 404, '群组不存在。');
    res.json({ messages });
  } catch (error) {
    fail(res, 500, error);
  }
});

router.get('/:groupId/messages/:messageId/images/:imageIndex', async (req, res) => {
  try {
    const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    const message = groupChatDb.getMessage(req.user.id, req.params.groupId, req.params.messageId);
    if (!message) return fail(res, 404, '群组消息不存在。');
    const imageIndex = Number.parseInt(req.params.imageIndex, 10);
    const images = Array.isArray(message.metadata?.images) ? message.metadata.images : [];
    const image = Number.isInteger(imageIndex) && imageIndex >= 0 ? images[imageIndex] : null;
    if (!image || typeof image !== 'object') return fail(res, 404, '图片附件不存在。');

    let bytes;
    let contentType = typeof image.mimeType === 'string' && image.mimeType.startsWith('image/')
      ? image.mimeType
      : 'image/png';
    if (typeof image.data === 'string') {
      const match = image.data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/u);
      if (!match) return fail(res, 400, '图片附件格式无效。');
      contentType = match[1];
      bytes = Buffer.from(match[2], 'base64');
    } else if (typeof image.path === 'string' && image.path.trim()) {
      const root = path.resolve(group.projectPath);
      const resolved = path.resolve(image.path);
      const relative = path.relative(root, resolved).replace(/\\/gu, '/');
      const withinProject = relative && !relative.startsWith('../') && !path.isAbsolute(relative);
      const stagedAttachment = relative.startsWith('.tmp/chat-attachments/')
        || relative.includes('/.tmp/chat-attachments/');
      if (!withinProject || !stagedAttachment) return fail(res, 403, '图片附件路径无效。');
      const fileStats = await stat(resolved).catch(() => null);
      if (!fileStats?.isFile()) return fail(res, 404, '图片附件文件不存在。');
      bytes = await readFile(resolved);
    } else {
      return fail(res, 404, '图片附件没有可显示的内容。');
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  } catch (error) {
    return fail(res, 500, error);
  }
});

router.post('/:groupId/messages', (req, res) => {
  try {
    const result = groupChatService.sendMessage(req.user.id, req.params.groupId, req.body || {});
    if (!result) return fail(res, 404, '群组不存在。');
    res.status(202).json(result);
  } catch (error) {
    fail(res, 400, error);
  }
});

router.post('/:groupId/delegate', async (req, res) => {
  try {
    const turn = groupChatDb.getTurnById(req.groupDelegationGrant?.turn_id);
    if (!turn || turn.roomId !== req.params.groupId) return fail(res, 403, '委派令牌不属于当前群组轮次。');
    const result = await groupChatService.delegateMember(
      turn.senderUserId,
      req.params.groupId,
      req.body || {},
    );
    if (!result) return fail(res, 404, '群组不存在。');
    res.json(result);
  } catch (error) {
    fail(res, 400, error);
  }
});

router.post('/:groupId/read', (req, res) => {
  try {
    const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    if (!conversationId) return fail(res, 400, '请指定群组会话。');
    const marked = groupChatDb.markRead(req.user.id, req.params.groupId, conversationId);
    if (!marked) return fail(res, 404, '群组不存在。');
    res.status(204).end();
  } catch (error) {
    fail(res, 500, error);
  }
});

router.get('/:groupId/participants', (req, res) => {
  try {
    const participants = groupChatDb.listParticipants(req.user.id, req.params.groupId);
    if (!participants) return fail(res, 404, '群组不存在。');
    return res.json({ participants });
  } catch (error) {
    return fail(res, 500, error);
  }
});

router.get('/:groupId/participant-candidates', (req, res) => {
  try {
    const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    if (!['owner', 'moderator'].includes(group.participantRole)) return fail(res, 403, '没有邀请成员的权限。');
    const existing = new Set((groupChatDb.listParticipants(req.user.id, req.params.groupId) || []).map((entry) => Number(entry.userId)));
    const candidates = projectAccessDb.listMembers(group.projectPath).flatMap((entry) => {
      if (!entry.is_active || existing.has(Number(entry.user_id))) return [];
      const instance = instancesDb.getDefault(entry.user_id);
      return [{
        userId: entry.user_id,
        username: entry.username,
        displayName: entry.display_name || entry.username,
        projectRole: entry.role,
        defaultInstance: instance && instance.status === 'approved'
          ? { id: instance.id, name: instance.name, kind: instance.kind }
          : null,
      }];
    });
    return res.json({ candidates });
  } catch (error) {
    return fail(res, 500, error);
  }
});

router.post('/:groupId/participants', (req, res) => {
  try {
    const targetUserId = Number(req.body?.userId);
    const target = userDb.getUserById(targetUserId);
    if (!target) return fail(res, 404, '用户不存在。');
    const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    if (!['owner', 'moderator'].includes(group.participantRole)) return fail(res, 403, '没有邀请成员的权限。');
    if (!getProjectRole(group.projectPath, target)) return fail(res, 409, '该用户尚未获得绑定项目的访问权。');
    const instance = instancesDb.getDefault(targetUserId);
    if (!instance || instance.status !== 'approved') return fail(res, 409, '该用户没有已批准的默认实例。');
    const participant = groupChatDb.addParticipant(req.user.id, req.params.groupId, {
      userId: targetUserId,
      displayName: target.display_name || target.username,
      role: req.body?.role === 'moderator' ? 'moderator' : 'member',
      instanceId: instance.id,
      instanceKind: instance.kind,
      instanceName: instance.name,
    });
    if (!participant) return fail(res, 403, '无法邀请该成员。');
    recordAudit(req, { eventType: 'group.participant_added', targetType: 'group', targetId: req.params.groupId, metadata: { userId: targetUserId } });
    return res.status(201).json({ participant });
  } catch (error) {
    return fail(res, 400, error);
  }
});

router.patch('/:groupId/participants/:userId', (req, res) => {
  try {
    const role = req.body?.role;
    if (!['moderator', 'member'].includes(role)) return fail(res, 400, '无效的群组角色。');
    const participant = groupChatDb.updateParticipantRole(req.user.id, req.params.groupId, Number(req.params.userId), role);
    if (!participant) return fail(res, 403, '无法修改该参与者。');
    recordAudit(req, { eventType: 'group.participant_role_updated', targetType: 'group', targetId: req.params.groupId, metadata: { userId: Number(req.params.userId), role } });
    return res.json({ participant });
  } catch (error) {
    return fail(res, 400, error);
  }
});

router.delete('/:groupId/participants/:userId', (req, res) => {
  try {
    const removed = groupChatDb.removeParticipant(req.user.id, req.params.groupId, Number(req.params.userId));
    if (!removed) return fail(res, 403, '无法移除该参与者。');
    recordAudit(req, { eventType: 'group.participant_removed', targetType: 'group', targetId: req.params.groupId, metadata: { userId: Number(req.params.userId) } });
    return res.status(204).end();
  } catch (error) {
    return fail(res, 500, error);
  }
});

router.patch('/:groupId/my-participation', (req, res) => {
  try {
    if (req.body?.muted !== undefined) {
      const participant = groupChatDb.setParticipantMuted(req.user.id, req.params.groupId, req.body.muted === true);
      if (!participant) return fail(res, 404, '群组不存在。');
    }
    if (req.body?.instanceId !== undefined) {
      const instance = instancesDb.get(String(req.body.instanceId));
      if (!instance || instance.owner_user_id !== Number(req.user.id) || instance.status !== 'approved') {
        return fail(res, 404, '可用实例不存在。');
      }
      const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
      if (!group) return fail(res, 404, '群组不存在。');
      if (instance.kind === 'remote' && !instancesDb.getProjectBinding(instance.id, group.projectPath)) {
        return fail(res, 409, '远端实例没有绑定当前群组项目的工作区。');
      }
      const participant = groupChatDb.switchParticipantInstance(req.user.id, req.params.groupId, {
        instanceId: instance.id,
        instanceKind: instance.kind,
        instanceName: instance.name,
      });
      if (!participant) return fail(res, 404, '群组不存在。');
    }
    return res.json({ participant: groupChatDb.getParticipant(req.user.id, req.params.groupId) });
  } catch (error) {
    return fail(res, 400, error);
  }
});

router.post('/:groupId/members', (req, res) => {
  try {
    const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    if (!['owner', 'moderator'].includes(group.participantRole)) return fail(res, 403, '没有管理智能体成员的权限。');
    const member = groupChatService.addMember(req.user.id, req.params.groupId, req.body || {});
    if (!member) return fail(res, 404, '群组不存在。');
    res.status(201).json({ member });
  } catch (error) {
    fail(res, 400, error);
  }
});

router.delete('/:groupId/members/:memberId', (req, res) => {
  try {
    const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    if (!['owner', 'moderator'].includes(group.participantRole)) return fail(res, 403, '没有管理智能体成员的权限。');
    if (req.params.memberId === 'main') return fail(res, 400, '主智能体不能移出群组。');
    const removed = groupChatDb.removeMember(req.user.id, req.params.groupId, req.params.memberId);
    if (!removed) return fail(res, 404, '群组或成员不存在。');
    res.status(204).end();
  } catch (error) {
    fail(res, 500, error);
  }
});

router.put('/:groupId/member-order', (req, res) => {
  try {
    const group = groupChatDb.getRoom(req.user.id, req.params.groupId);
    if (!group) return fail(res, 404, '群组不存在。');
    if (!['owner', 'moderator'].includes(group.participantRole)) return fail(res, 403, '没有调整智能体顺序的权限。');
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
    const members = groupChatDb.reorderMembers(req.user.id, req.params.groupId, memberIds);
    if (!members) return fail(res, 404, '群组不存在。');
    res.json({ members });
  } catch (error) {
    fail(res, 400, error);
  }
});

export default router;
