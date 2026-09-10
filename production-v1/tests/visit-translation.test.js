import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveVisitDirection, isRomanizationLikeText } from '../src/knowledge/visit-direction.js';
import { createVisitTranslationService } from '../src/services/visit-translation.js';

test('visit routing auto-routes English in a resident direction', () => {
  const routed = resolveVisitDirection('please stretch your hands', 'yue_to_en');
  assert.equal(routed.autoRouted, true);
  assert.equal(routed.effectiveDirection, 'en_to_yue');
  assert.equal(routed.routeReason, 'english_input_in_resident_mode');
});

test('rule fallback covers stretch and thanks without calling the model', async () => {
  let called = 0;
  const service = createVisitTranslationService({
    llmProvider: { async generate() { called += 1; return { rawText: '{}' }; } },
  });
  const stretch = await service.translate({ sourceText: '幫我伸展一下手', direction: 'yue_to_en' });
  const thanks = await service.translate({ sourceText: '唔該', direction: 'yue_to_en' });
  assert.equal(stretch.provider, 'rule-fallback');
  assert.match(stretch.translatedText, /stretch/i);
  assert.equal(thanks.translatedText, 'Thank you.');
  assert.equal(called, 0);
});

test('visit safety emergency bypasses LLM and romanization-like input suppresses TTS', async () => {
  const service = createVisitTranslationService({
    llmProvider: { async generate() { throw new Error('should not run'); } },
  });
  const emergency = await service.translate({
    sourceText: 'someone is unconscious and not breathing',
    direction: 'yue_to_en',
  });
  assert.equal(emergency.provider, 'safety');
  assert.equal(emergency.suppressTts, true);
  assert.equal(isRomanizationLikeText('nei5 hou2 maa3'), true);
  const romanized = await service.translate({
    sourceText: 'nei5 hou2',
    direction: 'en_to_yue',
  });
  assert.equal(romanized.suppressTts, true);
});
