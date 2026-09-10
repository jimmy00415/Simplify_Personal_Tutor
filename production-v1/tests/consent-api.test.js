import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

const NOTICE = '2026-09-10-ios-combined';
const CLIENT_MESSAGE = '44444444-4444-4444-8444-444444444444';

async function startApp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-consent-'));
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
  const app = createApp({ config, store });
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

function sendBody() {
  return JSON.stringify({
    clientMessageId: CLIENT_MESSAGE,
    text: 'How do I activate my SSOid?',
    replyLanguage: 'en',
    replyMode: 'text',
  });
}

test('session bootstrap includes consent and blocks sends until AI consent matches the notice', async (t) => {
  const { baseUrl, origin } = await startApp(t);
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.data.consent, {
    privacyNoticeVersion: NOTICE,
    aiGranted: false,
    voiceGranted: false,
  });

  const blocked = await json(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: sendBody(),
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.error.code, 'AI_CONSENT_REQUIRED');

  const granted = await json(`${baseUrl}/api/v1/consent`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['ai'], version: NOTICE }),
  });
  assert.equal(granted.response.status, 200);
  assert.equal(granted.body.data.consent.aiGranted, true);
  assert.equal(granted.body.data.consent.voiceGranted, false);

  const sent = await json(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: sendBody(),
  });
  assert.equal(sent.response.status, 202);
});

test('voice transcription requires voice consent and withdrawal leaves text working', async (t) => {
  const { baseUrl, origin } = await startApp(t);
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  await json(`${baseUrl}/api/v1/consent`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['ai'], version: NOTICE }),
  });

  const voiceBlocked = await json(`${baseUrl}/api/v1/voice/transcriptions`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'audio/wav',
      'X-Client-Upload-Id': '55555555-5555-4555-8555-555555555555',
      'X-Content-Sha256': 'a'.repeat(64),
      'X-Asr-Language': 'en',
    },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(voiceBlocked.response.status, 403);
  assert.equal(voiceBlocked.body.error.code, 'VOICE_CONSENT_REQUIRED');

  await json(`${baseUrl}/api/v1/consent`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['voice'], version: NOTICE }),
  });
  const withdrawn = await json(`${baseUrl}/api/v1/consent/voice`, {
    method: 'DELETE',
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(withdrawn.response.status, 200);
  assert.equal(withdrawn.body.data.consent.voiceGranted, false);
  assert.equal(withdrawn.body.data.consent.aiGranted, true);

  const stillText = await json(`${baseUrl}/api/v1/messages`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMessageId: '66666666-6666-4666-8666-666666666666',
      text: 'Where can I use my student e-Card?',
      replyLanguage: 'en',
      replyMode: 'text',
    }),
  });
  assert.equal(stillText.response.status, 202);
});
