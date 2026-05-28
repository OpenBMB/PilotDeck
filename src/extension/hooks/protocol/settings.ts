import type { PilotDeckHookEvent } from "./events.js";

export type PilotDeckHookCommand =
  | {
      type: "command";
      command: string;
      if?: string;
      shell?: "bash" | "powershell";
      statusMessage?: string;
      once?: boolean;
      async?: boolean;
      asyncRewake?: boolean;
      timeout?: number;
    }
  | {
      type: "prompt";
      prompt: string;
      if?: string;
      model?: string;
      statusMessage?: string;
      once?: boolean;
      timeout?: number;
    }
  | {
      type: "http";
      url: string;
      if?: string;
      headers?: Record<string, string>;
      allowedEnvVars?: string[];
      statusMessage?: string;
      once?: boolean;
      timeout?: number;
    }
  | {
      type: "agent";
      prompt: string;
      if?: string;
      model?: string;
      statusMessage?: string;
      once?: boolean;
      timeout?: number;
    }
  | {
      type: "callback";
      name: string;
      if?: string;
      statusMessage?: string;
    };

export type PilotDeckHookMatcher = {
  matcher?: string;
  hooks: PilotDeckHookCommand[];
  pluginName?: string;
  pluginId?: string;
  pluginRoot?: string;
};

export type PilotDeckHooksSettings = Partial<Record<PilotDeckHookEvent, PilotDeckHookMatcher[]>>;
