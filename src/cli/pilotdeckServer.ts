import type { ChannelAdapter, ChannelHandle } from "../adapters/index.js";
import type { CronResultDelivery } from "../cron/index.js";
import { FeishuChannel } from "../adapters/index.js";
import { WeixinChannel } from "../adapters/index.js";
import { QQChannel } from "../adapters/index.js";
import type { Gateway, GatewayChannelKey } from "../gateway/index.js";
import { startGatewayServer, type GatewayServer } from "../gateway/index.js";
import { resolvePilotHome, type PilotConfig } from "../pilot/index.js";
import {
  createProjectSessionSearchPort,
  type ProjectSessionStorageProvider,
} from "../session/index.js";
import type { SessionSearchPort } from "../session/search/SessionSearchPort.js";
import {
  createChannelRuntimeStatusReporter,
  type ChannelRuntimeStatusReporter,
} from "../adapters/channel/protocol/ChannelRuntimeStatus.js";
import type {
  ChannelLifecyclePort,
  ChannelLifecycleReconcileInput,
  ChannelLifecycleReconcileResult,
} from "./ChannelLifecyclePort.js";

export type StartPilotDeckServerOptions = {
  gateway: Gateway;
  port?: number;
  host?: string;
  allowRemoteHost?: boolean;
  token?: string;
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
  pilotHome?: string;
  sessionSearch?: SessionSearchPort;
  /** Selected durable backend used when the search capability is not explicit. */
  storageProvider?: ProjectSessionStorageProvider;
};

export type PilotDeckServer = GatewayServer & ChannelLifecyclePort & {
  /**
   * Hot-start a channel adapter after server startup.
   * Stops any previously running instance of the same channelKey first.
   */
  deliverCronResult(delivery: CronResultDelivery): Promise<boolean>;
};

