const GENERIC_VISIT_TRANSLATION_PATTERNS = [
  /The resident said something in Cantonese/i,
  /Please ask staff to confirm the exact meaning/i,
  /长者.*粤语.*确认/,
  /長者.*粵語.*確認/,
  /請.*職員.*確認/,
  /请.*工作人员.*确认/,
];

const FOOD_TERMS = [
  { pattern: /紅燒肉|红烧肉/, english: 'red-braised pork', mandarin: '紅燒肉' },
  { pattern: /叉燒|叉烧/, english: 'char siu', mandarin: '叉燒' },
  { pattern: /點心|点心/, english: 'dim sum', mandarin: '點心' },
  { pattern: /燒賣|烧卖/, english: 'siu mai', mandarin: '燒賣' },
  { pattern: /粥/, english: 'congee', mandarin: '粥' },
];

function normalizeVisitText(text) {
  return String(text || '')
    .replace(/\bmore\s*guy\b/gi, '唔該')
    .replace(/\bm4\s*goi(?:1)?\b/gi, '唔該')
    .replace(/[，。！？,.!?？]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function visitResult(displayText, options = {}) {
  const text = String(displayText || '').trim();
  return {
    translatedText: text,
    displayText: text,
    speakableText: options.speakableText || '',
    romanization: options.romanization || null,
    needsConfirmation: Boolean(options.needsConfirmation),
  };
}

function jyutping(text) {
  return { scheme: 'jyutping', text, toneNumbers: true };
}

const COMMON_VISIT_RULES = [
  {
    patterns: {
      cantonese: [/伸展|拉筋|鬆一鬆|松一松|郁一郁|活動.*(手|肩|膊|胳膊)|手.*伸展/],
      english: [/(stretch|move|exercise|relax).{0,24}(hand|hands|arm|arms|shoulder|shoulders)/, /(hand|hands|arm|arms|shoulder|shoulders).{0,24}(stretch|move|exercise|relax)/],
      mandarin: [/伸展|拉筋|放松|放鬆|活动.*(手|胳膊|肩膀)|手.*伸展/],
    },
    outputs: {
      yue_to_en: visitResult('Would you like me to help you gently stretch your hands?'),
      yue_to_zh: visitResult('你想让我帮你轻轻伸展一下双手吗？'),
      en_to_yue: visitResult('我可唔可以幫你伸展一下雙手？', {
        speakableText: '我可唔可以幫你伸展一下雙手？',
        romanization: jyutping('ngo5 ho2 m4 ho2 ji5 bong1 nei5 san1 zin2 jat1 haa5 soeng1 sau2?'),
      }),
      zh_to_yue: visitResult('我可唔可以幫你伸展一下雙手？', {
        speakableText: '我可唔可以幫你伸展一下雙手？',
        romanization: jyutping('ngo5 ho2 m4 ho2 ji5 bong1 nei5 san1 zin2 jat1 haa5 soeng1 sau2?'),
      }),
    },
  },
  {
    patterns: {
      cantonese: [/唔該|多謝|谢谢|謝謝/],
      english: [/thank/],
      mandarin: [/谢谢|謝謝|麻烦|麻煩/],
    },
    outputs: {
      yue_to_en: visitResult('Thank you.'),
      yue_to_zh: visitResult('谢谢。'),
      en_to_yue: visitResult('唔該晒。', {
        speakableText: '唔該晒。',
        romanization: jyutping('m4 goi1 saai3.'),
      }),
      zh_to_yue: visitResult('唔該晒。', {
        speakableText: '唔該晒。',
        romanization: jyutping('m4 goi1 saai3.'),
      }),
    },
  },
  {
    patterns: {
      cantonese: [/我.*(想|要|飲|喝).*水/, /我.*口渴/, /唔該.*水/],
      english: [/water|drink|thirsty/],
      mandarin: [/我.*(想|要|喝).*水/, /口渴/],
    },
    outputs: {
      yue_to_en: visitResult('I would like some water, please.'),
      yue_to_zh: visitResult('我想喝点水，谢谢。'),
      en_to_yue: visitResult('你想唔想飲啲水？', {
        speakableText: '你想唔想飲啲水？',
        romanization: jyutping('nei5 soeng2 m4 soeng2 jam2 di1 seoi2?'),
      }),
      zh_to_yue: visitResult('你想唔想飲啲水？', {
        speakableText: '你想唔想飲啲水？',
        romanization: jyutping('nei5 soeng2 m4 soeng2 jam2 di1 seoi2?'),
      }),
    },
  },
  {
    patterns: {
      cantonese: [/按摩|按一按|按吓|按下|鬆骨|松骨/],
      english: [/massage|massaging|rub|shoulder\s*massage|back\s*massage/],
      mandarin: [/按摩|按一按|揉一揉/],
    },
    outputs: {
      yue_to_en: visitResult('Would you like me to help you with a short massage?'),
      yue_to_zh: visitResult('你想让我帮你按摩一下吗？'),
      en_to_yue: visitResult('你想唔想我幫你按摩一下？', {
        speakableText: '你想唔想我幫你按摩一下？',
        romanization: jyutping('nei5 soeng2 m4 soeng2 ngo5 bong1 nei5 on3 mo1 jat1 haa5?'),
      }),
      zh_to_yue: visitResult('你想唔想我幫你按摩一下？', {
        speakableText: '你想唔想我幫你按摩一下？',
        romanization: jyutping('nei5 soeng2 m4 soeng2 ngo5 bong1 nei5 on3 mo1 jat1 haa5?'),
      }),
    },
  },
];

function sourceGroupForDirection(direction) {
  if (direction === 'en_to_yue') return 'english';
  if (direction === 'zh_to_yue') return 'mandarin';
  return 'cantonese';
}

function matchesRule(patterns, compactText, rawText) {
  return patterns.some((pattern) => pattern.test(compactText) || pattern.test(rawText));
}

function detectCommonVisitTranslation(sourceText, direction) {
  const compactText = normalizeVisitText(sourceText).toLowerCase();
  const rawText = String(sourceText || '').toLowerCase();
  const sourceGroup = sourceGroupForDirection(direction);
  for (const rule of COMMON_VISIT_RULES) {
    const patterns = rule.patterns[sourceGroup] || [];
    if (rule.outputs[direction] && matchesRule(patterns, compactText, rawText)) {
      return rule.outputs[direction];
    }
  }
  return null;
}

function detectFoodPreference(sourceText) {
  const text = normalizeVisitText(sourceText);
  if (!text) return null;
  const hasLike = /(我都|我也|我又)?(鐘意|鍾意|中意|喜歡|喜欢)/.test(text);
  const hasEat = /(食|吃)/.test(text);
  const asksBack = /(你哋|你地|你們|你们).*(乜嘢|乜野|咩|什麼|什么|呢|呀|吖|啦|喇)?/.test(text);
  const food = FOOD_TERMS.find((term) => term.pattern.test(text));
  if (!hasLike || !hasEat || !food) return null;
  return {
    englishFood: food.english,
    mandarinFood: food.mandarin,
    quantity: /(一點|一点|少少|少許|些少|啲|的)/.test(text),
    asksBack,
  };
}

export function createDailyLifeVisitTranslation(sourceText, direction) {
  const commonTranslation = detectCommonVisitTranslation(sourceText, direction);
  if (commonTranslation) return commonTranslation;
  const foodPreference = detectFoodPreference(sourceText);
  if (!foodPreference) return null;
  const englishQuantity = foodPreference.quantity ? 'a little ' : '';
  const englishTail = foodPreference.asksBack ? ' What about you?' : '';
  const mandarinQuantity = foodPreference.quantity ? '一點' : '';
  const mandarinTail = foodPreference.asksBack ? '，你們呢？' : '。';
  if (direction === 'yue_to_en') {
    const displayText = `I also like eating ${englishQuantity}${foodPreference.englishFood}.${englishTail}`;
    return { translatedText: displayText, displayText, speakableText: '', romanization: null };
  }
  if (direction === 'yue_to_zh') {
    const displayText = `我也喜歡吃${mandarinQuantity}${foodPreference.mandarinFood}${mandarinTail}`;
    return { translatedText: displayText, displayText, speakableText: '', romanization: null };
  }
  return null;
}

export function isGenericVisitTranslation(text) {
  const value = String(text || '').trim();
  return GENERIC_VISIT_TRANSLATION_PATTERNS.some((pattern) => pattern.test(value));
}

export function staffConfirmVisitTranslation(direction) {
  if (direction === 'yue_to_zh') {
    return visitResult('请工作人员确认准确意思。', { needsConfirmation: true });
  }
  if (direction === 'en_to_yue' || direction === 'zh_to_yue') {
    return visitResult('請職員確認準確意思。', {
      speakableText: '',
      needsConfirmation: true,
    });
  }
  return visitResult('Please ask staff to confirm the exact meaning.', { needsConfirmation: true });
}
