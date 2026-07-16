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
  deliverCronResult(delivery: CronResultDelivery): Promise<boolean>;
};

export async function startPilotDeckServer(options: StartPilotDeckServerOptions): Promise<PilotDeckServer> {
  const consoleLogger = {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
  const reportChannelStatus = createSafeChannelStatusReporter(
    createChannelRuntimeStatusReporter(resolvePilotHome(process.env)),
    consoleLogger,
  );
  const baseDeps = {
    gateway: options.gateway,
    config: options.config,
    logger: consoleLogger,
    reportChannelStatus,
  };

  const runningHandles = new Map<string, ChannelHandle>();
  const runningChannels = new Map<string, ChannelAdapter>();
  const channelStarts = new Map<string, Promise<void>>();

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
    feishuWebhook: options.feishu
      ? (request, response, body) => options.feishu!.handleWebhook(request, response, body)
      : undefined,
  });

  function startChannelInBackground(channel: ChannelAdapter): Promise<void> {
    const start = startAndTrack(channel)
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
      })
      .finally(() => {
        channelStarts.delete(channel.channelKey);
      });
    channelStarts.set(channel.channelKey, start);
    return start;
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
