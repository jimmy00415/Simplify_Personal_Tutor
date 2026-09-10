import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createTutorService, buildTutorSystemPrompt } from '../src/services/tutor.js';

const culture = JSON.parse(readFileSync(fileURLToPath(new URL('../data/culture/cantonese-culture.json', import.meta.url)), 'utf8'));

test('teaching and freeChat system prompts differ and may attach a cultural snippet', () => {
  const teaching = buildTutorSystemPrompt({
    mode: 'teaching',
    scenario: 'restaurant',
    culture,
  });
  const freeChat = buildTutorSystemPrompt({
    mode: 'freeChat',
    scenario: 'restaurant',
    culture,
  });
  assert.match(teaching, /Teaching:/);
  assert.match(freeChat, /Free Talk:/);
  assert.notEqual(teaching, freeChat);
  assert.match(teaching, /Ordering food/);
  assert.doesNotMatch(teaching, /"evidenceIds"/);
});

test('tutor emergency safety bypasses the model and parser rejects invented campus evidence', async () => {
  let called = 0;
  const tutor = createTutorService({
    culture,
    llmProvider: {
      async generate() {
        called += 1;
        return { rawText: '{"replyText":"你好","coachNotes":"Hi","evidenceIds":["claim-1"]}' };
      },
    },
  });
  const emergency = await tutor.answer({
    text: 'someone is unconscious and not breathing',
    mode: 'teaching',
    scenario: 'freeConversation',
  });
  assert.equal(emergency.provider, 'safety');
  assert.equal(called, 0);
  assert.match(emergency.text, /999/);

  await assert.rejects(
    tutor.answer({ text: '點樣叫凍檸茶', mode: 'teaching', scenario: 'restaurant' }),
    (error) => error.code === 'PROVIDER_INVALID_RESPONSE',
  );
});

test('tutor returns parsed coach notes from a deterministic JSON fixture', async () => {
  const tutor = createTutorService({
    culture,
    llmProvider: {
      async generate({ systemPrompt }) {
        assert.match(systemPrompt, /Never attach campus evidenceIds/);
        return { rawText: '{"replyText":"我想叫凍檸茶。","coachNotes":"I would like an iced lemon tea.","needsConfirmation":false}' };
      },
    },
  });
  const answer = await tutor.answer({
    text: '點樣叫凍檸茶',
    mode: 'teaching',
    scenario: 'restaurant',
  });
  assert.equal(answer.text, '我想叫凍檸茶。');
  assert.match(answer.coachNotes, /iced lemon tea/i);
  assert.deepEqual(answer.citations, []);
  assert.equal(answer.groundingStatus, 'unverified');
});
