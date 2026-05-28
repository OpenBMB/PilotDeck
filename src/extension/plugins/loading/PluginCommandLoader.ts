import { basename, dirname, relative } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

export type LoadedPluginCommand = {
  name: string;
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  isSkill: boolean;
};

export async function loadPluginCommands(options: {
  pluginName: string;
  baseDir: string;
}): Promise<LoadedPluginCommand[]> {
  const files = await collectMarkdownFiles(options.baseDir);
  return Promise.all(
    files.map(async (filePath) => {
      const raw = await readFile(filePath, "utf8");
      const parsed = parseMarkdownFrontmatter(raw);
      return {
        name: getPluginCommandName(options.pluginName, filePath, options.baseDir),
        path: filePath,
        content: parsed.content,
        frontmatter: parsed.frontmatter,
        isSkill: isSkillFile(filePath),
      };
    }),
  );
}

export function getPluginCommandName(pluginName: string, filePath: string, baseDir: string): string {
  const baseName = isSkillFile(filePath) ? basename(dirname(filePath)) : basename(filePath).replace(/\.md$/iu, "");
  const namespaceRoot = isSkillFile(filePath) ? dirname(dirname(filePath)) : dirname(filePath);
  const namespace = relative(baseDir, namespaceRoot)
    .split(/[\\/]/u)
    .filter(Boolean)
    .join(":");

  return namespace ? `${pluginName}:${namespace}:${baseName}` : `${pluginName}:${baseName}`;
}

function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/iu.test(basename(filePath));
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return output;
  }

  for (const entry of entries) {
    const fullPath = `${directory}/${entry}`;
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }
    if (entryStat.isDirectory()) {
      output.push(...await collectMarkdownFiles(fullPath));
    } else if (/\.md$/iu.test(entry)) {
      output.push(fullPath);
    }
  }
  return output;
}

function parseMarkdownFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, content: raw };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, content: raw };
  }
  const frontmatter: Record<string, unknown> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      frontmatter[key] = parseScalar(value);
    }
  }
  return { frontmatter, content: raw.slice(end + 5) };
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  const numberValue = Number(value);
  if (value !== "" && Number.isFinite(numberValue)) return numberValue;
  return value.replace(/^["']|["']$/gu, "");
}
