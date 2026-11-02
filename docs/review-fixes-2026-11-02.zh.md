# PR #721 review 修复记录

基线：`61ee3a11`。本轮不调整配置格式，不修改用户数据，不降低 CI、CodeQL 或已有测试断言。

## 五项 review 问题

| 问题 | 已确认的失败与修复 | 验证 |
| --- | --- | --- |
| Docker 缺少新增工作区和启动源码 | 原 Docker 日志报 `@pilotdeck/config` 无法解析。构建前复制该包，运行层保留 pnpm 工作区链接目标；将 `appearance`、`startupPresentation`、`startupStyle` 纳入构建上下文和 COPY 清单。 | PR Docker job 增加加载实际镜像后导入共享包与 Web 日志 bootstrap 的检查，使用生产启动相同的 tsx loader。 |
| 隔离 Electron 夹具缺少新依赖 | Windows/macOS 日志均在 `runtimeDiagnostics.js` 导入共享包时退出。补齐实际包、运行端 YAML、Windows 原生进程辅助源码，以及卸载数据辅助脚本。 | 临时目录模块隔离测试通过；Windows 实际 Electron 的 normal、notification-badge、slow-quit、startup-quit、stop-failure、update、update-recovery 七个场景通过。 |
| Linux 卸载动作未声明 | DEB/RPM 的 launcher 校验报动作分组没有匹配的 `Actions`。在主 desktop entry 加入 `Actions=Uninstall;`，保留中英文名称。 | 使用安装的 electron-builder 实际生成 desktop entry，逐项验证动作声明与分组对应。 |
| OOM 分类正则可发生慢匹配 | `FATAL ERROR:` 重复 30000 次，原实现超过 2 秒被子进程超时终止。改为逐行固定字符串查找。 | 对抗测试、大小写和同行顺序测试通过。 |
| 进程失败分类正则可发生慢匹配 | `process` 重复 30000 次，原实现同样超过 2 秒。移除非锚定的 `process.*failed`。 | 两组恶意重复输入合计约 0.1 秒完成，仍保留分类结果与跨行限制。 |

Docker 的忽略规则会直接决定 COPY 可访问的文件，依据 [Docker build context 文档](https://docs.docker.com/build/concepts/context/#dockerignore-files) 保留所需源码。Linux 动作声明依据 [Desktop Entry Specification](https://specifications.freedesktop.org/desktop-entry/latest/extra-actions.html)：动作分组必须在主 `Actions` 中列出。

## 其余 CodeQL 告警

- 历史目录：目录扫描增加 PilotHome/projects 范围、层级和 canonical path 检查，拒绝工作区/聊天目录链接到存储范围之外；文件属性使用 lstat，不跟随文件链接。测试覆盖相邻路径、`..` 路径和跨目录 junction/symlink，同时保留旧版冲突项目目录。
- 启动预览：改用单独测试的 inline JSON 序列化，实际输出反斜杠 Unicode 转义。测试包含混合大小写的关闭 script 标签，确认没有字面量 `<` 且能恢复原始日志路径。
- 启动基准：将动态拼接生成的 Electron 包装源码改为静态夹具，标题、文件路径、OOM 参数通过 JSON 环境数据传入。测试覆盖引号、script 风格标题、Windows/POSIX 路径及只针对 Gateway 的内存参数注入。
- HTML 测试：不再用正则模拟 HTML 过滤，直接提取自己生成的固定模板脚本；该测试不是产品中的 HTML 消毒器。

这里补强的是历史存储根目录边界；读取过程中本机进程同时替换文件的全部竞态不属于本轮的隔离保证。没有将未经证实的告警描述为已被利用的漏洞。

## 本地验证

- 桌面 helper 全套：218 项，209 通过、9 项按平台跳过，无失败。
- 共享诊断、日志、隔离依赖、启动展示及 inline JSON 聚焦组：22 项通过（与桌面全套部分重叠）。
- 历史目录、项目预览和无模型历史：16 项通过。
- 核心和 Electron TypeScript 编译通过。
- Windows 真实 Electron 七个生命周期/恢复场景通过，使用临时 app/profile 和合成运行时，没有操作正式用户实例。
- 加入 canonical path 检查后的 1000 会话列表基准约 209–269 毫秒，未恢复对全部会话正文的依赖；测试与桌面 helper 同时运行，不能据此比较几十毫秒差异。

当前 Windows 主机没有 Docker 引擎和可用 WSL 发行版，因此完整镜像构建、Linux 已安装 launcher 校验、macOS/ARM64 实机结果以本轮 PR CI 为准，不用本地单元测试代替。推送后检查全部八个桌面 job、Docker 与 CodeQL 的新结果。

原始本地日志保存在忽略的 `artifacts/review-fixes-2026-11-02/`。未纳入原先无关的图标修改、输出目录和脚本。
