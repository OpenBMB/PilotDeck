#!/usr/bin/env python3
"""Run one command or manage the two instance-specific web processes."""
import argparse,json,os,signal,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('action',choices=['exec','start','stop']);p.add_argument('command',nargs=argparse.REMAINDER);a=p.parse_args()
root=Path(a.root).resolve();repo=Path(__file__).resolve().parents[3];env={**os.environ,**json.loads((root/'env.json').read_text())};env['MINT_MODEL_API_KEY']=os.environ.get('MINT_MODEL_API_KEY','local-no-secret');env['NODE_OPTIONS']=''
if a.action=='exec':
 cmd=a.command[1:] if a.command[:1]==['--'] else a.command
 if not cmd:raise SystemExit('exec requires a command after --')
 raise SystemExit(subprocess.call(cmd,cwd=repo,env=env))
pids=root/'processes.json'
if a.action=='stop':
 for pid in (json.loads(pids.read_text()).values() if pids.exists() else []):
  try:os.killpg(pid,signal.SIGTERM)
  except ProcessLookupError:pass
 if pids.exists():pids.unlink()
 raise SystemExit(0)
if pids.exists():raise SystemExit('Instance has processes.json; stop it before restarting')
logs=root/'logs';logs.mkdir(exist_ok=True);processes={}
try:
 for name,cmd in [('server',['node','--import','tsx','ui/server/index.js']),('web',['node','ui/node_modules/vite/bin/vite.js','ui','--config','ui/vite.config.js','--host','127.0.0.1','--port',env['WEB_PORT'],'--strictPort'])]:
  with (logs/(name+'.log')).open('ab') as f:
   child=subprocess.Popen(cmd,cwd=repo,env=env,stdout=f,stderr=f,start_new_session=True)
  processes[name]=child.pid;time.sleep(2)
  if child.poll() is not None:raise RuntimeError(f'{name} exited; inspect {logs/name}.log')
finally:pids.write_text(json.dumps(processes))
print('http://127.0.0.1:'+env['WEB_PORT'])
