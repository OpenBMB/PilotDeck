# 思考模式实机验收 — 2026-09-15

## 结论

在提交 `097d49fd`、本地 `http://localhost:3001` 上测试。覆盖当前已配置的 3 家供应商、9 个模型。本轮未发现 PilotDeck 思考模式相关功能故障；不代表所有模型版本或全部业务功能均已验证。

- 27 次普通模型流式请求 + 6 次工具调用/续答请求，共 **33 次真实运行时请求**，全部 HTTP 200，答案符合预期。
- 另验证 1 次 GLM 关闭思考操作：在本地按当前适配规则拒绝，未发送 API 请求。这只能验证本地保护逻辑，不是对供应商是否支持关闭的实测结论。
- 浏览器通过真实聊天链路完成 **4 轮跨模型对话**，结果依次为 391、400、50、42。
- **173 项自动化测试通过**：后端 111 项，前端 62 项。
- 真实请求中未发现温度或旧 thinking-budget 控制字段；effort 原样发送，没有转换为 token 预算。

## 方法与配置保护

使用项目现有 `parseModelConfig`、`createModelRuntime` 和流式解析/消息组装代码；在发送 HTTP 的边界记录控制字段、HTTP 状态、流事件数、用量和最终文本。密钥、完整请求头与供应商地址均未写入报告。

未配置的测试档位和关闭状态仅修改内存中的配置副本。测试结束校验磁盘配置未变。浏览器设置弹窗内的开关测试均通过“取消”退出，并重新打开确认恢复。没有发送工具访问用户文件；工具回放使用固定测试数据。

实际真实请求直接走配置端点；报告不根据模型名推定中转站背后的真实模型。

## 普通请求明细

所有正常回答预期均为 `391`。思考字符数仅表示接口返回的可见思考文本长度，不能作为真实推理计算量的度量，也不能证明不同档位的效果差异。

| 供应商 | 模型 | 测试档位 | 实际思考控制字段 | HTTP/结果 | 可见思考字符 | 耗时 |
| --- | --- | --- | --- | --- | ---: | ---: |
| HXAPI | qwen3.8-27b | default | 无 | 200 / 正确 | 112 | 0.49s |
| HXAPI | qwen3.8-27b | low | `{"reasoning_effort":"low"}` | 200 / 正确 | 123 | 0.50s |
| HXAPI | qwen3.8-27b | medium | `{"reasoning_effort":"medium"}` | 200 / 正确 | 120 | 0.47s |
| HXAPI | qwen3.8-27b | xhigh | `{"reasoning_effort":"xhigh"}` | 200 / 正确 | 121 | 0.37s |
| zhipu | glm-5.3-flash | default | 无 | 200 / 正确 | 151 | 1.95s |
| HXAPI | qwen3.8-27b | off | `{"reasoning_effort":"none"}` | 200 / 正确 | 0 | 0.14s |
| HXAPI | qwen3.6-27b | configured-off | `{"reasoning_effort":"none"}` | 200 / 正确 | 0 | 0.14s |
| HXAPI | qwen3.6-35b-a3b | default | 无 | 200 / 正确 | 0 | 0.14s |
| HXAPI | minicpm5-2b | default | 无 | 200 / 正确 | 214 | 0.53s |
| aicore | gpt-5.6-sol | default | 无 | 200 / 正确 | 0 | 3.02s |
| zhipu | glm-5.3-flash | low | `{"reasoning_effort":"low"}` | 200 / 正确 | 3 | 1.29s |
| zhipu | glm-5.3-flash | high | `{"reasoning_effort":"high"}` | 200 / 正确 | 11 | 1.36s |
| zhipu | glm-5.3-flash | max | `{"reasoning_effort":"max"}` | 200 / 正确 | 80 | 1.59s |
| zhipu | glm-5.3-flash | off | 未发请求 | 本地拒绝（预期） | 0 | 0.00s |
| aicore | gpt-5.6-sol | low | `{"reasoning_effort":"low"}` | 200 / 正确 | 35 | 5.11s |
| aicore | gpt-5.6-sol | high | `{"reasoning_effort":"high"}` | 200 / 正确 | 34 | 3.21s |
| aicore | gpt-5.6-sol | off | `{"reasoning_effort":"none"}` | 200 / 正确 | 0 | 1.91s |
| aicore | claude-opus-5 | default | 无 | 200 / 正确 | 0 | 4.40s |
| aicore | claude-opus-5 | high | `{"reasoning_effort":"high"}` | 200 / 正确 | 0 | 2.69s |
| aicore | claude-opus-5 | off | `{"reasoning_effort":"none"}` | 200 / 正确 | 0 | 2.84s |
| aicore | gpt-5.6-luna | default | 无 | 200 / 正确 | 0 | 9.14s |
| aicore | claude-fable-5-1 | default | 无 | 200 / 正确 | 0 | 3.30s |
| aicore | gpt-5.6-sol | medium | `{"reasoning_effort":"medium"}` | 200 / 正确 | 45 | 3.36s |
| aicore | gpt-5.6-sol | xhigh | `{"reasoning_effort":"xhigh"}` | 200 / 正确 | 45 | 3.69s |
| aicore | gpt-5.6-sol | max | `{"reasoning_effort":"max"}` | 200 / 正确 | 45 | 3.73s |
| aicore | claude-opus-5 | medium | `{"reasoning_effort":"medium"}` | 200 / 正确 | 0 | 2.90s |
| aicore | claude-opus-5 | xhigh | `{"reasoning_effort":"xhigh"}` | 200 / 正确 | 0 | 2.53s |
| aicore | claude-opus-5 | max | `{"reasoning_effort":"max"}` | 200 / 正确 | 0 | 7.36s |

