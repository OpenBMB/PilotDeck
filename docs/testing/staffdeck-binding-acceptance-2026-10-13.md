# PD 项目自动绑定 SD 智能体：上线前测试执行报告

**结论：当前未提交候选满足本计划的隔离上线前验收条件。** B05、I01、I05、U02、C01 原未执行子项均有结果；本次将项目默认 discovery 预算改为90秒后，正式SD受控31秒恢复通过，全新L3六组场景各三轮通过，`L3-DISCOVERY-01`关闭。历史30秒超时、首次503及夹具污染证据永久保留。
本轮确实执行了 L1、正式应用 L2、生产前端构建浏览器和真实模型 L3；不是沿用历史通过数量。
真实模型最新授权检索、SOP、审批批准/拒绝均 3/3 通过；桌面与手机审批按钮均执行批准/拒绝。保留原始 discovery 超时和审批失败证据。用户已确认待发布后端为 SQLite。
未部署生产，未操作生产数据，未提交 Git commit。

## 候选与环境

| 仓库 | worktree / 分支 | 候选 HEAD |
| --- | --- | --- |
| PD | `/Users/a1/.codex/worktrees/standalone-alpha1-20261013/PilotDeck` / `codex/standalone-alpha1-20261013` | `b243fa007dcd449a78cf48e3d1f9e10f99c6c845` |
| SD | `/Users/a1/.codex/worktrees/standalone-alpha1-20261013/StaffDeck` / `standalone_alpha1` | `77c219737a9e8e24d6df39ba73212c60f5851b90` |

HEAD 上叠加未提交实现与本轮修复。完整脏路径及 diff stat 见
`evidence/staffdeck-binding-2026-10-13/candidate.json`；本轮执行期间发现缺陷后修改候选并做受影响回归。
补测最终候选见 `candidate-completion.json`；补测脚本和JSON逐项记录均已落入两个worktree对应仓库。
本次90秒修复后的最终候选见 `candidate-discovery90.json`；对应证据在 `l2-discovery90`、`l3-discovery90`，独立于历史补测记录。
因此这是最终未提交审阅候选，不宣称整个测试期间代码完全不变。依赖软链接不属于交付内容。

| 环境 | 原始私有目录尾名 | 端口 SD/SOP/Gateway/Web/模型 | 用途 |
| --- | --- | --- | --- |
| L2 故障与并发 | `binding-acceptance-AHIHdA` | 25610/25611/25612/25613/25614 | 正式 SD app.main、独立 SOP、编译 Gateway、Vite 构建前端、确定性 HTTP 模型 |
| L2 浏览器 | `binding-acceptance-AVJp5e` | 25810/25811/25812/25813/25814 | 创建/失败重试、上传、发布/归档/刷新、双标签页 |
| L2 最终重跑 | `binding-acceptance-CRfI8G` | 25910/25911/25912/25913/25914 | 修正进程控制后注册、重启、兼容、升级、同步、任务事件隔离 |
| L3 | `binding-acceptance-wyzCzg` | 25710/25711/25712/25713/外部模型 | `provider1/qwen3.6-flash-distill`、真实知识检索、真实 SOP 与审批 |
| L3 全新补测 | `binding-acceptance-XU5lt0` | 26010/26011/26012/26013/外部模型 | 先做普通聊天负例，再发布专用知识 SOP；真实三轮及浏览器/旧模式审批 |
| L3 discovery90 | `binding-acceptance-NHTKZd` | 26110/26111/26112/26113/外部模型 | 全新夹具先普通聊天，再发布私有SOP；观察代理26720/26721，正式SD应用包装器记录分段耗时 |

所有目录位于系统临时目录，独立 PILOT_HOME、PD auth.db 和 SD SQLite、两租户四种账号。
Web 使用正式 `ui/server/index.js` 入口提供构建后的 `ui/dist`，没有使用 Vite 开发服务器；
Gateway 从 `dist/src/cli/pilotdeck.js` 启动，SD 从 `uvicorn app.main:app` 启动，未手工拼接 SD 路由。
用户确认待发布数据库为 SQLite，和本轮隔离后端一致；并发、事务中断与旧数据库升级覆盖该后端。

## 命令与时间

精确命令数组、退出码、耗时见 `l2-browser/regression-result*.json`。
脚本前置条件与完整顺序见 `scripts/staffdeck-binding/README.md`。

