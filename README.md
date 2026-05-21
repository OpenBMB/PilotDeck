### 基于 WorkSpace 的开源智能体操作系统

    

**简体中文**  |  **[English](./README-en.md)**

---

## 💡 关于 PilotDeck

**PilotDeck** 是一个以「WorkSpace（工作舱）」为核心设计的开源智能体操作系统，由清华大学 [THUNLP](https://nlp.csai.tsinghua.edu.cn/) 实验室、[面壁智能](https://modelbest.cn/)、[OpenBMB](https://www.openbmb.cn/) 与 AI9stars 联合研发并开源，面向通用场景、适用于多任务，是 Agent 时代一个真正的「生产力工具」。

当前 AI Agent Harness 领域已涌现出一批优秀的代表成果，各有侧重：**Claude Code / Cursor / Trae Solo** 把模型的推理能力深度集成进了编程 IDE；**Claude Cowork** 引入了项目隔离的概念，把 Agent 带到了桌面端的知识工作场景；**WorkBuddy** 打通了 IM 生态，让 AI 在企微 / 飞书等通讯工具中触手可及。

然而，当我们把视角从“单次编程”或“即时问答”切换到**长周期、多项目并行的生产力创作**时，仍有一些尚未被很好回答的问题：

- 多项目并行时，记忆能否做到 **白盒可追溯**？AI 记错了，能否定位到哪条记忆出错、直接修改，而不必重开会话？
- Token 成本能否 **按任务分项追踪**？让后台常驻推进变得经济可行？
- 不同难度的任务，能否 **自动匹配不同模型**？而不是简单任务也跑最贵的旗舰模型？
- 人离开电脑后，活能否继续推进？Agent 能否 **主动发现值得做的事、汇报进展、把成果落地为文件**？

PilotDeck 正是围绕这些问题做的增量探索。它以 WorkSpace 为基本单位，将文件、记忆、技能在项目级别完整隔离与沉淀，并配套提供 **白盒记忆**、**智能路由**、**Always-on** 三大能力，整套系统原生支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)，跨前端（Web / CLI / IM）行为一致。

### ✨ 核心亮点

**📦 WorkSpace 级隔离与沉淀**

**项目制工作舱**：每个项目拥有独立的专属文件系统、记忆库与技能集。多任务并行互不干扰，检索空间有边界，技能随任务自动沉淀，告别全局上下文污染。

**🧠 可追溯的白盒记忆**

**透明可控**：记忆的生成、抽取、存储与使用全链路可见。AI 记错时可直接定位并手动修改。内置 **Dream 模式**，利用空闲时间自动归纳整理，并支持一键回滚。

**⚡ 智能路由与成本优化**

**动态模型调度**：内置任务难度识别，复杂任务调用强力模型（如 Claude 3.5 Sonnet / GPT-4o），简单任务降级至轻量模型。通过端云协同与精准匹配，大幅降低 Token 消耗。

**🌙 Always-on 常驻执行**

**后台持续推进**：突破“你问我答”的限制。用户离开后，Agent 仍能在后台主动发现潜在任务、执行长周期监控、并最终将成果落地为本地文件与摘要汇报。

### 📊 核心能力实测数据

PilotDeck 的三大核心能力在实际生产环境中展现出了显著的优势：

#### 1. 智能路由：社媒场景节省 ～70% 成本

在小红书等社媒运营场景中，开启智能路由后，系统会自动将简单的文本润色、排版任务降级给子 Agent（如 Sonnet 4.5），仅在核心规划节点使用 Opus 4.5，实测成本大幅下降：


| 方案对比          | 模型方案                         | 费用        | 倍率       |
| ------------- | ---------------------------- | --------- | -------- |
| **🟢 开启省钱路由** | 主 Opus 4.5 + 子 Sonnet 4.5 编排 | **$2.83** | **1.1x** |
| ⚪ 不开省钱路由      | 全 Opus 4.5 编排 (主+子)          | $12.58    | 5.0x     |
| ⚪ 单体大模型       | 单体 Opus 4.5 长 react（预估）      | $12.20    | 4.8x     |


#### 2. 智能路由：复杂任务 1/6 成本超越顶级模型

研究团队在播客多语言推送、多源数据报告、领域论文综述、代码库架构文档等 7 个复杂任务上进行了对比测试。结果表明，采用“主强子弱”的路由编排，能以极低的成本达到最优效果：


| Setting                                   | 得分       | 成本        |
| ----------------------------------------- | -------- | --------- |
| MiniMax-M2.7 单 Agent                      | 37.1     | $1.90     |
| Claude Sonnet 4.6 单 Agent                 | 69.1     | $18.36    |
| **🟢 主 Claude Sonnet 4.6，子 MiniMax-M2.7** | **70.6** | **$3.15** |


#### 3. 白盒记忆：排版与文风不再“串台”

在传统的黑盒 Agent 中，多任务混居会导致记忆全局污染。PilotDeck 通过 WorkSpace 实现了记忆的白盒化管理：


