type Result = { code: number; stdout?: string };
type Dependencies = {
  platform: string; packaged: boolean; chinese: () => boolean;
  exists: (file: string) => boolean;
  run: (file: string, args: string[]) => Promise<Result>;
  confirm: (options: { type: 'question'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean }) => Promise<{ response: number }>;
  stop: () => Promise<void>; restore: () => Promise<void>; quit: () => void;
  cleanup: () => { skipped: string[] };
  notify: (message: string) => Promise<void>;
};

export function createDesktopUninstaller(deps: Dependencies) {
  let pending: Promise<{ canceled: boolean }> | undefined;
  const supported = () => deps.platform === 'linux' && deps.packaged && deps.exists('/usr/bin/pkexec');
  const execute = async () => {
    const chinese = deps.chinese();
    if (!supported()) throw new Error(chinese ? '请使用系统包管理器卸载 PilotDeck，个人数据将保留。' : 'Use the system package manager to uninstall PilotDeck. Personal data will be retained.');
    const answer = await deps.confirm({ type: 'question', title: chinese ? '卸载 PilotDeck' : 'Uninstall PilotDeck',
      message: chinese ? '卸载后是否清理个人数据？' : 'Remove personal data when uninstalling?',
      detail: chinese ? '清理会删除 .pilotdeck 目录中的配置、会话、密钥和全部文件，以及当前用户的客户端设置与缓存。请提前备份。系统稍后会请求卸载权限。' : 'Cleanup deletes configuration, conversations, credentials and all files in .pilotdeck, plus this user’s client settings and caches. Back up files you want to keep. The system will then request permission to uninstall.',
      buttons: chinese ? ['卸载并保留数据', '卸载并清理数据', '取消'] : ['Uninstall and keep data', 'Uninstall and remove data', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true });
    if (answer.response === 2) return { canceled: true };
    const name = 'pilotdeck-desktop';
    let command: string[] | undefined;
    if (deps.exists('/usr/bin/dpkg-query') && (await deps.run('/usr/bin/dpkg-query', ['-W', '-f=${Status}', name])).stdout?.trim() === 'install ok installed') command = ['/usr/bin/dpkg', '--remove', name];
    else if (deps.exists('/usr/bin/rpm') && (await deps.run('/usr/bin/rpm', ['-q', name])).code === 0) command = ['/usr/bin/rpm', '-e', name];
    if (!command) throw new Error(chinese ? '未找到已安装的 DEB 或 RPM 软件包，个人数据已保留。' : 'No supported installed DEB or RPM package was found. Personal data has been retained.');
    await deps.stop();
    try {
      const result = await deps.run('/usr/bin/pkexec', command);
      if (result.code !== 0) throw new Error(chinese ? '系统取消或未能完成卸载，个人数据已保留。' : 'The system canceled or could not finish uninstalling. Personal data has been retained.');
    } catch (error) { await deps.restore(); throw error; }
    if (answer.response === 1) {
      const result = deps.cleanup();
      if (result.skipped.length) {
        // The package has already been removed. Never restart deleted binaries.
        await deps.notify(chinese ? '部分个人数据无法清理，剩余文件已保留。' : 'Some personal data could not be removed. The remaining files have been preserved.');
        deps.quit();
        return { canceled: false };
      }
    }
    deps.quit();
    return { canceled: false };
  };
  return {
    supported,
    start() { pending ??= execute().finally(() => { pending = undefined; }); return pending; },
  };
}
