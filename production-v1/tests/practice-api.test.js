import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTutorService } from '../src/services/tutor.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

const NOTICE = '2026-09-10-ios-combined';

async function startApp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-practice-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const origin = 'https://v1.example.test';
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_PUBLIC_ORIGIN: origin,
    V1_SESSION_SECRET: 'x'.repeat(32),
    V1_PRIVACY_NOTICE_VERSION: NOTICE,
    V1_REQUIRE_AI_CONSENT: 'true',
  });
  const app = createApp({
    config,
    store,
    tutorService: createTutorService({
      llmProvider: {
        async generate() {
          return { rawText: '{"replyText":"好呀。","coachNotes":"Okay.","needsConfirmation":false}' };
        },
      },
    }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, origin, store };
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('practice send without AI consent is 403 and campus messages stay isolated', async (t) => {
  const { baseUrl, origin } = await startApp(t);
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  const blocked = await json(`${baseUrl}/api/v1/practice/messages`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMessageId: '77777777-7777-4777-8777-777777777777',
      text: '點樣叫凍檸茶',
      mode: 'teaching',
      scenario: 'restaurant',
      replyLanguage: 'en',
      replyMode: 'text',
    }),
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error.code, 'AI_CONSENT_REQUIRED');

  await json(`${baseUrl}/api/v1/consent`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['ai'], version: NOTICE }),
  });
  const practice = await json(`${baseUrl}/api/v1/practice/messages`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMessageId: '88888888-8888-4888-8888-888888888888',
      text: '點樣叫凍檸茶',
      mode: 'teaching',
      scenario: 'restaurant',
      replyLanguage: 'en',
      replyMode: 'text',
    }),
  });
  assert.equal(practice.response.status, 202);
  const campus = await json(`${baseUrl}/api/v1/messages?after=0`, { headers: { Cookie: cookie } });
  assert.equal(campus.response.status, 200);
  assert.equal(campus.body.data.messages.length, 0);
  const practiceList = await json(`${baseUrl}/api/v1/practice/messages?after=0`, { headers: { Cookie: cookie } });
  assert.equal(practiceList.body.data.messages.some((message) => message.text === '點樣叫凍檸茶'), true);
});