| 执行 | 结果 | 本轮记录 |
| --- | --- | --- |
| `regression.mjs` core-tests | PASS | 97/97，41.50 秒；绑定、存储/锁故障、回调审批、完整 SOP AgentLoop |
| `regression.mjs` publish-tests | PASS | 10/10；发布/归档、原错误响应、快照和回执 |
| `regression.mjs` ui-tests | PASS | 89/89，5.97 秒；8 文件，包含绑定状态、模块/SDK/同步/发布/审批 |
| `regression.mjs` sd-tests | PASS | 67/67，17.66 秒；绑定、事务中断、升级、身份、能力、公开 SOP 与模型选择 |
| SD `test_project_knowledge_scope.py` | PASS | 1/1，2.36 秒；普通聊天隐藏 SOP-only，授权执行可见 |
| 归档 observer/host 追加回归 | PASS | 19/19，1.56 秒；与上述测试有重叠，不累计为独立总数 |
| 核心 build / UI build / UI typecheck | PASS | 修复后重跑；核心约 14.93 秒、最终 UI build 17.36 秒、类型检查通过 |
| 扩大 shell 回归 | PASS | 5 个 shell 文件、44/44 通过；标题补齐 `data-desktop-no-drag`。 |
| 两仓库 `git diff --check` | PASS | 最终检查通过 |
| 补测完整绑定集合 | PASS | core-tests 101/101，43.14 秒；SD含新增 facade 检查 82/82，17.05 秒。`l2-completion/regression-result-core-tests.json`、`regression-result-sd-tests.json`。 |
| 补测 UI 回归 | PASS | shell 44/44、模块/发布/审批89/89；类型检查8.58秒。构建须显式选择 `formal-host.yaml`，正式 Web 提供构建产物。 |
| discovery90 完整绑定集合 | PASS | core 101/101，41.612秒；SD 82/82，pytest17.95秒、命令18.943秒。`l2-discovery90/regression-result-*.json`；核心构建通过。UI及凭证轮换等未受影响链路保留已有通过证据。 |
| discovery90 受控恢复/真实模型 | PASS | 故障4/4；真实六组各三轮18/18。离线核验15次发现均成功且低于90秒，9个SOP状态及审批回执实际落盘。`l3-discovery90/observation-validation-result-discovery90.json`。 |

部分早期脚本没有记录 elapsedMs；对应报告明确保留“未记录”，不估算。
本轮初始复跑历史 PD21/UI108/SD25 作为起点；最终变更以以上针对性重跑及逐项证据为准。

## 用例矩阵

状态含义：PASS 为列明的断言通过；FAIL 为已执行失败；BLOCKED 为外部条件或尚未关闭原因阻断。原未执行补项全部已执行；PASS 不豁免其他场景的真实失败。

