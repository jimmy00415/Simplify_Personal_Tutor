import { consentCopy, chromeCopy } from './legal-copy.js';

export function createConsentController({
  dialog,
  title,
  copy,
  continueButton,
  leaveButton,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  let granted = false;
  let left = false;

  function applyLanguage(language) {
    const text = consentCopy(language);
    if (title) title.textContent = text.title;
    if (copy) copy.textContent = text.copy;
    if (continueButton) continueButton.textContent = text.continue;
    if (leaveButton) leaveButton.textContent = text.leave;
  }

  async function grant(version) {
    const response = await fetchImpl('/api/v1/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kinds: ['ai'], version }),
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body?.error?.code ?? 'CONSENT_FAILED'), { code: body?.error?.code });
    granted = body.data?.consent?.aiGranted === true;
    dialog?.close?.();
    return body.data.consent;
  }

  function show({ required, alreadyGranted, language = 'en' } = {}) {
    granted = alreadyGranted === true;
    applyLanguage(language);
    if (!required || granted || !dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
  }

  function leave() {
    left = true;
    granted = false;
    dialog?.close?.();
  }

  continueButton?.addEventListener('click', () => {
    const version = dialog?.dataset?.noticeVersion;
    void grant(version).catch(() => undefined);
  });
  leaveButton?.addEventListener('click', leave);

  return {
    show,
    grant,
    leave,
    applyLanguage,
    chromeCopy,
    isGranted: () => granted,
    hasLeft: () => left,
  };
}
