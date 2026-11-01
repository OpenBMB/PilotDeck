import { Provider, resolveFiles, type ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import type { AppUpdater } from "electron-updater";

type UpdateInfo = Parameters<typeof resolveFiles>[0];
export type JsonReleaseProviderOptions = {
  provider: "custom";
  updateProvider: typeof JsonReleaseProvider;
  url: string;
  updateInfo: UpdateInfo;
};

/** The already validated JSON manifest is pinned for the entire update operation.
 * Only payload requests reach the selected mirror; YAML is a legacy export. */
export class JsonReleaseProvider extends Provider<UpdateInfo> {
  private readonly base: URL;
  private readonly info: UpdateInfo;
  constructor(options: JsonReleaseProviderOptions, _updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    super({ ...runtime, isUseMultipleRangeRequest: false });
    this.base = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`);
    this.info = structuredClone(options.updateInfo);
  }
  async getLatestVersion(): Promise<UpdateInfo> { return structuredClone(this.info); }
  resolveFiles(info: UpdateInfo) { return resolveFiles(info, this.base); }
}
