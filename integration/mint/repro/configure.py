#!/usr/bin/env python3
"""Create an isolated instance from committed manifests; never patch artifacts."""
import argparse,json,os,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--host-source',required=True);p.add_argument('--mint',required=True);p.add_argument('--model',default='mint-minicpm5:2.6b-q4_k_m');p.add_argument('--base-url',default='http://127.0.0.1:11434/v1');p.add_argument('--server-port',type=int,default=3101);p.add_argument('--web-port',type=int,default=5273);a=p.parse_args()
root=Path(a.root).resolve();repo=Path(__file__).resolve().parents[3];host=Path(a.host_source).resolve();mint=Path(a.mint).resolve();project=root/'project';home=root/'mint-home'
if (root/'env.json').exists():raise SystemExit('Instance already configured; use its existing env.json to preserve history')
project.mkdir(parents=True,exist_ok=True);home.mkdir(exist_ok=True)
(root/'logs').mkdir(exist_ok=True)
for n in ['mint.toml','mint.lock']:shutil.copyfile(Path(__file__).parent/n,project/n)
base=a.base_url.rstrip('/');endpoint=base+'/chat/completions'
(home/'config.toml').write_text(f'[model]\nprovider = "openai"\nbase_url = {json.dumps(base)}\nmodel = {json.dumps(a.model)}\nsupports_tools = true\ncontext_window = 32768\nmax_output_tokens = 4096\n')
(home/'trust.toml').write_text(f'[projects.{json.dumps(str(project.resolve()))}]\ntrust = "trusted"\n')
config=f'''\n[packages."pilotdeck/context-instructions".config.instructions]
projectRoot = "/"
cwd = "/"
pilotHome = "/.pilotdeck"
[packages."liyishan1/pilotdeck-context-prompt-consumer".config]
provider = "mint"
permissionMode = "default"
environmentContext = ""
[packages."liyishan1/pilotdeck-context-prompt-consumer".config.hostEnvironment]
platform = "darwin"
runtimeVersion = "Rust AgentCPM / Mint Host"
[packages."liyishan1/pilotdeck-context-time-consumer".config.preparedContext]
systemPrompt = "You are a helpful assistant."
messages = []
[packages."pilotdeck/context-retention".config.retention]
maxResultSizeChars = 3000
previewBytes = 512
'''
with (project/'mint.toml').open('a') as f:f.write(config)
(project/'PILOTDECK.md').write_text('Deployment acceptance marker: MINT_REPRO_13.\n')
(project/'browser-proof.txt').write_text('MINT_REPRO_FS 青岛 🙂\n')
import tomllib
packages=tomllib.loads((project/'mint.lock').read_text())['package'];required=[x['name'] for x in packages if x['kind']=='plugin']
grants={n:{} for n in required}
for n in ['pilotdeck/context-instructions','liyishan1/pilotdeck-attachments-consumer','liyishan1/pilotdeck-tool-fs-read']:grants[n]={'fs.read':['$WORKDIR'],'fs.write':['$WORKDIR']}
grants['pilotdeck/context-retention']={'fs.read':['/.pilotdeck/tool-results'],'fs.write':['/.pilotdeck/tool-results']}
for n in ['liyishan1/pilotdeck-compaction-basic','liyishan1/pilotdeck-compaction-port-owner']:grants[n]={'model':True}
grants['pilotdeck/model-provider-openai-consumer']={'net':[endpoint],'model':True}
env={'MINT_HOME':str(home),'MINT_CACHE_DIR':str(root/'cache'),'MINT_PROJECT':str(project),'MINT_HOST_BIN':str(host/'target/debug/mint-host'),'MINT_REQUIRED_PLUGINS':json.dumps(required),'MINT_PLUGIN_GRANTS':json.dumps(grants),'MINT_MODEL_ENDPOINT':endpoint,'MINT_MODEL':a.model,'MINT_MODEL_PRIVATE_HOSTS':'["127.0.0.1"]','MINT_CONTEXT_WINDOW':'32768','MINT_OUTPUT_LIMIT':'4096','PILOTDECK_RUNTIME_BACKEND':'mint','PILOTDECK_DISABLE_LOCAL_AUTH':'1','PILOTDECK_MINT_PROJECT':str(project),'PILOTDECK_MINT_STATE_DIR':str(root/'bridge-state'),'PILOTDECK_MINT_MODEL':a.model,'PILOTDECK_MINT_STRUCTURED_INPUT':'1','PILOTDECK_MINT_CPMRT_BIN':str(host/'target/debug/cpmrt'),'PILOTDECK_MINT_COMMAND':str(repo/'integration/mint/runtime-launch.py'),'PILOT_HOME':str(root/'pilot-home'),'HOST':'127.0.0.1','SERVER_PORT':str(a.server_port),'PORT':str(a.server_port),'WEB_PORT':str(a.web_port),'PILOTDECK_TEST_RUNTIME':str(root),'MINT_REQUEST_EVIDENCE_DIR':str(root/'request-evidence'),'MINT_CONTEXT_OWNER_COMMAND':'/usr/bin/env','MINT_CONTEXT_OWNER_ARGS':json.dumps(['node','--import','tsx','integration/mint/context-owner.mjs']),'MINT_CONTEXT_OWNER_CWD':str(repo),'MINT_IMAGE_OFFLOAD_PACKAGE':str(project/'.mint/packages/liyishan1/pilotdeck-context-image-offload@0.1.4/dist/index.js'),'MINT_MEDIA_EVIDENCE':str(root/'media-evidence.jsonl'),'MINT_TOOL_RESULTS_DIR':str(root/'tool-results')}
(root/'env.json').write_text(json.dumps(env,indent=2)+'\n')
env={**os.environ,**env};subprocess.run([str(mint),'install','--locked'],cwd=project,env=env,check=True)
subprocess.run([str(mint),'install','--locked','--offline'],cwd=project,env=env,check=True)
print('Configured',root)
