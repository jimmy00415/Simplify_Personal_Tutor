import { createAppShell } from './app-shell.js';
import { createChatController } from './chat-controller.js';
import { createConsentController } from './consent-controller.js';
import { chromeCopy } from './legal-copy.js';
import { createPhrasebookView } from './phrasebook-view.js';
import { createPracticeView } from './practice-view.js';
import { createTodayView, markHabitPractised } from './today-view.js';
import { createVisitView } from './visit-view.js';
import {
  chatExperienceCopy,
  clearErrorCopy,
  replyPreferenceLabel,
  sendErrorCopy,
  startErrorCopy,
} from './chat-copy.js';
import { formatFreshness, shouldSubmitOnEnter, shouldSyncDraft, turnStatusMessage } from './chat-state.js';
import { createAssistantAudioController } from './assistant-audio-controller.js';
import { assistantAudioMediaIdentity, performAssistantAudioAction } from './assistant-audio-actions.js';
import { createMessageElement } from './message-renderer.js';
import {
  assistantVoiceMessagesToPrepare,
  currentReplyTupleIsFixed,
  reconcileMessageFeed,
} from './timeline-view.js';
import { createVoiceCapture } from './voice-capture.js';
import { createVoiceMessageController } from './voice-message-controller.js';
import { createVoiceTransport } from './voice-transport.js';
import { createVoiceUploadCoordinator } from './voice-upload-coordinator.js';
import { createVoiceUploadStore } from './voice-upload-store.js';
import {
  acceptedVoiceComposerDraft,
  clearVoiceScopeAfterProvenDeletion,
  createVoiceActivationGate,
  createVoiceHoldFence,
  guardedVoicePreflight,
  guardedVoiceRemove,
  voicePhaseCanCancelInteraction,
} from './voice-ui-guards.js';

const shell = document.querySelector('.chat-shell');
const messageList = document.querySelector('#message-list');
const messageFeed = document.querySelector('#message-feed');
const welcome = document.querySelector('#welcome');
const turnStatus = document.querySelector('#turn-status');
const connectionStatus = document.querySelector('#connection-status');
const composer = document.querySelector('#composer');
const composerPanel = document.querySelector('.composer-panel');
const messageInput = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const voiceButton = document.querySelector('#voice-button');
const voiceDraft = document.querySelector('#voice-draft');
const voiceDraftState = document.querySelector('#voice-draft-state');
const voiceDraftHelp = document.querySelector('#voice-draft-help');
const removeVoiceDraft = document.querySelector('#remove-voice-draft');
const retryVoiceCleanupButton = document.querySelector('#retry-voice-cleanup');
const voiceLive = document.querySelector('#voice-live');
const voiceHint = document.querySelector('#voice-hint');
const retryVoiceTranscriptionButton = document.querySelector('#retry-voice-transcription');
const cancelVoiceButton = document.querySelector('#cancel-voice');
const voiceConsent = document.querySelector('#voice-consent');
const voiceConsentContinue = document.querySelector('#voice-consent-continue');
const voiceConsentCancel = document.querySelector('#voice-consent-cancel');
const feedback = document.querySelector('#composer-feedback');
const starterPrompts = [...document.querySelectorAll('.starter-prompt')];
const welcomeMessage = document.querySelector('#welcome-message');
const welcomeDisclosure = document.querySelector('#welcome-disclosure');
const replyPreferencesTrigger = document.querySelector('#reply-preferences-trigger');
const replyPreferenceValue = document.querySelector('#reply-preference-value');
const replyPreferenceNote = document.querySelector('#reply-preference-note');
const replyPreferences = document.querySelector('#reply-preferences');
const replyPreferencesForm = document.querySelector('#reply-preferences-form');
const cancelReplyPreferences = document.querySelector('#cancel-reply-preferences');
const infoButton = document.querySelector('.info-button');
const infoSheet = document.querySelector('#assistant-info');
const closeButton = document.querySelector('#assistant-info .close-button');
const clearButton = document.querySelector('#clear-session');
const clearStatus = document.querySelector('#clear-status');
const knowledgeSnapshotDate = document.querySelector('#knowledge-snapshot-date');

const VOICE_BUSY_PHASES = new Set([
  'binding',
  'permission-checking',
  'processing',
  'recording',
  'removing',
  'resuming',
  'saving',
  'sending',
  'starting',
]);
const VOICE_CAPTURE_CANCEL_PHASES = new Set(['recording', 'starting']);
const VOICE_RETAINED_PHASES = new Set(['error', 'processing', 'transcription-retryable']);
const PUBLIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let latestSnapshot = null;
let latestVoiceSnapshot = null;
let clearConfirmationTimer = null;
let clearArmed = false;
let uiFeedback = '';
let voiceRuntime = null;
let voiceRuntimeEpoch = 0;
let desiredVoiceScope;
let voiceSyncPromise = Promise.resolve();
let voiceSetupFailed = false;
let presentedVoiceDraftId = null;
let activePointerId = null;
let keyboardRecording = false;
let assistantAudioController = null;
let assistantAudioScope = null;
let latestAssistantAudioSnapshot = null;
let assistantAudioRetryTimer = null;
let assistantAudioRetryAt = null;
let clearInProgress = false;
const voiceActivationGate = createVoiceActivationGate();
const voiceHoldFence = createVoiceHoldFence();

function atBottom() {
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 96;
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
}

function resizeComposer() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
}

function setFeedback(text = '') {
  uiFeedback = text;
  feedback.textContent = text;
}

function safeVoiceCopy(error, fallback = 'Voice input could not continue. You can keep typing your message.') {
  return error?.textSafe === true && typeof error.message === 'string' && error.message
    ? error.message
    : fallback;
}

function connectionCopy(state) {
  if (state === 'connecting') return 'Connecting to your guest conversation…';
  if (state === 'reconnecting') return 'Reconnecting. Your saved messages stay here.';
  return '';
}

function voiceAvailable(snapshot = latestSnapshot) {
  return Boolean(snapshot?.capabilities?.voiceInput || snapshot?.capabilities?.voiceInputPreview);
}

function assistantAudioAvailable(snapshot = latestSnapshot) {
  return Boolean(snapshot?.capabilities?.voiceOutput || snapshot?.capabilities?.voiceOutputPreview);
}

