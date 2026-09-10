import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

const NOTICE = '2026-09-10-ios-combined';

test('reports store message id, kind, and reason only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-report-'));
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
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: origin } });
  const cookie = created.headers.getSetCookie()[0].split(';')[0];
  await fetch(`${baseUrl}/api/v1/consent`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: ['ai'], version: NOTICE }),
  });
  const response = await fetch(`${baseUrl}/api/v1/reports`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      conversationKind: 'campus',
      reason: 'outdated',
      text: 'this must not be stored',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.data.reason, 'outdated');
  assert.equal(body.data.conversationKind, 'campus');
  assert.equal(JSON.stringify(body).includes('this must not be stored'), false);
});
