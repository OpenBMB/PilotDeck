import type { ChannelAdapter } from "../adapters/index.js";
import { FeishuChannel } from "../adapters/index.js";
import { WeixinChannel } from "../adapters/index.js";
import { QQChannel } from "../adapters/index.js";
import type { Gateway } from "../gateway/index.js";
import { startGatewayServer, type GatewayServer } from "../gateway/index.js";
import type { PilotConfig } from "../pilot/index.js";

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

export async function startPilotDeckServer(options: StartPilotDeckServerOptions): Promise<GatewayServer> {
  const consoleLogger = {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
  const baseDeps = { gateway: options.gateway, config: options.config, logger: consoleLogger };

  await options.feishu?.start(baseDeps);
  await options.weixin?.start(baseDeps);
  await options.qq?.start(baseDeps);

  if (options.channels?.length) {
    await Promise.all(
      options.channels.map((ch) =>
        ch.start(baseDeps).catch((e) => {
          console.error(`[adapters] channel ${ch.channelKey} start failed: ${e}`);
        }),
      ),
    );
  }

  return startGatewayServer({
    gateway: options.gateway,
    port: options.port,
    host: options.host,
    staticAssetsPath: options.staticAssetsPath,
    feishuWebhook: options.feishu
      ? (request, response, body) => options.feishu!.handleWebhook(request, response, body)
      : undefined,
  });
}
