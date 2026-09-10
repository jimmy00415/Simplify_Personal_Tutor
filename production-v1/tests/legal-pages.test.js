import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

const privacyHtml = await readFile(new URL('../public/legal/privacy.html', import.meta.url), 'utf8');
const supportHtml = await readFile(new URL('../public/legal/support.html', import.meta.url), 'utf8');

test('privacy policy names processors and regions and forbids residency claims', () => {
  assert.match(privacyHtml, /Vertex AI/i);
  assert.match(privacyHtml, /Speech-to-Text/i);
  assert.match(privacyHtml, /Text-to-Speech/i);
  assert.match(privacyHtml, /asia-east2/);
  assert.match(privacyHtml, /asia-southeast1/);
  assert.match(privacyHtml, /global Gemini/i);
  assert.doesNotMatch(privacyHtml, /stays in Hong Kong/i);
  assert.doesNotMatch(privacyHtml, /never retained/i);
  assert.match(privacyHtml, /lang="en"/);
  assert.match(privacyHtml, /lang="zh-Hant"/);
});

test('support page publishes a contact path for access and correction', () => {
  assert.match(supportHtml, /support@|mailto:|contact/i);
  assert.match(supportHtml, /access|correction|查閱|更正/i);
});

test('legal pages are served without a session and do not set a cookie', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-legal-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const origin = 'https://v1.example.test';
  const app = createApp({
    config: loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: origin, V1_SESSION_SECRET: 'x'.repeat(32) }),
    store,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const privacy = await fetch(`${baseUrl}/legal/privacy`);
  const support = await fetch(`${baseUrl}/legal/support`);
  assert.equal(privacy.status, 200);
  assert.equal(support.status, 200);
  assert.match(await privacy.text(), /Vertex AI/i);
  assert.match(await support.text(), /support/i);
  assert.equal(privacy.headers.getSetCookie?.()?.length ?? 0, 0);
});
