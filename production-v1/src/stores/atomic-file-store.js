import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { contextLimits, retainRecentCompletePairs } from '../context-budget.js';
import {
  DEFAULT_REPLY_LANGUAGE,
  DEFAULT_REPLY_MODE,
  REPLY_LANGUAGES,
  REPLY_MODES,
  SAFE_TURN_FAILURE_CODES,
  STORE_SCHEMA_VERSION,
  TURN_STATES,
  TURN_TERMINAL_STATES,
  storeError,
} from './store-contract.js';

const LEGACY_COLLECTIONS = ['sessions', 'conversations', 'messages', 'turns', 'events', 'mediaAssets', 'rateLimitBuckets', 'serviceState'];
const COLLECTIONS = [...LEGACY_COLLECTIONS, 'voiceUploads', 'mediaGenerations', 'mediaDeletionJobs'];
const NO_CHANGE = Symbol('atomic-store-no-change');
const NONTERMINAL_TRANSITIONS = Object.freeze({ accepted: 'retrieving', retrieving: 'generating' });
const ATTEMPT_CLEANUP_GRACE_MS = 60_000;

function noChange(value) { return { [NO_CHANGE]: true, value }; }

function emptySnapshot() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    sessions: [], conversations: [], messages: [], turns: [], events: [], mediaAssets: [],
    voiceUploads: [], mediaGenerations: [], mediaDeletionJobs: [],
    rateLimitBuckets: [], serviceState: {},
    visitTurns: [], reports: [],
  };
}

function conversationKindOf(conversation) {
  return conversation?.kind ?? 'campus';
}

function findConversation(snapshot, sessionId, kind = 'campus') {
  return snapshot.conversations.find((item) => (
    item.sessionId === sessionId && conversationKindOf(item) === kind
  )) ?? null;
}

function optionalList(snapshot, name) {
  if (!Array.isArray(snapshot[name])) snapshot[name] = [];
  return snapshot[name];
}

function validateSnapshotShape(snapshot, collections) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Atomic store state is corrupt or uses an unsupported schema version');
  }
  for (const collection of collections) {
    if (!(collection in snapshot) || (collection !== 'serviceState' && !Array.isArray(snapshot[collection]))) {
      throw new Error('Atomic store state is corrupt');
    }
  }
  if (snapshot.sessions.some((session) => !session?.id || !session.tokenHash)
    || snapshot.conversations.some((conversation) => !conversation?.id || !conversation.sessionId)
    || snapshot.messages.some((message) => !message?.id || !message.sessionId || !message.conversationId || !Number.isInteger(message.sequence))
    || snapshot.turns.some((turn) => !turn?.id || !turn.sessionId || !turn.conversationId || !turn.userMessageId || !turn.requestHash || !TURN_STATES.has(turn.state))
    || snapshot.events.some((event) => !event?.id || !event.sessionId || !event.conversationId || !Number.isInteger(event.cursor))) {
    throw new Error('Atomic store state is corrupt');
  }
  return snapshot;
}

function upgradeReplyPreferences(snapshot) {
  const upgraded = clone(snapshot);
  let changed = false;
  for (const row of [...upgraded.messages, ...upgraded.turns]) {
    if (row.replyLanguage === undefined) {
      row.replyLanguage = DEFAULT_REPLY_LANGUAGE;
      changed = true;
    }
    if (row.replyMode === undefined) {
      row.replyMode = DEFAULT_REPLY_MODE;
      changed = true;
    }
  }
  return { snapshot: upgraded, changed };
}

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error('Atomic store state is corrupt or uses an unsupported schema version');
  }
  validateSnapshotShape(snapshot, COLLECTIONS);
  if (snapshot.messages.some((message) => !REPLY_LANGUAGES.has(message.replyLanguage) || !REPLY_MODES.has(message.replyMode))
    || snapshot.turns.some((turn) => !REPLY_LANGUAGES.has(turn.replyLanguage) || !REPLY_MODES.has(turn.replyMode))) {
    throw new Error('Atomic store state is corrupt');
  }
  const scopeIds = snapshot.sessions.map((session) => session.clientScopeId);
  if (scopeIds.some((scopeId) => typeof scopeId !== 'string' || !scopeId)
    || new Set(scopeIds).size !== scopeIds.length) {
    throw new Error('Atomic store state is corrupt');
  }
  return snapshot;
}

function migrateSchemaOne(snapshot) {
  if (snapshot?.schemaVersion !== 1) {
    throw new Error('Atomic store state is corrupt or uses an unsupported schema version');
  }
  validateSnapshotShape(snapshot, LEGACY_COLLECTIONS);
  const migrated = clone(snapshot);
  const assigned = new Set();
  for (const session of migrated.sessions) {
    let clientScopeId;
    do { clientScopeId = randomUUID(); } while (assigned.has(clientScopeId));
    assigned.add(clientScopeId);
    session.clientScopeId = clientScopeId;
  }
  migrated.voiceUploads = [];
  migrated.mediaGenerations = [];
  migrated.mediaDeletionJobs = [];
  migrated.schemaVersion = STORE_SCHEMA_VERSION;
  return validateSnapshot(upgradeReplyPreferences(migrated).snapshot);
}

function clone(value) { return structuredClone(value); }
function nowIso(now) { return new Date(now ?? Date.now()).toISOString(); }
function instant(now) {
  const value = new Date(now ?? Date.now()).getTime();
  if (!Number.isFinite(value)) throw new Error('now must be a valid instant');
  return value;
}

function messageSequence(snapshot, conversationId) {
  return snapshot.messages.reduce((highest, message) => (
    message.conversationId === conversationId ? Math.max(highest, message.sequence) : highest
  ), 0) + 1;
}

function appendEvent(snapshot, { sessionId, conversationId, type, messageId = null, turnId = null, payloadJson = {}, now }) {
  const conversation = snapshot.conversations.find((item) => item.id === conversationId && item.sessionId === sessionId);
  if (!conversation) throw storeError('NOT_FOUND', 'The requested conversation was not found.');
  const existingHighWater = snapshot.events.reduce((highest, event) => (
    event.conversationId === conversationId ? Math.max(highest, event.cursor) : highest
  ), 0);
  const cursor = Math.max(Number(conversation.eventHighWater) || 0, existingHighWater) + 1;
  conversation.eventHighWater = cursor;
  conversation.updatedAt = nowIso(now);
  const event = {
    id: randomUUID(), sessionId, conversationId, cursor, type, messageId, turnId,
    payloadJson: clone(payloadJson), createdAt: nowIso(now),
  };
  snapshot.events.push(event);
  return event;
}

function inboundSequence(snapshot, turn) {
  return snapshot.messages.find((message) => message.id === turn.userMessageId)?.sequence ?? Number.MAX_SAFE_INTEGER;
}

function latestInstant(...values) {
  const finite = values.filter((value) => value !== null && value !== undefined).map((value) => instant(value));
  return finite.length > 0 ? Math.max(...finite) : 0;
}

function liveAttempt(row, now) {
  const nowMs = instant(now);
  return Boolean(row?.leaseToken && row.leaseExpiresAt && row.attemptDeadlineAt
    && instant(row.leaseExpiresAt) > nowMs && instant(row.attemptDeadlineAt) > nowMs);
}

function rateLimitState(snapshot, requests = []) {
  const resolved = requests.map((request) => ({
    request,
    bucket: snapshot.rateLimitBuckets.find((bucket) => (
      bucket.subjectHash === request.subjectHash
      && bucket.quota === request.quota
      && bucket.windowStart === request.windowStart
    )),
  }));
  const exhausted = resolved.filter(({ request, bucket }) => bucket && bucket.count >= request.limit);
  const blockingExpiresAt = exhausted.length > 0
    ? exhausted.reduce((latest, { bucket }) => (
      !latest || instant(bucket.expiresAt) > instant(latest) ? bucket.expiresAt : latest
    ), null)
    : null;
  return { resolved, blockingExpiresAt };
}

