import fs from 'fs';

const DEFAULT_GIT_BASH_PATHS = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
];

export function resolveWindowsGitBash(env = process.env, existsSync = fs.existsSync) {
    const candidates = [
        env.PILOTDECK_GIT_BASH_PATH,
        env.GIT_BASH_PATH,
        ...(env.ProgramFiles ? [
            `${env.ProgramFiles}\\Git\\bin\\bash.exe`,
            `${env.ProgramFiles}\\Git\\usr\\bin\\bash.exe`,
        ] : []),
        ...(env['ProgramFiles(x86)'] ? [
            `${env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
            `${env['ProgramFiles(x86)']}\\Git\\usr\\bin\\bash.exe`,
        ] : []),
        ...DEFAULT_GIT_BASH_PATHS,
    ].filter(Boolean);

    const seen = new Set();
    for (const candidate of candidates) {
        const normalized = String(candidate);
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (existsSync(normalized)) return normalized;
    }

    return null;
}

export function getDefaultPtyShell(platform = process.platform, env = process.env, existsSync = fs.existsSync) {
    if (platform !== 'win32') {
        return { shell: 'bash', args: (command) => ['-c', command], kind: 'bash' };
    }

    const gitBash = resolveWindowsGitBash(env, existsSync);
    if (gitBash) {
        return { shell: gitBash, args: (command) => ['--login', '-i', '-c', command], kind: 'git-bash' };
    }

    return { shell: 'powershell.exe', args: (command) => ['-NoProfile', '-Command', command], kind: 'powershell' };
}
