export type GatewayStatus = {
  feishu: {
    enabled: boolean;
    appId: string;
    hasSecret: boolean;
    connectionMode: string;
    domainName: string;
  };
  weixin: {
    enabled: boolean;
    hasCredentials: boolean;
    accountId: string | null;
    runtime?: {
      state:
        | "starting"
        | "connected"
        | "waiting_for_login"
        | "expired"
        | "failed"
        | "stopped";
      message?: string;
      accountId?: string;
      error?: string;
      qrUrl?: string;
      updatedAt?: string;
    } | null;
  };
  wecom: {
    enabled: boolean;
    botId: string;
    hasSecret: boolean;
    websocketUrl: string;
    dmPolicy: string;
    groupPolicy: string;
    allowFrom: string[];
    groupAllowFrom: string[];
  };
  /** Absent when talking to an older server without Slack/Telegram support. */
  slack?: {
    enabled: boolean;
    hasBotToken: boolean;
    hasAppToken: boolean;
    botTokenHint: string;
    runtime?: ChannelRuntime | null;
  };
  telegram?: {
    enabled: boolean;
    hasToken: boolean;
    tokenHint: string;
    runtime?: ChannelRuntime | null;
  };
};

export type ChannelRuntime = {
  state: "starting" | "connected" | "waiting_for_login" | "expired" | "failed" | "stopped";
  message?: string;
  accountId?: string;
  error?: string;
  updatedAt?: string;
};

export type TestResult = { ok: boolean; message?: string; error?: string } | null;
export type WeComAccessPolicy = "open" | "allowlist" | "disabled";
