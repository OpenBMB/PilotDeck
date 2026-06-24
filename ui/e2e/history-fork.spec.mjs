import { test, expect } from '@playwright/test';

const API_URL = process.env.PILOTDECK_API_URL || 'http://localhost:3001';
const PROJECT_PATH = process.env.PILOTDECK_E2E_PROJECT_PATH || '/Users/da/ws/PilotDeck/PilotDeck-20260610';
const PARENT_SESSION = process.env.PILOTDECK_E2E_PARENT_SESSION || 'web:s_df76542f-2f58-431f-8b74-94c3a33206e2';

test('history fork API carries prior transcript and exposes entryId on user messages', async ({ request }) => {
  const messagesResponse = await request.get(
    `${API_URL}/api/sessions/${encodeURIComponent(PARENT_SESSION)}/messages?projectPath=${encodeURIComponent(PROJECT_PATH)}&limit=200`,
  );
  expect(messagesResponse.ok()).toBeTruthy();
  const payload = await messagesResponse.json();
  test.skip(!payload.messages?.length, 'No live session messages available in this environment');

  const userMessage = payload.messages.find((message) => message.role === 'user' && message.entryId);
  expect(userMessage?.entryId).toBeTruthy();

  const forkResponse = await request.post(
    `${API_URL}/api/sessions/${encodeURIComponent(PARENT_SESSION)}/fork`,
    {
      data: {
        projectPath: PROJECT_PATH,
        fromEntryId: userMessage.entryId,
      },
    },
  );
  expect(forkResponse.ok()).toBeTruthy();
  const forkPayload = await forkResponse.json();
  expect(forkPayload.newSessionId).toMatch(/^web[:_]s_/);
  expect(typeof forkPayload.prefillText).toBe('string');
  expect(forkPayload.carriedMessageCount).toBeGreaterThan(0);
});
