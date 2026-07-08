#!/usr/bin/env node
import { resolve } from "node:path";
import { createAlwaysOnManager, createApplyHandler, SessionConfigOverrides, type AlwaysOnManager, type AlwaysOnConfig } from "../always-on/index.js";
import { createCronManager, type CronManager, type CronConfig } from "../cron/index.js";
import { connectRemoteGatewayIfAvailable, type Gateway, type GatewayEvent, type GatewaySubmitTurnInput } from "../gateway/index.js";
import {
  CliChannel, TuiChannel, FeishuChannel, WeixinChannel, QQChannel, WeComChannel,
  loadEnabledChannels, ChannelStatePersistence,
  FeishuSessionMapper, WeixinSessionMapper, WeComSessionMapper,
  type FeishuSessionMapperState, type WeixinSessionMapperState, type WeComSessionMapperState,
} from "../adapters/index.js";
import {
  migrateSkillsToPilotDeck,
  type SkillMigrationConflictMode,
  type SkillMigrationItem,
  type SkillMigrationSourceKind,
} from "../extension/skills/index.js";
import { loadPilotConfig, resolvePilotHome } from "../pilot/index.js";
import { createLocalGateway } from "./createLocalGateway.js";
import { startPilotDeckServer } from "./pilotdeckServer.js";
import { installGlobalProxy, reinstallGlobalProxy } from "./proxy.js";
import { createShutdownAndExit } from "./shutdownCoordinator.js";
import { createTelemetryCollector } from "../telemetry/index.js";

