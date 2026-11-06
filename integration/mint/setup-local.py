#!/usr/bin/env python3
"""Recreate the local instance configuration; preserve installed artifacts and state."""
import json, os, pathlib, shutil, subprocess
repo=pathlib.Path(__file__).resolve().parents[2]
runtime=pathlib.Path(os.environ.get('PILOTDECK_TEST_RUNTIME','/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime'))
project=(runtime/'pilotdeck-13-package-project').resolve()
source=pathlib.Path(os.environ.get('MINT_INSTALL_SOURCE','/tmp/mint-pilotdeck-image-offload-20261105'))
if not project.exists(): shutil.copytree(source,project)
# Package activation configuration belongs to the project, not the Host or iface.
# Keep the installed manifests/lock untouched and add only the runtime-owned
# values required by the published context consumers.
project_manifest = project/'mint.toml'
manifest_text = project_manifest.read_text()
config = r'''

[packages."pilotdeck/context-instructions".config.instructions]
projectRoot = "/"
cwd = "/"
pilotHome = "/.pilotdeck"

[packages."liyishan1/pilotdeck-context-prompt-consumer".config]
environmentContext = ""
provider = "mint"
permissionMode = "default"

[packages."liyishan1/pilotdeck-context-prompt-consumer".config.hostEnvironment]
platform = "darwin"
runtimeVersion = "Rust AgentCPM / Mint Host"

[packages."liyishan1/pilotdeck-context-time-consumer".config.preparedContext]
systemPrompt = "You are a helpful assistant."
messages = []

[packages."pilotdeck/context-retention".config.retention]
maxResultSizeChars = 200000
previewBytes = 2048
'''
if '[packages."pilotdeck/context-instructions".config.instructions]' not in manifest_text:
    project_manifest.write_text(manifest_text.rstrip() + config)
# The published image-offload artifact is an owner-injected library whose
# historical entry exported a named function. Mint JS plugins require a
# default activation object; keep this compatibility override local to the
# integration project and preserve the published lock/artifact.
image_entry = project/'.mint/packages/liyishan1/pilotdeck-context-image-offload@0.1.1/plugin/js/default.js'
if image_entry.is_file():
    image_entry.write_text('''import { createImageOffload } from '../../dist/index.js';\nexport default {\n  activate(ctx) {\n    if (ctx && typeof ctx.maybeReplaceMedia === "function") return createImageOffload({ budget: ctx });\n    ctx?.debug?.("image offload owner deferred to the ToolResultBudget consumer");\n  },\n};\n''')
image_dist = image_entry.parent.parent.parent/'dist/index.js'
if image_dist.is_file():
    image_source=image_dist.read_text()
    if 'export default' not in image_source:
        image_dist.write_text(image_source.rstrip()+'''\n\nexport default {\n  activate(ctx) {\n    ctx?.debug?.("image offload owner deferred to the ToolResultBudget consumer");\n  },\n};\n''')
unified=runtime/'utf8-unified';unified.mkdir(parents=True,exist_ok=True)
for name in ['env.json','kernel.toml','components.json','launch.py']:
 target=unified/name
 if not target.exists(): shutil.copyfile(repo/'integration/mint'/('runtime-'+name),target)
(unified/'components/bootstrap').mkdir(parents=True,exist_ok=True)
shutil.copyfile(repo/'integration/mint/runtime-bootstrap.toml',unified/'components/bootstrap/metadata.toml')
(unified/'launch.py').chmod(0o755)
env=json.loads((unified/'env.json').read_text())
env.update(MINT_PROJECT=str(project),MINT_CONTEXT_OWNER_CWD=str(repo),AGENTCPM_STARTUP_COMPONENTS=str(unified/'components.json'),MINT_REQUEST_EVIDENCE_DIR=str(unified/'request-evidence'))
# The Rust ACP path loads JS packages only for explicitly trusted projects.
# Keep that decision in this independent test instance so the default user
# trust ledger and unrelated Mint projects are never changed.
mint_home=runtime/'.mint-home'; mint_home.mkdir(parents=True,exist_ok=True)
# Keep the tested local model profile available while isolating package/session
# state. Secrets remain environment-provided by the launcher.
user_config=pathlib.Path.home()/'.mint'/'config.toml'
if user_config.is_file() and not (mint_home/'config.toml').exists():
    shutil.copyfile(user_config, mint_home/'config.toml')
model_config=mint_home/'config.toml'
if model_config.is_file():
    model_text=model_config.read_text()
    if '[model]' in model_text and 'context_window' not in model_text:
        marker='\n[core]'
        values="\ncontext_window = 32768\nmax_output_tokens = 4096\n"
        model_text=(model_text.replace(marker, values+marker, 1)
                    if marker in model_text else model_text.rstrip()+values)
        model_config.write_text(model_text)
trust=mint_home/'trust.toml'
key=os.path.realpath(project).replace('\\','/')
entry=f'\n[projects."{key}"]\ntrust = "trusted"\n'
existing=trust.read_text() if trust.exists() else ''
if f'[projects."{key}"]' not in existing:
    trust.write_text(existing.rstrip()+entry)
env['MINT_HOME']=str(mint_home)
# Credentials remain inherited environment values; this local model requires none.
(unified/'env.json').write_text(json.dumps(env,indent=2))
name=str(project).lstrip('/').replace('/','-')
marker=runtime/'.pilotdeck/projects'/name
marker.mkdir(parents=True,exist_ok=True);(marker/'.cwd').write_text(str(project))
print('Configured',unified,'for',project)

print('Package installation is preserved from', source)
