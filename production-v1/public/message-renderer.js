import { formatFreshness, safeOfficialUrl } from './chat-state.js';

function element(document, tagName, className, text = null) {
  const node = document.createElement(tagName);
  node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

function messageTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Hong_Kong',
  }).format(date);
}

const ANSWER_LANG = Object.freeze({
  en: 'en',
  'yue-Hant-HK': 'zh-HK',
  'cmn-Hans-CN': 'zh-CN',
});

function sourceLink(document, citation, href) {
  const link = element(document, 'a', 'source-card');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `Open official source: ${String(citation.title || 'HKBU source')}`);
  link.append(
    element(document, 'span', 'source-title', citation.title || 'Official HKBU source'),
    element(document, 'span', 'source-publisher', citation.publisher || 'Hong Kong Baptist University'),
    element(
      document,
      'span',
      'source-freshness',
      citation.status === 'verified'
        ? formatFreshness(citation.verifiedAt).replace(/^Verified /, 'Checked ')
        : 'Official source · not confirmed for this answer',
    ),
  );
  return link;
}

function appendSources(document, container, citations) {
  const unique = new Map();
  for (const citation of citations ?? []) {
    const href = safeOfficialUrl(citation?.url);
    if (href && !unique.has(href)) unique.set(href, { citation, href });
  }
  const links = [...unique.values()].map(({ citation, href }) => sourceLink(document, citation, href));
  if (links.length <= 1) {
    if (links[0]) container.append(links[0]);
    return;
  }
  const disclosure = element(document, 'details', 'sources-disclosure');
  const summary = element(document, 'summary', 'sources-summary', `Sources (${links.length})`);
  const list = element(document, 'div', 'sources-list');
  list.append(...links);
  disclosure.append(summary, list);
  container.append(disclosure);
}

function appendActions(document, container, cards) {
  const links = [];
  for (const card of cards ?? []) {
    const href = safeOfficialUrl(card?.url);
    if (!href) continue;
    const link = element(document, 'a', 'action-card');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', String(card.label || 'Open official guide'));
    link.append(
      element(document, 'span', 'action-card-title', card.title || 'Official HKBU guide'),
      element(document, 'span', 'action-card-label', card.label || 'Open official guide'),
    );
    links.push(link);
  }
  if (links.length === 0) return;
  container.append(element(document, 'span', 'official-next-step-label', 'Official next step'), ...links);
}

export function createMessageElement(document, message, {
  isLatestAssistant = false,
  onRetry = null,
} = {}) {
  if (!document?.createElement) throw new Error('A document adapter is required');
  const role = message?.role === 'user' ? 'user' : 'assistant';
  const article = element(document, 'article', `message-row message-row--${role}`);
  article.dataset.messageId = String(message?.id ?? '');
  if (typeof message?.clientMessageId === 'string' && message.clientMessageId.length <= 128) {
    article.dataset.clientMessageId = message.clientMessageId;
  }
  if (role === 'assistant' && ['verified', 'unverified'].includes(message?.groundingStatus)) {
    article.dataset.groundingStatus = message.groundingStatus;
  }

  const avatar = element(document, 'img', 'profile-avatar message-avatar');
  avatar.src = '/assets/ai-senior-avatar-128.png';
  avatar.alt = '';
  const stack = element(document, 'div', 'message-stack');
  const bubble = element(document, 'div', `message-bubble message-bubble--${role}`);
  const messageText = element(document, 'p', 'message-text', message?.text ?? '');
  if (role === 'assistant') messageText.setAttribute('lang', ANSWER_LANG[message?.replyLanguage] ?? 'en');
  bubble.append(messageText);
  stack.append(bubble);

  if (role === 'assistant') {
    const audioControl = element(document, 'div', 'assistant-audio');
    audioControl.hidden = true;
    audioControl.dataset.messageId = String(message?.id ?? '');
    audioControl.dataset.mediaId = String(message?.mediaId ?? '');
    const audioButton = element(document, 'button', 'assistant-audio-button', 'Generate voice');
    audioButton.type = 'button';
    audioButton.dataset.messageId = String(message?.id ?? '');
    audioButton.setAttribute('aria-pressed', 'false');
    audioButton.setAttribute('aria-label', 'Generate an optional AI voice for this answer');
    const audioStatus = element(document, 'span', 'assistant-audio-status');
    audioStatus.setAttribute('role', 'status');
    audioStatus.setAttribute('aria-live', 'polite');
    audioStatus.setAttribute('aria-atomic', 'true');
    const audioDisclosure = element(document, 'span', 'assistant-audio-disclosure', 'Optional AI-generated voice');
    audioControl.append(audioButton, audioStatus, audioDisclosure);
    stack.append(audioControl);
  }

  const sources = element(document, 'div', 'message-sources');
  appendSources(document, sources, message?.citations);
  stack.append(sources);

  const actions = element(document, 'div', 'message-actions');
  appendActions(document, actions, message?.cards);
  stack.append(actions);

  const suggested = element(document, 'div', 'suggested-replies');
  if (role === 'assistant' && isLatestAssistant) {
    for (const reply of message?.suggestedReplies ?? []) {
      if (typeof reply !== 'string' || !reply.trim()) continue;
      const button = element(document, 'button', 'suggested-reply', reply.trim());
      button.type = 'button';
      button.dataset.prompt = reply.trim();
      suggested.append(button);
    }
  }
  stack.append(suggested);

  const meta = element(document, 'div', 'message-meta');
  const time = element(document, 'time', 'message-time', messageTime(message?.createdAt));
  if (message?.createdAt) time.dateTime = String(message.createdAt);
  const status = element(document, 'span', 'message-state');
  if (message?.sendState === 'sending') status.textContent = 'Sending…';
  if (message?.sendState === 'unconfirmed') {
    status.textContent = 'Send not confirmed';
    status.dataset.state = 'failed';
  } else if (message?.sendState === 'retryable-rejection') {
    status.textContent = 'Not sent · wait to retry';
    status.dataset.state = 'failed';
  } else if (message?.sendState === 'rejected') {
    status.textContent = message?.failureCode === 'RATE_LIMITED'
      ? 'Not sent · rate limit'
      : 'Message was not accepted';
    status.dataset.state = 'failed';
  } else if (!message?.optimistic && role === 'user' && message?.status === 'failed') {
    status.textContent = 'Reply could not be completed';
    status.dataset.state = 'failed';
  }
  const retry = element(document, 'button', 'retry-message', 'Retry send');
  retry.type = 'button';
  retry.hidden = true;
  const report = element(document, 'button', 'report-answer', 'Report');
  report.type = 'button';
  report.hidden = role !== 'assistant' || Boolean(message?.optimistic);
  if (!report.hidden) report.dataset.messageId = String(message?.id ?? '');
  if (['unconfirmed', 'retryable-rejection'].includes(message?.sendState)
    && typeof onRetry === 'function') {
    retry.hidden = false;
    retry.dataset.clientMessageId = String(message.clientMessageId ?? '');
    retry.addEventListener('click', () => onRetry(message.clientMessageId));
  }
  meta.append(time, status, retry, report);
  stack.append(meta);

  article.append(avatar, stack);
  return article;
}