await installGlobalProxy();

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === "server") {
    const projectRoot = process.cwd();
    const env = process.env;
    const pilotHome = resolvePilotHome(env);
    const snapshot = loadPilotConfig({ projectRoot, env });
    const telemetry = createTelemetryCollector({
      env, pilotHome,
      enabled: snapshot.config.telemetry?.enabled,
    });

    // Apply proxy from config (env-based proxy from top-level installGlobalProxy
    // takes precedence; this fills in when only pilotdeck.yaml has a proxy).
    if (snapshot.config.proxy?.url) {
      await installGlobalProxy(snapshot.config.proxy.url);
    }

    let alwaysOn: AlwaysOnManager | undefined;
    let cron: CronManager | undefined;
    let deferredBroadcast: ((name: string, payload?: unknown) => void) | undefined;
    const sessionOverrides = new SessionConfigOverrides();

    const alwaysOnLogger = {
      info: (message: string, data?: Record<string, unknown>) =>
        console.log(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
      warn: (message: string, data?: Record<string, unknown>) =>
        console.warn(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
    };
    const cronLogger = {
      info: (message: string, data?: Record<string, unknown>) =>
        console.log(`[cron] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
      warn: (message: string, data?: Record<string, unknown>) =>
        console.warn(`[cron] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
    };

    function buildAlwaysOn(config: AlwaysOnConfig | undefined): AlwaysOnManager | undefined {
      if (!config?.enabled) return undefined;
      return createAlwaysOnManager({
        config,
        pilotHome,
        sessionOverrides,
        logger: alwaysOnLogger,
        telemetry,
        onWorktreeCreated: (runId, cwd) => {
          deferredBroadcast?.("worktree_created", { runId, cwd });
        },
        onWorktreeRemoved: (cwd) => {
          deferredBroadcast?.("worktree_removed", { cwd });
        },
        onTurnEvent: (sessionKey, channelKey, event) => {
          deferredBroadcast?.("always-on:turn-event", { sessionKey, channelKey, event });
        },
      });
    }

    function buildCron(config: CronConfig | undefined): CronManager | undefined {
      if (!config) return undefined;
      return createCronManager({
        config,
        pilotHome,
        sessionOverrides,
        logger: cronLogger,
        telemetry,
        onResultDelivery: (delivery) => {
          void serverRef?.deliverCronResult(delivery)
            .then((delivered) => {
              if (!delivered) {
                console.warn(`[cron] result delivery was not handled task=${delivery.taskId} run=${delivery.runId}`);
              }
            })
            .catch((error: unknown) => {
              console.warn(`[cron] result delivery failed ${error instanceof Error ? error.message : String(error)}`);
            });
        },
      });
    }

    alwaysOn = buildAlwaysOn(snapshot.config.alwaysOn);
    cron = buildCron(snapshot.config.cron);

    const {
      gateway, configStore, dispose: disposeGateway,
      bindServer, isProjectBusy, updateSubsystems,
    } = createLocalGateway({
      projectRoot,
      pilotHome,
      env,
      fallbackProjectRoot: pilotHome,
      extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
      sessionOverrides,
      cron,
      telemetry,
    });

    const standaloneApply = createApplyHandler({
      gateway,
      pilotHome,
      sessionOverrides,
      alwaysOnConfig: snapshot.config.alwaysOn,
      telemetry,
      onTurnEvent: (sessionKey, channelKey, event) => {
        deferredBroadcast?.("always-on:turn-event", { sessionKey, channelKey, event });
      },
    });

    if (alwaysOn) {
      alwaysOn.bindGateway(gateway, { isProjectBusy });
      await alwaysOn.start();
    }
    updateSubsystems({
      extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
      sessionOverrides,
      cron,
      alwaysOnApply: alwaysOn
        ? (input) => alwaysOn!.applyCycle(input)
        : standaloneApply,
      alwaysOnRerunPlan: alwaysOn
        ? (input) => alwaysOn!.rerunPlan(input)
        : undefined,
    });
    if (cron) {
      cron.bindGateway(gateway);
      await cron.start();
    }

    // --- Subsystem hot-reload on config change ---

    let reloadChain = Promise.resolve();

    configStore.subscribe((event) => {
      if (event.changedPaths.some((p) => p.startsWith("telemetry.") || p === "telemetry")) {
        telemetry.setEnabled(event.nextSnapshot.config.telemetry?.enabled ?? false);
      }

      const aoChanged = event.changedPaths.some((p) => p.startsWith("alwaysOn.") || p === "alwaysOn");
      const cronChanged = event.changedPaths.some((p) => p.startsWith("cron.") || p === "cron");
      const proxyChanged = event.changedPaths.some((p) => p.startsWith("proxy.") || p === "proxy");
      const adapterChanged = event.changedPaths.some((p) => p.startsWith("adapters."));

      if (proxyChanged) {
        const proxyConfig = event.nextSnapshot.config.proxy;
        void reinstallGlobalProxy(proxyConfig?.url, proxyConfig?.noProxy);
      }

      if (adapterChanged) {
        reloadChain = reloadChain
          .then(() => handleAdapterHotReload(event.nextSnapshot.config))
          .catch((err) =>
            console.warn(
              `[pilotdeck] adapter hot-reload failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }

      if (!aoChanged && !cronChanged) return;

      reloadChain = reloadChain
        .then(() => handleSubsystemReload(aoChanged, cronChanged, event.nextSnapshot.config))
        .catch((err) =>
          console.warn(
            `[pilotdeck] subsystem reload failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    });

    async function handleSubsystemReload(
      aoChanged: boolean,
      cronChanged: boolean,
      config: (typeof snapshot)["config"],
    ): Promise<void> {
      if (aoChanged) {
        await alwaysOn?.stop();
        alwaysOn = undefined;
      }
      if (cronChanged) {
        await cron?.stop();
        cron = undefined;
      }

      if (aoChanged) alwaysOn = buildAlwaysOn(config.alwaysOn);
      if (cronChanged) cron = buildCron(config.cron);

      if (aoChanged && alwaysOn) {
        alwaysOn.bindGateway(gateway, { isProjectBusy });
        await alwaysOn.start();
      }

      const fallbackApply = createApplyHandler({
        gateway,
        pilotHome,
        sessionOverrides,
        alwaysOnConfig: config.alwaysOn,
        telemetry,
        onTurnEvent: (sessionKey, channelKey, event) => {
          deferredBroadcast?.("always-on:turn-event", { sessionKey, channelKey, event });
        },
      });

      updateSubsystems({
        extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
        sessionOverrides,
        cron,
        alwaysOnApply: alwaysOn ? (input) => alwaysOn!.applyCycle(input) : fallbackApply,
        alwaysOnRerunPlan: alwaysOn ? (input) => alwaysOn!.rerunPlan(input) : undefined,
      });
      if (cronChanged && cron) {
        cron.bindGateway(gateway);
        await cron.start();
      }

      const parts: string[] = [];
      if (aoChanged) parts.push(`always-on=${alwaysOn ? "started" : "stopped"}`);
      if (cronChanged) parts.push(`cron=${cron ? "started" : "stopped"}`);
      console.log(`[pilotdeck] Subsystem hot-reload complete: ${parts.join(", ")}`);
    }

    // --- Channel state persistence ---

    const channelStatePersistence = new ChannelStatePersistence({
      stateDir: resolve(pilotHome, "channels"),
    });

    // --- Adapter hot-reload ---

    let serverRef: Awaited<ReturnType<typeof startPilotDeckServer>> | undefined;

    async function handleAdapterHotReload(config: (typeof snapshot)["config"]): Promise<void> {
      if (!serverRef) return;
      const parts: string[] = [];

      const fCfg = config.adapters?.feishu;
      if (fCfg?.enabled === true) {
        const savedFeishu = await channelStatePersistence.load<FeishuSessionMapperState>("feishu");
        const ch = new FeishuChannel({
          appId: fCfg.appId,
          appSecret: fCfg.appSecret,
          encryptKey: fCfg.encryptKey,
          verifyToken: fCfg.verifyToken,
          connectionMode: fCfg.connectionMode,
          domainName: fCfg.domainName,
          mapper: savedFeishu ? new FeishuSessionMapper(savedFeishu) : undefined,
          onStateChange: (state) => channelStatePersistence.save("feishu", state),
        });
        await serverRef.hotStartChannel(ch);
        parts.push("feishu=started");
      }

      const wCfg = config.adapters?.weixin;
      if (wCfg?.enabled === true) {
        const savedWeixin = await channelStatePersistence.load<WeixinSessionMapperState>("weixin");
        await serverRef.hotStartChannel(new WeixinChannel({
          mapper: savedWeixin ? new WeixinSessionMapper(savedWeixin) : undefined,
          onStateChange: (state) => channelStatePersistence.save("weixin", state),
        }));
        parts.push("weixin=started");
      }

      const wcCfg = config.adapters?.wecom;
      if (wcCfg?.enabled === true) {
        const savedWeCom = await channelStatePersistence.load<WeComSessionMapperState>("wecom");
        await serverRef.hotStartChannel(new WeComChannel({
          botKey: wcCfg.token,
          extra: wcCfg.extra,
          mapper: savedWeCom ? new WeComSessionMapper(savedWeCom) : undefined,
          onStateChange: (state) => channelStatePersistence.save("wecom", state),
        }));
        parts.push("wecom=started");
      }

      if (parts.length) {
        console.log(`[pilotdeck] Adapter hot-reload complete: ${parts.join(", ")}`);
      }
    }

    // --- Server startup ---

    const envPort = Number.parseInt(env.PILOTDECK_GATEWAY_PORT ?? "", 10);
    const extraChannels = await loadEnabledChannels(snapshot.config.adapters);
    const feishuCfg = snapshot.config.adapters?.feishu;
    const savedFeishuState = await channelStatePersistence.load<FeishuSessionMapperState>("feishu");
    const feishuChannel = feishuCfg?.enabled === true
      ? new FeishuChannel({
          appId: feishuCfg.appId,
          appSecret: feishuCfg.appSecret,
          encryptKey: feishuCfg.encryptKey,
          verifyToken: feishuCfg.verifyToken,
          connectionMode: feishuCfg.connectionMode,
          domainName: feishuCfg.domainName,
          mapper: savedFeishuState ? new FeishuSessionMapper(savedFeishuState) : undefined,
          onStateChange: (state) => channelStatePersistence.save("feishu", state),
        })
      : undefined;
    const weixinCfg = snapshot.config.adapters?.weixin;
    const savedWeixinState = await channelStatePersistence.load<WeixinSessionMapperState>("weixin");
    const weixinChannel = weixinCfg?.enabled === true
      ? new WeixinChannel({
          mapper: savedWeixinState ? new WeixinSessionMapper(savedWeixinState) : undefined,
          onStateChange: (state) => channelStatePersistence.save("weixin", state),
        })
      : undefined;
    const wecomCfg = snapshot.config.adapters?.wecom;
    const savedWeComState = await channelStatePersistence.load<WeComSessionMapperState>("wecom");
    const wecomChannel = wecomCfg?.enabled === true
      ? new WeComChannel({
          botKey: wecomCfg.token,
          extra: wecomCfg.extra,
          mapper: savedWeComState ? new WeComSessionMapper(savedWeComState) : undefined,
          onStateChange: (state) => channelStatePersistence.save("wecom", state),
        })
      : undefined;
    const allChannels = [...extraChannels, ...(wecomChannel ? [wecomChannel] : [])];
    const server = await startPilotDeckServer({
      gateway,
      port: readPort(argv) ?? (Number.isFinite(envPort) ? envPort : 18789),
      staticAssetsPath: resolve(projectRoot, "ui/dist"),
      feishu: feishuChannel,
      weixin: weixinChannel,
      qq: new QQChannel(),
      channels: allChannels,
      config: snapshot.config,
    });
    serverRef = server;
    bindServer(server);
    deferredBroadcast = (name, payload) => server.broadcastNotification(name, payload);
    console.log(`PilotDeck server listening: ${server.url}`);
    console.log(`WebSocket: ${server.wsUrl}`);
    if (server.tokenPath) {
      console.log(`Token: ${server.tokenPath}`);
    }
    const stop = async () => {
      try {
        await channelStatePersistence.flush();
        console.log(`[telemetry] shutdown snapshot ${JSON.stringify(telemetry.snapshot())}`);
        disposeGateway();
        await alwaysOn?.stop();
        await cron?.stop();
        await telemetry.shutdown();
      } catch (error) {
        console.warn(`[runtime] stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const shutdownAndExit = createShutdownAndExit(stop, (exitCode) => process.exit(exitCode));
    process.on("uncaughtException", (error) => {
      telemetry.trackError(error, { module: "runtime", metadata: { source: "uncaughtException" } });
      void shutdownAndExit(1);
    });
    process.on("unhandledRejection", (reason) => {
      telemetry.trackError(reason, { module: "runtime", metadata: { source: "unhandledRejection" } });
      void shutdownAndExit(1);
    });
    process.on("SIGINT", () => {
      void shutdownAndExit(0);
    });
    process.on("SIGTERM", () => {
      void shutdownAndExit(0);
    });
    await new Promise(() => undefined);
    return;
  }

  if (command === "gateway") {
    const sub = argv[1];
    if (sub === "setup") {
      const { runGatewaySetup } = await import("./commands/gatewaySetup.js");
      await runGatewaySetup(argv.slice(2));
      return;
    }
    console.error("Usage: pilotdeck gateway setup [feishu|weixin|wecom]");
    process.exitCode = 1;
    return;
  }

  if (command === "cron") {
    await handleCronCommand(argv.slice(1));
    return;
  }

  if (command === "update") {
    await handleUpdateCommand(argv.slice(1));
    return;
  }

  if (command === "skills") {
    await handleSkillsCommand(argv.slice(1));
    return;
  }

  if (command === "chat") {
    const { runChatSearchCli } = await import("./commands/chatSearch.js");
    await runChatSearchCli(argv.slice(1));
    return;
  }

  if (command === "tui") {
    if (!process.stdin.isTTY) {
      console.error("pilotdeck tui requires an interactive terminal.");
      process.exitCode = 1;
      return;
    }
    const snapshot = loadPilotConfig({ projectRoot: process.cwd() });
    const gatewayPort = snapshot.config.gateway?.port ?? 18789;
    const probeUrl = `http://127.0.0.1:${gatewayPort}`;
    const fallbackGateway = createFallbackGateway();
    try {
      const { gateway: local } = createLocalGateway({ projectRoot: process.cwd() });
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "PilotDeck",
        probe: { url: probeUrl },
      }).start({ gateway: local });
    } catch (error) {
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "PilotDeck",
        probe: { url: probeUrl },
      }).start({ gateway: fallbackGateway });
    }
    return;
  }

  const { gateway: fallbackGateway } = createLocalGateway({ projectRoot: process.cwd() });
  await new CliChannel({ argv, projectKey: process.cwd() }).start({ gateway: fallbackGateway });
}

async function handleUpdateCommand(argv: string[]): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const { resolve: resolvePath, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = resolvePath(dirname(__filename), "..", "..", "..");
  const scriptPath = resolvePath(projectRoot, "scripts", "update.sh");

  const doRestart = argv.includes("--restart");
  const checkOnly = argv.includes("--check");

  if (checkOnly) {
    try {
      const branch = execFileSync("git", ["branch", "--show-current"], { cwd: projectRoot, encoding: "utf-8" }).trim() || "main";
      execFileSync("git", ["fetch", "origin", branch], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe" });
      const local = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf-8" }).trim();
      const remote = execFileSync("git", ["rev-parse", `origin/${branch}`], { cwd: projectRoot, encoding: "utf-8" }).trim();

      if (local === remote) {
        console.log(`Already up-to-date (${local.slice(0, 8)}) on branch ${branch}`);
      } else {
        const countStr = execFileSync("git", ["rev-list", "--count", `HEAD..origin/${branch}`], { cwd: projectRoot, encoding: "utf-8" }).trim();
        console.log(`Update available: ${countStr} new commit(s) on branch ${branch}`);
        console.log(`  local:  ${local.slice(0, 8)}`);
        console.log(`  remote: ${remote.slice(0, 8)}`);
        const log = execFileSync("git", ["log", "--oneline", `HEAD..origin/${branch}`, "-5"], { cwd: projectRoot, encoding: "utf-8" }).trim();
        if (log) {
          console.log("\nRecent commits:");
          console.log(log);
        }
      }
    } catch (e: unknown) {
      console.error(`Failed to check for updates: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  const args = doRestart ? [scriptPath, "--restart"] : [scriptPath];

  try {
    execFileSync("bash", args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 2) {
      // Already up-to-date — not an error
      return;
    }
    console.error(`Update failed with exit code ${err.status ?? "unknown"}`);
    process.exitCode = 1;
  }
}

async function handleCronCommand(argv: string[]): Promise<void> {
  const gateway = await connectRemoteGatewayIfAvailable();
  if (!gateway) {
    console.error("pilotdeck cron requires a running pilotdeck server.");
    process.exitCode = 1;
    return;
  }
  const command = argv[0];
  if (command === "list") {
    const result = await gateway.cronList({
      includeHistory: argv.includes("--history"),
      limit: readNumberFlag(argv, "--limit"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "create") {
    const message = readStringFlag(argv, "--message");
    const sessionKey = readStringFlag(argv, "--session");
    const once = readStringFlag(argv, "--once");
    const cron = readStringFlag(argv, "--cron");
    if (!message || !sessionKey || (!once && !cron)) {
      console.error("Usage: pilotdeck cron create --session <sessionKey> --message <text> (--once <iso> | --cron <expr>)");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronCreate({
      message,
      sessionKey,
      channelKey: readStringFlag(argv, "--channel") ?? inferChannelKey(sessionKey),
      projectKey: readStringFlag(argv, "--project") ?? process.cwd(),
      schedule: once ? { type: "once", runAt: once } : { type: "cron", expression: cron! },
      timezone: readStringFlag(argv, "--timezone"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "delete") {
    const taskId = argv[1] ?? readStringFlag(argv, "--task");
    if (!taskId) {
      console.error("Usage: pilotdeck cron delete <taskId> [--stop-running]");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronDelete({ taskId, stopRunning: argv.includes("--stop-running") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "stop") {
    const taskId = argv[1] ?? readStringFlag(argv, "--task");
    const runId = readStringFlag(argv, "--run");
    if (!taskId && !runId) {
      console.error("Usage: pilotdeck cron stop <taskId> or pilotdeck cron stop --run <runId>");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronStop({ taskId, runId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error("Usage: pilotdeck cron <list|create|delete|stop>");
  process.exitCode = 1;
}

async function handleSkillsCommand(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command !== "migrate") {
    console.error("Usage: pilotdeck skills migrate [--execute] [--from cc,openclaw,hermes] [--source <dir>] [--overwrite|--rename]");
    process.exitCode = 1;
    return;
  }

  const from = parseSkillMigrationSources(readStringFlag(argv, "--from"));
  const conflictMode: SkillMigrationConflictMode = argv.includes("--overwrite")
    ? "overwrite"
    : argv.includes("--rename")
      ? "rename"
      : "skip";
  const projectRoot = readStringFlag(argv, "--project") ?? process.cwd();
  const pilotHome = readStringFlag(argv, "--pilot-home") ?? resolvePilotHome(process.env);
  const report = await migrateSkillsToPilotDeck({
    pilotHome,
    projectRoot,
    include: from,
    customSources: readRepeatedStringFlag(argv, "--source"),
    execute: argv.includes("--execute"),
    conflictMode,
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSkillMigrationReport(report);
  if (report.summary.error > 0) {
    process.exitCode = 1;
  }
}

function parseSkillMigrationSources(value: string | undefined): Array<Exclude<SkillMigrationSourceKind, "custom">> | undefined {
  if (!value) return undefined;
  const sources: Array<Exclude<SkillMigrationSourceKind, "custom">> = [];
  for (const raw of value.split(",")) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "cc" || normalized === "claude" || normalized === "claude-code") {
      sources.push("claude-code");
    } else if (normalized === "openclaw") {
      sources.push("openclaw");
    } else if (normalized === "hermes") {
      sources.push("hermes");
    } else if (normalized === "all") {
      sources.push("claude-code", "openclaw", "hermes");
    } else {
      throw new Error(`Unknown skills source "${raw}". Use cc, openclaw, hermes, or all.`);
    }
  }
  return sources.length > 0 ? [...new Set(sources)] : undefined;
}

function printSkillMigrationReport(report: Awaited<ReturnType<typeof migrateSkillsToPilotDeck>>): void {
  const mode = report.mode === "execute" ? "EXECUTED" : "DRY RUN";
  console.log(`PilotDeck skills migration (${mode})`);
  console.log(`Target: ${report.targetRoot}`);
  console.log(
    `Summary: migrated=${report.summary.migrated} would_migrate=${report.summary.would_migrate} ` +
      `conflict=${report.summary.conflict} skipped=${report.summary.skipped} error=${report.summary.error}`,
  );

  const actionable = report.items.filter((item) => item.status !== "skipped");
  if (actionable.length > 0) {
    console.log("");
    for (const item of actionable) {
      console.log(`${formatSkillMigrationStatus(item)} ${item.sourceLabel}: ${item.slug || "(n/a)"}`);
      console.log(`  ${item.sourcePath}`);
      if (item.destinationPath) console.log(`  -> ${item.destinationPath}`);
      if (item.reason) console.log(`  ${item.reason}`);
    }
  }

  if (report.mode === "dry-run") {
    console.log("");
    console.log("This was a dry run. Add --execute to copy skills.");
  }
}

function formatSkillMigrationStatus(item: SkillMigrationItem): string {
  if (item.status === "migrated") return "+";
  if (item.status === "would_migrate") return "?";
  if (item.status === "conflict") return "!";
  if (item.status === "error") return "x";
  return "-";
}

function readPort(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  const port = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(port) ? port : undefined;
}

function readStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readRepeatedStringFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function readNumberFlag(argv: string[], flag: string): number | undefined {
  const value = readStringFlag(argv, flag);
  if (!value) {
    return undefined;
  }
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : undefined;
}

function inferChannelKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator > 0 ? sessionKey.slice(0, separator) : "cli";
}

function createFallbackGateway(): Gateway {
  async function* errorStream(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    yield {
      type: "error",
      code: "local_gateway_unavailable",
      message: `No PilotDeck server is available and local config could not start session ${input.sessionKey}.`,
      recoverable: false,
    };
  }
  return {
    submitTurn: errorStream,
    abortTurn: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async (input) => input,
    newSession: async (input) => ({ sessionKey: `${input.channelKey}:project=${input.projectKey ?? process.cwd()}:s_local` }),
    closeSession: async () => undefined,
    describeServer: async () => ({ mode: "in_process" }),
    cronCreate: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronList: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronDelete: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronStop: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronRunNow: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => {
      throw new Error("read_session_messages is not configured.");
    },
    readSubagentMessages: async () => {
      throw new Error("read_subagent_messages is not configured.");
    },
    forkSession: async () => {
      throw new Error("fork_session is not configured.");
    },
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
