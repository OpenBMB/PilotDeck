# PD 原生 SOP 三服务验收

2026-10-14，本轮约定范围已通过：网页生成、编辑、版本、发布、执行、owner
人工审批和自动续跑均不需要 StaffDeck backend、数据库或凭据。Runtime
继续持有图状态、定义快照和 revision；PD 持有模型上下文、身份和交付日志。

## 部署与配对版本

- 两仓库分支：`standalone_alpha1_decouple_sop_1013`。
- StaffDeck 独立包提交：`8c6fff03a0cfa9679ca485f904157abe7de5b215`。
- PilotDeck 提交：包含本报告的实现提交，可用 `git log -1 --format=%H -- products/pilotdeck-staffdeck-sop/ACCEPTANCE-NATIVE-1014.zh-CN.md` 定位。
- 推送后核实的完整远端版本对保存在本机 `evidence/version-pair.json`。
- 网页入口：`http://127.0.0.1:27495/sop`，使用 PD 正常 owner 登录。
- Runtime/Management `27491`、PD Gateway `27493`、PD Web `27495`。
- 独立目录：`/Users/a1/.local/share/sop-native-1014`；独立 Runtime SQLite、
  PD auth.db、运行目录和安装依赖。模型为已配置的 `qwen3.6-flash-distill`。
- 三个 LaunchAgent：`cn.openbmb.sopnative1014.{runtime,gateway,web}`。
  原 `cn.openbmb.sop1014` 四服务全部卸载并禁用自动启动，SD 数据保留。
- `hostAdapter: pilotdeck`，关闭 Knowledge 模块；配置没有 SD 地址或凭据。
  网页构建、Web 和 Gateway 使用同一个 `PILOTDECK_CONFIG_PATH`。
- 出站 fetch/HTTP/Undici 记录只出现独立 Runtime、Gateway 与模型服务；
  SD 请求为 0。该证据为应用请求记录，不是网络抓包。
- 独立 Runtime 已安装包的导入检查没有 `app.*`、`staffdeck_harness`，
  安装依赖没有 StaffDeck backend。

## 逐项结果

原始证据在 `/Users/a1/.local/share/sop-native-1014/evidence`，未提交凭据和数据库。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 1440px 网页真实模型生成、编辑保存、发布、版本详情 | 通过 | `generation-three-browser.json`、编辑器/版本截图；无页面 JS 异常 |
| 390px 网页真实模型改写和发布 | 通过 | `rewrite-three-browser.json`；发布 1.0.2，无横向溢出 |
| 两尺寸收集 ticket、真实 read_file、owner 等待、审批、自动完成 | 通过 | `execution-three-browser.json`；revision 1 → 5 → 6 → 8；最终回复含 `SOP_NATIVE_COMPLETED` |
| 等待期间重启 Runtime/Gateway/Web | 通过 | 桌面会话；等待 revision、wait ID、固定版本一致，网页原表单继续处理 |
| 重复原审批请求 | 通过 | 两尺寸返回相同恢复 receipt/revision，续跑任务不增加 |
| Web 重启恢复未发送的持久化续跑任务 | 通过 | `outbox-restart.json`；真实模型完成 revision 4，再重启不重复已受理 run |
| 新发布立即生效、原会话继续固定版本 | 通过 | `deployment-final.json`；新会话 1.0.2，原已完成会话仍为 1.0.1 |
| owner JWT、换 owner、伪造 subject/authority、跨项目/会话、错误 wait/revision | 通过 | native authority/router/approval bridge 聚焦测试 |
| 草稿 revision 冲突、不可变版本、归档/删除、回退和发布事务 | 通过 | 独立 Management Service 测试；归档/删除禁止新执行，旧快照保留 |
| 子 SOP 已发布版本固定、未发布引用、循环及超过 8 层 | 通过 | 独立管理/Core 测试 |
| 生成取消、SSE 续读、worker 中断、一次修复及不覆盖草稿 | 通过 | 独立任务测试及 PD worker/router 测试 |
| submit/resume 幂等、旧 revision、非法后继、必填槽位和 receipt 拒绝 | 通过 | Core/Runtime、SQLite 恢复与真实 HTTP AgentLoop 测试 |
| Tool/Skill/Knowledge 的成功、失败、缺失绑定及 receipt scope | 测试替身通过 | HTTP AgentLoop 聚焦测试；真实网页能力调用为 read_file |
| StaffDeck adapter 回归 | 通过 | 保留原审批及 SOP AgentLoop 测试 |
| 真实知识查询 | 未验收 | 本轮只实现可替换绑定与测试替身 |
| 生产迁移、数字员工/gallery 导入、飞书重测 | 不在范围 | 未执行，不作为本轮完成条件 |

真实三服务会话关联：

- 桌面：`web:s_5b025b9f-61a1-472b-9270-1e05701a620c`，
  wait `978ba279-9d29-4f77-9266-ab30ab443ee9`，版本 1.0.1，最终 revision 8。
- 移动：`web:s_12cfe888-4eeb-4d21-aeab-19cc8d727080`，
  wait `02153e33-ec1c-4db8-8f19-9c096cd87ef2`，版本 1.0.1，最终 revision 8。
- 续跑重启：`web:s_1083e9ed-d094-492d-9cb3-4a27d08f58ae`，
  wait `7283309f-8e59-4ed1-b4e6-44586fcfa901`，
  run `sop-resume:2fdd84b9-7f4b-4534-b803-f6ed41d28350`。

重启验收曾发现 Web 丢失原交互绑定导致 `interaction_reconnect_required`。
修复后将服务端绑定持久化，恢复时凭原绑定重连，再走正常 Gateway 投递；
没有跳过 Gateway 对过期绑定的拒绝。修复后的真实重启验收通过。
早期测试脚本使用错误项目的任务被拒绝并保留为 failed，未计入通过。
已经被 Gateway 受理但中断的执行保留在运行日志中，不静默重跑；未受理
任务才在启动后补投。

## 聚焦验证

- 独立 Python Core/Runtime/Management：32 项通过。
- PD HTTP Runtime、原生审批及原 SD adapter：95 项通过，`backend-final.tap`。
- Web worker/router/authority/outbox/binding 与正常 bridge 回归：
  9 文件、73 项通过，`web-final.txt`。
- 前端模块生成器：10 项通过。
- 后端 TypeScript 编译、前端 typecheck、同配置网页生产构建、双仓库 diff 检查通过。
  各套测试存在重叠，未将数量相加宣称唯一覆盖数。

实现/复跑入口见 `NATIVE-SOP.md`。Runtime 侧完整验收记录在配对 StaffDeck
仓库 `portable_sop/ACCEPTANCE-NATIVE-1014.md`。此前四服务和 SD reviewer
验收报告仅保留为历史证据，本报告使用三服务、无 SD 的完成标准。
