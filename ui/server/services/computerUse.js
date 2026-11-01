import { randomUUID } from 'node:crypto';
import { StandaloneComputerUseController } from './standaloneComputerUse.js';

const REQUEST = 'pilotdeck:computer-use-request';
const RESPONSE = 'pilotdeck:computer-use-response';

// The HTTP API is shared by Electron's renderer and ordinary browsers.
// macOS always uses the bundled native GUI helper, so Web and desktop have the
// same permission owner. Windows/Linux retain Electron's private IPC control.
export function createComputerUseService({ env = process.env, platform = process.platform, processLike = process,
  standaloneFactory = () => new StandaloneComputerUseController({ platform,
    env: env.PILOTDECK_DESKTOP === '1' ? { ...env, PILOTDECK_CUA_DRIVER_PATH: undefined } : env }), timeoutMs = 45_000 } = {}) {
  if (env.PILOTDECK_DESKTOP !== '1' || platform === 'darwin') return standaloneFactory();
  const pending = new Map();
  const receive = message => {
    if (message?.type !== RESPONSE || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.status);
  };
  const disconnect = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Computer use host disconnected')); }
    pending.clear();
  };
  processLike.on('message', receive);
  processLike.on('disconnect', disconnect);
  const request = (action, value) => new Promise((resolve, reject) => {
    if (!processLike.connected || typeof processLike.send !== 'function') return reject(new Error('Computer use host is unavailable'));
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Computer use host timed out')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { processLike.send({ type: REQUEST, id, action, value }, error => {
      if (!error || !pending.has(id)) return;
      pending.delete(id); clearTimeout(timer); reject(error);
    }); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
  return {
    initialize: async () => {},
    status: () => request('status'),
    setEnabled: enabled => request('setEnabled', enabled),
    refresh: () => request('refresh'),
    requestPermission: permission => request('requestPermission', permission),
    revealPermissionApp: () => request('revealPermissionApp'),
    stop: async () => { disconnect(); processLike.off('message', receive); processLike.off('disconnect', disconnect); },
  };
}
