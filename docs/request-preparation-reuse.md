# 单次模型调用内复用请求准备与 token 估算（#688）

本次优化只在当前模型调用尝试内复用上下文快照、文本请求体和本地 token 估算。
每次工具执行后的下一轮、重试和后续用户消息都会建立新作用域。
压缩阈值、输出预留、压缩策略、供应商计数缓存及路由用量校准规则保持原有逻辑。

## 实现与失效条件

- `AgentLoop` 为每次模型调用创建准备结果容器和本地计数 Map。预算检查和正式发送共享它们。
- `DefaultContextRuntime.reusePreparedContext` 核对准备参数、历史、工具、会话状态、UTC 日期、扩展提示词和项目规则。
  预览不提交时间或缓存状态；正式采用时才提交，并消费一次待执行缓存重置。
- 完整压缩的新 checkpoint 如果需要刷新系统日期，正式采用会回退到原来的完整准备路径。
  废弃候选不会改变会话状态。
- 异步规则校验结束后再次确认正式采用的输入和取消信号；校验过程中输入改变或被取消，
  不会提交旧预览。记忆检索失败的预览也不复用，保留正式准备时重试的机会。
- 正式采用时保留项目规则重读，覆盖规则新增、修改、删除；因此规则发现次数在普通场景仍为两次。
  这次校验不会重放完整历史投影和记忆检索。
- 没有文件媒体引用的请求可直接复用已整理的消息体。计划模式提醒仍只添加一次。
  文件媒体在 `InstructionsLoaded` 之后重新读取，避免检查和发送之间文件变化造成旧内容复用。
- 本地计数按实际参与估算的消息、系统提示词和工具定义生成内容指纹。
  路由只改变上下文容量时复用本地计数，再计算预算；实际输入变化时重新分词。
  供应商计数与校准仍按供应商和模型分别处理，输出预留也会重新计算。
- 路由后的首轮检查直接评估已经准备好的实际请求；仅历史变化的压缩候选需要重新准备。
- 没有提供快照复用能力的其他 ContextRuntime 实现继续使用完整准备路径。

## 验证

使用 Node.js `v22.23.4`，在 Apple Silicon Mac（darwin/arm64）验证：

- `npm run build`、`npm run build:web`：通过。
- context、agent/loop、session、router、model 回归：394 项通过，0 失败。
- `npm run test:checkpoints`：78 项通过，0 失败；其中部分与上述 session 测试重叠。
- Web CI 同范围 Vitest 回归（2 个 worker）：248 个文件、2,199 项测试通过。
- `git diff --check`：通过。

全量后端检查使用 `--test-concurrency 4 --test-force-exit --test-timeout 60000`：
920 项中 911 通过、0 失败、7 取消、2 跳过，退出码为 1，因此不标记为全量全绿。
7 项取消全部来自 `tests/network/fetch.spec.ts` 的未引用计时器；对未修改的
`5862db79` 单独执行同一编译后测试文件，复现完全相同的 7 个取消名称与
`Promise resolution is still pending but the event loop has already resolved` 原因。
一次有其他检查并行的全量运行还触发了原有 FunASR 约 1 秒 MCP 响应超时；
该文件单独复跑 2/2 通过，无其他检查并行时再次全量运行未复现该超时。
此 PR 不修改这两处独立测试或网络计时器实现。

新增 24 项测试，涵盖请求体复用、正式采用只提交一次、规则及工具变化、路由变换、
用量校准、废弃及采用压缩候选、完整压缩刷新日期、跨日通知、待执行缓存重置、
异步准备期间另一请求提交、校验期间输入变化或新信号取消、失败记忆检索重试、
工具循环、计划模式及文件媒体重新读取。最后三项边界测试均先复现失败，再验证修复。

回归时还发现一个已有测试断言过时：OpenAI Responses 的函数工具序列化已明确使用
`strict: false`，但 token 计数端点测试仍期待 `true`。在未修改的基线 `5862db79`
复现相同失败后，同步了这个断言，没有改动序列化实现。