function renderAssistantAudioControls() {
  const messages = new Map((latestSnapshot?.messages ?? []).map((message) => [message.id, message]));
  const available = Boolean(
    assistantAudioController
      && latestSnapshot?.ready
      && assistantAudioScope === latestSnapshot.clientSessionScope
      && assistantAudioAvailable()
      && !latestAssistantAudioSnapshot?.disposed,
  );
  let nextRetryAt = null;
  for (const control of messageFeed.querySelectorAll('.assistant-audio[data-message-id]')) {
    const messageId = control.dataset.messageId;
    const message = messages.get(messageId);
    const eligible = Boolean(
      available
        && PUBLIC_UUID.test(messageId ?? '')
        && message?.role === 'assistant'
        && message?.status === 'delivered',
    );
    control.hidden = !eligible;
    if (!eligible) continue;

    const button = control.querySelector('.assistant-audio-button');
    const status = control.querySelector('.assistant-audio-status');
    const entry = latestAssistantAudioSnapshot?.entries?.[messageId] ?? null;
    const playback = latestAssistantAudioSnapshot?.playback?.messageId === messageId
      ? latestAssistantAudioSnapshot.playback
      : null;
    const mediaId = assistantAudioMediaIdentity(message, entry);
    const invalidMedia = Boolean((message.mediaId || entry?.mediaId) && !mediaId);
    control.dataset.mediaId = mediaId ?? '';
    button.dataset.messageId = messageId;
    button.disabled = false;
    button.setAttribute('aria-pressed', String(playback?.state === 'playing'));

    if (invalidMedia) {
      button.textContent = 'Voice unavailable';
      button.setAttribute('aria-label', 'AI-generated voice is unavailable for this answer');
      button.disabled = true;
      status.textContent = 'Audio could not continue safely. The text answer is still available.';
    } else if (playback?.state === 'playing') {
      button.textContent = 'Pause voice';
      button.setAttribute('aria-label', 'Pause the AI-generated voice for this answer');
      status.textContent = playback.statusText;
    } else if (entry?.state === 'pending' || entry?.state === 'generating') {
      button.textContent = 'Preparing AI voice…';
      button.setAttribute('aria-label', 'AI-generated voice is being prepared');
      button.disabled = true;
      status.textContent = 'The text answer is ready.';
    } else if (mediaId) {
      button.textContent = playback?.state === 'paused' ? 'Resume voice' : 'Play voice';
      button.setAttribute('aria-label', `${button.textContent} for this answer`);
      status.textContent = playback?.statusText || 'AI voice ready';
    } else if (entry?.state === 'retryable') {
      const retryPending = Number.isFinite(entry.retryNotBefore) && Date.now() < entry.retryNotBefore;
      if (retryPending) nextRetryAt = Math.min(nextRetryAt ?? entry.retryNotBefore, entry.retryNotBefore);
      button.textContent = retryPending ? 'Wait to retry' : 'Retry voice';
      button.setAttribute('aria-label', retryPending
        ? 'Wait before retrying the AI-generated voice'
        : 'Retry generating an AI voice for this answer');
      button.disabled = retryPending;
      status.textContent = entry.statusText;
    } else if (entry?.state === 'failed') {
      button.textContent = 'Voice unavailable';
      button.setAttribute('aria-label', 'AI-generated voice is unavailable for this answer');
      button.disabled = true;
      status.textContent = entry.statusText;
    } else if (entry?.state === 'missing') {
      button.textContent = 'Generate voice';
      button.setAttribute('aria-label', 'Generate an AI voice for this answer');
      status.textContent = 'AI voice was not prepared. The text answer is ready.';
    } else if (message?.replyMode === 'voice') {
      button.textContent = 'Preparing AI voice…';
      button.setAttribute('aria-label', 'AI-generated voice is being prepared');
      button.disabled = true;
      status.textContent = 'The text answer is ready.';
    } else {
      button.textContent = 'Generate voice';
      button.setAttribute('aria-label', 'Generate an optional AI voice for this answer');
      status.textContent = '';
    }
  }
  if (assistantAudioRetryTimer && assistantAudioRetryAt !== nextRetryAt) {
    clearTimeout(assistantAudioRetryTimer);
    assistantAudioRetryTimer = null;
    assistantAudioRetryAt = null;
  }
  if (!assistantAudioRetryTimer && Number.isFinite(nextRetryAt)) {
    assistantAudioRetryAt = nextRetryAt;
    assistantAudioRetryTimer = setTimeout(() => {
      assistantAudioRetryTimer = null;
      assistantAudioRetryAt = null;
      renderAssistantAudioControls();
    }, Math.max(1, nextRetryAt - Date.now()));
  }
}

function prepareAssistantVoiceReplies(messages = latestSnapshot?.messages ?? []) {
  if (!assistantAudioController || assistantAudioScope !== latestSnapshot?.clientSessionScope) return;
  const entries = latestAssistantAudioSnapshot?.entries ?? {};
  for (const message of assistantVoiceMessagesToPrepare(messages, entries)) {
    void assistantAudioController.prepare(message).catch(() => undefined);
  }
}

function disposeAssistantAudioRuntime() {
  if (assistantAudioRetryTimer) clearTimeout(assistantAudioRetryTimer);
  assistantAudioRetryTimer = null;
  assistantAudioRetryAt = null;
  assistantAudioController?.dispose();
  assistantAudioController = null;
  assistantAudioScope = null;
  latestAssistantAudioSnapshot = null;
  renderAssistantAudioControls();
}

function syncAssistantAudioScope(snapshot) {
  const targetScope = snapshot?.ready
    && assistantAudioAvailable(snapshot)
    && typeof window.Audio === 'function'
    ? snapshot.clientSessionScope
    : null;
  if (assistantAudioController && assistantAudioScope === targetScope) return;
  disposeAssistantAudioRuntime();
  if (!targetScope) return;
  try {
    assistantAudioScope = targetScope;
    assistantAudioController = createAssistantAudioController({
      AudioClass: window.Audio,
      origin: window.location.origin,
      onChange: (next) => {
        if (assistantAudioScope !== targetScope) return;
        latestAssistantAudioSnapshot = next;
        renderAssistantAudioControls();
      },
    });
    latestAssistantAudioSnapshot = assistantAudioController.snapshot();
  } catch {
    assistantAudioController = null;
    assistantAudioScope = null;
    latestAssistantAudioSnapshot = null;
  }
}

function voiceConsentKey(scope) {
  return `hk-buddy:v1:${scope}:voice-consent`;
}

function savedVoiceConsent(scope) {
  try { return window.sessionStorage.getItem(voiceConsentKey(scope)) === 'granted'; } catch { return false; }
}

