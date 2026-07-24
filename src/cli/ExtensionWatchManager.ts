import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { getPilotExtensionPaths } from "../pilot/index.js";

export type ExtensionWatchScope =
  | { kind: "global" }
  | { kind: "project"; projectRoot: string };

export type ExtensionWatchEvent = {
  scope: ExtensionWatchScope;
  changedPaths: string[];
};

export type ExtensionWatchManagerOptions = {
  pilotHome: string;
  builtinSkillsRoot?: string;
  debounceMs?: number;
  onChange(event: ExtensionWatchEvent): void;
  onError?(scope: ExtensionWatchScope, error: Error): void;
};

type ScopeWatchRecord = {
  scope: ExtensionWatchScope;
  watchedPaths: string[];
  watchers: FSWatcher[];
  pendingPaths: Set<string>;
  timer?: NodeJS.Timeout;
};

export class ExtensionWatchManager {
  private readonly scopes = new Map<string, ScopeWatchRecord>();
  private started = false;

  constructor(private readonly options: ExtensionWatchManagerOptions) {}

  start(): () => void {
    if (this.started) {
      return () => this.stop();
    }
    this.started = true;
    this.ensureGlobalScope();
    for (const record of this.scopes.values()) {
      if (record.watchers.length === 0) {
        record.watchers.push(...this.createWatchers(record.scope, record.watchedPaths));
      }
    }
    return () => this.stop();
  }

  stop(): void {
    this.started = false;
    for (const record of this.scopes.values()) {
      if (record.timer) {
        clearTimeout(record.timer);
        record.timer = undefined;
      }
      for (const watcher of record.watchers) {
        try {
          watcher.close();
        } catch {
          // Best-effort shutdown.
        }
      }
      record.watchers = [];
      record.pendingPaths.clear();
    }
  }

  watchProject(projectRoot: string): void {
    this.ensureGlobalScope();
    this.ensureScope({ kind: "project", projectRoot: resolve(projectRoot) });
  }

  private ensureGlobalScope(): void {
    this.ensureScope({ kind: "global" });
  }

  private ensureScope(scope: ExtensionWatchScope): void {
    const key = scopeKey(scope);
    if (this.scopes.has(key)) {
      return;
    }
    const watchedPaths = this.getWatchedPaths(scope);
    const record: ScopeWatchRecord = {
      scope,
      watchedPaths,
      watchers: [],
      pendingPaths: new Set<string>(),
    };
    if (this.started) {
      record.watchers.push(...this.createWatchers(scope, watchedPaths));
    }
    this.scopes.set(key, record);
  }

  private getWatchedPaths(scope: ExtensionWatchScope): string[] {
    if (scope.kind === "global") {
      return [
        resolve(this.options.pilotHome, "mcp.json"),
        resolve(this.options.pilotHome, "plugins"),
        resolve(this.options.pilotHome, "skills"),
        ...(this.options.builtinSkillsRoot ? [resolve(this.options.builtinSkillsRoot)] : []),
      ];
    }
    const paths = getPilotExtensionPaths(scope.projectRoot, this.options.pilotHome);
    return [resolve(scope.projectRoot, ".pilotdeck", "mcp.json"), paths.projectPluginsDir, paths.projectSkillsDir];
  }

  private createWatchers(scope: ExtensionWatchScope, watchedPaths: string[]): FSWatcher[] {
    const watchers: FSWatcher[] = [];
    for (const watchedPath of watchedPaths) {
      const watchTarget = resolveExistingWatchTarget(watchedPath);
      const schedule = (filename: string) => {
        if (shouldHandleWatchSignal(watchTarget, watchedPath, filename)) {
          this.schedule(scope, watchedPath);
        }
      };
      const errorTarget = (error: unknown) =>
        this.options.onError?.(scope, error instanceof Error ? error : new Error(String(error)));
      const recursiveWatcher = this.tryWatch(watchTarget, true, schedule, errorTarget);
      if (recursiveWatcher) {
        watchers.push(recursiveWatcher);
        continue;
      }
      const plainWatcher = this.tryWatch(watchTarget, false, schedule, errorTarget);
      if (plainWatcher) {
        watchers.push(plainWatcher);
      }
    }
    return watchers;
  }

  private tryWatch(
    target: string,
    recursive: boolean,
    onSignal: (filename: string) => void,
    onError: (error: unknown) => void,
  ): FSWatcher | undefined {
    try {
      const watcher = watch(target, { recursive }, (_event, filename) => onSignal(toUtf8(filename)));
      watcher.on("error", onError);
      return watcher;
    } catch {
      return undefined;
    }
  }

  private schedule(scope: ExtensionWatchScope, changedPath: string): void {
    const record = this.scopes.get(scopeKey(scope));
    if (!record) {
      return;
    }
    record.pendingPaths.add(changedPath);
    if (record.timer) {
      clearTimeout(record.timer);
    }
    record.timer = setTimeout(() => {
      record.timer = undefined;
      const changedPaths = [...record.pendingPaths].sort();
      record.pendingPaths.clear();
      this.options.onChange({ scope: record.scope, changedPaths });
    }, this.options.debounceMs ?? 250);
  }
}

function scopeKey(scope: ExtensionWatchScope): string {
  return scope.kind === "global" ? "__global__" : scope.projectRoot;
}

function resolveExistingWatchTarget(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

function shouldHandleWatchSignal(watchTarget: string, watchedPath: string, filename: string): boolean {
  if (filename.length === 0) {
    return true;
  }
  const absoluteChanged = resolve(watchTarget, filename);
  const belongsToWatchedPath = absoluteChanged === watchedPath || absoluteChanged.startsWith(`${watchedPath}${sep}`);
  return belongsToWatchedPath && !isIgnoredExtensionRuntimePath(absoluteChanged);
}

export function isIgnoredExtensionRuntimePath(path: string): boolean {
  const segments = path.split(/[\\/]+/u);
  const name = segments.at(-1)?.toLowerCase() ?? "";
  return segments.some((segment) => segment.toLowerCase() === "__pycache__")
    || name.endsWith(".pyc")
    || name.endsWith(".pyo")
    || name === ".ds_store"
    || name.startsWith(".~")
    || name.startsWith("~$");
}

function toUtf8(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value.toString === "function") {
    return value.toString("utf8");
  }
  return "";
}
