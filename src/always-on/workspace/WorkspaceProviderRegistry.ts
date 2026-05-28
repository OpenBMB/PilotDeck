import { AlwaysOnError } from "../protocol/errors.js";
import type { WorkspaceHandle } from "../protocol/types.js";
import type { WorkspaceProvider, WorkspacePrepareInput } from "./WorkspaceProvider.js";

/**
 * Picks the first applicable provider in priority order. The registry never
 * reads a "preferred strategy" from configuration; selection is purely
 * automatic per `02-pilotdeck-always-on-rewrite-plan.md` §9.
 */
export class WorkspaceProviderRegistry {
  private readonly providers: WorkspaceProvider[] = [];

  add(provider: WorkspaceProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  list(): readonly WorkspaceProvider[] {
    return this.providers;
  }

  async resolve(projectRoot: string): Promise<WorkspaceProvider> {
    for (const provider of this.providers) {
      try {
        if (await provider.isApplicable(projectRoot)) {
          return provider;
        }
      } catch {
        // ignore: try the next provider.
      }
    }
    throw new AlwaysOnError(
      "workspace_unavailable",
      `no workspace provider applicable for ${projectRoot}.`,
    );
  }

  async prepare(input: WorkspacePrepareInput): Promise<{
    handle: WorkspaceHandle;
    provider: WorkspaceProvider;
  }> {
    const provider = await this.resolve(input.projectRoot);
    const handle = await provider.prepare(input);
    return { handle, provider };
  }

  findById(id: WorkspaceProvider["id"]): WorkspaceProvider | undefined {
    return this.providers.find((entry) => entry.id === id);
  }
}
