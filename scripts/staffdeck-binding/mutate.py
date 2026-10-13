"""Temporary field mutations in the isolated acceptance database only."""
import json
import os
import sys
from pathlib import Path

from sqlmodel import Session
from app.db import engine
from app.db.models import APICredential, AgentProfile

qa = Path(os.environ['BINDING_QA_ROOT'])
env = json.loads((qa / 'env.json').read_text())
project = json.loads((qa / 'projects.json').read_text())['b']
snapshot = qa / 'mutation-private.json'
action = sys.argv[1]
with Session(engine) as db:
    credential = db.get(APICredential, env['STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID'])
    agent = db.get(AgentProfile, project['staffdeckBinding']['agentId'])
    if action == 'restore':
        saved = json.loads(snapshot.read_text())
        credential.status = saved['credentialStatus']
        credential.scopes_json = saved['credentialScopes']
        db.add(credential)
        if agent is None:
            agent = AgentProfile.model_validate(saved['agent'])
        else:
            agent.status = saved['agent']['status']
        db.add(agent)
        db.commit()
        snapshot.unlink()
    else:
        assert not snapshot.exists(), 'Restore previous mutation first'
        snapshot.write_text(json.dumps({'credentialStatus': credential.status,
            'credentialScopes': credential.scopes_json, 'agent': agent.model_dump(mode='json')}))
        snapshot.chmod(0o600)
        if action == 'revoke':
            credential.status = 'revoked'
            db.add(credential)
        elif action == 'downgrade':
            credential.scopes_json = ['agents:read']
            db.add(credential)
        elif action == 'archive':
            agent.status = 'archived'
            db.add(agent)
        elif action == 'missing':
            db.delete(agent)
        else:
            raise ValueError('Unknown mutation')
        db.commit()
print(json.dumps({'action': action, 'applied': True}))
