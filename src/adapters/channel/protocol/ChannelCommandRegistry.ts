/**
 * Centralized IM channel command registry.
 *
 * All IM channels (Feishu, Weixin, QQ, Telegram, Slack, etc.) share this
 * single command definition list. To add a new slash command that works
 * across all channels, just add an entry here — no need to touch individual
 * channel implementations.
 *
 * Commands marked `systemLevel: true` are handled by the channel directly
 * (without entering the AI agent loop). Commands marked `systemLevel: false`
 * are passed through to the gateway as normal messages.
 */

import type { Gateway } from "../../../gateway/index.js";
import { resolvePilotHome } from "../../../pilot/index.js";
import { runChatSearchFormatted } from "../../../cli/commands/chatSearch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandExecContext = {
  gateway: Gateway;
  chatId: string;
  channelKey: string;
  /** Send a text reply back to the same chat. */
  reply: (text: string) => Promise<void>;
  /** Bind a project to this chat (for project-scoped channels). */
  bindProject?: (projectKey: string) => void;
  /** Get the currently bound project for this chat. */
  getProject?: () => string | undefined;
  /** Reset the active session for this chat (equivalent to /new). */
  resetSession?: () => void;
  logger?: {
    info?(msg: string): void;
    warn?(msg: string): void;
    error?(msg: string): void;
  };
};