function saveVoiceConsent(scope) {
  try { window.sessionStorage.setItem(voiceConsentKey(scope), 'granted'); } catch { /* consent remains in memory */ }
}

function voiceIdentity(runtime = voiceRuntime) {
  return Object.freeze({ runtime, epoch: voiceRuntimeEpoch, scope: runtime?.scope ?? null });
}

function currentVoiceIdentity(identity) {
  return Boolean(
    identity?.runtime
      && voiceRuntime === identity.runtime
      && voiceRuntimeEpoch === identity.epoch
      && latestSnapshot?.clientSessionScope === identity.scope,
  );
}

function voiceStatusCopy(snapshot) {
  const phase = snapshot?.phase;
  if (phase === 'permission-checking') return 'Checking microphone access…';
  if (phase === 'starting') return 'Starting microphone…';
  if (phase === 'recording') return 'Listening… Release to create a transcript.';
  if (phase === 'saving') return 'Preparing your voice message…';
  if (phase === 'processing') return 'Transcribing your voice message…';
  if (phase === 'binding' || phase === 'sending') return 'Voice message · Sending…';
  if (phase === 'accepted-cleanup-pending') return 'Message accepted · Cleaning local voice draft';
  if (phase === 'send-unconfirmed') return 'Voice message · Send not confirmed';
  if (phase === 'send-rate-limited') return 'Voice message · Wait to retry';
  if (phase === 'transcription-retryable') return 'Voice message saved · Retry needed';
  if (phase === 'removing') return 'Removing voice message…';
  if (phase === 'suspended') return 'Voice paused when the page became inactive.';
  if (phase === 'error') return snapshot?.error?.copy ?? 'Voice input could not continue.';
  return 'Voice draft · Not sent';
}

function adoptVoiceDraft(snapshot) {
  const draft = snapshot?.draft;
  if (!draft) {
    presentedVoiceDraftId = null;
    return;
  }
  if (presentedVoiceDraftId === draft.voiceDraftId) return;
  presentedVoiceDraftId = draft.voiceDraftId;
  if (snapshot?.phase === 'accepted-cleanup-pending') {
    const resolution = acceptedVoiceComposerDraft({
      phase: snapshot.phase,
      bindingText: snapshot.binding?.text,
      composerDraft: latestSnapshot?.draft,
    });
    if (resolution.shouldApply) {
      chatController.setDraft(resolution.draft);
      messageInput.value = resolution.draft;
      resizeComposer();
    }
    return;
  }
  const savedText = latestSnapshot?.draft ?? '';
  if (savedText.trim() && savedText !== draft.text) {
    try { voiceRuntime?.controller.setDraft(savedText); } catch { /* a later render keeps canonical draft */ }
    return;
  }
  chatController.setDraft(draft.text);
  messageInput.value = draft.text;
  resizeComposer();
}

function renderVoiceControls() {
  const snapshot = latestVoiceSnapshot;
  const sameScope = Boolean(
    snapshot
      && latestSnapshot?.ready
      && snapshot.clientSessionScope === latestSnapshot.clientSessionScope,
  );
  const available = voiceAvailable() && sameScope && !snapshot?.disposed;
  const phase = available ? snapshot.phase : null;
  const hasVoiceDraft = Boolean(available && snapshot.draft);
  const hasVoiceOperation = Boolean(available && snapshot.operation);
  const hasVoiceArtifact = hasVoiceDraft || hasVoiceOperation;
  const retainedOperation = Boolean(hasVoiceOperation && !hasVoiceDraft && VOICE_RETAINED_PHASES.has(phase));
  const live = Boolean(available && (VOICE_BUSY_PHASES.has(phase) || retainedOperation));
  const sendInProgress = latestSnapshot?.messages?.some((message) => message.sendState === 'sending');
  const hasTextDraft = Boolean(latestSnapshot?.draft?.trim());
  const boundDraft = currentReplyTupleIsFixed({ voiceSnapshot: snapshot });
  const acceptedCleanupPending = phase === 'accepted-cleanup-pending';
  const explicitlyRejected = phase === 'error' && snapshot?.error?.code === 'VOICE_SEND_REJECTED';

  voiceButton.hidden = !voiceAvailable();
  composerPanel.dataset.voiceAvailable = String(voiceAvailable());

  voiceDraft.hidden = !hasVoiceDraft;
  if (hasVoiceDraft) {
    voiceDraftState.textContent = voiceStatusCopy(snapshot);
    voiceDraftHelp.textContent = acceptedCleanupPending
      ? 'Your message was sent. Retry only finishes local cleanup; it never sends the message again.'
      : explicitlyRejected
        ? 'The message was not accepted. Remove this voice draft to continue.'
        : boundDraft
          ? 'Use Retry on the message. Its voice identity is fixed.'
          : 'Review the transcript in the chat box, then tap Send.';
    removeVoiceDraft.hidden = acceptedCleanupPending;
    removeVoiceDraft.disabled = acceptedCleanupPending || ['binding', 'removing', 'sending'].includes(phase);
    retryVoiceCleanupButton.hidden = !acceptedCleanupPending;
    retryVoiceCleanupButton.disabled = !acceptedCleanupPending;
  } else {
    removeVoiceDraft.hidden = false;
    removeVoiceDraft.disabled = true;
    retryVoiceCleanupButton.hidden = true;
    retryVoiceCleanupButton.disabled = true;
  }

  voiceLive.hidden = !live;
  if (live) {
    voiceHint.textContent = voiceStatusCopy(snapshot);
    const canCancelCapture = VOICE_CAPTURE_CANCEL_PHASES.has(phase);
    const canRemoveOperation = Boolean(hasVoiceOperation && VOICE_RETAINED_PHASES.has(phase));
    retryVoiceTranscriptionButton.hidden = phase !== 'transcription-retryable';
    retryVoiceTranscriptionButton.disabled = phase !== 'transcription-retryable';
    cancelVoiceButton.hidden = !(canCancelCapture || canRemoveOperation);
    cancelVoiceButton.disabled = !(canCancelCapture || canRemoveOperation);
    cancelVoiceButton.textContent = canRemoveOperation ? 'Remove voice' : 'Cancel';
  } else {
    voiceHint.textContent = 'Hold while speaking, or press once to start and again to stop. Your recording becomes an editable transcript.';
    retryVoiceTranscriptionButton.hidden = true;
    retryVoiceTranscriptionButton.disabled = true;
    cancelVoiceButton.hidden = true;
    cancelVoiceButton.disabled = true;
    cancelVoiceButton.textContent = 'Cancel';
  }

  voiceButton.dataset.serverAvailable = String(voiceAvailable());
  voiceButton.dataset.voicePhase = phase ?? 'unavailable';
  voiceButton.setAttribute('aria-pressed', String(phase === 'recording' || phase === 'starting'));
  if (!voiceAvailable()) {
    voiceButton.textContent = 'Voice unavailable';
    voiceButton.setAttribute('aria-label', 'Voice input is unavailable in this build');
    voiceButton.disabled = true;
  } else if (!latestSnapshot?.ready || !sameScope || voiceSetupFailed) {
    voiceButton.textContent = voiceSetupFailed ? 'Retry voice setup' : 'Getting voice ready';
    voiceButton.setAttribute('aria-label', voiceButton.textContent);
    voiceButton.disabled = !voiceSetupFailed;
  } else if (phase === 'recording' || phase === 'starting') {
    voiceButton.textContent = 'Release to transcribe';
    voiceButton.setAttribute('aria-label', keyboardRecording
      ? 'Press to stop and transcribe this voice message'
      : 'Release to finish this voice message');
    voiceButton.disabled = false;
  } else if (snapshot.consent !== 'granted' || snapshot.permission !== 'ready') {
    voiceButton.textContent = 'Enable voice';
    voiceButton.setAttribute('aria-label', 'Enable optional voice messages');
    voiceButton.disabled = false;
  } else if (hasVoiceArtifact) {
    voiceButton.textContent = phase === 'transcription-retryable' ? 'Voice saved' : 'Voice draft';
    voiceButton.setAttribute('aria-label', phase === 'transcription-retryable'
      ? 'Retry or remove the saved voice message'
      : 'Review or remove the current voice draft');
    voiceButton.disabled = true;
  } else if (VOICE_BUSY_PHASES.has(phase) || phase === 'suspended' || phase === 'disposed') {
    voiceButton.textContent = phase === 'suspended' ? 'Voice paused' : 'Please wait';
    voiceButton.setAttribute('aria-label', voiceButton.textContent);
    voiceButton.disabled = true;
  } else if (hasTextDraft) {
    voiceButton.textContent = 'Voice';
    voiceButton.setAttribute('aria-label', 'Clear the typed message before recording a voice message');
    voiceButton.disabled = true;
  } else {
    voiceButton.textContent = 'Hold to speak';
    voiceButton.setAttribute('aria-label', 'Press or hold to record a voice message');
    voiceButton.disabled = false;
  }

  const voiceBlocksEditing = Boolean(available && VOICE_BUSY_PHASES.has(phase));
  messageInput.disabled = !latestSnapshot?.ready || voiceBlocksEditing;
  sendButton.disabled = !latestSnapshot?.ready
    || !latestSnapshot.draft.trim()
    || sendInProgress
    || voiceBlocksEditing
    || boundDraft;
  for (const prompt of starterPrompts) {
    prompt.disabled = !latestSnapshot?.ready || sendInProgress || voiceBlocksEditing || hasVoiceDraft;
  }
  renderReplyExperience();
}

