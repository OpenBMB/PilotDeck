// Rebuild macOS template status images, retaining transparency and Retina scale.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
const icons = new URL('../resources/icons/', import.meta.url);
for (const scale of [1, 2]) {
  await sharp(fileURLToPath(new URL('trayTemplate.svg', icons)), { density: 72 * scale })
    .png().toFile(fileURLToPath(new URL(`trayTemplate${scale === 2 ? '@2x' : ''}.png`, icons)));
}