export type ChannelCommand = {
  /** The slash command name without leading `/` (e.g. "update", "projects") */
  name: string;
  /** Aliases (e.g. "升级" for Chinese users) */
  aliases?: string[];
  /** Short description */
  description: string;
  /**
   * If true, this command is handled directly by the channel (system-level)
   * and does NOT enter the agent session. If false, the text is forwarded
   * as a normal user message to the gateway.
   */
  systemLevel: boolean;
  /**
   * Handler function. Only called for systemLevel commands.
   * `arg` is everything after the command name.
   */
  handler?: (ctx: CommandExecContext, arg: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

const commands: ChannelCommand[] = [
  {
    name: "new",
    description: "Create a new conversation session",
    systemLevel: true,
    // Handled by the session mapper in each channel (creates a new session key)
    // so no handler here — the mapper returns `command: "new"` and the channel
    // sends an ack directly.
  },

  {
    name: "plan",
    description: "先生成计划并请求确认",
    systemLevel: false,
  },

  {
    name: "projects",
    aliases: ["项目列表"],
    description: "List available projects",
    systemLevel: true,
    handler: async (ctx, _arg) => {
      const result = await ctx.gateway.listProjects();
      const projects = result.projects;
      if (projects.length === 0) {
        await ctx.reply("暂无项目。使用 Web UI 创建 WorkSpace 后即可在此切换。");
        return;
      }
      const currentProject = ctx.getProject?.();
      const lines = ["📂 项目列表：", ""];
      for (const p of projects) {
        const marker = currentProject === p.projectKey ? " ✅" : "";
        lines.push(`• ${p.name}${marker}`);
      }
      lines.push("", "发送 /switch-project <项目名> 切换 WorkSpace");
      await ctx.reply(lines.join("\n"));
    },
  },

  {
    name: "switch-project",
    aliases: ["切换项目"],
    description: "Switch active project for this chat",
    systemLevel: true,
    handler: async (ctx, arg) => {
      if (!arg) {
        await ctx.reply("用法：/switch-project <项目名>\n\n发送 /projects 查看可用项目。");
        return;
      }
      const result = await ctx.gateway.listProjects();
      const lower = arg.toLowerCase();
      const target =
        result.projects.find((p) => p.name === arg) ??
        result.projects.find((p) => p.name.toLowerCase() === lower) ??
        result.projects.find((p) => p.name.toLowerCase().includes(lower));

      if (!target) {
        await ctx.reply(`未找到匹配「${arg}」的项目。\n\n发送 /projects 查看可用项目。`);
        return;
      }
      ctx.bindProject?.(target.projectKey);
      ctx.resetSession?.();
      await ctx.reply(`已切换到项目：${target.name}\n路径：${target.fullPath}\n（已自动创建新会话）`);
    },
  },

  {
    name: "update",
    aliases: ["升级", "更新"],
    description: "Pull latest code, rebuild, and restart PilotDeck",
    systemLevel: true,
    handler: async (ctx, arg) => {
      const { execFile } = await import("node:child_process");
      const { resolve: resolvePath, dirname } = await import("node:path");
      const { promisify } = await import("node:util");
      const { fileURLToPath } = await import("node:url");
      const execFileAsync = promisify(execFile);

      const thisFile = fileURLToPath(import.meta.url);
      const projectRoot = resolvePath(dirname(thisFile), "..", "..", "..", "..");
      const scriptPath = resolvePath(projectRoot, "scripts", "update.sh");

      const subcommand = arg?.trim() || "";

      if (subcommand === "check") {
        await ctx.reply("⏳ 正在检查更新...");
        try {
          const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], { cwd: projectRoot });
          const currentBranch = branch.trim() || "main";
          await execFileAsync("git", ["fetch", "origin", currentBranch], { cwd: projectRoot });
          const { stdout: localH } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
          const { stdout: remoteH } = await execFileAsync("git", ["rev-parse", `origin/${currentBranch}`], { cwd: projectRoot });
          if (localH.trim() === remoteH.trim()) {
            await ctx.reply(`✅ 已是最新版本 (${localH.trim().slice(0, 8)})，无需更新。`);
          } else {
            const { stdout: countStr } = await execFileAsync(
              "git", ["rev-list", "--count", `HEAD..origin/${currentBranch}`], { cwd: projectRoot },
            );
            const { stdout: logStr } = await execFileAsync(
              "git", ["log", "--oneline", `HEAD..origin/${currentBranch}`, "-5"], { cwd: projectRoot },
            );
            const lines = [
              `🆕 有 ${countStr.trim()} 个新提交可用`,
              `当前: ${localH.trim().slice(0, 8)} → 最新: ${remoteH.trim().slice(0, 8)}`,
              "",
              "最近提交:",
              logStr.trim(),
              "",
              "发送 /update 执行更新",
            ];
            await ctx.reply(lines.join("\n"));
          }
        } catch (e) {
          await ctx.reply(`❌ 检查更新失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      // Execute the update
      await ctx.reply("🚀 开始更新 PilotDeck...\n正在拉取最新代码、重新构建...");
      try {
        const { stdout, stderr } = await execFileAsync("bash", [scriptPath, "--restart"], {
          cwd: projectRoot,
          env: { ...process.env, FORCE_COLOR: "0" },
          timeout: 300_000,
        });

        const output = (stdout || "").trim();
        const lastLines = output.split("\n").slice(-5).join("\n");
        await ctx.reply(`✅ 更新完成！\n\n${lastLines}\n\n服务即将重启...`);

        // Exit so the process manager (docker/systemd) restarts us.
        // In local dev without a process manager, the user must restart manually.
        setTimeout(() => process.exit(0), 2000);
      } catch (e: unknown) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        if (err.code === 2) {
          await ctx.reply("✅ 已是最新版本，无需更新。");
          return;
        }
        const detail = err.stderr?.trim().split("\n").slice(-3).join("\n") || "";
        await ctx.reply(`❌ 更新失败\n\n${detail || (e instanceof Error ? e.message : String(e))}`);
      }
    },
  },

  {
    name: "status",
    aliases: ["状态"],
    description: "Show PilotDeck status and version",
    systemLevel: true,
    handler: async (ctx, _arg) => {
      const { execFile } = await import("node:child_process");
      const { resolve: resolvePath, dirname } = await import("node:path");
      const { promisify } = await import("node:util");
      const { fileURLToPath } = await import("node:url");
      const execFileAsync = promisify(execFile);

      const thisFile = fileURLToPath(import.meta.url);
      const projectRoot = resolvePath(dirname(thisFile), "..", "..", "..", "..");

      try {
        const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], { cwd: projectRoot });
        const { stdout: commit } = await execFileAsync("git", ["log", "--oneline", "-1", "HEAD"], { cwd: projectRoot });
        const uptime = process.uptime();
        const uptimeMin = Math.floor(uptime / 60);
        const uptimeH = Math.floor(uptimeMin / 60);
        const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

        const lines = [
          "📊 PilotDeck Status",
          "",
          `分支: ${branch.trim()}`,
          `提交: ${commit.trim()}`,
          `运行时间: ${uptimeStr}`,
          `Node: ${process.version}`,
          `平台: ${process.platform}`,
        ];
        await ctx.reply(lines.join("\n"));
      } catch (e) {
        await ctx.reply(`获取状态失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },

  {
    name: "search",
    aliases: ["find", "grep", "搜索"],
    description: "Search chat history across sessions",
    systemLevel: true,
    handler: async (ctx, arg) => {
      const projectRoot = ctx.getProject?.();
      const parsed = arg.trim();
      if (!parsed) {
        await ctx.reply(
          "用法：/search <关键词> [--all] [--limit N] [--role user|assistant]\n示例：/search docker 部署",
        );
        return;
      }

      const { text } = await runChatSearchFormatted({
        arg: parsed,
        projectRoot,
        pilotHome: resolvePilotHome(process.env),
        locale: "zh",
      });
      await ctx.reply(text);
    },
  },

  {
    name: "help",
    aliases: ["帮助"],
    description: "Show available commands",
    systemLevel: true,
    handler: async (ctx, _arg) => {
      const lines = ["📋 可用命令：", ""];
      for (const cmd of commands) {
        const aliases = cmd.aliases?.length ? ` (${cmd.aliases.map((a) => "/" + a).join(", ")})` : "";
        lines.push(`/${cmd.name}${aliases} — ${cmd.description}`);
      }
      await ctx.reply(lines.join("\n"));
    },
  },
];

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

/** Look up command by name or alias. Returns undefined if not a registered command. */
export function resolveCommand(text: string): { command: ChannelCommand; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const spaceIdx = trimmed.indexOf(" ");
  const name = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
  const arg = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

  for (const cmd of commands) {
    if (cmd.name === name) return { command: cmd, arg };
    if (cmd.aliases?.some((a) => a.toLowerCase() === name)) return { command: cmd, arg };
  }
  return undefined;
}

/** Get all registered commands. */
export function getRegisteredCommands(): readonly ChannelCommand[] {
  return commands;
}

/**
 * Execute a system-level command. Returns true if the command was handled,
 * false if it should be forwarded to the gateway.
 */
export async function executeChannelCommand(
  text: string,
  ctx: CommandExecContext,
): Promise<boolean> {
  const resolved = resolveCommand(text);
  if (!resolved) return false;
  if (!resolved.command.systemLevel) return false;
  if (!resolved.command.handler) return false;

  try {
    await resolved.command.handler(ctx, resolved.arg);
  } catch (e) {
    ctx.logger?.error?.(`command /${resolved.command.name} failed: ${e}`);
    await ctx.reply(`命令执行失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}