| 编号 / 子项 | 状态 | 输入与动作、预期、实际及证据 |
| --- | --- | --- |
| B01 三入口与重复注册 | PASS | 新目录 A、已有目录 B、隔离本地 HTTP bare Git 真克隆；各绑定普通空白 agent，Git HEAD 相同；重复 B 复用；列表/状态不增加数据库行。`l2-final/results.json`，6.43 秒。注册输入校验见项目路由测试。 |
| B02 C/D 接入与冲突 | PASS | 关闭开关创建 C/D，启用后读取 C pending 不创建；ensure C、显式绑定 D 复用预建目标；目标占用/KB与SOP身份冲突在 L1 拒绝。`l2-final/compatibility-result.json`、PD绑定测试。 |
| B03 永久幂等/并发 | PASS | 单项目20 HTTP请求；3独立PD进程各20调用；10项目3轮。API可见数量、数据库 agent/mapping 和 PD 行数逐轮一致，重放不新增。`l2-final/results.json`、`l2-faults/concurrency-result-complete-list.json`。 |
| B03 SD事务/PD中断/存储 | PASS | SD子进程 flushed但未提交时 SIGKILL 后0/0，提交后 SIGKILL 后1/1，重放最终1/1；PD UUID、发HTTP前、SD响应后、激活期间、激活返回后中断恢复；有效锁超时、退出锁、损坏JSON、实际 chmod EACCES 不重置身份。SD绑定测试及并发证据。 |
| B03 正式Gateway中断窗口 | PASS | 透传WebSocket代理观察正式reload_extensions：请求发出但响应未返回时杀PD；成功响应被暂扣且PD状态仍binding时杀PD。PD/Gateway共用PILOT_HOME；恢复同UUID/agent，数据库每项只增加1/1。`l2-final/gateway-crash-result.json`，1.41/0.95秒。 |
| B04 五状态/运行时加载 | PASS | disabled/pending/binding/bound/failed；加载前读 binding、加载抛错保存原目标 failed、重试 bound。真实不可用 Gateway 也返回 failed 后恢复原目标。L1与 `faults-result-ready-fixed.json`。 |
| B05 配置/凭证/目标故障 | PASS | 缺配置、非法地址、401/403/500/503替身；真实撤销、降权、目标归档/缺失，项目保留、资源拒绝、B普通聊天仍可用；恢复无替代目标。4项耗时2.36/1.31/1.40/1.24秒，`l2-faults/faults-result-ready-fixed.json`。 |
| B05 SD停机/Gateway不可用 | PASS | SD停机创建仍保留项目 failed，恢复复用UUID；Web bridge指向不可用loopback，状态 failed 后恢复同 agent，数据库不变，7.57秒。Gateway本身不可用时聊天无法执行，这是基础运行依赖，不宣称此时聊天可用。 |
| B05 SD超时/凭证轮换 | PASS | 正式SD进程SIGSTOP，10秒请求超时failed；SIGCONT恢复同bindingId/agentId、DB不新增，11.39秒。真实轮换接口：旧key401、ensure failed；新key重启后同UUID/agent且旧会话继续，5.91秒。`l2-completion/faults-complete-result-completion.json`。 |
| B05 discovery故障恢复 | PASS | 20ms超时、主动取消、代理503保留错误语义；使用发布默认发现90秒/执行30秒，31秒延迟后正式SD route成功，总耗时31.829秒。核对完整绑定文件不变（包括UUID/agentId）、DB仍38agents/35mappings。`l2-discovery90/discovery-faults-result.json`，历史503证据保留。 |
| B06 30秒复验 | PASS | 可控时钟29999ms无请求，30000ms复验，401使 failed，不新增agent；failed资源入口拒绝，列表只读。`staffdeck-project-binding-faults.spec.ts`。 |
| I01 知识库/任务隔离 | PASS | A的通用/SOP-only资源；B读详情、文档、分块、版本、查询、引用、任务、取消均404；A合法引用200。正式APIJob读/结果/取消/事件B403且无A标记，A可读事件。SD绑定测试、`l2-final/jobs-result.json`。 |
| I01 全部资源操作闭包 | PASS | 35子项：列表/详情/更新/删除/版本、文档/分块/引用、OKF导出、真实preview任务读取/取消/事件。每项A合法访问200（admission202）、B私有ID404，集合无A行；SDK文档更新使用当前版本实际200。`l2-completion/resources-complete-result-strict-owner.json`；preview25.95秒。全局资源规则延续I03证据。 |
| I02 生命周期 | PASS | 空白B无SOP工具、普通聊天；A创建、校验、首次与再次发布、回滚生成draft、重新发布、归档移除运行时定义。版本与回执按A目录持久化，不进入B。`l2-final/sop-lifecycle-result.json`、runtime结果。 |
| I02 发布失败 | PASS | 原401/403等响应不触碰快照，Gateway刷新失败不宣称effective；回执存储失败保持发布结果并报告未持久化。10项发布回归。 |
| I03 同步与提升 | PASS | 全局KB/SOP导入A；B没有A专属副本；A资源按既有规则提升全局；B指定A目标修改403。`l2-final/sync-result.json`。 |
| I04 身份/审批/会话 | PASS | tenant/actor/PD user/agent错误与歧义绑定拒绝；真实A等待时操作B，审批仍A；首轮真实SD/Gateway重启批准恢复；B不存在A session文件。L1及L3 verified-process事件。 |
| I04 真实审批全部重复 | PASS | 修复后批准3/3、拒绝3/3，均保存 `completed`；原始失败证据保留，最新证据 `special-runtime-result-post-fix.json`。 |
| I05 身份篡改 | PASS | 客户端agentId/scope与登记项目冲突403；B任务ID读写/事件403；缺失/未知项目409，不落入A/B。SDK路由测试和 `jobs-result.json`。 |
| I05 全参数组合 | PASS | 30身份子项，加I01资源ID/任务ID矩阵。四种模块入口缺/未知header409；A header与B projectKey/projectName/agentId冲突仍登记A；wrong scope403、缺scope/嵌套agent/tenant400；B任务读/结果/取消/事件403；ensure以URL项目为准且未知404。`l2-completion/identity-complete-result-completion.json`。 |
| U01 状态/异步切换/双标签 | PASS | 五态、重试、重复点击合并、迟到GET/POST单元测试；正式A响应延迟，侧栏切B后状态/资源仍B；双标签A/B独立。`browser-switch-result.json`、`browser-result.json`。 |
| U02 浏览器操作 | PASS | 1440x960/390x844生产构建；UI创建失败重试、刷新、markdown上传并查到唯一标记、浏览器发布/归档；无pageerror/持续重连/横向溢出，截图有内容。最终 `browser-workflow-result-ready-loaded.json`。 |
| U02 完整UI编辑/手机交互 | PASS | 1440x960、390x844各从UI创建空白项目，正式SD生成并完成校验事件，进入全屏修改节点、编辑唯一SOP ID、保存201、发布200、归档200；无pageerror/横向溢出，29.05/30.36秒。`l2-completion/browser-editor-result-final-editor.json`。两尺寸分别审批批准/拒绝并恢复completed：`l3-completion/special-runtime-result-browser-final.json`、截图。 |
| C01 删除/重添/重启 | PASS | 删除不删SD/映射；同路径重添复用；Web/Gateway/SD分别重启后保持，数据库计数不变，13.74秒。最终L2 `results.json`。 |
| C01 固定模式/升级 | PASS | 关闭开关恢复固定KB/SOP/copy访问，重新启用恢复A无新增；旧数据库副本移除新增表后正式app启动，旧行数不变，新表空，3.65秒。`compatibility-result.json`、`upgrade-result.json`。 |
| C01 旧固定审批 | PASS | 关闭绑定、固定A目标；真实handoff、切B、重启SD/Gateway、审批重放、批准/拒绝均completed；旧模式状态位于home/sop/sessions。重新启用A同UUID/agent且bound，DB前后6agents/4mappings，53.33/61.40秒。`l3-completion/special-runtime-result-legacy-counts.json`及legacy持久化状态。 |
| 待发布数据库后端 | PASS | 用户明确确认SQLite；与本轮正式应用数据库一致，数据库确认阻塞解除。 |