| 记忆维度        | 现有 AI Agent（黑盒）           | PilotDeck（白盒）                           |
| ----------- | ------------------------- | --------------------------------------- |
| **记忆可见性**   | 用户看不到 AI 记住了什么，只能看到最终输出   | 随时查看 AI 记住了哪些内容、何时记录的、属于哪个 WorkSpace    |
| **记忆可控性**   | 写入后无法修改、删除，只能等 AI 自己“想明白” | 可手动修改、删除记忆条目，标记关键节点，重要决策不丢失             |
| **记忆可追溯性**  | 出错时无法定位根本原因               | 生成 → 抽取 → 存储 → 使用，每个环节可查可改              |
| **记忆隔离性**   | 共享一个记忆池，跨项目互相污染           | 按 WorkSpace 隔离，A 项目的记忆不会跑到 B 项目，检索空间有边界 |
| **整理/压缩可逆** | 上下文压缩后无法查看原始内容            | Dream 整理后支持**一键回滚**到整理前状态，不怕“越整理越乱”     |


---

## 🖥️ 交互界面与演示

PilotDeck 提供了开箱即用的 Web UI，支持完整的 WorkSpace 管理、白盒记忆编辑、以及多智能体协作过程的可视化。

### 使用场景

> *"调研一下中国大模型应用市场，整理成一份正式的 HTML 白皮书"*







> *"用 Vibe Coding 模式陪我做一款 iOS AR 小游戏《找球球》"*







> *"从零造一个 Embedding 低代码调优平台"*







> *"把这期英文播客推送给中日法韩西阿六语全球受众"*







---

## 📦 安装与快速开始

我们提供了 macOS/Linux 下的一键安装脚本，以及适合开发者的源码启动方式。

### 方式一：一键安装 (推荐, macOS/Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Gucc111/PilotDeck/main/install.sh | bash
```

该脚本将自动配置 Node.js 22 环境、克隆代码、安装依赖并编译前端。安装完成后，直接运行：

```bash
pilotdeck            # 在 http://localhost:3001 启动服务
pilotdeck status     # 查看运行状态
```

### 方式二：源码启动 (适合开发者)

**1. 克隆代码与安装依赖**

```bash
git clone https://github.com/Gucc111/PilotDeck.git
cd PilotDeck

npm install              # 安装根目录依赖 (Gateway 运行时)
cd ui && npm install     # 安装 UI 依赖
cd ..
```

**2. 配置模型 Provider**
PilotDeck 依赖 `~/.pilotdeck/pilotdeck.yaml` 进行配置。您可以手动创建、运行启动脚本自动生成，**或者在启动 Web UI 后直接在设置界面中进行可视化配置**。
支持 OpenAI、Anthropic、DeepSeek、Qwen、Kimi、MiniMax 等多种协议。

```yaml
schemaVersion: 1
agent:
  model: deepseek/deepseek-v4-pro
model:
  providers:
    deepseek:
      protocol: openai
      url: https://api.deepseek.com/v1
      apiKey: sk-your-api-key
```

**3. 启动服务**

```bash
cd ui && npm run dev     # 开发模式 (HMR)，访问 http://localhost:5173
# 或
cd ui && npm run start   # 生产模式，访问 http://localhost:3001
```

### 🍎 桌面端 App (Apple Silicon)

对于 macOS 用户，我们提供了签名并经过 Apple 公证的 DMG 安装包，无需配置命令行环境即可双击运行。
详细构建与发布指南请参考 [apps/desktop/RELEASING.md](apps/desktop/RELEASING.md)。

---

## 🛠️ 扩展与插件 (Extension Protocol)

PilotDeck 采用开放的插件架构，插件代码与开源核心严格隔离。开发者可以通过 `plugin.json` 轻松扩展系统能力：

- **MCP Servers**: 原生支持集成 Model Context Protocol 服务器。
- **Tools & Skills**: 注册自定义工具，或通过 [ClawHub](https://www.npmjs.com/package/clawhub) 引入社区 Skill。
- **Lifecycle Hooks**: 拦截 `PreToolUse`、`UserPromptSubmit` 等关键生命周期。
- **Custom Memory**: 允许接入自定义的记忆存储 Provider。

---

## 🤝 参与贡献

感谢所有为 PilotDeck 提交代码与反馈的开发者！我们欢迎新的成员加入，共同构建下一代智能体操作系统。

贡献流程：**Fork 本仓库 → 创建 Feature 分支 → 提交 PR**。
提交前请确保通过了单元测试与 Linter 检查：

```bash
npm test
cd ui && npx vitest run
```

---

## 💬 联系我们

- 关于技术问题及功能请求，请提交 [GitHub Issues](https://github.com/Gucc111/PilotDeck/issues)。
- 商务合作、企业级支持或开源 License 讨论，请邮件联系：`team@pilotdeck.ai` 。
- 欢迎加入我们的社区与我们交流：


|           |           |                |
| --------- | --------- | -------------- |
| **微信交流群** | **飞书交流群** | **Discord 社区** |


---

## 🏢 联合研发

              

---

## ⭐ 支持我们

如果您觉得 PilotDeck 对您的工作或研究有帮助，请点亮一颗 ⭐ 支持我们！

---

## 📝 引用

```bibtex
@misc{pilotdeck2026,
  title  = {PilotDeck: A WorkSpace-Centric Open-Source Agent Operating System},
  author = {THUNLP and ModelBest and OpenBMB and AI9stars},
  year   = {2026},
  note   = {Live demo: http://58.57.119.12:52006/},
  url    = {https://github.com/Gucc111/PilotDeck}
}
```

## 📄 许可证

本项目开源许可证 **待定 (TBD)**。在正式 License 落地前，核心代码视作 "source-available, all rights reserved"。`products/`** 目录存放客户专属定制代码，不包含在开源发布范围内。