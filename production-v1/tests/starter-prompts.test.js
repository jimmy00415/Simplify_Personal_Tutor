import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as chatCopy from '../public/chat-copy.js';
import { loadDefaultCorpus } from '../src/knowledge/corpus.js';
import { createRetriever } from '../src/knowledge/retriever.js';
import { createLlmProvider } from '../src/providers/llm.js';
import { createAnswerService } from '../src/services/answer.js';

const NOW = new Date('2026-08-25T12:01:00+08:00');
const EXPECTED_STARTERS = [
  {
    prompt: 'How do I activate my SSOid?',
    topSourceId: 'hkbu.ito.account',
    evidenceIds: ['evidence.ito.account.student-activation'],
  },
  {
    prompt: 'What food options are available at HKBU?',
    topSourceId: 'hkbu.eo.dining-overview',
    evidenceIds: [
      'evidence.eo.dining-overview.special-hours',
      'evidence.eo.dining.bu-fiesta.renovation-closure',
      'evidence.eo.dining.main-canteen.regular',
    ],
  },
  {
    prompt: 'Where can I use my student e-Card?',
    topSourceId: 'hkbu.ar.student-e-card',
    evidenceIds: ['evidence.ar.student-e-card.listed-facilities-only'],
  },
  {
    prompt: 'How do I set up Duo on a new phone?',
    topSourceId: 'hkbu.ito.duo',
    evidenceIds: ['evidence.ito.duo.new-phone'],
  },
];

test('every shipped starter prompt reaches useful reviewed campus evidence end to end', async () => {
  assert.equal(typeof chatCopy.chatExperienceCopy, 'function');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const prompts = [...html.matchAll(/class="starter-prompt"[^>]+data-prompt="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(prompts, EXPECTED_STARTERS.map((starter) => starter.prompt));

  const corpus = await loadDefaultCorpus();
  const retriever = createRetriever({ corpus, now: () => NOW });
  const service = createAnswerService({
    corpus,
    retriever,
    now: () => NOW,
    llmProvider: createLlmProvider({ config: { provider: 'deterministic', settings: {} } }),
  });

  for (const replyLanguage of ['en', 'yue-Hant-HK', 'cmn-Hans-CN']) {
    const localized = chatCopy.chatExperienceCopy(replyLanguage).starterPrompts;
    assert.equal(localized.length, EXPECTED_STARTERS.length);
    for (const [index, starter] of EXPECTED_STARTERS.entries()) {
      const prompt = localized[index];
      const retrieval = retriever.retrieve(prompt);
      assert.ok(retrieval.supportableClaims.length > 0, `${prompt} must retrieve a current reviewed claim`);
      assert.equal(retrieval.sources[0]?.id, starter.topSourceId);
      assert.deepEqual(retrieval.supportableClaims.map((claim) => claim.id), starter.evidenceIds);
      assert.equal(retrieval.ambiguityCodes.includes('NO_MATCHING_OFFICIAL_EVIDENCE'), false);

      const answer = await service.answer({
        turnId: `starter-${replyLanguage}-${index + 1}`,
        text: prompt,
        replyLanguage,
        context: [{ role: 'user', text: prompt }],
        beforeProvider: async () => {},
      });
      assert.equal(answer.groundingStatus, 'verified', `${prompt} must produce a grounded answer`);
      assert.equal(answer.provider, 'deterministic');
      assert.deepEqual(answer.citations.map((citation) => citation.evidenceId), starter.evidenceIds);
      if (replyLanguage === 'en') assert.doesNotMatch(answer.text, /\p{Script=Han}/u);
      else assert.match(answer.text, /\p{Script=Han}/u);
      assert.doesNotMatch(answer.text, /could not confirm|未能確認|未能确认/i);
    }
  }
});

test('the production acceptance JC³ inventory remains within its reviewed evidence window', async () => {
  const corpus = await loadDefaultCorpus();
  const retriever = createRetriever({ corpus, now: () => new Date('2026-09-07T23:44:46+08:00') });
  const retrieval = retriever.retrieve('What food outlets are at JC³?');
  assert.deepEqual(
    retrieval.supportableClaims.map((claim) => claim.id),
    ['evidence.eo.dining-inventory.jc3'],
  );
});
