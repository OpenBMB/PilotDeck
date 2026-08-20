import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

export type WorkspaceFileSpec =
  | { path: string; content: string }
  | { source: string; dest: string };

export type BenchmarkTask = {
  taskId: string;
  name: string;
  category: string;
  gradingType: "automated" | "llm_judge" | "hybrid";
  timeoutSeconds: number;
  workspaceFiles: WorkspaceFileSpec[];
  prompt: string;
  expectedBehavior: string;
  gradingCriteria: string[];
  automatedChecks?: string;
  llmJudgeRubric?: string;
  gradingWeights?: Record<string, number>;
  filePath: string;
  frontmatter: Record<string, unknown>;
};

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const SECTION_HEADER_RE = /^##\s+(.+)$/;
const CRITERIA_ITEM_RE = /^-\s+\[[ x]\]\s+(.+)$/;

export function parseTask(content: string, filePath: string): BenchmarkTask {
  const match = content.match(FRONTMATTER_RE);
  if (!match) throw new Error(`No YAML frontmatter found in ${filePath}`);

  const frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
  const sections = parseSections(match[2]);
  return {
    taskId: stringValue(frontmatter.id),
    name: stringValue(frontmatter.name),
    category: stringValue(frontmatter.category),
    gradingType: (frontmatter.grading_type as BenchmarkTask["gradingType"]) ?? "automated",
    timeoutSeconds: typeof frontmatter.timeout_seconds === "number" ? frontmatter.timeout_seconds : 120,
    workspaceFiles: (frontmatter.workspace_files as WorkspaceFileSpec[] | undefined) ?? [],
    prompt: sections["Prompt"] ?? "",
    expectedBehavior: sections["Expected Behavior"] ?? "",
    gradingCriteria: extractGradingCriteria(sections["Grading Criteria"] ?? ""),
    automatedChecks: sections["Automated Checks"],
    llmJudgeRubric: sections["LLM Judge Rubric"],
    gradingWeights: frontmatter.grading_weights as Record<string, number> | undefined,
    filePath,
    frontmatter,
  };
}

export async function loadAllTasks(tasksDir: string): Promise<BenchmarkTask[]> {
  const files = (await readdir(tasksDir))
    .filter(file => file.startsWith("task_") && file.endsWith(".md"))
    .sort();
  const tasks: BenchmarkTask[] = [];
  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    const task = parseTask(await readFile(filePath, "utf8"), filePath);
    if (task.frontmatter.multi_session !== true) tasks.push(task);
  }
  return tasks;
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let heading: string | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (heading) sections[heading] = lines.join("\n").trim();
  };
  for (const line of body.split("\n")) {
    const match = line.match(SECTION_HEADER_RE);
    if (match) {
      flush();
      heading = match[1];
      lines = [];
    } else if (heading) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function extractGradingCriteria(value: string): string[] {
  return value.split("\n").flatMap(line => {
    const match = line.trim().match(CRITERIA_ITEM_RE);
    return match ? [match[1]] : [];
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
