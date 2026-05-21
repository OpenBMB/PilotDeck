<p align="center">
  <!-- TODO[banner]: replace with PilotDeck logo or banner image (suggested 1600x400) -->
  <img src="docs/assets/banner.png" alt="PilotDeck Banner" width="80%">
</p>

<h3 align="center">
A WorkSpace-Centric Open-Source Agent Operating System
</h3>

<p align="center">
  <a href="https://jcst.ict.ac.cn/en/article/doi/10.1007/s11390-025-6000-0"><img src="https://img.shields.io/badge/Paper-JCST'26-blue?style=flat-square" alt="Paper"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-TBD-lightgrey.svg?style=flat-square" alt="License"/></a>
  <a href="http://58.57.119.12:52006/"><img src="https://img.shields.io/badge/Demo-Live-brightgreen?style=flat-square" alt="Live Demo"/></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-≥22-43853d.svg?style=flat-square" alt="Node"/></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-1.x-purple.svg?style=flat-square" alt="MCP"/></a>
  <a href="https://github.com/Gucc111/PilotDeck/stargazers"><img src="https://img.shields.io/github/stars/Gucc111/PilotDeck?style=flat-square" alt="Stars"/></a>
  <br/>
  <a href="#-community"><img src="https://img.shields.io/badge/WeChat-Community-07C160?style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"/></a>
  &nbsp;
  <a href="#-community"><img src="https://img.shields.io/badge/Feishu-Community-00D6B9?style=for-the-badge&logo=bytedance&logoColor=white" alt="Feishu"/></a>
  &nbsp;
  <a href="#-community"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"/></a>
</p>

<p align="center">
  <a href="./README.md"><b>简体中文</b></a> &nbsp;|&nbsp; <b>English</b>
</p>

---

## 💡 About PilotDeck

**PilotDeck** is an open-source agent operating system designed around the concept of "WorkSpace". It is jointly developed and open-sourced by Tsinghua University [THUNLP](https://nlp.csai.tsinghua.edu.cn/), [ModelBest](https://modelbest.cn/), [OpenBMB](https://www.openbmb.cn/), and AI9stars. Targeting general-purpose, multi-task scenarios, PilotDeck is built to be a true *productivity tool* for the Agent era.

A wave of excellent AI Agent harnesses has emerged in recent years, each with its own focus: **Claude Code / Cursor / Trae Solo** brought model reasoning deep into the programming IDE; **Claude Cowork** introduced the notion of project-level isolation to desktop-side knowledge work; **WorkBuddy** connected agents to IM ecosystems such as WeCom and Feishu so AI is one message away.

When we shift the lens from "one-shot programming" or "immediate Q&A" to **long-running, multi-project productivity work**, however, several questions remain open:

- When many projects run in parallel, can memory be **white-box and traceable**? When the AI gets something wrong, can you pinpoint which memory entry caused it and edit it directly — without starting a new chat from scratch?
- Can token cost be **tracked per task**, so that running agents in the background actually becomes economically viable?
- Can tasks of different difficulty **automatically be matched to different models**, instead of burning the flagship model on trivial calls?
- When you step away from the keyboard, can the work keep moving? Can the agent **proactively discover what's worth doing, report progress, and land results as files on disk**?

PilotDeck is an incremental exploration around exactly these questions. It uses the WorkSpace as the fundamental unit — completely isolating files, memory and skills per project — and pairs it with three pillar capabilities: **White-box Memory**, **Smart Routing** and **Always-on**. The entire system natively supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) and behaves consistently across front-ends (Web / CLI / IM).

<p align="center">
  <img alt="PilotDeck vs Others" src="docs/assets/competitor-comparison.png" width=90%>
</p>

### ✨ Key Highlights

<table>
<tr>
<td width="50%" valign="top">

**📦 WorkSpace-Level Isolation & Accretion**

**A pod per project.** Every project gets its own file system, memory store and skill set. Parallel work no longer interferes with itself, retrieval has a bounded scope, and skills accrete naturally as each task grows — no more global context pollution.

</td>
<td width="50%" valign="top">

**🧠 Traceable White-box Memory**

**Transparent and editable.** Memory generation, extraction, storage and retrieval are visible end-to-end. When the AI mis-remembers, you can pinpoint and fix the offending entry. Built-in **Dream Mode** consolidates memory in idle windows, and supports one-click rollback.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**⚡ Smart Routing & Cost Optimization**

