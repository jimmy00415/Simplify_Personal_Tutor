import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PostgresStore, productionInstanceLockName } from '../src/stores/postgres-store.js';
import { exerciseDeletionGenerationContract } from './helpers/media-lifecycle-contract.js';

const MIGRATION_URL = new URL('../migrations/001_initial.sql', import.meta.url);
const NOW = '2026-08-25T00:00:00.000Z';

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

class RecordingPool {
  constructor(steps = [], { controlErrors = {} } = {}) {
    this.steps = [...steps];
    this.controlErrors = controlErrors;
    this.calls = [];
    this.releases = 0;
    this.releaseErrors = [];
    this.closed = false;
    this.client = new EventEmitter();
    this.client.query = (query, values) => this.#query(query, values, true);
    this.client.release = (error) => {
      this.releases += 1;
      this.releaseErrors.push(error ?? null);
    };
  }

  async connect() {
    this.calls.push({ text: 'CONNECT', values: [], transactional: true });
    return this.client;
  }

  async query(query, values) {
    return this.#query(query, values, false);
  }

  async end() { this.closed = true; }

  async #query(query, values = [], transactional) {
    const config = query && typeof query === 'object'
      ? query
      : { text: query, values };
    const normalized = String(config.text).trim();
    const boundValues = Array.isArray(config.values) ? config.values : [];
    this.calls.push({
      text: normalized,
      values: [...boundValues],
      transactional,
      signal: config.signal,
    });
    if (this.controlErrors[normalized.toUpperCase()]) throw this.controlErrors[normalized.toUpperCase()];
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return result();
    const step = this.steps.shift();
    assert.ok(step, `Unexpected SQL: ${normalized}`);
    if (step.match) assert.match(normalized, step.match);
    if (step.error) throw step.error;
    if (step.run) return step.run({
      text: normalized,
      values: [...boundValues],
      transactional,
      signal: config.signal,
    });
    return step.result ?? result();
  }

  assertDrained() { assert.equal(this.steps.length, 0, 'all scripted SQL outcomes must be consumed'); }
}

function transactionWords(pool) {
  return pool.calls.map((call) => call.text).filter((text) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(text));
}

function sessionRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    token_hash: 'a'.repeat(64),
    client_scope_id: '22222222-2222-4222-8222-222222222222',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function conversationRow(overrides = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    session_id: '11111111-1111-4111-8111-111111111111',
    event_high_water: '0',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function retentionStateRow(overrides = {}) {
  return {
    name: 'retention',
    payload_json: {
      workerId: 'retention-worker',
      runToken: '81818181-8181-4818-8818-818181818181',
      status: 'running',
      policyVersion: 'retention-v1',
      stoppedAt: null,
    },
    heartbeat_at: NOW,
    last_success_at: null,
    updated_at: NOW,
    ...overrides,
  };
}

test('postgres migration encodes durable ownership, ordering, fencing, quota, and outbox invariants', async () => {
  const sql = await readFile(MIGRATION_URL, 'utf8');

  for (const table of [
    'sessions', 'conversations', 'messages', 'turns', 'events', 'rate_limit_buckets',
    'service_state', 'media_assets', 'voice_uploads', 'media_generations',
    'media_deletion_jobs',
  ]) assert.match(sql, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\b`, 'i'), table);

  assert.match(sql, /client_scope_id\s+uuid\s+NOT NULL\s+UNIQUE/i);
  assert.match(sql, /UNIQUE\s*\(\s*conversation_id\s*,\s*sequence\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*conversation_id\s*,\s*client_message_id\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*conversation_id\s*,\s*cursor\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*session_id\s*,\s*client_upload_id\s*\)/i);
  assert.match(sql, /UNIQUE\s*\(\s*owner_message_id\s*,\s*kind\s*\)/i);
  assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*messages[\s\S]*turn_id[\s\S]*role\s*=\s*'assistant'/i);
  assert.match(sql, /request_hash\s+char\s*\(\s*64\s*\)\s+NOT NULL/i);
  assert.match(sql, /reply_language\s+text\s+NOT NULL\s+CHECK\s*\(\s*reply_language\s+IN\s*\(\s*'en'\s*,\s*'yue-Hant-HK'\s*,\s*'cmn-Hans-CN'\s*\)\s*\)/i);
  assert.match(sql, /reply_mode\s+text\s+NOT NULL\s+CHECK\s*\(\s*reply_mode\s+IN\s*\(\s*'text'\s*,\s*'voice'\s*\)\s*\)/i);
  assert.match(sql, /lease_token\s+uuid/i);
  assert.match(sql, /lease_expires_at\s+timestamptz/i);
  assert.match(sql, /payload_json\s+jsonb\s+NOT NULL/i);
  assert.match(sql, /citations\s+jsonb\s+NOT NULL/i);
  assert.match(sql, /cards\s+jsonb\s+NOT NULL/i);
  assert.match(sql, /storage_key\s+text\s+NOT NULL\s+UNIQUE/i);
  assert.match(sql, /REFERENCES\s+sessions\s*\(id\)\s+ON DELETE CASCADE/i);
  assert.match(sql, /REFERENCES\s+messages\s*\(id\)\s+ON DELETE CASCADE/i);
  assert.match(sql, /CREATE INDEX[\s\S]*turns[\s\S]*lease_expires_at[\s\S]*WHERE[\s\S]*state/i);
  assert.match(sql, /CREATE INDEX[\s\S]*voice_uploads[\s\S]*lease_expires_at/i);
  assert.match(sql, /CREATE INDEX[\s\S]*media_generations[\s\S]*lease_expires_at/i);
  assert.match(sql, /CREATE INDEX[\s\S]*media_deletion_jobs\s*\(\s*state\s*,\s*not_before\s*,\s*lease_expires_at\s*\)/i);

  const deletionTable = sql.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+media_deletion_jobs\s*\(([\s\S]*?)\);/i)?.[1] ?? '';
  assert.doesNotMatch(deletionTable, /REFERENCES/i, 'outbox rows must survive cascading owner deletion');
});

test('postgres adapter exposes every storage operation used by HTTP and background services', () => {
  const store = new PostgresStore({ pool: new RecordingPool() });
  const methods = [
    'init', 'close', 'createOrResumeSession', 'getSessionByTokenHash',
    'getConversationForSession', 'getOrCreateConversation', 'recordConsent',
    'withdrawVoiceConsent', 'getConsent', 'getVisitTurn', 'createVisitTurn',
    'createReport',
    'getAcceptedMessage', 'acceptMessage',
    'acceptMessageWithRateLimits', 'listMessages', 'getActiveTurn', 'claimNextTurn',
    'renewTurnLease', 'setTurnState', 'getTurnContext', 'failTurn',
    'deliverAssistant', 'claimVoiceUploadWithRateLimits', 'renewVoiceUploadLease',
    'setVoiceUploadTranscribing', 'getVoiceUploadStatus', 'cancelVoiceUpload',
    'completeVoiceUpload', 'failVoiceUpload', 'claimAssistantAudioWithRateLimits',
    'renewMediaGenerationLease', 'getAssistantAudioStatus',
    'getOwnedAssistantMessage', 'completeMediaGeneration', 'failMediaGeneration',
    'getMediaAsset', 'revokeVoiceDraft', 'enqueueMediaDeletion',
    'rearmMediaDeletionAfterWrite', 'rearmMediaDeletionFromSweep',
    'claimNextMediaDeletion', 'completeMediaDeletion', 'failMediaDeletion',
    'isStorageKeyLive', 'revokeSessionAndEnqueueMedia', 'deleteSession',
    'listRecoverableTurns', 'getEventHighWater', 'listEventsPage', 'listEvents',
    'consumeRateLimit', 'healthCheck', 'dispatcherHealthCheck', 'acquireInstanceLock',
    'recordRetentionHeartbeat', 'purgeExpired',
    'hasPendingMediaDeletions', 'recordRetentionSuccess', 'recordRetentionStopped',
    'getRetentionState',
  ];
  for (const method of methods) assert.equal(typeof store[method], 'function', method);
});

test('postgres health check returns only a safe driver status on success or failure', async () => {
  const healthyPool = new RecordingPool([
    { match: /^SELECT\s+1\s+AS\s+ok$/i, result: result([{ ok: 1 }]) },
  ]);
  const unhealthyPool = new RecordingPool([
    {
      match: /^SELECT\s+1\s+AS\s+ok$/i,
      error: new Error('connection refused: postgresql://secret@private.example/db'),
    },
  ]);

  assert.deepEqual(
    await new PostgresStore({ pool: healthyPool }).healthCheck(),
    { ok: true, driver: 'postgres' },
  );
  const unhealthy = await new PostgresStore({ pool: unhealthyPool }).healthCheck();
  assert.deepEqual(unhealthy, { ok: false, driver: 'postgres', code: 'DATABASE_UNAVAILABLE' });
  assert.doesNotMatch(JSON.stringify(unhealthy), /secret|private\.example|postgresql:\/\//i);
  assert.deepEqual(healthyPool.calls[0].values, []);
  healthyPool.assertDrained();
  unhealthyPool.assertDrained();

  const preAbortedPool = new RecordingPool([]);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await new PostgresStore({ pool: preAbortedPool }).healthCheck({ signal: controller.signal }), {
    ok: false, driver: 'postgres', code: 'DATABASE_UNAVAILABLE',
  });
  assert.equal(preAbortedPool.calls.length, 0, 'an already-aborted readiness check starts no query');
});

test('aborted PostgreSQL readiness destroys its checked-out query before a later probe can start', async () => {
  const querySignals = [];
  const releaseErrors = [];
  let queryCalls = 0;
  let activeQueries = 0;
  let maximumActiveQueries = 0;
  const pool = {
    query: async () => assert.fail('signal-aware health checks require an owned client'),
    connect: async () => {
      const client = new EventEmitter();
      client.query = (config) => {
        queryCalls += 1;
        querySignals.push(config?.signal);
        activeQueries += 1;
        maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries);
        if (queryCalls === 2) {
          activeQueries -= 1;
          return Promise.resolve(result([{ ok: 1 }]));
        }
        return new Promise((resolve, reject) => {
          void resolve;
          config?.signal?.addEventListener('abort', () => {
            activeQueries -= 1;
            reject(Object.assign(new Error('private cancelled query'), { name: 'AbortError' }));
          }, { once: true });
        });
      };
      client.release = (error) => releaseErrors.push(error ?? null);
      return client;
    },
  };
  const store = new PostgresStore({ pool });
  const firstController = new AbortController();
  const first = store.healthCheck({ signal: firstController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  firstController.abort();
  assert.deepEqual(await first, { ok: false, driver: 'postgres', code: 'DATABASE_UNAVAILABLE' });
  assert.equal(activeQueries, 0, 'the aborted dependency query settles before the caller returns');
  assert.equal(releaseErrors.length, 1);
  assert.ok(releaseErrors[0] instanceof Error, 'an aborted pg client is destroyed, not returned idle');

  const secondController = new AbortController();
  assert.deepEqual(await store.healthCheck({ signal: secondController.signal }), {
    ok: true, driver: 'postgres',
  });
  assert.equal(queryCalls, 2);
  assert.equal(maximumActiveQueries, 1, 'a cancelled query cannot overlap the recovery probe');
  assert.deepEqual(querySignals, [firstController.signal, secondController.signal]);
});

test('signal-aware PostgreSQL readiness contains a checked-out client error and destroys that session', async () => {
  const client = new EventEmitter();
  let releases = 0;
  let releaseError = null;
  client.query = async () => new Promise(() => undefined);
  client.release = (error) => {
    releases += 1;
    releaseError = error;
  };
  const store = new PostgresStore({
    pool: {
      query: async () => assert.fail('signal-aware readiness must own its client'),
      connect: async () => client,
    },
  });
  const controller = new AbortController();
  const checking = store.healthCheck({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotThrow(() => client.emit('error', new Error('postgres://private-readiness-host/db')));
  assert.deepEqual(await checking, { ok: false, driver: 'postgres', code: 'DATABASE_UNAVAILABLE' });
  assert.equal(releases, 1);
  assert.ok(releaseError instanceof Error);
});

test('dispatcher health check plans every real turn-claim dependency without consuming work', async () => {
  const healthyPool = new RecordingPool([
    {
      match: /EXPLAIN[\s\S]*WITH candidate[\s\S]*JOIN messages inbound[\s\S]*FOR UPDATE OF t SKIP LOCKED[\s\S]*LIMIT 1[\s\S]*UPDATE turns/i,
      result: result(),
    },
  ]);
  const unhealthyPool = new RecordingPool([
    {
      match: /EXPLAIN[\s\S]*WITH candidate[\s\S]*JOIN messages inbound[\s\S]*UPDATE turns/i,
      error: new Error('permission denied at postgresql://private-user:secret@internal.example/db'),
    },
  ]);

  assert.deepEqual(await new PostgresStore({ pool: healthyPool }).dispatcherHealthCheck(), {
    ok: true, driver: 'postgres', capability: 'turn-claim',
  });
  const unhealthy = await new PostgresStore({ pool: unhealthyPool }).dispatcherHealthCheck();
  assert.deepEqual(unhealthy, {
    ok: false, driver: 'postgres', capability: 'turn-claim', code: 'DISPATCHER_UNAVAILABLE',
  });
  assert.doesNotMatch(JSON.stringify(unhealthy), /secret|internal\.example|postgresql:\/\//i);
  assert.match(healthyPool.calls[0].text, /t\.lease_token[\s\S]*t\.lease_expires_at/i);
  assert.match(healthyPool.calls[0].text, /SET worker_id\s*=\s*\$1[\s\S]*lease_token\s*=\s*\$2[\s\S]*attempt\s*=\s*t\.attempt \+ 1/i);
  assert.equal(healthyPool.calls[0].values.length, 4, 'the planned statement must bind the real claim tuple');
  healthyPool.assertDrained();
  unhealthyPool.assertDrained();
});

test('singleton advisory lock is held on one dedicated connection until idempotent release', async () => {
  const lockName = 'hong-kong-buddy-production-v1';
  const ownedPool = new RecordingPool([
    { match: /pg_try_advisory_lock[\s\S]*hashtextextended/i, result: result([{ acquired: true }]) },
    { match: /pg_advisory_unlock[\s\S]*hashtextextended/i, result: result([{ released: true }]) },
  ]);
  const owned = await new PostgresStore({ pool: ownedPool }).acquireInstanceLock({ name: lockName });
  assert.equal(owned.owned, true);
  assert.equal(ownedPool.releases, 0, 'the session lock connection stays checked out');
  await Promise.all([owned.release(), owned.release()]);
  assert.equal(ownedPool.releases, 1);
  assert.equal(ownedPool.calls.filter((call) => /pg_advisory_unlock/i.test(call.text)).length, 1);
  assert.ok(ownedPool.calls.some((call) => call.values.includes(lockName)));
  ownedPool.assertDrained();

  const deniedPool = new RecordingPool([
    { match: /pg_try_advisory_lock[\s\S]*hashtextextended/i, result: result([{ acquired: false }]) },
  ]);
  const denied = await new PostgresStore({ pool: deniedPool }).acquireInstanceLock({ name: lockName });
  assert.equal(denied.owned, false);
  await denied.release();
  assert.equal(deniedPool.releases, 1);
  deniedPool.assertDrained();
});

test('singleton lock loss on a dedicated client error or end is contained and reported exactly once', async (t) => {
  for (const eventName of ['error', 'end']) {
    await t.test(eventName, async () => {
      const pool = new RecordingPool([
        { match: /pg_try_advisory_lock[\s\S]*hashtextextended/i, result: result([{ acquired: true }]) },
      ]);
      let losses = 0;
      const lock = await new PostgresStore({ pool }).acquireInstanceLock({
        name: productionInstanceLockName,
        onLost: () => { losses += 1; },
      });
      assert.equal(lock.isOwned(), true);
      if (eventName === 'error') {
        assert.doesNotThrow(() => pool.client.emit('error', new Error('postgres://private-lock-host/db')));
      } else {
        assert.doesNotThrow(() => pool.client.emit('end'));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(lock.owned, false);
      assert.equal(lock.isOwned(), false);
      assert.equal(losses, 1);
      assert.equal(pool.releases, 1, 'the unusable dedicated connection is removed once');

      pool.client.emit('end');
      await lock.release();
      assert.equal(losses, 1, 'duplicate events and cleanup do not repeat the loss transition');
      assert.equal(pool.releases, 1);
      pool.assertDrained();
    });
  }
});

test('singleton lock health is checked on its owning session and loss is fail-closed without reacquisition', async () => {
  const pool = new RecordingPool([
    { match: /pg_try_advisory_lock[\s\S]*hashtextextended/i, result: result([{ acquired: true }]) },
    { match: /FROM pg_locks[\s\S]*pg_backend_pid/i, result: result([{ owned: false }]) },
  ]);
  let losses = 0;
  const lock = await new PostgresStore({ pool }).acquireInstanceLock({
    name: productionInstanceLockName,
    onLost: () => { losses += 1; },
  });
  const controller = new AbortController();
  assert.deepEqual(await lock.healthCheck({ signal: controller.signal }), { owned: false });
  assert.equal(lock.isOwned(), false);
  assert.equal(losses, 1);
  assert.equal(pool.calls.filter((call) => /pg_try_advisory_lock/i.test(call.text)).length, 1,
    'lock supervision never silently reacquires');
  assert.equal(pool.calls.find((call) => /FROM pg_locks/i.test(call.text))?.signal, controller.signal);
  assert.equal(pool.releases, 1);
  pool.assertDrained();
});

test('intentional singleton release suppresses lock-loss notification', async () => {
  const pool = new RecordingPool([
    { match: /pg_try_advisory_lock[\s\S]*hashtextextended/i, result: result([{ acquired: true }]) },
    { match: /pg_advisory_unlock[\s\S]*hashtextextended/i, result: result([{ released: true }]) },
  ]);
  let losses = 0;
  const lock = await new PostgresStore({ pool }).acquireInstanceLock({
    name: productionInstanceLockName,
    onLost: () => { losses += 1; },
  });
  await lock.release();
  pool.client.emit('end');
  assert.equal(lock.isOwned(), false);
  assert.equal(losses, 0);
  assert.equal(pool.releases, 1);
  pool.assertDrained();
});

test('session bootstrap commits atomically, returns a stable scope, and parameterizes the token hash', async () => {
  const pool = new RecordingPool([
    { match: /pg_advisory_xact_lock/i, result: result([{ locked: true }]) },
    { match: /FROM sessions[\s\S]*token_hash\s*=\s*\$1/i, result: result() },
    { match: /INSERT INTO sessions/i, result: result([sessionRow()]) },
    { match: /INSERT INTO conversations/i, result: result([conversationRow()]) },
    { match: /pg_advisory_xact_lock/i, result: result([{ locked: true }]) },
    { match: /FROM sessions[\s\S]*token_hash\s*=\s*\$1/i, result: result([sessionRow()]) },
    { match: /FROM conversations/i, result: result([conversationRow()]) },
  ]);
  const store = new PostgresStore({ pool });
  const tokenHash = `malicious-'${'a'.repeat(52)}`;

  const created = await store.createOrResumeSession({ tokenHash, now: NOW });
  const resumed = await store.createOrResumeSession({ tokenHash, now: '2026-08-25T00:01:00.000Z' });

  assert.equal(created.created, true);
  assert.equal(resumed.created, false);
  assert.equal(resumed.session.clientScopeId, created.session.clientScopeId);
  assert.equal(resumed.conversation.id, created.conversation.id);
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  const tokenQuery = pool.calls.find((call) => /FROM sessions[\s\S]*token_hash/i.test(call.text));
  assert.ok(tokenQuery.values.includes(tokenHash));
  assert.equal(tokenQuery.text.includes(tokenHash), false);
  assert.equal(pool.releases, 2);
  pool.assertDrained();
});

test('client scope is bootstrap correlation only and never authenticates a session', async () => {
  const scope = '22222222-2222-4222-8222-222222222222';
  const pool = new RecordingPool([
    { match: /FROM sessions[\s\S]*token_hash\s*=\s*\$1/i, result: result() },
    { match: /FROM conversations[\s\S]*id\s*=\s*\$1[\s\S]*session_id\s*=\s*\$2/i, result: result() },
  ]);
  const store = new PostgresStore({ pool });

  assert.equal(await store.getSessionByTokenHash(scope), null);
  await assert.rejects(
    store.listMessages({ sessionId: scope, conversationId: conversationRow().id, after: 0 }),
    { code: 'NOT_FOUND' },
  );
  assert.equal(pool.calls.some((call) => /client_scope_id\s*=/.test(call.text)), false);
  pool.assertDrained();
});

test('message acceptance serializes sequence allocation, commits event truth, and never interpolates text', async () => {
  const messageRow = {
    id: '44444444-4444-4444-8444-444444444444',
    session_id: sessionRow().id,
    conversation_id: conversationRow().id,
    turn_id: '55555555-5555-4555-8555-555555555555',
    client_message_id: '66666666-6666-4666-8666-666666666666',
    sequence: '1', role: 'user', kind: 'text', status: 'accepted',
    failure_code: null, text: "Duo'; DROP TABLE sessions; --",
    voice_draft_id: null, media_id: null, citations: [], cards: [],
    suggested_replies: [], needs_clarification: false, grounding_status: null,
    reply_language: 'cmn-Hans-CN', reply_mode: 'voice',
    provider: null, provider_latency_ms: null, created_at: NOW,
  };
  const turnRow = {
    id: messageRow.turn_id, session_id: sessionRow().id,
    conversation_id: conversationRow().id, user_message_id: messageRow.id,
    request_hash: 'b'.repeat(64), state: 'accepted', failure_code: null,
    reply_language: 'cmn-Hans-CN', reply_mode: 'voice',
    attempt: 0, lease_token: null, lease_expires_at: null, worker_id: null,
    created_at: NOW, updated_at: NOW,
  };
  const eventRow = {
    id: '77777777-7777-4777-8777-777777777777', session_id: sessionRow().id,
    conversation_id: conversationRow().id, cursor: '1', type: 'message.accepted',
    message_id: messageRow.id, turn_id: turnRow.id,
    payload_json: { messageId: messageRow.id, turnId: turnRow.id }, created_at: NOW,
  };
  const pool = new RecordingPool([
    { match: /FROM sessions[\s\S]*FOR UPDATE/i, result: result([sessionRow()]) },
    { match: /FROM conversations[\s\S]*FOR UPDATE/i, result: result([conversationRow()]) },
    { match: /client_message_id\s*=\s*\$2/i, result: result() },
    { match: /MAX\s*\(\s*sequence\s*\)/i, result: result([{ next_sequence: '1' }]) },
    { match: /UPDATE conversations[\s\S]*event_high_water/i, result: result([{ event_high_water: '1' }]) },
    { match: /INSERT INTO messages/i, result: result([messageRow]) },
    { match: /INSERT INTO turns/i, result: result([turnRow]) },
    { match: /INSERT INTO events/i, result: result([eventRow]) },
  ]);
  const store = new PostgresStore({ pool });

  const accepted = await store.acceptMessage({
    sessionId: sessionRow().id,
    conversationId: conversationRow().id,
    clientMessageId: messageRow.client_message_id,
    requestHash: turnRow.request_hash,
    text: messageRow.text,
    replyLanguage: 'cmn-Hans-CN',
    replyMode: 'voice',
    now: NOW,
  });

  assert.equal(accepted.message.text, messageRow.text);
  assert.equal(accepted.message.sequence, 1);
  assert.equal(accepted.event.cursor, 1);
  assert.equal(accepted.message.replyLanguage, 'cmn-Hans-CN');
  assert.equal(accepted.turn.replyMode, 'voice');
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'COMMIT']);
  const insert = pool.calls.find((call) => /INSERT INTO messages/i.test(call.text));
  assert.ok(insert.values.includes(messageRow.text));
  assert.ok(insert.values.includes('cmn-Hans-CN'));
  assert.ok(insert.values.includes('voice'));
  assert.equal(insert.text.includes(messageRow.text), false);
  const sessionLock = pool.calls.findIndex((call) => /FROM sessions[\s\S]*FOR UPDATE/i.test(call.text));
  const conversationLock = pool.calls.findIndex((call) => /FROM conversations[\s\S]*FOR UPDATE/i.test(call.text));
  assert.equal(sessionLock >= 0 && sessionLock < conversationLock, true,
    'message acceptance must lock session before conversation');
  pool.assertDrained();
});

