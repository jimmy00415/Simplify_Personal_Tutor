export function createPracticeView({
  feed,
  input,
  form,
  correctButton,
  modeButtons,
  scenario,
  status,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  uuid = () => globalThis.crypto.randomUUID(),
  onFirstDelivery = () => {},
} = {}) {
  let mode = 'teaching';
  let delivered = false;

  function setMode(next) {
    mode = next === 'freeChat' ? 'freeChat' : 'teaching';
    for (const button of modeButtons ?? []) {
      button.setAttribute('aria-pressed', String(button.id === `practice-mode-${mode}`));
    }
  }

  async function refresh() {
    const response = await fetchImpl('/api/v1/practice/messages?after=0');
    const body = await response.json();
    if (!feed) return body;
    feed.replaceChildren();
    for (const message of body.data?.messages ?? []) {
      const row = document.createElement('p');
      row.textContent = `${message.role}: ${message.text}`;
      feed.append(row);
    }
    return body;
  }

  async function send(text) {
    const response = await fetchImpl('/api/v1/practice/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientMessageId: uuid(),
        text,
        mode,
        scenario: scenario?.value ?? 'freeConversation',
        replyLanguage: 'en',
        replyMode: 'text',
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      if (status) status.textContent = body.error?.code ?? 'SEND_FAILED';
      throw Object.assign(new Error(body.error?.code ?? 'SEND_FAILED'), { code: body.error?.code });
    }
    if (input) input.value = '';
    await refresh();
    if (!delivered) {
      delivered = true;
      onFirstDelivery();
    }
    return body;
  }

  async function correct() {
    const response = await fetchImpl('/api/v1/practice/correct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (status) status.textContent = body.data?.coachNotes ?? body.error?.code ?? '';
    return body;
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input?.value?.trim();
    if (text) void send(text).catch(() => undefined);
  });
  correctButton?.addEventListener('click', () => { void correct().catch(() => undefined); });
  for (const button of modeButtons ?? []) {
    button.addEventListener('click', () => setMode(button.id.endsWith('freeChat') ? 'freeChat' : 'teaching'));
  }

  return { send, correct, refresh, setMode, mode: () => mode };
}
