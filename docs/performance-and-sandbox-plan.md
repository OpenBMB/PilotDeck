# 性能优化与 Rust 实现方案

> 基于当前 `main` 分支（2026-11-23）核心运行时实现整理。核心原则：**执行速度的主要矛盾在架构不在语言**——重复计算靠缓存、同步阻塞移出事件循环、冷启动靠后台预热；Rust（`napi-rs`）聚焦内核级安全 Sandbox 与高收益算力加速层，不做全量重写。

---

## 1. 总体策略与结论

| 候选项 | 状态 | 结论与理由 |
| --- | --- | --- |
| **P0 TS 侧性能优化（缓存 / Worker / 预热）** | **已实现** | 性价比最高，已落地 Token LRU 缓存、检查点 `worker_threads` 池、Python/MCP 后台预热 |
| **Rust Sandbox（`packages/native-sandbox`）** | **已实现骨架（Windows Job Object）** | 安全能力缺口（Node 生态无内核级进程/权限隔离）；TS 侧已完成接线与优雅降级 |
| **P0 #5 `executeCode` Python 进程池** | **TODO** | 每次 `spawn(python)` 开销 100–300ms，但需处理跨调用状态污染隔离 |
| **P1 Rust `napi` 加速层（`packages/native`）** | **TODO** | 在 P0 效果经度量确认仍有算力瓶颈时启动（`tiktoken-rs` 批处理 / 并行扫描） |
| **全量 Rust 重写 / 换 Tauri** | **不做** | Gateway/流式/存储均为 I/O 等待，重写收益极低且引入过高风险 |

---

## 2. 性能优化（已实现与机制）

### 2.1 Token 计数前缀缓存（已实现）
- **位置**：`src/context/budget/tokenizer.ts`、`tests/context/tokenizer.spec.ts`
- **解决痛点**：`TokenBudgetManager`、`SnipEngine`、`TokenAccountingRuntime` 每回合都会反复对未变更的历史消息调用 `js-tiktoken` 的纯 JS BPE `encode()`。
- **实现方案**：
  - 在 `countTokens(text)` 内置容量上限为 `4096` 的有界 LRU 缓存；
  - 短文本（`<= 256` 字符）直接以原文为 key；长文本（`> 256` 字符）使用 `${length}:${sha256}` 定长 key，避免缓存持有大字符串引用导致内存滞留；
  - 所有上层调用方无需修改签名即可自动命中缓存。

### 2.2 检查点扫描移出事件循环（已实现）
- **位置**：`src/session/checkpoints/checkpointWorkerPool.ts`、`src/session/checkpoints/WorkspaceCheckpoints.ts`、`tests/session/workspace-checkpoints.spec.ts`
- **解决痛点**：`WorkspaceCheckpoints.capture()` 原先在主线程串行读取文件并计算 SHA-256，大工作区下会阻塞流式输出与其他会话响应。
- **实现方案**：
  - 实现基于 `node:worker_threads` 的并行捕获池（并发度 `min(4, max(2, cpus - 1))`，内嵌纯 JS Worker 脚本以兼容源码直跑与编译产物；`unref()` + 10s 空闲自动回收避免阻塞进程退出）；
  - `capture()` 收集候选文件后，文件数 `< 16` 走主线程直连路径；`>= 16` 时按每批 `16` 个文件分发至 Worker 池并行执行 `lstat` 一致性校验、文件读取、SHA-256 计算、二进制检测与 `objects/<hash>` 原子写盘；
  - 完整保留 `EXCLUDED`、`.git` 排除、symlink 安全校验及 `MAX_WORKSPACE_BYTES`（256 MB）预算截断。

### 2.3 Python Runtime 与共享 MCP 预热（已实现）
- **位置**：`src/cli/createLocalGateway.ts`（`ProjectRuntimeRegistry.prewarm`）
- **解决痛点**：原本直到首个会话创建时才惰性触发 `python.resolve()` 与 `ensureMcpReady()`，导致首回合等待数秒。
- **实现方案**：
  - `createLocalGateway()` 解析默认项目运行时后，通过 `setImmediate(...).unref()` 在后台异步预热 Python 环境与共享 MCP Server；
  - 与 `prepareLeasedSessionRuntime()` 共享同一幂等 Promise，避免重复初始化；`shutdown()` 置位 `disposed` 标志安全中止并清理资源（支持 `PILOTDECK_DISABLE_PREWARM=1` 禁用）。

