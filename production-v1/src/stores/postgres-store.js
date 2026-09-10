import { randomUUID } from 'node:crypto';

import { contextLimits, retainRecentCompletePairs } from '../context-budget.js';
import {
  DEFAULT_REPLY_LANGUAGE,
  DEFAULT_REPLY_MODE,
  REPLY_LANGUAGES,
  REPLY_MODES,
  SAFE_TURN_FAILURE_CODES,
  TURN_STATES,
  TURN_TERMINAL_STATES,
  storeError,
} from './store-contract.js';

const NONTERMINAL_TRANSITIONS = Object.freeze({ accepted: 'retrieving', retrieving: 'generating' });
const ATTEMPT_CLEANUP_GRACE_MS = 60_000;
export const productionInstanceLockName = 'hong-kong-buddy-production-v1';
const TURN_CLAIM_STATEMENT = `
  WITH candidate AS (
    SELECT t.id
    FROM turns t
    JOIN messages inbound ON inbound.id = t.user_message_id
    WHERE t.state NOT IN ('delivered', 'failed')
      AND (t.lease_token IS NULL OR t.lease_expires_at IS NULL OR t.lease_expires_at <= $4)
      AND NOT EXISTS (
        SELECT 1
        FROM turns earlier_turn
        JOIN messages earlier_message ON earlier_message.id = earlier_turn.user_message_id
        WHERE earlier_turn.conversation_id = t.conversation_id
          AND earlier_turn.state NOT IN ('delivered', 'failed')
          AND (
            earlier_message.sequence < inbound.sequence
            OR (earlier_message.sequence = inbound.sequence AND earlier_turn.id < t.id)
          )
      )
    ORDER BY t.created_at ASC, inbound.sequence ASC, t.id ASC
    FOR UPDATE OF t SKIP LOCKED
    LIMIT 1
  )
  UPDATE turns t
  SET worker_id = $1, lease_token = $2, lease_expires_at = $3,
      attempt = t.attempt + 1, updated_at = $4
  FROM candidate
  WHERE t.id = candidate.id
  RETURNING t.*
`;
const NUMERIC_FIELDS = new Set([
  'attempt', 'byteLength', 'count', 'cursor', 'durationMs', 'eventHighWater',
  'failureHttpStatus', 'generation', 'providerLatencyMs', 'sequence',
]);

