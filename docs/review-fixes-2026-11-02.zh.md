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

## 跟进 CI 暴露的后续问题及进度条反馈

第一轮修复提交 `002af441` 后，Docker 实际镜像构建及 bootstrap 导入、Checks、三个平台的 Checkpoints 均通过，macOS arm64 也通过了完整打包。继续运行的任务还暴露出以下问题，已继续修复：

- Windows 的完整 NSIS 端到端夹具使用默认的全部语言，而产品仅支持英文和简体中文，导致其他语言缺少自定义 LangString，触发 warning 6040。夹具现在直接采用产品 `installerLanguages`，保留编译器警告检查。
- CodeQL 七项告警降到一项，剩余项位于 canonical path 校验之前的 realpath 参数。现在从可信存储根目录及 basename 项目分量构造操作路径，并在 filesystem 调用前直接检查范围，随后仍验证 canonical 路径和目录层级。没有抑制或豁免告警，处理方式参考 [CodeQL 路径注入说明](https://codeql.github.com/codeql-query-help/javascript/js-path-injection/)。
- Linux 后续 UI 夹具加载超时在 Windows 也能稳定复现：真实 preload 新增了同步启动状态读取，但旧测试宿主没有对应 IPC handler。补齐后导航恢复；完整界面测试随后发现 `display: contents` 启动包装层仍改变 DOM 父子层级，导致首次配置页的 desktop CSS 失效。改为保留原页面层级，通过 root 上的临时状态及 inert 管理交互，转场后清理。新增回归断言各阶段都保留同一页面节点及其父层级。

用户进一步反馈安装进度“一卡一卡”。提取进度原来被一秒一次的文字/ETA 更新节流，进度控件又强制使用经典样式。现在进度按解码器更新及时发送，文字日志仍限频；累计进度控件继承原生控件样式、扩展样式及主题，不强制颜色。卸载页移除额外的控件样式覆盖，使用 NSIS 原生进度。行为依据 [Windows Progress Bar 控件文档](https://learn.microsoft.com/en-us/windows/win32/controls/progress-bar-control-styles)。没有加入与实际安装量无关的虚构百分比。

后续本地验证：

- 完整 Windows NSIS 静默安装、交互覆盖/升级、两类取消、拒绝/批准移动和卸载通过；增加原生样式和主题一致性断言，同一解码器测试中的可观察进度更新约由 8–9 次提高到 17 次。
- 安装事务、回滚、损坏归档、Unicode 路径、暂时锁定和组件保留测试通过；安装/卸载脚本编译通过。
- 冷缓存 Vite + 真实 Electron 的完整桌面 chrome 测试通过，未调整超时或布局断言；启动组件相关 34 项回归通过。
- 核心历史回归 25 项通过，目录边界/无模型历史回归通过。

完整新一轮 CI 和最终安装包仍须使用最新提交验证，不以 `002af441` 的部分成功替代最新结果。

`91387368` 的 CodeQL 门禁已成功且注解为 0；Web、Docker、Checks 和三个平台的 Checkpoints 成功。DEB arm64 也通过完整图形测试；RPM 图形夹具随后在首次配置页测量中遇到 7–8 像素的暂态溢出。夹具现在等待启动遮罩释放、字体准备及两帧绘制后再测量，并在失败时记录矩形与动画状态。原有一像素容差、尺寸断言和超时均保留，没有通过放宽断言来通过 CI。这一跟进仅调整测试同步，不改变安装包运行代码。