test('a failed multi-row message write rolls back and releases the transaction client', async () => {
  const pool = new RecordingPool([
    { match: /FROM sessions[\s\S]*FOR UPDATE/i, result: result([sessionRow()]) },
    { match: /FROM conversations[\s\S]*FOR UPDATE/i, result: result([conversationRow()]) },
    { match: /client_message_id\s*=\s*\$2/i, result: result() },
    { match: /MAX\s*\(\s*sequence\s*\)/i, result: result([{ next_sequence: '1' }]) },
    { match: /UPDATE conversations[\s\S]*event_high_water/i, result: result([{ event_high_water: '1' }]) },
    { match: /INSERT INTO messages/i, error: Object.assign(new Error('disk full'), { code: 'XX000' }) },
  ]);
  const store = new PostgresStore({ pool });

  await assert.rejects(store.acceptMessage({
    sessionId: sessionRow().id, conversationId: conversationRow().id,
    clientMessageId: '66666666-6666-4666-8666-666666666666',
    requestHash: 'b'.repeat(64), text: 'rollback me', now: NOW,
  }), /disk full/);

  assert.deepEqual(transactionWords(pool), ['BEGIN', 'ROLLBACK']);
  assert.equal(pool.releases, 1);
  pool.assertDrained();
});

test('a failed BEGIN still releases the checked-out PostgreSQL client', async () => {
  const pool = new RecordingPool([], { controlErrors: { BEGIN: new Error('database unavailable') } });
  const store = new PostgresStore({ pool });

  await assert.rejects(
    store.createOrResumeSession({ tokenHash: 'a'.repeat(64), now: NOW }),
    /database unavailable/,
  );

  assert.equal(pool.releases, 1);
  assert.deepEqual(transactionWords(pool), ['BEGIN']);
});

