const CJK_PATTERN = /[\u3400-\u9fff]/;
const ENGLISH_WORD_PATTERN = /[A-Za-z]{2,}/g;

export const VISIT_DIRECTIONS = Object.freeze(['yue_to_en', 'yue_to_zh', 'en_to_yue', 'zh_to_yue']);

export function looksLikeEnglishVisitInput(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const englishWords = value.match(ENGLISH_WORD_PATTERN) || [];
  const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (value.match(/[A-Za-z]/g) || []).length;
  const visibleCount = (value.match(/[A-Za-z\u3400-\u9fff]/g) || []).length || 1;
  return englishWords.length >= 2 && !CJK_PATTERN.test(value) && cjkCount === 0 && latinCount / visibleCount > 0.75;
}

export function isRomanizationLikeText(text) {
  const value = String(text || '').trim();
  if (!value || CJK_PATTERN.test(value)) return false;
  return /[a-z]+[1-6]\b/i.test(value);
}

export function resolveVisitDirection(sourceText, requestedDirection) {
  if ((requestedDirection === 'yue_to_en' || requestedDirection === 'yue_to_zh')
    && looksLikeEnglishVisitInput(sourceText)) {
    return {
      requestedDirection,
      effectiveDirection: 'en_to_yue',
      autoRouted: true,
      routeReason: 'english_input_in_resident_mode',
    };
  }
  return {
    requestedDirection,
    effectiveDirection: requestedDirection,
    autoRouted: false,
    routeReason: null,
  };
}