回归命令（先让 Node.js 22 位于 PATH）：

```sh
npm run build
node --test --test-force-exit --test-timeout 60000 \
  'dist/tests/context/**/*.spec.js' \
  'dist/tests/agent/loop/**/*.spec.js' \
  'dist/tests/session/**/*.spec.js' \
  'dist/tests/router/**/*.spec.js' \
  'dist/tests/model/**/*.spec.js'
npm run test:checkpoints
pnpm --dir ui exec vitest run --maxWorkers 2 \
  --exclude 'e2e/**' \
  --exclude 'src/components/chat/hooks/streamSmoother.test.ts' \
  --exclude 'server/services/desktopUpdateNetwork.test.ts' \
  --exclude 'server/services/desktopUpdates.spec.ts'
git diff --check
```

## 优化前后实测

最终基线为上游 `main` 的 `5862db79`。本 PR 不包含 #687 / PR #701 的提交，
请求准备与工作区保护优化可以独立审查、合并。
两个实现使用同一个 `scripts/benchmark-request-preparation.ts`、固定生成的源码文本、
相同的临时工作目录和项目规则路径、30 个工具定义、约 5 KiB 项目规则。
前后每组输入 token 数完全一致。

基准运行真实的 AgentLoop、DefaultContextRuntime、InstructionDiscovery、TokenAccountingRuntime、
TokenBudgetManager 和 AutoCompactionPolicy；记忆检索与模型立即返回，无网络调用，
不执行工作区检查点或产物扫描。上下文上限固定为 2M token，路由场景切到 1M，
保证所有样本不触发压缩。分词器预热，每组 25 次，丢弃第 1 次，取其余 24 次中位数。
共采集前后 200 个样本。扩大采样以减少几毫秒级短请求受启动和调度抖动的影响。

测量从进入 `loop.run` 到进入 `router.execute` 的本地耗时：

| 输入 token | 场景 | 优化前 | 优化后 | 耗时降低 |
| ---: | --- | ---: | ---: | ---: |
| 3,845 | 普通调用 | 3.983 ms | 2.680 ms | 32.7% |
| 20,894 | 普通调用 | 16.417 ms | 9.591 ms | 41.6% |
| 144,726 | 普通调用 | 105.338 ms | 60.460 ms | 42.6% |
| 20,894 | 路由改变上下文容量 | 24.267 ms | 10.545 ms | 56.5% |

所有优化后样本的完整上下文准备、本地全文分词和记忆检索均为一次：

| 计数 | 普通调用（前 → 后） | 路由场景（前 → 后） |
| --- | --- | --- |
| 完整上下文准备 | 2 → 1 | 3 → 1 |
| 本地全文分词 | 2 → 1 | 3 → 1 |
| 记忆检索调用 | 2 → 1 | 3 → 1 |
| 项目规则发现/校验 | 2 → 2 | 3 → 2 |

这是本地准备耗时的改善，不包含网络与模型推理，也不是端到端首 token 加速比例。
短输入仍有指纹、规则和状态校验等固定开销，因此降低幅度小于长输入。
不同文本、设备和真实记忆服务会有不同结果。

原始数据：[优化前](benchmarks/request-preparation-before.json)、[优化后](benchmarks/request-preparation-after.json)。

复现时对基线和修改后的实现分别执行（`--fixture` 必须是不存在的专用临时路径，脚本结束会清理）：

```sh
node --import tsx scripts/benchmark-request-preparation.ts \
  --implementation-root /absolute/path/to/baseline-checkout \
  --fixture /tmp/pilotdeck-688-comparison-fixture \
  --runs 25 --output /tmp/request-preparation-before.json

node --import tsx scripts/benchmark-request-preparation.ts \
  --fixture /tmp/pilotdeck-688-comparison-fixture \
  --runs 25 --output /tmp/request-preparation-after.json
```

基线 checkout 需要可以解析相同依赖。基准脚本从修改后的工作区启动，再通过
`--implementation-root` 加载被测实现，因此不会要求基线本身已有这个新脚本。
