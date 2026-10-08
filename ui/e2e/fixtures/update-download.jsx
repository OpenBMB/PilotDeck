import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import DesktopAboutSections from '../../src/components/settings/view/about/DesktopAboutSections';
import { applyLightAppearance } from '../../src/lib/appearanceRuntime';
import { normalizeLightAppearance } from '../../src/lib/lightAppearance';
import { normalizeDesktopVersionResult } from '../../src/components/settings/version';
import i18n from '../../src/i18n/config';
import '../../src/index.css';
import '../../src/components/settings/settings-page.css';
import '../../src/light-appearance.css';

const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get('language') || 'zh-CN');
const initial = params.get('state') || 'downloading';
let state = initial === 'downloading'
  ? { state: 'downloading', progress: .42, transferred: 84 * 1024 * 1024, total: 200 * 1024 * 1024, bytesPerSecond: 2.4 * 1024 * 1024 }
  : initial === 'failed' ? { state: 'failed', progress: .42, reason: 'updateFailed' } : { state: 'idle', progress: 0 };
const current = { version: '2026.1001.0' };
const available = { current, latest: { version: '2026.1002.0', publishedAt: '2026-10-02' }, hasUpdate: true, canDownload: true, checkUnavailable: false };
const initialCheck = initial === 'upToDate' ? { ...available, latest: current, hasUpdate: false, canDownload: false }
  : initial === 'unavailable' ? { current, latest: null, hasUpdate: false, canDownload: false, checkUnavailable: true, reason: 'checkFailed' } : available;
let checkResult = available;
const calls = [];
window.updateTest = {
  calls,
  release: value => { checkResult = { ...available, ...value }; },
  set: value => { state = { ...state, ...value }; },
  theme: (preset = 'default', dark = false) => {
    document.documentElement.classList.toggle('dark', dark);
    applyLightAppearance(normalizeLightAppearance({ preset }), dark);
  },
};
window.pilotdeckDesktop = {
  platform: params.get('platform') || 'linux',
  checkUpdates: async () => {
    calls.push('check');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!checkResult.checkUnavailable) state = { state: 'idle', progress: 0 };
    return { ...checkResult };
  },
  getUpdateStatus: async () => ({ ...state }),
  startUpdate: async () => { calls.push('start'); state = { state: 'downloading', progress: 0, transferred: 0 }; return { ...state }; },
  pauseUpdate: async () => { state = { ...state, state: 'paused', bytesPerSecond: 0 }; return { ...state }; },
  resumeUpdate: async () => { state = { ...state, state: 'downloading', bytesPerSecond: 2.4 * 1024 * 1024 }; return { ...state }; },
  cancelUpdate: async () => { state = { ...state, state: 'cancelled', reason: 'cancelled', bytesPerSecond: 0 }; return { ...state }; },
};
window.updateTest.theme();
function About() {
  const [versionInfo, setVersionInfo] = useState(() => normalizeDesktopVersionResult(initialCheck));
  const [checkingVersion, setCheckingVersion] = useState(false);
  const check = async () => {
    setCheckingVersion(true);
    try { setVersionInfo(normalizeDesktopVersionResult(await window.pilotdeckDesktop.checkUpdates())); }
    finally { setCheckingVersion(false); }
  };
  return <DesktopAboutSections title="About" checkingVersion={checkingVersion} versionInfo={versionInfo} onCheckUpdates={check} />;
}
createRoot(document.getElementById('root')).render(
  <main className="app-root" style={{ minHeight: '100vh', padding: 24 }}>
    <div className="pilotdeck-settings-app" style={{ display: 'block', maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 20 }}>PilotDeck</h1>
      <About />
    </div>
  </main>,
);
