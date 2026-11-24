import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { SessionConfigOverrides } from "../../always-on/runtime/SessionConfigOverrides.js";
import type { Gateway } from "../../gateway/index.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import type { PilotDeckToolDefinition } from "../../tool/index.js";
import { resolveProjectIdentityPath } from "../../pilot/paths.js";
import type { CronConfig } from "../config/parseCronConfig.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronRunRecord,
  CronResultDeliveryHandler,
  CronStopInput,
  CronStopResult,
  CronTask,
  CronTaskChange,
  CronUpdateInput,
  CronUpdateResult,
} from "../protocol/types.js";
import { resolveCronPaths } from "../storage/CronPaths.js";
import { createCronTools } from "../tool/createCronTools.js";
import { migrateCronStores } from "../storage/CronStoreMigration.js";
import { CronRuntime, type CronRuntimeLogger, type CreateCronRuntimeOptions } from "./CronRuntime.js";
import type { CronTurnEventHandler } from "./CronFire.js";
import { CronReminderStore } from "../storage/CronReminderStore.js";
import type { CronReminder, CronReminderListInput, CronReminderDismissInput } from "../protocol/types.js";
import { createRegisteredWebProjectResolver } from "../../web/server/listProjects.js";

export type CreateCronManagerOptions = {
  config: CronConfig;
  pilotHome: string;
  sessionOverrides?: SessionConfigOverrides;
  now?: () => Date;
  uuid?: () => string;
  logger?: CronRuntimeLogger;
  telemetry?: TelemetryClient;
  onResultDelivery?: CronResultDeliveryHandler;
  onTurnEvent?: CronTurnEventHandler;
  onTaskChange?: (change: CronTaskChange) => void;
  onReminderChange?: (change: { id: string; reminder?: CronReminder; dismissedScope?: string }) => void;
  generateTaskDetails?: CreateCronRuntimeOptions["generateTaskDetails"];
};

export class CronManager {
  readonly config: CronConfig;

  private readonly pilotHome: string;
  private readonly runtimes = new Map<string, CronRuntime>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly tools: PilotDeckToolDefinition[];
  private gateway?: Gateway;
  private started = false;
  private readonly reminders: CronReminderStore;
  private readonly resolveRegisteredProject: ReturnType<typeof createRegisteredWebProjectResolver>;
  private readonly emittedReminders = new Set<string>();

  constructor(private readonly options: CreateCronManagerOptions) {
    this.config = options.config;
    this.pilotHome = resolve(options.pilotHome);
    this.resolveRegisteredProject = createRegisteredWebProjectResolver({ pilotHome: this.pilotHome });
    this.tools = createCronTools(this);
    this.reminders = new CronReminderStore(resolve(this.pilotHome, "cron", "reminders.json"));
  }

  getTools(): PilotDeckToolDefinition[] {
    return this.config.enabled ? [...this.tools] : [];
  }

