#!/usr/bin/env python3
"""Fetch pinned toolchain sources and build from Git, then configure an instance."""
import argparse,json,subprocess,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',required=True);a,extra=p.parse_known_args();root=Path(a.root).resolve();root.mkdir(parents=True,exist_ok=True);here=Path(__file__).resolve().parent
sources=json.loads((here/'sources.json').read_text())
for name in ['host','cli']:
 spec=sources[name];dst=root/(name+'-source')
 if not dst.exists():subprocess.run(['git','clone','--no-checkout','--single-branch','--branch',spec['branch'],spec['url'],str(dst)],check=True)
 subprocess.run(['git','checkout','--detach',spec['commit']],cwd=dst,check=True)
 cmd=['cargo','build','--locked']+(['--release','-p','mint-cli','--bin','mint'] if name=='cli' else ['-p','mint-core-bin','--features','js-host','--bin','cpmrt','-p','mint-host','--bin','mint-host'])
 subprocess.run(cmd,cwd=dst,check=True)
subprocess.run([sys.executable,str(here/'configure.py'),'--root',str(root/'instance'),'--host-source',str(root/'host-source'),'--mint',str(root/'cli-source/target/release/mint'),*extra],check=True)