function asDate(value, name = 'instant') {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be a valid instant`);
  return date;
}

function asIso(value, name) { return asDate(value, name).toISOString(); }
function laterIso(...values) {
  const finite = values.filter((value) => value !== null && value !== undefined).map((value) => asDate(value).getTime());
  return new Date(Math.max(...finite)).toISOString();
}

function camelKey(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function mapValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(mapValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, mapValue(nested)]));
  }
  return value;
}

function mapRow(row) {
  if (!row) return null;
  const mapped = {};
  for (const [key, value] of Object.entries(row)) {
    const outputKey = camelKey(key);
    const normalized = mapValue(value);
    mapped[outputKey] = NUMERIC_FIELDS.has(outputKey) && normalized !== null
      ? Number(normalized)
      : normalized;
  }
  return mapped;
}

function mapRows(rows = []) { return rows.map(mapRow); }

function liveAttempt(row, now) {
  const current = asDate(now).getTime();
  return Boolean(row?.leaseToken && row.leaseExpiresAt && row.attemptDeadlineAt
    && asDate(row.leaseExpiresAt).getTime() > current
    && asDate(row.attemptDeadlineAt).getTime() > current);
}

function rateLimitError(expiresAt) {
  const error = storeError('RATE_LIMITED', 'Rate limit exceeded.');
  error.expiresAt = expiresAt;
  return error;
}

function retentionIdentity(workerId, runToken) {
  if (typeof workerId !== 'string' || !workerId.trim()
    || typeof runToken !== 'string' || !runToken.trim()) {
    throw new Error('Retention workerId and runToken are required');
  }
  return { workerId: workerId.trim(), runToken: runToken.trim() };
}

function retentionPolicy(policy, explicitVersion) {
  const version = typeof (explicitVersion ?? policy?.version) === 'string'
    ? (explicitVersion ?? policy?.version).trim()
    : '';
  if (!version) throw new Error('Retention policy version is required');
  const normalized = { version };
  for (const field of ['anonymousTextEventMs', 'voiceMediaMs']) {
    if (policy?.[field] === undefined) continue;
    if (!Number.isSafeInteger(policy[field]) || policy[field] <= 0) {
      throw new Error(`Retention ${field} must be a positive integer`);
    }
    normalized[field] = policy[field];
  }
  return normalized;
}

function pgUnique(error, code, message) {
  if (error?.code !== '23505') throw error;
  throw storeError(code, message);
}

async function abortableStatus(work, signal, fallback) {
  if (!signal) return work;
  if (signal.aborted) return fallback;
  let abort;
  const boundary = new Promise((resolve) => {
    abort = () => resolve(fallback);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, boundary]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function postgresAbortError() {
  const error = new Error('PostgreSQL operation aborted');
  error.name = 'AbortError';
  error.code = 'POSTGRES_OPERATION_ABORTED';
  return error;
}

function releaseClient(client, error) {
  try { client?.release?.(error); } catch { /* release is best-effort and idempotently guarded by callers */ }
}

export class PostgresStore {
  constructor({ pool, ownsPool = true } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new Error('PostgresStore requires a PostgreSQL pool');
    }
    this.pool = pool;
    this.ownsPool = ownsPool;
    this.healthCheckPromise = null;
    this.healthCheckSignal = null;
    this.dispatcherHealthCheckPromise = null;
    this.dispatcherHealthCheckSignal = null;
  }

  async #withSignalClient(signal, operation) {
    if (!signal || typeof signal.addEventListener !== 'function') {
      throw new Error('A cancellation signal is required');
    }
    if (signal.aborted) throw postgresAbortError();

    const connecting = Promise.resolve().then(() => this.pool.connect());
    let connectAbort;
    const connectBoundary = new Promise((resolve, reject) => {
      void resolve;
      connectAbort = () => reject(postgresAbortError());
      signal.addEventListener('abort', connectAbort, { once: true });
    });
    let client;
    try {
      client = await Promise.race([connecting, connectBoundary]);
    } catch (error) {
      if (signal.aborted) {
        void connecting.then(
          (lateClient) => releaseClient(lateClient, postgresAbortError()),
          () => undefined,
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', connectAbort);
    }

    let released = false;
    const releaseOnce = (error) => {
      if (released) return;
      released = true;
      releaseClient(client, error);
    };
    if (signal.aborted) {
      const error = postgresAbortError();
      releaseOnce(error);
      throw error;
    }

    let abort;
    let clientError;
    const failureBoundary = new Promise((resolve, reject) => {
      void resolve;
      abort = () => {
        const error = postgresAbortError();
        releaseOnce(error);
        reject(error);
      };
      clientError = (error) => {
        releaseOnce(error instanceof Error ? error : new Error('PostgreSQL client unavailable'));
        reject(error instanceof Error ? error : new Error('PostgreSQL client unavailable'));
      };
      signal.addEventListener('abort', abort, { once: true });
      client?.on?.('error', clientError);
    });
    const scopedClient = {
      query: (text, values = []) => {
        if (signal.aborted) throw postgresAbortError();
        return client.query({ text, values, signal });
      },
    };
    const work = Promise.resolve().then(() => operation(scopedClient));
    try {
      return await Promise.race([work, failureBoundary]);
    } finally {
      signal.removeEventListener('abort', abort);
      client?.removeListener?.('error', clientError);
      releaseOnce();
    }
  }

  async #query(text, values = [], signal) {
    if (!signal) return this.pool.query(text, values);
    return this.#withSignalClient(signal, (client) => client.query(text, values));
  }

  async init({ signal } = {}) {
    const migration = await this.#query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [1],
      signal,
    );
    if (migration.rowCount !== 1) throw new Error('PostgreSQL schema migration 1 is required');
  }

  async healthCheck({ signal } = {}) {
    const unavailable = { ok: false, driver: 'postgres', code: 'DATABASE_UNAVAILABLE' };
    if (signal?.aborted) return unavailable;
    if (!this.healthCheckPromise) {
      const work = (async () => {
        try {
          const checked = await this.#query('SELECT 1 AS ok', [], signal);
          if (checked.rowCount === 1 && Number(checked.rows[0]?.ok) === 1) {
            return { ok: true, driver: 'postgres' };
          }
        } catch { /* expose only the safe dependency status */ }
        return unavailable;
      })();
      this.healthCheckPromise = work;
      this.healthCheckSignal = signal ?? null;
      void work.finally(() => {
        if (this.healthCheckPromise === work) {
          this.healthCheckPromise = null;
          this.healthCheckSignal = null;
        }
      });
    }
    if (this.healthCheckSignal === (signal ?? null)) return this.healthCheckPromise;
    return abortableStatus(this.healthCheckPromise, signal, unavailable);
  }

  async dispatcherHealthCheck({ signal } = {}) {
    const unavailable = {
      ok: false,
      driver: 'postgres',
      capability: 'turn-claim',
      code: 'DISPATCHER_UNAVAILABLE',
    };
    if (signal?.aborted) return unavailable;
    if (!this.dispatcherHealthCheckPromise) {
      const work = (async () => {
        try {
          await this.#query(`EXPLAIN (FORMAT JSON, COSTS FALSE) ${TURN_CLAIM_STATEMENT}`, [
            'dispatcher-readiness',
            '00000000-0000-4000-8000-000000000000',
            '2000-01-01T00:01:00.000Z',
            '2000-01-01T00:00:00.000Z',
          ], signal);
          return { ok: true, driver: 'postgres', capability: 'turn-claim' };
        } catch { /* expose only a safe capability status */ }
        return unavailable;
      })();
      this.dispatcherHealthCheckPromise = work;
      this.dispatcherHealthCheckSignal = signal ?? null;
      void work.finally(() => {
        if (this.dispatcherHealthCheckPromise === work) {
          this.dispatcherHealthCheckPromise = null;
          this.dispatcherHealthCheckSignal = null;
        }
      });
    }
    if (this.dispatcherHealthCheckSignal === (signal ?? null)) {
      return this.dispatcherHealthCheckPromise;
    }
    return abortableStatus(this.dispatcherHealthCheckPromise, signal, unavailable);
  }

  async acquireInstanceLock({ name, onLost } = {}) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) {
      throw new Error('A safe singleton lock name is required');
    }
    if (onLost !== undefined && typeof onLost !== 'function') {
      throw new Error('Singleton lock loss handler must be a function');
    }
    const client = await this.pool.connect();
    if (typeof client?.on !== 'function' || typeof client?.removeListener !== 'function') {
      releaseClient(client, new Error('PostgreSQL singleton lock supervision is unavailable'));
      throw new Error('PostgreSQL singleton lock supervision is unavailable');
    }
    let state = 'acquiring';
    let clientReleased = false;
    let lossNotified = false;
    let healthPromise = null;
    let releasePromise = null;
    const releaseDedicatedClient = (error) => {
      if (clientReleased) return;
      clientReleased = true;
      releaseClient(client, error);
    };
    const removeClientListeners = () => {
      client.removeListener('error', clientError);
      client.removeListener('end', clientEnd);
    };
    const notifyLost = () => {
      if (lossNotified || typeof onLost !== 'function') return;
      lossNotified = true;
      try {
        const outcome = onLost();
        void Promise.resolve(outcome).catch(() => undefined);
      } catch { /* lock loss callbacks may never escape a pg event handler */ }
    };
    const markLost = (cause) => {
      if (state === 'lost' || state === 'releasing' || state === 'released') return;
      const wasOwned = state === 'owned';
      state = 'lost';
      releaseDedicatedClient(cause instanceof Error ? cause : new Error('PostgreSQL singleton lock lost'));
      removeClientListeners();
      if (wasOwned) notifyLost();
    };
    function clientError(error) { markLost(error); }
    function clientEnd() { markLost(new Error('PostgreSQL singleton lock session ended')); }
    client.on('error', clientError);
    client.on('end', clientEnd);

    const deniedLock = {
      owned: false,
      isOwned: () => false,
      healthCheck: async () => ({ owned: false }),
      release: async () => undefined,
    };
    try {
      const selected = await client.query(`
        SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired
      `, [name]);
      const acquired = selected.rowCount === 1 && selected.rows[0]?.acquired === true;
      if (!acquired) {
        state = 'releasing';
        removeClientListeners();
        releaseDedicatedClient();
        state = 'released';
        return deniedLock;
      }
      if (state === 'lost') throw new Error('PostgreSQL singleton lock session was lost');
      state = 'owned';

      const healthCheck = ({ signal } = {}) => {
        if (state !== 'owned' || signal?.aborted) return Promise.resolve({ owned: false });
        if (!healthPromise) {
          const work = (async () => {
            let abort;
            if (signal) {
              abort = () => markLost(postgresAbortError());
              signal.addEventListener('abort', abort, { once: true });
            }
            try {
              const checked = await client.query({
                text: `
                  SELECT EXISTS (
                    SELECT 1 FROM pg_locks
                    WHERE locktype = 'advisory'
                      AND pid = pg_backend_pid()
                      AND classid::bigint = ((hashtextextended($1, 0) >> 32) & 4294967295)
                      AND objid::bigint = (hashtextextended($1, 0) & 4294967295)
                      AND objsubid = 1
                      AND granted = TRUE
                  ) AS owned
                `,
                values: [name],
                signal,
              });
              const owned = state === 'owned'
                && checked.rowCount === 1
                && checked.rows[0]?.owned === true;
              if (!owned) markLost(new Error('PostgreSQL singleton lock is not owned'));
              return { owned };
            } catch (error) {
              markLost(error);
              return { owned: false };
            } finally {
              if (signal && abort) signal.removeEventListener('abort', abort);
            }
          })();
          healthPromise = work;
          void work.finally(() => {
            if (healthPromise === work) healthPromise = null;
          });
        }
        return abortableStatus(healthPromise, signal, { owned: false });
      };

      const release = () => {
        releasePromise ??= (async () => {
          if (state === 'lost' || state === 'released') return;
          state = 'releasing';
          let releaseError = null;
          try {
            const unlocked = await client.query(`
              SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released
            `, [name]);
            if (unlocked.rowCount !== 1 || unlocked.rows[0]?.released !== true) {
              throw new Error('PostgreSQL singleton lock release failed');
            }
          } catch (error) {
            releaseError = error;
            throw error;
          } finally {
            removeClientListeners();
            releaseDedicatedClient(releaseError);
            state = 'released';
          }
        })();
        return releasePromise;
      };
      return {
        get owned() { return state === 'owned'; },
        isOwned: () => state === 'owned',
        healthCheck,
        release,
      };
    } catch (error) {
      if (state !== 'lost') {
        state = 'releasing';
        removeClientListeners();
        releaseDedicatedClient(error);
        state = 'released';
      }
      throw error;
    }
  }

  async close() {
    if (this.ownsPool && typeof this.pool.end === 'function') await this.pool.end();
  }

  async #transaction(operation, { signal } = {}) {
    const transact = async (client) => {
      let began = false;
      try {
        await client.query('BEGIN');
        began = true;
        const value = await operation(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        if (began && !signal?.aborted) {
          try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
        }
        throw error;
      }
    };
    if (signal) return this.#withSignalClient(signal, transact);
    const client = await this.pool.connect();
    try {
      return await transact(client);
    } finally {
      client.release();
    }
  }

  async #activeSession(client, sessionId, { lock = false } = {}) {
    const selected = await client.query(`
      SELECT * FROM sessions
      WHERE id = $1
      ${lock ? 'FOR UPDATE' : ''}
    `, [sessionId]);
    if (selected.rowCount !== 1) throw storeError('SESSION_NOT_FOUND', 'A valid session is required.');
    return mapRow(selected.rows[0]);
  }

  async #ownedConversation(client, sessionId, conversationId, { lock = false } = {}) {
    const selected = await client.query(`
      SELECT * FROM conversations
      WHERE id = $1 AND session_id = $2
      ${lock ? 'FOR UPDATE' : ''}
    `, [conversationId, sessionId]);
    if (selected.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested conversation was not found.');
    return mapRow(selected.rows[0]);
  }

  async #lockSessionConversation(client, sessionId, conversationId) {
    await this.#activeSession(client, sessionId, { lock: true });
    return this.#ownedConversation(client, sessionId, conversationId, { lock: true });
  }

  async createOrResumeSession({ tokenHash, now }) {
    return this.#transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [tokenHash]);
      const existing = await client.query('SELECT * FROM sessions WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
      if (existing.rowCount === 1) {
        const session = mapRow(existing.rows[0]);
        const conversationResult = await client.query(
          `SELECT * FROM conversations WHERE session_id = $1 AND COALESCE(kind, 'campus') = 'campus'`,
          [session.id],
        );
        if (conversationResult.rowCount !== 1) throw new Error('PostgreSQL store state is corrupt');
        return { created: false, session, conversation: mapRow(conversationResult.rows[0]) };
      }
      const timestamp = asIso(now);
      const sessionId = randomUUID();
      const clientScopeId = randomUUID();
      const conversationId = randomUUID();
      let insertedSession;
      try {
        insertedSession = await client.query(`
          INSERT INTO sessions (id, token_hash, client_scope_id, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4)
          RETURNING *
        `, [sessionId, tokenHash, clientScopeId, timestamp]);
      } catch (error) {
        pgUnique(error, 'IDEMPOTENCY_CONFLICT', 'The session token is already in use.');
      }
      const insertedConversation = await client.query(`
        INSERT INTO conversations (id, session_id, event_high_water, kind, created_at, updated_at)
        VALUES ($1, $2, 0, 'campus', $3, $3)
        RETURNING *
      `, [conversationId, sessionId, timestamp]);
      return {
        created: true,
        session: mapRow(insertedSession.rows[0]),
        conversation: mapRow(insertedConversation.rows[0]),
      };
    });
  }

  async getSessionByTokenHash(tokenHash) {
    const selected = await this.pool.query('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash]);
    return selected.rowCount === 1 ? mapRow(selected.rows[0]) : null;
  }

  async getConversationForSession({ sessionId, kind = 'campus' }) {
    const selected = await this.pool.query(
      `SELECT * FROM conversations WHERE session_id = $1 AND COALESCE(kind, 'campus') = $2`,
      [sessionId, kind],
    );
    return selected.rowCount === 1 ? mapRow(selected.rows[0]) : null;
  }

  async getOrCreateConversation({ sessionId, kind, mode = null, scenario = null, now }) {
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId, { lock: true });
      const existing = await client.query(
        `SELECT * FROM conversations WHERE session_id = $1 AND COALESCE(kind, 'campus') = $2 FOR UPDATE`,
        [sessionId, kind],
      );
      const timestamp = asIso(now);
      if (existing.rowCount === 1) {
        const updated = await client.query(`
          UPDATE conversations
          SET mode = COALESCE($3, mode), scenario = COALESCE($4, scenario), updated_at = $5
          WHERE id = $1
          RETURNING *
        `, [existing.rows[0].id, sessionId, mode, scenario, timestamp]);
        return mapRow(updated.rows[0]);
      }
      const inserted = await client.query(`
        INSERT INTO conversations (id, session_id, event_high_water, kind, mode, scenario, created_at, updated_at)
        VALUES ($1, $2, 0, $3, $4, $5, $6, $6)
        RETURNING *
      `, [randomUUID(), sessionId, kind, mode, scenario, timestamp]);
      return mapRow(inserted.rows[0]);
    });
  }

  async recordConsent({ sessionId, kinds, version, now }) {
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId, { lock: true });
      const timestamp = asIso(now);
      const updated = await client.query(`
        UPDATE sessions
        SET ai_consent_version = CASE WHEN $2 THEN $3 ELSE ai_consent_version END,
            ai_consent_at = CASE WHEN $2 THEN $4 ELSE ai_consent_at END,
            voice_consent_version = CASE WHEN $5 THEN $3 ELSE voice_consent_version END,
            voice_consent_at = CASE WHEN $5 THEN $4 ELSE voice_consent_at END,
            updated_at = $4
        WHERE id = $1
        RETURNING *
      `, [sessionId, kinds.includes('ai'), version, timestamp, kinds.includes('voice')]);
      if (updated.rowCount !== 1) throw storeError('SESSION_NOT_FOUND', 'A valid session is required.');
      return mapRow(updated.rows[0]);
    });
  }

  async withdrawVoiceConsent({ sessionId, now }) {
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId, { lock: true });
      const updated = await client.query(`
        UPDATE sessions
        SET voice_consent_version = NULL, voice_consent_at = NULL, updated_at = $2
        WHERE id = $1
        RETURNING *
      `, [sessionId, asIso(now)]);
      if (updated.rowCount !== 1) throw storeError('SESSION_NOT_FOUND', 'A valid session is required.');
      return mapRow(updated.rows[0]);
    });
  }

  async getConsent({ sessionId }) {
    return this.#activeSession(this.pool, sessionId);
  }

  async getVisitTurn({ sessionId, clientTurnId }) {
    const selected = await this.pool.query(
      'SELECT * FROM visit_turns WHERE session_id = $1 AND client_turn_id = $2',
      [sessionId, clientTurnId],
    );
    return selected.rowCount === 1 ? mapRow(selected.rows[0]) : null;
  }

  async createVisitTurn({ sessionId, clientTurnId, sourceText, direction, userJob, inputType, voiceDraftId, result, now }) {
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId, { lock: true });
      const existing = await client.query(
        'SELECT * FROM visit_turns WHERE session_id = $1 AND client_turn_id = $2 FOR UPDATE',
        [sessionId, clientTurnId],
      );
      if (existing.rowCount === 1) {
        const row = mapRow(existing.rows[0]);
        if (row.sourceText !== sourceText || row.direction !== direction) {
          throw storeError('IDEMPOTENCY_CONFLICT', 'This client turn ID was already used with different content.');
        }
        return row;
      }
      const inserted = await client.query(`
        INSERT INTO visit_turns (
          id, session_id, client_turn_id, source_text, direction, effective_direction,
          user_job, input_type, translated_text, display_text, romanization,
          auto_routed, route_reason, needs_confirmation, provider, suppress_tts,
          voice_draft_id, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
          $12, $13, $14, $15, $16, $17, $18
        ) RETURNING *
      `, [
        randomUUID(), sessionId, clientTurnId, sourceText, direction,
        result.effectiveDirection ?? direction, userJob ?? null, inputType ?? 'text',
        result.translatedText, result.displayText ?? result.translatedText,
        JSON.stringify(result.romanization ?? null), Boolean(result.autoRouted),
        result.routeReason ?? null, Boolean(result.needsConfirmation), result.provider,
        Boolean(result.suppressTts), voiceDraftId ?? null, asIso(now),
      ]);
      return mapRow(inserted.rows[0]);
    });
  }

  async createReport({ sessionId, messageId, conversationKind, reason, now }) {
    await this.#activeSession(this.pool, sessionId);
    const inserted = await this.pool.query(`
      INSERT INTO answer_reports (id, session_id, message_id, conversation_kind, reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [randomUUID(), sessionId, messageId ?? null, conversationKind, reason, asIso(now)]);
    return mapRow(inserted.rows[0]);
  }

  async #findAcceptedMessage(client, { conversationId, clientMessageId }) {
    const selected = await client.query(`
      SELECT to_jsonb(m) AS message, to_jsonb(t) AS turn, to_jsonb(e) AS event
      FROM messages m
      JOIN turns t ON t.user_message_id = m.id
      JOIN events e ON e.message_id = m.id AND e.type = 'message.accepted'
      WHERE m.conversation_id = $1 AND m.client_message_id = $2
      LIMIT 1
    `, [conversationId, clientMessageId]);
    if (selected.rowCount === 0) return null;
    const row = selected.rows[0];
    return { message: mapRow(row.message), turn: mapRow(row.turn), event: mapRow(row.event) };
  }

  async getAcceptedMessage({ sessionId, conversationId, clientMessageId }) {
    await this.#ownedConversation(this.pool, sessionId, conversationId);
    return this.#findAcceptedMessage(this.pool, { conversationId, clientMessageId });
  }

  async #prepareRateBuckets(client, requests = []) {
    const sorted = [...requests].sort((left, right) => (
      `${left.subjectHash}\u0000${left.quota}\u0000${asIso(left.windowStart)}`
        .localeCompare(`${right.subjectHash}\u0000${right.quota}\u0000${asIso(right.windowStart)}`)
    ));
    const locked = [];
    for (const request of sorted) {
      const windowStart = asIso(request.windowStart, 'windowStart');
      const expiresAt = asIso(request.expiresAt, 'expiresAt');
      await client.query(`
        INSERT INTO rate_limit_buckets
          (id, subject_hash, quota, window_start, count, expires_at)
        VALUES ($1, $2, $3, $4, 0, $5)
        ON CONFLICT (subject_hash, quota, window_start) DO NOTHING
      `, [randomUUID(), request.subjectHash, request.quota, windowStart, expiresAt]);
      const selected = await client.query(`
        SELECT * FROM rate_limit_buckets
        WHERE subject_hash = $1 AND quota = $2 AND window_start = $3
        FOR UPDATE
      `, [request.subjectHash, request.quota, windowStart]);
      if (selected.rowCount !== 1) throw new Error('PostgreSQL rate bucket is unavailable');
      locked.push({ request, row: mapRow(selected.rows[0]) });
    }
    const exhausted = locked.filter(({ request, row }) => row.count >= request.limit);
    const blockingExpiresAt = exhausted.reduce((latest, { row }) => (
      !latest || asDate(row.expiresAt).getTime() > asDate(latest).getTime() ? row.expiresAt : latest
    ), null);
    return { locked, blockingExpiresAt };
  }

  async #incrementRateBuckets(client, locked) {
    for (const { request } of locked) {
      await client.query(`
        UPDATE rate_limit_buckets
        SET count = count + 1
        WHERE subject_hash = $1 AND quota = $2 AND window_start = $3
      `, [request.subjectHash, request.quota, asIso(request.windowStart)]);
    }
  }

  async #acceptMessage(client, input, rateLimits = []) {
    const {
      sessionId, conversationId, clientMessageId, requestHash, text,
      voiceDraftId = null, replyLanguage = DEFAULT_REPLY_LANGUAGE,
      replyMode = DEFAULT_REPLY_MODE, now,
    } = input;
    if (!REPLY_LANGUAGES.has(replyLanguage) || !REPLY_MODES.has(replyMode)) {
      throw storeError('INVALID_REQUEST', 'Unsupported reply preferences.');
    }
    await this.#lockSessionConversation(client, sessionId, conversationId);
    const duplicate = await this.#findAcceptedMessage(client, { conversationId, clientMessageId });
    if (duplicate) {
      if (duplicate.turn.requestHash !== requestHash) {
        throw storeError('IDEMPOTENCY_CONFLICT', 'This client message ID was already used with different content.');
      }
      return { idempotent: true, ...duplicate };
    }
    const rateState = await this.#prepareRateBuckets(client, rateLimits);
    if (rateState.blockingExpiresAt) throw rateLimitError(rateState.blockingExpiresAt);

    let voiceDraft = null;
    if (voiceDraftId) {
      const draft = await client.query(`
        SELECT * FROM media_assets
        WHERE id = $1 AND session_id = $2 AND kind = 'user_voice' AND status = 'draft'
        FOR UPDATE
      `, [voiceDraftId, sessionId]);
      if (draft.rowCount !== 1) throw storeError('INVALID_VOICE_DRAFT', 'The voice draft is unavailable.');
      voiceDraft = mapRow(draft.rows[0]);
    }

    const sequenceResult = await client.query(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM messages WHERE conversation_id = $1
    `, [conversationId]);
    const sequence = Number(sequenceResult.rows[0].next_sequence);
    const timestamp = asIso(now);
    const eventCursor = await client.query(`
      UPDATE conversations
      SET event_high_water = event_high_water + 1, updated_at = $2
      WHERE id = $1
      RETURNING event_high_water
    `, [conversationId, timestamp]);
    const cursor = Number(eventCursor.rows[0].event_high_water);
    const messageId = randomUUID();
    const turnId = randomUUID();
    const eventId = randomUUID();
    let messageResult;
    try {
      messageResult = await client.query(`
        INSERT INTO messages (
          id, session_id, conversation_id, turn_id, client_message_id, sequence,
          role, kind, status, failure_code, text, reply_language, reply_mode,
          voice_draft_id, media_id,
          citations, cards, suggested_replies, needs_clarification,
          grounding_status, provider, provider_latency_ms, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          'user', $7, 'accepted', NULL, $8, $9, $10, $11, $12,
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, false,
          NULL, NULL, NULL, $13
        ) RETURNING *
      `, [
        messageId, sessionId, conversationId, turnId, clientMessageId, sequence,
        voiceDraft ? 'voice' : 'text', text, replyLanguage, replyMode,
        voiceDraftId, voiceDraft?.id ?? null, timestamp,
      ]);
    } catch (error) {
      pgUnique(error, 'IDEMPOTENCY_CONFLICT', 'This client message ID was already used.');
    }
    const turnResult = await client.query(`
      INSERT INTO turns (
        id, session_id, conversation_id, user_message_id, request_hash,
        reply_language, reply_mode, state,
        failure_code, attempt, lease_token, lease_expires_at, worker_id,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', NULL, 0, NULL, NULL, NULL, $8, $8)
      RETURNING *
    `, [turnId, sessionId, conversationId, messageId, requestHash, replyLanguage, replyMode, timestamp]);
    if (voiceDraft) {
      const attached = await client.query(`
        UPDATE media_assets
        SET status = 'attached', owner_message_id = $2, updated_at = $3
        WHERE id = $1 AND session_id = $4 AND status = 'draft' AND owner_message_id IS NULL
        RETURNING *
      `, [voiceDraft.id, messageId, timestamp, sessionId]);
      if (attached.rowCount !== 1) throw storeError('INVALID_VOICE_DRAFT', 'The voice draft is unavailable.');
    }
    const eventResult = await client.query(`
      INSERT INTO events (
        id, session_id, conversation_id, cursor, type, message_id, turn_id,
        payload_json, created_at
      ) VALUES ($1, $2, $3, $4, 'message.accepted', $5, $6, $7::jsonb, $8)
      RETURNING *
    `, [
      eventId, sessionId, conversationId, cursor, messageId, turnId,
      JSON.stringify({ messageId, turnId }), timestamp,
    ]);
    await this.#incrementRateBuckets(client, rateState.locked);
    return {
      idempotent: false,
      message: mapRow(messageResult.rows[0]),
      turn: mapRow(turnResult.rows[0]),
      event: mapRow(eventResult.rows[0]),
    };
  }

  async acceptMessage(input) {
    return this.#transaction((client) => this.#acceptMessage(client, input));
  }

  async acceptMessageWithRateLimits({ rateLimits = [], ...input }) {
    return this.#transaction((client) => this.#acceptMessage(client, input, rateLimits));
  }

  async listMessages({ sessionId, conversationId, after = 0 }) {
    await this.#ownedConversation(this.pool, sessionId, conversationId);
    const selected = await this.pool.query(`
      SELECT * FROM messages
      WHERE conversation_id = $1 AND sequence > $2
      ORDER BY sequence ASC
    `, [conversationId, Number(after)]);
    return mapRows(selected.rows);
  }

  async getActiveTurn({ sessionId, conversationId }) {
    await this.#ownedConversation(this.pool, sessionId, conversationId);
    const selected = await this.pool.query(`
      SELECT t.*
      FROM turns t
      JOIN messages inbound ON inbound.id = t.user_message_id
      WHERE t.conversation_id = $1 AND t.state NOT IN ('delivered', 'failed')
      ORDER BY inbound.sequence ASC, t.id ASC
      LIMIT 1
    `, [conversationId]);
    return selected.rowCount === 1 ? mapRow(selected.rows[0]) : null;
  }

  async claimNextTurn({ workerId, leaseToken, leaseUntil, now }) {
    if (!workerId || !leaseToken) throw new Error('workerId and leaseToken are required');
    const current = asIso(now);
    const expiry = asIso(leaseUntil);
    if (asDate(expiry).getTime() <= asDate(current).getTime()) throw new Error('leaseUntil must be in the future');
    return this.#transaction(async (client) => {
      const selected = await client.query(TURN_CLAIM_STATEMENT, [workerId, leaseToken, expiry, current]);
      return selected.rowCount === 1 ? mapRow(selected.rows[0]) : null;
    });
  }

  async renewTurnLease({ turnId, leaseToken, leaseUntil, now }) {
    const current = asIso(now);
    const expiry = asIso(leaseUntil);
    if (asDate(expiry).getTime() <= asDate(current).getTime()) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    }
    const updated = await this.pool.query(`
      UPDATE turns
      SET lease_expires_at = $3, updated_at = $4
      WHERE id = $1 AND lease_token = $2
        AND lease_expires_at > $4
        AND state NOT IN ('delivered', 'failed')
      RETURNING *
    `, [turnId, leaseToken, expiry, current]);
    if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    return mapRow(updated.rows[0]);
  }

  async #liveTurn(client, { turnId, leaseToken, now }) {
    const selected = await client.query(`
      SELECT * FROM turns
      WHERE id = $1 AND lease_token = $2
        AND lease_expires_at > $3
        AND state NOT IN ('delivered', 'failed')
      FOR UPDATE
    `, [turnId, leaseToken, asIso(now)]);
    if (selected.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    return mapRow(selected.rows[0]);
  }

  async #lockTurnOwnership(client, turnId) {
    const owner = await client.query('SELECT session_id, conversation_id FROM turns WHERE id = $1', [turnId]);
    if (owner.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    try {
      await this.#lockSessionConversation(
        client,
        owner.rows[0].session_id,
        owner.rows[0].conversation_id,
      );
    } catch (error) {
      if (error?.code === 'SESSION_NOT_FOUND' || error?.code === 'NOT_FOUND') {
        throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      }
      throw error;
    }
  }

  async #appendEvent(client, { sessionId, conversationId, type, messageId = null, turnId = null, payloadJson = {}, now }) {
    const timestamp = asIso(now);
    const cursorResult = await client.query(`
      UPDATE conversations
      SET event_high_water = event_high_water + 1, updated_at = $2
      WHERE id = $1 AND session_id = $3
      RETURNING event_high_water
    `, [conversationId, timestamp, sessionId]);
    if (cursorResult.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested conversation was not found.');
    const inserted = await client.query(`
      INSERT INTO events (
        id, session_id, conversation_id, cursor, type, message_id, turn_id,
        payload_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      RETURNING *
    `, [
      randomUUID(), sessionId, conversationId,
      Number(cursorResult.rows[0].event_high_water), type, messageId, turnId,
      JSON.stringify(payloadJson), timestamp,
    ]);
    return mapRow(inserted.rows[0]);
  }

  async setTurnState({ turnId, leaseToken, state, now }) {
    if (!TURN_STATES.has(state) || TURN_TERMINAL_STATES.has(state)) {
      throw new Error('setTurnState requires a nonterminal state');
    }
    return this.#transaction(async (client) => {
      await this.#lockTurnOwnership(client, turnId);
      const turn = await this.#liveTurn(client, { turnId, leaseToken, now });
      if (turn.state === state) return { turn, event: null, changed: false };
      if (NONTERMINAL_TRANSITIONS[turn.state] !== state) {
        throw storeError('INVALID_TURN_TRANSITION', 'The requested turn transition is not allowed.');
      }
      const updated = await client.query(`
        UPDATE turns
        SET state = $3, failure_code = NULL, updated_at = $4
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $4
        RETURNING *
      `, [turnId, leaseToken, state, asIso(now)]);
      if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      const mapped = mapRow(updated.rows[0]);
      const event = await this.#appendEvent(client, {
        sessionId: mapped.sessionId, conversationId: mapped.conversationId,
        type: 'turn.state', turnId, payloadJson: { turnId, state }, now,
      });
      return { turn: mapped, event, changed: true };
    });
  }

  async getTurnContext({ turnId }) {
    const turnResult = await this.pool.query('SELECT * FROM turns WHERE id = $1', [turnId]);
    if (turnResult.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested turn was not found.');
    const turn = mapRow(turnResult.rows[0]);
    const selected = await this.pool.query(`
      SELECT m.*, inbound.sequence AS turn_sequence
      FROM messages m
      JOIN turns owner_turn ON owner_turn.id = m.turn_id
      JOIN messages inbound ON inbound.id = owner_turn.user_message_id
      JOIN messages target_inbound ON target_inbound.id = $1
      WHERE owner_turn.conversation_id = $2
        AND (
          (owner_turn.id = $3 AND m.id = owner_turn.user_message_id)
          OR (owner_turn.state = 'delivered' AND inbound.sequence < target_inbound.sequence)
        )
      ORDER BY inbound.sequence ASC,
        CASE WHEN m.role = 'user' THEN 0 ELSE 1 END ASC,
        m.sequence ASC
    `, [turn.userMessageId, turn.conversationId, turn.id]);
    const messages = mapRows(selected.rows).map(({ turnSequence, ...message }) => message);
    const conversationResult = await this.pool.query('SELECT * FROM conversations WHERE id = $1', [turn.conversationId]);
    return {
      turn,
      conversation: conversationResult.rowCount === 1 ? mapRow(conversationResult.rows[0]) : null,
      messages: retainRecentCompletePairs(messages, { maxBytes: contextLimits.turnBytes, contentKey: 'text' }),
    };
  }

  async failTurn({ turnId, leaseToken, failureCode, now }) {
    return this.#transaction(async (client) => {
      await this.#lockTurnOwnership(client, turnId);
      const turn = await this.#liveTurn(client, { turnId, leaseToken, now });
      const safeFailureCode = SAFE_TURN_FAILURE_CODES.has(failureCode) ? failureCode : 'ANSWER_FAILED';
      const timestamp = asIso(now);
      const updated = await client.query(`
        UPDATE turns
        SET state = 'failed', failure_code = $3, lease_token = NULL,
            lease_expires_at = NULL, worker_id = NULL, updated_at = $4
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $4
        RETURNING *
      `, [turnId, leaseToken, safeFailureCode, timestamp]);
      if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      const inbound = await client.query(`
        UPDATE messages SET status = 'failed', failure_code = $2
        WHERE id = $1 RETURNING *
      `, [turn.userMessageId, safeFailureCode]);
      if (inbound.rowCount !== 1) throw new Error('PostgreSQL store state is corrupt');
      const event = await this.#appendEvent(client, {
        sessionId: turn.sessionId, conversationId: turn.conversationId,
        type: 'turn.failed', messageId: turn.userMessageId, turnId,
        payloadJson: { messageId: turn.userMessageId, turnId, failureCode: safeFailureCode }, now,
      });
      return { turn: mapRow(updated.rows[0]), event };
    });
  }

  async deliverAssistant({ turnId, leaseToken, message, now }) {
    if (!message || typeof message.text !== 'string' || !message.text.trim()) {
      throw new Error('Assistant message text is required');
    }
    return this.#transaction(async (client) => {
      await this.#lockTurnOwnership(client, turnId);
      const turn = await this.#liveTurn(client, { turnId, leaseToken, now });
      if (turn.state !== 'generating') {
        throw storeError('INVALID_TURN_TRANSITION', 'Assistant delivery requires a generating turn.');
      }
      const duplicate = await client.query(`
        SELECT id FROM messages WHERE turn_id = $1 AND role = 'assistant' FOR UPDATE
      `, [turnId]);
      if (duplicate.rowCount > 0) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      const sequenceResult = await client.query(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM messages WHERE conversation_id = $1
      `, [turn.conversationId]);
      const timestamp = asIso(now);
      let inserted;
      try {
        inserted = await client.query(`
          INSERT INTO messages (
            id, session_id, conversation_id, turn_id, client_message_id,
            sequence, role, kind, status, failure_code, text,
            reply_language, reply_mode,
            voice_draft_id, media_id, citations, cards, suggested_replies,
            needs_clarification, grounding_status, provider,
            provider_latency_ms, created_at
          ) VALUES (
            $1, $2, $3, $4, NULL,
            $5, 'assistant', 'text', 'delivered', NULL, $6, $7, $8,
            NULL, NULL, $9::jsonb, $10::jsonb, $11::jsonb,
            $12, $13, $14, $15, $16
          ) RETURNING *
        `, [
          randomUUID(), turn.sessionId, turn.conversationId, turnId,
          Number(sequenceResult.rows[0].next_sequence), message.text.trim(),
          turn.replyLanguage, turn.replyMode,
          JSON.stringify(message.citations ?? []), JSON.stringify(message.cards ?? []),
          JSON.stringify(message.suggestedReplies ?? []), Boolean(message.needsClarification),
          message.groundingStatus === 'verified' ? 'verified' : 'unverified',
          typeof message.provider === 'string' ? message.provider : null,
          Number.isFinite(message.providerLatencyMs) ? message.providerLatencyMs : null,
          timestamp,
        ]);
      } catch (error) {
        pgUnique(error, 'LEASE_LOST', 'The worker no longer owns this turn.');
      }
      const inbound = await client.query(`
        UPDATE messages SET status = 'delivered', failure_code = NULL
        WHERE id = $1 RETURNING *
      `, [turn.userMessageId]);
      if (inbound.rowCount !== 1) throw new Error('PostgreSQL store state is corrupt');
      const completedTurn = await client.query(`
        UPDATE turns
        SET state = 'delivered', failure_code = NULL, lease_token = NULL,
            lease_expires_at = NULL, worker_id = NULL, updated_at = $3
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $3
        RETURNING *
      `, [turnId, leaseToken, timestamp]);
      if (completedTurn.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      const assistant = mapRow(inserted.rows[0]);
      const event = await this.#appendEvent(client, {
        sessionId: turn.sessionId, conversationId: turn.conversationId,
        type: 'message.delivered', messageId: assistant.id, turnId,
        payloadJson: { messageId: assistant.id, turnId }, now,
      });
      return { turn: mapRow(completedTurn.rows[0]), message: assistant, event };
    });
  }

  async #assertAttemptStorageKeyAvailable(client, storageKey, { uploadId = null, generationId = null } = {}) {
    if (typeof storageKey !== 'string' || !storageKey) throw new Error('attemptStorageKey is required');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1)) AS locked', [storageKey]);
    const collision = await client.query(`
      SELECT storage_key FROM media_assets WHERE storage_key = $1
      UNION ALL
      SELECT attempt_storage_key AS storage_key FROM voice_uploads
        WHERE attempt_storage_key = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)
      UNION ALL
      SELECT attempt_storage_key AS storage_key FROM media_generations
        WHERE attempt_storage_key = $1 AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1
    `, [storageKey, uploadId, generationId]);
    if (collision.rowCount > 0) throw storeError('STORAGE_KEY_CONFLICT', 'The media storage key is already in use.');
  }

  async #enqueueDeletion(client, {
    storageKey, reason, notBefore, now, rearm = false, sweepObservation = null,
  }) {
    if (typeof storageKey !== 'string' || !storageKey) throw new Error('storageKey is required');
    const timestamp = asIso(now);
    const safeNotBefore = asIso(notBefore ?? now);
    const id = randomUUID();
    let upserted;
    if (rearm) {
      upserted = await client.query(`
        INSERT INTO media_deletion_jobs (
          id, storage_key, reason, not_before, state, attempt, generation,
          lease_token, lease_expires_at, worker_id, last_error_code,
          sweep_observation, created_at, updated_at, completed_at
        ) VALUES ($1, $2, $3, $4, 'pending', 0, 1, NULL, NULL, NULL, NULL, $5, $6, $6, NULL)
        ON CONFLICT (storage_key) DO UPDATE SET
          reason = EXCLUDED.reason,
          not_before = EXCLUDED.not_before,
          state = 'pending',
          attempt = 0,
          generation = media_deletion_jobs.generation + 1,
          lease_token = NULL,
          lease_expires_at = NULL,
          worker_id = NULL,
          last_error_code = NULL,
          sweep_observation = EXCLUDED.sweep_observation,
          updated_at = EXCLUDED.updated_at,
          completed_at = NULL
        RETURNING *
      `, [id, storageKey, reason, safeNotBefore, sweepObservation, timestamp]);
    } else if (sweepObservation !== null) {
      upserted = await client.query(`
        INSERT INTO media_deletion_jobs (
          id, storage_key, reason, not_before, state, attempt, generation,
          lease_token, lease_expires_at, worker_id, last_error_code,
          sweep_observation, created_at, updated_at, completed_at
        ) VALUES ($1, $2, $3, $4, 'pending', 0, 1, NULL, NULL, NULL, NULL, $5, $6, $6, NULL)
        ON CONFLICT (storage_key) DO UPDATE SET
          reason = EXCLUDED.reason,
          not_before = EXCLUDED.not_before,
          state = 'pending',
          attempt = 0,
          generation = media_deletion_jobs.generation + 1,
          lease_token = NULL,
          lease_expires_at = NULL,
          worker_id = NULL,
          last_error_code = NULL,
          sweep_observation = EXCLUDED.sweep_observation,
          updated_at = EXCLUDED.updated_at,
          completed_at = NULL
        WHERE media_deletion_jobs.sweep_observation IS DISTINCT FROM EXCLUDED.sweep_observation
        RETURNING *
      `, [id, storageKey, reason, safeNotBefore, sweepObservation, timestamp]);
    } else {
      upserted = await client.query(`
        INSERT INTO media_deletion_jobs (
          id, storage_key, reason, not_before, state, attempt, generation,
          lease_token, lease_expires_at, worker_id, last_error_code,
          sweep_observation, created_at, updated_at, completed_at
        ) VALUES ($1, $2, $3, $4, 'pending', 0, 1, NULL, NULL, NULL, NULL, $5, $6, $6, NULL)
        ON CONFLICT (storage_key) DO UPDATE SET
          reason = EXCLUDED.reason,
          not_before = GREATEST(media_deletion_jobs.not_before, EXCLUDED.not_before),
          updated_at = EXCLUDED.updated_at
        WHERE media_deletion_jobs.state <> 'completed'
        RETURNING *
      `, [id, storageKey, reason, safeNotBefore, sweepObservation, timestamp]);
    }
    if (upserted.rowCount === 1) return mapRow(upserted.rows[0]);
    const existing = await client.query('SELECT * FROM media_deletion_jobs WHERE storage_key = $1', [storageKey]);
    if (existing.rowCount !== 1) throw new Error('PostgreSQL deletion outbox is unavailable');
    return mapRow(existing.rows[0]);
  }

  async claimVoiceUploadWithRateLimits({
    sessionId, clientUploadId, requestSha256, mimeType, rateLimits = [],
    leaseToken, attemptStorageKey, leaseExpiresAt, attemptDeadlineAt, now,
  }) {
    const current = asIso(now);
    const requestedLease = asIso(leaseExpiresAt);
    const deadline = asIso(attemptDeadlineAt);
    if (!leaseToken || asDate(requestedLease).getTime() <= asDate(current).getTime()
      || asDate(deadline).getTime() <= asDate(current).getTime()) {
      throw new Error('A live lease token, expiry, and hard deadline are required');
    }
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId, { lock: true });
      const selected = await client.query(`
        SELECT * FROM voice_uploads
        WHERE session_id = $1 AND client_upload_id = $2
        FOR UPDATE
      `, [sessionId, clientUploadId]);
      let upload = selected.rowCount === 1 ? mapRow(selected.rows[0]) : null;
      if (upload) {
        if (upload.state === 'failed' && upload.failureCode === 'VOICE_UPLOAD_CANCELLED') {
          return { status: 'permanent_failure', upload, failureCode: upload.failureCode, failureHttpStatus: 410, retryable: false };
        }
        if (upload.requestSha256 !== requestSha256 || upload.mimeType !== mimeType) {
          return { status: 'conflict', upload };
        }
        if (upload.state === 'ready') {
          const asset = await client.query('SELECT * FROM media_assets WHERE id = $1 AND session_id = $2', [upload.mediaAssetId, sessionId]);
          if (asset.rowCount !== 1) throw new Error('PostgreSQL store state is corrupt');
          return { status: 'ready', upload, mediaAsset: mapRow(asset.rows[0]) };
        }
        if (upload.state === 'failed' && !upload.retryable) {
          return {
            status: 'permanent_failure', upload, failureCode: upload.failureCode,
            failureHttpStatus: upload.failureHttpStatus, retryable: false,
          };
        }
        if (['uploading', 'transcribing'].includes(upload.state) && liveAttempt(upload, current)) {
          return { status: 'live', upload };
        }
      }
      const rateState = await this.#prepareRateBuckets(client, rateLimits);
      if (rateState.blockingExpiresAt) return { status: 'rate_limited', blockingExpiresAt: rateState.blockingExpiresAt };
      await this.#assertAttemptStorageKeyAvailable(client, attemptStorageKey, { uploadId: upload?.id });
      if (upload?.attemptStorageKey) {
        const safeHorizon = new Date(asDate(laterIso(upload.leaseExpiresAt, upload.attemptDeadlineAt, current)).getTime() + ATTEMPT_CLEANUP_GRACE_MS);
        await this.#enqueueDeletion(client, {
          storageKey: upload.attemptStorageKey, reason: 'voice-attempt-displaced',
          notBefore: safeHorizon, now: current, rearm: true,
        });
      }
      await this.#incrementRateBuckets(client, rateState.locked);
      const effectiveLease = new Date(Math.min(asDate(requestedLease).getTime(), asDate(deadline).getTime())).toISOString();
      let changed;
      if (upload) {
        changed = await client.query(`
          UPDATE voice_uploads SET
            state = 'uploading', attempt = attempt + 1, lease_token = $2,
            lease_expires_at = $3, attempt_storage_key = $4,
            attempt_started_at = $5, attempt_deadline_at = $6,
            media_asset_id = NULL, transcript = NULL, failure_code = NULL,
            failure_http_status = NULL, retryable = NULL, updated_at = $5
          WHERE id = $1 RETURNING *
        `, [upload.id, leaseToken, effectiveLease, attemptStorageKey, current, deadline]);
      } else {
        changed = await client.query(`
          INSERT INTO voice_uploads (
            id, session_id, client_upload_id, request_sha256, mime_type, state,
            attempt, lease_token, lease_expires_at, attempt_storage_key,
            attempt_started_at, attempt_deadline_at, media_asset_id, transcript,
            failure_code, failure_http_status, retryable, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, 'uploading',
            1, $6, $7, $8, $9, $10, NULL, NULL, NULL, NULL, NULL, $9, $9
          ) RETURNING *
        `, [randomUUID(), sessionId, clientUploadId, requestSha256, mimeType, leaseToken, effectiveLease, attemptStorageKey, current, deadline]);
      }
      upload = mapRow(changed.rows[0]);
      return { status: 'claimed', upload };
    });
  }

  async renewVoiceUploadLease({ uploadId, leaseToken, leaseExpiresAt, now }) {
    const current = asIso(now);
    const requested = asIso(leaseExpiresAt);
    if (asDate(requested).getTime() <= asDate(current).getTime()) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
    }
    const updated = await this.pool.query(`
      UPDATE voice_uploads
      SET lease_expires_at = LEAST($3, attempt_deadline_at), updated_at = $4
      WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $4
        AND attempt_deadline_at > $4 AND state IN ('uploading', 'transcribing')
      RETURNING *
    `, [uploadId, leaseToken, requested, current]);
    if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
    return mapRow(updated.rows[0]);
  }

  async setVoiceUploadTranscribing({ uploadId, leaseToken, now }) {
    const current = asIso(now);
    const updated = await this.pool.query(`
      UPDATE voice_uploads
      SET state = 'transcribing', updated_at = $3
      WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $3
        AND attempt_deadline_at > $3 AND state IN ('uploading', 'transcribing')
      RETURNING *
    `, [uploadId, leaseToken, current]);
    if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
    return mapRow(updated.rows[0]);
  }

  async getVoiceUploadStatus({ sessionId, clientUploadId }) {
    await this.#activeSession(this.pool, sessionId);
    const selected = await this.pool.query(`
      SELECT u.*, to_jsonb(a) AS media_asset
      FROM voice_uploads u
      LEFT JOIN media_assets a ON a.id = u.media_asset_id AND a.session_id = u.session_id
      WHERE u.session_id = $1 AND u.client_upload_id = $2
    `, [sessionId, clientUploadId]);
    if (selected.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested voice upload was not found.');
    const upload = mapRow(selected.rows[0]);
    upload.mediaAsset = selected.rows[0].media_asset ? mapRow(selected.rows[0].media_asset) : null;
    return upload;
  }

  async #liveVoiceUpload(client, { uploadId, leaseToken, now }) {
    const owner = await client.query('SELECT session_id FROM voice_uploads WHERE id = $1', [uploadId]);
    if (owner.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
    try {
      await this.#activeSession(client, owner.rows[0].session_id, { lock: true });
    } catch (error) {
      if (error?.code === 'SESSION_NOT_FOUND') {
        throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      }
      throw error;
    }
    const selected = await client.query(`
      SELECT * FROM voice_uploads
      WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $3
        AND attempt_deadline_at > $3 AND state IN ('uploading', 'transcribing')
      FOR UPDATE
    `, [uploadId, leaseToken, asIso(now)]);
    if (selected.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
    return mapRow(selected.rows[0]);
  }

  async cancelVoiceUpload({ sessionId, clientUploadId, cleanupNotBefore, now }) {
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId, { lock: true });
      const selected = await client.query(`
        SELECT * FROM voice_uploads
        WHERE session_id = $1 AND client_upload_id = $2
        FOR UPDATE
      `, [sessionId, clientUploadId]);
      if (selected.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested voice upload was not found.');
      const upload = mapRow(selected.rows[0]);
      if (upload.state === 'failed' && upload.failureCode === 'VOICE_UPLOAD_CANCELLED') {
        if (upload.mediaAssetId || upload.transcript || upload.attemptStorageKey) throw new Error('PostgreSQL store state is corrupt');
        return upload;
      }
      if (upload.mediaAssetId) {
        const assetResult = await client.query(`
          SELECT * FROM media_assets WHERE id = $1 AND session_id = $2 FOR UPDATE
        `, [upload.mediaAssetId, sessionId]);
        if (assetResult.rowCount !== 1) throw new Error('PostgreSQL store state is corrupt');
        const asset = mapRow(assetResult.rows[0]);
        if (asset.status === 'attached' || asset.ownerMessageId) {
          throw storeError('VOICE_DRAFT_ALREADY_ATTACHED', 'The voice draft is already attached to a message.');
        }
        if (asset.kind !== 'user_voice' || asset.status !== 'draft') throw new Error('PostgreSQL store state is corrupt');
        await this.#enqueueDeletion(client, {
          storageKey: asset.storageKey, reason: 'voice-upload-cancelled-draft',
          notBefore: cleanupNotBefore ?? now, now, rearm: true,
        });
        await client.query('DELETE FROM media_assets WHERE id = $1 AND session_id = $2', [asset.id, sessionId]);
      } else if (upload.attemptStorageKey) {
        const horizon = new Date(asDate(laterIso(cleanupNotBefore ?? now, upload.leaseExpiresAt, upload.attemptDeadlineAt)).getTime() + ATTEMPT_CLEANUP_GRACE_MS);
        await this.#enqueueDeletion(client, {
          storageKey: upload.attemptStorageKey, reason: 'voice-upload-cancelled-attempt',
          notBefore: horizon, now, rearm: true,
        });
      }
      const updated = await client.query(`
        UPDATE voice_uploads SET
          state = 'failed', media_asset_id = NULL, transcript = NULL,
          failure_code = 'VOICE_UPLOAD_CANCELLED', failure_http_status = 410,
          retryable = false, lease_token = NULL, lease_expires_at = NULL,
          attempt_storage_key = NULL, updated_at = $2
        WHERE id = $1 RETURNING *
      `, [upload.id, asIso(now)]);
      return mapRow(updated.rows[0]);
    });
  }

  async completeVoiceUpload({ uploadId, leaseToken, mediaAsset, transcript, now }) {
    return this.#transaction(async (client) => {
      const upload = await this.#liveVoiceUpload(client, { uploadId, leaseToken, now });
      if (upload.state !== 'transcribing' || typeof transcript !== 'string' || !transcript.trim()
        || mediaAsset?.storageKey !== upload.attemptStorageKey) {
        throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1)) AS locked', [mediaAsset.storageKey]);
      const collision = await client.query('SELECT id FROM media_assets WHERE storage_key = $1', [mediaAsset.storageKey]);
      if (collision.rowCount > 0) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      const timestamp = asIso(now);
      const inserted = await client.query(`
        INSERT INTO media_assets (
          id, session_id, owner_message_id, kind, storage_key, mime_type,
          byte_length, duration_ms, sha256, status, expires_at, created_at, updated_at
        ) VALUES ($1, $2, NULL, 'user_voice', $3, $4, $5, $6, $7, 'draft', $8, $9, $9)
        RETURNING *
      `, [
        randomUUID(), upload.sessionId, mediaAsset.storageKey, mediaAsset.mimeType,
        mediaAsset.byteLength, mediaAsset.durationMs ?? null, mediaAsset.sha256,
        mediaAsset.expiresAt ? asIso(mediaAsset.expiresAt) : null, timestamp,
      ]);
      const asset = mapRow(inserted.rows[0]);
      const completed = await client.query(`
        UPDATE voice_uploads SET
          state = 'ready', media_asset_id = $3, transcript = $4,
          failure_code = NULL, failure_http_status = NULL, retryable = false,
          lease_token = NULL, lease_expires_at = NULL, updated_at = $5
        WHERE id = $1 AND lease_token = $2 AND state = 'transcribing'
          AND lease_expires_at > $5 AND attempt_deadline_at > $5
        RETURNING *
      `, [uploadId, leaseToken, asset.id, transcript.trim(), timestamp]);
      if (completed.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      return { upload: mapRow(completed.rows[0]), mediaAsset: asset };
    });
  }

  async failVoiceUpload({
    uploadId, leaseToken, failureCode, failureHttpStatus, retryable,
    cleanupNotBefore, now,
  }) {
    return this.#transaction(async (client) => {
      const upload = await this.#liveVoiceUpload(client, { uploadId, leaseToken, now });
      if (upload.attemptStorageKey) {
        await this.#enqueueDeletion(client, {
          storageKey: upload.attemptStorageKey, reason: 'voice-attempt-failed',
          notBefore: cleanupNotBefore ?? now, now,
        });
      }
      const updated = await client.query(`
        UPDATE voice_uploads SET
          state = 'failed', failure_code = $3, failure_http_status = $4,
          retryable = $5, lease_token = NULL, lease_expires_at = NULL,
          attempt_storage_key = NULL, updated_at = $6
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $6
          AND attempt_deadline_at > $6 AND state IN ('uploading', 'transcribing')
        RETURNING *
      `, [
        uploadId, leaseToken, String(failureCode || 'VOICE_TRANSCRIPTION_FAILED'),
        Number(failureHttpStatus) || 502, Boolean(retryable), asIso(now),
      ]);
      if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this voice upload.');
      return mapRow(updated.rows[0]);
    });
  }

  async claimAssistantAudioWithRateLimits({
    sessionId, messageId, kind, rateLimits = [], leaseToken, attemptStorageKey,
    configVersion, leaseExpiresAt, attemptDeadlineAt, now,
  }) {
    const current = asIso(now);
    const requestedLease = asIso(leaseExpiresAt);
    const deadline = asIso(attemptDeadlineAt);
    if (!leaseToken || asDate(requestedLease).getTime() <= asDate(current).getTime()
      || asDate(deadline).getTime() <= asDate(current).getTime()) {
      throw new Error('A live lease token, expiry, and hard deadline are required');
    }
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId, { lock: true });
      const messageResult = await client.query(`
        SELECT * FROM messages
        WHERE id = $1 AND session_id = $2
          AND role = 'assistant' AND status = 'delivered'
        FOR UPDATE
      `, [messageId, sessionId]);
      if (messageResult.rowCount !== 1 || kind !== 'assistant_voice') return { status: 'conflict' };
      const message = mapRow(messageResult.rows[0]);
      const selected = await client.query(`
        SELECT * FROM media_generations
        WHERE owner_message_id = $1 AND kind = $2
        FOR UPDATE
      `, [messageId, kind]);
      let generation = selected.rowCount === 1 ? mapRow(selected.rows[0]) : null;
      if (generation) {
        if (generation.state === 'attached') {
          const asset = await client.query('SELECT * FROM media_assets WHERE id = $1 AND session_id = $2', [generation.mediaAssetId, sessionId]);
          if (asset.rowCount !== 1) throw new Error('PostgreSQL store state is corrupt');
          return { status: 'ready', generation, mediaAsset: mapRow(asset.rows[0]) };
        }
        if (generation.state === 'failed' && !generation.retryable) {
          return {
            status: 'permanent_failure', generation,
            failureCode: generation.failureCode,
            failureHttpStatus: generation.failureHttpStatus,
            retryable: false,
          };
        }
        if (generation.state === 'generating' && liveAttempt(generation, current)) {
          return { status: 'live', generation };
        }
      }
      const rateState = await this.#prepareRateBuckets(client, rateLimits);
      if (rateState.blockingExpiresAt) return { status: 'rate_limited', blockingExpiresAt: rateState.blockingExpiresAt };
      await this.#assertAttemptStorageKeyAvailable(client, attemptStorageKey, { generationId: generation?.id });
      if (generation?.attemptStorageKey) {
        const safeHorizon = new Date(asDate(laterIso(generation.leaseExpiresAt, generation.attemptDeadlineAt, current)).getTime() + ATTEMPT_CLEANUP_GRACE_MS);
        await this.#enqueueDeletion(client, {
          storageKey: generation.attemptStorageKey, reason: 'tts-attempt-displaced',
          notBefore: safeHorizon, now: current, rearm: true,
        });
      }
      await this.#incrementRateBuckets(client, rateState.locked);
      const effectiveLease = new Date(Math.min(asDate(requestedLease).getTime(), asDate(deadline).getTime())).toISOString();
      let changed;
      if (generation) {
        changed = await client.query(`
          UPDATE media_generations SET
            state = 'generating', attempt = attempt + 1, lease_token = $2,
            lease_expires_at = $3, attempt_storage_key = $4,
            attempt_started_at = $5, attempt_deadline_at = $6,
            media_asset_id = NULL, failure_code = NULL,
            failure_http_status = NULL, retryable = NULL,
            config_version = $7, updated_at = $5
          WHERE id = $1 RETURNING *
        `, [generation.id, leaseToken, effectiveLease, attemptStorageKey, current, deadline, String(configVersion ?? 'unversioned')]);
      } else {
        changed = await client.query(`
          INSERT INTO media_generations (
            id, owner_message_id, kind, state, attempt, lease_token,
            lease_expires_at, attempt_storage_key, attempt_started_at,
            attempt_deadline_at, media_asset_id, failure_code,
            failure_http_status, retryable, config_version, created_at, updated_at
          ) VALUES (
            $1, $2, $3, 'generating', 1, $4,
            $5, $6, $7, $8, NULL, NULL, NULL, NULL, $9, $7, $7
          ) RETURNING *
        `, [randomUUID(), messageId, kind, leaseToken, effectiveLease, attemptStorageKey, current, deadline, String(configVersion ?? 'unversioned')]);
      }
      generation = mapRow(changed.rows[0]);
      return { status: 'claimed', generation, message };
    });
  }

  async renewMediaGenerationLease({ generationId, leaseToken, leaseExpiresAt, now }) {
    const current = asIso(now);
    const requested = asIso(leaseExpiresAt);
    if (asDate(requested).getTime() <= asDate(current).getTime()) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
    }
    const updated = await this.pool.query(`
      UPDATE media_generations
      SET lease_expires_at = LEAST($3, attempt_deadline_at), updated_at = $4
      WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $4
        AND attempt_deadline_at > $4 AND state = 'generating'
      RETURNING *
    `, [generationId, leaseToken, requested, current]);
    if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
    return mapRow(updated.rows[0]);
  }

  async #liveMediaGeneration(client, { generationId, leaseToken, now }) {
    const owner = await client.query(`
      SELECT m.session_id, m.conversation_id
      FROM media_generations g
      JOIN messages m ON m.id = g.owner_message_id
      WHERE g.id = $1
    `, [generationId]);
    if (owner.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
    try {
      await this.#lockSessionConversation(
        client,
        owner.rows[0].session_id,
        owner.rows[0].conversation_id,
      );
    } catch (error) {
      if (error?.code === 'SESSION_NOT_FOUND' || error?.code === 'NOT_FOUND') {
        throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      }
      throw error;
    }
    const selected = await client.query(`
      SELECT g.*, m.session_id, m.conversation_id, m.turn_id
      FROM media_generations g
      JOIN messages m ON m.id = g.owner_message_id
      WHERE g.id = $1 AND g.lease_token = $2 AND g.lease_expires_at > $3
        AND g.attempt_deadline_at > $3 AND g.state = 'generating'
      FOR UPDATE OF g
    `, [generationId, leaseToken, asIso(now)]);
    if (selected.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
    return mapRow(selected.rows[0]);
  }

  async getAssistantAudioStatus({ sessionId, messageId, kind }) {
    await this.#activeSession(this.pool, sessionId);
    const message = await this.pool.query(`
      SELECT id FROM messages
      WHERE id = $1 AND session_id = $2 AND role = 'assistant' AND status = 'delivered'
    `, [messageId, sessionId]);
    if (message.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested assistant message was not found.');
    const selected = await this.pool.query(`
      SELECT g.*, to_jsonb(a) AS media_asset
      FROM media_generations g
      LEFT JOIN media_assets a ON a.id = g.media_asset_id AND a.session_id = $3
      WHERE g.owner_message_id = $1 AND g.kind = $2
    `, [messageId, kind, sessionId]);
    if (selected.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested assistant audio was not found.');
    const generation = mapRow(selected.rows[0]);
    generation.mediaAsset = selected.rows[0].media_asset ? mapRow(selected.rows[0].media_asset) : null;
    return generation;
  }

  async getOwnedAssistantMessage({ sessionId, messageId }) {
    await this.#activeSession(this.pool, sessionId);
    const selected = await this.pool.query(`
      SELECT * FROM messages
      WHERE id = $1 AND session_id = $2 AND role = 'assistant' AND status = 'delivered'
    `, [messageId, sessionId]);
    if (selected.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested assistant message was not found.');
    return mapRow(selected.rows[0]);
  }

  async listAssistantAudioRecoveryCandidates({ limit = 25, now } = {}) {
    const maximum = Math.max(1, Math.min(Number(limit) || 25, 25));
    const current = asIso(now);
    const selected = await this.pool.query(`
      SELECT m.id, m.session_id, m.reply_language, m.reply_mode, m.created_at
      FROM messages m
      LEFT JOIN media_generations g
        ON g.owner_message_id = m.id AND g.kind = 'assistant_voice'
      WHERE m.role = 'assistant' AND m.status = 'delivered'
        AND m.media_id IS NULL
        AND (
          (m.reply_mode = 'voice' AND g.id IS NULL)
          OR (
            g.id IS NOT NULL
            AND (
              (g.state = 'failed' AND g.retryable = TRUE)
              OR (
                g.state = 'generating'
                AND (
                  g.lease_expires_at IS NULL OR g.lease_expires_at <= $2
                  OR g.attempt_deadline_at IS NULL OR g.attempt_deadline_at <= $2
                )
              )
            )
          )
        )
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT $1
    `, [maximum, current]);
    return mapRows(selected.rows);
  }

  async completeMediaGeneration({ generationId, leaseToken, mediaAsset, now }) {
    return this.#transaction(async (client) => {
      const generation = await this.#liveMediaGeneration(client, { generationId, leaseToken, now });
      if (mediaAsset?.storageKey !== generation.attemptStorageKey) {
        throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1)) AS locked', [mediaAsset.storageKey]);
      const collision = await client.query('SELECT id FROM media_assets WHERE storage_key = $1', [mediaAsset.storageKey]);
      if (collision.rowCount > 0) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      const timestamp = asIso(now);
      const inserted = await client.query(`
        INSERT INTO media_assets (
          id, session_id, owner_message_id, kind, storage_key, mime_type,
          byte_length, duration_ms, sha256, status, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 'assistant_voice', $4, $5, $6, $7, $8, 'attached', $9, $10, $10)
        RETURNING *
      `, [
        randomUUID(), generation.sessionId, generation.ownerMessageId,
        mediaAsset.storageKey, mediaAsset.mimeType, mediaAsset.byteLength,
        mediaAsset.durationMs ?? null, mediaAsset.sha256,
        mediaAsset.expiresAt ? asIso(mediaAsset.expiresAt) : null, timestamp,
      ]);
      const asset = mapRow(inserted.rows[0]);
      const message = await client.query(`
        UPDATE messages SET media_id = $2
        WHERE id = $1 AND session_id = $3 AND role = 'assistant' AND status = 'delivered'
        RETURNING *
      `, [generation.ownerMessageId, asset.id, generation.sessionId]);
      if (message.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      const completed = await client.query(`
        UPDATE media_generations SET
          state = 'attached', media_asset_id = $3, failure_code = NULL,
          failure_http_status = NULL, retryable = false, lease_token = NULL,
          lease_expires_at = NULL, updated_at = $4
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $4
          AND attempt_deadline_at > $4 AND state = 'generating'
        RETURNING *
      `, [generationId, leaseToken, asset.id, timestamp]);
      if (completed.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      const mappedMessage = mapRow(message.rows[0]);
      const event = await this.#appendEvent(client, {
        sessionId: mappedMessage.sessionId, conversationId: mappedMessage.conversationId,
        type: 'audio.ready', messageId: mappedMessage.id, turnId: mappedMessage.turnId,
        payloadJson: { messageId: mappedMessage.id, mediaId: asset.id }, now,
      });
      return {
        generation: mapRow(completed.rows[0]), mediaAsset: asset,
        message: mappedMessage, event,
      };
    });
  }

  async failMediaGeneration({
    generationId, leaseToken, failureCode, failureHttpStatus, retryable,
    cleanupNotBefore, now,
  }) {
    return this.#transaction(async (client) => {
      const generation = await this.#liveMediaGeneration(client, { generationId, leaseToken, now });
      if (generation.attemptStorageKey) {
        await this.#enqueueDeletion(client, {
          storageKey: generation.attemptStorageKey, reason: 'tts-attempt-failed',
          notBefore: cleanupNotBefore ?? now, now,
        });
      }
      const updated = await client.query(`
        UPDATE media_generations SET
          state = 'failed', failure_code = $3, failure_http_status = $4,
          retryable = $5, lease_token = NULL, lease_expires_at = NULL,
          attempt_storage_key = NULL, updated_at = $6
        WHERE id = $1 AND lease_token = $2 AND lease_expires_at > $6
          AND attempt_deadline_at > $6 AND state = 'generating'
        RETURNING *
      `, [
        generationId, leaseToken, String(failureCode || 'VOICE_SYNTHESIS_FAILED'),
        Number(failureHttpStatus) || 502, Boolean(retryable), asIso(now),
      ]);
      if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The worker no longer owns this media generation.');
      return mapRow(updated.rows[0]);
    });
  }

  async getMediaAsset({ sessionId, mediaId }) {
    await this.#activeSession(this.pool, sessionId);
    const selected = await this.pool.query('SELECT * FROM media_assets WHERE id = $1 AND session_id = $2', [mediaId, sessionId]);
    if (selected.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested media asset was not found.');
    return mapRow(selected.rows[0]);
  }

  async revokeVoiceDraft({ sessionId, draftId, now, cleanupNotBefore }) {
    return this.#transaction(async (client) => {
      await this.#activeSession(client, sessionId);
      const selected = await client.query(`
        SELECT * FROM media_assets
        WHERE id = $1 AND session_id = $2 AND kind = 'user_voice' AND status = 'draft'
        FOR UPDATE
      `, [draftId, sessionId]);
      if (selected.rowCount !== 1) throw storeError('NOT_FOUND', 'The requested voice draft was not found.');
      const asset = mapRow(selected.rows[0]);
      await this.#enqueueDeletion(client, {
        storageKey: asset.storageKey, reason: 'voice-draft-revoked',
        notBefore: cleanupNotBefore ?? now, now,
      });
      await client.query(`
        UPDATE voice_uploads SET
          state = 'failed', media_asset_id = NULL, transcript = NULL,
          failure_code = 'VOICE_DRAFT_DELETED', failure_http_status = 404,
          retryable = false, attempt_storage_key = NULL, updated_at = $2
        WHERE media_asset_id = $1
      `, [draftId, asIso(now)]);
      await client.query('DELETE FROM media_assets WHERE id = $1 AND session_id = $2', [draftId, sessionId]);
      return { revoked: true, draftId };
    });
  }

  async enqueueMediaDeletion({ storageKey, reason, notBefore, now }) {
    return this.#transaction((client) => this.#enqueueDeletion(client, {
      storageKey, reason, notBefore, now, rearm: false,
    }));
  }

  async rearmMediaDeletionAfterWrite({ storageKey, reason, notBefore, now }) {
    return this.#transaction((client) => this.#enqueueDeletion(client, {
      storageKey, reason, notBefore, now, rearm: true,
    }));
  }

  async rearmMediaDeletionFromSweep({ storageKey, sweepObservation, reason, notBefore, now }) {
    if (typeof sweepObservation !== 'string' || !/^[0-9a-f]{64}$/.test(sweepObservation)) {
      throw new Error('sweepObservation must be a SHA-256 fingerprint');
    }
    return this.#transaction((client) => this.#enqueueDeletion(client, {
      storageKey, reason, notBefore, now, rearm: false, sweepObservation,
    }));
  }

  async claimNextMediaDeletion({ workerId, leaseToken, leaseExpiresAt, now }) {
    const current = asIso(now);
    const expiry = asIso(leaseExpiresAt);
    if (!workerId || !leaseToken || asDate(expiry).getTime() <= asDate(current).getTime()) {
      throw new Error('A worker, token, and live lease are required');
    }
    return this.#transaction(async (client) => {
      const claimed = await client.query(`
        WITH candidate AS (
          SELECT id FROM media_deletion_jobs
          WHERE (state = 'pending' AND not_before <= $4)
             OR (state = 'deleting' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $4)
          ORDER BY not_before ASC, created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE media_deletion_jobs j SET
          state = 'deleting', attempt = j.attempt + 1, worker_id = $1,
          lease_token = $2, lease_expires_at = $3, updated_at = $4
        FROM candidate WHERE j.id = candidate.id
        RETURNING j.*
      `, [workerId, leaseToken, expiry, current]);
      return claimed.rowCount === 1 ? mapRow(claimed.rows[0]) : null;
    });
  }

  async completeMediaDeletion({ jobId, generation, leaseToken, now }) {
    return this.#transaction(async (client) => {
      const updated = await client.query(`
        UPDATE media_deletion_jobs SET
          state = 'completed', lease_token = NULL, lease_expires_at = NULL,
          worker_id = NULL, last_error_code = NULL, completed_at = $4,
          updated_at = $4
        WHERE id = $1 AND generation = $2 AND lease_token = $3
          AND state = 'deleting' AND lease_expires_at > $4
        RETURNING *
      `, [jobId, generation, leaseToken, asIso(now)]);
      if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The cleanup worker no longer owns this job.');
      return mapRow(updated.rows[0]);
    });
  }

  async failMediaDeletion({ jobId, generation, leaseToken, failureCode, retryAt, now }) {
    return this.#transaction(async (client) => {
      const updated = await client.query(`
        UPDATE media_deletion_jobs SET
          state = 'pending', not_before = $4, lease_token = NULL,
          lease_expires_at = NULL, worker_id = NULL, last_error_code = $5,
          updated_at = $6
        WHERE id = $1 AND generation = $2 AND lease_token = $3
          AND state = 'deleting' AND lease_expires_at > $6
        RETURNING *
      `, [
        jobId, generation, leaseToken, asIso(retryAt),
        String(failureCode || 'MEDIA_DELETE_FAILED').slice(0, 128), asIso(now),
      ]);
      if (updated.rowCount !== 1) throw storeError('LEASE_LOST', 'The cleanup worker no longer owns this job.');
      return mapRow(updated.rows[0]);
    });
  }

  async isStorageKeyLive({ storageKey, now }) {
    const graceBoundary = new Date(asDate(now).getTime() - ATTEMPT_CLEANUP_GRACE_MS).toISOString();
    const selected = await this.pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM media_assets WHERE storage_key = $1
        UNION ALL
        SELECT 1 FROM voice_uploads
          WHERE attempt_storage_key = $1
            AND (attempt_deadline_at IS NULL OR attempt_deadline_at >= $2)
        UNION ALL
        SELECT 1 FROM media_generations
          WHERE attempt_storage_key = $1
            AND (attempt_deadline_at IS NULL OR attempt_deadline_at >= $2)
      ) AS live
    `, [storageKey, graceBoundary]);
    return Boolean(selected.rows[0]?.live);
  }

  async #revokeSessionAndEnqueueMedia(client, {
    sessionId, now, cleanupNotBefore, sessionLocked = false,
  }) {
    if (!sessionLocked) await this.#activeSession(client, sessionId, { lock: true });
    const assets = await client.query(`
      SELECT storage_key FROM media_assets WHERE session_id = $1 FOR UPDATE
    `, [sessionId]);
    const attempts = await client.query(`
      SELECT attempt_storage_key AS storage_key, lease_expires_at, attempt_deadline_at
      FROM voice_uploads
      WHERE session_id = $1 AND attempt_storage_key IS NOT NULL
      UNION ALL
      SELECT g.attempt_storage_key AS storage_key, g.lease_expires_at, g.attempt_deadline_at
      FROM media_generations g
      JOIN messages m ON m.id = g.owner_message_id
      WHERE m.session_id = $1 AND g.attempt_storage_key IS NOT NULL
    `, [sessionId]);
    const queued = new Set();
    for (const row of assets.rows) {
      if (queued.has(row.storage_key)) continue;
      await this.#enqueueDeletion(client, {
        storageKey: row.storage_key, reason: 'session-revoked-asset',
        notBefore: cleanupNotBefore ?? now, now,
      });
      queued.add(row.storage_key);
    }
    for (const raw of attempts.rows) {
      const row = mapRow(raw);
      if (!row.storageKey || queued.has(row.storageKey)) continue;
      const horizon = new Date(asDate(laterIso(
        cleanupNotBefore ?? now,
        row.leaseExpiresAt,
        row.attemptDeadlineAt,
      )).getTime() + ATTEMPT_CLEANUP_GRACE_MS);
      await this.#enqueueDeletion(client, {
        storageKey: row.storageKey, reason: 'session-revoked-attempt',
        notBefore: horizon, now,
      });
      queued.add(row.storageKey);
    }
    const deleted = await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    if (deleted.rowCount !== 1) throw storeError('SESSION_NOT_FOUND', 'A valid session is required.');
    return { deleted: true, queuedKeys: queued.size };
  }

  async revokeSessionAndEnqueueMedia({ sessionId, now, cleanupNotBefore }) {
    return this.#transaction((client) => this.#revokeSessionAndEnqueueMedia(client, {
      sessionId, now, cleanupNotBefore,
    }));
  }

  async deleteSession({ sessionId }) {
    const now = new Date();
    return this.revokeSessionAndEnqueueMedia({ sessionId, now, cleanupNotBefore: now });
  }

  async recordRetentionHeartbeat({ workerId, runToken, heartbeatAt, policy, signal }) {
    const identity = retentionIdentity(workerId, runToken);
    const normalizedPolicy = retentionPolicy(policy);
    const timestamp = asIso(heartbeatAt, 'heartbeatAt');
    const payload = JSON.stringify({
      ...identity,
      status: 'running',
      policyVersion: normalizedPolicy.version,
      policy: normalizedPolicy,
      stoppedAt: null,
    });
    const upserted = await this.#query(`
      INSERT INTO service_state (
        name, payload_json, heartbeat_at, last_success_at, updated_at
      ) VALUES ($1, $2::jsonb, $3, NULL, $3)
      ON CONFLICT (name) DO UPDATE SET
        payload_json = service_state.payload_json || EXCLUDED.payload_json,
        heartbeat_at = EXCLUDED.heartbeat_at,
        updated_at = EXCLUDED.updated_at
      WHERE service_state.heartbeat_at IS NULL
        OR service_state.heartbeat_at <= EXCLUDED.heartbeat_at
      RETURNING *
    `, ['retention', payload, timestamp], signal);
    if (upserted.rowCount !== 1) {
      throw storeError('RETENTION_RUN_FENCED', 'The retention worker no longer owns this run.');
    }
    return mapRow(upserted.rows[0]);
  }

  async purgeExpired({
    anonymousBefore, voiceBefore, now, workerId, runToken, policyVersion, signal,
  }) {
    const identity = retentionIdentity(workerId, runToken);
    const normalizedPolicy = retentionPolicy(undefined, policyVersion);
    const anonymousCutoff = asIso(anonymousBefore, 'anonymousBefore');
    const voiceCutoff = asIso(voiceBefore, 'voiceBefore');
    const current = asIso(now, 'now');
    return this.#transaction(async (client) => {
      const ownership = await client.query(`
        SELECT * FROM service_state
        WHERE name = $1
          AND payload_json ->> 'workerId' = $2
          AND payload_json ->> 'runToken' = $3
          AND payload_json ->> 'policyVersion' = $4
          AND payload_json ->> 'status' = 'running'
        FOR UPDATE
      `, ['retention', identity.workerId, identity.runToken, normalizedPolicy.version]);
      if (ownership.rowCount !== 1) {
        throw storeError('RETENTION_RUN_FENCED', 'The retention worker no longer owns this run.');
      }

      const expiredRateBuckets = await client.query(`
        DELETE FROM rate_limit_buckets
        WHERE expires_at <= $1
      `, [current]);
      const rateBucketsPurged = expiredRateBuckets.rowCount;
      let deletionJobsQueued = 0;
      let anonymousSessionsPurged = 0;
      while (true) {
        const expiredSessions = await client.query(`
          SELECT s.* FROM sessions s
          WHERE s.created_at < $1
            AND NOT EXISTS (
              SELECT 1 FROM messages m
              WHERE m.session_id = s.id AND m.created_at >= $1
            )
            AND NOT EXISTS (
              SELECT 1 FROM events e
              WHERE e.session_id = s.id AND e.created_at >= $1
            )
            AND NOT EXISTS (
              SELECT 1 FROM voice_uploads u
              WHERE u.session_id = s.id AND u.created_at >= $1
            )
          ORDER BY s.created_at ASC, s.id ASC
          LIMIT 100
          FOR UPDATE OF s
        `, [anonymousCutoff]);
        if (expiredSessions.rowCount === 0) break;
        for (const raw of expiredSessions.rows) {
          const session = mapRow(raw);
          const revoked = await this.#revokeSessionAndEnqueueMedia(client, {
            sessionId: session.id,
            now: current,
            cleanupNotBefore: current,
            sessionLocked: true,
          });
          anonymousSessionsPurged += 1;
          deletionJobsQueued += revoked.queuedKeys;
        }
      }

      let voiceAssetsRevoked = 0;
      while (true) {
        const expiredVoice = await client.query(`
          SELECT * FROM media_assets
          WHERE created_at < $1
            OR (expires_at IS NOT NULL AND expires_at <= $2)
          ORDER BY created_at ASC, id ASC
          LIMIT 100
          FOR UPDATE
        `, [voiceCutoff, current]);
        if (expiredVoice.rowCount === 0) break;
        const voiceAssetIds = [];
        for (const raw of expiredVoice.rows) {
          const asset = mapRow(raw);
          await this.#enqueueDeletion(client, {
            storageKey: asset.storageKey,
            reason: 'voice-media-expired',
            notBefore: current,
            now: current,
            rearm: true,
          });
          deletionJobsQueued += 1;
          voiceAssetIds.push(asset.id);
        }
        await client.query(`
          UPDATE voice_uploads SET
            state = 'failed', media_asset_id = NULL, attempt_storage_key = NULL,
            failure_code = 'VOICE_MEDIA_EXPIRED', failure_http_status = 410,
            retryable = false, lease_token = NULL, lease_expires_at = NULL,
            updated_at = $2
          WHERE media_asset_id = ANY($1::uuid[])
        `, [voiceAssetIds, current]);
        await client.query(`
          UPDATE media_generations SET
            state = 'failed', media_asset_id = NULL, attempt_storage_key = NULL,
            failure_code = 'VOICE_MEDIA_EXPIRED', failure_http_status = 410,
            retryable = false, lease_token = NULL, lease_expires_at = NULL,
            updated_at = $2
          WHERE media_asset_id = ANY($1::uuid[])
        `, [voiceAssetIds, current]);
        await client.query('DELETE FROM media_assets WHERE id = ANY($1::uuid[])', [voiceAssetIds]);
        voiceAssetsRevoked += voiceAssetIds.length;
      }
      return {
        rateBucketsPurged,
        anonymousSessionsPurged,
        voiceAssetsRevoked,
        deletionJobsQueued,
      };
    }, { signal });
  }

  async hasPendingMediaDeletions({ workerId, runToken, signal }) {
    const identity = retentionIdentity(workerId, runToken);
    const selected = await this.#query(`
      SELECT EXISTS (
        SELECT 1 FROM media_deletion_jobs
        WHERE state IN ('pending', 'deleting')
      ) AS pending
      FROM service_state
      WHERE name = $1
        AND payload_json ->> 'workerId' = $2
        AND payload_json ->> 'runToken' = $3
        AND payload_json ->> 'status' = 'running'
    `, ['retention', identity.workerId, identity.runToken], signal);
    if (selected.rowCount !== 1) {
      throw storeError('RETENTION_RUN_FENCED', 'The retention worker no longer owns this run.');
    }
    return Boolean(selected.rows[0].pending);
  }

  async recordRetentionSuccess({
    workerId, runToken, heartbeatAt, lastSuccessAt, policy, signal,
  }) {
    const identity = retentionIdentity(workerId, runToken);
    const normalizedPolicy = retentionPolicy(policy);
    const heartbeat = asIso(heartbeatAt, 'heartbeatAt');
    const succeededAt = asIso(lastSuccessAt, 'lastSuccessAt');
    if (asDate(succeededAt).getTime() < asDate(heartbeat).getTime()) {
      throw new Error('Retention success cannot precede its heartbeat');
    }
    const payload = JSON.stringify({
      status: 'running',
      policyVersion: normalizedPolicy.version,
      policy: normalizedPolicy,
      stoppedAt: null,
    });
    const updated = await this.#query(`
      UPDATE service_state SET
        payload_json = payload_json || $4::jsonb,
        heartbeat_at = GREATEST(COALESCE(heartbeat_at, $5), $5),
        last_success_at = $6,
        updated_at = $6
      WHERE name = $1
        AND payload_json ->> 'workerId' = $2
        AND payload_json ->> 'runToken' = $3
        AND payload_json ->> 'status' = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM media_deletion_jobs
          WHERE state IN ('pending', 'deleting')
        )
      RETURNING *
    `, [
      'retention', identity.workerId, identity.runToken,
      payload, heartbeat, succeededAt,
    ], signal);
    if (updated.rowCount !== 1) {
      throw storeError('RETENTION_RUN_FENCED', 'The retention worker no longer owns this run.');
    }
    return mapRow(updated.rows[0]);
  }

  async recordRetentionStopped({ workerId, runToken, stoppedAt, policy }) {
    const identity = retentionIdentity(workerId, runToken);
    const normalizedPolicy = retentionPolicy(policy);
    const timestamp = asIso(stoppedAt, 'stoppedAt');
    const payload = JSON.stringify({
      status: 'stopped',
      policyVersion: normalizedPolicy.version,
      policy: normalizedPolicy,
      stoppedAt: timestamp,
    });
    const updated = await this.pool.query(`
      UPDATE service_state SET
        payload_json = payload_json || $4::jsonb,
        updated_at = GREATEST(updated_at, $5)
      WHERE name = $1
        AND payload_json ->> 'workerId' = $2
        AND payload_json ->> 'runToken' = $3
        AND payload_json ->> 'status' IN ('running', 'stopped')
      RETURNING *
    `, ['retention', identity.workerId, identity.runToken, payload, timestamp]);
    if (updated.rowCount !== 1) {
      throw storeError('RETENTION_RUN_FENCED', 'The retention worker no longer owns this run.');
    }
    return mapRow(updated.rows[0]);
  }

  async getRetentionState({ signal } = {}) {
    const selected = await this.#query(`
      SELECT payload_json, heartbeat_at, last_success_at
      FROM service_state
      WHERE name = $1
    `, ['retention'], signal);
    if (selected.rowCount === 0) return null;
    if (selected.rowCount !== 1) throw new Error('PostgreSQL retention state is corrupt');
    const state = mapRow(selected.rows[0]);
    const payload = state.payloadJson && typeof state.payloadJson === 'object'
      ? state.payloadJson
      : {};
    return {
      heartbeatAt: state.heartbeatAt ?? null,
      lastSuccessAt: state.lastSuccessAt ?? null,
      stoppedAt: payload.stoppedAt ?? null,
      policyVersion: typeof payload.policyVersion === 'string' ? payload.policyVersion : null,
    };
  }

  async listRecoverableTurns() {
    const selected = await this.pool.query(`
      SELECT * FROM turns
      WHERE state NOT IN ('delivered', 'failed')
      ORDER BY created_at ASC, id ASC
    `);
    return mapRows(selected.rows);
  }

  async getEventHighWater({ sessionId, conversationId }) {
    const conversation = await this.#ownedConversation(this.pool, sessionId, conversationId);
    return conversation.eventHighWater;
  }

  async listEventsPage({
    sessionId, conversationId, afterCursor = 0,
    throughCursor = Number.MAX_SAFE_INTEGER, limit = 100,
  }) {
    const after = Number(afterCursor);
    const through = Number(throughCursor);
    const pageLimit = Number(limit);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(through) || through < after
      || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
      throw new Error('Invalid event page');
    }
    await this.#ownedConversation(this.pool, sessionId, conversationId);
    const selected = await this.pool.query(`
      SELECT * FROM events
      WHERE conversation_id = $1 AND cursor > $2 AND cursor <= $3
      ORDER BY cursor ASC
      LIMIT $4
    `, [conversationId, after, through, pageLimit]);
    return mapRows(selected.rows);
  }

  async listEvents({ sessionId, conversationId, afterCursor = 0 }) {
    const highWater = await this.getEventHighWater({ sessionId, conversationId });
    const events = [];
    let cursor = Number(afterCursor);
    while (cursor < highWater) {
      const page = await this.listEventsPage({
        sessionId, conversationId, afterCursor: cursor,
        throughCursor: highWater, limit: 100,
      });
      if (page.length === 0) break;
      events.push(...page);
      cursor = page.at(-1).cursor;
    }
    return events;
  }

  async consumeRateLimit({ subjectHash, quota, windowStart, limit, expiresAt }) {
    return this.#transaction(async (client) => {
      const state = await this.#prepareRateBuckets(client, [{
        subjectHash, quota, windowStart, limit, expiresAt,
      }]);
      const row = state.locked[0].row;
      if (state.blockingExpiresAt) return { allowed: false, count: row.count, expiresAt: row.expiresAt };
      const updated = await client.query(`
        UPDATE rate_limit_buckets
        SET count = count + 1
        WHERE subject_hash = $1 AND quota = $2 AND window_start = $3
        RETURNING *
      `, [subjectHash, quota, asIso(windowStart)]);
      const consumed = mapRow(updated.rows[0]);
      return { allowed: true, count: consumed.count, expiresAt: consumed.expiresAt };
    });
  }
}