test('turn claim uses earliest-work SKIP LOCKED SQL and stale fencing tokens are rejected', async () => {
  const claimedTurn = {
    id: '55555555-5555-4555-8555-555555555555', session_id: sessionRow().id,
    conversation_id: conversationRow().id,
    user_message_id: '44444444-4444-4444-8444-444444444444',
    request_hash: 'b'.repeat(64), state: 'accepted', failure_code: null,
    attempt: 1, lease_token: '88888888-8888-4888-8888-888888888888',
    lease_expires_at: '2026-08-25T00:00:30.000Z', worker_id: 'worker-one',
    created_at: NOW, updated_at: NOW,
  };
  const pool = new RecordingPool([
    { match: /FOR UPDATE\s+OF\s+t\s+SKIP LOCKED/i, result: result([claimedTurn]) },
    { match: /UPDATE turns/i, result: result() },
  ]);
  const store = new PostgresStore({ pool });
  const claimed = await store.claimNextTurn({
    workerId: 'worker-one', leaseToken: claimedTurn.lease_token,
    now: NOW, leaseUntil: claimedTurn.lease_expires_at,
  });
  await assert.rejects(store.renewTurnLease({
    turnId: claimed.id, leaseToken: '99999999-9999-4999-8999-999999999999',
    now: NOW, leaseUntil: '2026-08-25T00:01:00.000Z',
  }), { code: 'LEASE_LOST' });

  const claimSql = pool.calls.find((call) => /SKIP LOCKED/i.test(call.text));
  assert.match(claimSql.text, /NOT EXISTS/i);
  assert.match(claimSql.text, /earlier/i);
  assert.equal(claimSql.text.includes(claimedTurn.lease_token), false);
  assert.ok(claimSql.values.includes(claimedTurn.lease_token));
  pool.assertDrained();
});

test('turn mutations lock the owning session before the turn so session deletion cannot deadlock them', async () => {
  const turn = {
    id: '54545454-5454-4545-8545-545454545454', session_id: sessionRow().id,
    conversation_id: conversationRow().id,
    user_message_id: '43434343-4343-4434-8434-434343434343',
    request_hash: '4'.repeat(64), state: 'accepted', failure_code: null,
    attempt: 1, lease_token: '32323232-3232-4323-8323-323232323232',
    lease_expires_at: '2026-08-25T00:01:00.000Z', worker_id: 'worker-lock',
    created_at: NOW, updated_at: NOW,
  };
  const updatedTurn = { ...turn, state: 'retrieving', updated_at: '2026-08-25T00:00:01.000Z' };
  const event = {
    id: '21212121-2121-4212-8212-212121212121', session_id: sessionRow().id,
    conversation_id: conversationRow().id, cursor: '1', type: 'turn.state',
    message_id: null, turn_id: turn.id,
    payload_json: { turnId: turn.id, state: 'retrieving' },
    created_at: updatedTurn.updated_at,
  };
  const pool = new RecordingPool([
    {
      match: /SELECT\s+session_id\s*,\s*conversation_id\s+FROM turns/i,
      result: result([{ session_id: sessionRow().id, conversation_id: conversationRow().id }]),
    },
    { match: /FROM sessions[\s\S]*FOR UPDATE/i, result: result([sessionRow()]) },
    { match: /FROM conversations[\s\S]*FOR UPDATE/i, result: result([conversationRow()]) },
    { match: /FROM turns[\s\S]*lease_token[\s\S]*FOR UPDATE/i, result: result([turn]) },
    { match: /UPDATE turns/i, result: result([updatedTurn]) },
    { match: /UPDATE conversations[\s\S]*event_high_water/i, result: result([{ event_high_water: '1' }]) },
    { match: /INSERT INTO events/i, result: result([event]) },
  ]);
  const store = new PostgresStore({ pool });

  const changed = await store.setTurnState({
    turnId: turn.id, leaseToken: turn.lease_token, state: 'retrieving',
    now: updatedTurn.updated_at,
  });

  assert.equal(changed.turn.state, 'retrieving');
  const sessionLock = pool.calls.findIndex((call) => /FROM sessions[\s\S]*FOR UPDATE/i.test(call.text));
  const conversationLock = pool.calls.findIndex((call) => /FROM conversations[\s\S]*FOR UPDATE/i.test(call.text));
  const turnLock = pool.calls.findIndex((call) => /FROM turns[\s\S]*lease_token[\s\S]*FOR UPDATE/i.test(call.text));
  assert.equal(sessionLock >= 0 && sessionLock < conversationLock && conversationLock < turnLock, true);
  pool.assertDrained();
});

test('assistant delivery locks session then conversation then turn', async () => {
  const turn = {
    id: '51515151-5151-4515-8515-515151515151', session_id: sessionRow().id,
    conversation_id: conversationRow().id,
    user_message_id: '41414141-4141-4414-8414-414141414141',
    request_hash: '5'.repeat(64), state: 'generating', failure_code: null,
    attempt: 1, lease_token: '31313131-3131-4313-8313-313131313131',
    lease_expires_at: '2026-08-25T00:01:00.000Z', worker_id: 'worker-deliver',
    created_at: NOW, updated_at: NOW,
  };
  const assistant = {
    id: '61616161-6161-4616-8616-616161616161', session_id: turn.session_id,
    conversation_id: turn.conversation_id, turn_id: turn.id, client_message_id: null,
    sequence: '2', role: 'assistant', kind: 'text', status: 'delivered',
    failure_code: null, text: 'Grounded answer', voice_draft_id: null, media_id: null,
    citations: [], cards: [], suggested_replies: [], needs_clarification: false,
    grounding_status: 'verified', provider: 'fake', provider_latency_ms: 12,
    created_at: NOW,
  };
  const deliveredTurn = {
    ...turn, state: 'delivered', lease_token: null, lease_expires_at: null,
    worker_id: null, updated_at: NOW,
  };
  const event = {
    id: '71717171-7171-4717-8717-717171717171', session_id: turn.session_id,
    conversation_id: turn.conversation_id, cursor: '1', type: 'message.delivered',
    message_id: assistant.id, turn_id: turn.id,
    payload_json: { messageId: assistant.id, turnId: turn.id }, created_at: NOW,
  };
  const pool = new RecordingPool([
    {
      match: /SELECT\s+session_id\s*,\s*conversation_id\s+FROM turns/i,
      result: result([{ session_id: turn.session_id, conversation_id: turn.conversation_id }]),
    },
    { match: /FROM sessions[\s\S]*FOR UPDATE/i, result: result([sessionRow()]) },
    { match: /FROM conversations[\s\S]*FOR UPDATE/i, result: result([conversationRow()]) },
    { match: /FROM turns[\s\S]*lease_token[\s\S]*FOR UPDATE/i, result: result([turn]) },
    { match: /FROM messages[\s\S]*turn_id[\s\S]*role\s*=\s*'assistant'[\s\S]*FOR UPDATE/i, result: result() },
    { match: /MAX\s*\(\s*sequence\s*\)/i, result: result([{ next_sequence: '2' }]) },
    { match: /INSERT INTO messages/i, result: result([assistant]) },
    { match: /UPDATE messages[\s\S]*status\s*=\s*'delivered'/i, result: result([{ id: turn.user_message_id }]) },
    { match: /UPDATE turns[\s\S]*state\s*=\s*'delivered'/i, result: result([deliveredTurn]) },
    { match: /UPDATE conversations[\s\S]*event_high_water/i, result: result([{ event_high_water: '1' }]) },
    { match: /INSERT INTO events/i, result: result([event]) },
  ]);
  const store = new PostgresStore({ pool });

  const delivered = await store.deliverAssistant({
    turnId: turn.id,
    leaseToken: turn.lease_token,
    message: {
      text: assistant.text, citations: [], cards: [], suggestedReplies: [],
      groundingStatus: 'verified', provider: 'fake', providerLatencyMs: 12,
    },
    now: NOW,
  });

  assert.equal(delivered.message.id, assistant.id);
  const sessionLock = pool.calls.findIndex((call) => /FROM sessions[\s\S]*FOR UPDATE/i.test(call.text));
  const conversationLock = pool.calls.findIndex((call) => /FROM conversations[\s\S]*FOR UPDATE/i.test(call.text));
  const turnLock = pool.calls.findIndex((call) => /FROM turns[\s\S]*lease_token[\s\S]*FOR UPDATE/i.test(call.text));
  assert.equal(sessionLock < conversationLock && conversationLock < turnLock, true);
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'COMMIT']);
  pool.assertDrained();
});

