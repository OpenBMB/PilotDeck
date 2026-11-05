#!/usr/bin/env python3
"""Recreate the local instance configuration; preserve installed artifacts and state."""
import json, os, pathlib, shutil, subprocess
repo=pathlib.Path(__file__).resolve().parents[2]
runtime=pathlib.Path(os.environ.get('PILOTDECK_TEST_RUNTIME','/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime'))
project=runtime/'pilotdeck-13-package-project'
source=pathlib.Path(os.environ.get('MINT_INSTALL_SOURCE','/tmp/mint-pilotdeck-image-offload-20261105'))
if not project.exists(): shutil.copytree(source,project)
unified=runtime/'utf8-unified';unified.mkdir(parents=True,exist_ok=True)
for name in ['env.json','kernel.toml','components.json','launch.py']:
 target=unified/name
 if not target.exists(): shutil.copyfile(repo/'integration/mint'/('runtime-'+name),target)
(unified/'components/bootstrap').mkdir(parents=True,exist_ok=True)
shutil.copyfile(repo/'integration/mint/runtime-bootstrap.toml',unified/'components/bootstrap/metadata.toml')
(unified/'launch.py').chmod(0o755)
env=json.loads((unified/'env.json').read_text())
env.update(MINT_PROJECT=str(project),MINT_CONTEXT_OWNER_CWD=str(repo),AGENTCPM_STARTUP_COMPONENTS=str(unified/'components.json'),MINT_REQUEST_EVIDENCE_DIR=str(unified/'request-evidence'))
# Credentials remain inherited environment values; this local model requires none.
(unified/'env.json').write_text(json.dumps(env,indent=2))
name=str(project).lstrip('/').replace('/','-')
marker=runtime/'.pilotdeck/projects'/name
marker.mkdir(parents=True,exist_ok=True);(marker/'.cwd').write_text(str(project))
print('Configured',unified,'for',project)

print('Package installation is preserved from', source)
