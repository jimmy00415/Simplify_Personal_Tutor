import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { routeSafety } from '../knowledge/safety.js';

const DEFAULT_CULTURE_PATH = fileURLToPath(new URL('../../data/culture/cantonese-culture.json', import.meta.url));
const PRACTICE_MODES = new Set(['teaching', 'freeChat']);
const SCENARIO_IDS = new Set([
  'freeConversation', 'restaurant', 'meetingPeople', 'traveling', 'shopping', 'workplace',
]);

function loadCulture(culture) {
  if (culture && typeof culture === 'object') return culture;
  return JSON.parse(readFileSync(DEFAULT_CULTURE_PATH, 'utf8'));
}

function emergencyText(safety, replyLanguage = 'en') {
  if (replyLanguage === 'yue-Hant-HK') return safety.guidance.zhHant;
  if (replyLanguage === 'cmn-Hans-CN') return safety.guidance.zhHans;
  return safety.guidance.en;
}

function parseTutorDraft(rawText) {
  const text = String(rawText ?? '').trim();
  let draft;
  try {
    draft = JSON.parse(text);
  } catch {
    const error = new Error('PROVIDER_INVALID_RESPONSE');
    error.code = 'PROVIDER_INVALID_RESPONSE';
    throw error;
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    const error = new Error('PROVIDER_INVALID_RESPONSE');
    error.code = 'PROVIDER_INVALID_RESPONSE';
    throw error;
  }
  if (Array.isArray(draft.evidenceIds) && draft.evidenceIds.length > 0) {
    const error = new Error('PROVIDER_INVALID_RESPONSE');
    error.code = 'PROVIDER_INVALID_RESPONSE';
    throw error;
  }
  if (Array.isArray(draft.citations) && draft.citations.some((item) => item?.evidenceId)) {
    const error = new Error('PROVIDER_INVALID_RESPONSE');
    error.code = 'PROVIDER_INVALID_RESPONSE';
    throw error;
  }
  const replyText = typeof draft.replyText === 'string' ? draft.replyText.trim() : '';
  if (!replyText) {
    const error = new Error('PROVIDER_INVALID_RESPONSE');
    error.code = 'PROVIDER_INVALID_RESPONSE';
    throw error;
  }
  return {
    replyText,
    coachNotes: typeof draft.coachNotes === 'string' ? draft.coachNotes.trim() : '',
    needsClarification: Boolean(draft.needsConfirmation || draft.needsClarification),
  };
}

export function buildTutorSystemPrompt({ mode = 'teaching', scenario = 'freeConversation', culture } = {}) {
  const resolvedMode = PRACTICE_MODES.has(mode) ? mode : 'teaching';
  const resolvedScenario = SCENARIO_IDS.has(scenario) ? scenario : 'freeConversation';
  const snippet = culture?.scenarios?.[resolvedScenario]?.hint ?? '';
  const modeRule = resolvedMode === 'freeChat'
    ? 'Free Talk: tolerate minor errors unless they block meaning. Do not grade pronunciation.'
    : 'Teaching: point out useful corrections in coachNotes. Do not grade pronunciation or claim a score.';
  return [
    'You are a Cantonese conversation tutor for Hong Kong Buddy.',
    'Reply in written Cantonese using Traditional Chinese in replyText.',
    'Put a short English translation and coaching in coachNotes.',
    'Never attach campus evidenceIds, HKBU corpus citations, or official-source cards.',
    'Never claim to be an official HKBU representative or to score tones.',
    modeRule,
    snippet ? `Cultural context: ${snippet}` : '',
    'Return only JSON: {"replyText":"...","coachNotes":"...","needsConfirmation":false}',
  ].filter(Boolean).join('\n');
}

export function createTutorService({
  llmProvider = null,
  culture,
  safetyRouter = routeSafety,
} = {}) {
  const cultureData = loadCulture(culture);

  async function complete({ text, mode, scenario, context = [], signal, beforeProvider, task = 'reply' }) {
    const safety = safetyRouter(text);
    if (safety.kind === 'emergency') {
      return {
        text: emergencyText(safety),
        coachNotes: emergencyText(safety),
        citations: [],
        cards: [],
        suggestedReplies: [],
        needsClarification: false,
        groundingStatus: 'unverified',
        provider: 'safety',
        safety: true,
      };
    }
    await beforeProvider?.();
    if (typeof llmProvider?.generate !== 'function') {
      const error = new Error('PROVIDER_UNAVAILABLE');
      error.code = 'PROVIDER_UNAVAILABLE';
      throw error;
    }
    const systemPrompt = buildTutorSystemPrompt({ mode, scenario, culture: cultureData });
    const messages = [
      ...context.filter((item) => item?.role && item?.text).map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: item.text,
      })),
      { role: 'user', content: task === 'correct' ? `Correct this student utterance only:\n${text}` : text },
    ];
    const result = await llmProvider.generate({
      systemPrompt,
      messages,
      maxOutputTokens: 800,
      signal,
    });
    const draft = parseTutorDraft(result.rawText ?? result.text);
    return {
      text: draft.replyText,
      coachNotes: draft.coachNotes,
      citations: [],
      cards: [],
      suggestedReplies: [],
      needsClarification: draft.needsClarification,
      groundingStatus: 'unverified',
      provider: result.provider ?? 'vertex-ai',
      providerLatencyMs: result.providerLatencyMs,
    };
  }

  return {
    answer(input) {
      return complete({ ...input, task: 'reply' });
    },
    correct(input) {
      return complete({ ...input, task: 'correct' });
    },
    buildTutorSystemPrompt: (input) => buildTutorSystemPrompt({ ...input, culture: cultureData }),
  };
}
