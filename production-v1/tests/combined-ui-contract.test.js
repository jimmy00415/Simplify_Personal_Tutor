import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { chromeCopy, consentCopy } from '../public/legal-copy.js';
import { sendErrorCopy, clearErrorCopy } from '../public/chat-copy.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const playbooks = await readFile(new URL('../public/content/playbooks.js', import.meta.url), 'utf8');

test('combined shell exposes four tabs, first-run AI consent, and legal links', () => {
  for (const tab of ['Today', 'Campus', 'Practice', 'Translate']) {
    assert.match(html, new RegExp(`>${tab}<`));
  }
  assert.match(html, /id="ai-consent"/);
  assert.match(html, /id="ai-consent-continue"/);
  assert.match(html, /id="ai-consent-leave"/);
  assert.match(html, /href="\/legal\/privacy"/);
  assert.match(html, /href="\/legal\/support"/);
  assert.doesNotMatch(html, /SpeechSDK|azure.*speech/i);
  assert.doesNotMatch(html, /<audio[^>]+autoplay/i);
  assert.match(html, />Teaching</);
  assert.match(html, />Free Talk</);
  assert.match(html, /Free Conversation/);
  assert.match(html, /At the Restaurant/);
  assert.match(html, /Meeting New People/);
  assert.match(html, /Traveling in Hong Kong/);
  assert.match(html, /Shopping Small Talk/);
  assert.match(html, /Workplace Small Talk/);
  assert.match(html, /Resident speaks Cantonese/);
  assert.match(html, /Volunteer speaks English or Mandarin/);
  assert.match(html, /class="report-answer"/);
  assert.match(html, /hk-buddy:v1.1:habitState|Saved on this iPhone only/);
  assert.match(css, /min-height:\s*calc\(49px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /min-width:\s*44px/);
  assert.match(playbooks, /elderlyVisitPlaybook/);
  assert.match(playbooks, /cantonese:/);
});

test('consent, deletion, and send errors exist in English, Cantonese, and Mandarin', () => {
  for (const language of ['en', 'yue-Hant-HK', 'cmn-Hans-CN']) {
    const consent = consentCopy(language);
    const chrome = chromeCopy(language);
    assert.ok(consent.title);
    assert.ok(consent.copy);
    assert.ok(chrome.deletion);
    assert.ok(chrome.voiceStatus);
    assert.ok(chrome.consentRequired);
  }
  assert.match(sendErrorCopy({ code: 'AI_CONSENT_REQUIRED' }), /AI disclosure/i);
  assert.match(clearErrorCopy({}), /not cleared|try again/i);
});