test('live ASR and delivered-assistant TTS claims are observed under row locks instead of double-claimed', async () => {
  const voice = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session_id: sessionRow().id,
    client_upload_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    request_sha256: 'c'.repeat(64), mime_type: 'audio/wav', state: 'uploading',
    attempt: 1, lease_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    lease_expires_at: '2026-08-25T00:00:30.000Z',
    attempt_deadline_at: '2026-08-25T00:05:00.000Z',
    attempt_storage_key: 'attempts/voice/one', attempt_started_at: NOW,
    media_asset_id: null, transcript: null, failure_code: null,
    failure_http_status: null, retryable: null, created_at: NOW, updated_at: NOW,
  };
  const message = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', session_id: sessionRow().id,
    conversation_id: conversationRow().id, turn_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    sequence: '2', role: 'assistant', kind: 'text', status: 'delivered', text: 'answer',
    reply_language: 'en', reply_mode: 'text',
    created_at: NOW,
  };
  const generation = {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', owner_message_id: message.id,
    kind: 'assistant_voice', state: 'generating', attempt: 1,
    lease_token: '12121212-1212-4212-8212-121212121212',
    lease_expires_at: '2026-08-25T00:00:30.000Z',
    attempt_deadline_at: '2026-08-25T00:05:00.000Z',
    attempt_storage_key: 'attempts/tts/one', attempt_started_at: NOW,
    media_asset_id: null, failure_code: null, failure_http_status: null,
    retryable: null, config_version: 'v1', created_at: NOW, updated_at: NOW,
  };
  const pool = new RecordingPool([
    { match: /FROM sessions[\s\S]*id\s*=\s*\$1/i, result: result([sessionRow()]) },
    { match: /FROM voice_uploads[\s\S]*FOR UPDATE/i, result: result([voice]) },
    { match: /FROM sessions[\s\S]*id\s*=\s*\$1/i, result: result([sessionRow()]) },
    { match: /FROM messages[\s\S]*role\s*=\s*'assistant'[\s\S]*FOR UPDATE/i, result: result([message]) },
    { match: /FROM media_generations[\s\S]*FOR UPDATE/i, result: result([generation]) },
  ]);
  const store = new PostgresStore({ pool });

  const asr = await store.claimVoiceUploadWithRateLimits({
    sessionId: sessionRow().id, clientUploadId: voice.client_upload_id,
    requestSha256: voice.request_sha256, mimeType: voice.mime_type,
    rateLimits: [], leaseToken: '34343434-3434-4434-8434-343434343434',
    attemptStorageKey: 'attempts/voice/two', leaseExpiresAt: voice.lease_expires_at,
    attemptDeadlineAt: voice.attempt_deadline_at, now: NOW,
  });
  const tts = await store.claimAssistantAudioWithRateLimits({
    sessionId: sessionRow().id, messageId: message.id, kind: 'assistant_voice',
    rateLimits: [], leaseToken: '56565656-5656-4656-8656-565656565656',
    attemptStorageKey: 'attempts/tts/two', configVersion: 'v1',
    leaseExpiresAt: generation.lease_expires_at,
    attemptDeadlineAt: generation.attempt_deadline_at, now: NOW,
  });

  assert.equal(asr.status, 'live');
  assert.equal(tts.status, 'live');
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
  const activeSessionQueries = pool.calls.filter((call) => /FROM sessions[\s\S]*id\s*=\s*\$1/i.test(call.text));
  assert.equal(activeSessionQueries.length, 2);
  assert.equal(activeSessionQueries.every((call) => /FOR UPDATE/i.test(call.text)), true,
    'voice claims must serialize with session deletion before choosing an attempt key');
  const assistantClaim = pool.calls.find((call) => /FROM messages[\s\S]*role\s*=\s*'assistant'[\s\S]*FOR UPDATE/i.test(call.text));
  assert.match(assistantClaim.text, /status\s*=\s*'delivered'/i);
  assert.doesNotMatch(assistantClaim.text, /reply_mode\s*=/i,
    'manual voice generation remains available for an owned delivered text answer');
  pool.assertDrained();
});

test('assistant audio recovery query is bounded to eligible nonterminal delivered generations', async () => {
  const candidate = {
    id: 'abababab-abab-4bab-8bab-abababababab',
    session_id: sessionRow().id,
    reply_language: 'yue-Hant-HK',
    reply_mode: 'text',
    created_at: NOW,
  };
  const pool = new RecordingPool([
    { match: /FROM messages/i, result: result([candidate]) },
  ]);
  const store = new PostgresStore({ pool });

  const candidates = await store.listAssistantAudioRecoveryCandidates({ limit: 2, now: NOW });
  assert.deepEqual(candidates, [{
    id: candidate.id,
    sessionId: candidate.session_id,
    replyLanguage: 'yue-Hant-HK',
    replyMode: 'text',
    createdAt: NOW,
  }]);
  const query = pool.calls.find((call) => /FROM messages/i.test(call.text));
  assert.match(query.text, /role\s*=\s*'assistant'/i);
  assert.match(query.text, /status\s*=\s*'delivered'/i);
  assert.match(query.text, /m\.reply_mode\s*=\s*'voice'\s+AND\s+g\.id\s+IS\s+NULL/i,
    'only an intrinsic voice reply may recover without a durable generation request');
  assert.match(query.text, /g\.id\s+IS\s+NOT\s+NULL[\s\S]*g\.state\s*=\s*'failed'/i,
    'a durable retryable generation authorizes recovery for either reply mode');
  assert.match(query.text, /media_id\s+IS\s+NULL/i);
  assert.match(query.text, /LEFT JOIN\s+media_generations/i);
  assert.match(query.text, /retryable\s*=\s*TRUE/i);
  assert.match(query.text, /lease_expires_at[\s\S]*<=\s*\$2/i);
  assert.match(query.text, /attempt_deadline_at[\s\S]*<=\s*\$2/i);
  assert.match(query.text, /LIMIT\s+\$1/i);
  assert.deepEqual(query.values, [2, NOW]);
  pool.assertDrained();
});

test('deletion outbox generation contract fences stale workers across adapter calls', async () => {
  const key = 'attempts/voice/contract-key';
  const job = (overrides = {}) => ({
    id: 'abababab-abab-4bab-8bab-abababababab', storage_key: key,
    reason: 'test-delete', not_before: NOW, state: 'pending', attempt: 0,
    generation: 1, lease_token: null, lease_expires_at: null, worker_id: null,
    last_error_code: null, sweep_observation: null, created_at: NOW,
    updated_at: NOW, completed_at: null, ...overrides,
  });
  const pool = new RecordingPool([
    { match: /INSERT INTO media_deletion_jobs/i, result: result([job()]) },
    { match: /FOR UPDATE\s+SKIP LOCKED/i, result: result([job({ state: 'deleting', attempt: 1, lease_token: 'cleanup-token-one', lease_expires_at: '2026-08-25T00:00:30.000Z', worker_id: 'cleanup-one' })]) },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([job({ generation: 2 })]) },
    { match: /UPDATE media_deletion_jobs/i, result: result() },
    { match: /FOR UPDATE\s+SKIP LOCKED/i, result: result([job({ generation: 2, state: 'deleting', attempt: 1, lease_token: 'cleanup-token-two', lease_expires_at: '2026-08-25T00:00:30.000Z', worker_id: 'cleanup-two' })]) },
    { match: /UPDATE media_deletion_jobs/i, result: result([job({ generation: 2, state: 'completed', attempt: 1, completed_at: NOW })]) },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([job({ generation: 3 })]) },
  ]);
  const store = new PostgresStore({ pool });

  await exerciseDeletionGenerationContract({ store, storageKey: key, now: NOW });

  assert.equal(pool.calls.filter((call) => call.text === 'BEGIN').length, 7);
  assert.equal(pool.calls.filter((call) => call.text === 'COMMIT').length, 6);
  assert.equal(pool.calls.filter((call) => call.text === 'ROLLBACK').length, 1);
  pool.assertDrained();
});

