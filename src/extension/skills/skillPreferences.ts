import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SkillAddressInput } from "./types.js";

export type SkillPreferences = { version: 1; disabled: string[] };

function preferenceKey(input: SkillAddressInput): string {
  const project = input.scope === "project" ? resolve(input.projectKey!) : null;
  return JSON.stringify([input.scope, process.platform === "win32" ? project?.toLowerCase() ?? null : project, input.slug]);
}

export function readSkillPreferences(pilotHome: string): SkillPreferences {
  let raw: string;
  try {
    raw = readFileSync(join(pilotHome, "skill-preferences.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, disabled: [] };
    throw error;
  }
  const value = JSON.parse(raw) as SkillPreferences;
  if (value?.version !== 1 || !Array.isArray(value.disabled) || value.disabled.some(key => typeof key !== "string")) {
    throw new Error("Invalid skill-preferences.json. Restore or repair the preferences before changing skills.");
  }
  return value;
}

export function isSkillEnabled(preferences: SkillPreferences, input: SkillAddressInput): boolean {
  return !preferences.disabled.includes(preferenceKey(input));
}

/** The single Gateway owns writes. Synchronous read/modify/rename keeps
 * concurrent requests from losing other skills' changes, including on Windows. */
export function writeSkillEnabled(pilotHome: string, input: SkillAddressInput, enabled: boolean): void {
  const preferences = readSkillPreferences(pilotHome);
  const key = preferenceKey(input);
  const disabled = preferences.disabled.filter(entry => entry !== key);
  if (!enabled) disabled.push(key);
  mkdirSync(pilotHome, { recursive: true });
  const target = join(pilotHome, "skill-preferences.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, disabled }, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