---

## 3. Rust 部分实现：`packages/native-sandbox`

### 3.1 现状与设计目标
当前 `NodeShellCommandRunner`（`src/tool/builtin/bash/commandRunner.ts`）直接 `spawn` 子进程且在 Windows 超时时依赖外部 `taskkill`。Rust 沙箱模块旨在提供内核级执行边界与高性能进程树管理，并在原生模块不可用时无缝回退。

### 3.2 已实现结构与文件清单
```text
packages/native-sandbox/
├── Cargo.toml                  # napi = "2" (napi4), napi-derive, windows-sys (JobObjects/Threading)
├── build.rs                    # napi-build setup
├── package.json                # @pilotdeck/native-sandbox
├── index.cjs                   # 按 platform-arch 加载 .node 产物
├── index.d.ts                  # TS 类型声明
├── scripts/build-native.mjs    # Cargo release 编译与产物拷贝脚本
└── src/
    ├── lib.rs                  # 导出 sandboxBackend / startSandboxed / killSandboxed
    ├── windows.rs              # Win32 Job Object 进程树绑定、原子终止与环境变量清洗
    └── unix.rs                 # macOS / Linux 最小占位（当前返回 unsupported）
```

- **TS 侧集成**：
  - `src/tool/builtin/bash/sandboxedCommandRunner.ts`：实现 `PilotDeckCommandRunner` 契约，接入 `startSandboxed` / `killSandboxed` 流式事件回调与超时/取消控制；原生不可用或返回 `unsupported` 时自动回退 `NodeShellCommandRunner`。
  - `src/cli/createLocalGateway.ts`：设置 `PILOTDECK_SANDBOX=1` 时向 `createBuiltinRegistry` 注入 `SandboxedCommandRunner`。
  - `tests/tool/sandboxed-command-runner.spec.ts`：验证流式输出、超时终止与自动回退逻辑（当前 3 例全过）。

### 3.3 当前构建限制
- 本机环境尚未安装 MSVC C++ Build Tools（缺少 `link.exe`），因此尚未在本地链接产出 `index.win32-x64.node`，运行时当前走 `NodeShellCommandRunner` 自动回退路径；安装 VS Build Tools 后在 `packages/native-sandbox/` 执行 `pnpm run build` 即可生成原生产物并激活 `"windows-job"` 后端。

---

## 4. 待办 TODO 清单（未实现优化与后续补全）

- [ ] **TODO (P0 #5)**：`executeCode`（`src/tool/builtin/executeCode.ts`）常驻 Python 解释器/进程池化与状态隔离，消减每次 100–300ms 启动开销。
- [ ] **TODO (P1 M1)**：`packages/native/` 基于 `tiktoken-rs` + `rayon` 实现 `count_tokens_batch`（`AsyncTask`），加速冷文本大批量分词。
- [ ] **TODO (P1 M2/M3)**：根据实测与业务需要评估是否将历史会话搜索与超大工作区检查点全盘扫描下沉至 Rust（`ignore` + `sha2` / `memchr` + `fancy-regex`）。
- [ ] **TODO (Sandbox Windows 增强)**：在 `packages/native-sandbox/src/windows.rs` 补全 AppContainer / Low-Integrity + 工作区 ACL 精细读写/网络隔离，并升级为 `CREATE_SUSPENDED` 挂起注入。
- [ ] **TODO (Sandbox Linux / macOS)**：在 `packages/native-sandbox/src/unix.rs` 补全 Linux `landlock` + `seccomp` 与 macOS `sandbox-exec` / Seatbelt 后端，返回对应后端标识。
- [ ] **TODO (分发与度量)**：为 `countTokens` / `capture` 补齐 `telemetry` 基线计时埋点；将 `@pilotdeck/native-sandbox` 各平台 `.node` 产物纳入 `apps/desktop/scripts/build-runtime.mjs` 打包矩阵并增加构建断言。
- [ ] **TODO (统一收敛 `executeCode`)**：将 `executeCode.ts` 的 Python 子进程执行也收敛至 `SandboxedCommandRunner` 边界。
