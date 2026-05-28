import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput, stderr as defaultError } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { Gateway, GatewaySubmitTurnInput } from "../../../gateway/index.js";
import { connectRemoteGatewayIfAvailable, type ProbeGatewayServerOptions } from "../../../gateway/index.js";
import type { ChannelAdapter, ChannelHandle, ChannelStartDeps } from "../protocol/ChannelAdapter.js";
import { renderCliEvent } from "./cli-render.js";

export type CliChannelOptions = {
  argv?: string[];
  projectKey?: string;
  sessionKey?: string;
  input?: Readable;
  output?: Writable;
  error?: Writable;
  probe?: ProbeGatewayServerOptions | false;
};

export class CliChannel implements ChannelAdapter {
  readonly channelKey = "cli";
  private stopped = false;

  constructor(private readonly options: CliChannelOptions = {}) {}

  async start(deps: ChannelStartDeps): Promise<ChannelHandle> {
    const gateway = await this.resolveGateway(deps.gateway);
    const prompt = this.options.argv?.join(" ").trim();
    if (prompt) {
      await this.submitAndRender(gateway, prompt);
    } else {
      await this.runInteractive(gateway);
    }
    return { stop: async () => this.stop() };
  }

  private async resolveGateway(fallback: Gateway): Promise<Gateway> {
    if (this.options.probe === false) {
      return fallback;
    }
    const remote = await connectRemoteGatewayIfAvailable(this.options.probe);
    if (remote) {
      return remote;
    }
    this.writeError("[pilotdeck] gateway server unavailable; using in-process mode.\n");
    return fallback;
  }

  private async runInteractive(gateway: Gateway): Promise<void> {
    const rl = createInterface({
      input: this.options.input ?? defaultInput,
      output: this.options.output ?? defaultOutput,
      terminal: false,
    });
    for await (const line of rl) {
      if (this.stopped) {
        break;
      }
      const text = line.trim();
      if (!text) {
        continue;
      }
      await this.submitAndRender(gateway, text);
      this.writeOutput("\n");
    }
  }

  private async submitAndRender(gateway: Gateway, message: string): Promise<void> {
    const input: GatewaySubmitTurnInput = {
      sessionKey: this.options.sessionKey ?? defaultCliSessionKey(this.options.projectKey),
      channelKey: "cli",
      projectKey: this.options.projectKey,
      message,
    };
    for await (const event of gateway.submitTurn(input)) {
      const rendered = renderCliEvent(event);
      if (rendered) {
        this.writeOutput(rendered);
      }
    }
  }

  private async stop(): Promise<void> {
    this.stopped = true;
  }

  private writeOutput(value: string): void {
    (this.options.output ?? defaultOutput).write(value);
  }

  private writeError(value: string): void {
    (this.options.error ?? defaultError).write(value);
  }
}

export function defaultCliSessionKey(projectKey = process.cwd()): string {
  return `cli:project=${projectKey}:default`;
}
