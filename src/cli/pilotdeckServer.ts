import type { ChannelAdapter, ChannelHandle } from "../adapters/index.js";
import type { CronResultDelivery } from "../cron/index.js";
import { FeishuChannel } from "../adapters/index.js";
import { WeixinChannel } from "../adapters/index.js";
import { QQChannel } from "../adapters/index.js";
import type { Gateway } from "../gateway/index.js";
import { startGatewayServer, type GatewayServer } from "../gateway/index.js";
import { resolvePilotHome, type PilotConfig } from "../pilot/index.js";
import {
  createChannelRuntimeStatusReporter,
  type ChannelRuntimeStatusReporter,
} from "../adapters/channel/protocol/ChannelRuntimeStatus.js";

export type StartPilotDeckServerOptions = {
  gateway: Gateway;
  port?: number;
  host?: string;
  staticAssetsPath?: string;
  feishu?: FeishuChannel;
  weixin?: WeixinChannel;
  qq?: QQChannel;
  /**
   * Extra channels (e.g. telegram, discord, slack) loaded via
   * `loadEnabledChannels(config.adapters)`.
   */
  channels?: ChannelAdapter[];
  /**
   * Loaded pilotdeck.yaml config — passed into channel.start() so adapters can
   * read their own section (e.g. `adapters.feishu.appId/appSecret`).
   */
  config?: PilotConfig;
};

export type PilotDeckServer = GatewayServer & {
  /**
   * Hot-start a channel adapter after server startup.
   * Stops any previously running instance of the same channelKey first.
   */
  hotStartChannel(channel: ChannelAdapter): Promise<void>;
  /** Stop a running channel (e.g. after it was disabled in config). No-op if not running. */
  stopChannel(channelKey: string, reason?: string): Promise<void>;
  /** Last runtime state a channel reported ("connected", "failed", …), if any. */
  channelState(channelKey: string): string | undefined;
  deliverCronResult(delivery: CronResultDelivery): Promise<boolean>;
};

export async function startPilotDeckServer(options: StartPilotDeckServerOptions): Promise<PilotDeckServer> {
  const consoleLogger = {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
  const persistChannelStatus = createSafeChannelStatusReporter(
    createChannelRuntimeStatusReporter(resolvePilotHome(process.env)),
    consoleLogger,
  );
  const lastChannelState = new Map<string, string>();
  const reportChannelStatus: ChannelRuntimeStatusReporter = (channelKey, update) => {
    lastChannelState.set(channelKey, update.state);
    persistChannelStatus(channelKey, update);
  };
  const baseDeps = {
    gateway: options.gateway,
    config: options.config,
    logger: consoleLogger,
    reportChannelStatus,
  };

  const runningHandles = new Map<string, ChannelHandle>();
  const runningChannels = new Map<string, ChannelAdapter>();
  /**
   * Starts and stops of one channel run strictly one after another. Overlapping
   * hot reloads would otherwise both miss the running instance and start two
   * copies (two Telegram pollers fight with 409s; two Slack sockets split events).
   */
  const channelOps = new Map<string, Promise<void>>();

  function enqueueChannelOp(channelKey: string, op: () => Promise<void>): Promise<void> {
    const previous = channelOps.get(channelKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(op);
    channelOps.set(channelKey, next);
    void next
      .finally(() => {
        if (channelOps.get(channelKey) === next) channelOps.delete(channelKey);
      })
      .catch(() => undefined);
    return next;
  }

  async function startAndTrack(ch: ChannelAdapter): Promise<void> {
    reportChannelStatus(ch.channelKey, {
      state: "starting",
      message: `${ch.channelKey}: starting in background`,
    });
    const existing = runningHandles.get(ch.channelKey);
    if (existing) {
      await existing.stop("hot-reload").catch(() => {});
      runningHandles.delete(ch.channelKey);
      runningChannels.delete(ch.channelKey);
    }
    const handle = await ch.start(baseDeps);
    runningHandles.set(ch.channelKey, handle);
    runningChannels.set(ch.channelKey, ch);
  }

  const gwServer = await startGatewayServer({
    gateway: options.gateway,
    port: options.port,
    host: options.host,
    staticAssetsPath: options.staticAssetsPath,
    feishuWebhook: (request, response, body) => {
      // Resolve the active instance for every request, including channels enabled
      // after startup. Never retain a replaced instance or its old credentials.
      const channel = runningChannels.get("feishu");
      if (channel instanceof FeishuChannel) return channel.handleWebhook(request, response, body);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "feishu_not_started" }));
      return true;
    },
  });

  function startChannelInBackground(channel: ChannelAdapter): Promise<void> {
    return enqueueChannelOp(channel.channelKey, () => startAndTrack(channel)
      .then(() => {
        consoleLogger.info(`[adapters] channel ${channel.channelKey} startup task completed`);
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        consoleLogger.error(`[adapters] channel ${channel.channelKey} start failed: ${message}`);
        reportChannelStatus(channel.channelKey, {
          state: "failed",
          message: `${channel.channelKey}: startup failed`,
          error: message,
        });
      }));
  }

  const startupChannels = [
    ...(options.feishu ? [options.feishu] : []),
    ...(options.weixin ? [options.weixin] : []),
    ...(options.qq ? [options.qq] : []),
    ...(options.channels ?? []),
  ];
  for (const channel of startupChannels) {
    void startChannelInBackground(channel);
  }

  return Object.assign(gwServer, {
    hotStartChannel(channel: ChannelAdapter) {
      void startChannelInBackground(channel);
      return Promise.resolve();
    },
    stopChannel(channelKey: string, reason = "disabled") {
      return enqueueChannelOp(channelKey, async () => {
        const handle = runningHandles.get(channelKey);
        if (!handle) return;
        runningHandles.delete(channelKey);
        runningChannels.delete(channelKey);
        await handle.stop(reason).catch((e: unknown) => {
          consoleLogger.warn(`[adapters] channel ${channelKey} stop failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        reportChannelStatus(channelKey as ChannelAdapter["channelKey"], {
          state: "stopped",
          message: `${channelKey}: stopped (${reason})`,
        });
      });
    },
    channelState(channelKey: string) {
      return lastChannelState.get(channelKey);
    },
    async deliverCronResult(delivery: CronResultDelivery) {
      const channel = runningChannels.get(delivery.originChannelKey ?? delivery.channelKey);
      if (!channel?.deliverCronResult) return false;
      return channel.deliverCronResult(delivery);
    },
  });
}

function createSafeChannelStatusReporter(
  reporter: ChannelRuntimeStatusReporter,
  logger: { warn(message: string): void },
): ChannelRuntimeStatusReporter {
  return (channelKey, update) => {
    try {
      reporter(channelKey, update);
    } catch (error) {
      logger.warn(
        `[adapters] failed to write runtime status for ${channelKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}
