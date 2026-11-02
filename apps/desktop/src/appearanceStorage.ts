import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfiguration, updateConfiguration } from '@pilotdeck/config';
import { normalizeAppearance, type DesktopAppearance } from './appearance';
import { isImageId, MAX_BACKGROUND_BYTES } from './lightAppearance';

export function readAppearanceSettings(userData: string, configHome: string, locale: string): DesktopAppearance {
  const value = readConfiguration(path.join(configHome, 'appearance.yaml'), {
    defaults: normalizeAppearance(null, locale), legacyPaths: [path.join(userData, 'appearance.json')],
    normalize: value => normalizeAppearance(value, locale),
  }).value;
  const id = value.lightAppearance?.background.imageId;
  if (isImageId(id)) {
    const source = path.join(userData, 'appearance-images', id);
    const target = path.join(configHome, 'appearance-images', id);
    if (source !== target && fs.existsSync(source) && !fs.existsSync(target)) {
      try { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
      catch { /* The legacy image stays available for a later migration attempt. */ }
    }
  }
  return value;
}

export function saveAppearancePatch(userData: string, current: DesktopAppearance, value: unknown, locale: string, configHome = userData): DesktopAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid appearance');
  return updateConfiguration(path.join(configHome, 'appearance.yaml'), stored => normalizeAppearance({ ...stored, ...value }, locale), { defaults: current });
}
export function appearanceImagePath(userData: string, id: unknown): string {
  if (!isImageId(id)) throw new Error('Invalid background image id');
  return path.join(userData, 'appearance-images', id);
}
export function writeAppearanceImage(userData: string, value: unknown, dimensions: (buffer: Buffer) => { width: number; height: number }): string {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_BACKGROUND_BYTES) throw new Error('Invalid background image');
  const bytes = Buffer.from(value);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid image format');
  const size = dimensions(bytes);
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0 || size.width > 3840 || size.height > 3840) throw new Error('Invalid image dimensions');
  const id = `${randomUUID()}.png`;
  const file = appearanceImagePath(userData, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return id;
}
