#!/usr/bin/env python3
"""Check captured requests, independent of model self-reports. No requests modified."""
import json,sys
from pathlib import Path
requests=[(p,json.loads(p.read_text())) for p in sorted(Path(sys.argv[1]).glob('*-request.json'))]
checks={
 'instructions': lambda d: any(m.get('role')=='system' and '<project-instructions>' in str(m.get('content')) and 'MINT_REPRO_13' in str(m.get('content')) for m in d.get('messages',[])),
 'prompt': lambda d: 'pilotdeck-context-prompt-consumer' in json.dumps(d),
 'time': lambda d: 'pilotdeck-context-time-consumer:host-hooks' in json.dumps(d) and '<environment>' in json.dumps(d),
 'attachments': lambda d: any(m.get('role')=='user' and '<attachment ' in str(m.get('content')) and 'plum-742' in str(m.get('content')) for m in d.get('messages',[])),
 'pruner': lambda d: any(m.get('role')=='tool' and '[Old tool result content compacted]' in str(m.get('content')) for m in d.get('messages',[])),
}
failed=False
for name,check in checks.items():
 matches=[p.name for p,d in requests if check(d)]
 print(json.dumps({'check':name,'status':'pass' if matches else 'missing_evidence','requests':matches}))
 failed|=not matches
sys.exit(1 if failed else 0)