function renderVoice(snapshot) {
  if (!voiceRuntime) return;
  latestVoiceSnapshot = snapshot;
  adoptVoiceDraft(snapshot);
  if (snapshot.error?.copy) setFeedback(snapshot.error.copy);
  renderVoiceControls();
}

async function disposeVoiceRuntime(reason = 'pagehide') {
  const runtime = voiceRuntime;
  if (!runtime) return;
  voiceRuntime = null;
  voiceRuntimeEpoch += 1;
  activePointerId = null;
  keyboardRecording = false;
  voiceHoldFence.invalidate();
  latestVoiceSnapshot = null;
  presentedVoiceDraftId = null;
  try { await Promise.resolve(runtime.controller.cancel(reason)); } catch { /* lifecycle fencing continues */ }
  try { runtime.controller.dispose(); } catch { /* lifecycle fencing continues */ }
  try { await runtime.store.dispose(); } catch { /* IndexedDB closure is best effort */ }
  renderVoiceControls();
}

async function buildVoiceRuntime(scope) {
  const runtimeEpoch = ++voiceRuntimeEpoch;
  const store = createVoiceUploadStore();
  const capture = createVoiceCapture();
  const transport = createVoiceTransport({ origin: window.location.origin });
  const coordinator = createVoiceUploadCoordinator({ store, transport });
  let runtime;
  const controller = createVoiceMessageController({
    capture,
    store,
    coordinator,
    chat: chatController,
    onChange: (snapshot) => {
      if (voiceRuntime === runtime && runtimeEpoch === voiceRuntimeEpoch) renderVoice(snapshot);
    },
  });
  runtime = { capture, controller, coordinator, scope, store, transport };
  voiceRuntime = runtime;
  if (savedVoiceConsent(scope)) controller.confirmConsent();
  try {
    await controller.resume({ clientSessionScope: scope });
  } catch (error) {
    if (voiceRuntime === runtime) {
      voiceSetupFailed = true;
      setFeedback(safeVoiceCopy(error, 'Saved voice work could not be restored. Text chat is still available.'));
      voiceRuntime = null;
      voiceRuntimeEpoch += 1;
      latestVoiceSnapshot = null;
      try { controller.dispose(); } catch { /* failed setup is fenced */ }
      try { await store.dispose(); } catch { /* failed setup is fenced */ }
      renderVoiceControls();
    }
    return;
  }
  if (voiceRuntime !== runtime || runtimeEpoch !== voiceRuntimeEpoch || desiredVoiceScope !== scope) {
    try { controller.dispose(); } catch { /* stale runtime is fenced */ }
    try { await store.dispose(); } catch { /* stale runtime is fenced */ }
    return;
  }
  latestVoiceSnapshot = controller.snapshot();
  renderVoice(latestVoiceSnapshot);
}

function scheduleVoiceScope(snapshot = latestSnapshot) {
  if (clearInProgress) return;
  const target = snapshot?.ready && voiceAvailable(snapshot) ? snapshot.clientSessionScope : null;
  if (target === desiredVoiceScope) {
    if (target && voiceRuntime?.scope === target) {
      void voiceRuntime.controller.reconcileChatSnapshot(snapshot).catch(() => undefined);
    }
    return;
  }
  desiredVoiceScope = target;
  voiceSetupFailed = false;
  voiceSyncPromise = voiceSyncPromise.then(async () => {
    if (voiceRuntime?.scope !== desiredVoiceScope) await disposeVoiceRuntime('pagehide');
    if (desiredVoiceScope && !voiceRuntime) await buildVoiceRuntime(desiredVoiceScope);
  }).catch(() => {
    voiceSetupFailed = true;
    setFeedback('Voice setup could not finish. Text chat is still available.');
    renderVoiceControls();
  });
}

