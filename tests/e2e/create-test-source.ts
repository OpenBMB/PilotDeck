#!/usr/bin/env -S npx tsx
/**
 * create-test-source.ts — bootstrap a fresh, non-fork test session with 3
 * user turns + assistant responses. Used to re-seed the canonical E2E
 * source session after it has been deleted (e.g. by A9's destructive test).
 *
 * JSONL format reference (from working session web:s_03a279bf-...):
 *   line 1: accepted_input (user message)  — fields: messages[]
 *   line 2: assistant_message              — fields: message{} (singular!)
 *   line 3: turn_result                    — fields: result.finalMessage
 *   line 4: accepted_input (user message)
 *   ...
 *
 * Usage:
 *   npx tsx tests/e2e/create-test-source.ts
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const HOME = '/Users/macmini-01/.pilotdeck';
const PROJECT_DIR = `${HOME}/projects/Users-macmini-01-.pilotdeck/chats`;

const userTurns = [
  '你好 — this is the first user turn (E2E bootstrap).',
  'second user turn — 建筑要不要早起?',
  'third user turn — OK we have enough turns for A7.',
];
const asstTurns = [
  'hi there — first assistant response.',
  '筑地建议早上 5 点出门。',
  'Great — at this point the test session has 3 user + 3 assistant entries.',
];

function nowMinusSec(sec: number): string {
  return new Date(Date.now() - sec * 1000).toISOString();
}

const sessionId = `web:s_${randomUUID()}`;
const turnIds = [randomUUID(), randomUUID(), randomUUID()];
const acceptedEntryIds = [randomUUID(), randomUUID(), randomUUID()];
const assistantEntryIds = [randomUUID(), randomUUID(), randomUUID()];
const turnResultEntryIds = [randomUUID(), randomUUID(), randomUUID()];

const lines: string[] = [];
let seq = 1;
let cursor = 60;
for (let i = 0; i < 3; i++) {
  // 1) accepted_input
  lines.push(JSON.stringify({
    type: 'accepted_input',
    sessionId,
    turnId: turnIds[i],
    sequence: seq++,
    createdAt: nowMinusSec(cursor--),
    entryId: acceptedEntryIds[i],
    parentEntryId: i === 0 ? null : acceptedEntryIds[i - 1],
    messages: [{ role: 'user', content: [{ type: 'text', text: userTurns[i] }] }],
  }));
  // 2) assistant_message  — note `message` (singular), not `messages`
  const startedAt = nowMinusSec(cursor + 1);
  const completedAt = nowMinusSec(cursor);
  const assistantContent = [{ type: 'text', text: asstTurns[i] }];
  lines.push(JSON.stringify({
    type: 'assistant_message',
    sessionId,
    turnId: turnIds[i],
    sequence: seq++,
    createdAt: completedAt,
    entryId: assistantEntryIds[i],
    parentEntryId: acceptedEntryIds[i],
    message: { role: 'assistant', content: assistantContent },
  }));
  // 3) turn_result
  lines.push(JSON.stringify({
    type: 'turn_result',
    sessionId,
    turnId: turnIds[i],
    sequence: seq++,
    createdAt: completedAt,
    entryId: turnResultEntryIds[i],
    parentEntryId: assistantEntryIds[i],
    result: {
      type: 'success',
      stopReason: 'completed',
      usage: {},
      permissionDenials: [],
      turns: 1,
      startedAt,
      finalMessage: { role: 'assistant', content: assistantContent },
      sessionId,
      turnId: turnIds[i],
      completedAt,
    },
  }));
}

const path = `${PROJECT_DIR}/${sessionId}.jsonl`;
writeFileSync(path, lines.join('\n') + '\n');
execSync(`touch -t 209901010000 "${path}"`);
console.log(sessionId);