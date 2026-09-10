import {
  createOptimisticMessage,
  eventHint,
  markOptimisticFailed,
  normalizeReplyPreferences,
  reconcileTimeline,
  retryPayload,
} from './chat-state.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ROOT_SCOPE_KEY = 'hk-buddy:v1:scope';
const ROOT_CLIENT_INSTANCE_KEY = 'hk-buddy:v1:client-instance-id';
const MUTATING_EXISTING_MESSAGE_EVENTS = new Set(['turn.failed', 'audio.ready']);
const SSE_EVENTS = ['message.accepted', 'turn.state', 'message.delivered', 'turn.failed', 'audio.ready', 'resync_required'];

function scopedKey(scope, name) {
  return `hk-buddy:v1:${scope}:${name}`;
}

function maximumSequence(messages) {
  return messages.reduce((highest, message) => (
    Number.isSafeInteger(message?.sequence) ? Math.max(highest, message.sequence) : highest
  ), 0);
}

function canonicalMessages(messages = []) {
  return reconcileTimeline(messages, []).filter((message) => Number.isSafeInteger(message.sequence));
}

function mergeCanonical(current, incoming, replace = false) {
  if (replace) return canonicalMessages(incoming);
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming ?? []) {
    if (message?.id) byId.set(message.id, message);
  }
  return canonicalMessages([...byId.values()]);
}

function normalizeCapabilities(capabilities = {}) {
  return {
    ...capabilities,
    voiceInput: capabilities.voiceInput === true,
    voiceInputPreview: capabilities.voiceInputPreview === true,
    voiceOutput: capabilities.voiceOutput === true,
    voiceOutputPreview: capabilities.voiceOutputPreview === true,
  };
}

