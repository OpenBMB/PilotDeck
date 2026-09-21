#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const port = Number(process.env.REPLACEMENT_KNOWLEDGE_PORT || '18093');
const evidencePath = process.env.REPLACEMENT_KNOWLEDGE_EVIDENCE_PATH;

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', implementationId: 'replacement.knowledge', contract: 'staffdeck.knowledge/v1' }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v2/module/call') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const operation = envelope?.payload?.operation;
  const input = envelope?.payload?.input ?? {};
  const result = operation === 'query'
    ? { implementation: 'replacement-knowledge-runtime', query: input.query, chunks: [{ id: 'replacement-citation-001', content: 'Replacement runtime verified this query through an independent module process.', source_ref: 'replacement://conformance/001' }] }
    : operation === 'resolve_citation'
      ? { implementation: 'replacement-knowledge-runtime', citation: { id: input.chunkId, content: 'Replacement citation resolved by the independent module process.' } }
      : null;
  const body = result
    ? { kind: 'response', inReplyTo: envelope.messageId, ok: true, payload: { result } }
    : { kind: 'response', inReplyTo: envelope.messageId, ok: false, code: 'UNKNOWN_OPERATION', error: { message: `Unsupported operation: ${operation}` } };
  if (evidencePath) await appendFile(evidencePath, `${JSON.stringify({ operation, input, at: new Date().toISOString() })}\n`);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}).listen(port, '127.0.0.1', () => console.log(`replacement Knowledge runtime listening on ${port}`));