function replyTupleIsAlreadyBound() {
  return currentReplyTupleIsFixed({
    voiceSnapshot: latestVoiceSnapshot,
    messages: latestSnapshot?.messages,
  });
}

function renderReplyExperience(snapshot = latestSnapshot) {
  const replyLanguage = snapshot?.replyLanguage ?? 'en';
  const replyMode = snapshot?.replyMode ?? 'text';
  const copy = chatExperienceCopy(replyLanguage);
  welcomeMessage.textContent = copy.welcome;
  welcomeMessage.setAttribute('lang', copy.documentLanguage);
  welcomeDisclosure.textContent = copy.disclosure;
  welcomeDisclosure.setAttribute('lang', copy.documentLanguage);
  messageInput.placeholder = copy.placeholder;
  replyPreferenceValue.textContent = replyPreferenceLabel({ replyLanguage, replyMode });
  replyPreferencesTrigger.disabled = !snapshot?.ready;
  replyPreferenceNote.textContent = replyTupleIsAlreadyBound()
    ? 'Your current send or voice draft keeps its original reply setting.'
    : 'Applies to your next message';
  starterPrompts.forEach((prompt, index) => {
    const localized = copy.starterPrompts[index];
    if (!localized) return;
    prompt.textContent = localized;
    prompt.dataset.prompt = localized;
    prompt.lang = copy.documentLanguage;
  });
}

function render(snapshot) {
  const shouldStick = !latestSnapshot || atBottom();
  latestSnapshot = snapshot;
  syncAssistantAudioScope(snapshot);
  shell.dataset.appState = snapshot.ready ? 'ready' : 'loading';
  messageFeed.setAttribute('aria-busy', 'true');

  reconcileMessageFeed(messageFeed, snapshot.messages, (message, { isLatestAssistant }) => (
    createMessageElement(document, message, { isLatestAssistant, onRetry: retryUnconfirmed })
  ));
  welcome.hidden = snapshot.messages.length > 0;
  messageFeed.setAttribute('aria-busy', 'false');
  renderAssistantAudioControls();
  prepareAssistantVoiceReplies(snapshot.messages);

  turnStatus.textContent = turnStatusMessage(snapshot.activeTurn);
  const connectionText = connectionCopy(snapshot.connection);
  connectionStatus.textContent = connectionText;
  connectionStatus.hidden = !connectionText;
  knowledgeSnapshotDate.textContent = formatFreshness(snapshot.knowledgeSnapshotDate);
  if (snapshot.knowledgeSnapshotDate) knowledgeSnapshotDate.dateTime = snapshot.knowledgeSnapshotDate;
  else knowledgeSnapshotDate.removeAttribute('datetime');
  renderReplyExperience(snapshot);

  if (shouldSyncDraft(messageInput.value, snapshot.draft)) {
    messageInput.value = snapshot.draft;
    resizeComposer();
  }
  scheduleVoiceScope(snapshot);
  renderVoiceControls();
  feedback.textContent = uiFeedback;
  if (shouldStick) scrollToLatest();
}

const chatController = createChatController({
  storage: window.sessionStorage,
  onChange: render,
});

function showReplyPreferences() {
  const snapshot = chatController.snapshot();
  for (const input of replyPreferencesForm.querySelectorAll('[name="reply-language"]')) {
    input.checked = input.value === snapshot.replyLanguage;
  }
  for (const input of replyPreferencesForm.querySelectorAll('[name="reply-mode"]')) {
    input.checked = input.value === snapshot.replyMode;
  }
  replyPreferencesTrigger.setAttribute('aria-expanded', 'true');
  if (!replyPreferences.open) replyPreferences.showModal();
}

async function sendText(text) {
  const normalized = text.trim();
  if (!normalized || !latestSnapshot?.ready) return;
  setFeedback('');
  try {
    if (latestVoiceSnapshot?.draft && voiceRuntime) {
      voiceRuntime.controller.setDraft(normalized);
      await voiceRuntime.controller.sendDraft({
        clientMessageId: window.crypto.randomUUID(),
        text: normalized,
      });
      return;
    }
    await chatController.sendText(normalized);
  } catch (error) {
    setFeedback(error?.textSafe === true ? safeVoiceCopy(error) : sendErrorCopy(error));
  }
}

async function retryUnconfirmed(clientMessageId) {
  setFeedback('');
  try {
    if (voiceRuntime && latestVoiceSnapshot?.binding?.clientMessageId === clientMessageId) {
      await voiceRuntime.controller.retrySend();
      return;
    }
    const retrying = chatController.retryUnconfirmed(clientMessageId);
    if (retrying === false) {
      setFeedback('This accepted question cannot be resent. Start a new message if you want to try again.');
      return;
    }
    await retrying;
  } catch (error) {
    setFeedback(error?.textSafe === true ? safeVoiceCopy(error) : sendErrorCopy(error));
  }
}

function usePrompt(text) {
  chatController.setDraft(text);
  messageInput.value = text;
  resizeComposer();
  void sendText(text);
}

function showVoiceConsent() {
  if (!voiceConsent.open) voiceConsent.showModal();
}

async function enableVoiceFromGesture() {
  if (!voiceRuntime) return false;
  const identity = voiceIdentity();
  const snapshot = identity.runtime.controller.snapshot();
  if (snapshot.consent !== 'granted') {
    showVoiceConsent();
    return false;
  }
  if (snapshot.permission !== 'ready') {
    setFeedback('');
    try {
      const result = await guardedVoicePreflight({
        runtime: identity.runtime,
        isCurrent: () => currentVoiceIdentity(identity),
      });
      if (result.state === 'ready' && currentVoiceIdentity(identity)) {
        setFeedback('Microphone ready. Hold the voice button when you want to speak.');
      }
    } catch (error) {
      if (currentVoiceIdentity(identity)) setFeedback(safeVoiceCopy(error));
    }
    return false;
  }
  return true;
}