function consumeRateLimits(snapshot, requests = []) {
  for (const request of requests) {
    let bucket = snapshot.rateLimitBuckets.find((item) => (
      item.subjectHash === request.subjectHash
      && item.quota === request.quota
      && item.windowStart === request.windowStart
    ));
    if (!bucket) {
      bucket = {
        id: randomUUID(), subjectHash: request.subjectHash, quota: request.quota,
        windowStart: request.windowStart, count: 0, expiresAt: request.expiresAt,
      };
      snapshot.rateLimitBuckets.push(bucket);
    }
    bucket.count += 1;
  }
}

function enqueueDeletion(snapshot, {
  storageKey, reason, notBefore, now, rearm = false, sweepObservation = null,
}) {
  if (typeof storageKey !== 'string' || !storageKey) throw new Error('storageKey is required');
  const timestamp = nowIso(now);
  const safeNotBefore = nowIso(notBefore ?? now);
  let job = snapshot.mediaDeletionJobs.find((item) => item.storageKey === storageKey);
  if (!job) {
    job = {
      id: randomUUID(), storageKey, reason, notBefore: safeNotBefore,
      state: 'pending', attempt: 0, generation: 1,
      leaseToken: null, leaseExpiresAt: null, workerId: null, lastErrorCode: null,
      sweepObservation,
      createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    };
    snapshot.mediaDeletionJobs.push(job);
    return job;
  }
  if (rearm) {
    job.generation = Number(job.generation || 0) + 1;
    job.state = 'pending';
    job.attempt = 0;
    job.reason = reason;
    job.notBefore = safeNotBefore;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.workerId = null;
    job.lastErrorCode = null;
    job.sweepObservation = sweepObservation;
    job.completedAt = null;
    job.updatedAt = timestamp;
    return job;
  }
  if (job.state !== 'completed') {
    if (instant(safeNotBefore) > instant(job.notBefore)) job.notBefore = safeNotBefore;
    job.reason = reason;
    job.updatedAt = timestamp;
  }
  return job;
}