API契约：SD UUID/空名称/超长名称/非blank 422，无认证401、无权限/agent专属凭证403，跨用户404、归档409；事务不留孤立行。
PD业务失败以HTTP200的 `{status:failed,error:{code,message}}` 返回状态，路由认证/未知项目/损坏状态存储分别403/404/409等；
本轮修复统一这些错误的状态摘要结构，没有新增业务API。状态文件和外部摘要不含凭证。

## 真实模型

| 场景 | 结果 | 判据与证据 |
| --- | --- | --- |
| A普通聊天通用知识 | PASS 3/3；历史FAIL 2保留 | discovery90全新会话工具/AMBER引用通过，11.091/9.943/29.933秒。历史completion第2/3次30.10秒超时未检索：`l3-completion/chat-result-completion.json`不覆盖。 |
| A普通聊天SOP-only隐藏 | PASS 3/3；历史FAIL保留 | 私有SOP发布前，每次实际查询，无COBALT且无submit_step_result，26.276/16.471/15.189秒。旧夹具命中已发布授权SOP属夹具污染，保留且不作为直接泄漏证据。 |
| A授权SOP内私有知识 | PASS 3/3 | 正式授权context、实际工具参数与COBALT标记、最终completed；discovery90为34.318/28.839/25.849秒。 |
| A发布SOP执行/B普通聊天 | PASS 各3/3 | 正式回调、独立SOP服务、状态文件completed；B无submit_step_result，`runtime-result.json`。早期运行未记录单例耗时。 |
| B无法取得A私有知识 | PASS 3/3 | 实际knowledge_query无AMBER标记，3.644/3.673/3.128秒。 |
| A审批批准 | PASS 3/3 | discovery90：B切换、跨租户403、重放及A completed；SD/Gateway重启恢复，44.717/19.612/35.068秒。 |
| A审批拒绝 | PASS 3/3；历史FAIL保留 | discovery90：40.309/20.066/33.887秒completed；历史未提交节点结果失败保留，不被新结果覆盖。 |

