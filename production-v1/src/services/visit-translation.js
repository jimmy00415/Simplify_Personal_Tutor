import { routeSafety } from '../knowledge/safety.js';
import {
  isRomanizationLikeText,
  resolveVisitDirection,
  VISIT_DIRECTIONS,
} from '../knowledge/visit-direction.js';
import { createDailyLifeVisitTranslation, staffConfirmVisitTranslation } from '../knowledge/visit-fallback.js';

function emergencyResult(safety, direction) {
  const text = direction === 'yue_to_zh' ? safety.guidance.zhHans : safety.guidance.en;
  return {
    translatedText: text,
    displayText: text,
    romanization: null,
    autoRouted: false,
    routeReason: 'safety_emergency',
    needsConfirmation: false,
    provider: 'safety',
    suppressTts: true,
  };
}

function withRouting(base, routing, extras = {}) {
  return {
    translatedText: base.translatedText,
    displayText: base.displayText ?? base.translatedText,
    romanization: base.romanization ?? null,
    autoRouted: routing.autoRouted,
    routeReason: routing.routeReason,
    needsConfirmation: Boolean(base.needsConfirmation),
    provider: extras.provider ?? 'rule-fallback',
    suppressTts: extras.suppressTts === true || !base.speakableText,
    requestedDirection: routing.requestedDirection,
    effectiveDirection: routing.effectiveDirection,
  };
}

export function createVisitTranslationService({
  llmProvider = null,
  safetyRouter = routeSafety,
} = {}) {
  async function translate({ sourceText, direction, userJob, signal } = {}) {
    const text = String(sourceText ?? '').trim();
    if (!text || !VISIT_DIRECTIONS.includes(direction)) {
      const error = new Error('INVALID_REQUEST');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    const safety = safetyRouter(text);
    if (safety.kind === 'emergency') return emergencyResult(safety, direction);
    const routing = resolveVisitDirection(text, direction);
    const suppressTts = isRomanizationLikeText(text);
    const rule = createDailyLifeVisitTranslation(text, routing.effectiveDirection);
    if (rule) return withRouting(rule, routing, { provider: 'rule-fallback', suppressTts });
    if (typeof llmProvider?.generate === 'function') {
      try {
        const result = await llmProvider.generate({
          systemPrompt: [
            'Translate for a supervised elderly or community visit.',
            'Never invent campus evidenceIds.',
            'Return JSON {"translatedText":"...","displayText":"...","needsConfirmation":false}.',
          ].join(' '),
          messages: [{ role: 'user', content: `${routing.effectiveDirection}\n${text}` }],
          maxOutputTokens: 400,
          signal,
        });
        const draft = JSON.parse(String(result.rawText ?? result.text ?? ''));
        if (draft?.translatedText) {
          return withRouting({
            translatedText: draft.translatedText,
            displayText: draft.displayText ?? draft.translatedText,
            romanization: draft.romanization ?? null,
            needsConfirmation: Boolean(draft.needsConfirmation),
            speakableText: suppressTts ? '' : (draft.speakableText ?? draft.translatedText),
          }, routing, { provider: result.provider ?? 'vertex-ai', suppressTts });
        }
      } catch {
        /* fall through to staff confirm */
      }
    }
    return withRouting(staffConfirmVisitTranslation(routing.effectiveDirection), routing, {
      provider: 'staff-confirm',
      suppressTts: true,
    });
  }

  return { translate };
}
