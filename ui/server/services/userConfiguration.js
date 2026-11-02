import path from 'node:path';
import { resolveConfigHome } from '@pilotdeck/config';

export function userConfigurationDirectory(userId, home = resolveConfigHome()) {
  if (!/^\d+$/.test(String(userId))) throw new Error('Invalid user identity');
  return path.join(home, 'users', String(userId));
}