## 工具调用和历史回放

三家均使用 Low 档位，第一轮请求 `lookup_test_value`，本地提供固定结果 `PD_ACCEPTANCE_628`，第二轮要求模型返回该值。只模拟纯数据工具，不执行外部操作。

| 供应商 / 模型 | 工具参数正确 | 工具结果回传 | 原生思考历史回传 | 最终答案 |
| --- | --- | --- | --- | --- |
| HXAPI / qwen3.8-27b | 是 | 是 | 是 | 正确 |
| aicore / claude-opus-5 | 是 | 是 | 首轮未返回思考内容，无需回传 | 正确 |
| zhipu / glm-5.3-flash | 是 | 是 | 首轮未返回思考内容，无需回传 | 正确 |

## 浏览器端到端验收

使用独立浏览器测试页，留下验收会话“PilotDeck 计算 23×17”。

1. Qwen 3.8 选择 `低(Low)`：菜单自动收起，按钮显示“低”，真实回答 391；刷新后仍为 Low。
2. 切换 GLM 5.3 Flash 的 `最高(Max)`：引用上一轮结果加 9，回答 400。
3. 切换 aicore GPT 5.6 Sol（未配置思考强度）：按钮不残留 Max；引用历史除以 8，回答 50。
4. 切回 Qwen 并选择 `默认(Default)`：菜单收起，回答 42；刷新后仍为“默认”，未恢复旧 Low。
5. 设置弹窗：思考模式与关闭思考互斥；两者不选时显示服务端默认说明；图片输入保持独立；取消后原思考状态和已勾选档位恢复。
6. 设置弹窗和聊天档位菜单均无温度调节控件。

本轮中文交互实测通过。英文 Xhigh/Max 标签及鼠标、键盘选择收起行为已在此提交部署前验证；本轮未重复切换语言。

## 自动化覆盖

后端 111 项：模型请求构建、协议参数映射、关闭/默认/未配置档位、旧字段过滤、流式思考解析、工具回放、模型选择保存与恢复、默认覆盖和错误处理等。

前端 62 项（8 个文件）：模型选择 hook、能力枚举、菜单布局、模型设置弹窗、供应商和模型列表、WebSocket 模型配置与记忆状态同步。

## 实测边界与注意事项

- **默认不等于关闭。** Qwen 3.8 和 GLM 在无 effort 参数时仍返回思考内容；其他模型是否暴露思考内容取决于接口。
- **关闭的实际观测：** HXAPI Qwen 3.8、已配置关闭的 Qwen 3.6-27b，以及 aicore GPT 5.6 Sol，发送 `reasoning_effort: none` 后没有返回思考片段。该观测不是对服务端内部计算过程的证明。
- **Claude 中转的 effort 效果未证实：** aicore Claude Opus 的默认、开启不同档位及关闭请求均被接受，但都未返回可见思考。可能是接口隐藏思考或忽略/转换参数；本轮无法区分，不应把 HTTP 200 当作档位真实生效的证明。
- GPT、Qwen、GLM 的档位兼容性通过，但短算术题不足以验证五档质量/耗时的统计差异；未做长任务基准测试。
- 未测试图片识别、其他供应商、并发压力、长上下文压缩、真实外部工具执行或完整业务回归。
- 浏览器对话会触发正常的上下文与辅助请求；33 次仅统计直接运行时验收请求，不含这 4 轮聊天的辅助用量。

## 本地证据

脱敏请求记录与测试日志保存在 `/tmp/pilotdeck-reasoning-acceptance/`，包括 `results.jsonl`、`extended-results.jsonl`、`roundtrip.jsonl`、`regression.log` 和 `ui-tests.log`。该临时目录可能被系统清理。