test('a fresh orphan-sweep observation rearms and fences an existing deletion job', async () => {
  const pool = new RecordingPool([
    {
      match: /INSERT INTO media_deletion_jobs/i,
      result: result([{
        id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
        storage_key: 'attempts/tts/swept', reason: 'orphan-attempt-sweep',
        not_before: NOW, state: 'pending', attempt: 0, generation: 2,
        lease_token: null, lease_expires_at: null, worker_id: null,
        last_error_code: null, sweep_observation: 'e'.repeat(64),
        created_at: NOW, updated_at: NOW, completed_at: null,
      }]),
    },
  ]);
  const store = new PostgresStore({ pool });

  const rearmed = await store.rearmMediaDeletionFromSweep({
    storageKey: 'attempts/tts/swept', sweepObservation: 'e'.repeat(64),
    reason: 'orphan-attempt-sweep', notBefore: NOW, now: NOW,
  });

  assert.equal(rearmed.generation, 2);
  assert.equal(rearmed.state, 'pending');
  const upsert = pool.calls.find((call) => /INSERT INTO media_deletion_jobs/i.test(call.text));
  assert.match(upsert.text, /generation\s*=\s*media_deletion_jobs\.generation\s*\+\s*1/i);
  assert.match(upsert.text, /sweep_observation\s+IS DISTINCT FROM/i);
  pool.assertDrained();
});

test('session revocation queues every owned object key before the cascading delete commits', async () => {
  const assetKey = 'media/user/owned.wav';
  const attemptKey = 'attempts/voice/owned';
  const pool = new RecordingPool([
    { match: /FROM sessions[\s\S]*FOR UPDATE/i, result: result([sessionRow()]) },
    { match: /FROM media_assets/i, result: result([{ storage_key: assetKey }]) },
    { match: /FROM voice_uploads[\s\S]*UNION ALL[\s\S]*media_generations/i, result: result([{ storage_key: attemptKey, lease_expires_at: NOW, attempt_deadline_at: NOW }]) },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([{ storage_key: assetKey }]) },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([{ storage_key: attemptKey }]) },
    { match: /DELETE FROM sessions/i, result: result([], 1) },
  ]);
  const store = new PostgresStore({ pool });

  const revoked = await store.revokeSessionAndEnqueueMedia({
    sessionId: sessionRow().id, now: NOW, cleanupNotBefore: NOW,
  });

  assert.deepEqual(revoked, { deleted: true, queuedKeys: 2 });
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'COMMIT']);
  const deleteIndex = pool.calls.findIndex((call) => /DELETE FROM sessions/i.test(call.text));
  const queuedIndexes = pool.calls.map((call, index) => (/INSERT INTO media_deletion_jobs/i.test(call.text) ? index : -1)).filter((index) => index >= 0);
  assert.equal(queuedIndexes.every((index) => index < deleteIndex), true);
  pool.assertDrained();
});

test('retention heartbeat, success, and stop use parameterized run-token fencing', async () => {
  const workerId = "retention-worker'; DROP TABLE sessions; --";
  const runToken = '81818181-8181-4818-8818-818181818181';
  const staleToken = '91919191-9191-4919-8919-919191919191';
  const policy = {
    version: 'retention-v1',
    anonymousTextEventMs: 30 * 24 * 60 * 60 * 1_000,
    voiceMediaMs: 7 * 24 * 60 * 60 * 1_000,
  };
  const running = retentionStateRow({
    payload_json: {
      workerId, runToken, status: 'running', policyVersion: policy.version, stoppedAt: null,
    },
  });
  const succeeded = retentionStateRow({
    ...running,
    last_success_at: '2026-08-25T00:00:02.000Z',
  });
  const stopped = retentionStateRow({
    ...succeeded,
    payload_json: {
      ...succeeded.payload_json,
      status: 'stopped',
      stoppedAt: '2026-08-25T00:00:03.000Z',
    },
    updated_at: '2026-08-25T00:00:03.000Z',
  });
  const pool = new RecordingPool([
    { match: /INSERT INTO service_state[\s\S]*ON CONFLICT/i, result: result([running]) },
    { match: /UPDATE service_state[\s\S]*last_success_at/i, result: result() },
    { match: /UPDATE service_state[\s\S]*last_success_at/i, result: result([succeeded]) },
    { match: /UPDATE service_state[\s\S]*stopped/i, result: result() },
    { match: /UPDATE service_state[\s\S]*stopped/i, result: result([stopped]) },
    { match: /UPDATE service_state[\s\S]*stopped/i, result: result([stopped]) },
  ]);
  const store = new PostgresStore({ pool });

  const heartbeat = await store.recordRetentionHeartbeat({
    workerId, runToken, heartbeatAt: NOW, policy,
  });
  assert.equal(heartbeat.payloadJson.runToken, runToken);
  await assert.rejects(store.recordRetentionSuccess({
    workerId, runToken: staleToken, heartbeatAt: NOW,
    lastSuccessAt: '2026-08-25T00:00:02.000Z', policy,
    result: { purged: {}, media: { completed: 0, idle: true } },
  }), { code: 'RETENTION_RUN_FENCED' });
  assert.equal((await store.recordRetentionSuccess({
    workerId, runToken, heartbeatAt: NOW,
    lastSuccessAt: '2026-08-25T00:00:02.000Z', policy,
    result: { purged: {}, media: { completed: 0, idle: true } },
  })).lastSuccessAt, '2026-08-25T00:00:02.000Z');
  await assert.rejects(store.recordRetentionStopped({
    workerId, runToken: staleToken, stoppedAt: '2026-08-25T00:00:03.000Z', policy,
  }), { code: 'RETENTION_RUN_FENCED' });
  await store.recordRetentionStopped({
    workerId, runToken, stoppedAt: '2026-08-25T00:00:03.000Z', policy,
  });
  const idempotentStop = await store.recordRetentionStopped({
    workerId, runToken, stoppedAt: '2026-08-25T00:00:03.000Z', policy,
  });
  assert.equal(idempotentStop.payloadJson.status, 'stopped');

  const heartbeatSql = pool.calls.find((call) => /INSERT INTO service_state/i.test(call.text));
  const successSql = pool.calls.find((call) => /UPDATE service_state[\s\S]*last_success_at/i.test(call.text));
  const stopSql = pool.calls.find((call) => /UPDATE service_state[\s\S]*stopped/i.test(call.text));
  for (const call of [heartbeatSql, successSql, stopSql]) {
    assert.equal(call.text.includes(workerId), false);
    assert.equal(call.values.some((value) => String(value).includes(workerId)), true);
  }
  assert.match(successSql.text, /payload_json\s*->>\s*'runToken'/i);
  assert.match(successSql.text, /NOT EXISTS[\s\S]*media_deletion_jobs/i,
    'success must atomically recheck that the durable outbox is empty');
  assert.match(stopSql.text, /payload_json\s*->>\s*'runToken'/i);
  pool.assertDrained();
});

test('retention readiness reads the durable PostgreSQL heartbeat and success snapshot', async () => {
  const state = retentionStateRow({
    last_success_at: '2026-08-25T00:00:02.000Z',
  });
  const pool = new RecordingPool([
    { match: /SELECT[\s\S]*FROM service_state[\s\S]*name\s*=\s*\$1/i, result: result([state]) },
    { match: /SELECT[\s\S]*FROM service_state[\s\S]*name\s*=\s*\$1/i, result: result() },
  ]);
  const store = new PostgresStore({ pool });

  assert.deepEqual(await store.getRetentionState(), {
    heartbeatAt: NOW,
    lastSuccessAt: '2026-08-25T00:00:02.000Z',
    stoppedAt: null,
    policyVersion: 'retention-v1',
  });
  assert.equal(await store.getRetentionState(), null);
  assert.deepEqual(pool.calls.filter((call) => /FROM service_state/i.test(call.text))
    .map((call) => call.values), [['retention'], ['retention']]);
  pool.assertDrained();
});

