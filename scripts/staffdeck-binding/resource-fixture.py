"""Seed child rows for a base created by the formal management API."""
import json
import os
import sys
from uuid import uuid4
from sqlmodel import Session, select
from app.db import engine
from app.db.models import (KnowledgeBaseVersion, KnowledgeDocument, KnowledgeBucket,
                           KnowledgeChunk, KnowledgeIngestJob, KnowledgeDiscoverySuggestion)

base_id = sys.argv[1]
tenant = 'binding-tenant'
suffix = uuid4().hex
ids = {kind: f'binding_{kind}_{suffix}' for kind in ['document', 'bucket', 'chunk', 'job', 'suggestion']}
with Session(engine) as db:
    version = db.exec(select(KnowledgeBaseVersion).where(KnowledgeBaseVersion.knowledge_base_id == base_id)).first()
    assert version is not None
    version_name = version.version
    common = dict(tenant_id=tenant, knowledge_base_id=base_id, knowledge_base_version_id=version.id)
    rows = [KnowledgeDocument(id=ids['document'], **common, filename='matrix.md', file_type='md',
                              status='ready', title='A_PRIVATE_MATRIX_9351'),
            KnowledgeBucket(id=ids['bucket'], **common, document_id=ids['document'],
                            bucket_key='matrix', title='Matrix', summary='A_PRIVATE_MATRIX_9351'),
            KnowledgeChunk(id=ids['chunk'], **common, document_id=ids['document'],
                           bucket_id=ids['bucket'], chunk_index=0, content='A_PRIVATE_MATRIX_9351'),
            KnowledgeIngestJob(id=ids['job'], **common, document_id=ids['document'],
                               filename='matrix.md', status='succeeded', stage='done'),
            KnowledgeDiscoverySuggestion(id=ids['suggestion'], **common, document_id=ids['document'],
                                         suggestion_type='warning', title='Matrix')]
    for row in rows:
        db.add(row)
    db.commit()
print(json.dumps({**ids, 'base': base_id, 'version': version_name}))
