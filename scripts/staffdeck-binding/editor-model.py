"""Install a loopback deterministic SD authoring model in the isolated fixture."""
import json
import os
from pathlib import Path
from sqlmodel import Session, select
from app.db import engine
from app.db.models import ModelConfig
from app.security.encryption import encrypt_secret

qa = Path(os.environ['BINDING_QA_ROOT'])
env = json.loads((qa / 'env.json').read_text())
credentials = json.loads((qa / 'credentials.json').read_text())
with Session(engine) as db:
    tenant = credentials['actor']['tenantId']
    row = db.exec(select(ModelConfig).where(ModelConfig.tenant_id == tenant,
                                          ModelConfig.name == 'Binding editor fixture')).first()
    if row is None:
        row = ModelConfig(tenant_id=tenant, name='Binding editor fixture',
                          base_url=f"http://127.0.0.1:{int(env['SERVER_PORT']) + 1}/v1",
                          model='binding-deterministic', api_key_encrypted=encrypt_secret('binding-local'),
                          enabled=True, is_default=True)
        db.add(row)
        db.commit()
    row.api_key_encrypted = encrypt_secret('binding-local')
    db.add(row)
    db.commit()
    print(json.dumps({'modelId': row.id, 'tenantId': tenant, 'enabled': row.enabled}))