**Dynamic model dispatch.** Task difficulty is auto-detected; complex calls go to flagship models (e.g. Claude 3.5 Sonnet / GPT-4o), simple ones drop to lighter models. Through on-device / cloud co-orchestration and precise matching, token spend shrinks dramatically without sacrificing quality.

</td>
<td width="50%" valign="top">

**🌙 Always-on Background Execution**

**Work keeps moving while you're away.** PilotDeck breaks the "you ask, it answers" loop: after you sign off, the agent keeps discovering candidate tasks, running long-horizon monitors, and finally lands deliverables as local files with a summary report waiting for you.

</td>
</tr>
</table>

### 📊 Real-world Numbers

The three pillar capabilities have shown clear advantages in production-grade workflows:

#### 1. Smart Routing — ~70% cost savings on social-media workloads

In Xiaohongshu-style social-media operations, enabling Smart Routing automatically demotes simple polishing / layout tasks to a sub-agent (e.g. Sonnet 4.5) and only invokes Opus 4.5 at planning checkpoints:

| Setup                          | Model configuration                                | Cost       | Multiplier |
| ------------------------------ | -------------------------------------------------- | ---------- | ---------- |
| **🟢 Smart Routing ON**         | Opus 4.5 (main) + Sonnet 4.5 (sub) orchestration   | **$2.83**  | **1.1x**   |
| ⚪ Smart Routing OFF            | All Opus 4.5 (main + sub)                          | $12.58     | 5.0x       |
| ⚪ Monolithic                   | Single Opus 4.5 long-react (estimated)             | $12.20     | 4.8x       |

#### 2. Smart Routing — 1/6 the cost while beating frontier models on hard tasks

The research team benchmarked 7 complex tasks (multilingual podcast push, multi-source data reports, domain-specific literature review, codebase architecture docs, etc.). The "strong main + light sub" routing setup matches or beats the frontier single-model setup at a fraction of the cost:

| Setting                                                | Score    | Cost       |
| ------------------------------------------------------ | -------- | ---------- |
| MiniMax-M2.7 single-agent                              | 37.1     | $1.90      |
| Claude Sonnet 4.6 single-agent                         | 69.1     | $18.36     |
| **🟢 Claude Sonnet 4.6 (main) + MiniMax-M2.7 (sub)**    | **70.6** | **$3.15**  |

#### 3. White-box Memory — layout & tone never bleed across projects

In black-box agents, mixing tasks in a shared context pool inevitably pollutes memory. PilotDeck's WorkSpace-scoped white-box memory addresses this end-to-end:

| Memory dimension          | Current AI Agents (black-box)                                  | PilotDeck (white-box)                                                       |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Visibility**            | You can't see what the AI remembers, only what it outputs       | View every memory entry: what was stored, when, and to which WorkSpace      |
| **Controllability**       | Once written, memory can't be edited or removed — you wait it out | Manually edit / delete entries, pin critical decisions so they don't drift  |
| **Traceability**          | When it goes wrong, you can't find the root cause               | Generation → extraction → storage → retrieval, every step is auditable      |
| **Isolation**             | One shared pool — projects bleed into each other                | Scoped per WorkSpace; A's memory never reaches B; retrieval is bounded      |
| **Reversible compaction** | After compression, the original is gone                          | Dream-mode consolidation supports **one-click rollback** to the prior state |

---

## 🖥️ UI & Demo

PilotDeck ships an out-of-the-box Web UI with full WorkSpace management, white-box memory editing, and visualization of multi-agent collaboration.

### Use Cases

<table>
<tr>
<td width="50%" valign="top">

> *"Survey the Chinese LLM application market and turn it into a formal HTML white paper."*

<!-- TODO[case-whitepaper]: replace with white-paper generation demo GIF -->
<img src="docs/assets/case-whitepaper.gif" width="100%"/>

</td>
<td width="50%" valign="top">

> *"Walk me through building an iOS AR mini-game *Ball Finder* in Vibe Coding mode."*

<!-- TODO[case-ios-ar]: replace with iOS AR development demo GIF -->
<img src="docs/assets/case-ios-ar.gif" width="100%"/>

</td>
</tr>
<tr>
<td width="50%" valign="top">

> *"Build a low-code embedding fine-tuning platform from scratch."*

