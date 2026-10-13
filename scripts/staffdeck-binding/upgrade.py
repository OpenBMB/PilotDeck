"""Boot the full application against an isolated pre-binding SQLite copy."""
import json
import os
import sqlite3
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

qa = Path(os.environ['BINDING_QA_ROOT'])
sd = Path(os.environ.get('STAFFDECK_CHECKOUT', Path(__file__).resolve().parents[3] / 'StaffDeck'))
target = qa / 'upgrade.sqlite'
with sqlite3.connect(qa / 'sd.sqlite') as source, sqlite3.connect(target) as copy:
    source.backup(copy)
    before = {table: copy.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
              for table in ['users', 'agent_profiles', 'skills', 'knowledge_bases']}
    copy.execute('DROP TABLE pilotdeck_project_bindings')
with socket.socket() as probe:
    probe.bind(('127.0.0.1', int(os.environ.get('BINDING_QA_UPGRADE_PORT', '0'))))
    port = probe.getsockname()[1]
env = {**os.environ, 'PYTHONPATH': f'{sd}/backend:{sd}/backend/src',
       'DATABASE_URL': f'sqlite:///{target}', 'ULTRARAG_DOTENV': str(qa / 'absent.env'),
       'APP_SECRET': 'binding-isolated-acceptance-secret', 'DEMO_SEED_ENABLED': 'false',
       'STARTUP_ORPHAN_CLEANUP_ENABLED': 'false', 'HARNESS_V3_HOME': str(qa / 'upgrade-home'),
       'HARNESS_RUNTIME_CONFIG_PATH': str(qa / 'upgrade-runtime.json')}
result = {'id': 'UPGRADE-FULL-APP', 'status': 'FAIL'}
started = time.monotonic()
with (qa / 'upgrade.log').open('ab') as log:
    child = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', str(port)],
                             cwd=sd, env=env, stdout=log, stderr=log)
    try:
        for _ in range(180):
            if child.poll() is not None:
                raise RuntimeError('Full StaffDeck application exited during upgrade')
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1) as response:
                    if response.status == 200:
                        if child.poll() is not None:
                            raise RuntimeError('Upgrade process exited before becoming healthy')
                        break
            except (OSError, ValueError):
                time.sleep(.25)
        else:
            raise RuntimeError('Full application health timeout')
        with sqlite3.connect(target) as db:
            after = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in before}
            assert before == after, (before, after)
            assert db.execute('SELECT count(*) FROM pilotdeck_project_bindings').fetchone()[0] == 0
        result.update(status='PASS', oldRows=before, newRows=after, mappings=0, fullApplicationHealthy=True)
    except Exception as error:
        result['error'] = str(error)
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
result['elapsedMs'] = round((time.monotonic() - started) * 1000)
(qa / 'upgrade-result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
sys.exit(result['status'] != 'PASS')
