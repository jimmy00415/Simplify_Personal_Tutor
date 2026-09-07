import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDefaultCorpus } from '../src/knowledge/corpus.js';
import { createRetriever } from '../src/knowledge/retriever.js';
import { createAnswerService, parseModelDraft } from '../src/services/answer.js';

const FIXED_NOW = new Date('2026-08-25T12:00:00+08:00');
const STALE_NOW = new Date('2026-10-26T00:00:00+08:00');
const corpus = await loadDefaultCorpus();
const retriever = createRetriever({ corpus, now: () => FIXED_NOW });

const duoActions = [{
  id: 'action.ito.duo.open',
  sourceId: 'hkbu.ito.duo',
  label: { en: 'Open Duo guidance', zhHant: '查看 Duo 指引', zhHans: '查看 Duo 指引' },
}];

function parseAt(rawText, retrieval, overrides = {}) {
  return parseModelDraft(rawText, { retrieval, corpus, actionSnapshot: duoActions, now: FIXED_NOW, ...overrides });
}

function validDraft(overrides = {}) {
  return {
    replyText: 'Use the official Duo guidance for a changed phone.',
    evidenceIds: ['evidence.ito.duo.new-phone'],
    actionIds: ['action.ito.duo.open'],
    suggestedReplies: ['Where is ITO?'],
    needsClarification: false,
    groundingStatus: 'verified',
    ...overrides,
  };
}

