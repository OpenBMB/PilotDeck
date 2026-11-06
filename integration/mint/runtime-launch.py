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
env = {**config, **env}
for key in ('MINT_MODEL_API_KEY', 'MINT_MODEL_ENDPOINT', 'MINT_MODEL'):
    if key in os.environ:
        env[key] = os.environ[key]

sidecar = os.environ.get('PILOTDECK_MINT_SIDECAR_BIN') or env.get('PILOTDECK_MINT_SIDECAR_BIN')
if sidecar:
    args = json.loads(os.environ.get('PILOTDECK_MINT_SIDECAR_ARGS', '[]'))
    if not isinstance(args, list) or any(not isinstance(value, str) for value in args):
        raise SystemExit('PILOTDECK_MINT_SIDECAR_ARGS must be a JSON string array')
    os.execve(sidecar, [sidecar, *args], env)

# The formal local sidecar is the Rust ACP binary itself. With no external
# kernel argument, cpmrt uses the Rust Agent/turn loop and loads the project
# Mint Host directly; this path never starts installed_loop_worker.
cpmrt = os.environ.get('PILOTDECK_MINT_CPMRT_BIN') or env.get('PILOTDECK_MINT_CPMRT_BIN')
if cpmrt:
    project = env.get('MINT_PROJECT') or env.get('PILOTDECK_MINT_PROJECT')
    if not project:
        raise SystemExit('Mint sidecar requires MINT_PROJECT or PILOTDECK_MINT_PROJECT')
    args = [cpmrt, 'acp', '--cwd', project]
    os.execve(cpmrt, args, env)

# A legacy external-kernel path is diagnostic-only and must be fully explicit.
kernel = os.environ.get('PILOTDECK_MINT_KERNEL_BIN') or env.get('PILOTDECK_MINT_KERNEL_BIN')
loop = os.environ.get('PILOTDECK_MINT_LOOP_BIN') or env.get('PILOTDECK_MINT_LOOP_BIN')
if not (kernel and loop):
    raise SystemExit(
        'Mint sidecar is not configured. Set PILOTDECK_MINT_SIDECAR_BIN or '
        'PILOTDECK_MINT_CPMRT_BIN; legacy external-kernel diagnostics require '
        'PILOTDECK_MINT_KERNEL_BIN and PILOTDECK_MINT_LOOP_BIN.'
    )
raise SystemExit('legacy external-kernel mode requires an explicit cpmrt binary')