function observeHold(handle, { identity, token }) {
  void handle.started.catch((error) => {
    if (currentVoiceIdentity(identity) && voiceHoldFence.isCurrent(token)) {
      setFeedback(safeVoiceCopy(error));
    }
  });
  void handle.completion.catch((error) => {
    if (currentVoiceIdentity(identity) && voiceHoldFence.isCurrent(token)) {
      setFeedback(safeVoiceCopy(error));
    }
  }).finally(() => {
    if (!currentVoiceIdentity(identity) || !voiceHoldFence.clear(token)) return;
    keyboardRecording = false;
    if (activePointerId !== null) {
      const pointerId = activePointerId;
      activePointerId = null;
      try {
        if (voiceButton.hasPointerCapture?.(pointerId)) voiceButton.releasePointerCapture(pointerId);
      } catch { /* capture may already be gone */ }
    }
  });
}

function beginVoiceHold() {
  const identity = voiceIdentity();
  if (!currentVoiceIdentity(identity)) return false;
  const token = voiceHoldFence.begin();
  try {
    const handle = identity.runtime.controller.beginHold();
    observeHold(handle, { identity, token });
    return true;
  } catch (error) {
    voiceHoldFence.clear(token);
    setFeedback(safeVoiceCopy(error));
    return false;
  }
}

function finishVoiceHold() {
  if (!voiceRuntime) return;
  let completion;
  try {
    completion = voiceRuntime.controller.finishHold();
  } catch (error) {
    setFeedback(safeVoiceCopy(error));
    return;
  }
  void Promise.resolve(completion).catch((error) => setFeedback(safeVoiceCopy(error)));
}

function cancelVoiceInteraction(reason) {
  const runtime = voiceRuntime;
  voiceHoldFence.invalidate();
  keyboardRecording = false;
  const pointerId = activePointerId;
  activePointerId = null;
  let phase = null;
  try { phase = runtime?.controller.snapshot()?.phase ?? null; } catch { /* a replaced runtime is not cancellable */ }
  if (runtime && voicePhaseCanCancelInteraction(phase)) {
    try {
      const cancelled = runtime.controller.cancel(reason);
      void Promise.resolve(cancelled).catch(() => undefined);
    } catch (error) {
      setFeedback(safeVoiceCopy(error));
    }
  }
  try {
    if (pointerId !== null && voiceButton.hasPointerCapture?.(pointerId)) {
      voiceButton.releasePointerCapture(pointerId);
    }
  } catch { /* capture may already be gone */ }
}

async function toggleVoiceRecording() {
  if (voiceSetupFailed) {
    desiredVoiceScope = undefined;
    scheduleVoiceScope(latestSnapshot);
    return;
  }
  if (keyboardRecording) {
    keyboardRecording = false;
    finishVoiceHold();
    renderVoiceControls();
    return;
  }
  if (!(await enableVoiceFromGesture())) return;
  keyboardRecording = beginVoiceHold();
  renderVoiceControls();
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendText(messageInput.value);
});

replyPreferencesTrigger.addEventListener('click', () => {
  cancelVoiceInteraction('visible-cancel');
  showReplyPreferences();
});

replyPreferencesForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(replyPreferencesForm);
  try {
    chatController.setReplyPreferences({
      replyLanguage: formData.get('reply-language'),
      replyMode: formData.get('reply-mode'),
    });
    setFeedback('');
    replyPreferences.close('saved');
  } catch {
    setFeedback('Reply settings could not be changed.');
  }
});

cancelReplyPreferences.addEventListener('click', () => replyPreferences.close('cancel'));
replyPreferences.addEventListener('cancel', (event) => {
  event.preventDefault();
  replyPreferences.close('cancel');
});
replyPreferences.addEventListener('close', () => {
  replyPreferencesTrigger.setAttribute('aria-expanded', 'false');
  replyPreferencesTrigger.focus();
});
replyPreferences.addEventListener('click', (event) => {
  if (event.target === replyPreferences) replyPreferences.close('cancel');
});

messageInput.addEventListener('input', () => {
  chatController.setDraft(messageInput.value);
  if (latestVoiceSnapshot?.draft && voiceRuntime) {
    try { voiceRuntime.controller.setDraft(messageInput.value); } catch { /* canonical state remains authoritative */ }
  }
  resizeComposer();
});

messageInput.addEventListener('keydown', (event) => {
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (!shouldSubmitOnEnter(event, finePointer)) return;
  event.preventDefault();
  void sendText(messageInput.value);
});

voiceButton.addEventListener('pointerdown', (event) => {
  if (event.button !== undefined && event.button !== 0) return;
  voiceActivationGate.markDirectActivation();
  event.preventDefault();
  void (async () => {
    if (voiceSetupFailed) {
      desiredVoiceScope = undefined;
      scheduleVoiceScope(latestSnapshot);
      return;
    }
    if (!(await enableVoiceFromGesture()) || activePointerId !== null) return;
    activePointerId = event.pointerId;
    try { voiceButton.setPointerCapture(event.pointerId); } catch { /* pointer lifecycle handlers still fence work */ }
    if (!beginVoiceHold()) activePointerId = null;
  })();
});

voiceButton.addEventListener('pointerup', (event) => {
  voiceActivationGate.markDirectActivation();
  if (activePointerId !== event.pointerId) return;
  event.preventDefault();
  finishVoiceHold();
  const pointerId = activePointerId;
  activePointerId = null;
  try {
    if (voiceButton.hasPointerCapture?.(pointerId)) voiceButton.releasePointerCapture(pointerId);
  } catch { /* normal release may already have dropped capture */ }
});

voiceButton.addEventListener('pointercancel', (event) => {
  if (activePointerId === event.pointerId) cancelVoiceInteraction('pointercancel');
});

voiceButton.addEventListener('lostpointercapture', (event) => {
  if (activePointerId === event.pointerId) cancelVoiceInteraction('lostpointercapture');
});

voiceButton.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key) || event.repeat) return;
  voiceActivationGate.markDirectActivation();
  event.preventDefault();
  void toggleVoiceRecording();
});

voiceButton.addEventListener('keyup', (event) => {
  if (['Enter', ' '].includes(event.key)) voiceActivationGate.markDirectActivation();
});

voiceButton.addEventListener('click', (event) => {
  if (!voiceActivationGate.shouldHandleClick()) return;
  event.preventDefault();
  void toggleVoiceRecording();
});

