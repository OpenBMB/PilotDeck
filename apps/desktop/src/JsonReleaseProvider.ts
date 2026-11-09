import { Provider, resolveFiles, type ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import type { AppUpdater } from "electron-updater";

type UpdateInfo = Parameters<typeof resolveFiles>[0];

/** Inverse of the release allocator, including same-day revisions. */
export function releaseTagForVersion(version: string): string {
  const match = /^(\d{4})\.(\d{3,4})\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error("Unsupported differential base version");
  const year = Number(match[1]), date = Number(match[2]), revision = Number(match[3]);
  const month = Math.floor(date / 100), day = date % 100;
  if (!Number.isSafeInteger(revision + 1) || month < 1 || month > 12 || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error("Invalid differential base date");
  return `v${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}${revision ? `-r${revision + 1}` : ''}`;
}
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
  override getBlockMapFiles(file: URL, oldVersion: string, newVersion: string): URL[] {
    const newTag = releaseTagForVersion(newVersion);
    const oldTag = releaseTagForVersion(oldVersion);
    const name = this.info.files.find(entry => new URL(entry.url, this.base).href === file.href)?.url;
    // Never derive a host or arbitrary path from metadata. Unsupported historic
    // layouts fall back to full download through electron-updater.
    if (newVersion !== this.info.version || !this.base.pathname.endsWith(`/${newTag}/`)
      || !name?.startsWith(`PilotDeck-${newVersion}-`) || !/^[\w.-]+$/.test(name)) {
      throw new Error("Unsupported differential release layout");
    }
    const oldName = name.replace(`PilotDeck-${newVersion}-`, `PilotDeck-${oldVersion}-`);
    return [new URL(`../${oldTag}/${oldName}.blockmap`, this.base), new URL(`${name}.blockmap`, this.base)];
  }
}