  bindGateway(gateway: Gateway): void {
    if (this.gateway) {
      throw new Error("CronManager.bindGateway already called.");
    }
    this.gateway = gateway;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.options.logger?.info("cron disabled in config; manager is a no-op.");
      return;
    }
    if (!this.gateway) {
      throw new Error("CronManager.start called before bindGateway.");
    }
    await migrateCronStores({
      pilotHome: this.pilotHome,
      logger: this.options.logger,
    });
    this.started = true;
    const projectKeys = await discoverCronProjectKeys(this.pilotHome, this.options.logger);
    for (const projectKey of projectKeys) {
      try { await this.ensureRuntime(projectKey); }
      catch (error) { this.options.logger?.warn("cron project could not start; its store was preserved", { projectKey, error: String(error) }); }
    }
    this.options.logger?.info("cron manager started", { projectCount: this.runtimes.size });
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.starting.values()].map((pending) => pending.catch(() => undefined)));
    for (const runtime of this.runtimes.values()) {
      await runtime.stop();
    }
    this.runtimes.clear();
    this.starting.clear();
  }

  async createTask(input: CronCreateInput): Promise<CronCreateResult> {
    if (!this.config.enabled) throw new Error("Cron is disabled. Enable it in pilotdeck.yaml to create tasks.");
    const requested = input.projectKey === "general" ? this.pilotHome : requireProjectKey(input.projectKey);
    // Check before creating a runtime, project marker, or durable task. Agent
    // tools and Gateway/Web requests share this creation boundary.
    const projectKey = resolveProjectIdentityPath(requested) === resolveProjectIdentityPath(this.pilotHome)
      ? this.pilotHome : await this.resolveRegisteredProject(requested);
    if (!projectKey) {
      throw Object.assign(new Error("Cron project is not registered or its directory is unavailable. Select an existing project and try again."), {
        code: "cron_project_unavailable",
      });
    }
    let workspaceCwd = input.workspaceCwd;
    if (projectKey === this.pilotHome && !workspaceCwd) {
      const configured = process.env.PILOTDECK_GENERAL_WORKSPACE_DIRECTORY?.trim();
      if (configured) workspaceCwd = configured.startsWith("~/") ? resolve(homedir(), configured.slice(2)) : configured;
      else {
        try {
          const state = JSON.parse(await readFile(resolve(this.pilotHome, "general-workspace.json"), "utf-8"));
          if (state.version === 1 && typeof state.directory === "string") workspaceCwd = state.directory;
        } catch (error) {
          throw new Error("Cron General workspace is unavailable. Open General in the Web UI to prepare it.", { cause: error });
        }
      }
    }
    if (projectKey === this.pilotHome) {
      if (!workspaceCwd || !isAbsolute(workspaceCwd)) throw new Error("Cron General workspace is unavailable.");
      const [home, workspace] = await Promise.all([realpath(this.pilotHome), realpath(workspaceCwd)]);
      const outside = (root: string, path: string) => { const rel = relative(root, path); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel); };
      if (!outside(home, workspace) || !outside(workspace, home)) throw new Error("Cron General workspace must be separate from the configuration directory.");
      workspaceCwd = workspace;
    }
    const runtime = await this.ensureRuntime(projectKey);
    return runtime.createTask({ ...input, projectKey, workspaceCwd });
  }

  async listTasks(input: CronListInput = {}): Promise<CronListResult> {
    if (input.projectKey === "general") input = { ...input, projectKey: this.pilotHome };
    if (input.projectKey) {
      const runtime = await this.ensureRuntime(input.projectKey);
      return runtime.listTasks(input);
    }
    const tasks: CronTask[] = [];
    const runs: CronRunRecord[] = [];
    for (const runtime of this.runtimes.values()) {
      const result = await runtime.listTasks(input);
      tasks.push(...result.tasks);
      if (result.recentRuns) runs.push(...result.recentRuns);
    }
    const result: CronListResult = {
      tasks: tasks.sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? "")),
    };
    if (input.includeHistory) {
      result.recentRuns = runs
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, input.limit ?? 50);
      if (input.taskId && runs.length >= (input.limit ?? 50)) result.nextBeforeRunId = result.recentRuns.at(-1)?.runId;
    }
    return result;
  }

  async updateTask(input: CronUpdateInput): Promise<CronUpdateResult> {
    if (input.projectKey === "general") input = { ...input, projectKey: this.pilotHome };
    const runtime = await this.resolveTaskRuntime(input.taskId, input.projectKey);
    if (!runtime) return { updated: false, reason: "not_found" };
    return runtime.updateTask(input);
  }

  async listReminders(input: CronReminderListInput): Promise<{ reminders: CronReminder[] }> {
    validateReminderScope(input.scope);
    return { reminders: await this.reminders.list(input.scope) };
  }

  async dismissReminder(input: CronReminderDismissInput): Promise<{ dismissed: boolean }> {
    validateReminderScope(input.scope);
    if (typeof input.id !== "string" || !/^[a-f0-9]{64}$/.test(input.id)) throw new Error("Invalid reminder ID.");
    const dismissed = await this.reminders.dismiss(input.scope, input.id, (this.options.now?.() ?? new Date()).toISOString());
    if (dismissed) this.options.onReminderChange?.({ id: input.id, dismissedScope: input.scope });
    return { dismissed };
  }

  private async recordReminder(reminder: CronReminder): Promise<void> {
    if (this.emittedReminders.has(reminder.id)) return;
    const created = await this.reminders.put(reminder);
    this.emittedReminders.add(reminder.id);
    if (created) this.options.onReminderChange?.({ id: reminder.id, reminder });
  }

  async prepareConversation(input: { sessionKey: string; projectKey?: string }): Promise<{ task: CronTask; workspaceCwd: string }> {
    const task = (await this.listTasks()).tasks.find(task => task.sessionKey === input.sessionKey);
    if (!task?.projectKey || (input.projectKey
        && resolveProjectIdentityPath(input.projectKey) !== resolveProjectIdentityPath(task.projectKey))) {
      throw new Error("Scheduled task conversation does not belong to this project.");
    }
    return (await this.ensureRuntime(task.projectKey)).prepareConversation(task.taskId);
  }

  async deleteTask(input: CronDeleteInput): Promise<CronDeleteResult> {
    const runtime = await this.resolveTaskRuntime(input.taskId, input.projectKey);
    if (!runtime) return { deleted: false };
    return runtime.deleteTask({ ...input, projectKey: runtime.projectKey });
  }

  async stopTask(input: CronStopInput): Promise<CronStopResult> {
    const runtime = await this.resolveStopRuntime(input);
    if (!runtime) {
      return { stopped: false, taskId: input.taskId, runId: input.runId };
    }
    return runtime.stopTask(input);
  }

  async runTaskNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    const runtime = await this.resolveTaskRuntime(input.taskId, input.projectKey);
    if (!runtime) return { started: false, reason: "not_found" };
    return runtime.runTaskNow(input);
  }

  /** Public for tests; runs one scheduler tick for one or all loaded projects. */
  async runTickOnce(projectKey?: string): Promise<void> {
    if (projectKey) {
      await (await this.ensureRuntime(projectKey)).runTickOnce();
      return;
    }
    for (const runtime of this.runtimes.values()) {
      await runtime.runTickOnce();
    }
  }

  private async ensureRuntime(projectKeyInput: string): Promise<CronRuntime> {
    const projectKey = projectKeyInput === "general" ? this.pilotHome : resolve(projectKeyInput);
    const identity = resolveProjectIdentityPath(projectKey);
    const existing = this.runtimes.get(identity);
    if (existing) {
      await this.starting.get(identity);
      return existing;
    }

    const runtime = new CronRuntime({
      config: this.config,
      pilotHome: this.pilotHome,
      projectKey,
      sessionOverrides: this.options.sessionOverrides,
      now: this.options.now,
      uuid: this.options.uuid,
      logger: this.options.logger,
      telemetry: this.options.telemetry,
      onResultDelivery: this.options.onResultDelivery,
      onTurnEvent: this.options.onTurnEvent,
      onTaskChange: this.options.onTaskChange,
      onReminder: reminder => this.recordReminder(reminder),
      generateTaskDetails: this.options.generateTaskDetails,
      activeRunCount: () => this.activeRunCount(),
      onRunFinished: () => { for (const loaded of this.runtimes.values()) loaded.poke(); },
      skipToolCreation: true,
    });
    if (this.gateway) runtime.bindGateway(this.gateway);
    this.runtimes.set(identity, runtime);
    const pending = writeProjectMarker(runtime.paths.projectDir, projectKey)
      .then(async () => { if (this.started) await runtime.start(); })
      .finally(() => this.starting.delete(identity));
    this.starting.set(identity, pending);
    await pending;
    return runtime;
  }

  private activeRunCount(): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      count += runtime.getActiveRunCount();
    }
    return count;
  }

  private async resolveTaskRuntime(
    taskId: string,
    projectKey?: string,
  ): Promise<CronRuntime | undefined> {
    if (projectKey) {
      const runtime = await this.ensureRuntime(projectKey);
      return (await runtime.hasTask(taskId)) ? runtime : undefined;
    }
    const matches: CronRuntime[] = [];
    for (const runtime of this.runtimes.values()) {
      if (await runtime.hasTask(taskId)) {
        matches.push(runtime);
      }
    }
    if (matches.length > 1) {
      throw Object.assign(new Error(`Cron task id is ambiguous across projects: ${taskId}`), {
        code: "cron_task_ambiguous",
      });
    }
    return matches[0];
  }

  private async resolveStopRuntime(input: CronStopInput): Promise<CronRuntime | undefined> {
    if (input.projectKey) {
      return this.ensureRuntime(input.projectKey);
    }
    const matches: CronRuntime[] = [];
    for (const runtime of this.runtimes.values()) {
      const tasks = (await runtime.listTasks()).tasks;
      if (tasks.some((task) =>
        (input.taskId && task.taskId === input.taskId)
        || (input.runId && task.lastRunId === input.runId))) {
        matches.push(runtime);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Cron run identifier is ambiguous across projects: ${input.runId ?? input.taskId}`);
    }
    return matches[0];
  }
}

export function createCronManager(options: CreateCronManagerOptions): CronManager {
  return new CronManager(options);
}

function requireProjectKey(projectKey: string | undefined): string {
  if (!projectKey?.trim()) {
    throw new Error("Cron task creation requires a projectKey.");
  }
  return resolve(projectKey);
}

function validateReminderScope(scope: string): void {
  if (typeof scope !== "string" || !scope || scope.length > 128) throw new Error("Invalid reminder scope.");
}

async function discoverCronProjectKeys(
  pilotHome: string,
  logger?: CronRuntimeLogger,
): Promise<string[]> {
  const projectsDir = resolve(pilotHome, "cron", "projects");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const projectKeys = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = resolve(projectsDir, entry.name);
    try {
      const raw = await readFile(resolve(projectDir, "tasks.json"), "utf-8");
      const parsed = JSON.parse(raw) as { tasks?: Array<{ projectKey?: unknown }> };
      for (const task of parsed.tasks ?? []) {
        if (typeof task.projectKey === "string" && task.projectKey.trim()) {
          projectKeys.add(resolve(task.projectKey));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger?.warn("cron project discovery skipped unreadable task store", {
          projectDir: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      const raw = await readFile(resolve(projectDir, "run-history.jsonl"), "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const run = JSON.parse(line) as { projectKey?: unknown };
          if (typeof run.projectKey === "string" && run.projectKey.trim()) {
            projectKeys.add(resolve(run.projectKey));
          }
        } catch {
          // Preserve unreadable migration leftovers, but continue discovering
          // project keys from the remaining valid records.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger?.warn("cron project discovery skipped unreadable run history", {
          projectDir: entry.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      const marker = (await readFile(resolve(projectDir, ".cwd"), "utf-8")).trim();
      if (marker) projectKeys.add(resolve(marker));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...projectKeys].sort();
}

async function writeProjectMarker(projectDir: string, projectKey: string): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(resolve(projectDir, ".cwd"), `${projectKey}\n`, "utf-8");
}
