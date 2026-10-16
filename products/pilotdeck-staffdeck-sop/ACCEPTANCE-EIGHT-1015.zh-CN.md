# SOP 八项网页功能验收，2026-10-15

本轮基线后创建修复 goal，保留失败记录，再修复代码、更新本机部署并使用真实模型复测。
本报告与 `evidence/eight-1015` 配套；私密模型轨迹、数据库和配置留在本机。

## 基线缺口与修复

| 基线结果 | 修复与验证 |
| --- | --- |
| 节点无模型选择入口，仅配置一个模型 | 普通编辑和全屏节点检查面板增加继承/具体模型选择；配置第二个真实模型 |
| 子 SOP 展开节点找不到父定义中的模型和上下文配置 | 从 Runtime 固定会话快照中的 prepared node 读取；真实 HTTP 测试覆盖过期宿主目录 |
| 子流程预览白屏 | 发布目录向共享图传递定义内容，预览和循环检测容忍无内容条目 |
| 本机 Skills 关闭、无绑定 | 启用 PD Skill 发现，绑定 read_skill/read_file/write_file；专用 SKILL.md 真实读取与文件写入 |
| 找不到 Skill 仍返回成功文本 | read_skill 抛出 tool_execution_failed，不产生成功 receipt；保留 content-only loader 兼容 |
| 审批输入随刷新清空 | 保留同会话投影，草稿按 session/wait/revision 存在 sessionStorage，恢复成功后清除；隔离与重挂载回归 |
| HANDOFF_REQUIRED 后模型只写审批文字，宿主没有纠正 | 对该提交错误允许一次有界协议纠正；真实能力错误仍保留失败行为 |
| 子模型曾改写 output_path | 失败会话保留；验收定义 1.0.2 明确子节点仅写 child_version，父终态不重写共享字段；增加路径不变断言 |

脚本失败也单独记录：构建生成配置被同步覆盖、逐字匹配模型标记、在禁用表单上输入、并行会话 workspace_busy、Gateway 重启时旧 run-registry 锁导致超时后恢复。
这些记录不作为成功证据；基线审批会话保持原 handoff 状态，不改写历史。

## 实际流程与证据

网页执行：收集 ticket/risk → 读取 Skill → read_file/write_file → 模型动态选择 high/low →
固定版本子 SOP → owner 网页审批 → DeepSeek 子节点 → 返回父流程完成。
工具授权通过网页 Allow once；SOP 审批单独通过 owner 表单，均非模拟事件。

模型实际请求为 `provider1/qwen3.6-flash-distill` 与 `provider1/deepseek-v4.1-flash`。
原始响应分别标识 `qwen3.6-flash`、`deepseek-v4-1-flash-260910`，不是同模型别名。
每个完成会话均有真实 read_skill、read_file、write_file success，三个当前节点 receipt，
可读取的 `eight-<ticket>.txt`，包含 ticket/risk、SKILL_RECIPE_EXECUTED_1015 和发布证据。

| 尺寸/场景 | Runtime session | 版本/结果 |
| --- | --- | --- |
| 1440 高风险，等待时发布新版本并重启三服务 | web:s_df94b2cb-b2df-471a-ad6a-e0f4b708056c | 固定父/子 1.0.0，completed revision 11 |
| 1440 高风险，审批草稿整页重载后恢复 | web:s_c1288cfb-51d1-4875-aff8-87a6f008ecf8 | 父/子 1.0.1，completed revision 11 |
| 1440 低风险，字段保持复测 | web:s_a79cb772-7b2c-4f55-bc99-16614a1e7c71 | 父/子 1.0.2，completed revision 11 |
| 390 低风险，编辑/会话/审批/完成 | web:s_246b61ad-e459-4c59-a5da-8194e1ac5fa6 | 父/子 1.0.2，completed revision 11 |
| 1440 高风险，同一 1.0.2 定义双分支复测 | web:s_8cab4941-7c89-4827-911e-17eaa41f5a8b | 父/子 1.0.2，completed revision 11 |

新建和真实模型生成均通过网页保存草稿并发布；JSON 校验应用、名称编辑、普通和全屏模型选择均实际操作。
普通项目会话通过 `/sop eight_parent_1015` 启动。高低分支分别持久化 HIGH_PATH_EXECUTED/LOW_PATH_EXECUTED。
旧父 1.0.0 固定子 1.0.0，父 1.0.1 固定子 1.0.1，新 1.0.2 固定子 1.0.2。
等待时重启保持完整状态、wait ID、revision 和展开快照；审批后自动续跑。
重复原 resume 返回原 revision，审计每个 wait 只有一条 accepted 续跑任务。

## 拒绝、回归与部署

部署 API 专用会话覆盖非法后继、缺失槽位、缺失 receipt、错节点/错 turn/未声明 capability、
旧 revision 与重复 submit；拒绝后状态完全一致。正常网页缺失绑定和不存在模型均明确报错，revision 0。

- AgentLoop、原 StaffDeck adapter、read_skill 聚焦回归：88 项通过。
- 独立 HTTP Runtime/PD adapter 测试通过，覆盖固定子节点模型、等待恢复及 conformance cases。
- 前端开关/模型/审批：8 项通过；路由/管理/续跑：9 项通过；StaffDeck approval consumer：4 项通过。
- 后端 TypeScript、前端 typecheck、运行配置生产构建和 diff 检查通过。

沿用 `cn.openbmb.sopnative1014.{runtime,gateway,web}`，端口 27491/27493/27495。
最终知识关闭、版本管理开启；StaffDeck 服务未加载，数据库和 24 个原会话状态保留。
应用 fetch/HTTP/Undici 出站目录仅 Runtime、Gateway、模型服务，StaffDeck 请求 0。
网页入口：http://127.0.0.1:27495/sop 。Docker 不参与这套本机部署。

## 复跑与配对

脚本：`scripts/browser-native-eight.mjs`、`scripts/verify-native-eight-rejections.mjs`。
设置 SOP_ACCEPTANCE_ROOT 指向私有部署目录；owner.json 由已有登录持有 token，不提交。
部署目录需要同名测试项目、能力绑定、两个模型、三服务配置及 LaunchAgents。
首次运行使用干净的验收 SOP ID/版本；重复发布的不可变版本不得覆盖。
已有 1.0.2 定义复跑可设 EIGHT_SETUP=0、EIGHT_NO_RESTART=1、EIGHT_EXPECT_VERSION=1.0.2。

本机原始证据：`~/.local/share/sop-native-1014/evidence/eight-1015`。
`baseline.json`、`attempt-*.json`、失败截图保留；`final-audit.json` 关联模型、工具、receipt、
session/turn/run/wait/revision 和最终输出。提交版索引只含脱敏结果与选定截图。
配对 SD 报告：`portable_sop/ACCEPTANCE-EIGHT-1015.md`；推送版本存本机 version-pair.json。

真实知识查询本轮取消；生产迁移和飞书重测不在范围。
