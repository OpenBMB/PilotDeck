import { resolve } from "node:path";
import { DialogGatewayError } from "./errors.js";

export type RegisteredDialogProject = {
  projectKey: string;
};

export type DialogProjectRegistryOptions = {
  pilotHome: string;
  listProjects: () => Promise<RegisteredDialogProject[]>;
};

export type DialogProjectRegistry = {
  listProjectKeys: () => Promise<string[]>;
  resolveProjectKey: (projectKey: string) => Promise<string>;
};

/**
 * Dialog APIs accept real registered projects plus PilotDeck's one virtual
 * General workspace rooted at pilotHome. Keeping that exception here avoids
 * teaching the real-project enumerator about a UI/runtime-only workspace.
 */
export function createDialogProjectRegistry(
  options: DialogProjectRegistryOptions,
): DialogProjectRegistry {
  const generalProjectKey = resolve(options.pilotHome);

  const listProjectKeys = async (): Promise<string[]> => {
    const projects = await options.listProjects();
    const byResolvedPath = new Map<string, string>([[generalProjectKey, generalProjectKey]]);
    for (const project of projects) {
      const resolvedProjectKey = resolve(project.projectKey);
      if (!byResolvedPath.has(resolvedProjectKey)) {
        byResolvedPath.set(resolvedProjectKey, project.projectKey);
      }
    }
    return [...byResolvedPath.values()];
  };

  const resolveProjectKey = async (projectKey: string): Promise<string> => {
    const requestedProjectKey = resolve(projectKey);
    if (requestedProjectKey === generalProjectKey) {
      return generalProjectKey;
    }

    const projects = await options.listProjects();
    const match = projects.find(
      (project) => resolve(project.projectKey) === requestedProjectKey,
    );
    if (!match) {
      throw new DialogGatewayError("PROJECT_NOT_FOUND", `Unknown projectKey: ${projectKey}`);
    }
    return match.projectKey;
  };

  return { listProjectKeys, resolveProjectKey };
}
