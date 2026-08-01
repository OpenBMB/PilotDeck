import express from 'express';
import { getProjects } from '../projects.js';
import { groupChatDb } from '../services/group-chat-db.js';
import { groupChatService } from '../services/group-chat-service.js';

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
    const projects = await getProjects();
    const project = projects.find((candidate) => candidate.name === projectName);
    if (!project) return fail(res, 400, '请选择有效的项目工作空间。');
    const group = groupChatDb.createRoom(req.user.id, {
      title,
      projectName: project.name,
      projectPath: project.fullPath,
      triggerMode,
      muted: req.body?.muted === true,
    });
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

router.patch('/:groupId', (req, res) => {
  try {
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
    if (req.body?.muted !== undefined) patch.muted = req.body.muted === true;
    const group = groupChatDb.updateRoom(req.user.id, req.params.groupId, patch);
    if (!group) return fail(res, 404, '群组不存在。');
    res.json({ group });
  } catch (error) {
    fail(res, 400, error);
  }
});

router.delete('/:groupId', (req, res) => {
  try {
    const archived = groupChatDb.archiveRoom(req.user.id, req.params.groupId);
    if (!archived) return fail(res, 404, '群组不存在。');
    res.status(204).end();
  } catch (error) {
    fail(res, 500, error);
  }
});

router.get('/:groupId/messages', (req, res) => {
  try {
    const messages = groupChatDb.listMessages(
      req.user.id,
      req.params.groupId,
      req.query.limit,
      typeof req.query.before === 'string' ? req.query.before : null,
    );
    if (!messages) return fail(res, 404, '群组不存在。');
    res.json({ messages });
  } catch (error) {
    fail(res, 500, error);
  }
});

router.post('/:groupId/messages', (req, res) => {
  try {
    const result = groupChatService.sendMessage(req.user.id, req.params.groupId, req.body || {});
    if (!result) return fail(res, 404, '群组不存在。');
    res.status(202).json(result);
  } catch (error) {
    const status = String(error?.message || '').includes('上一轮') ? 409 : 400;
    fail(res, status, error);
  }
});

router.post('/:groupId/read', (req, res) => {
  try {
    const marked = groupChatDb.markRead(req.user.id, req.params.groupId);
    if (!marked) return fail(res, 404, '群组不存在。');
    res.status(204).end();
  } catch (error) {
    fail(res, 500, error);
  }
});

router.post('/:groupId/members', (req, res) => {
  try {
    const member = groupChatService.addMember(req.user.id, req.params.groupId, req.body || {});
    if (!member) return fail(res, 404, '群组不存在。');
    res.status(201).json({ member });
  } catch (error) {
    fail(res, 400, error);
  }
});

router.delete('/:groupId/members/:memberId', (req, res) => {
  try {
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
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
    const members = groupChatDb.reorderMembers(req.user.id, req.params.groupId, memberIds);
    if (!members) return fail(res, 404, '群组不存在。');
    res.json({ members });
  } catch (error) {
    fail(res, 400, error);
  }
});

export default router;