test('answer parser accepts one fenced object and handles braces inside JSON strings', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  const draft = validDraft({ replyText: 'Open {Duo} guidance without guessing.' });
  const parsed = parseAt(`Here is the result:\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``, retrieval);
  assert.equal(parsed.replyText, draft.replyText);
  assert.deepEqual(parsed.evidenceIds, draft.evidenceIds);
  assert.equal(parsed.groundingStatus, 'verified');
});

test('answer parser rejects multiple, truncated, oversized, legacy, arbitrary-card, and extra-property output', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  const invalid = [
    `${JSON.stringify(validDraft())}\n${JSON.stringify(validDraft())}`,
    JSON.stringify(validDraft()).slice(0, -1),
    JSON.stringify({ ...validDraft(), citationIds: ['legacy'] }),
    JSON.stringify({ ...validDraft(), cards: [{ url: 'https://evil.example' }] }),
    JSON.stringify({ ...validDraft(), arbitrary: true }),
    JSON.stringify(validDraft({ replyText: 'x'.repeat(4001) })),
    JSON.stringify(validDraft({ evidenceIds: Array.from({ length: 9 }, (_, index) => `evidence.${index}`) })),
    JSON.stringify(validDraft({ suggestedReplies: ['x'.repeat(161)] })),
  ];
  for (const rawText of invalid) {
    assert.throws(() => parseAt(rawText, retrieval), /MODEL_DRAFT_INVALID|MODEL_DRAFT_TOO_LARGE/);
  }
});

test('answer parser rejects unknown or stale evidence and non-allowlisted actions', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  for (const overrides of [
    { evidenceIds: ['evidence.unknown'] },
    { evidenceIds: ['evidence.library.main.from-september-2026'] },
    { actionIds: ['action.unknown'] },
  ]) {
    assert.throws(() => parseAt(JSON.stringify(validDraft(overrides)), retrieval), /MODEL_DRAFT_INVALID/);
  }
});

test('answer parser downgrades unsupported verified status instead of promoting an uncited claim', () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  const parsed = parseAt(JSON.stringify(validDraft({ evidenceIds: [], actionIds: [], groundingStatus: 'verified' })), retrieval);
  assert.equal(parsed.groundingStatus, 'unverified');
});

test('answer service maps only corpus evidence/actions and renders selected claim text', async () => {
  let providerInput;
  const provider = {
    provider: 'hkbu',
    async generate(input) {
      providerInput = input;
      return { rawText: JSON.stringify(validDraft()), provider: 'hkbu', latencyMs: 12, usage: {}, finishReason: 'stop', providerRequestId: 'request-1' };
    },
  };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  let generatingCalls = 0;
  const answer = await service.answer({ turnId: 'turn-1', text: 'Duo 换手机怎么办', context: [], beforeProvider: async () => { generatingCalls += 1; } });
  assert.equal(generatingCalls, 1);
  const selectedClaim = corpus.sources
    .flatMap((source) => source.claims)
    .find((claim) => claim.id === 'evidence.ito.duo.new-phone');
  assert.equal(answer.text, selectedClaim.text.en);
  assert.equal(answer.groundingStatus, 'verified');
  assert.deepEqual(answer.citations.map((citation) => citation.evidenceId), ['evidence.ito.duo.new-phone']);
  assert.equal(answer.citations[0].url, 'https://ito.hkbu.edu.hk/services/it-security/mfa.html');
  assert.deepEqual(answer.cards.map((card) => card.actionId), ['action.ito.duo.open']);
  assert.equal(answer.cards[0].url, 'https://ito.hkbu.edu.hk/services/it-security/mfa.html');
  assert.deepEqual(providerInput.actionSnapshot, duoActions);
});

test('answer service maps immutable wire locales to trusted provider instructions without content inference', async () => {
  const observed = [];
  const provider = {
    provider: 'hkbu',
    async generate(input) {
      observed.push(input);
      return { rawText: JSON.stringify(validDraft()), provider: 'hkbu', latencyMs: 1, usage: {}, finishReason: 'stop', providerRequestId: null };
    },
  };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  for (const replyLanguage of ['en', 'yue-Hant-HK', 'cmn-Hans-CN']) {
    await service.answer({
      turnId: `turn-${replyLanguage}`,
      text: 'Duo changed phone',
      replyLanguage,
      context: [],
      beforeProvider: async () => {},
    });
  }
  assert.deepEqual(observed.map((input) => input.responseLanguage), ['en', 'yue-Hant-HK', 'cmn-Hans-CN']);
  assert.match(observed[0].systemPrompt, /international English/i);
  assert.match(observed[1].systemPrompt, /written Cantonese.*Traditional Chinese/i);
  assert.match(observed[2].systemPrompt, /Mandarin.*Simplified Chinese/i);
  assert.match(observed[0].systemPrompt, /groundingStatus must be exactly "verified" or "unverified"/);
  await assert.rejects(
    service.answer({ turnId: 'bad-locale', text: 'Duo changed phone', replyLanguage: 'fr', context: [] }),
    /unsupported reply language/i,
  );
});

test('deterministic grounded fallback follows the requested locale and preserves official URLs', async () => {
  const provider = { provider: 'hkbu', async generate() { throw Object.assign(new Error('unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); } };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const cantonese = await service.answer({ turnId: 'fallback-yue', text: 'Duo changed phone', replyLanguage: 'yue-Hant-HK', context: [], beforeProvider: async () => {} });
  const mandarin = await service.answer({ turnId: 'fallback-cmn', text: 'Duo changed phone', replyLanguage: 'cmn-Hans-CN', context: [], beforeProvider: async () => {} });
  assert.match(cantonese.text, /[換這門麼裡為還開關間學醫證]/u);
  assert.match(mandarin.text, /[换这门么里为还开关间学医证]/u);
  assert.deepEqual(cantonese.citations.map((citation) => citation.url), mandarin.citations.map((citation) => citation.url));
});

test('answer parser validates actions against the exact current snapshot rather than any retrieval source', () => {
  const retrieval = structuredClone(retriever.retrieve('Duo 换手机怎么办'));
  retrieval.sources.push({ id: 'hkbu.ar.student-card-collection' });
  const guessed = validDraft({ actionIds: ['action.ar.student-card-collection.open'] });
  assert.throws(() => parseAt(JSON.stringify(guessed), retrieval), /MODEL_DRAFT_INVALID/);
});

test('answer acceptance and deterministic fallback recheck corpus freshness at the final clock boundary', async () => {
  const retrieval = retriever.retrieve('Duo 换手机怎么办');
  assert.throws(
    () => parseAt(JSON.stringify(validDraft()), retrieval, { now: STALE_NOW }),
    /MODEL_DRAFT_INVALID/,
  );

  let modelClock = FIXED_NOW;
  const modelService = createAnswerService({
    corpus,
    retriever,
    now: () => modelClock,
    llmProvider: {
      provider: 'hkbu',
      async generate() {
        modelClock = STALE_NOW;
        return { rawText: JSON.stringify(validDraft()), provider: 'hkbu', latencyMs: 1, usage: null, finishReason: 'stop', providerRequestId: null };
      },
    },
  });
  let fallbackClock = FIXED_NOW;
  const fallbackService = createAnswerService({
    corpus,
    retriever,
    now: () => fallbackClock,
    llmProvider: {
      provider: 'hkbu',
      async generate() {
        fallbackClock = STALE_NOW;
        throw Object.assign(new Error('unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
      },
    },
  });
  for (const service of [modelService, fallbackService]) {
    const answer = await service.answer({ turnId: 'turn-stale', text: 'Duo 换手机怎么办', context: [], beforeProvider: async () => {} });
    assert.equal(answer.groundingStatus, 'unverified');
    assert.equal(answer.citations.some((citation) => citation.status === 'verified' || citation.evidenceId), false);
  }
});

test('answer service falls back deterministically to selected evidence and source metadata on provider failure', async () => {
  const provider = { provider: 'hkbu', async generate() { throw Object.assign(new Error('private provider body'), { code: 'PROVIDER_UNAVAILABLE' }); } };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const first = await service.answer({ turnId: 'turn-1', text: 'Duo 换手机怎么办', replyLanguage: 'yue-Hant-HK', context: [], beforeProvider: async () => {} });
  const second = await service.answer({ turnId: 'turn-1', text: 'Duo 换手机怎么办', replyLanguage: 'yue-Hant-HK', context: [], beforeProvider: async () => {} });
  const selected = retriever.retrieve('Duo 换手机怎么办').supportableClaims.flatMap((claim) => [claim.text.zhHant, claim.text.zhHans]);
  assert.deepEqual(first, second);
  assert.equal(first.fallback, true);
  assert.equal(first.groundingStatus, 'verified');
  assert.equal(selected.some((text) => first.text.includes(text)), true);
  assert.equal(first.text.includes('private provider body'), false);
  assert.equal(first.citations.every((citation) => citation.url.endsWith('.hkbu.edu.hk/services/it-security/mfa.html')), true);
});

test('clarification-required retrieval never lets a successful model invent current operating status', async () => {
  let providerCalls = 0;
  const freshNow = new Date('2026-08-26T12:00:00+08:00');
  const freshRetriever = createRetriever({ corpus, now: () => freshNow });
  const provider = {
    provider: 'hkbu',
    async generate() {
      providerCalls += 1;
      return {
        rawText: JSON.stringify({
          replyText: 'Yes, Main Canteen is open now.',
          evidenceIds: ['evidence.eo.dining-overview.special-hours'],
          actionIds: [],
          suggestedReplies: [],
          needsClarification: false,
          groundingStatus: 'verified',
        }),
        provider: 'hkbu',
        latencyMs: 1,
        usage: null,
        finishReason: 'stop',
        providerRequestId: null,
      };
    },
  };
  const service = createAnswerService({ corpus, retriever: freshRetriever, llmProvider: provider, now: () => freshNow });
  const answer = await service.answer({
    turnId: 'turn-current-canteen',
    text: 'Is Main Canteen open now?',
    context: [],
    beforeProvider: async () => {},
  });

  assert.equal(providerCalls, 0);
  assert.equal(answer.needsClarification, true);
  assert.equal(answer.groundingStatus, 'verified');
  assert.deepEqual(answer.citations.map((citation) => citation.evidenceId), ['evidence.eo.dining-overview.special-hours']);
  assert.doesNotMatch(answer.text, /yes,? main canteen is open now/i);
});

test('verified answers render selected claim text instead of unrelated successful-model prose', async () => {
  const maliciousText = 'NTTIH reception is open 24 hours and the Welfare Shop sells SIM cards.';
  const provider = {
    provider: 'hkbu',
    async generate() {
      return {
        rawText: JSON.stringify(validDraft({
          replyText: maliciousText,
          suggestedReplies: ['Which SIM card should I buy?'],
        })),
        provider: 'hkbu',
        latencyMs: 1,
        usage: null,
        finishReason: 'stop',
        providerRequestId: null,
      };
    },
  };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const answer = await service.answer({
    turnId: 'turn-adversarial-grounding',
    text: 'Duo changed phone',
    context: [],
    beforeProvider: async () => {},
  });
  const duoClaim = corpus.sources
    .flatMap((source) => source.claims)
    .find((claim) => claim.id === 'evidence.ito.duo.new-phone');

  assert.equal(answer.text, duoClaim.text.en);
  assert.doesNotMatch(answer.text, /NTTIH|SIM card|24 hours/i);
  assert.deepEqual(answer.suggestedReplies, []);
  assert.equal(answer.groundingStatus, 'verified');
  assert.deepEqual(answer.citations.map((citation) => citation.evidenceId), [duoClaim.id]);
});

test('answer service is honestly unverified and never invents a global directory handoff', async () => {
  let providerCalls = 0;
  const provider = { provider: 'hkbu', async generate() { providerCalls += 1; throw new Error('must not be called'); } };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const answer = await service.answer({ turnId: 'turn-unknown', text: 'Where can I rent a purple submarine on campus?', context: [] });
  assert.equal(providerCalls, 0);
  assert.equal(answer.groundingStatus, 'unverified');
  assert.equal(answer.needsClarification, true);
  assert.match(answer.text, /could not confirm|未能確認|未能确认/i);
  assert.deepEqual(answer.citations, []);
  assert.deepEqual(answer.cards, []);
});

test('answer service safety bypass is deterministic, multilingual, and never calls the model', async () => {
  let providerCalls = 0;
  const provider = { provider: 'hkbu', async generate() { providerCalls += 1; throw new Error('must not be called'); } };
  const service = createAnswerService({ corpus, retriever, llmProvider: provider, now: () => FIXED_NOW });
  const answer = await service.answer({ turnId: 'turn-danger', text: '宿舍现在着火了', context: [] });
  assert.equal(providerCalls, 0);
  assert.equal(answer.safety, true);
  assert.match(answer.text, /999/);
  assert.match(answer.text, /3411 7777/);
  assert.equal(answer.citations.some((citation) => citation.url.includes('Security-Control-Rooms-and-Security-Hotline')), true);
});
