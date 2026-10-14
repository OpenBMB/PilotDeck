# SOP v3 本地验收与交付

两仓库分支为 `standalone_alpha1_decouple_sop_1013`。完整逐项结果见
StaffDeck `portable_sop/ACCEPTANCE-1014.md`。私有原始证据位于
`/Users/a1/.codex/sop-acceptance-1014/evidence`，不提交凭据、数据库或模型配置。

已通过：独立 Runtime、双 adapter 共享 conformance cases、两宿主真实模型、
Tool/Skill/Knowledge 调用、人工恢复、管理编辑/发布/版本/子 SOP、StaffDeck
桌面与移动端审批、Gateway WebSocket、Runtime 重启和 66 次幂等重放。

PilotDeck 实际模型会话为 `real-model-sop-smoke-1791954754286`，最终 revision 3。
模型曾生成不完整的 Knowledge 参数并收到 422，修正参数后实际调用成功。
审批由 host-control 入口完成；这不等于公共 bearer 浏览器审批通过。
另增四节点真实业务验收 `pilotdeck-business-graph.json`，会话
`real-model-sop-smoke-1791956455451` 最终 revision 8：收集工单、调用
Tool/Skill/Knowledge、人工审批、完成。两宿主使用相同业务图和自己的能力绑定。

PilotDeck 公共审批页面已通过桌面 1440px 和移动端 390px 验收。
`pilotdeck-public-approval.json` 使用正常安装用户注册、原始 session admission、
真实 discovery/model callback 和 StaffDeck reviewer 登录，无替代 session resolver。
两次等待期间重启 Gateway 与 StaffDeck，原始审批状态一致；浏览器回复、重复
回复幂等和点击普通发送按钮后的真实模型续跑均通过，最终 revision 3。
会话为 `web:s_08de1fa8-d130-4003-b840-f08db0ab96eb` 与
`web:s_e5922dc5-5f77-418c-a4da-a716a26527b2`，截图无横向溢出。

StaffDeck 自身等待会话重启也已通过，证据 `staffdeck-process-restart.json`：
`session_14b7fde092804e89`、`handoff_c9f163e081194029`，进程 PID 61884
替换为 62064，正式 reviewer 回复后真实模型完成，Runtime revision 3。

PilotDeck 真实飞书已通过入站、模型/工具、等待、宿主控制接口恢复及最终投递，
`feishu.json` 保存入站消息 `om_x100b63c57fdb88acb0bbeab6f4007e7` 和回复消息
`om_x100b63c579088ca4cefaeb4b3716d74`，Runtime revision 3。
这条证据不覆盖公共浏览器 reviewer 审批。cc-connect 在该轮测试后已恢复。

StaffDeck 真实飞书会话 `session_2fd7b89933ec499e` 已完成入站、等待通知、
正式 reviewer API 审批、恢复与最终投递，Runtime revision 5，最终 outbox
记录 `chdlv_cca3bba558dd47da` 为 delivered。入站消息 ID 为
`om_x100b63c539e69938b0f95cd4929de85`。飞书历史查询权限不足，远端回复
消息 ID 尚未补取；reaction 权限也不足。测试绑定已停用，cc-connect 已恢复。

构建通过：PilotDeck TypeScript、PilotDeck UI、StaffDeck UI。
本轮聚焦测试：136 项非导出测试通过，8 项导出测试通过；导出测试须设置
`STAFFDECK_SOP_ROOT` 为实际配对的 StaffDeck worktree。
本轮新增独立 HTTP Runtime 回归 1 项、前端装配/等待/审批 12 项通过，
TypeScript 编译、UI typecheck、UI 生产构建与 diff 检查通过。
修复 scoped SOP 定义投影丢失版本造成的重复 prepare 内容冲突、v3 前端
装配拒绝和审批未登录时的重复错误提示。可复跑脚本为
`scripts/run-public-approval-v3.mjs`，须使用隔离验收环境与私有配置。

飞书 runner 只接受标记 `SOP1014` 的真实事件，并锁定该会话；不能用模拟事件
计为通过。相同机器人按宿主顺序测试，测试完成后恢复现有 cc-connect。

`/dsh` 部署、生产数据库迁移和主实例切换尚未执行。SSH 连接未确认前继续
保留未完成状态。切换前需要窗口和回滚方案；回滚必须保留新 Runtime 进度。