cancelVoiceButton.addEventListener('click', async () => {
  const phase = latestVoiceSnapshot?.phase;
  if (phase === 'processing' && voiceRuntime) {
    setFeedback('');
    try {
      await voiceRuntime.controller.remove();
    } catch (error) {
      setFeedback(safeVoiceCopy(error));
    }
    return;
  }
  if (VOICE_RETAINED_PHASES.has(phase) && latestVoiceSnapshot?.operation && voiceRuntime) {
    setFeedback('');
    try {
      await voiceRuntime.controller.remove();
    } catch (error) {
      setFeedback(safeVoiceCopy(error));
    }
    return;
  }
  cancelVoiceInteraction('visible-cancel');
});

retryVoiceTranscriptionButton.addEventListener('click', async () => {
  if (!voiceRuntime || latestVoiceSnapshot?.phase !== 'transcription-retryable') return;
  setFeedback('');
  try {
    await voiceRuntime.controller.retryTranscription();
  } catch (error) {
    setFeedback(safeVoiceCopy(error));
  }
});

removeVoiceDraft.addEventListener('click', async () => {
  if (!voiceRuntime) return;
  const identity = voiceIdentity();
  const preservedText = messageInput.value;
  const bindingText = identity.runtime.controller.snapshot()?.binding?.text ?? null;
  setFeedback('');
  try {
    const outcome = await guardedVoiceRemove({
      runtime: identity.runtime,
      isCurrent: () => currentVoiceIdentity(identity),
      preservedText,
      bindingText,
    });
    if (outcome.apply) chatController.setDraft(outcome.draft);
  } catch (error) {
    if (currentVoiceIdentity(identity)) setFeedback(safeVoiceCopy(error));
  }
});

retryVoiceCleanupButton.addEventListener('click', async () => {
  const identity = voiceIdentity();
  if (!currentVoiceIdentity(identity)
    || identity.runtime.controller.snapshot().phase !== 'accepted-cleanup-pending') return;
  setFeedback('');
  try {
    await identity.runtime.controller.retryAcceptedCleanup();
  } catch (error) {
    if (currentVoiceIdentity(identity)) setFeedback(safeVoiceCopy(error));
  }
});

voiceConsentContinue.addEventListener('click', async () => {
  if (!voiceRuntime) return;
  const identity = voiceIdentity();
  identity.runtime.controller.confirmConsent();
  saveVoiceConsent(identity.scope);
  voiceConsentContinue.disabled = true;
  setFeedback('');
  try {
    const result = await guardedVoicePreflight({
      runtime: identity.runtime,
      isCurrent: () => currentVoiceIdentity(identity),
    });
    if (voiceConsent.open) voiceConsent.close();
    if (result.state === 'ready' && currentVoiceIdentity(identity)) {
      setFeedback('Microphone ready. Hold the voice button when you want to speak.');
    }
  } catch (error) {
    if (voiceConsent.open) voiceConsent.close();
    if (currentVoiceIdentity(identity)) setFeedback(safeVoiceCopy(error));
  } finally {
    voiceConsentContinue.disabled = false;
  }
});

voiceConsentCancel.addEventListener('click', () => {
  cancelVoiceInteraction('visible-cancel');
  voiceConsent.close();
});
voiceConsent.addEventListener('cancel', (event) => {
  event.preventDefault();
  cancelVoiceInteraction('escape');
  voiceConsent.close();
});
voiceConsent.addEventListener('close', () => voiceButton.focus());
voiceConsent.addEventListener('click', (event) => {
  if (event.target === voiceConsent) {
    cancelVoiceInteraction('visible-cancel');
    voiceConsent.close();
  }
});

for (const prompt of starterPrompts) {
  prompt.addEventListener('click', () => usePrompt(prompt.dataset.prompt || prompt.textContent));
}

messageFeed.addEventListener('click', (event) => {
  const audioButton = event.target.closest?.('.assistant-audio-button[data-message-id]');
  if (audioButton) {
    const messageId = audioButton.dataset.messageId;
    const message = latestSnapshot?.messages?.find((item) => item.id === messageId);
    if (!assistantAudioController || message?.role !== 'assistant' || message?.status !== 'delivered') return;
    void performAssistantAudioAction({
      controller: assistantAudioController,
      message,
      snapshot: latestAssistantAudioSnapshot,
    }).then((result) => {
      if (result?.state === 'error' || result?.state === 'invalid') setFeedback(result.statusText);
      renderAssistantAudioControls();
    }).catch(() => setFeedback('Audio could not continue safely. The text answer is still available.'));
    return;
  }
  const prompt = event.target.closest?.('.suggested-reply[data-prompt]');
  if (prompt) usePrompt(prompt.dataset.prompt);
});

infoButton.addEventListener('click', () => {
  cancelVoiceInteraction('visible-cancel');
  clearStatus.textContent = '';
  infoSheet.showModal();
  infoButton.setAttribute('aria-expanded', 'true');
});

closeButton.addEventListener('click', () => infoSheet.close());
infoSheet.addEventListener('close', () => infoButton.setAttribute('aria-expanded', 'false'));
infoSheet.addEventListener('click', (event) => {
  if (event.target === infoSheet) infoSheet.close();
});

function resetClearConfirmation({ preserveStatus = false } = {}) {
  clearArmed = false;
  clearButton.disabled = false;
  clearButton.textContent = 'Clear conversation';
  if (!preserveStatus) clearStatus.textContent = '';
  if (clearConfirmationTimer) clearTimeout(clearConfirmationTimer);
  clearConfirmationTimer = null;
}

