"""Observe the formal SD app without persisting prompts or credentials."""
import contextvars
import json
import os
import sys
import time
from uuid import uuid4

import uvicorn
from app.public_api import pilotdeck_domain_host as domain_host
from app.public_api.pilotdeck_domain_host import PilotDeckDomainHostClient

active_route = contextvars.ContextVar('binding_observed_route', default=None)
active_stage = contextvars.ContextVar('binding_observed_stage', default={})
output = os.environ['BINDING_QA_OBSERVE_SD_PATH']
original_route = PilotDeckDomainHostClient.plan_sop_route
original_call = PilotDeckDomainHostClient._call
original_prepare = domain_host._prepare_user_input


def observe_prepare(payload):
    stage = {'stage': 'initial'}
    for key, name in [('_schema_repair', 'plan_repair'), ('_json_repair', 'json_repair')]:
        if key in payload:
            stage['stage'] = name
            stage[name + 'Attempt'] = payload[key].get('attempt')
    active_stage.set(stage)
    return original_prepare(payload)


def record(row):
    with open(output, 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(row) + '\n')


def observe_route(self, **kwargs):
    row = {'kind': 'route', 'routeId': uuid4().hex,
           'sessionId': kwargs['session'].id, 'startedMs': time.time() * 1000}
    token = active_route.set(row)
    try:
        result = original_route(self, **kwargs)
        row['decision'] = result.decision
        return result
    except Exception as exc:
        row['errorType'] = type(exc).__name__
        raise
    finally:
        row['endedMs'] = time.time() * 1000
        row['elapsedMs'] = row['endedMs'] - row['startedMs']
        record(row)
        active_route.reset(token)


def observe_call(self, client, *, principal, operation, input):
    route = active_route.get()
    if route is None:
        return original_call(self, client, principal=principal, operation=operation, input=input)
    row = {'kind': 'callback', 'routeId': route['routeId'], 'sessionId': route['sessionId'],
           'operation': operation, 'requestId': input.get('requestId'),
           'startedMs': time.time() * 1000}
    if operation == 'model_stream':
        row.update(active_stage.get())
    try:
        response = original_call(self, client, principal=principal, operation=operation, input=input)
        row['status'] = response.status_code
        return response
    except Exception as exc:
        row['errorType'] = type(exc).__name__
        raise
    finally:
        row['endedMs'] = time.time() * 1000
        row['elapsedMs'] = row['endedMs'] - row['startedMs']
        record(row)


PilotDeckDomainHostClient.plan_sop_route = observe_route
PilotDeckDomainHostClient._call = observe_call
domain_host._prepare_user_input = observe_prepare
uvicorn.run('app.main:app', host='127.0.0.1', port=int(sys.argv[1]))