export function createChatController({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  EventSourceImpl = globalThis.EventSource,
  storage = globalThis.sessionStorage,
  uuid = () => globalThis.crypto.randomUUID(),
  clientInstanceUuid = () => globalThis.crypto.randomUUID(),
  now = () => new Date(),
  onChange = () => {},
  scheduleReconnect = (callback, delay = 1_500) => globalThis.setTimeout(callback, delay),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');

  const state = {
    ready: false,
    clientSessionScope: null,
    conversation: null,
    capabilities: normalizeCapabilities(),
    knowledgeSnapshotDate: null,
    consent: { privacyNoticeVersion: null, aiGranted: false, voiceGranted: false },
    canonicalMessages: [],
    optimisticMessages: [],
    activeTurn: null,
    lastMessageSequence: 0,
    eventCursor: 0,
    draft: '',
    replyLanguage: 'en',
    replyMode: 'text',
    connection: 'idle',
    disposed: false,
  };
  let sessionEpoch = 0;
  let eventCursorEpoch = 0;
  let eventSource = null;
  let refreshQueue = Promise.resolve();
  let inFlightClientIds = new Set();
  let sendBlockedUntil = 0;
  let sendRetryAfter = null;

  function beginSessionEpoch() {
    sessionEpoch += 1;
    eventCursorEpoch += 1;
    refreshQueue = Promise.resolve();
    inFlightClientIds = new Set();
    closeEvents();
    return sessionEpoch;
  }

  function isCurrentEpoch(epoch) {
    return !state.disposed && epoch === sessionEpoch;
  }

  function isCurrentSession(epoch, scope) {
    return isCurrentEpoch(epoch) && state.clientSessionScope === scope;
  }

  function storageGet(key) {
    try { return storage?.getItem?.(key) ?? null; } catch { return null; }
  }

  function storageSet(key, value) {
    try { storage?.setItem?.(key, String(value)); } catch { /* storage is best effort */ }
  }

  function storageRemove(key) {
    try { storage?.removeItem?.(key); } catch { /* storage is best effort */ }
  }

  function clientInstanceId() {
    const stored = storageGet(ROOT_CLIENT_INSTANCE_KEY);
    if (UUID.test(stored ?? '')) return stored.toLowerCase();
    if (stored !== null) storageRemove(ROOT_CLIENT_INSTANCE_KEY);
    const created = clientInstanceUuid();
    if (!UUID.test(created ?? '')) throw new Error('Client instance identity is unavailable.');
    const normalized = created.toLowerCase();
    storageSet(ROOT_CLIENT_INSTANCE_KEY, normalized);
    return normalized;
  }

  function snapshot() {
    return {
      ready: state.ready,
      clientSessionScope: state.clientSessionScope,
      conversation: state.conversation ? { ...state.conversation } : null,
      capabilities: { ...state.capabilities },
      knowledgeSnapshotDate: state.knowledgeSnapshotDate,
      consent: { ...state.consent },
      messages: reconcileTimeline(state.canonicalMessages, state.optimisticMessages).map((message) => ({ ...message })),
      activeTurn: state.activeTurn ? { ...state.activeTurn } : null,
      lastMessageSequence: state.lastMessageSequence,
      eventCursor: state.eventCursor,
      draft: state.draft,
      replyLanguage: state.replyLanguage,
      replyMode: state.replyMode,
      connection: state.connection,
    };
  }

  function notify() {
    onChange(snapshot());
  }

  async function requestJson(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(path, { credentials: 'same-origin', ...options });
    } catch (cause) {
      const error = new Error(cause?.message || 'The network request failed.');
      error.code = 'NETWORK_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    let body = null;
    try { body = await response.json(); } catch { /* normalized below */ }
    if (!response.ok || !body || body.error) {
      const error = new Error(body?.error?.message || 'The request could not be completed.');
      error.code = body?.error?.code || 'INVALID_RESPONSE';
      error.status = response.status;
      error.retryAfter = response.headers.get('Retry-After');
      throw error;
    }
    return body.data;
  }

  function persistCursor() {
    if (state.clientSessionScope) storageSet(scopedKey(state.clientSessionScope, 'event-cursor'), state.eventCursor);
  }

  function persistDraft() {
    if (!state.clientSessionScope) return;
    const key = scopedKey(state.clientSessionScope, 'draft');
    if (state.draft) storageSet(key, state.draft);
    else storageRemove(key);
  }

  function loadReplyPreferences(scope) {
    const key = scopedKey(scope, 'reply-preferences');
    const saved = storageGet(key);
    if (saved === null) return normalizeReplyPreferences();
    try {
      return normalizeReplyPreferences(JSON.parse(saved));
    } catch {
      storageRemove(key);
      return normalizeReplyPreferences();
    }
  }

  function persistReplyPreferences() {
    if (!state.clientSessionScope) return;
    storageSet(scopedKey(state.clientSessionScope, 'reply-preferences'), JSON.stringify({
      replyLanguage: state.replyLanguage,
      replyMode: state.replyMode,
    }));
  }

  function adoptScope(scope) {
    const previous = storageGet(ROOT_SCOPE_KEY);
    if (previous && previous !== scope) {
      storageRemove(scopedKey(previous, 'draft'));
      storageRemove(scopedKey(previous, 'event-cursor'));
      storageRemove(scopedKey(previous, 'reply-preferences'));
    }
    state.clientSessionScope = scope;
    storageSet(ROOT_SCOPE_KEY, scope);
    state.draft = storageGet(scopedKey(scope, 'draft')) ?? '';
    const savedCursor = Number(storageGet(scopedKey(scope, 'event-cursor')) ?? 0);
    state.eventCursor = Number.isSafeInteger(savedCursor) && savedCursor >= 0 ? savedCursor : 0;
    const preferences = loadReplyPreferences(scope);
    state.replyLanguage = preferences.replyLanguage;
    state.replyMode = preferences.replyMode;
  }

  function closeEvents() {
    eventSource?.close?.();
    eventSource = null;
  }

  function pruneCanonicallyAcceptedOptimistic() {
    const acceptedClientIds = new Set(state.canonicalMessages
      .map((message) => message.clientMessageId)
      .filter((clientMessageId) => typeof clientMessageId === 'string' && clientMessageId));
    if (acceptedClientIds.size === 0 || state.optimisticMessages.length === 0) return;
    let clearMatchingDraft = false;
    state.optimisticMessages = state.optimisticMessages.filter((optimistic) => {
      if (!acceptedClientIds.has(optimistic.clientMessageId)) return true;
      if (state.draft.trim() === optimistic.text) clearMatchingDraft = true;
      return false;
    });
    if (clearMatchingDraft) {
      state.draft = '';
      persistDraft();
    }
  }

  function markInterruptedSendsUnconfirmed() {
    state.optimisticMessages = state.optimisticMessages.map((message) => (
      message.sendState === 'sending'
        ? {
            ...markOptimisticFailed(message, 'SEND_NOT_CONFIRMED'),
            sendState: 'unconfirmed',
            retryAfter: null,
          }
        : message
    ));
  }

  function refreshCanonical({
    full = false,
    eventCursorOnSuccess = null,
    cursorEpoch = eventCursorEpoch,
    epoch = sessionEpoch,
    scope = state.clientSessionScope,
  } = {}) {
    const run = refreshQueue.then(async () => {
      if (!state.ready || !isCurrentSession(epoch, scope)) return false;
      const after = full ? 0 : state.lastMessageSequence;
      const data = await requestJson(`/api/v1/messages?after=${after}`);
      if (!isCurrentSession(epoch, scope)) return false;
      state.canonicalMessages = mergeCanonical(state.canonicalMessages, data.messages, full);
      pruneCanonicallyAcceptedOptimistic();
      state.lastMessageSequence = maximumSequence(state.canonicalMessages);
      state.activeTurn = data.activeTurn ?? null;
      if (cursorEpoch === eventCursorEpoch
        && Number.isSafeInteger(eventCursorOnSuccess)
        && eventCursorOnSuccess > state.eventCursor) {
        state.eventCursor = eventCursorOnSuccess;
        persistCursor();
      }
      state.connection = 'connected';
      notify();
      return true;
    });
    refreshQueue = run.catch(() => undefined);
    return run.catch((error) => {
      if (isCurrentSession(epoch, scope)) {
        state.connection = 'reconnecting';
        notify();
      }
      throw error;
    });
  }

  function reconnectCurrentSession(epoch, scope, delay) {
    scheduleReconnect(() => {
      if (isCurrentSession(epoch, scope)) connectEvents();
    }, delay);
  }

  function connectEvents() {
    if (!state.ready || state.disposed || typeof EventSourceImpl !== 'function') return;
    closeEvents();
    const epoch = sessionEpoch;
    const scope = state.clientSessionScope;
    const source = new EventSourceImpl(`/api/v1/events?afterCursor=${state.eventCursor}`);
    eventSource = source;

    const handle = (event) => {
      if (source !== eventSource || !isCurrentSession(epoch, scope)) return;
      const hint = eventHint(event, state.eventCursor);
      if (event.type === 'resync_required') {
        eventCursorEpoch += 1;
        state.eventCursor = 0;
        persistCursor();
        closeEvents();
        notify();
        void refreshCanonical({ full: true, epoch, scope })
          .catch(() => undefined)
          .finally(() => reconnectCurrentSession(epoch, scope, 0));
        return;
      }
      if (!hint.shouldBackfill) return;
      // Sequence backfill sees only newly appended messages. Terminal failure and
      // audio attachment mutate existing rows, so those persisted event types
      // require a full canonical refresh while their SSE payload remains ignored.
      void refreshCanonical({
        full: MUTATING_EXISTING_MESSAGE_EVENTS.has(event.type),
        eventCursorOnSuccess: hint.cursor,
        epoch,
        scope,
      }).catch(() => {
        if (!isCurrentSession(epoch, scope) || source !== eventSource) return;
        closeEvents();
        reconnectCurrentSession(epoch, scope);
      });
    };

    for (const type of SSE_EVENTS) source.addEventListener(type, handle);
    source.onopen = () => {
      if (source !== eventSource || !isCurrentSession(epoch, scope)) return;
      state.connection = 'connected';
      notify();
    };
    source.onerror = () => {
      if (source !== eventSource || !isCurrentSession(epoch, scope)) return;
      closeEvents();
      state.connection = 'reconnecting';
      notify();
      reconnectCurrentSession(epoch, scope);
    };
  }

  async function bootstrap({ epoch = beginSessionEpoch(), draftOverride } = {}) {
    const previousScope = state.clientSessionScope;
    const previousOptimistic = state.optimisticMessages;
    if (!isCurrentEpoch(epoch)) return snapshot();
    state.connection = 'connecting';
    notify();
    const data = await requestJson('/api/v1/session', {
      method: 'POST',
      headers: { 'X-Client-Instance-Id': clientInstanceId() },
    });
    if (!isCurrentEpoch(epoch)) return snapshot();
    if (typeof data?.clientSessionScope !== 'string' || !data.clientSessionScope) {
      throw new Error('Session bootstrap did not return a client scope.');
    }
    const sameScope = previousScope === data.clientSessionScope;
    adoptScope(data.clientSessionScope);
    if (!sameScope) {
      sendBlockedUntil = 0;
      sendRetryAfter = null;
    }
    if (typeof draftOverride === 'string') {
      state.draft = draftOverride.slice(0, 4000);
      persistDraft();
    }
    state.conversation = data.conversation ?? null;
    state.capabilities = normalizeCapabilities(data.capabilities);
    state.knowledgeSnapshotDate = data.knowledgeSnapshotDate ?? null;
    state.consent = data.consent ?? state.consent;
    state.canonicalMessages = canonicalMessages(data.messages);
    state.optimisticMessages = sameScope ? previousOptimistic : [];
    pruneCanonicallyAcceptedOptimistic();
    state.activeTurn = null;
    state.lastMessageSequence = maximumSequence(state.canonicalMessages);
    state.ready = true;
    state.connection = 'connected';
    notify();
    if (state.canonicalMessages.length > 0) {
      await refreshCanonical({ epoch, scope: data.clientSessionScope }).catch(() => undefined);
    }
    if (!isCurrentSession(epoch, data.clientSessionScope)) return snapshot();
    connectEvents();
    return snapshot();
  }

  async function submitOptimistic(optimistic) {
    const epoch = sessionEpoch;
    const scope = state.clientSessionScope;
    if (!isCurrentSession(epoch, scope)) return false;
    const clientMessageId = optimistic.clientMessageId;
    if (inFlightClientIds.has(clientMessageId)) return false;
    const flightSet = inFlightClientIds;
    flightSet.add(clientMessageId);
    state.optimisticMessages = state.optimisticMessages.map((message) => (
      message.clientMessageId === clientMessageId
        ? { ...message, status: 'sending', sendState: 'sending', failureCode: null }
        : message
    ));
    notify();
    try {
      const data = await requestJson('/api/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryPayload(optimistic)),
      });
      if (!isCurrentSession(epoch, scope)) return false;
      state.canonicalMessages = mergeCanonical(state.canonicalMessages, [data.message]);
      pruneCanonicallyAcceptedOptimistic();
      state.lastMessageSequence = maximumSequence(state.canonicalMessages);
      state.activeTurn = data.turn ?? null;
      notify();
      return true;
    } catch (error) {
      if (!isCurrentSession(epoch, scope)) return false;
      if (error.code === 'SESSION_NOT_FOUND') {
        const preservedDraft = state.draft;
        const oldScope = state.clientSessionScope;
        const recoveryEpoch = beginSessionEpoch();
        if (oldScope) {
          storageRemove(scopedKey(oldScope, 'draft'));
          storageRemove(scopedKey(oldScope, 'event-cursor'));
          storageRemove(scopedKey(oldScope, 'reply-preferences'));
        }
        storageRemove(ROOT_SCOPE_KEY);
        state.ready = false;
        state.clientSessionScope = null;
        state.conversation = null;
        state.canonicalMessages = [];
        state.optimisticMessages = [];
        state.activeTurn = null;
        state.lastMessageSequence = 0;
        state.eventCursor = 0;
        state.draft = preservedDraft;
        notify();
        try {
          await bootstrap({ epoch: recoveryEpoch, draftOverride: preservedDraft });
        } catch (cause) {
          if (isCurrentEpoch(recoveryEpoch)) {
            state.draft = preservedDraft;
            state.connection = 'reconnecting';
            notify();
          }
          const recoveryError = new Error('Your guest session expired, and a new chat could not start yet.');
          recoveryError.code = 'SESSION_RECOVERY_FAILED';
          recoveryError.cause = cause;
          throw recoveryError;
        }
        const recovered = new Error('Your guest session expired. A new guest chat is ready and your draft was kept.');
        recovered.code = 'SESSION_RECOVERED';
        throw recovered;
      }
      const explicitRejection = Number.isSafeInteger(error.status)
        && error.status >= 400 && error.status < 500;
      if (error.status === 429) {
        const retrySeconds = /^\d+$/.test(error.retryAfter ?? '') ? Number(error.retryAfter) : null;
        const retryDate = retrySeconds === null ? new Date(error.retryAfter ?? '').getTime() : null;
        const currentTime = now().getTime();
        sendBlockedUntil = retrySeconds === null
          ? (Number.isFinite(retryDate) ? Math.max(currentTime, retryDate) : currentTime)
          : currentTime + (retrySeconds * 1000);
        sendRetryAfter = error.retryAfter ?? null;
      }
      state.optimisticMessages = state.optimisticMessages.map((message) => (
        message.clientMessageId === clientMessageId
          ? {
              ...markOptimisticFailed(message, error.code),
              sendState: error.status === 429
                ? 'retryable-rejection'
                : explicitRejection ? 'rejected' : 'unconfirmed',
              retryAfter: error.retryAfter ?? null,
            }
          : message
      ));
      notify();
      throw error;
    } finally {
      flightSet.delete(clientMessageId);
    }
  }

  function rateLimitError() {
    const error = new Error('Please wait before sending another message.');
    error.code = 'RATE_LIMITED';
    error.status = 429;
    error.retryAfter = sendRetryAfter;
    return error;
  }

  function sendMessage({
    text,
    voiceDraftId = null,
    clientMessageId = uuid(),
    replyLanguage = state.replyLanguage,
    replyMode = state.replyMode,
  } = {}) {
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!state.ready || state.disposed) return Promise.reject(new Error('The chat is not ready.'));
    if (!normalized || normalized.length > 4000) return Promise.reject(new Error('Enter a message between 1 and 4000 characters.'));
    if (!UUID.test(String(clientMessageId ?? ''))
      || (voiceDraftId !== null && !UUID.test(String(voiceDraftId ?? '')))) {
      const error = new Error('The message identity is invalid.');
      error.code = 'INVALID_MESSAGE_IDENTITY';
      return Promise.reject(error);
    }
    let preferences;
    try { preferences = normalizeReplyPreferences({ replyLanguage, replyMode }); } catch (cause) {
      const error = new Error('The reply preferences are invalid.');
      error.code = 'INVALID_REPLY_PREFERENCES';
      error.cause = cause;
      return Promise.reject(error);
    }
    if (sendBlockedUntil > now().getTime()) {
      return Promise.reject(rateLimitError());
    }
    if (inFlightClientIds.size > 0) {
      const error = new Error('Wait for the current message to be accepted.');
      error.code = 'MESSAGE_SEND_IN_PROGRESS';
      return Promise.reject(error);
    }
    const optimistic = {
      ...createOptimisticMessage({
        clientMessageId,
        text: normalized,
        voiceDraftId,
        ...preferences,
        createdAt: now().toISOString(),
      }),
      sendState: 'sending',
    };
    state.optimisticMessages.push(optimistic);
    notify();
    return submitOptimistic(optimistic);
  }

  function sendText(text) {
    return sendMessage({ text });
  }

  function retryUnconfirmed(clientMessageId) {
    if (!state.ready || state.disposed) {
      const error = new Error('The chat is not ready to retry this message.');
      error.code = 'CHAT_NOT_READY';
      return Promise.reject(error);
    }
    const optimistic = state.optimisticMessages.find((message) => (
      message.clientMessageId === clientMessageId
        && ['unconfirmed', 'retryable-rejection'].includes(message.sendState)
    ));
    if (!optimistic) return false;
    if (sendBlockedUntil > now().getTime()) return Promise.reject(rateLimitError());
    return submitOptimistic(optimistic).then(() => true);
  }

  function setDraft(value) {
    state.draft = String(value ?? '').slice(0, 4000);
    persistDraft();
    notify();
  }

  function setReplyPreferences(input) {
    const preferences = normalizeReplyPreferences(input);
    state.replyLanguage = preferences.replyLanguage;
    state.replyMode = preferences.replyMode;
    persistReplyPreferences();
    notify();
    return { ...preferences };
  }

  async function clearSession({ confirmed = false } = {}) {
    if (!confirmed) return { confirmationRequired: true };
    const oldScope = state.clientSessionScope;
    const epoch = beginSessionEpoch();
    const preservedDraft = state.draft;
    state.ready = false;
    state.connection = 'connecting';
    notify();
    try {
      await requestJson('/api/v1/session', { method: 'DELETE' });
    } catch (deleteError) {
      if (!isCurrentEpoch(epoch)) return false;
      const deleteOutcomeAmbiguous = ['NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(deleteError.code);
      // The epoch fence intentionally ignores every old POST completion. Any
      // still-unreconciled send is therefore ambiguous and must be retryable
      // with its original idempotency identity, never left stuck as "sending".
      markInterruptedSendsUnconfirmed();
      try {
        // Re-bootstrap before deciding the outcome. The recovered scope tells
        // us whether the old guest chat remains authoritative; if it does, a
        // send accepted during the revocation race is recovered canonically.
        await bootstrap({ epoch });
      } catch (recoveryCause) {
        if (isCurrentEpoch(epoch)) {
          state.ready = false;
          state.connection = 'reconnecting';
          state.draft = preservedDraft;
          persistDraft();
          notify();
        }
        const recoveryError = new Error(deleteOutcomeAmbiguous
          ? 'Clearing could not be confirmed, and the guest scope could not be checked yet.'
          : 'The conversation was not cleared, and the existing chat could not be reloaded yet.');
        recoveryError.code = deleteOutcomeAmbiguous ? 'CLEAR_OUTCOME_UNKNOWN' : 'CLEAR_FAILED_RECOVERY_PENDING';
        recoveryError.deleted = deleteOutcomeAmbiguous ? null : false;
        recoveryError.cause = recoveryCause;
        recoveryError.deleteCause = deleteError;
        throw recoveryError;
      }
      if (state.clientSessionScope !== oldScope) {
        // A lost DELETE response can hide a successful revocation and cookie
        // rotation. A different recovered scope proves the old guest scope is
        // no longer the active chat, so honor the clear intent and never carry
        // its local draft, cursor, optimistic rows, or history into the new one.
        if (oldScope) {
          storageRemove(scopedKey(oldScope, 'draft'));
          storageRemove(scopedKey(oldScope, 'event-cursor'));
        }
        const newScope = state.clientSessionScope;
        state.canonicalMessages = [];
        state.optimisticMessages = [];
        state.activeTurn = null;
        state.lastMessageSequence = 0;
        state.eventCursor = 0;
        state.draft = '';
        if (newScope) {
          storageRemove(scopedKey(newScope, 'draft'));
          storageRemove(scopedKey(newScope, 'event-cursor'));
        }
        eventCursorEpoch += 1;
        closeEvents();
        state.connection = 'connected';
        notify();
        connectEvents();
        return { deleted: true, recovered: true };
      }
      deleteError.deleted = false;
      deleteError.recovered = true;
      throw deleteError;
    }
    if (!isCurrentEpoch(epoch)) return false;
    if (oldScope) {
      storageRemove(scopedKey(oldScope, 'draft'));
      storageRemove(scopedKey(oldScope, 'event-cursor'));
      storageRemove(scopedKey(oldScope, 'reply-preferences'));
    }
    storageRemove(ROOT_SCOPE_KEY);
    state.ready = false;
    state.clientSessionScope = null;
    state.conversation = null;
    state.canonicalMessages = [];
    state.optimisticMessages = [];
    state.activeTurn = null;
    state.lastMessageSequence = 0;
    state.eventCursor = 0;
    state.draft = '';
    notify();
    try {
      await bootstrap({ epoch });
    } catch (cause) {
      const error = new Error('Conversation cleared, but a new guest chat could not start yet.');
      error.code = 'CLEARED_RESTART_FAILED';
      error.deleted = true;
      error.cause = cause;
      throw error;
    }
    return { deleted: true };
  }

  function dispose() {
    state.disposed = true;
    sessionEpoch += 1;
    eventCursorEpoch += 1;
    refreshQueue = Promise.resolve();
    inFlightClientIds = new Set();
    closeEvents();
  }

  return {
    start: bootstrap,
    snapshot,
    sendMessage,
    sendText,
    retryUnconfirmed,
    setDraft,
    setReplyPreferences,
    clearSession,
    refresh: refreshCanonical,
    dispose,
  };
}
