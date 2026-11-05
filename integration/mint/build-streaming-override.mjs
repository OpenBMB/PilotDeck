import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from '../../node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/lib/main.js';
const project=resolve(process.argv[2]);
const pkg=resolve(project,'.mint/packages/pilotdeck/model-provider-openai-consumer@0.1.2');
const bundle=resolve(pkg,'dist/index.js');
try {await access(bundle+'.published');} catch {await copyFile(bundle,bundle+'.published');}
const manifest=resolve(pkg,'mint.toml');
let toml=await readFile(manifest,'utf8');
if(!/^model = true$/m.test(toml))toml=toml.replace('[capabilities]','[capabilities]\nmodel = true');
await writeFile(manifest,toml);
await build({entryPoints:[resolve(import.meta.dirname,'streaming-consumer.mjs')],outfile:bundle,bundle:true,format:'esm',platform:'neutral',target:'es2022',plugins:[{name:'published-codec',setup(b){b.onResolve({filter:/^pilotdeck-model-openai-compat$/},()=>({path:resolve(pkg,'vendor/pilotdeck-model-openai-compat-0.1.2/dist/index.js')}));}}]});
await writeFile(resolve(project,'LOCAL-OVERRIDE.md'),`Local probe override: model consumer 0.1.2 now uses generic model.http_stream/model.event services for live delivery, retaining published codec 0.1.2. Original JS is dist/index.js.published, original manifest mint.toml.published. Exact local HTTP scope and model service capability added. This is not full external-loop acceptance.\n`);
