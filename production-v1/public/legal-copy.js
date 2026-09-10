const CONSENT = Object.freeze({
  en: Object.freeze({
    title: 'Use this AI assistant?',
    copy: 'Hong Kong Buddy is an AI assistant, not an official HKBU representative. Typed text is stored in Hong Kong and sent to Google Vertex AI using the global endpoint. Optional voice uploads a recording to Google Speech-to-Text in Singapore before you tap Send. Generated voice uses Google Text-to-Speech in Singapore. Guest history does not follow you to another device. Clear conversation revokes this session.',
    continue: 'Continue',
    leave: 'Leave',
  }),
  'yue-Hant-HK': Object.freeze({
    title: '用呢個 AI 助手？',
    copy: 'Hong Kong Buddy 係 AI 助手，唔係浸大官方代表。你打嘅字會存喺香港，並送到 Google Vertex AI 全球端點。可選語音會喺你按傳送前，把錄音上傳到新加坡嘅 Google Speech-to-Text。生成語音用新加坡嘅 Google Text-to-Speech。訪客紀錄唔會跟你去另一部裝置。清除對話會撤銷呢個工作階段。',
    continue: '繼續',
    leave: '離開',
  }),
  'cmn-Hans-CN': Object.freeze({
    title: '使用这个 AI 助手？',
    copy: 'Hong Kong Buddy 是 AI 助手，不是浸大官方代表。你输入的文字会存放在香港，并送到 Google Vertex AI 全球端点。可选语音会在你点发送前，把录音上传到新加坡的 Google Speech-to-Text。生成语音使用新加坡的 Google Text-to-Speech。访客记录不会跟随你到另一部设备。清除对话会撤销此会话。',
    continue: '继续',
    leave: '离开',
  }),
});

const CHROME = Object.freeze({
  en: Object.freeze({
    today: 'Today',
    campus: 'Campus',
    practice: 'Practice',
    translate: 'Translate',
    deletion: 'Clear conversation revokes this guest session and queues stored data for deletion.',
    voiceStatus: 'Voice draft · Not sent',
    report: 'Report',
    consentRequired: 'Please accept the AI disclosure before sending.',
    leaveOnly: 'You can still open Privacy and the offline phrasebook.',
  }),
  'yue-Hant-HK': Object.freeze({
    today: '今日',
    campus: '校園',
    practice: '練習',
    translate: '翻譯',
    deletion: '清除對話會撤銷呢個訪客工作階段，並排隊刪除已存資料。',
    voiceStatus: '語音草稿 · 未傳送',
    report: '回報',
    consentRequired: '請先接受 AI 說明再傳送。',
    leaveOnly: '你仍然可以開啟私隱同離線語句冊。',
  }),
  'cmn-Hans-CN': Object.freeze({
    today: '今日',
    campus: '校园',
    practice: '练习',
    translate: '翻译',
    deletion: '清除对话会撤销此访客会话，并排队删除已存数据。',
    voiceStatus: '语音草稿 · 未发送',
    report: '报告',
    consentRequired: '请先接受 AI 说明再发送。',
    leaveOnly: '你仍可打开隐私和离线短语本。',
  }),
});

export function consentCopy(language = 'en') {
  return CONSENT[language] ?? CONSENT.en;
}

export function chromeCopy(language = 'en') {
  return CHROME[language] ?? CHROME.en;
}