test('retention heartbeat and readiness reads bind the same cancellation signal to pg query config', async () => {
  const running = retentionStateRow();
  const pool = new RecordingPool([
    { match: /INSERT INTO service_state/i, result: result([running]) },
    { match: /SELECT payload_json, heartbeat_at, last_success_at/i, result: result([running]) },
  ]);
  const store = new PostgresStore({ pool });
  const controller = new AbortController();
  await store.recordRetentionHeartbeat({
    workerId: 'retention-worker',
    runToken: '81818181-8181-4818-8818-818181818181',
    heartbeatAt: NOW,
    policy: {
      version: 'retention-v1',
      anonymousTextEventMs: 30 * 24 * 60 * 60 * 1_000,
      voiceMediaMs: 7 * 24 * 60 * 60 * 1_000,
    },
    signal: controller.signal,
  });
  await store.getRetentionState({ signal: controller.signal });

  const dependencyQueries = pool.calls.filter((call) => /service_state/i.test(call.text));
  assert.equal(dependencyQueries.length, 2);
  for (const call of dependencyQueries) assert.equal(call.signal, controller.signal);
  assert.equal(pool.releases, 2, 'each signal-aware standalone query owns and releases its client');
  pool.assertDrained();
});

test('aborting a retention transaction destroys the active query and starts no rollback or later side effect', async () => {
  let queryStartedResolve;
  const queryStarted = new Promise((resolve) => { queryStartedResolve = resolve; });
  const calls = [];
  const releaseErrors = [];
  let activeQueries = 0;
  const client = new EventEmitter();
  client.query = async (config) => {
    const text = String(config?.text ?? config).trim();
    calls.push({ text, signal: config?.signal });
    if (text === 'BEGIN') return result();
    if (/FROM service_state[\s\S]*FOR UPDATE/i.test(text)) {
      activeQueries += 1;
      queryStartedResolve();
      return new Promise((resolve, reject) => {
        void resolve;
        config.signal.addEventListener('abort', () => {
          activeQueries -= 1;
          reject(Object.assign(new Error('private cancelled retention query'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    assert.fail(`unexpected post-cancellation SQL: ${text}`);
  };
  client.release = (error) => releaseErrors.push(error ?? null);
  const store = new PostgresStore({
    pool: {
      query: async () => assert.fail('signal-aware retention uses a checked-out client'),
      connect: async () => client,
    },
  });
  const controller = new AbortController();
  const purging = store.purgeExpired({
    anonymousBefore: '2026-08-01T00:00:00.000Z',
    voiceBefore: '2026-08-20T00:00:00.000Z',
    now: NOW,
    workerId: 'retention-worker',
    runToken: '81818181-8181-4818-8818-818181818181',
    policyVersion: 'retention-v1',
    signal: controller.signal,
  });
  await queryStarted;
  controller.abort();
  await assert.rejects(purging, { code: 'POSTGRES_OPERATION_ABORTED' });

  assert.equal(activeQueries, 0);
  assert.equal(releaseErrors.length, 1);
  assert.ok(releaseErrors[0] instanceof Error);
  assert.deepEqual(calls.map((call) => call.text === 'BEGIN' ? 'BEGIN' : 'OWNERSHIP'), [
    'BEGIN', 'OWNERSHIP',
  ]);
  assert.equal(calls.every((call) => call.signal === controller.signal), true);
});

test('retention backlog check includes deferred pending and deleting jobs, not only claimable work', async () => {
  const workerId = 'retention-worker';
  const runToken = '81818181-8181-4818-8818-818181818181';
  const pool = new RecordingPool([
    { match: /SELECT[\s\S]*EXISTS[\s\S]*media_deletion_jobs/i, result: result([{ pending: true }]) },
    { match: /SELECT[\s\S]*EXISTS[\s\S]*media_deletion_jobs/i, result: result([{ pending: false }]) },
    { match: /SELECT[\s\S]*EXISTS[\s\S]*media_deletion_jobs/i, result: result() },
  ]);
  const store = new PostgresStore({ pool });

  assert.equal(await store.hasPendingMediaDeletions({ workerId, runToken }), true);
  assert.equal(await store.hasPendingMediaDeletions({ workerId, runToken }), false);
  await assert.rejects(
    store.hasPendingMediaDeletions({ workerId, runToken: 'stale-token' }),
    { code: 'RETENTION_RUN_FENCED' },
  );

  const query = pool.calls.find((call) => /media_deletion_jobs/i.test(call.text));
  assert.match(query.text, /state\s+IN\s*\(\s*'pending'\s*,\s*'deleting'\s*\)/i);
  assert.doesNotMatch(query.text, /not_before\s*<=/i,
    'future retry rows must keep retention success false');
  assert.ok(query.values.includes(runToken));
  pool.assertDrained();
});

test('retention purge revokes voice and queues every session key before metadata cascades in one transaction', async () => {
  const voiceBefore = '2026-08-18T00:00:00.000Z';
  const anonymousBefore = '2026-07-26T00:00:00.000Z';
  const workerId = 'retention-worker';
  const runToken = '81818181-8181-4818-8818-818181818181';
  const voiceSessionId = '84848484-8484-4848-8848-848484848484';
  const voiceAsset = {
    id: '82828282-8282-4828-8828-828282828282', session_id: voiceSessionId,
    owner_message_id: null, kind: 'user_voice', storage_key: 'media/voice/expired.wav',
    mime_type: 'audio/wav', byte_length: '128', duration_ms: 1000,
    sha256: '8'.repeat(64), status: 'draft', expires_at: null,
    created_at: '2026-08-17T00:00:00.000Z', updated_at: '2026-08-17T00:00:00.000Z',
  };
  const sessionAssetKey = 'media/voice/session-expired.wav';
  const sessionAttemptKey = 'attempts/tts/session-expired';
  const pool = new RecordingPool([
    { match: /FROM service_state[\s\S]*FOR UPDATE/i, result: result([retentionStateRow()]) },
    { match: /DELETE FROM rate_limit_buckets[\s\S]*expires_at\s*<=\s*\$1/i, result: result([], 2) },
    { match: /FROM sessions\s+s[\s\S]*NOT EXISTS[\s\S]*messages[\s\S]*FOR UPDATE OF s/i, result: result([sessionRow()]) },
    { match: /FROM media_assets[\s\S]*session_id\s*=\s*\$1[\s\S]*FOR UPDATE/i, result: result([{ storage_key: sessionAssetKey }]) },
    {
      match: /FROM voice_uploads[\s\S]*UNION ALL[\s\S]*media_generations/i,
      result: result([{ storage_key: sessionAttemptKey, lease_expires_at: NOW, attempt_deadline_at: NOW }]),
    },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([{ storage_key: sessionAssetKey }]) },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([{ storage_key: sessionAttemptKey }]) },
    { match: /DELETE FROM sessions/i, result: result([], 1) },
    { match: /FROM sessions\s+s[\s\S]*NOT EXISTS[\s\S]*messages[\s\S]*FOR UPDATE OF s/i, result: result() },
    { match: /FROM media_assets[\s\S]*created_at\s*<\s*\$1[\s\S]*FOR UPDATE/i, result: result([voiceAsset]) },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([{ storage_key: voiceAsset.storage_key }]) },
    { match: /UPDATE voice_uploads[\s\S]*VOICE_MEDIA_EXPIRED/i, result: result([], 1) },
    { match: /UPDATE media_generations[\s\S]*VOICE_MEDIA_EXPIRED/i, result: result() },
    { match: /DELETE FROM media_assets[\s\S]*ANY/i, result: result([], 1) },
    { match: /FROM media_assets[\s\S]*created_at\s*<\s*\$1[\s\S]*FOR UPDATE/i, result: result() },
  ]);
  const store = new PostgresStore({ pool });

  const purged = await store.purgeExpired({
    anonymousBefore, voiceBefore, now: NOW,
    workerId, runToken, policyVersion: 'retention-v1',
  });

  assert.deepEqual(purged, {
    rateBucketsPurged: 2,
    anonymousSessionsPurged: 1,
    voiceAssetsRevoked: 1,
    deletionJobsQueued: 3,
  });
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'COMMIT']);
  const voiceQueue = pool.calls.findIndex((call) => /INSERT INTO media_deletion_jobs/i.test(call.text)
    && call.values.includes(voiceAsset.storage_key));
  const voiceDelete = pool.calls.findIndex((call) => /DELETE FROM media_assets/i.test(call.text));
  assert.equal(voiceQueue >= 0 && voiceQueue < voiceDelete, true);
  const sessionDelete = pool.calls.findIndex((call) => /DELETE FROM sessions/i.test(call.text));
  const sessionQueues = pool.calls.map((call, index) => (
    /INSERT INTO media_deletion_jobs/i.test(call.text)
      && [sessionAssetKey, sessionAttemptKey].some((key) => call.values.includes(key)) ? index : -1
  )).filter((index) => index >= 0);
  assert.equal(sessionQueues.length, 2);
  assert.equal(sessionQueues.every((index) => index < sessionDelete), true);
  const voiceSelection = pool.calls.find((call) => /FROM media_assets[\s\S]*created_at\s*</i.test(call.text));
  assert.ok(voiceSelection.values.includes(voiceBefore));
  assert.equal(voiceSelection.text.includes(voiceBefore), false);
  const sessionSelection = pool.calls.find((call) => /FROM sessions\s+s/i.test(call.text));
  assert.ok(sessionSelection.values.includes(anonymousBefore));
  assert.match(sessionSelection.text, /s\.created_at\s*<\s*\$1/i);
  for (const table of ['messages', 'events', 'voice_uploads']) {
    assert.match(sessionSelection.text, new RegExp(`${table}[\\s\\S]*created_at\\s*>=\\s*\\$1`, 'i'),
      `${table} activity inside the window must preserve the whole guest session`);
  }
  assert.ok(pool.calls.indexOf(sessionSelection) < pool.calls.indexOf(voiceSelection),
    'session retention takes the session lock before any later voice-asset lock');
  assert.equal(pool.calls.filter((call) => /FROM sessions\s+s/i.test(call.text)).length, 2,
    'retention must prove the expired-session batch is exhausted before success');
  assert.equal(pool.calls.filter((call) => /FROM media_assets[\s\S]*created_at\s*</i.test(call.text)).length, 2,
    'retention must prove the expired-voice batch is exhausted before success');
  assert.doesNotMatch(sessionSelection.text, /SKIP LOCKED/i,
    'retention success cannot skip an expired row locked by another lifecycle transaction');
  assert.doesNotMatch(voiceSelection.text, /SKIP LOCKED/i,
    'retention success cannot skip an expired asset locked by another lifecycle transaction');
  const rateBucketPurge = pool.calls.find((call) => /DELETE FROM rate_limit_buckets/i.test(call.text));
  assert.deepEqual(rateBucketPurge.values, [NOW]);
  pool.assertDrained();
});

test('retention purge rolls back voice outbox and metadata revocation together on failure', async () => {
  const voiceAsset = {
    id: '83838383-8383-4838-8838-838383838383', session_id: sessionRow().id,
    storage_key: 'media/voice/rollback.wav', created_at: '2026-08-17T00:00:00.000Z',
  };
  const pool = new RecordingPool([
    { match: /FROM service_state[\s\S]*FOR UPDATE/i, result: result([retentionStateRow()]) },
    { match: /DELETE FROM rate_limit_buckets[\s\S]*expires_at\s*<=\s*\$1/i, result: result() },
    { match: /FROM sessions\s+s[\s\S]*FOR UPDATE OF s/i, result: result() },
    { match: /FROM media_assets[\s\S]*FOR UPDATE/i, result: result([voiceAsset]) },
    { match: /INSERT INTO media_deletion_jobs/i, result: result([{ storage_key: voiceAsset.storage_key }]) },
    { match: /UPDATE voice_uploads/i, error: new Error('database write failed') },
  ]);
  const store = new PostgresStore({ pool });

  await assert.rejects(store.purgeExpired({
    anonymousBefore: '2026-07-26T00:00:00.000Z',
    voiceBefore: '2026-08-18T00:00:00.000Z', now: NOW,
    workerId: 'retention-worker',
    runToken: '81818181-8181-4818-8818-818181818181',
    policyVersion: 'retention-v1',
  }), /database write failed/);

  assert.deepEqual(transactionWords(pool), ['BEGIN', 'ROLLBACK']);
  assert.equal(pool.calls.some((call) => /DELETE FROM media_assets/i.test(call.text)), false);
  pool.assertDrained();
});

test('rate buckets lock durably and return the maximum exhausted expiry without incrementing', async () => {
  const later = '2026-08-26T00:00:00.000Z';
  const pool = new RecordingPool([
    { match: /INSERT INTO rate_limit_buckets/i, result: result() },
    { match: /FROM rate_limit_buckets[\s\S]*FOR UPDATE/i, result: result([{ count: 300, expires_at: later }]) },
  ]);
  const store = new PostgresStore({ pool });

  const limited = await store.consumeRateLimit({
    subjectHash: 'f'.repeat(64), quota: 'messages-day', windowStart: NOW,
    limit: 300, expiresAt: later,
  });

  assert.deepEqual(limited, { allowed: false, count: 300, expiresAt: later });
  assert.equal(pool.calls.some((call) => /SET\s+count\s*=\s*count\s*\+\s*1/i.test(call.text)), false);
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'COMMIT']);
  pool.assertDrained();
});

test('multi-window message rejection returns the latest blocking expiry in deterministic lock order', async () => {
  const shortExpiry = '2026-08-25T00:05:00.000Z';
  const dailyExpiry = '2026-08-26T00:00:00.000Z';
  const pool = new RecordingPool([
    { match: /FROM sessions[\s\S]*FOR UPDATE/i, result: result([sessionRow()]) },
    { match: /FROM conversations[\s\S]*FOR UPDATE/i, result: result([conversationRow()]) },
    { match: /client_message_id\s*=\s*\$2/i, result: result() },
    { match: /INSERT INTO rate_limit_buckets/i, result: result() },
    { match: /FROM rate_limit_buckets[\s\S]*FOR UPDATE/i, result: result([{ count: 30, expires_at: shortExpiry }]) },
    { match: /INSERT INTO rate_limit_buckets/i, result: result() },
    { match: /FROM rate_limit_buckets[\s\S]*FOR UPDATE/i, result: result([{ count: 300, expires_at: dailyExpiry }]) },
  ]);
  const store = new PostgresStore({ pool });
  const subjectHash = '9'.repeat(64);

  await assert.rejects(store.acceptMessageWithRateLimits({
    sessionId: sessionRow().id, conversationId: conversationRow().id,
    clientMessageId: '67676767-6767-4767-8767-676767676767',
    requestHash: '8'.repeat(64), text: 'rate me', now: NOW,
    rateLimits: [
      { subjectHash, quota: 'messages-day', windowStart: NOW, limit: 300, expiresAt: dailyExpiry },
      { subjectHash, quota: 'messages-5m', windowStart: NOW, limit: 30, expiresAt: shortExpiry },
    ],
  }), (error) => error.code === 'RATE_LIMITED' && error.expiresAt === dailyExpiry);

  const bucketLocks = pool.calls.filter((call) => /FROM rate_limit_buckets[\s\S]*FOR UPDATE/i.test(call.text));
  assert.deepEqual(bucketLocks.map((call) => call.values[1]), ['messages-5m', 'messages-day']);
  assert.equal(pool.calls.some((call) => /SET\s+count\s*=\s*count\s*\+\s*1/i.test(call.text)), false);
  assert.deepEqual(transactionWords(pool), ['BEGIN', 'ROLLBACK']);
  pool.assertDrained();
});

test('JSON event payloads round-trip without rewriting nested keys or numeric-looking strings', async () => {
  const payload = { source_id: 'hkbu-official', count: '007', nested_value: { card_id: 'A_01' } };
  const pool = new RecordingPool([
    { match: /FROM conversations[\s\S]*id\s*=\s*\$1/i, result: result([conversationRow({ event_high_water: '1' })]) },
    {
      match: /FROM events/i,
      result: result([{
        id: '78787878-7878-4787-8787-787878787878', session_id: sessionRow().id,
        conversation_id: conversationRow().id, cursor: '1', type: 'source.card',
        message_id: null, turn_id: null, payload_json: payload, created_at: NOW,
      }]),
    },
  ]);
  const store = new PostgresStore({ pool });

  const events = await store.listEventsPage({
    sessionId: sessionRow().id, conversationId: conversationRow().id,
    afterCursor: 0, throughCursor: 1, limit: 10,
  });

  assert.deepEqual(events[0].payloadJson, payload);
  pool.assertDrained();
});

test.skip('real PostgreSQL concurrency, crash recovery, FK/cascade, and lifecycle acceptance — NOT RUN (approved isolated database required)', () => {});
