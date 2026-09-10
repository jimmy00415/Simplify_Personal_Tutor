import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

const NOTICE = '2026-09-10-ios-combined';

async function startApp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-visit-'));
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
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, origin };
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('visit translate requires consent, is idempotent, and returns four-direction rule output', async (t) => {
  const { baseUrl, origin } = await startApp(t);
  const created = await json(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.response.headers.getSetCookie()[0].split(';')[0];
  const payload = {
    sourceText: '唔該',
    direction: 'yue_to_en',
    clientTurnId: '99999999-9999-4999-8999-999999999999',
    inputType: 'text',
    userJob: 'resident',
  };
  const blocked = await json(`${baseUrl}/api/v1/visit-translate`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(blocked.response.status, 403);
  await json(`${baseUrl}/api/v1/consent`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['ai'], version: NOTICE }),
  });
  const first = await json(`${baseUrl}/api/v1/visit-translate`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const retry = await json(`${baseUrl}/api/v1/visit-translate`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.translatedText, 'Thank you.');
  assert.equal(first.body.data.provider, 'rule-fallback');
  assert.equal(retry.body.data.id, first.body.data.id);

  const extras = [
    ['yue_to_zh', '唔該', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
    ['en_to_yue', 'thank you', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'],
    ['zh_to_yue', '谢谢', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'],
  ];
  for (const [direction, sourceText, clientTurnId] of extras) {
    const result = await json(`${baseUrl}/api/v1/visit-translate`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceText, direction, clientTurnId, inputType: 'text' }),
    });
    assert.equal(result.response.status, 200, direction);
    assert.ok(result.body.data.translatedText, direction);
  }
});
