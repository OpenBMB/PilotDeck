import { spawn } from "node:child_process";
import type { Gateway } from "../../../gateway/index.js";
import { connectRemoteGatewayIfAvailable, type ProbeGatewayServerOptions } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { applyTuiEvent, createTuiRenderState, type TuiRenderState } from "./tui-render.js";
import React from "react";
import { render, type Instance } from "ink";
import { TuiApp, type TuiAppProps } from "./app/TuiApp.js";

export type TuiChannelOptions = {
  projectKey?: string;
  sessionKey?: string;
  probe?: ProbeGatewayServerOptions | false;
  model?: string;
  cwd?: string;
  serverUrl?: string;
  interactive?: boolean;
};

export class TuiChannel implements ChannelAdapter {
  readonly channelKey = "tui";
  readonly state: TuiRenderState = createTuiRenderState();
  private stopped = false;
  private instance?: Instance;

  constructor(private readonly options: TuiChannelOptions = {}) {}

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    const { gateway, connection } = await this.resolveGateway(deps.gateway);
    if (this.options.interactive === false) {
      return { stop: async () => this.stop() };
    }

    const appProps: TuiAppProps = {
      gateway,
      connection,
      projectKey: this.options.projectKey,
      sessionKey: this.options.sessionKey,
      model: this.options.model,
      cwd: this.options.cwd,
      serverUrl: this.options.serverUrl ?? (connection === "remote" ? this.options.probe && typeof this.options.probe === "object" ? this.options.probe.url : undefined : undefined),
      onViewOutput: async (path: string) => {
        this.instance?.unmount();
        const pager = process.env.PAGER || "less";
        try {
          const child = spawn(pager, [path], { stdio: "inherit" });
          await new Promise<void>((resolve) => child.on("exit", () => resolve()));
        } catch { /* pager failed, continue */ }
        this.instance = render(React.createElement(TuiApp, appProps));
      },
    };

    this.instance = render(React.createElement(TuiApp, appProps));
    await this.instance.waitUntilExit();
    return { stop: async () => this.stop() };
  }

  async submit(gateway: Gateway, message: string): Promise<TuiRenderState> {
    for await (const event of gateway.submitTurn({
      sessionKey: this.options.sessionKey ?? defaultTuiSessionKey(this.options.projectKey),
      channelKey: "tui",
      projectKey: this.options.projectKey,
      message,
    })) {
      applyTuiEvent(this.state, event);
    }
    return this.state;
  }

  private async resolveGateway(fallback: Gateway): Promise<{ gateway: Gateway; connection: "remote" | "in_process" }> {
    if (this.options.probe === false) {
      return { gateway: fallback, connection: "in_process" };
    }
    const remote = await connectRemoteGatewayIfAvailable({ ...this.options.probe, timeoutMs: 200 });
    return remote ? { gateway: remote, connection: "remote" } : { gateway: fallback, connection: "in_process" };
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    this.instance?.unmount();
  }
}

export function defaultTuiSessionKey(projectKey = process.cwd()): string {
  return `tui:project=${projectKey}:default`;
}
