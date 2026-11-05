#!/usr/bin/env python3
import os,json,pathlib
root=pathlib.Path(__file__).resolve().parent
env=dict(os.environ,**json.loads((root/'env.json').read_text()))
for key in ('MINT_MODEL_API_KEY','MINT_MODEL_ENDPOINT','MINT_MODEL'):
    if key in os.environ: env[key]=os.environ[key]
command='/tmp/mint-merge-all-mrs-20261104/target/debug/cpmrt'
args=[command,'acp','--cwd',env['MINT_PROJECT'],'--kernel-command=/tmp/mint-merge-all-mrs-20261104/target/debug/examples/installed-owner-kernel','--kernel-arg=--config','--kernel-arg='+str(root/'kernel.toml'),'--kernel-arg=--data-dir','--kernel-arg='+str(root/'data'),'--kernel-arg=--components-dir','--kernel-arg='+str(root/'components')]
os.execve(command,args,env)
