import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { prepareComputerUse } from '../../../scripts/prepare-computer-use.mjs';
export { selectDriverAsset, verifyDriverArchive } from '../../../scripts/prepare-computer-use.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareComputerUse();