clearButton.addEventListener('click', async () => {
  if (!clearArmed) {
    await chatController.clearSession({ confirmed: false });
    clearArmed = true;
    clearButton.textContent = 'Tap again to clear';
    clearStatus.textContent = 'Tap again to confirm. This revokes the current guest conversation.';
    clearConfirmationTimer = setTimeout(resetClearConfirmation, 5_000);
    return;
  }
  clearButton.disabled = true;
  setFeedback('');
  disposeAssistantAudioRuntime();
  clearInProgress = true;
  const runtimeAtClear = voiceRuntime;
  const oldScope = runtimeAtClear?.scope ?? latestSnapshot?.clientSessionScope ?? null;
  desiredVoiceScope = null;
  if (runtimeAtClear) {
    try { await Promise.resolve(runtimeAtClear.controller.cancel('pagehide')); } catch { /* the clear epoch remains authoritative */ }
  }
  try {
    const result = await chatController.clearSession({ confirmed: true });
    if (result?.deleted !== true) throw new Error('Conversation deletion was not confirmed.');
    let localCleanupError = null;
    try {
      await clearVoiceScopeAfterProvenDeletion({
        scope: oldScope,
        runtime: runtimeAtClear,
        createStore: createVoiceUploadStore,
      });
    } catch (error) {
      localCleanupError = error;
    }
    if (voiceRuntime === runtimeAtClear) await disposeVoiceRuntime('pagehide');
    clearInProgress = false;
    desiredVoiceScope = undefined;
    scheduleVoiceScope(chatController.snapshot());
    if (localCleanupError) {
      resetClearConfirmation({ preserveStatus: true });
      clearStatus.textContent = 'Conversation cleared, but this browser could not finish removing its saved voice draft. Reload before recording another voice message.';
    } else {
      resetClearConfirmation();
      infoSheet.close();
    }
  } catch (error) {
    let localCleanupFailed = false;
    if (error?.deleted === true) {
      try {
        await clearVoiceScopeAfterProvenDeletion({
          scope: oldScope,
          runtime: runtimeAtClear,
          createStore: createVoiceUploadStore,
        });
      } catch {
        localCleanupFailed = true;
      }
    }
    if (voiceRuntime === runtimeAtClear) await disposeVoiceRuntime('pagehide');
    clearInProgress = false;
    resetClearConfirmation({ preserveStatus: true });
    clearStatus.textContent = localCleanupFailed
      ? `${clearErrorCopy(error)} This browser also could not finish removing its saved voice draft.`
      : clearErrorCopy(error);
    desiredVoiceScope = undefined;
    scheduleVoiceScope(chatController.snapshot());
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') cancelVoiceInteraction('escape');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (assistantAudioController) assistantAudioController.handleHidden();
    desiredVoiceScope = null;
    void disposeVoiceRuntime('hidden');
    return;
  }
  if (latestSnapshot?.ready) {
    void chatController.refresh().catch(() => undefined);
    desiredVoiceScope = undefined;
    scheduleVoiceScope(latestSnapshot);
  }
});

window.addEventListener('pagehide', () => {
  disposeAssistantAudioRuntime();
  desiredVoiceScope = null;
  void disposeVoiceRuntime('pagehide');
  chatController.dispose();
}, { once: true });

window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});

const appShell = createAppShell({
  root: shell,
  tabButtons: [...document.querySelectorAll('#app-tabs [data-tab]')],
  views: {
    today: document.querySelector('#today-view'),
    campus: null,
    practice: document.querySelector('#practice-view'),
    translate: document.querySelector('#translate-view'),
  },
  campusNodes: [
    document.querySelector('#message-list'),
    document.querySelector('#turn-status'),
    document.querySelector('#composer'),
  ],
});
const todayView = createTodayView({
  greeting: document.querySelector('#today-greeting'),
  habitStatus: document.querySelector('#habit-status'),
  phraseText: document.querySelector('#phrase-of-day-text'),
});
const practiceView = createPracticeView({
  feed: document.querySelector('#practice-feed'),
  input: document.querySelector('#practice-input'),
  form: document.querySelector('#practice-composer'),
  correctButton: document.querySelector('#practice-correct'),
  modeButtons: [...document.querySelectorAll('#practice-mode-teaching, #practice-mode-freeChat')],
  scenario: document.querySelector('#practice-scenario'),
  status: document.querySelector('#practice-status'),
  onFirstDelivery: () => {
    markHabitPractised();
    todayView.render({ language: chatController.snapshot().replyLanguage });
  },
});
const visitView = createVisitView({
  form: document.querySelector('#visit-composer'),
  input: document.querySelector('#visit-input'),
  direction: document.querySelector('#visit-direction'),
  result: document.querySelector('#visit-result'),
  display: document.querySelector('#visit-display'),
  romanization: document.querySelector('#visit-romanization'),
  jobButtons: [...document.querySelectorAll('.visit-job')],
});
const phrasebookView = createPhrasebookView({
  list: document.querySelector('#phrasebook-list'),
  onPractise: (phrase) => {
    const input = document.querySelector('#practice-input');
    if (input) input.value = phrase.cantonese;
    appShell.show('practice');
  },
  onTranslate: (phrase) => {
    const input = document.querySelector('#visit-input');
    if (input) input.value = phrase.cantonese;
    appShell.show('translate');
  },
});
const consentController = createConsentController({
  dialog: document.querySelector('#ai-consent'),
  title: document.querySelector('#ai-consent-title'),
  copy: document.querySelector('#ai-consent-copy'),
  continueButton: document.querySelector('#ai-consent-continue'),
  leaveButton: document.querySelector('#ai-consent-leave'),
});
void visitView;
document.querySelector('#open-phrasebook')?.addEventListener('click', () => {
  phrasebookView.render();
  document.querySelector('#phrasebook-sheet')?.showModal?.();
});
document.querySelector('[data-close-sheet="phrasebook-sheet"]')?.addEventListener('click', () => {
  document.querySelector('#phrasebook-sheet')?.close?.();
});
for (const button of document.querySelectorAll('[data-go-tab]')) {
  button.addEventListener('click', () => appShell.show(button.dataset.goTab));
}
document.querySelector('#practise-phrase')?.addEventListener('click', () => appShell.show('practice'));
document.querySelector('#translate-phrase')?.addEventListener('click', () => appShell.show('translate'));
document.addEventListener('click', async (event) => {
  const button = event.target?.closest?.('.report-answer');
  if (!button?.dataset.messageId) return;
  await fetch('/api/v1/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: button.dataset.messageId,
      conversationKind: appShell.current() === 'practice' ? 'practice' : 'campus',
      reason: 'other',
    }),
  }).catch(() => undefined);
});

void chatController.start().then((snapshot) => {
  const language = snapshot?.replyLanguage ?? 'en';
  todayView.render({ language });
  phrasebookView.render();
  const notice = snapshot?.consent?.privacyNoticeVersion ?? snapshot?.capabilities?.privacyNoticeVersion;
  const aiDialog = document.querySelector('#ai-consent');
  if (aiDialog && notice) aiDialog.dataset.noticeVersion = notice;
  consentController.show({
    required: snapshot?.capabilities?.requireAiConsent === true,
    alreadyGranted: snapshot?.consent?.aiGranted === true,
    language,
  });
  if (consentController.hasLeft()) {
    connectionStatus.hidden = false;
    connectionStatus.textContent = chromeCopy(language).leaveOnly;
  }
  appShell.show('campus');
}).catch((error) => {
  const copy = startErrorCopy(error);
  connectionStatus.hidden = false;
  connectionStatus.textContent = copy;
});
