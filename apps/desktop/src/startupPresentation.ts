// Pure presentation shared by the native loading page and the Web renderer.
export const startupProgress: Record<string, number> = {
  starting: 8, config: 22, server: 45, gateway: 78, ready: 96, awaiting_configuration: 96,
};

const messages = {
  en: {
    starting: 'Starting PilotDeck…', config: 'Preparing your workspace…', server: 'Starting PilotDeck…',
    gateway: 'Starting Gateway…', ready: 'Opening your workspace…', awaiting_configuration: 'Opening your workspace…',
    failed: 'PilotDeck could not start', restart: 'Restart', save: 'Save runtime logs', saved: 'Runtime logs saved',
    saveFailed: 'Could not save the logs. Try another location.', log: 'Runtime log',
    PD_RUNTIME_OUT_OF_MEMORY: 'There was not enough memory to start the service.',
    PD_RUNTIME_NATIVE_FAILURE: 'The local service stopped because of an internal runtime error.',
    PD_RESOURCE_NOT_FOUND: 'A required application file is missing. Reinstall PilotDeck and try again.',
    PD_FILESYSTEM_PERMISSION: 'PilotDeck cannot access a required file or folder.',
    PD_NETWORK_PORT_IN_USE: 'A port required by the local service is already in use.',
    PD_FILESYSTEM_FULL: 'There is not enough disk space to start the service.',
    PD_RUNTIME_TIMEOUT: 'The local service took too long to start.',
    PD_CONFIG_INVALID: 'The model configuration could not be read. Check it in Settings and try again.',
    PD_CONFIG_STATUS_UNAVAILABLE: 'PilotDeck could not check the model configuration. Try restarting.',
    unknown: 'The local service stopped unexpectedly. Restart PilotDeck, or save the logs to help investigate.',
  },
  'zh-CN': {
    starting: '正在启动 PilotDeck…', config: '正在准备工作区…', server: '正在启动 PilotDeck…',
    gateway: '正在启动 Gateway…', ready: '即将进入 PilotDeck…', awaiting_configuration: '即将进入 PilotDeck…',
    failed: 'PilotDeck 启动遇到问题', restart: '重新启动', save: '保存运行日志', saved: '运行日志已保存',
    saveFailed: '日志保存失败，请尝试其他位置。', log: '运行日志',
    PD_RUNTIME_OUT_OF_MEMORY: '可用内存不足，服务无法启动。',
    PD_RUNTIME_NATIVE_FAILURE: '本地服务发生内部运行错误。',
    PD_RESOURCE_NOT_FOUND: '缺少必要的程序文件，请重新安装 PilotDeck 后再试。',
    PD_FILESYSTEM_PERMISSION: '无法访问启动所需的文件或文件夹。',
    PD_NETWORK_PORT_IN_USE: '本地服务需要的端口已被其他程序占用。',
    PD_FILESYSTEM_FULL: '磁盘空间不足，服务无法启动。',
    PD_RUNTIME_TIMEOUT: '本地服务启动超时，请重试。',
    PD_CONFIG_INVALID: '模型配置无法读取，请在设置中检查后重试。',
    PD_CONFIG_STATUS_UNAVAILABLE: '暂时无法检查模型配置，请尝试重新启动。',
    unknown: '本地服务意外停止，请重新启动；若仍然失败，可保存日志用于排查。',
  },
};

export function startupLabels(language: string) { return messages[language === 'zh-CN' ? 'zh-CN' : 'en']; }

export function startupFailure(error: string, language: string) {
  const labels = startupLabels(language);
  const code = error.match(/\bPD_[A-Z_]+\b/)?.[0] || 'PD_RUNTIME_PROCESS_FAILED';
  const reason = labels[code as keyof typeof labels] || labels.unknown;
  return { code, reason, logPath: error.match(/^Runtime log:\s*(.+)$/m)?.[1] };
}
