export function createVisitView({
  form,
  input,
  direction,
  result,
  display,
  romanization,
  jobButtons,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  uuid = () => globalThis.crypto.randomUUID(),
} = {}) {
  for (const button of jobButtons ?? []) {
    button.addEventListener('click', () => {
      if (direction && button.dataset.direction) direction.value = button.dataset.direction;
    });
  }

  async function translate(sourceText) {
    const response = await fetchImpl('/api/v1/visit-translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceText,
        direction: direction?.value ?? 'yue_to_en',
        clientTurnId: uuid(),
        inputType: 'text',
      }),
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error?.code ?? 'VISIT_FAILED'), { code: body.error?.code });
    if (result) result.hidden = false;
    if (display) display.textContent = body.data.displayText;
    if (romanization) {
      romanization.textContent = body.data.romanization?.text ?? '';
    }
    return body.data;
  }

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input?.value?.trim();
    if (text) void translate(text).catch(() => undefined);
  });

  return { translate };
}
