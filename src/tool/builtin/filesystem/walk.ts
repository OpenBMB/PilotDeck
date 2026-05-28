import { readdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist"]);

export async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, root, files);
  return files;
}

async function walk(root: string, current: string, files: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files);
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }
}
