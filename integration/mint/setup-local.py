#!/usr/bin/env python3
"""Recreate the local instance configuration; preserve installed artifacts and state."""
import json, os, pathlib, shutil, subprocess
repo=pathlib.Path(__file__).resolve().parents[2]
runtime=pathlib.Path(os.environ.get('PILOTDECK_TEST_RUNTIME','/Users/a1/Documents/ChatGPT/pilotdeck-mint-runtime'))
project=runtime/'utf8-registry-project'
source=pathlib.Path(os.environ.get('MINT_INSTALL_SOURCE','/tmp/mint-pilotdeck-curated-install-20261105-28489'))
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

subprocess.run([os.environ.get('MINT_BIN','/tmp/mint-merge-all-mrs-20261104/target/debug/mint'),'add','pilotdeck/context-instructions@0.1.6','pilotdeck/context-retention@0.2.5','pilotdeck/context-tool-result-pruner@0.1.8','pilotdeck/context-budget-production@0.3.6','pilotdeck/model-provider-openai-consumer@0.1.3','--registry','mint-hub','-y'],cwd=project,check=True)
(project/'LOCAL-OVERRIDE.md').unlink(missing_ok=True)
