import type { ChannelAdapter } from "./protocol/ChannelAdapter.js";
import type { PilotAdaptersConfig, PilotPlatformAdapterConfig } from "../../pilot/config/types.js";

/**
 * Lazily import + instantiate every channel whose config has `enabled: true`.
 * Each entry maps a config key to a dynamic loader for the matching channel folder.
 */
const CHANNEL_LOADERS: Record<
  string,
  (cfg: PilotPlatformAdapterConfig) => Promise<ChannelAdapter>
> = {
  telegram: async (cfg) => {
    const { TelegramChannel } = await import("./telegram/TelegramChannel.js");
    return new TelegramChannel({
      token: cfg.token,
      webhookUrl: cfg.webhookUrl,
    });
  },
  discord: async (cfg) => {
    const { DiscordChannel } = await import("./discord/DiscordChannel.js");
    return new DiscordChannel({ token: cfg.token });
  },
  slack: async (cfg) => {
    const { SlackChannel } = await import("./slack/SlackChannel.js");
    return new SlackChannel({
      botToken: cfg.token,
      appToken: cfg.extra?.appToken as string | undefined,
    });
  },
  matrix: async (cfg) => {
    const { MatrixChannel } = await import("./matrix/MatrixChannel.js");
    return new MatrixChannel({
      accessToken: cfg.token,
      homeserver: cfg.extra?.homeserver as string | undefined,
      userId: cfg.extra?.userId as string | undefined,
    });
  },
  mattermost: async (cfg) => {
    const { MattermostChannel } = await import("./mattermost/MattermostChannel.js");
    return new MattermostChannel({
      token: cfg.token,
      serverUrl: cfg.extra?.serverUrl as string | undefined,
      teamId: cfg.extra?.teamId as string | undefined,
    });
  },
  signal: async (cfg) => {
    const { SignalChannel } = await import("./signal/SignalChannel.js");
    return new SignalChannel({
      restUrl: cfg.extra?.restUrl as string | undefined,
      account: cfg.extra?.account as string | undefined,
    });
  },
  whatsapp: async (cfg) => {
    const { WhatsAppChannel } = await import("./whatsapp/WhatsAppChannel.js");
    return new WhatsAppChannel({
      bridgePath: cfg.extra?.bridgePath as string | undefined,
      bridgeUrl: cfg.extra?.bridgeUrl as string | undefined,
    });
  },
  bluebubbles: async (cfg) => {
    const { BlueBubblesChannel } = await import("./bluebubbles/BlueBubblesChannel.js");
    return new BlueBubblesChannel({
      serverUrl: cfg.extra?.serverUrl as string | undefined,
      password: cfg.token ?? (cfg.extra?.password as string | undefined),
    });
  },
  dingtalk: async (cfg) => {
    const { DingTalkChannel } = await import("./dingtalk/DingTalkChannel.js");
    return new DingTalkChannel({
      clientId: cfg.extra?.clientId as string | undefined,
      clientSecret: cfg.extra?.clientSecret as string | undefined,
    });
  },
  wecom: async (cfg) => {
    const { WeComChannel } = await import("./wecom/WeComChannel.js");
    return new WeComChannel({
      botKey: cfg.token,
      extra: cfg.extra,
    });
  },
  wecomCallback: async (cfg) => {
    const { WeComCallbackChannel } = await import("./wecom-callback/WeComCallbackChannel.js");
    return new WeComCallbackChannel({
      corpId: cfg.extra?.corpId as string | undefined,
      agentId: cfg.extra?.agentId as string | undefined,
      secret: cfg.extra?.secret as string | undefined,
      token: cfg.token,
      encodingAesKey: cfg.extra?.encodingAesKey as string | undefined,
      port: cfg.extra?.port as number | undefined,
    });
  },
  email: async (cfg) => {
    const { EmailChannel } = await import("./email/EmailChannel.js");
    return new EmailChannel({ extra: cfg.extra });
  },
  sms: async (cfg) => {
    const { SmsChannel } = await import("./sms/SmsChannel.js");
    return new SmsChannel({ extra: cfg.extra });
  },
  homeassistant: async (cfg) => {
    const { HomeAssistantChannel } = await import("./homeassistant/HomeAssistantChannel.js");
    return new HomeAssistantChannel({
      url: cfg.extra?.url as string | undefined,
      token: cfg.token,
    });
  },
  apiServer: async (cfg) => {
    const { ApiServerChannel } = await import("./api-server/ApiServerChannel.js");
    return new ApiServerChannel({
      port: cfg.extra?.port as number | undefined,
      apiKey: cfg.apiKey,
    });
  },
  webhook: async (cfg) => {
    const { WebhookChannel } = await import("./webhook/WebhookChannel.js");
    return new WebhookChannel({
      port: cfg.extra?.port as number | undefined,
      secret: cfg.extra?.secret as string | undefined,
    });
  },
};

export async function loadEnabledChannels(adapters: PilotAdaptersConfig | undefined): Promise<ChannelAdapter[]> {
  if (!adapters) return [];
  const channels: ChannelAdapter[] = [];

  for (const [key, loader] of Object.entries(CHANNEL_LOADERS)) {
    const cfg = (adapters as Record<string, unknown>)[key] as PilotPlatformAdapterConfig | undefined;
    if (!cfg?.enabled) continue;

    try {
      channels.push(await loader(cfg));
    } catch (e) {
      console.error(`[adapters] Failed to load channel "${key}": ${e}`);
    }
  }

  return channels;
}
