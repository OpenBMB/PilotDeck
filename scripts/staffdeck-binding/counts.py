"""Read database counts without initializing, seeding, or modifying tables."""
import json
import os

from sqlalchemy import create_engine, text

engine = create_engine(os.environ['DATABASE_URL'])
with engine.connect() as connection:
    counts = {key: connection.execute(text(f'SELECT count(*) FROM {table}')).scalar_one()
              for key, table in [('agents', 'agent_profiles'),
                                 ('mappings', 'pilotdeck_project_bindings')]}
print(json.dumps(counts))
engine.dispose()
