#!/usr/bin/env python3
"""Launch the PilotDeck Mint backend.

The preferred path is a composed Rust sidecar. The legacy cpmrt supervisor
path is retained only when all three explicit legacy paths are supplied; it is
never inferred from an old temporary checkout.
"""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parent
env = dict(os.environ)
config = json.loads((root / 'env.json').read_text()) if (root / 'env.json').is_file() else {}
env.update(config)
for key in ('MINT_MODEL_API_KEY', 'MINT_MODEL_ENDPOINT', 'MINT_MODEL'):
    if key in os.environ:
        env[key] = os.environ[key]

sidecar = os.environ.get('PILOTDECK_MINT_SIDECAR_BIN') or env.get('PILOTDECK_MINT_SIDECAR_BIN')
if sidecar:
    args = json.loads(os.environ.get('PILOTDECK_MINT_SIDECAR_ARGS', '[]'))
    if not isinstance(args, list) or any(not isinstance(value, str) for value in args):
        raise SystemExit('PILOTDECK_MINT_SIDECAR_ARGS must be a JSON string array')
    os.execve(sidecar, [sidecar, *args], env)

# Keep the old cpmrt route explicit for diagnostic compatibility. It is not
# the production integration route and cannot silently select an installed
# loop worker.
cpmrt = os.environ.get('PILOTDECK_MINT_CPMRT_BIN') or env.get('PILOTDECK_MINT_CPMRT_BIN')
kernel = os.environ.get('PILOTDECK_MINT_KERNEL_BIN') or env.get('PILOTDECK_MINT_KERNEL_BIN')
loop = os.environ.get('PILOTDECK_MINT_LOOP_BIN') or env.get('PILOTDECK_MINT_LOOP_BIN')
if not (cpmrt and kernel and loop):
    raise SystemExit(
        'Mint sidecar is not configured. Set PILOTDECK_MINT_SIDECAR_BIN; '
        'legacy cpmrt diagnostics require PILOTDECK_MINT_CPMRT_BIN, '
        'PILOTDECK_MINT_KERNEL_BIN and PILOTDECK_MINT_LOOP_BIN.'
    )
args = [cpmrt, 'acp', '--cwd', env['MINT_PROJECT'], '--kernel-command', kernel,
        '--kernel-arg=--config', '--kernel-arg=' + str(root / 'kernel.toml'),
        '--kernel-arg=--data-dir', '--kernel-arg=' + str(root / 'data'),
        '--kernel-arg=--components-dir', '--kernel-arg=' + str(root / 'components')]
os.execve(cpmrt, args, env)
