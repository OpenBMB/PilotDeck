import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { getRegisteredCommands } from "../../adapters/channel/protocol/ChannelCommandRegistry.js";
import { resolvePilotHome } from "../../pilot/index.js";
import type { CommandListItem, CommandsListInput, CommandsListResult, MatchRange } from "../protocol/types.js";
import { DialogGatewayError } from "./errors.js";

const PINNED = ["/skill_install", "/projects", "/switch-project"];
const WEB_BUILTINS: Array<[string, string]> = [
  ["/clear", "Clear the conversation history"], ["/model", "View the current AI model and available options"],
  ["/cost", "Display token usage and cost information"], ["/memory", "Open PILOTDECK.md memory file for editing"],
  ["/config", "Open settings and configuration"], ["/rewind", "Rewind the conversation to a previous state"],
  ["/ao", "List, run, or inspect Always-On jobs"], ["/turnkey", "Run turnkey workflow subcommands"],
  ["/skill_install", "Install a skill"],
];

export async function listCommands(input: CommandsListInput, configuredPilotHome?: string): Promise<CommandsListResult> {
  if (!input.projectKey) throw new DialogGatewayError("PROJECT_NOT_FOUND", "projectKey is required.");
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  if (query.length > 256) throw new DialogGatewayError("INVALID_QUERY", "query must not exceed 256 characters.");
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DialogGatewayError("INVALID_LIMIT", "limit must be an integer between 1 and 100.");

  const registry = getRegisteredCommands().filter((item) => item.name !== "new").map((item) => ({
    name: `/${item.name}`, description: item.description, namespace: "builtin", type: "builtin",
    metadata: { type: "builtin", source: "registry", ...(item.aliases ? { aliases: item.aliases } : {}) },
  } satisfies CommandListItem));
  const builtins = WEB_BUILTINS.map(([name, description]) => ({ name, description, namespace: "builtin", type: "builtin", metadata: { type: "builtin" } }));
  const builtin = dedupe([...builtins, ...registry]);
  const pilotHome = configuredPilotHome ?? resolvePilotHome(process.env);
  const [projectCommands, projectSkills, userCommands, userSkills] = await Promise.all([
    scanMarkdown(join(input.projectKey, ".pilotdeck", "commands"), "project", "command"),
    scanSkills(join(input.projectKey, ".pilotdeck", "skills"), "project"),
    scanMarkdown(join(pilotHome, "commands"), "user", "command"),
    scanSkills(join(pilotHome, "skills"), "user"),
  ]);
  const all = dedupe([...builtin, ...projectCommands, ...projectSkills, ...userCommands, ...userSkills]);
  const matched = all.map((item) => ({ ...item, matches: commandMatches(item, query) }))
    .filter((item) => !query || item.matches.length > 0);
  const pinned = PINNED.map((name) => matched.find((item) => item.name === name)).filter((item): item is CommandListItem & { matches: MatchRange[] } => Boolean(item));
  const unpinned = matched.filter((item) => !PINNED.includes(item.name)).sort((a, b) => {
    const rank = (value: CommandListItem) => value.namespace === "builtin" ? 0 : value.namespace === "project" ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const signature = Buffer.from(JSON.stringify({ projectKey: input.projectKey, query })).toString("base64url");
  const offset = decodeCursor(input.cursor, signature);
  const page = unpinned.slice(offset, offset + limit).map(cleanMatches);
  const nextOffset = offset + page.length;
  return {
    pinned: pinned.map((item) => cleanMatches({ ...item, namespace: "pinned" })),
    builtIn: page.filter((item) => item.namespace === "builtin"),
    custom: page.filter((item) => item.namespace !== "builtin"),
    ...(nextOffset < unpinned.length ? { nextCursor: Buffer.from(JSON.stringify({ offset: nextOffset, signature })).toString("base64url") } : {}),
  };
}

async function scanMarkdown(root: string, namespace: string, type: string): Promise<CommandListItem[]> {
  const output: CommandListItem[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const source = await readFile(path, "utf8").catch(() => "");
        const metadata = frontmatter(source);
        const rel = relative(root, path).split(sep).join("/");
        output.push({
          name: `/${rel.replace(/\.md$/i, "")}`, namespace, type, path, relativePath: rel,
          description: typeof metadata.description === "string" ? metadata.description : firstContentLine(source), metadata,
          ...(typeof metadata.argumentHint === "string" ? { argumentHint: metadata.argumentHint } : {}),
        });
      }
    }
  }
  await walk(root); return output;
}
async function scanSkills(root: string, namespace: string): Promise<CommandListItem[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const output: CommandListItem[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root, entry.name, "SKILL.md");
    const source = await readFile(path, "utf8").catch(() => undefined); if (!source) continue;
    const metadata = frontmatter(source);
    output.push({ name: `/${entry.name}`, namespace, type: "skill", path, relativePath: `${entry.name}/SKILL.md`, description: typeof metadata.description === "string" ? metadata.description : firstContentLine(source), metadata });
  }
  return output;
}
function frontmatter(source: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source); if (!match) return {};
  try { const parsed = parseYaml(match[1]); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
function firstContentLine(source: string): string { return source.replace(/^---[\s\S]*?---\s*/, "").split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "").trim() ?? ""; }
function dedupe(items: CommandListItem[]): CommandListItem[] { const seen = new Set<string>(); return items.filter((item) => !seen.has(item.name) && Boolean(seen.add(item.name))); }
function commandMatches(item: CommandListItem, query: string): MatchRange[] {
  if (!query) return [];
  const aliases = Array.isArray(item.metadata?.aliases) ? item.metadata.aliases.filter((value): value is string => typeof value === "string") : [];
  return [match("name", item.name, query), match("description", item.description ?? "", query), ...aliases.map((alias) => match("alias", alias, query))].flat();
}
function match(field: string, value: string, query: string): MatchRange[] { const lower = value.toLocaleLowerCase(); const result: MatchRange[] = []; let from = 0; while (from <= lower.length - query.length) { const start = lower.indexOf(query, from); if (start < 0) break; result.push({ field, start, end: start + query.length }); from = start + Math.max(1, query.length); } return result; }
function cleanMatches<T extends CommandListItem & { matches: MatchRange[] }>(item: T): CommandListItem { const { matches, ...rest } = item; return matches.length ? { ...rest, matches } : rest; }
function decodeCursor(value: string | undefined, signature: string): number { if (!value) return 0; try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (!Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.signature !== signature) throw new Error(); return parsed.offset; } catch { throw new DialogGatewayError("INVALID_CURSOR", "cursor is invalid or does not match the query."); } }
