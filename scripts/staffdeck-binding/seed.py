"""Create isolated acceptance accounts using the real StaffDeck database APIs."""
import json
import os
from pathlib import Path

from sqlmodel import Session, select

from app.db import engine, init_db
from app.db.models import Tenant, User, AgentProfile, PilotDeckProjectBinding
from app.api.auth import AccountAPICredentialCreateRequest, create_account_api_credential
from app.security.auth import create_access_token, hash_password

init_db()
output = Path(os.environ['BINDING_QA_ROOT']) / 'credentials.json'
if not output.exists():
    credentials = {}
    with Session(engine) as db:
        for tenant in ['binding-tenant', 'binding-other-tenant']:
            db.add(Tenant(id=tenant, name=tenant))
        for name, tenant, role in [('actor', 'binding-tenant', 'member'),
                                   ('admin', 'binding-tenant', 'admin'),
                                   ('stranger', 'binding-tenant', 'member'),
                                   ('other', 'binding-other-tenant', 'member')]:
            user = User(id=f'binding-{name}', tenant_id=tenant, username=f'binding-{name}',
                        role=role, password_hash=hash_password('binding-acceptance-only'))
            db.add(user)
            db.commit()
            credential = create_account_api_credential(
                AccountAPICredentialCreateRequest(name='Binding acceptance'), user, db)
            credentials[name] = {'userId': user.id, 'tenantId': tenant,
                                 'token': create_access_token(user), 'key': credential.api_key,
                                 'credentialId': credential.id}
    output.write_text(json.dumps(credentials), encoding='utf-8')
    output.chmod(0o600)
with Session(engine) as db:
    print(json.dumps({'agents': len(db.exec(select(AgentProfile)).all()),
                      'mappings': len(db.exec(select(PilotDeckProjectBinding)).all())}))
