"""Seed a completed private job for full-service ownership checks."""
import json
import os
from pathlib import Path
from uuid import uuid4
from sqlmodel import Session
from app.db import engine
from app.db.models import APIJob, APIJobEvent

qa = Path(os.environ['BINDING_QA_ROOT'])
env = json.loads((qa / 'env.json').read_text())
project = json.loads((qa / 'projects.json').read_text())['a']
job_id = 'binding_job_' + uuid4().hex
with Session(engine) as db:
    db.add(APIJob(id=job_id, tenant_id=env['STAFFDECK_COPY_TENANT_ID'],
        credential_id=env['STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID'],
        agent_id=project['staffdeckBinding']['agentId'], kind='knowledge.binding_test', status='succeeded',
        result_json={'marker': 'A_PRIVATE_JOB_5923'}))
    db.add(APIJobEvent(tenant_id=env['STAFFDECK_COPY_TENANT_ID'], job_id=job_id, sequence=1,
        event_type='job.succeeded', data_json={'marker': 'A_PRIVATE_EVENT_6134'}))
    db.commit()
print(json.dumps({'jobId': job_id}))
