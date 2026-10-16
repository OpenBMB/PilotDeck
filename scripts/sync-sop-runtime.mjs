import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Vendor only the portable Python package; never copy the StaffDeck backend.
const source = resolve(process.argv[2] || '../StaffDeck/portable_sop');
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/sop-runtime');
mkdirSync(target, { recursive: true });
cpSync(join(source, 'pyproject.toml'), join(target, 'pyproject.toml'));
rmSync(join(target, 'src'), { recursive: true, force: true });
for (const name of ['staffdeck_sop_core', 'staffdeck_sop_runtime']) {
  const destination = join(target, 'src', name);
  mkdirSync(destination, { recursive: true });
  for (const file of readdirSync(join(source, 'src', name))) {
    if (file.endsWith('.py')) cpSync(join(source, 'src', name, file), join(destination, file));
  }
}
console.log(`Portable SOP package copied to ${target}`);
