import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { PILOT_PROJECT_DIR_NAME } from "../../pilot/index.js";

export type PlanFileManager = {
  getPlanDirectoryPath(): string;
  resolvePlanFilePath(filePath: string, cwd: string): string | undefined;
  readPlanFile(filePath: string, cwd: string): string | undefined;
};

export function createPlanFileManager(options: {
  projectRoot: string;
}): PlanFileManager {
  const planDir = resolve(options.projectRoot, PILOT_PROJECT_DIR_NAME, "plans");

  function getPlanDirectoryPath(): string {
    mkdirSync(planDir, { recursive: true });
    return planDir;
  }

  function resolvePlanFilePath(filePath: string, cwd: string): string | undefined {
    if (!filePath.trim()) return undefined;
    const absolutePath = resolve(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
    const relativeToPlanDir = relative(planDir, absolutePath);
    if (
      isAbsolute(relativeToPlanDir)
      || relativeToPlanDir.startsWith("..")
      || relativeToPlanDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      || relativeToPlanDir === ""
    ) {
      return undefined;
    }
    if (!absolutePath.toLowerCase().endsWith(".md")) {
      return undefined;
    }
    return absolutePath;
  }

  function readPlanFile(filePath: string, cwd: string): string | undefined {
    const absolutePath = resolvePlanFilePath(filePath, cwd);
    if (!absolutePath) {
      return undefined;
    }
    try {
      const content = readFileSync(absolutePath, "utf8");
      return content.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  return { getPlanDirectoryPath, resolvePlanFilePath, readPlanFile };
}
