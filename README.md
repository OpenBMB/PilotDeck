<p align="center">
  <img src="assets/banner.png" alt="PilotDeck" width="680"/>
</p>

<p align="center">
  Task-oriented AI Agent productivity platform — redefining operational boundaries and memory evolution, one WorkSpace at a time.
</p>

<p align="center">
  <a href="https://pilotdeck.openbmb.cn"><img src="https://img.shields.io/badge/Website-pilotdeck.openbmb.cn-FF6B35?style=flat-square&logo=googlechrome&logoColor=white" alt="Official Website"/></a>
  <a href="https://pilotdeck.openbmb.cn/pilotdeck.github.io/demo/p/pilotdeck-demo"><img src="https://img.shields.io/badge/Demo-Live-brightgreen?style=flat-square" alt="Live Demo"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_3.0-blue.svg?style=flat-square" alt="License"/></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-Native-6366F1?style=flat-square" alt="MCP Native"/></a>
  <a href="https://github.com/OpenBMB/PilotDeck/stargazers"><img src="https://img.shields.io/github/stars/OpenBMB/PilotDeck?style=flat-square" alt="Stars"/></a>
  <br/>
  <a href="#-community"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"/></a>
  &nbsp;
  <a href="#-community"><img src="https://img.shields.io/badge/Feishu-Community-00D6B9?style=for-the-badge&logo=bytedance&logoColor=white" alt="Feishu"/></a>
  &nbsp;
  <a href="#-community"><img src="https://img.shields.io/badge/WeChat-Community-07C160?style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"/></a>
  <br/>
</p>

<p align="center">
  <b>English</b> | <a href="./README.zh.md">简体中文</a>
  <br/>
  <a href="https://pilotdeck.openbmb.cn">Website</a> · <a href="https://pilotdeck.openbmb.cn/pilotdeck.github.io/demo/p/pilotdeck-demo">Live Demo</a> · <a href="https://pilotdeck.openbmb.cn/pilotdeck.github.io/docs/en/introduction">Tutorial</a> · <a href="#-installation--quick-start">Quick Start</a> · <a href="#-key-highlights">Highlights</a> · <a href="#use-cases">Use Cases</a> · <a href="#-community">Community</a>
</p>

---

**News** 🔥

