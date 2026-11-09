// Additive metadata: schemaVersion remains 1 so installed clients can upgrade.
export function describeReleaseAsset(name) {
  const format = name.split('.').at(-1).toLowerCase();
  const platform = /mac|\.dmg$/.test(name) ? 'darwin'
    : /linux|\.(deb|rpm)$/.test(name) ? 'linux'
      : /win|\.exe$/.test(name) || /^latest-(x64|arm64)\.yml$/.test(name) ? 'win32' : 'unknown';
  const arch = /arm64|aarch64/.test(name) ? 'arm64' : /x64|x86_64|^latest-(rpm-)?linux\.yml$/.test(name) ? 'x64' : 'unknown';
  const roles = format === 'dmg' ? ['install'] : format === 'zip' && platform === 'darwin' ? ['update']
    : ['exe', 'deb', 'rpm'].includes(format) ? ['install', 'update'] : ['compatibility'];
  return { platform, arch, format, roles };
}

/** Derive the old protocol from the canonical payload records, never builder feeds. */
export function compatibilityFeeds(manifest) {
  const feeds = [];
  for (const asset of manifest.assets.filter(a => a.roles?.includes('update'))) {
    const { platform, arch, format } = asset;
    if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported update architecture');
    const name = platform === 'linux' ? `latest${format === 'rpm' ? '-rpm' : ''}-linux${arch === 'arm64' ? '-arm64' : ''}.yml`
      : `latest-${arch}${platform === 'darwin' ? '-mac' : ''}.yml`;
    if (feeds.some(f => f.name === name)) throw new Error(`Ambiguous update payload: ${name}`);
    const text = `version: ${manifest.version}\nfiles:\n  - url: ${asset.name}\n    sha512: ${asset.sha512}\n    size: ${asset.size}\n`
      + `path: ${asset.name}\nsha512: ${asset.sha512}\nreleaseDate: '${manifest.buildTime}'\n`;
    feeds.push({ name, text });
  }
  return feeds;
}

export function installerDownloads(assets) {
  return assets.filter(a => (a.roles ?? describeReleaseAsset(a.name).roles).includes('install'));
}
