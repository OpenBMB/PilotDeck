import type { ChannelAttachment, Gateway, GatewayChannelKey } from "../../../gateway/index.js";
import type { CronResultDelivery } from "../../../cron/index.js";
import type { PilotConfig } from "../../../pilot/index.js";
import type { ChannelRuntimeStatusReporter } from "./ChannelRuntimeStatus.js";

export type ChannelLogger = {
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
};

export type ChannelStartDeps = {
  gateway: Gateway;
  config?: PilotConfig;
  logger?: ChannelLogger;
  reportChannelStatus?: ChannelRuntimeStatusReporter;
};

export type ChannelHandle = {
  stop(reason?: string): Promise<void>;
};

export interface ChannelAdapter {
  readonly channelKey: GatewayChannelKey;
  start(deps: ChannelStartDeps): Promise<ChannelHandle>;
  deliverCronResult?(delivery: CronResultDelivery): Promise<boolean> | boolean;
}

export type ChannelMessage = {
  sessionKey: string;
  text: string;
  projectKey?: string;
  attachments?: ChannelAttachment[];
};
