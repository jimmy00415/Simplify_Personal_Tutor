const EXPERIENCE_COPY = Object.freeze({
  en: Object.freeze({
    documentLanguage: 'en',
    welcome: 'Hi — I’m Hong Kong Buddy, your HKBU AI senior. Ask me about registration, halls, food, campus services, transport, or settling into Hong Kong.',
    disclosure: 'Campus facts include official sources.',
    placeholder: 'Ask your AI senior…',
    starterPrompts: Object.freeze([
      'How do I activate my SSOid?',
      'What food options are available at HKBU?',
      'Where can I use my student e-Card?',
      'How do I set up Duo on a new phone?',
    ]),
  }),
  'yue-Hant-HK': Object.freeze({
    documentLanguage: 'zh-HK',
    welcome: '你好，我係 Hong Kong Buddy，你嘅浸大 AI 學長。註冊、宿舍、飲食、校園服務、交通同香港生活，都可以問我。',
    disclosure: '校園資料會附上官方來源。',
    placeholder: '問你嘅浸大 AI 學長…',
    starterPrompts: Object.freeze([
      '點樣啟用 SSOid？',
      '浸大有咩食嘢選擇？',
      '學生電子證（Student e-Card）可以喺邊度用？',
      '換咗電話後點樣設定 Duo？',
    ]),
  }),
  'cmn-Hans-CN': Object.freeze({
    documentLanguage: 'zh-CN',
    welcome: '你好，我是 Hong Kong Buddy，你的浸大 AI 学长。注册、宿舍、餐饮、校园服务、交通和香港生活，都可以问我。',
    disclosure: '校园信息会附上官方来源。',
    placeholder: '问你的浸大 AI 学长…',
    starterPrompts: Object.freeze([
      '怎么启用 SSOid？',
      '浸大有什么吃饭选择？',
      '学生电子证（Student e-Card）可以在哪里使用？',
      '换了手机后怎么设置 Duo？',
    ]),
  }),
});

const REPLY_LANGUAGE_LABELS = Object.freeze({
  en: 'English',
  'yue-Hant-HK': '廣東話',
  'cmn-Hans-CN': '普通話',
});

const REPLY_MODE_LABELS = Object.freeze({ text: 'Text', voice: 'Voice reply' });

export function chatExperienceCopy(replyLanguage = 'en') {
  const copy = EXPERIENCE_COPY[replyLanguage];
  if (!copy) throw new TypeError('Unsupported reply language');
  return { ...copy, starterPrompts: [...copy.starterPrompts] };
}

export function replyPreferenceLabel({ replyLanguage = 'en', replyMode = 'text' } = {}) {
  const language = REPLY_LANGUAGE_LABELS[replyLanguage];
  if (!language) throw new TypeError('Unsupported reply language');
  const mode = REPLY_MODE_LABELS[replyMode];
  if (!mode) throw new TypeError('Unsupported reply mode');
  return `${language} · ${mode}`;
}

export function startErrorCopy() {
  return 'The chat could not start. Check your connection and refresh to try again.';
}

export function sendErrorCopy(error = {}) {
  if (error.code === 'CHAT_NOT_READY') {
    return 'The chat is changing. Wait until the conversation is ready before trying again.';
  }
  if (error.code === 'SESSION_RECOVERED') {
    return 'A new guest chat is ready. Your draft was kept; send it again when you are ready.';
  }
  if (error.code === 'SESSION_RECOVERY_FAILED') {
    return 'Your guest session expired. Your draft is kept here, but a new chat could not start yet. Refresh to try again.';
  }
  if (error.code === 'AI_CONSENT_REQUIRED') {
    return 'Please accept the AI disclosure before sending.';
  }
  if (error.code === 'VOICE_CONSENT_REQUIRED') {
    return 'Please accept optional voice transcription first.';
  }
  if (error.code === 'RATE_LIMITED' || error.status === 429) {
    return error.retryAfter
      ? `Your message was not accepted. Wait ${error.retryAfter} seconds before sending again.`
      : 'Your message was not accepted. Wait a moment before sending again.';
  }
  if (Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 500) {
    return 'Your message was not accepted. Edit the draft if needed, then send it again.';
  }
  return 'Send not confirmed. Your draft is kept; use Retry send on the message.';
}

export function clearErrorCopy(error = {}) {
  if (error.code === 'CLEARED_RESTART_FAILED' || error.deleted === true) {
    return 'Conversation cleared. A new guest chat could not start yet; refresh to try again.';
  }
  if (error.code === 'CLEAR_OUTCOME_UNKNOWN') {
    return 'Clearing could not be confirmed. Refresh to check this guest chat before continuing.';
  }
  if (error.code === 'CLEAR_FAILED_RECOVERY_PENDING') {
    return 'The conversation was not cleared, and the existing chat could not be reloaded. Refresh to recover it.';
  }
  return 'The conversation was not cleared. Please try again.';
}