- **[2026.05.28]** PilotDeck is now open source! Visit our official website at [pilotdeck.openbmb.cn](https://pilotdeck.openbmb.cn). We welcome contributions, feedback, and stars from the community.

---

## 💡 About PilotDeck

**PilotDeck** is an open-source agent operating system designed around the concept of "WorkSpace". It is jointly developed and open-sourced by Tsinghua University [THUNLP](https://nlp.csai.tsinghua.edu.cn/), [ModelBest](https://modelbest.cn/), [OpenBMB](https://www.openbmb.cn/), and [AI9Stars](https://github.com/AI9Stars). Targeting general-purpose, multi-task scenarios, PilotDeck is built to be a true *productivity tool* for the Agent era.

A wave of excellent AI Agent harnesses has emerged in recent years, each with its own focus: **Claude Code / Cursor / Trae Solo** brought model reasoning deep into the programming IDE; **Claude Cowork** introduced the notion of project-level isolation to desktop-side knowledge work; **WorkBuddy** connected agents to IM ecosystems such as WeCom and Feishu so AI is one message away.

When we shift the lens from "one-shot programming" or "immediate Q&A" to **long-running, multi-project productivity work**, however, several questions remain open:

- When many projects run in parallel, can memory be **white-box and traceable**? When the AI gets something wrong, can you pinpoint which memory entry caused it and edit it directly — without starting a new chat from scratch?
- Can token cost be **tracked per task**, so that running agents in the background actually becomes economically viable?
- Can tasks of different difficulty **automatically be matched to different models**, instead of burning the flagship model on trivial calls?
- When you step away from the keyboard, can the work keep moving? Can the agent **proactively discover what's worth doing, report progress, and land results as files on disk**?

PilotDeck is an incremental exploration around exactly these questions. It uses the WorkSpace as the fundamental unit — completely isolating files, memory and skills per project — and pairs it with three pillar capabilities: **White-box Memory**, **Smart Routing** and **Always-on**. The entire system natively supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) and behaves consistently across front-ends (Web / CLI / IM).

### ✨ Key Highlights

<table width="100%">
<tr>
<td width="50%" valign="top">

**WorkSpace-Level Isolation & Accretion**

Every project gets its own file system, memory store and skill set. Parallel work no longer interferes with itself, retrieval has a bounded scope, and skills accrete naturally as each task grows — no more global context pollution.

<p align="center">
  <img src="assets/workspace_en.gif" width="100%" alt="WorkSpace isolation demo"/>
</p>

</td>
<td width="50%" valign="top">

**Traceable White-box Memory**

Memory generation, extraction, storage and retrieval are visible end-to-end. When the AI mis-remembers, you can pinpoint and fix the offending entry. Built-in **Dream Mode** consolidates memory in idle windows, and supports one-click rollback.

<p align="center">
  <img src="assets/memory_en.gif" width="100%" alt="White-box memory demo"/>
</p>

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Smart Routing & Cost Optimization**

Task difficulty is auto-detected; complex calls go to flagship models (e.g. Claude 3.5 Sonnet / GPT-4o), simple ones drop to lighter models. Through on-device / cloud co-orchestration and precise matching, token spend shrinks dramatically without sacrificing quality.

<p align="center">
  <img src="assets/router.gif" width="100%" alt="Smart routing demo"/>
</p>

</td>
<td width="50%" valign="top">

**Always-on Background Execution**

PilotDeck breaks the "you ask, it answers" loop: after you sign off, the agent keeps discovering candidate tasks, running long-horizon monitors, and finally lands deliverables as local files with a summary report waiting for you.

<p align="center">
  <img src="assets/awo_en.gif" width="100%" alt="Always-on execution demo"/>
</p>

</td>
</tr>
</table>

### 📊 Real-world Numbers

The three pillar capabilities have shown clear advantages in production-grade workflows:

#### 1. Smart Routing — ~70% cost savings on social-media workloads

In Xiaohongshu-style social-media operations, enabling Smart Routing automatically demotes simple polishing / layout tasks to a sub-agent (e.g. Sonnet 4.5) and only invokes Opus 4.5 at planning checkpoints:

<table width="100%">
<tr>
<th width="22%" align="left">Setup</th>
<th width="48%" align="left">Model configuration</th>
<th width="15%" align="left">Cost</th>
<th width="15%" align="left">Multiplier</th>
</tr>
<tr>
<td><b>Smart Routing ON</b></td>
<td>Opus 4.5 (main) + Sonnet 4.5 (sub)</td>
<td><b>$2.83</b></td>
<td><b>1.1×</b></td>
</tr>
<tr>
<td>Smart Routing OFF</td>
<td>All Opus 4.5 (main + sub)</td>
<td>$12.58</td>
<td>5.0×</td>
</tr>
<tr>
<td>Monolithic</td>
<td>Single Opus 4.5 long-react (estimated)</td>
<td>$12.20</td>
<td>4.8×</td>
</tr>
<tr>
<td colspan="4"><img width="840" height="1" alt=""/></td>
</tr>
</table>

#### 2. Smart Routing — 1/6 the cost while beating frontier models on hard tasks

The research team benchmarked 7 complex tasks (multilingual podcast push, multi-source data reports, domain-specific literature review, codebase architecture docs, etc.). The "strong main + light sub" routing setup matches or beats the frontier single-model setup at a fraction of the cost:

<table width="100%">
<tr>
<th width="70%" align="left">Setting</th>
<th width="15%" align="left">Score</th>
<th width="15%" align="left">Cost</th>
</tr>
<tr>
<td>MiniMax-M2.7 single-agent</td>
<td>37.1</td>
<td>$1.90</td>
</tr>
<tr>
<td>Claude Sonnet 4.6 single-agent</td>
<td>69.1</td>
<td>$18.36</td>
</tr>
<tr>
<td><b>Sonnet 4.6 (main) + MiniMax-M2.7 (sub)</b></td>
<td><b>70.6</b></td>
<td><b>$3.15</b></td>
</tr>
<tr>
<td colspan="3"><img width="840" height="1" alt=""/></td>
</tr>
</table>

#### 3. White-box Memory — layout & tone never bleed across projects

In black-box agents, mixing tasks in a shared context pool inevitably pollutes memory. PilotDeck's WorkSpace-scoped white-box memory addresses this end-to-end:

<table width="100%">
<thead>
<tr>
  <th width="14%" align="left">Dimension</th>
  <th width="41%" align="left">Current AI Agents (black-box)</th>
  <th width="45%" align="left">PilotDeck (white-box)</th>
</tr>
</thead>
<tbody>
<tr>
  <td><b>Visibility</b></td>
  <td>You can't see what the AI remembers, only what it outputs</td>
  <td>View every memory entry: what was stored, when, and which WorkSpace</td>
</tr>
<tr>
  <td><b>Control</b></td>
  <td>Once written, memory can't be edited or removed</td>
  <td>Edit / delete entries, pin critical decisions so they don't drift</td>
</tr>
<tr>
  <td><b>Traceability</b></td>
  <td>When it goes wrong, you can't find the root cause</td>
  <td>Generation → extraction → storage → retrieval, all auditable</td>
</tr>
<tr>
  <td><b>Isolation</b></td>
  <td>One shared pool — projects bleed into each other</td>
  <td>Scoped per WorkSpace; A's memory never reaches B</td>
</tr>
<tr>
  <td><b>Reversible</b></td>
  <td>After compression, the original is gone</td>
  <td>Dream-mode supports <b>one-click rollback</b> to the prior state</td>
</tr>
</tbody>
</table>

---

## 🖥️ UI & Demo

PilotDeck ships an out-of-the-box Web UI with full WorkSpace management, white-box memory editing, and visualization of multi-agent collaboration.

### Use Cases

> All demos below are generated entirely by edge-side models via PilotDeck's Smart Routing — no cloud-side frontier model required.

#### Work Document Generation

> *"Survey the Chinese LLM application market and turn it into a formal HTML white paper."*

<table width="100%">
<tr>
<td width="50%" align="center"><b>Process</b></td>
<td width="50%" align="center"><b>Result</b></td>
</tr>
<tr>
<td><img src="assets/en/ppt_en.gif" width="100%"/></td>
<td><img src="assets/result/ppt_result_en.gif" width="100%"/></td>
</tr>
</table>

#### Mini-Game Development

> *"Walk me through building an iOS AR mini-game Ball Finder in Vibe Coding mode."*

<table width="100%">
<tr>
<td width="50%" align="center"><b>Process</b></td>
<td width="50%" align="center"><b>Result</b></td>
</tr>
<tr>
<td><img src="assets/en/iosgame_en.gif" width="100%"/></td>
<td align="center"><img src="assets/result/ios_game_result.gif" width="60%"/></td>
</tr>
</table>

#### AI Engineering Platform Development

> *"Build a low-code embedding fine-tuning platform from scratch."*

<table width="100%">
<tr>
<td width="50%" align="center"><b>Process</b></td>
<td width="50%" align="center"><b>Result</b></td>
</tr>
<tr>
<td><img src="assets/en/modeltraining_en.gif" width="100%"/></td>
<td><img src="assets/result/modeltrainingresult_en.gif" width="100%"/></td>
</tr>
</table>

#### Audio-Video Editing & Social Media Operations

> *"Push this English podcast to a global audience in Chinese / Japanese / French / Korean / Spanish / Arabic."*

<table width="100%">
<tr>
<td width="50%" align="center"><b>Process</b></td>
<td width="50%" align="center"><b>Result (with audio)</b></td>
</tr>
<tr>
<td><img src="assets/en/podcast_en.gif" width="100%"/></td>
<td>

https://github.com/user-attachments/assets/a7245467-ee3c-4939-a055-c56576ac56d1

</td>
</tr>
</table>

---

## 📦 Installation & Quick Start

We provide one-line installers for macOS / Linux and Windows PowerShell, plus a source-based workflow for developers.

### Option A: One-line install (recommended, macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/OpenBMB/PilotDeck/main/install.sh | bash
```

The script checks/uses the supported Node.js 22 runtime (22.13+ and <23, required for the built-in SQLite runtime), clones the repo, installs dependencies, and builds the frontend. On Linux it can install missing system packages when `sudo` and a supported package manager are available. On macOS, make sure Xcode Command Line Tools and a Python with `distutils` are usable before running the installer. Once it finishes:

If Node.js or npm package downloads are slow or unreliable on your network, set reachable mirrors before running the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/OpenBMB/PilotDeck/main/install.sh | \
  PILOTDECK_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node \
  NPM_CONFIG_REGISTRY=https://registry.npmmirror.com bash
```

You can also keep the official Node.js host as the primary source and opt in to one or more trusted fallback mirrors with `PILOTDECK_NODE_DIST_FALLBACK_MIRRORS`.

```bash
pilotdeck            # starts the server at http://localhost:3001
pilotdeck status     # check runtime status
```

To open PilotDeck again later on macOS / Linux, run `pilotdeck` in a terminal and open the printed URL in your browser. If your shell has not picked up the PATH update yet, open a new terminal or source your shell profile first.

```bash
pilotdeck
# then open http://localhost:3001, or the URL printed by the command
```

### Option A2: One-line install (Windows PowerShell)

Run PowerShell as a normal user, then execute:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/OpenBMB/PilotDeck/main/install.ps1 | iex"
```

The PowerShell installer uses Windows-native paths under `%USERPROFILE%\.pilotdeck`, checks Node.js 22.13+ with `node:sqlite`, installs missing prerequisites with `winget` when available, builds PilotDeck, and creates a `pilotdeck.cmd` launcher in `%USERPROFILE%\.pilotdeck\bin`. Git LFS media assets are optional for the core app; if Git LFS is unavailable or times out, the installer continues without demo videos/GIFs.

After installation, the script starts PilotDeck and prints the UI URL, usually `http://localhost:3001`. It does not automatically open a browser, so copy that URL into your browser to finish onboarding (provider + API key). You can also open it from PowerShell:

```powershell
Start-Process http://localhost:3001
```

If this is your first install, open a new PowerShell window after the script updates your user `PATH`, then run:

```powershell
pilotdeck            # starts the server at http://localhost:3001
pilotdeck status     # check runtime status
```

To open PilotDeck again later, run `pilotdeck` from a new PowerShell window, then open the printed URL in your browser. If `pilotdeck` is not yet on `PATH`, run the launcher directly:

```powershell
& "$HOME\.pilotdeck\bin\pilotdeck.cmd"
```

#### Windows PowerShell FAQ

**`npm.ps1` cannot be loaded because running scripts is disabled**

This can still happen when you run development commands such as `npm run dev` directly in Windows PowerShell for the first time. PowerShell may resolve `npm` to `npm.ps1`, and the default execution policy can block that shim.

Fix it once for the current user, then reopen PowerShell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

If you do not want to change the user policy, run the cmd shim explicitly instead:

```powershell
npm.cmd run dev
```

**Native dependency build errors (`node-gyp`, `MSBuild`, or Python not found)**

The installer normally uses prebuilt packages for native dependencies such as `node-pty`, `better-sqlite3`, `bcrypt`, and `sharp`. On a fresh Windows machine, if npm cannot download a matching prebuild and falls back to compiling from source, install Visual Studio Build Tools with the C++ workload and Python, then rerun the installer.

**GitHub returns `429: Too Many Requests` while downloading `install.ps1`**

GitHub may rate-limit repeated `raw.githubusercontent.com` requests from shared networks. Wait a few minutes and rerun the one-line command, or download `install.ps1` from the repository and run it locally with `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

### Option B: From source (for developers)

> Need platform-specific dependency installation commands? See the [Source Installation Guide](./README_SOURCE_INSTALL.md).

**1. Clone and install dependencies**

> By default, skip large Git LFS demo media to keep the source install lightweight. If you need the demo videos/GIFs later, run `git lfs pull` after cloning.

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck

node --version          # must be v22.13.0 or newer, and below v23
corepack enable         # enables the pinned pnpm version from package.json
corepack pnpm install --frozen-lockfile
```

PilotDeck uses the committed `pnpm-lock.yaml` for reproducible source installs. Prefer the `corepack pnpm ...` command above instead of `npm install`; on macOS, this also avoids unnecessary native rebuild fallbacks when matching prebuilt packages are available.

**2. Configure a model provider**

PilotDeck reads `~/.pilotdeck/pilotdeck.yaml`. You can create it manually, let the bootstrap script generate one, **or just open the Web UI and configure providers visually in the settings panel.**
Supported protocols include OpenAI, Anthropic, native Google Gemini, DeepSeek, Qwen, Kimi, MiniMax and other OpenAI-compatible endpoints.

If you do not already have a config file, prepare the Web UI onboarding flow before starting in production mode:

```bash
node scripts/bootstrap-pilotdeck-config.mjs
```

This initializes `~/.pilotdeck/pilotdeck.yaml` for first-run onboarding so the Gateway can boot. Then open the Web UI and finish provider/API key setup in the onboarding/settings panel.

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

Native Gemini can be configured with `protocol: google`:

```yaml
schemaVersion: 1
agent:
  model: google/gemini-3.1-pro-preview
model:
  providers:
    google:
      protocol: google
      url: https://generativelanguage.googleapis.com
      apiKey: ${GEMINI_API_KEY}
      models:
        gemini-3.1-pro-preview: {}
```

Local Ollama models can be configured without an API key. PilotDeck uses
Ollama's OpenAI-compatible `/v1/chat/completions` endpoint:

```bash
ollama serve
ollama pull qwen3:0.6b
```

```yaml
schemaVersion: 1
agent:
  model: ollama/qwen3:0.6b
model:
  providers:
    ollama:
      protocol: openai
      url: http://localhost:11434/v1
      models:
        qwen3:0.6b: {}
```

**3. Start the services**

```bash
cd ui && npm run dev     # dev mode (HMR), visit http://localhost:5173
# or
cd ui && npm run start   # production mode, visit http://localhost:3001
```

### Option C: Docker Compose

If Docker is installed, you can start PilotDeck with:

```bash
docker compose up -d --build
```

For full Docker configuration, see [README_DOCKER.md](README_DOCKER.md).

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

Workflow: **Fork → feature branch → PR**.

---

## 💬 Community

- For bugs and feature requests, please open a [GitHub Issue](https://github.com/OpenBMB/PilotDeck/issues).
- Join our community channels:

<table width="100%">
<tr>
<td width="33%" align="center"><b>WeChat Community</b></td>
<td width="33%" align="center"><b>Feishu Community</b></td>
<td width="33%" align="center"><b>Discord Community</b></td>
</tr>
<tr>
<td align="center"><img src="assets/community/qr-wechat.png" width="200" alt="WeChat QR"/></td>
<td align="center"><img src="assets/community/qr-feishu.png" width="200" alt="Feishu QR"/></td>
<td align="center"><img src="assets/community/qr-discord.png" width="200" alt="Discord QR"/></td>
</tr>
</table>

---

## 🙏 Acknowledgements

We thank Agent OS pioneers such as OpenClaw, Claude Code, Codex, Cursor, and Hermes for their explorations that helped shape this field.

PilotDeck builds upon the following outstanding open-source projects:

- [ClawXRouter](https://github.com/OpenBMB/ClawXRouter) — Intelligent model routing
- [ClawXMemory](https://github.com/OpenBMB/ClawXMemory) — Agent memory system
- [Claude Code UI](https://github.com/siteboon/claudecodeui) — Web UI reference
- [Claude Code Router](https://github.com/musistudio/claude-code-router) — Model routing reference
- [UltraRAG](https://github.com/OpenBMB/UltraRAG) — RAG framework
- [Anthropic Skills](https://github.com/anthropics/skills) — Agent skill framework and built-in skills (skill-creator)
- [Vercel Labs Skills](https://github.com/vercel-labs/skills) — find-skills skill
- [MiniMax-AI Skills](https://github.com/MiniMax-AI/skills) — minimax-pdf skill
- [frontend-slides](https://github.com/zarazhangrui/frontend-slides) — Create beautiful slides on the web using a coding agent's frontend skills
- [Karpathy Guidelines](https://x.com/karpathy/status/2015883857489522876) — LLM coding behavioral guidelines
- [Vite](https://github.com/vitejs/vite) — Frontend build tool
- [React](https://github.com/facebook/react) — UI framework
- [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) — Utility-first CSS framework
- [shadcn/ui](https://github.com/shadcn-ui/ui) — Accessible component primitives for React

---

## 🏢 Joint Development

PilotDeck is jointly developed by Tsinghua University [THUNLP](https://nlp.csai.tsinghua.edu.cn/), [ModelBest](https://modelbest.cn/), [OpenBMB](https://www.openbmb.cn/) and [AI9Stars](https://github.com/AI9Stars).

---

## ⭐ Support Us

If PilotDeck has been helpful in your work or research, please consider giving us a Star on GitHub!

---

## 📝 Citation

```bibtex
@misc{pilotdeck2026,
  author       = {PilotDeck Team},
  title        = {PilotDeck: A WorkSpace-Centric Open-Source Agent Operating System},
  howpublished = {\url{https://github.com/OpenBMB/PilotDeck}},
  year         = {2026},
  note         = {Accessed: 2026-05-29}
}
```

## 📄 License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
