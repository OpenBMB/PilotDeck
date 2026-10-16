# SOP 知识与版本开关增量验收

2026-10-14，两个开关的代码、独立包安装、网页部署和增量验收通过。
最终配置为 `SOP_KNOWLEDGE_ENABLED=false`、
`SOP_VERSION_MANAGEMENT_ENABLED=true`。默认值均为 true；配置由 Runtime
启动时读取，重启生效，没有新增网页设置入口。

## 部署与版本

- 网页：`http://127.0.0.1:27495/sop`；Runtime/Management 27491、Gateway 27493、Web 27495。
- 仍使用 `cn.openbmb.sopnative1014.{runtime,gateway,web}` 三服务。
  旧 StaffDeck 服务未加载，数据保留，没有生产迁移。
- 保留 SQLite/config 备份、原定义及全部 13 个原有会话；逐个比较状态未变化。
- 独立 Runtime 包已重新安装；Gateway 编译和 Web 构建使用服务运行时相同的
  `PILOTDECK_CONFIG_PATH`，没有 SD 地址或凭据。
- 双仓库分支：`standalone_alpha1_decouple_sop_1013`。
- 配对 StaffDeck 提交：`7a24755ca429cae2724386cf49720470f2b58011`。
- PD 提交为包含本报告的提交；推送后的完整远端版本对存于本机
  `evidence/features-1014/version-pair.json`。

## 四种配置与拒绝行为

| 知识 | 版本管理 | 管理 API | 1440px / 390px 普通编辑器、全屏节点与基础信息 |
| --- | --- | --- | --- |
| 关闭 | 关闭 | 通过 | 通过 |
| 关闭 | 开启 | 通过，最终部署 | 通过 |
| 开启 | 关闭 | 入口及绑定规则通过 | 通过 |
| 开启 | 开启 | 入口及绑定规则通过 | 通过 |

Runtime `features` 返回 `{knowledge, versionManagement}`；PD capabilities
透传。路由四组合测试确认生成 worker 与编辑器取得相同能力目录。
部署矩阵确认知识 binding 的目录过滤与 UI 策略一致。

知识关闭时隐藏知识节点、绑定入口；实际 JSON 导入、管理 create/validate、
直接发布知识定义及引用知识子 SOP 的父定义均被 `SOP_FEATURE_DISABLED` 拒绝。
已有知识会话的 prepare/submit/resume 被拒绝，状态未改变；普通 SOP 正常执行。
子 SOP 依赖在发布时展开检查；尚未解析的子 SOP 草稿仍允许编辑。

版本关闭时，普通及全屏编辑器不显示版本输入；目录不显示历史和回退入口。
服务端 list_versions/get_version/rollback 返回 `SOP_FEATURE_DISABLED`。
生成、编辑、保存、发布继续可用；发布自动分配不可变 `snapshot-*`。
重开版本管理后历史、详情和回退恢复可用，历史内容未改写。

## 真实模型、固定快照与恢复

两个尺寸均通过网页调用真实 `qwen3.6-flash-distill`，在两个开关都关闭时：
生成 → 编辑名称并保存 → 发布 → 发起 owner 审批 → 再次编辑发布 →
等待时重启三服务 → 原审批表单恢复 → 自动执行并完成。
新会话固定第二次发布快照，原等待会话固定初版。重启前后原会话的
wait ID、revision、slots 和版本完全一致。

| 尺寸 | SOP | 原等待会话 | 初版 → 第二次发布 |
| --- | --- | --- | --- |
| 1440 | `feature_real_1440_52856518` | `web:s_20a1506c-ef23-44c9-8fdc-7c27ec0d1197` | `snapshot-ec91813f0ca9483a99381c778c4ac826` → `snapshot-a72ebaa05ed44123a9df685ff3fe112c` |
| 390 | `feature_real_390_569dc9ec` | `web:s_40160c6d-73e7-408f-bb50-9ea8f1f13801` | `snapshot-0aa87de6bb0a4006b4c3b75257989337` → `snapshot-3b08706d55f64e9c81a93a1fd7c505f4` |

- 桌面 wait：`ff274a64-40c4-4735-8f59-427dc1efe47d`。
- 移动 wait：`15ce9f09-6b2a-42b6-a7b5-5b139a2ed2ea`。
- 两会话 revision：等待 **1** → 恢复 **2** → 完成 **4**；最终回复包含
  `FEATURE_SWITCH_COMPLETED`，始终保留初版快照。
- 重复原恢复请求返回同一 revision 2；最终逐个核对，每个 wait 仅一条
  续跑任务，再次重放不增加任务或推进流程。
- 两尺寸重新开启版本管理后，网页历史详情与回退通过；回退仅切换指针，
  完整历史记录前后相同。
- 修复验收发现的 390px 全屏检查面板裁切，以及原生版本详情弹窗缺少
  关闭控件；修复后重新构建并复跑四组合，面板边界和横向溢出检查通过。

## 证据与测试

原始证据在 `/Users/a1/.local/share/sop-native-1014/evidence/features-1014`：

- `matrix.json`、24 张 `matrix-{00,01,10,11}-{1440,390}-{editor,node,basic}.png`。
- `real-browser.json`、两尺寸 `real-*-published-off.png`、`real-*-completed.png`、
  `real-*-version-details.png`，含实际 session/wait/快照/revision/run 关联。
- `deployment-final.json`：最终开关、三服务、旧服务未加载、13 个原会话保留。
- `python-tests.txt`：独立 Core/Runtime/Management **40 项通过**。
- `backend-tests.tap`：HTTP/native 与原 StaffDeck adapter **95 项通过**。
- `web-final.txt`：路由/worker/outbox/binding/page **5 文件 15 项通过**；
  `approval-final.txt`：审批 consumer **4 项通过**。此前 feature suite 为 20 项，
  与上述测试重叠，不相加宣称唯一测试数。
- 后端 TypeScript 编译、前端 typecheck、同配置生产构建、双仓库 diff 检查通过。

移动端脚本的用例通过后，清理阶段遇到另一轮配置重启冲突；原始结果保留为
`real-browser-raw.json`。随后独立完成矩阵运行和最终在线核验，确认最终配置、
已完成状态、历史指针及幂等任务数量；没有把清理失败当成通过证据。

应用 fetch/HTTP/Undici 出站记录只有独立 Runtime、Gateway 和模型服务，
**StaffDeck 请求为 0**。这是应用请求记录，不是网络抓包。凭据、数据库和
模型私密配置未提交。

真实知识查询按本轮要求**取消**，知识开启仅验入口及替代绑定规则；不宣称
真实查询通过。生产迁移和飞书重测继续不在范围。基础三服务验收仍见
`ACCEPTANCE-NATIVE-1014.zh-CN.md`；Runtime 对应报告为配对仓库
`portable_sop/ACCEPTANCE-FEATURES-1014.md`。