export async function startPilotDeckServer(options: StartPilotDeckServerOptions): Promise<PilotDeckServer> {
  const pilotHome = options.pilotHome ?? resolvePilotHome(process.env);
  const sessionSearch = options.sessionSearch ?? createProjectSessionSearchPort({
    storageProvider: options.storageProvider,
  });
  const consoleLogger = {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
  const reportChannelStatus = createSafeChannelStatusReporter(
    createChannelRuntimeStatusReporter(pilotHome),
    consoleLogger,
  );
  const baseDeps = {
    gateway: options.gateway,
    config: options.config,
    logger: consoleLogger,
    reportChannelStatus,
    sessionSearch,
    pilotHome,
  };

  const runningHandles = new Map<string, ChannelHandle>();
  const runningChannels = new Map<string, ChannelAdapter>();
  const channelStarts = new Map<string, Promise<void>>();
  const channelOperations = new Map<string, Promise<void>>();
  let activeFeishu: FeishuChannel | undefined = options.feishu;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  async function startAndTrack(ch: ChannelAdapter): Promise<void> {
    if (closing) {
      throw new Error("channel server is closing");
    }
    reportChannelStatus(ch.channelKey, {
      state: "starting",
      message: `${ch.channelKey}: starting in background`,
    });
    const handle = await ch.start(baseDeps);
    if (closing) {
      await handle.stop("server-shutdown");
      reportChannelStatus(ch.channelKey, {
        state: "stopped",
        message: `${ch.channelKey}: startup completed after server shutdown`,
      });
      throw new Error("channel server is closing");
    }
    runningHandles.set(ch.channelKey, handle);
    runningChannels.set(ch.channelKey, ch);
    if (isFeishuChannel(ch)) {
      activeFeishu = ch;
    }
    reportChannelStatus(ch.channelKey, {
      state: "connected",
      message: `${ch.channelKey}: started`,
    });
  }

  async function stopRunningChannel(channelKey: GatewayChannelKey, reason: string): Promise<boolean> {
    const handle = runningHandles.get(channelKey);
    if (!handle) return false;
    const channel = runningChannels.get(channelKey);
    // Claim the exact handle before awaiting its shutdown so a concurrent
    // server close cannot stop it twice.
    runningHandles.delete(channelKey);
    runningChannels.delete(channelKey);
    try {
      await handle.stop(reason);
    } catch (error) {
      if (!runningHandles.has(channelKey) && channel) {
        runningHandles.set(channelKey, handle);
        runningChannels.set(channelKey, channel);
      }
      const message = error instanceof Error ? error.message : String(error);
      reportChannelStatus(channelKey, {
        state: "failed",
        message: `${channelKey}: stop failed`,
        error: message,
      });
      throw error;
    }
    if (reason !== "hot-reload" && activeFeishu === channel) {
      activeFeishu = undefined;
    }
    reportChannelStatus(channelKey, {
      state: "stopped",
      message: `${channelKey}: stopped (${reason})`,
    });
    return true;
  }

  async function replaceChannel(channel: ChannelAdapter): Promise<void> {
    if (closing) {
      throw new Error("channel server is closing");
    }
    const previousHandle = runningHandles.get(channel.channelKey);
    const previousChannel = runningChannels.get(channel.channelKey);
    if (previousHandle && previousChannel) {
      await stopRunningChannel(channel.channelKey, "hot-reload");
    }
    try {
      await startAndTrack(channel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportChannelStatus(channel.channelKey, {
        state: "failed",
        message: `${channel.channelKey}: startup failed`,
        error: message,
      });
      if (previousChannel) {
        try {
          await startAndTrack(previousChannel);
          consoleLogger.warn(`[adapters] channel ${channel.channelKey} replacement failed; restored previous adapter`);
        } catch (restoreError) {
          const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
          reportChannelStatus(channel.channelKey, {
            state: "failed",
            message: `${channel.channelKey}: rollback failed`,
            error: restoreMessage,
          });
          throw new AggregateError([error, restoreError], `channel ${channel.channelKey} replacement and rollback failed`);
        }
      }
      throw error;
    }
  }

  function enqueueChannelOperation<T>(channelKey: GatewayChannelKey, operation: () => Promise<T>): Promise<T> {
    const previous = channelOperations.get(channelKey) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    channelOperations.set(channelKey, settled);
    void settled.finally(() => {
      if (channelOperations.get(channelKey) === settled) {
        channelOperations.delete(channelKey);
      }
    });
    return current;
  }

  async function reconcileChannels(input: ChannelLifecycleReconcileInput): Promise<ChannelLifecycleReconcileResult> {
    if (closing) {
      throw new Error("channel server is closing");
    }
    const desired = new Map<GatewayChannelKey, ChannelAdapter>();
    for (const channel of input.channels) {
      if (desired.has(channel.channelKey)) {
        throw new Error(`duplicate channel adapter in reconciliation: ${channel.channelKey}`);
      }
      desired.set(channel.channelKey, channel);
    }

    const managed = new Set(input.managedChannelKeys);
    const stopped: GatewayChannelKey[] = [];
    for (const channelKey of managed) {
      if (desired.has(channelKey)) continue;
      const didStop = await enqueueChannelOperation(channelKey, () => stopRunningChannel(channelKey, "config-disabled"));
      if (didStop) stopped.push(channelKey);
    }

    const started: GatewayChannelKey[] = [];
    for (const channel of desired.values()) {
      await enqueueChannelOperation(channel.channelKey, () => replaceChannel(channel));
      started.push(channel.channelKey);
    }
    return { started, stopped };
  }

  function closeServer(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    activeFeishu = undefined;
    closePromise = (async () => {
      const stopResults = await Promise.allSettled(
        [...runningHandles.keys()].map((channelKey) => stopRunningChannel(channelKey as GatewayChannelKey, "server-shutdown")),
      );
      let closeError: unknown;
      try {
        await closeGatewayServer();
      } catch (error) {
        closeError = error;
      }
      const stopErrors = stopResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (closeError || stopErrors.length > 0) {
        throw new AggregateError(
          [...stopErrors, ...(closeError ? [closeError] : [])],
          "PilotDeck server shutdown failed",
        );
      }
    })();
    return closePromise;
  }

  const gwServer = await startGatewayServer({
    gateway: options.gateway,
    port: options.port,
    host: options.host,
    allowRemoteHost: options.allowRemoteHost,
    token: options.token,
    staticAssetsPath: options.staticAssetsPath,
    feishuWebhook: (request, response, body) =>
      activeFeishu?.handleWebhook(request, response, body) ?? false,
  });
  const closeGatewayServer = gwServer.close.bind(gwServer);

  function startChannelInBackground(channel: ChannelAdapter): void {
    const start = enqueueChannelOperation(channel.channelKey, () => replaceChannel(channel))
      .then(() => consoleLogger.info(`[adapters] channel ${channel.channelKey} startup task completed`))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        consoleLogger.error(`[adapters] channel ${channel.channelKey} start failed: ${message}`);
      })
      .finally(() => {
        channelStarts.delete(channel.channelKey);
    });
    channelStarts.set(channel.channelKey, start);
  }

  const startupChannels = [
    ...(options.feishu ? [options.feishu] : []),
    ...(options.weixin ? [options.weixin] : []),
    ...(options.qq ? [options.qq] : []),
    ...(options.channels ?? []),
  ];
  for (const channel of startupChannels) {
    startChannelInBackground(channel);
  }

  return Object.assign(gwServer, {
    close: closeServer,
    hotStartChannel(channel: ChannelAdapter) {
      if (closing) return Promise.reject(new Error("channel server is closing"));
      return enqueueChannelOperation(channel.channelKey, () => replaceChannel(channel));
    },
    reconcileChannels,
    async deliverCronResult(delivery: CronResultDelivery) {
      const channel = runningChannels.get(delivery.originChannelKey ?? delivery.channelKey);
      if (!channel?.deliverCronResult) return false;
      return channel.deliverCronResult(delivery);
    },
  });
}

function isFeishuChannel(channel: ChannelAdapter): channel is FeishuChannel {
  return channel.channelKey === "feishu" && typeof (channel as Partial<FeishuChannel>).handleWebhook === "function";
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