<!-- TODO[case-embedding]: replace with embedding platform demo GIF -->
<img src="docs/assets/case-embedding.gif" width="100%"/>

</td>
<td width="50%" valign="top">

> *"Push this English podcast to a global audience in Chinese / Japanese / French / Korean / Spanish / Arabic."*

<!-- TODO[case-podcast]: replace with multilingual podcast push demo GIF -->
<img src="docs/assets/case-podcast.gif" width="100%"/>

</td>
</tr>
</table>

---

## 📦 Installation & Quick Start

We provide a one-line installer for macOS / Linux, plus a source-based workflow for developers.

### Option A: One-line install (recommended, macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Gucc111/PilotDeck/main/install.sh | bash
```

The script auto-installs Node.js 22, clones the repo, installs dependencies, and builds the frontend. Once it finishes:

```bash
pilotdeck            # starts the server at http://localhost:3001
pilotdeck status     # check runtime status
```

### Option B: From source (for developers)

**1. Clone and install dependencies**

```bash
git clone https://github.com/Gucc111/PilotDeck.git
cd PilotDeck

npm install              # root deps (Gateway runtime)
cd ui && npm install     # UI deps
cd ..
```

**2. Configure a model provider**

PilotDeck reads `~/.pilotdeck/pilotdeck.yaml`. You can create it manually, let the bootstrap script generate one, **or just open the Web UI and configure providers visually in the settings panel.**
Supported protocols include OpenAI, Anthropic, DeepSeek, Qwen, Kimi, MiniMax and other OpenAI-compatible endpoints.

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

**3. Start the services**

```bash
cd ui && npm run dev     # dev mode (HMR), visit http://localhost:5173
# or
cd ui && npm run start   # production mode, visit http://localhost:3001
```

### 🍎 Desktop App (Apple Silicon)

For macOS users we ship a signed, Apple-notarized DMG — double-click to run, no command-line setup required.
Build and release details: [apps/desktop/RELEASING.md](apps/desktop/RELEASING.md).

---

## 🛠️ Extension Protocol

PilotDeck has an open plugin architecture with a strict boundary between the open-source core and plugin customization. Extending the system is a `plugin.json` away:

- **MCP Servers** — first-class integration with any Model Context Protocol server.
- **Tools & Skills** — register custom tools, or pull community skills via [ClawHub](https://www.npmjs.com/package/clawhub).
- **Lifecycle Hooks** — intercept `PreToolUse`, `UserPromptSubmit`, and other critical lifecycle events.
- **Custom Memory** — plug in your own memory store provider.

---

## 🤝 Contributing

Thanks to everyone who has contributed code, feedback, and ideas. New contributors are warmly welcome — let's build the next-gen agent OS together.

Workflow: **Fork → feature branch → PR**. Please make sure the unit tests and linters pass before opening a PR:

```bash
npm test
cd ui && npx vitest run
```

---

## 💬 Community

- For bugs and feature requests, please open a [GitHub Issue](https://github.com/Gucc111/PilotDeck/issues).
- For commercial collaboration, enterprise support, or open-source license discussions, please reach out via email: `team@pilotdeck.ai` <!-- TODO: replace with real contact email -->.
- Join our community channels:

|                       |                       |                          |
| --------------------- | --------------------- | ------------------------ |
| **WeChat Community**  | **Feishu Community**  | **Discord Community**    |

---

## 🏢 Joint Development

PilotDeck is jointly developed by Tsinghua University [THUNLP](https://nlp.csai.tsinghua.edu.cn/), [ModelBest](https://modelbest.cn/), [OpenBMB](https://www.openbmb.cn/) and AI9stars.

---

## ⭐ Support Us

If PilotDeck has been helpful in your work or research, please consider giving us a ⭐ on GitHub!

---

## 📝 Citation

```bibtex
@misc{pilotdeck2026,
  title  = {PilotDeck: A WorkSpace-Centric Open-Source Agent Operating System},
  author = {THUNLP and ModelBest and OpenBMB and AI9stars},
  year   = {2026},
  note   = {Live demo: http://58.57.119.12:52006/},
  url    = {https://github.com/Gucc111/PilotDeck}
}
```

## 📄 License

The open-source license for this project is **TBD**. Until a formal license is finalized, the core code should be treated as "source-available, all rights reserved". The `products/**` directory contains customer-specific customizations and is **not** part of the open-source release scope.