export class AtomicFileStore {
  constructor({ filePath }) {
    if (!filePath) throw new Error('AtomicFileStore requires filePath');
    this.filePath = filePath;
    this.snapshot = null;
    this.mutations = Promise.resolve();
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.schemaVersion === 1) {
        const migrated = migrateSchemaOne(parsed);
        await this.#persist(migrated);
        this.snapshot = migrated;
      } else {
        const upgraded = upgradeReplyPreferences(parsed);
        this.snapshot = validateSnapshot(upgraded.snapshot);
        if (upgraded.changed) await this.#persist(this.snapshot);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.snapshot = emptySnapshot();
        await this.#persist(this.snapshot);
      } else if (error instanceof SyntaxError || /corrupt|schema version/i.test(error?.message ?? '')) {
        throw new Error('Atomic store state is corrupt or uses an unsupported schema version');
      } else {
        throw error;
      }
    }
  }

  async close() { await this.mutations; }

  async #persist(snapshot) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(snapshot));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
  }

  #read(callback) {
    if (!this.snapshot) throw new Error('AtomicFileStore.init() must finish before use');
    return callback(this.snapshot);
  }

  #mutate(callback) {
    const operation = async () => {
      if (!this.snapshot) throw new Error('AtomicFileStore.init() must finish before use');
      const draft = clone(this.snapshot);
      const result = await callback(draft);
      if (result?.[NO_CHANGE]) return clone(result.value);
      validateSnapshot(draft);
      await this.#persist(draft);
      this.snapshot = draft;
      return clone(result);
    };
    const result = this.mutations.then(operation, operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  #ownedConversation(snapshot, sessionId, conversationId) {
    const conversation = snapshot.conversations.find((item) => item.id === conversationId && item.sessionId === sessionId);
    if (!conversation) throw storeError('NOT_FOUND', 'The requested conversation was not found.');
    return conversation;
  }

  #activeSession(snapshot, sessionId) {
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) throw storeError('SESSION_NOT_FOUND', 'A valid session is required.');
    return session;
  }

  #assertAttemptStorageKeyAvailable(snapshot, storageKey, { uploadId, generationId } = {}) {
    if (typeof storageKey !== 'string' || !storageKey) throw new Error('attemptStorageKey is required');
    const used = snapshot.mediaAssets.some((asset) => asset.storageKey === storageKey)
      || snapshot.voiceUploads.some((upload) => upload.id !== uploadId && upload.attemptStorageKey === storageKey)
      || snapshot.mediaGenerations.some((generation) => generation.id !== generationId && generation.attemptStorageKey === storageKey);
    if (used) throw storeError('STORAGE_KEY_CONFLICT', 'The media storage key is already in use.');
  }

  #liveVoiceLease(snapshot, { uploadId, leaseToken, now }) {
    const upload = snapshot.voiceUploads.find((item) => item.id === uploadId);
    if (!upload || !['uploading', 'transcribing'].includes(upload.state)
      || upload.leaseToken !== leaseToken || !liveAttempt(upload, now)
      || !snapshot.sessions.some((session) => session.id === upload.sessionId)) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
    }
    return upload;
  }

  #liveGenerationLease(snapshot, { generationId, leaseToken, now }) {
    const generation = snapshot.mediaGenerations.find((item) => item.id === generationId);
    if (!generation || generation.state !== 'generating'
      || generation.leaseToken !== leaseToken || !liveAttempt(generation, now)) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
    }
    const message = snapshot.messages.find((item) => item.id === generation.ownerMessageId);
    if (!message || !snapshot.sessions.some((session) => session.id === message.sessionId)) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
    }
    return generation;
  }

  #turn(snapshot, turnId) {
    const turn = snapshot.turns.find((item) => item.id === turnId);
    if (!turn) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    return turn;
  }

  #liveLease(snapshot, { turnId, leaseToken, now }) {
    const turn = this.#turn(snapshot, turnId);
    const nowMs = instant(now);
    if (TURN_TERMINAL_STATES.has(turn.state)
      || typeof leaseToken !== 'string'
      || !leaseToken
      || turn.leaseToken !== leaseToken
      || !turn.leaseExpiresAt
      || new Date(turn.leaseExpiresAt).getTime() <= nowMs) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    }
    return turn;
  }

  async createOrResumeSession({ tokenHash, now }) {
    return this.#mutate((snapshot) => {
      const timestamp = nowIso(now);
      const existing = snapshot.sessions.reduce((matched, session) => (
        session.tokenHash === tokenHash ? session : matched
      ), null);
      if (existing) {
        const conversation = findConversation(snapshot, existing.id, 'campus');
        if (!conversation) throw new Error('Atomic store state is corrupt');
        return { created: false, session: existing, conversation };
      }
      const session = {
        id: randomUUID(), tokenHash, clientScopeId: randomUUID(),
        createdAt: timestamp, updatedAt: timestamp,
        aiConsentVersion: null, aiConsentAt: null, voiceConsentVersion: null, voiceConsentAt: null,
      };
      const conversation = {
        id: randomUUID(), sessionId: session.id, kind: 'campus',
        mode: null, scenario: null, eventHighWater: 0, createdAt: timestamp, updatedAt: timestamp,
      };
      snapshot.sessions.push(session);
      snapshot.conversations.push(conversation);
      return { created: true, session, conversation };
    });
  }

  async getSessionByTokenHash(tokenHash) {
    return this.#read((snapshot) => clone(snapshot.sessions.reduce((matched, session) => (
      session.tokenHash === tokenHash ? session : matched
    ), null)));
  }

  async getConversationForSession({ sessionId, kind = 'campus' }) {
    return this.#read((snapshot) => clone(findConversation(snapshot, sessionId, kind)));
  }

  async getOrCreateConversation({ sessionId, kind, mode = null, scenario = null, now }) {
    return this.#mutate((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const existing = findConversation(snapshot, sessionId, kind);
      const timestamp = nowIso(now);
      if (existing) {
        if (mode != null) existing.mode = mode;
        if (scenario != null) existing.scenario = scenario;
        existing.updatedAt = timestamp;
        return clone(existing);
      }
      if (!['campus', 'practice'].includes(kind)) {
        throw storeError('INVALID_REQUEST', 'Unsupported conversation kind.');
      }
      const conversation = {
        id: randomUUID(), sessionId, kind, mode, scenario,
        eventHighWater: 0, createdAt: timestamp, updatedAt: timestamp,
      };
      snapshot.conversations.push(conversation);
      return clone(conversation);
    });
  }

  async recordConsent({ sessionId, kinds, version, now }) {
    return this.#mutate((snapshot) => {
      const session = this.#activeSession(snapshot, sessionId);
      const timestamp = nowIso(now);
      if (kinds.includes('ai')) {
        session.aiConsentVersion = version;
        session.aiConsentAt = timestamp;
      }
      if (kinds.includes('voice')) {
        session.voiceConsentVersion = version;
        session.voiceConsentAt = timestamp;
      }
      session.updatedAt = timestamp;
      return clone(session);
    });
  }

  async withdrawVoiceConsent({ sessionId, now }) {
    return this.#mutate((snapshot) => {
      const session = this.#activeSession(snapshot, sessionId);
      session.voiceConsentVersion = null;
      session.voiceConsentAt = null;
      session.updatedAt = nowIso(now);
      return clone(session);
    });
  }

  async getConsent({ sessionId }) {
    return this.#read((snapshot) => clone(this.#activeSession(snapshot, sessionId)));
  }

  async getVisitTurn({ sessionId, clientTurnId }) {
    return this.#read((snapshot) => clone(
      optionalList(snapshot, 'visitTurns').find((item) => item.sessionId === sessionId && item.clientTurnId === clientTurnId) ?? null,
    ));
  }

  async createVisitTurn({ sessionId, clientTurnId, sourceText, direction, userJob, inputType, voiceDraftId, result, now }) {
    return this.#mutate((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const turns = optionalList(snapshot, 'visitTurns');
      const existing = turns.find((item) => item.sessionId === sessionId && item.clientTurnId === clientTurnId);
      if (existing) {
        if (existing.sourceText !== sourceText || existing.direction !== direction) {
          throw storeError('IDEMPOTENCY_CONFLICT', 'This client turn ID was already used with different content.');
        }
        return clone(existing);
      }
      const row = {
        id: randomUUID(),
        sessionId,
        clientTurnId,
        sourceText,
        direction,
        effectiveDirection: result.effectiveDirection ?? direction,
        userJob: userJob ?? null,
        inputType: inputType ?? 'text',
        translatedText: result.translatedText,
        displayText: result.displayText ?? result.translatedText,
        romanization: result.romanization ?? null,
        autoRouted: Boolean(result.autoRouted),
        routeReason: result.routeReason ?? null,
        needsConfirmation: Boolean(result.needsConfirmation),
        provider: result.provider,
        suppressTts: Boolean(result.suppressTts),
        voiceDraftId: voiceDraftId ?? null,
        createdAt: nowIso(now),
      };
      turns.push(row);
      return clone(row);
    });
  }

  async createReport({ sessionId, messageId, conversationKind, reason, now }) {
    return this.#mutate((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const reports = optionalList(snapshot, 'reports');
      const row = {
        id: randomUUID(),
        sessionId,
        messageId: messageId ?? null,
        conversationKind,
        reason,
        createdAt: nowIso(now),
      };
      reports.push(row);
      return clone(row);
    });
  }

  async getAcceptedMessage({ sessionId, conversationId, clientMessageId }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      const message = snapshot.messages.find((item) => item.conversationId === conversationId && item.clientMessageId === clientMessageId);
      if (!message) return null;
      const turn = snapshot.turns.find((item) => item.userMessageId === message.id);
      const event = snapshot.events.find((item) => item.type === 'message.accepted' && item.messageId === message.id);
      if (!turn || !event) throw new Error('Atomic store state is corrupt');
      return clone({ message, turn, event });
    });
  }

  async acceptMessage({
    sessionId, conversationId, clientMessageId, requestHash, text, voiceDraftId = null,
    replyLanguage = DEFAULT_REPLY_LANGUAGE, replyMode = DEFAULT_REPLY_MODE, now,
  }) {
    return this.#mutate((snapshot) => {
      return this.#acceptMessage(snapshot, {
        sessionId, conversationId, clientMessageId, requestHash, text, voiceDraftId,
        replyLanguage, replyMode, now,
      });
    });
  }

  async acceptMessageWithRateLimits({ rateLimits, ...messageInput }) {
    return this.#mutate((snapshot) => {
      const duplicate = this.#findAcceptedMessage(snapshot, messageInput);
      if (duplicate) {
        if (duplicate.turn.requestHash !== messageInput.requestHash) throw storeError('IDEMPOTENCY_CONFLICT', 'This client message ID was already used with different content.');
        return { idempotent: true, ...duplicate };
      }
      const { blockingExpiresAt } = rateLimitState(snapshot, rateLimits);
      if (blockingExpiresAt) {
        const error = storeError('RATE_LIMITED', 'Rate limit exceeded.');
        error.expiresAt = blockingExpiresAt;
        throw error;
      }
      consumeRateLimits(snapshot, rateLimits);
      return this.#acceptMessage(snapshot, messageInput);
    });
  }

  #findAcceptedMessage(snapshot, { sessionId, conversationId, clientMessageId }) {
    this.#ownedConversation(snapshot, sessionId, conversationId);
    const message = snapshot.messages.find((item) => item.conversationId === conversationId && item.clientMessageId === clientMessageId);
    if (!message) return null;
    const turn = snapshot.turns.find((item) => item.userMessageId === message.id);
    const event = snapshot.events.find((item) => item.type === 'message.accepted' && item.messageId === message.id);
    if (!turn || !event) throw new Error('Atomic store state is corrupt');
    return { message, turn, event };
  }

  #acceptMessage(snapshot, {
    sessionId, conversationId, clientMessageId, requestHash, text, voiceDraftId = null,
    replyLanguage = DEFAULT_REPLY_LANGUAGE, replyMode = DEFAULT_REPLY_MODE, now,
  }) {
    if (!REPLY_LANGUAGES.has(replyLanguage) || !REPLY_MODES.has(replyMode)) {
      throw storeError('INVALID_REQUEST', 'Unsupported reply preferences.');
    }
    const duplicate = this.#findAcceptedMessage(snapshot, { sessionId, conversationId, clientMessageId });
    if (duplicate) {
      if (duplicate.turn.requestHash !== requestHash) throw storeError('IDEMPOTENCY_CONFLICT', 'This client message ID was already used with different content.');
      return { idempotent: true, ...duplicate };
    }
    let voiceDraft = null;
    if (voiceDraftId) {
      voiceDraft = snapshot.mediaAssets.find((asset) => asset.id === voiceDraftId && asset.sessionId === sessionId && asset.kind === 'user_voice' && asset.status === 'draft');
      if (!voiceDraft) throw storeError('INVALID_VOICE_DRAFT', 'The voice draft is unavailable.');
    }
    const timestamp = nowIso(now);
    const sequence = messageSequence(snapshot, conversationId);
    const turnId = randomUUID();
    const message = {
      id: randomUUID(), sessionId, conversationId, turnId, clientMessageId, sequence,
      role: 'user', kind: voiceDraftId ? 'voice' : 'text', status: 'accepted',
      failureCode: null, text, replyLanguage, replyMode,
      voiceDraftId, mediaId: voiceDraft?.id ?? null, createdAt: timestamp,
    };
    const turn = {
      id: turnId, sessionId, conversationId, userMessageId: message.id, requestHash,
      replyLanguage, replyMode,
      state: 'accepted', failureCode: null, attempt: 0, leaseExpiresAt: null,
      leaseToken: null, workerId: null, createdAt: timestamp, updatedAt: timestamp,
    };
    const event = appendEvent(snapshot, {
      sessionId, conversationId, type: 'message.accepted', messageId: message.id,
      turnId: turn.id, payloadJson: { messageId: message.id, turnId: turn.id }, now: timestamp,
    });
    snapshot.messages.push(message);
    snapshot.turns.push(turn);
    if (voiceDraft) {
      voiceDraft.status = 'attached';
      voiceDraft.ownerMessageId = message.id;
      voiceDraft.updatedAt = timestamp;
    }
    return { idempotent: false, message, turn, event };
  }

  async listMessages({ sessionId, conversationId, after = 0 }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      return clone(snapshot.messages.filter((message) => message.conversationId === conversationId && message.sequence > Number(after)).sort((a, b) => a.sequence - b.sequence));
    });
  }

  async getActiveTurn({ sessionId, conversationId }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      const turns = snapshot.turns.filter((turn) => turn.conversationId === conversationId && !TURN_TERMINAL_STATES.has(turn.state));
      turns.sort((left, right) => inboundSequence(snapshot, left) - inboundSequence(snapshot, right) || left.id.localeCompare(right.id));
      return clone(turns[0] ?? null);
    });
  }

  async claimNextTurn({ workerId, leaseToken, leaseUntil, now }) {
    return this.#mutate((snapshot) => {
      if (typeof workerId !== 'string' || !workerId || typeof leaseToken !== 'string' || !leaseToken) {
        throw new Error('workerId and leaseToken are required');
      }
      const nowMs = instant(now);
      const leaseUntilMs = instant(leaseUntil);
      if (leaseUntilMs <= nowMs) throw new Error('leaseUntil must be in the future');
      const earliestByConversation = new Map();
      for (const turn of snapshot.turns) {
        if (TURN_TERMINAL_STATES.has(turn.state)) continue;
        const current = earliestByConversation.get(turn.conversationId);
        if (!current || inboundSequence(snapshot, turn) < inboundSequence(snapshot, current)
          || (inboundSequence(snapshot, turn) === inboundSequence(snapshot, current) && turn.id.localeCompare(current.id) < 0)) {
          earliestByConversation.set(turn.conversationId, turn);
        }
      }
      const claimable = [...earliestByConversation.values()].filter((turn) => (
        !turn.leaseToken || !turn.leaseExpiresAt || new Date(turn.leaseExpiresAt).getTime() <= nowMs
      ));
      claimable.sort((left, right) => {
        const leftCreated = new Date(left.createdAt).getTime();
        const rightCreated = new Date(right.createdAt).getTime();
        return leftCreated - rightCreated || inboundSequence(snapshot, left) - inboundSequence(snapshot, right) || left.id.localeCompare(right.id);
      });
      const turn = claimable[0];
      if (!turn) return noChange(null);
      turn.workerId = workerId;
      turn.leaseToken = leaseToken;
      turn.leaseExpiresAt = new Date(leaseUntilMs).toISOString();
      turn.attempt = Number(turn.attempt || 0) + 1;
      turn.updatedAt = nowIso(nowMs);
      return turn;
    });
  }

  async renewTurnLease({ turnId, leaseToken, leaseUntil, now }) {
    return this.#mutate((snapshot) => {
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      const leaseUntilMs = instant(leaseUntil);
      if (leaseUntilMs <= instant(now)) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      turn.leaseExpiresAt = new Date(leaseUntilMs).toISOString();
      turn.updatedAt = nowIso(now);
      return turn;
    });
  }

  async setTurnState({ turnId, leaseToken, state, now }) {
    return this.#mutate((snapshot) => {
      if (!TURN_STATES.has(state) || TURN_TERMINAL_STATES.has(state)) throw new Error('setTurnState requires a nonterminal state');
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      if (turn.state === state) return noChange({ turn, event: null, changed: false });
      if (NONTERMINAL_TRANSITIONS[turn.state] !== state) {
        throw storeError('INVALID_TURN_TRANSITION', 'The requested turn transition is not allowed.');
      }
      turn.state = state;
      turn.failureCode = null;
      turn.updatedAt = nowIso(now);
      const event = appendEvent(snapshot, {
        sessionId: turn.sessionId, conversationId: turn.conversationId, type: 'turn.state',
        turnId, payloadJson: { turnId, state }, now,
      });
      return { turn, event, changed: true };
    });
  }

  async getTurnContext({ turnId }) {
    return this.#read((snapshot) => {
      const turn = snapshot.turns.find((item) => item.id === turnId);
      if (!turn) throw storeError('NOT_FOUND', 'The requested turn was not found.');
      const targetSequence = inboundSequence(snapshot, turn);
      const earlier = snapshot.turns.filter((item) => (
        item.conversationId === turn.conversationId
        && item.state === 'delivered'
        && inboundSequence(snapshot, item) < targetSequence
      )).sort((left, right) => inboundSequence(snapshot, left) - inboundSequence(snapshot, right));
      const messages = [];
      for (const completed of earlier) {
        const inbound = snapshot.messages.find((message) => message.id === completed.userMessageId);
        const assistant = snapshot.messages.find((message) => message.turnId === completed.id && message.role === 'assistant');
        if (inbound && assistant) messages.push(inbound, assistant);
      }
      const current = snapshot.messages.find((message) => message.id === turn.userMessageId);
      if (!current) throw new Error('Atomic store state is corrupt');
      messages.push(current);
      const bounded = retainRecentCompletePairs(messages, { maxBytes: contextLimits.turnBytes, contentKey: 'text' });
      const conversation = snapshot.conversations.find((item) => item.id === turn.conversationId) ?? null;
      return clone({ turn, messages: bounded, conversation });
    });
  }

  async failTurn({ turnId, leaseToken, failureCode, now }) {
    return this.#mutate((snapshot) => {
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      const safeFailureCode = SAFE_TURN_FAILURE_CODES.has(failureCode) ? failureCode : 'ANSWER_FAILED';
      const inbound = snapshot.messages.find((message) => message.id === turn.userMessageId);
      if (!inbound) throw new Error('Atomic store state is corrupt');
      turn.state = 'failed';
      turn.failureCode = safeFailureCode;
      turn.updatedAt = nowIso(now);
      turn.leaseToken = null;
      turn.leaseExpiresAt = null;
      turn.workerId = null;
      inbound.status = 'failed';
      inbound.failureCode = safeFailureCode;
      const event = appendEvent(snapshot, {
        sessionId: turn.sessionId, conversationId: turn.conversationId, type: 'turn.failed',
        messageId: inbound.id, turnId, payloadJson: { messageId: inbound.id, turnId, failureCode: safeFailureCode }, now,
      });
      return { turn, event };
    });
  }

  async deliverAssistant({ turnId, leaseToken, message, now }) {
    return this.#mutate((snapshot) => {
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      if (turn.state !== 'generating') {
        throw storeError('INVALID_TURN_TRANSITION', 'Assistant delivery requires a generating turn.');
      }
      if (snapshot.messages.some((item) => item.turnId === turnId && item.role === 'assistant')) {
        throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      }
      if (!message || typeof message.text !== 'string' || !message.text.trim()) throw new Error('Assistant message text is required');
      const timestamp = nowIso(now);
      const assistant = {
        id: randomUUID(), sessionId: turn.sessionId, conversationId: turn.conversationId,
        turnId, sequence: messageSequence(snapshot, turn.conversationId), role: 'assistant',
        kind: 'text', status: 'delivered', text: message.text.trim(),
        replyLanguage: turn.replyLanguage, replyMode: turn.replyMode,
        citations: clone(message.citations ?? []), cards: clone(message.cards ?? []),
        suggestedReplies: clone(message.suggestedReplies ?? []),
        needsClarification: Boolean(message.needsClarification),
        groundingStatus: message.groundingStatus === 'verified' ? 'verified' : 'unverified',
        provider: typeof message.provider === 'string' ? message.provider : null,
        providerLatencyMs: Number.isFinite(message.providerLatencyMs) ? message.providerLatencyMs : null,
        createdAt: timestamp,
      };
      const inbound = snapshot.messages.find((item) => item.id === turn.userMessageId);
      if (!inbound) throw new Error('Atomic store state is corrupt');
      inbound.status = 'delivered';
      turn.state = 'delivered';
      turn.failureCode = null;
      turn.updatedAt = timestamp;
      turn.leaseToken = null;
      turn.leaseExpiresAt = null;
      turn.workerId = null;
      snapshot.messages.push(assistant);
      const event = appendEvent(snapshot, {
        sessionId: turn.sessionId, conversationId: turn.conversationId, type: 'message.delivered',
        messageId: assistant.id, turnId, payloadJson: { messageId: assistant.id, turnId }, now,
      });
      return { turn, message: assistant, event };
    });
  }

  async claimVoiceUploadWithRateLimits({
    sessionId, clientUploadId, requestSha256, mimeType, rateLimits = [],
    leaseToken, attemptStorageKey, leaseExpiresAt, attemptDeadlineAt, now,
  }) {
    return this.#mutate((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const timestamp = nowIso(now);
      const nowMs = instant(now);
      const deadlineMs = instant(attemptDeadlineAt);
      const requestedLeaseMs = instant(leaseExpiresAt);
      if (!leaseToken || requestedLeaseMs <= nowMs || deadlineMs <= nowMs) {
        throw new Error('A live lease token, expiry, and hard deadline are required');
      }
      let upload = snapshot.voiceUploads.find((item) => (
        item.sessionId === sessionId && item.clientUploadId === clientUploadId
      ));
      if (upload) {
        if (upload.state === 'failed' && upload.failureCode === 'VOICE_UPLOAD_CANCELLED') {
          return noChange({
            status: 'permanent_failure', upload,
            failureCode: 'VOICE_UPLOAD_CANCELLED', failureHttpStatus: 410, retryable: false,
          });
        }
        if (upload.requestSha256 !== requestSha256 || upload.mimeType !== mimeType) {
          return noChange({ status: 'conflict', upload });
        }
        if (upload.state === 'ready') {
          const mediaAsset = snapshot.mediaAssets.find((asset) => asset.id === upload.mediaAssetId);
          if (!mediaAsset) throw new Error('Atomic store state is corrupt');
          return noChange({ status: 'ready', upload, mediaAsset });
        }
        if (upload.state === 'failed' && !upload.retryable) {
          return noChange({
            status: 'permanent_failure', upload,
            failureCode: upload.failureCode,
            failureHttpStatus: upload.failureHttpStatus,
            retryable: false,
          });
        }
        if (['uploading', 'transcribing'].includes(upload.state) && liveAttempt(upload, nowMs)) {
          return noChange({ status: 'live', upload });
        }
      }

      const { blockingExpiresAt } = rateLimitState(snapshot, rateLimits);
      if (blockingExpiresAt) return noChange({ status: 'rate_limited', blockingExpiresAt });
      this.#assertAttemptStorageKeyAvailable(snapshot, attemptStorageKey, { uploadId: upload?.id });

      if (upload?.attemptStorageKey) {
        const safeHorizon = latestInstant(upload.leaseExpiresAt, upload.attemptDeadlineAt, nowMs) + 60_000;
        enqueueDeletion(snapshot, {
          storageKey: upload.attemptStorageKey,
          reason: 'voice-attempt-displaced',
          notBefore: safeHorizon,
          now: timestamp,
          rearm: true,
        });
      }
      consumeRateLimits(snapshot, rateLimits);
      if (!upload) {
        upload = {
          id: randomUUID(), sessionId, clientUploadId, requestSha256, mimeType,
          createdAt: timestamp,
        };
        snapshot.voiceUploads.push(upload);
      }
      upload.state = 'uploading';
      upload.attempt = Number(upload.attempt || 0) + 1;
      upload.leaseToken = leaseToken;
      upload.leaseExpiresAt = new Date(Math.min(requestedLeaseMs, deadlineMs)).toISOString();
      upload.attemptStorageKey = attemptStorageKey;
      upload.attemptStartedAt = timestamp;
      upload.attemptDeadlineAt = new Date(deadlineMs).toISOString();
      upload.mediaAssetId = null;
      upload.transcript = null;
      upload.failureCode = null;
      upload.failureHttpStatus = null;
      upload.retryable = null;
      upload.updatedAt = timestamp;
      return { status: 'claimed', upload };
    });
  }

  async renewVoiceUploadLease({ uploadId, leaseToken, leaseExpiresAt, now }) {
    return this.#mutate((snapshot) => {
      const upload = this.#liveVoiceLease(snapshot, { uploadId, leaseToken, now });
      const requested = instant(leaseExpiresAt);
      const nowMs = instant(now);
      if (requested <= nowMs) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      upload.leaseExpiresAt = new Date(Math.min(requested, instant(upload.attemptDeadlineAt))).toISOString();
      upload.updatedAt = nowIso(now);
      return upload;
    });
  }

  async setVoiceUploadTranscribing({ uploadId, leaseToken, now }) {
    return this.#mutate((snapshot) => {
      const upload = this.#liveVoiceLease(snapshot, { uploadId, leaseToken, now });
      if (upload.state === 'transcribing') return noChange(upload);
      if (upload.state !== 'uploading') throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      upload.state = 'transcribing';
      upload.updatedAt = nowIso(now);
      return upload;
    });
  }

  async getVoiceUploadStatus({ sessionId, clientUploadId }) {
    return this.#read((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const upload = snapshot.voiceUploads.find((item) => item.sessionId === sessionId && item.clientUploadId === clientUploadId);
      if (!upload) throw storeError('NOT_FOUND', 'The requested voice upload was not found.');
      const mediaAsset = upload.mediaAssetId
        ? snapshot.mediaAssets.find((asset) => asset.id === upload.mediaAssetId && asset.sessionId === sessionId) ?? null
        : null;
      return clone({ ...upload, mediaAsset });
    });
  }

  async cancelVoiceUpload({ sessionId, clientUploadId, cleanupNotBefore, now }) {
    return this.#mutate((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const upload = snapshot.voiceUploads.find((item) => (
        item.sessionId === sessionId && item.clientUploadId === clientUploadId
      ));
      if (!upload) throw storeError('NOT_FOUND', 'The requested voice upload was not found.');
      if (upload.state === 'failed' && upload.failureCode === 'VOICE_UPLOAD_CANCELLED') {
        if (upload.mediaAssetId || upload.transcript || upload.attemptStorageKey) {
          throw new Error('Atomic store state is corrupt');
        }
        return noChange(upload);
      }

      const assetIndex = upload.mediaAssetId
        ? snapshot.mediaAssets.findIndex((asset) => asset.id === upload.mediaAssetId && asset.sessionId === sessionId)
        : -1;
      const asset = assetIndex >= 0 ? snapshot.mediaAssets[assetIndex] : null;
      if (upload.mediaAssetId && !asset) throw new Error('Atomic store state is corrupt');
      if (asset?.status === 'attached' || asset?.ownerMessageId) {
        throw storeError('VOICE_DRAFT_ALREADY_ATTACHED', 'The voice draft is already attached to a message.');
      }

      const timestamp = nowIso(now);
      if (asset) {
        if (asset.kind !== 'user_voice' || asset.status !== 'draft') {
          throw new Error('Atomic store state is corrupt');
        }
        enqueueDeletion(snapshot, {
          storageKey: asset.storageKey,
          reason: 'voice-upload-cancelled-draft',
          notBefore: cleanupNotBefore ?? now,
          now,
          rearm: true,
        });
        snapshot.mediaAssets.splice(assetIndex, 1);
      } else if (upload.attemptStorageKey) {
        const safeHorizon = latestInstant(
          cleanupNotBefore ?? now,
          upload.leaseExpiresAt,
          upload.attemptDeadlineAt,
        ) + ATTEMPT_CLEANUP_GRACE_MS;
        enqueueDeletion(snapshot, {
          storageKey: upload.attemptStorageKey,
          reason: 'voice-upload-cancelled-attempt',
          notBefore: safeHorizon,
          now,
          rearm: true,
        });
      }

      upload.state = 'failed';
      upload.mediaAssetId = null;
      upload.transcript = null;
      upload.failureCode = 'VOICE_UPLOAD_CANCELLED';
      upload.failureHttpStatus = 410;
      upload.retryable = false;
      upload.leaseToken = null;
      upload.leaseExpiresAt = null;
      upload.attemptStorageKey = null;
      upload.updatedAt = timestamp;
      return upload;
    });
  }

  async completeVoiceUpload({ uploadId, leaseToken, mediaAsset, transcript, now }) {
    return this.#mutate((snapshot) => {
      const upload = this.#liveVoiceLease(snapshot, { uploadId, leaseToken, now });
      if (upload.state !== 'transcribing' || typeof transcript !== 'string' || !transcript.trim()
        || mediaAsset?.storageKey !== upload.attemptStorageKey) {
        throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      }
      if (snapshot.mediaAssets.some((asset) => asset.storageKey === mediaAsset.storageKey)) {
        throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      }
      const timestamp = nowIso(now);
      const asset = {
        id: randomUUID(), sessionId: upload.sessionId, ownerMessageId: null,
        kind: 'user_voice', storageKey: mediaAsset.storageKey,
        mimeType: mediaAsset.mimeType, byteLength: mediaAsset.byteLength,
        durationMs: mediaAsset.durationMs ?? null, sha256: mediaAsset.sha256,
        status: 'draft', createdAt: timestamp, updatedAt: timestamp,
        expiresAt: mediaAsset.expiresAt ?? null,
      };
      snapshot.mediaAssets.push(asset);
      upload.state = 'ready';
      upload.mediaAssetId = asset.id;
      upload.transcript = transcript.trim();
      upload.failureCode = null;
      upload.failureHttpStatus = null;
      upload.retryable = false;
      upload.leaseToken = null;
      upload.leaseExpiresAt = null;
      upload.updatedAt = timestamp;
      return { upload, mediaAsset: asset };
    });
  }

  async failVoiceUpload({
    uploadId, leaseToken, failureCode, failureHttpStatus, retryable,
    cleanupNotBefore, now,
  }) {
    return this.#mutate((snapshot) => {
      const upload = this.#liveVoiceLease(snapshot, { uploadId, leaseToken, now });
      const timestamp = nowIso(now);
      if (upload.attemptStorageKey) {
        enqueueDeletion(snapshot, {
          storageKey: upload.attemptStorageKey,
          reason: 'voice-attempt-failed',
          notBefore: cleanupNotBefore ?? now,
          now,
        });
      }
      upload.state = 'failed';
      upload.failureCode = String(failureCode || 'VOICE_TRANSCRIPTION_FAILED');
      upload.failureHttpStatus = Number(failureHttpStatus) || 502;
      upload.retryable = Boolean(retryable);
      upload.leaseToken = null;
      upload.leaseExpiresAt = null;
      upload.attemptStorageKey = null;
      upload.updatedAt = timestamp;
      return upload;
    });
  }

  async claimAssistantAudioWithRateLimits({
    sessionId, messageId, kind, rateLimits = [], leaseToken, attemptStorageKey,
    configVersion, leaseExpiresAt, attemptDeadlineAt, now,
  }) {
    return this.#mutate((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const message = snapshot.messages.find((item) => (
        item.id === messageId && item.sessionId === sessionId
        && item.role === 'assistant' && item.status === 'delivered'
      ));
      if (!message || kind !== 'assistant_voice') return noChange({ status: 'conflict' });
      const timestamp = nowIso(now);
      const nowMs = instant(now);
      const deadlineMs = instant(attemptDeadlineAt);
      const requestedLeaseMs = instant(leaseExpiresAt);
      if (!leaseToken || requestedLeaseMs <= nowMs || deadlineMs <= nowMs) {
        throw new Error('A live lease token, expiry, and hard deadline are required');
      }
      let generation = snapshot.mediaGenerations.find((item) => (
        item.ownerMessageId === messageId && item.kind === kind
      ));
      if (generation) {
        if (generation.state === 'attached') {
          const mediaAsset = snapshot.mediaAssets.find((asset) => asset.id === generation.mediaAssetId);
          if (!mediaAsset) throw new Error('Atomic store state is corrupt');
          return noChange({ status: 'ready', generation, mediaAsset });
        }
        if (generation.state === 'failed' && !generation.retryable) {
          return noChange({
            status: 'permanent_failure', generation,
            failureCode: generation.failureCode,
            failureHttpStatus: generation.failureHttpStatus,
            retryable: false,
          });
        }
        if (generation.state === 'generating' && liveAttempt(generation, nowMs)) {
          return noChange({ status: 'live', generation });
        }
      }
      const { blockingExpiresAt } = rateLimitState(snapshot, rateLimits);
      if (blockingExpiresAt) return noChange({ status: 'rate_limited', blockingExpiresAt });
      this.#assertAttemptStorageKeyAvailable(snapshot, attemptStorageKey, { generationId: generation?.id });
      if (generation?.attemptStorageKey) {
        const safeHorizon = latestInstant(generation.leaseExpiresAt, generation.attemptDeadlineAt, nowMs) + 60_000;
        enqueueDeletion(snapshot, {
          storageKey: generation.attemptStorageKey,
          reason: 'tts-attempt-displaced',
          notBefore: safeHorizon,
          now: timestamp,
          rearm: true,
        });
      }
      consumeRateLimits(snapshot, rateLimits);
      if (!generation) {
        generation = {
          id: randomUUID(), ownerMessageId: messageId, kind, createdAt: timestamp,
        };
        snapshot.mediaGenerations.push(generation);
      }
      generation.state = 'generating';
      generation.attempt = Number(generation.attempt || 0) + 1;
      generation.leaseToken = leaseToken;
      generation.leaseExpiresAt = new Date(Math.min(requestedLeaseMs, deadlineMs)).toISOString();
      generation.attemptStorageKey = attemptStorageKey;
      generation.attemptStartedAt = timestamp;
      generation.attemptDeadlineAt = new Date(deadlineMs).toISOString();
      generation.mediaAssetId = null;
      generation.failureCode = null;
      generation.failureHttpStatus = null;
      generation.retryable = null;
      generation.configVersion = String(configVersion ?? 'unversioned');
      generation.updatedAt = timestamp;
      return { status: 'claimed', generation, message };
    });
  }

  async renewMediaGenerationLease({ generationId, leaseToken, leaseExpiresAt, now }) {
    return this.#mutate((snapshot) => {
      const generation = this.#liveGenerationLease(snapshot, { generationId, leaseToken, now });
      const requested = instant(leaseExpiresAt);
      const nowMs = instant(now);
      if (requested <= nowMs) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      generation.leaseExpiresAt = new Date(Math.min(requested, instant(generation.attemptDeadlineAt))).toISOString();
      generation.updatedAt = nowIso(now);
      return generation;
    });
  }

  async getAssistantAudioStatus({ sessionId, messageId, kind }) {
    return this.#read((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const message = snapshot.messages.find((item) => (
        item.id === messageId && item.sessionId === sessionId
        && item.role === 'assistant' && item.status === 'delivered'
      ));
      if (!message) throw storeError('NOT_FOUND', 'The requested assistant message was not found.');
      const generation = snapshot.mediaGenerations.find((item) => item.ownerMessageId === messageId && item.kind === kind);
      if (!generation) throw storeError('NOT_FOUND', 'The requested assistant audio was not found.');
      const mediaAsset = generation.mediaAssetId
        ? snapshot.mediaAssets.find((asset) => asset.id === generation.mediaAssetId && asset.sessionId === sessionId) ?? null
        : null;
      return clone({ ...generation, mediaAsset });
    });
  }

  async getOwnedAssistantMessage({ sessionId, messageId }) {
    return this.#read((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const message = snapshot.messages.find((item) => (
        item.id === messageId && item.sessionId === sessionId
        && item.role === 'assistant' && item.status === 'delivered'
      ));
      if (!message) throw storeError('NOT_FOUND', 'The requested assistant message was not found.');
      return clone(message);
    });
  }

  async listAssistantAudioRecoveryCandidates({ limit = 25, now } = {}) {
    const maximum = Math.max(1, Math.min(Number(limit) || 25, 25));
    const current = instant(now);
    return this.#read((snapshot) => clone(snapshot.messages
      .filter((message) => (
        message.role === 'assistant' && message.status === 'delivered'
        && !message.mediaId
        && (() => {
          const generation = snapshot.mediaGenerations.find((item) => (
            item.ownerMessageId === message.id && item.kind === 'assistant_voice'
          ));
          return (message.replyMode === 'voice' && !generation)
            || (generation !== undefined && (
              (generation.state === 'failed' && generation.retryable === true)
              || (generation.state === 'generating' && !liveAttempt(generation, current))
            ));
        })()
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, maximum)
      .map((message) => ({
        id: message.id,
        sessionId: message.sessionId,
        replyLanguage: message.replyLanguage,
        replyMode: message.replyMode,
        createdAt: message.createdAt,
      }))));
  }

  async completeMediaGeneration({ generationId, leaseToken, mediaAsset, now }) {
    return this.#mutate((snapshot) => {
      const generation = this.#liveGenerationLease(snapshot, { generationId, leaseToken, now });
      if (mediaAsset?.storageKey !== generation.attemptStorageKey
        || snapshot.mediaAssets.some((asset) => asset.storageKey === mediaAsset.storageKey)) {
        throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      }
      const message = snapshot.messages.find((item) => item.id === generation.ownerMessageId);
      if (!message) throw new Error('Atomic store state is corrupt');
      const timestamp = nowIso(now);
      const asset = {
        id: randomUUID(), sessionId: message.sessionId, ownerMessageId: message.id,
        kind: 'assistant_voice', storageKey: mediaAsset.storageKey,
        mimeType: mediaAsset.mimeType, byteLength: mediaAsset.byteLength,
        durationMs: mediaAsset.durationMs ?? null, sha256: mediaAsset.sha256,
        status: 'attached', createdAt: timestamp, updatedAt: timestamp,
        expiresAt: mediaAsset.expiresAt ?? null,
      };
      snapshot.mediaAssets.push(asset);
      message.mediaId = asset.id;
      generation.state = 'attached';
      generation.mediaAssetId = asset.id;
      generation.failureCode = null;
      generation.failureHttpStatus = null;
      generation.retryable = false;
      generation.leaseToken = null;
      generation.leaseExpiresAt = null;
      generation.updatedAt = timestamp;
      const event = appendEvent(snapshot, {
        sessionId: message.sessionId,
        conversationId: message.conversationId,
        type: 'audio.ready',
        messageId: message.id,
        turnId: message.turnId,
        payloadJson: { messageId: message.id, mediaId: asset.id },
        now,
      });
      return { generation, mediaAsset: asset, message, event };
    });
  }

  async failMediaGeneration({
    generationId, leaseToken, failureCode, failureHttpStatus, retryable,
    cleanupNotBefore, now,
  }) {
    return this.#mutate((snapshot) => {
      const generation = this.#liveGenerationLease(snapshot, { generationId, leaseToken, now });
      if (generation.attemptStorageKey) {
        enqueueDeletion(snapshot, {
          storageKey: generation.attemptStorageKey,
          reason: 'tts-attempt-failed',
          notBefore: cleanupNotBefore ?? now,
          now,
        });
      }
      generation.state = 'failed';
      generation.failureCode = String(failureCode || 'VOICE_SYNTHESIS_FAILED');
      generation.failureHttpStatus = Number(failureHttpStatus) || 502;
      generation.retryable = Boolean(retryable);
      generation.leaseToken = null;
      generation.leaseExpiresAt = null;
      generation.attemptStorageKey = null;
      generation.updatedAt = nowIso(now);
      return generation;
    });
  }

  async getMediaAsset({ sessionId, mediaId }) {
    return this.#read((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const asset = snapshot.mediaAssets.find((item) => item.id === mediaId && item.sessionId === sessionId);
      if (!asset) throw storeError('NOT_FOUND', 'The requested media asset was not found.');
      return clone(asset);
    });
  }

  async revokeVoiceDraft({ sessionId, draftId, now, cleanupNotBefore }) {
    return this.#mutate((snapshot) => {
      this.#activeSession(snapshot, sessionId);
      const index = snapshot.mediaAssets.findIndex((asset) => (
        asset.id === draftId && asset.sessionId === sessionId
        && asset.kind === 'user_voice' && asset.status === 'draft'
      ));
      if (index < 0) throw storeError('NOT_FOUND', 'The requested voice draft was not found.');
      const asset = snapshot.mediaAssets[index];
      enqueueDeletion(snapshot, {
        storageKey: asset.storageKey,
        reason: 'voice-draft-revoked',
        notBefore: cleanupNotBefore ?? now,
        now,
      });
      snapshot.mediaAssets.splice(index, 1);
      const upload = snapshot.voiceUploads.find((item) => item.mediaAssetId === draftId);
      if (upload) {
        upload.state = 'failed';
        upload.mediaAssetId = null;
        upload.transcript = null;
        upload.failureCode = 'VOICE_DRAFT_DELETED';
        upload.failureHttpStatus = 404;
        upload.retryable = false;
        upload.attemptStorageKey = null;
        upload.updatedAt = nowIso(now);
      }
      return { revoked: true, draftId };
    });
  }

  async enqueueMediaDeletion({ storageKey, reason, notBefore, now }) {
    return this.#mutate((snapshot) => enqueueDeletion(snapshot, {
      storageKey, reason, notBefore, now, rearm: false,
    }));
  }

  async rearmMediaDeletionAfterWrite({ storageKey, reason, notBefore, now }) {
    return this.#mutate((snapshot) => enqueueDeletion(snapshot, {
      storageKey, reason, notBefore, now, rearm: true,
    }));
  }

  async rearmMediaDeletionFromSweep({ storageKey, sweepObservation, reason, notBefore, now }) {
    if (typeof sweepObservation !== 'string' || !/^[0-9a-f]{64}$/.test(sweepObservation)) {
      throw new Error('sweepObservation must be a SHA-256 fingerprint');
    }
    return this.#mutate((snapshot) => {
      const existing = snapshot.mediaDeletionJobs.find((item) => item.storageKey === storageKey);
      if (existing?.sweepObservation === sweepObservation) return noChange(existing);
      return enqueueDeletion(snapshot, {
        storageKey, reason, notBefore, now, rearm: Boolean(existing), sweepObservation,
      });
    });
  }

  async claimNextMediaDeletion({ workerId, leaseToken, leaseExpiresAt, now }) {
    return this.#mutate((snapshot) => {
      if (!workerId || !leaseToken || instant(leaseExpiresAt) <= instant(now)) {
        throw new Error('A worker, token, and live lease are required');
      }
      const nowMs = instant(now);
      const eligible = snapshot.mediaDeletionJobs.filter((job) => (
        (job.state === 'pending' && instant(job.notBefore) <= nowMs)
        || (job.state === 'deleting' && job.leaseExpiresAt && instant(job.leaseExpiresAt) <= nowMs)
      )).sort((left, right) => (
        instant(left.notBefore) - instant(right.notBefore)
        || instant(left.createdAt) - instant(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
      const job = eligible[0];
      if (!job) return noChange(null);
      job.state = 'deleting';
      job.attempt = Number(job.attempt || 0) + 1;
      job.workerId = workerId;
      job.leaseToken = leaseToken;
      job.leaseExpiresAt = nowIso(leaseExpiresAt);
      job.updatedAt = nowIso(now);
      return job;
    });
  }

  async completeMediaDeletion({ jobId, generation, leaseToken, now }) {
    return this.#mutate((snapshot) => {
      const job = snapshot.mediaDeletionJobs.find((item) => item.id === jobId);
      if (!job || job.state !== 'deleting' || job.generation !== generation
        || job.leaseToken !== leaseToken || instant(job.leaseExpiresAt) <= instant(now)) {
        throw storeError('LEASE_LOST', 'The cleanup worker no longer owns this job.');
      }
      job.state = 'completed';
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.workerId = null;
      job.lastErrorCode = null;
      job.completedAt = nowIso(now);
      job.updatedAt = nowIso(now);
      return job;
    });
  }

  async failMediaDeletion({ jobId, generation, leaseToken, failureCode, retryAt, now }) {
    return this.#mutate((snapshot) => {
      const job = snapshot.mediaDeletionJobs.find((item) => item.id === jobId);
      if (!job || job.state !== 'deleting' || job.generation !== generation
        || job.leaseToken !== leaseToken || instant(job.leaseExpiresAt) <= instant(now)) {
        throw storeError('LEASE_LOST', 'The cleanup worker no longer owns this job.');
      }
      job.state = 'pending';
      job.notBefore = nowIso(retryAt);
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.workerId = null;
      job.lastErrorCode = String(failureCode || 'MEDIA_DELETE_FAILED').slice(0, 128);
      job.updatedAt = nowIso(now);
      return job;
    });
  }

  async isStorageKeyLive({ storageKey, now }) {
    const nowMs = instant(now);
    const liveAttemptReference = (operation) => {
      if (operation.attemptStorageKey !== storageKey) return false;
      const deadlineMs = new Date(operation.attemptDeadlineAt).getTime();
      return !Number.isFinite(deadlineMs) || nowMs <= deadlineMs + ATTEMPT_CLEANUP_GRACE_MS;
    };
    return this.#read((snapshot) => (
      snapshot.mediaAssets.some((asset) => asset.storageKey === storageKey)
      || snapshot.voiceUploads.some(liveAttemptReference)
      || snapshot.mediaGenerations.some(liveAttemptReference)
    ));
  }

  #revokeSessionSnapshot(snapshot, { sessionId, now, cleanupNotBefore }) {
    this.#activeSession(snapshot, sessionId);
    const baseNotBefore = instant(cleanupNotBefore ?? now);
    const ownedMessages = snapshot.messages.filter((message) => message.sessionId === sessionId);
    const messageIds = new Set(ownedMessages.map((message) => message.id));
    const uploads = snapshot.voiceUploads.filter((upload) => upload.sessionId === sessionId);
    const generations = snapshot.mediaGenerations.filter((generation) => messageIds.has(generation.ownerMessageId));
    const assets = snapshot.mediaAssets.filter((asset) => asset.sessionId === sessionId);

    for (const asset of assets) {
      enqueueDeletion(snapshot, {
        storageKey: asset.storageKey,
        reason: 'session-revoked-asset',
        notBefore: baseNotBefore,
        now,
      });
    }
    for (const operation of [...uploads, ...generations]) {
      if (!operation.attemptStorageKey) continue;
      const horizon = latestInstant(baseNotBefore, operation.leaseExpiresAt, operation.attemptDeadlineAt) + 60_000;
      enqueueDeletion(snapshot, {
        storageKey: operation.attemptStorageKey,
        reason: 'session-revoked-attempt',
        notBefore: horizon,
        now,
      });
    }

    const conversationIds = new Set(snapshot.conversations.filter((item) => item.sessionId === sessionId).map((item) => item.id));
    snapshot.mediaGenerations = snapshot.mediaGenerations.filter((item) => !messageIds.has(item.ownerMessageId));
    snapshot.voiceUploads = snapshot.voiceUploads.filter((item) => item.sessionId !== sessionId);
    snapshot.mediaAssets = snapshot.mediaAssets.filter((item) => item.sessionId !== sessionId);
    snapshot.sessions = snapshot.sessions.filter((item) => item.id !== sessionId);
    snapshot.conversations = snapshot.conversations.filter((item) => item.sessionId !== sessionId);
    snapshot.visitTurns = optionalList(snapshot, 'visitTurns').filter((item) => item.sessionId !== sessionId);
    snapshot.reports = optionalList(snapshot, 'reports').filter((item) => item.sessionId !== sessionId);
    snapshot.messages = snapshot.messages.filter((item) => item.sessionId !== sessionId);
    snapshot.turns = snapshot.turns.filter((item) => item.sessionId !== sessionId);
    snapshot.events = snapshot.events.filter((item) => !conversationIds.has(item.conversationId));
    return { deleted: true, queuedKeys: new Set([...assets, ...uploads, ...generations].map((item) => item.storageKey ?? item.attemptStorageKey).filter(Boolean)).size };
  }

  async revokeSessionAndEnqueueMedia({ sessionId, now, cleanupNotBefore }) {
    return this.#mutate((snapshot) => this.#revokeSessionSnapshot(snapshot, {
      sessionId, now, cleanupNotBefore,
    }));
  }

  async deleteSession({ sessionId }) {
    return this.#mutate((snapshot) => this.#revokeSessionSnapshot(snapshot, {
      sessionId, now: Date.now(), cleanupNotBefore: Date.now(),
    }));
  }

  async listRecoverableTurns() {
    return this.#read((snapshot) => clone(snapshot.turns
      .filter((turn) => !TURN_TERMINAL_STATES.has(turn.state))
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt) || left.id.localeCompare(right.id))));
  }

  async getEventHighWater({ sessionId, conversationId }) {
    return this.#read((snapshot) => {
      const conversation = this.#ownedConversation(snapshot, sessionId, conversationId);
      return Math.max(Number(conversation.eventHighWater) || 0, snapshot.events.reduce((highest, event) => (
        event.conversationId === conversationId ? Math.max(highest, event.cursor) : highest
      ), 0));
    });
  }

  async listEventsPage({ sessionId, conversationId, afterCursor = 0, throughCursor = Number.MAX_SAFE_INTEGER, limit = 100 }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      const after = Number(afterCursor);
      const through = Number(throughCursor);
      const pageLimit = Number(limit);
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(through) || through < after
        || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
        throw new Error('Invalid event page');
      }
      return clone(snapshot.events
        .filter((event) => event.conversationId === conversationId && event.cursor > after && event.cursor <= through)
        .sort((left, right) => left.cursor - right.cursor)
        .slice(0, pageLimit));
    });
  }

  async listEvents({ sessionId, conversationId, afterCursor = 0 }) {
    const highWater = await this.getEventHighWater({ sessionId, conversationId });
    const events = [];
    let cursor = Number(afterCursor);
    while (cursor < highWater) {
      const page = await this.listEventsPage({ sessionId, conversationId, afterCursor: cursor, throughCursor: highWater, limit: 100 });
      if (page.length === 0) break;
      events.push(...page);
      cursor = page.at(-1).cursor;
    }
    return events;
  }

  async consumeRateLimit({ subjectHash, quota, windowStart, limit, expiresAt }) {
    return this.#mutate((snapshot) => {
      let bucket = snapshot.rateLimitBuckets.find((item) => item.subjectHash === subjectHash && item.quota === quota && item.windowStart === windowStart);
      if (!bucket) {
        bucket = { id: randomUUID(), subjectHash, quota, windowStart, count: 0, expiresAt };
        snapshot.rateLimitBuckets.push(bucket);
      }
      if (bucket.count >= limit) return { allowed: false, count: bucket.count, expiresAt: bucket.expiresAt };
      bucket.count += 1;
      return { allowed: true, count: bucket.count, expiresAt: bucket.expiresAt };
    });
  }
}