原始缺陷 `L3-BEHAVIOR-01` 的 runId 为 `c84c6341-cddf-4f9c-afb5-5adf24c638fc`；修复后审批三轮通过。实际 wire 观察仍发现模型可能在强制工具选择下返回纯文字，代码只允许一次协议纠正，不伪造工具结果。
历史超时分析：PD原默认30秒AbortController截止，completion失败发生在30.10秒，SD同路径最终可有200但PD已取消，普通检索未发生。本次仅将项目默认discovery预算改为90000ms，显式合法值优先；执行timeoutMs默认30000ms不变，整体截止和主动取消保留，无路由降级或新增重试。
本次真实证据位于 `l3-discovery90`：15次发现均成功，最长27.482秒；15次目录查询最长7.621ms；15次initial模型回调最长27.464秒；JSON修正0次、计划修正0次。关联wire首响应最长598ms、首字节最长599ms、流完成最长27.454秒，耗时主要在模型流生成。首次30秒失败没有分段数据，不能据新样本断言它的确切延迟来源。
观察器仅记录阶段、路由/session/requestId、状态与耗时，不保存凭证或完整对话。`validate-observation.mjs`离线核对18项结果、15组一对一模型请求关联、实际completed状态和审批回执，不重新调用模型。先执行全部普通聊天负例，再发布私有SOP；重启、配置修改及故障注入串行。
模型服务异常仍保留：首轮批准恢复中的模型请求发生ETIMEDOUT（7.782秒），PD现有机制记录 `retry_progress` attempt1/max2、server_error，后续工具调用成功并持久化completed；本次未增加重试。另4个ECONNRESET均有下游clientClosed记录，是客户端取消请求，不算发现失败。15次发现本身均HTTP200且无errorType。六组会话只执行既定三轮，没有失败后整项重跑到通过。
初始 special-runtime 夹具错误与中间修复结果保留；补测以 `l3-completion` 对应逐项结果为准，首次真实失败仍列出。

## 修复与证据限制

本轮修复：绑定组件取消迟到响应；损坏JSON结构化失败且保留安装身份；多模型catalog显式选择；
普通聊天/公开debug隐藏SOP-only；首次SOP发布branch version激活；必需knowledge工具使用授权SOP context；
归档移除运行时定义及旧发布回执；模块页刷新恢复原登记项目；PD路由错误结构统一。
各修复有失败复现与受影响回归；绑定公共身份/持久化修改重跑核心绑定集合。

测试基础设施修复：SIGTERM后仍存活的任务Gateway需SIGKILL且核对listener PID；不能把未重启进程当成新版。
受影响重启结果由最终L2与 verified-process重跑替代。构建删除dist时与服务重启冲突，已顺序执行；
升级端口冲突改为空闲端口；同步重跑fixture名称改为唯一值；浏览器等待实际publish/启用菜单、ready与最终报告写入。
SD公开agent列表默认50且没有续页，计数改用已存在的完整enterprise列表，并与数据库分别校验；超过50行后重跑通过。
这些中间失败保留在证据中，不能当作已关闭产品缺陷数量。

会话标题已补 `data-desktop-no-drag`，相关 shell 回归 44/44 通过。

补测发现并修复SD公开 `cancel_knowledge_job` 未校验任务所属知识库，可由B取消A任务。现在先读任务租户和KB归属，再执行取消；真实A200/B404、focused facade15/15以及SD82/82、完整PD绑定101/101通过。
修复手机主区域无侧栏入口，接入既有展开按钮；生产前端两尺寸完整编辑通过。UI shell44/44、模块89/89及类型检查通过。
夹具修正记录：SD作者模型最初未配置/APP_SECRET不一致；静态UI须用formal-host profile；手机使用卡片而非table row；重复确定性SOP ID改为界面编辑唯一ID；旧模式读取home/sop；环境修改脚本应严格串行。所有中间失败JSON保留，部分重复浏览器尝试与写入并行造成断言失效，不作为产品通过证据。

脱敏目录含结果、命令/耗时、PD状态、实际工具/模型事件和截图；不含数据库、凭证、env、private配置或原日志。
补测总索引 `evidence/staffdeck-binding-2026-10-13/completion-cases.json` 收录104条执行记录：102 PASS、2 FAIL（同一真实discovery阻断的两个重复）。这是补测记录数，不替代原矩阵或L1测试总数。逐条含环境、命令、时长、预期、实际及证据文件；历史证据仍在原目录。
每次并发/故障结果包含数据库数量断言；SQLite升级保留旧行数。
旧预览 `/tmp/pd-sd-binding-qa.kJse4x` 为历史手拼路由环境，不能用作本轮正式L2结论。

## 放行

**隔离上线前验收通过。** 原必测补项均已执行；本次90秒默认修复、受控恢复、完整绑定回归及全新真实三轮证据补齐，`L3-DISCOVERY-01`关闭。重复创建、跨项目资源、会话身份漂移、失败误报bound未发现未关闭缺陷，任务取消越权已修复回归。
历史completion索引102PASS/2FAIL保留其原轮次意义；当前修复后的18/18及分段核验单列在l3-discovery90。外部模型瞬时服务失败按上述记录保留，不宣称服务永不失败。结论仅适用于记录的SQLite隔离候选及配置，不扩展到其他数据库或生产运行。
本报告不授权生产部署。
