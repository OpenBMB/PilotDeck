import type { MessageBoxOptions } from 'electron';

export type DesktopAboutContext = {
  language: string;
  appVersion: string;
  metadata: { version?: string; buildTime?: string; commitSha?: string };
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  versions: { electron?: string; chrome?: string; node?: string };
};
const projectWebsite = 'https://github.com/OpenBMB/PilotDeck';

/** Local build information, also used by the settings page without a network request. */
export function desktopAboutInfo(context: DesktopAboutContext) {
  return {
    version: context.metadata.version || context.appVersion,
    platform: context.platform === 'win32' ? 'Windows' : context.platform === 'darwin' ? 'macOS' : 'Linux',
    arch: context.arch,
    osRelease: context.osRelease,
    buildTime: context.metadata.buildTime || null,
    commitSha: context.metadata.commitSha || null,
    versions: { electron: context.versions.electron, chrome: context.versions.chrome, node: context.versions.node },
    license: 'AGPL-3.0-only',
    projectWebsite,
    versionInformation: desktopAboutInformation(context).versionInformation,
  };
}

export function desktopAboutInformation(context: DesktopAboutContext) {
  const zh = context.language === 'zh-CN';
  const text = (chinese: string, english: string) => zh ? chinese : english;
  const { metadata } = context;
  const version = metadata.version || context.appVersion;
  const platform = context.platform === 'win32' ? 'Windows' : context.platform === 'darwin' ? 'macOS' : 'Linux';
  const buildTime = metadata.buildTime && Number.isFinite(Date.parse(metadata.buildTime))
    ? new Date(metadata.buildTime).toLocaleString(zh ? 'zh-CN' : 'en', { hour12: false }) : null;
  const information = [
    `${text('版本', 'Version')}: ${version}`,
    `${text('平台', 'Platform')}: ${platform} ${context.osRelease} (${context.arch})`,
    ...(buildTime ? [`${text('构建时间', 'Built')}: ${buildTime}`] : []),
    ...(metadata.commitSha ? [`${text('提交', 'Commit')}: ${metadata.commitSha.slice(0, 12)}`] : []),
  ];
  const dialog: MessageBoxOptions = {
    type: 'info', title: text('关于 PilotDeck', 'About PilotDeck'), message: 'PilotDeck',
    detail: [text('开源 AI 工作台：对话、项目文件、技能与定时任务。', 'An open-source AI workspace for conversations, project files, skills and scheduled tasks.'),
      '', ...information, '', `${text('许可证', 'License')}: AGPL-3.0-only`, 'Copyright © OpenBMB', projectWebsite].join('\n'),
    buttons: [text('确定', 'OK'), text('复制版本信息', 'Copy Version Information'), text('项目主页', 'Project Website')],
    defaultId: 0, cancelId: 0, noLink: true,
  };
  const versionInformation = [
    `PilotDeck: ${version}`, `OS: ${context.platform} ${context.osRelease} (${context.arch})`,
    ...Object.entries(context.versions).filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`),
    ...(metadata.buildTime ? [`Built: ${metadata.buildTime}`] : []),
    ...(metadata.commitSha ? [`Commit: ${metadata.commitSha}`] : []),
    'License: AGPL-3.0-only', projectWebsite,
  ].join('\n');
  return { dialog, versionInformation, projectWebsite };
}

export async function presentDesktopAbout(context: DesktopAboutContext, actions: {
  showDialog: (options: MessageBoxOptions) => Promise<{ response: number }>;
  copy: (text: string) => void;
  openWebsite: (url: string) => Promise<unknown>;
}) {
  const information = desktopAboutInformation(context);
  const { response } = await actions.showDialog(information.dialog);
  if (response === 1) actions.copy(information.versionInformation);
  else if (response === 2) await actions.openWebsite(information.projectWebsite);
}
