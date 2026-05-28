import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { getPilotConfigFilePath, resolvePilotHome } from "../paths.js";
import { classifyConfigChanges, diffConfigSnapshots } from "./classifyChanges.js";
import { loadPilotConfig } from "./loadPilotConfig.js";
import {
  PilotConfigError,
  type PilotConfigDiagnostic,
  type PilotConfigLoadOptions,
  type PilotConfigReloadEvent,
  type PilotConfigSnapshot,
} from "./types.js";

export type PilotConfigListener = (event: PilotConfigReloadEvent) => void;

export type PilotConfigStore = {
  getSnapshot(): PilotConfigSnapshot;
  getDiagnostics(): PilotConfigDiagnostic[];
  reload(reason?: string): Promise<PilotConfigSnapshot>;
  subscribe(listener: PilotConfigListener): () => void;
  startWatching(options?: { debounceMs?: number }): () => void;
};

export async function createPilotConfigStore(
  options: PilotConfigLoadOptions = {},
): Promise<PilotConfigStore> {
  return createPilotConfigStoreSync(options);
}

export function createPilotConfigStoreSync(
  options: PilotConfigLoadOptions = {},
): PilotConfigStore {
  const initialSnapshot = loadPilotConfig(options);
  return new DefaultPilotConfigStore(initialSnapshot, options);
}

class DefaultPilotConfigStore implements PilotConfigStore {
  private currentSnapshot: PilotConfigSnapshot;
  private lastReloadDiagnostics: PilotConfigDiagnostic[] = [];
  private readonly listeners = new Set<PilotConfigListener>();
  private reloading: Promise<PilotConfigSnapshot> | undefined;
  private nextVersion: number;

  constructor(
    initialSnapshot: PilotConfigSnapshot,
    private readonly options: PilotConfigLoadOptions,
  ) {
    this.currentSnapshot = initialSnapshot;
    this.nextVersion = initialSnapshot.version + 1;
  }

  getSnapshot(): PilotConfigSnapshot {
    return this.currentSnapshot;
  }

  getDiagnostics(): PilotConfigDiagnostic[] {
    return [...this.currentSnapshot.diagnostics, ...this.lastReloadDiagnostics];
  }

  async reload(_reason = "manual"): Promise<PilotConfigSnapshot> {
    if (this.reloading) {
      return this.reloading;
    }

    this.reloading = Promise.resolve()
      .then(() => {
        const previousSnapshot = this.currentSnapshot;
        const nextSnapshot = loadPilotConfig({
          ...this.options,
          version: this.nextVersion,
        });
        const changedPaths = diffConfigSnapshots(previousSnapshot, nextSnapshot);
        const changeClasses = classifyConfigChanges(changedPaths);

        this.currentSnapshot = nextSnapshot;
        this.nextVersion = nextSnapshot.version + 1;
        this.lastReloadDiagnostics = [];
        this.publish({
          previousSnapshot,
          nextSnapshot,
          changedPaths,
          changeClasses,
        });

        return nextSnapshot;
      })
      .catch((error: unknown) => {
        if (error instanceof PilotConfigError) {
          this.lastReloadDiagnostics = error.diagnostics;
        }
        throw error;
      })
      .finally(() => {
        this.reloading = undefined;
      });

    return this.reloading;
  }

  subscribe(listener: PilotConfigListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startWatching(options: { debounceMs?: number } = {}): () => void {
    const debounceMs = options.debounceMs ?? 250;
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;

    const scheduleReload = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void this.reload("watch").catch(() => {
          // Reload diagnostics are retained on the store; watchers must not crash the runtime.
        });
      }, debounceMs);
    };

    for (const path of this.getWatchedPaths()) {
      const watchedPath = existsSync(path) ? path : dirname(path);
      try {
        watchers.push(watch(watchedPath, scheduleReload));
      } catch {
        // Watcher support is best effort. Manual reload remains available.
      }
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    };
  }

  private publish(event: PilotConfigReloadEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscribers cannot block or break snapshot publication.
      }
    }
  }

  private getWatchedPaths(): string[] {
    const env = this.options.env ?? process.env;
    const pilotHome = resolvePilotHome(env);
    return [getPilotConfigFilePath(pilotHome)];
  }
}
