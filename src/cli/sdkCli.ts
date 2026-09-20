import { readFile } from "node:fs/promises";
import { resolveGatewayTokenPath } from "../gateway/server/authToken.js";
import {
  createPilotDeckClient,
  resolveSettings,
  updateSettings,
  type PilotDeckClient,
  type PilotDeckMessage,
  type PilotDeckOptions,
  type PilotDeckResult,
} from "@pilotdeck/sdk";

const VALUE_FLAGS = new Set([
  "--gateway-url",
  "--auth-token",
  "--project",
  "--channel",
  "--model",
  "--permission-mode",
]);

export async function runSdkCli(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "run" || command === "resume") {
    await runTurn(command, argv.slice(1));
    return;
  }
  if (command === "sessions") {
    await runSessionsCommand(argv.slice(1));
    return;
  }
  if (command === "settings") {
    await runSettingsCommand(argv.slice(1));
    return;
  }
  throw new Error("Usage: pilotdeck <run|resume|sessions|settings> ...");
}

async function runTurn(command: "run" | "resume", argv: string[]): Promise<void> {
  const connection = await readConnection(argv);
  const projectKey = readValue(argv, "--project") ?? process.cwd();
  const channelKey = readValue(argv, "--channel") ?? "cli";
  const client = createClient(connection, projectKey);
  let onSignal: (() => void) | undefined;
  try {
    let sessionId: string;
    if (command === "run") {
      sessionId = (await client.sessions.create({ projectKey, channelKey })).sessionId;
    } else {
      sessionId = positional(argv, command)[0] ?? "";
      if (!sessionId) throw new Error("Usage: pilotdeck resume <session-id> <prompt>");
      await client.sessions.resume(sessionId, { projectKey });
    }
    const prompt = await readPrompt(argv, command === "resume" ? 1 : 0);
    if (!prompt) throw new Error("A prompt is required, or provide it through stdin.");
    const run = client.runs.start({
      sessionId,
      input: { type: "text", text: prompt },
      options: {
        projectKey,
        model: readValue(argv, "--model"),
        permissionMode: readValue(argv, "--permission-mode") as PilotDeckOptions["permissionMode"],
      },
    });
    onSignal = () => { void run.abort("CLI interrupted"); };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const { result, streamedText } = await consumeRun(run, argv.includes("--stream-json"));
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ sessionId, result }));
    } else if (result.status !== "completed" || !streamedText) {
      const output = result.status === "completed" ? result.output : result;
      if (output !== undefined) console.log(typeof output === "string" ? output : JSON.stringify(output));
    }
    if (result.status !== "completed") process.exitCode = 1;
  } finally {
    if (onSignal) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    await client.close();
  }
}

function printHelp(): void {
  console.log(`PilotDeck SDK CLI

  pilotdeck run <prompt> [options]
  pilotdeck resume <session-id> <prompt> [options]
  pilotdeck sessions list [options]
  pilotdeck sessions messages <session-id> [options]
  pilotdeck settings get [options]
  pilotdeck settings set '<json>' [options]

Options:
  --gateway-url <url>       Gateway WebSocket URL
  --auth-token <token>      Gateway auth token
  --project <path>          Project key (defaults to cwd)
  --channel <name>          Session channel (defaults to cli)
  --model <provider/model>  Session model override
  --permission-mode <mode>  Session permission mode
  --json                    Print the final run/result as JSON
  --stream-json             Print each run event as JSONL`);
}

async function consumeRun(run: ReturnType<PilotDeckClient["runs"]["start"]>, jsonEvents: boolean): Promise<{ result: PilotDeckResult; streamedText: boolean }> {
  let streamedText = false;
  for await (const event of run.events()) {
    if (jsonEvents) {
      console.log(JSON.stringify(event));
      continue;
    }
    const text = eventText(event);
    if (text) {
      process.stdout.write(text);
      streamedText = true;
    }
  }
  const result = await run.result();
  if (streamedText && result.status === "completed") process.stdout.write("\n");
  return { result, streamedText };
}

function eventText(event: PilotDeckMessage): string {
  if (!event.type.includes("assistant") && event.type !== "subagent.message") return "";
  if (typeof event.text === "string") return event.text;
  if (typeof event.delta === "string") return event.delta;
  return "";
}

async function runSessionsCommand(argv: string[]): Promise<void> {
  const connection = await readConnection(argv);
  const projectKey = readValue(argv, "--project") ?? process.cwd();
  const client = createClient(connection, projectKey);
  try {
    const subcommand = argv[0] ?? "list";
    if (subcommand === "list") {
      console.log(JSON.stringify(await client.sessions.list({ projectKey }), null, 2));
      return;
    }
    if (subcommand === "messages") {
      const sessionId = positional(argv.slice(1), "messages")[0];
      if (!sessionId) throw new Error("Usage: pilotdeck sessions messages <session-id>");
      console.log(JSON.stringify(await client.sessions.messages(sessionId, { projectKey }), null, 2));
      return;
    }
    throw new Error("Usage: pilotdeck sessions <list|messages> ...");
  } finally {
    await client.close();
  }
}

async function runSettingsCommand(argv: string[]): Promise<void> {
  const connection = await readConnection(argv);
  const subcommand = argv[0] ?? "get";
  if (subcommand === "get") {
    console.log(JSON.stringify(await resolveSettings(connection), null, 2));
    return;
  }
  if (subcommand === "set") {
    const raw = readValue(argv.slice(1), "--json") ?? positional(argv.slice(1), "set").join(" ");
    if (!raw) throw new Error("Usage: pilotdeck settings set '<json>'");
    let settings: unknown;
    try {
      settings = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid settings JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    await updateSettings(connection, settings as Parameters<typeof updateSettings>[1]);
    console.log(JSON.stringify({ updated: true }));
    return;
  }
  throw new Error("Usage: pilotdeck settings <get|set> ...");
}

async function readConnection(argv: string[]): Promise<{ gatewayUrl: string; authToken: string }> {
  const gatewayUrl = readValue(argv, "--gateway-url")
    ?? process.env.PILOTDECK_SDK_GATEWAY_URL
    ?? process.env.PILOTDECK_GATEWAY_URL
    ?? `ws://127.0.0.1:${process.env.PILOTDECK_GATEWAY_PORT ?? "18789"}/ws`;
  const authToken = readValue(argv, "--auth-token")
    ?? process.env.PILOTDECK_SDK_AUTH_TOKEN
    ?? process.env.PILOTDECK_TOKEN
    ?? (await readFile(resolveGatewayTokenPath(), "utf8").catch(() => "")).trim();
  if (!authToken) throw new Error("Gateway auth token is required. Set PILOTDECK_TOKEN or pass --auth-token.");
  return { gatewayUrl, authToken };
}

function createClient(connection: { gatewayUrl: string; authToken: string }, projectKey: string): PilotDeckClient {
  return createPilotDeckClient({ ...connection, projectKey, clientVersion: "pilotdeck-cli" });
}

async function readPrompt(argv: string[], positionalIndex: number): Promise<string> {
  const value = positional(argv, positionalIndex === 1 ? "resume" : "run").slice(positionalIndex).join(" ").trim();
  if (value) return value;
  if (!process.stdin.isTTY) return (await readFile("/dev/stdin", "utf8")).trim();
  return "";
}

function positional(argv: string[], _command: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    values.push(value);
  }
  return values;
}

function readValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
