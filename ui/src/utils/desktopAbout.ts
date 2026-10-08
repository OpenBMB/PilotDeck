export type DesktopAboutInfo = {
  version: string;
  platform: string;
  arch: string;
  osRelease: string;
  buildTime: string | null;
  commitSha: string | null;
  versions: { electron?: string; chrome?: string; node?: string };
  license: string;
  projectWebsite: string;
  versionInformation: string;
};
