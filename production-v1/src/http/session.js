import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import express from 'express';

import { httpError, sendError } from './errors.js';
import { createRateLimiter, rateLimitBucket } from '../services/rate-limiter.js';
import { createEventStreamHandler } from '../services/events.js';
import { REPLY_LANGUAGES, REPLY_MODES } from '../stores/store-contract.js';
import { acceptanceTimingContext } from '../telemetry/acceptance-timings.js';

const COOKIE_NAME = 'hb_v1_session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function parseCookies(header = '') { return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s)).filter(([key]) => key)); }
function requestHash({ text, voiceDraftId, replyLanguage, replyMode }) {
  return createHash('sha256').update(JSON.stringify({
    text,
    voiceDraftId: voiceDraftId ?? null,
    replyLanguage,
    replyMode,
  })).digest('hex');
}
function rateLimited(response, result) { response.set('Retry-After', String(result.retryAfter)); throw httpError(429, 'RATE_LIMITED'); }

function ipv6Groups(value) {
  const source = value.toLowerCase().split('%', 1)[0];
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const parts = half.split(':');
    const last = parts.at(-1);
    if (last?.includes('.')) {
      if (isIP(last) !== 4) return null;
      const octets = last.split('.').map(Number);
      parts.splice(parts.length - 1, 1, ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
    }
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

export function coarseIpSubject(value) {
  const version = isIP(String(value ?? ''));
  if (version === 4) {
    const octets = value.split('.').map(Number);
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (version === 6) {
    const groups = ipv6Groups(value);
    if (!groups) return 'unknown';
    const prefix = [groups[0], groups[1], groups[2], groups[3] & 0xff00].map((group) => group.toString(16));
    return `${prefix.join(':')}::/56`;
  }
  return 'unknown';
}

function cookieOptions(config) { return { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 }; }

function publicTurn(turn) {
  if (!turn) return null;
  return {
    id: turn.id,
    state: turn.state,
    failureCode: turn.failureCode ?? null,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    replyLanguage: turn.replyLanguage,
    replyMode: turn.replyMode,
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    turnId: message.turnId,
    clientMessageId: message.clientMessageId ?? null,
    sequence: message.sequence,
    role: message.role,
    kind: message.kind ?? 'text',
    status: message.status ?? (message.role === 'assistant' ? 'delivered' : 'accepted'),
    failureCode: message.failureCode ?? null,
    text: message.text,
    replyLanguage: message.replyLanguage,
    replyMode: message.replyMode,
    voiceDraftId: message.voiceDraftId ?? null,
    mediaId: message.mediaId ?? null,
    citations: message.citations ?? [],
    cards: message.cards ?? [],
    suggestedReplies: message.suggestedReplies ?? [],
    needsClarification: Boolean(message.needsClarification),
    groundingStatus: message.groundingStatus ?? null,
    createdAt: message.createdAt,
  };
}

export function createSessionResolver({ store }) {
  return async function sessionFromRequest(request) {
    const token = parseCookies(request.get('cookie'))[COOKIE_NAME];
    if (!token) throw httpError(401, 'SESSION_NOT_FOUND');
    const session = await store.getSessionByTokenHash(tokenHash(token));
    if (!session) throw httpError(401, 'SESSION_NOT_FOUND');
    const conversation = await store.getConversationForSession({ sessionId: session.id });
    if (!conversation) throw httpError(401, 'SESSION_NOT_FOUND');
    return { session, conversation };
  };
}

export function createSessionRouter({
  config, store, eventHub, dispatcher, cleanupService, acceptanceTimingRecorder,
  now = () => new Date(),
}) {
  const router = express.Router();
  const limiter = createRateLimiter({ store, secret: config.sessionSecret ?? 'local-development-session-secret' });
  const limits = config.rateLimits ?? { bootstrapClient10m: 4, bootstrapCoarseIp10m: 100, message5m: 30, messageDaily: 300 };

  const sessionFromRequest = createSessionResolver({ store });
  const currentCapabilities = () => config.getPublicStatus?.(now()) ?? config.publicStatus ?? {};

  router.post('/session', async (request, response) => {
    try {
      const cookies = parseCookies(request.get('cookie'));
      const existing = cookies[COOKIE_NAME];
      if (existing) {
        const resumed = await store.getSessionByTokenHash(tokenHash(existing));
        if (resumed) {
          const conversation = await store.getConversationForSession({ sessionId: resumed.id });
          if (!conversation) throw httpError(401, 'SESSION_NOT_FOUND');
          const messages = await store.listMessages({ sessionId: resumed.id, conversationId: conversation.id, after: 0 });
          return response.json({ data: { session: { id: resumed.id }, clientSessionScope: resumed.clientScopeId, conversation, messages: messages.map(publicMessage), capabilities: currentCapabilities(), knowledgeSnapshotDate: config.knowledgeSnapshotDate ?? null }, error: null, requestId: response.locals.requestId });
        }
      }
      const clientInstance = UUID.test(request.get('x-client-instance-id') ?? '')
        ? request.get('x-client-instance-id').toLowerCase()
        : 'missing';
      const coarseIp = await limiter.consume({
        subject: coarseIpSubject(request.ip), quota: 'session-bootstrap-coarse-ip',
        limit: limits.bootstrapCoarseIp10m, durationMs: 10 * 60 * 1000,
      });
      if (!coarseIp.allowed) return rateLimited(response, coarseIp);
      const client = await limiter.consume({
        subject: clientInstance, quota: 'session-bootstrap-client-instance',
        limit: limits.bootstrapClient10m, durationMs: 10 * 60 * 1000,
      });
      if (!client.allowed) return rateLimited(response, client);
      const token = randomBytes(32).toString('base64url');
      const sessionData = await store.createOrResumeSession({ tokenHash: tokenHash(token) });
      response.cookie(COOKIE_NAME, token, cookieOptions(config));
      return response.status(201).json({ data: { session: { id: sessionData.session.id }, clientSessionScope: sessionData.session.clientScopeId, conversation: sessionData.conversation, messages: [], capabilities: currentCapabilities(), knowledgeSnapshotDate: config.knowledgeSnapshotDate ?? null }, error: null, requestId: response.locals.requestId });
    } catch (error) { return sendError(response, error); }
  });

  router.get('/acceptance/timings', async (request, response) => {
    try {
      if (!acceptanceTimingRecorder?.query || !/^[0-9a-f]{64}$/.test(String(request.query.windowId ?? ''))) {
        throw httpError(400, 'INVALID_REQUEST');
      }
      const { session } = await sessionFromRequest(request);
      const data = acceptanceTimingRecorder.query({
        windowId: request.query.windowId,
        sessionId: session.id,
      });
      return response.json({ data, error: null, requestId: response.locals.requestId });
    } catch (error) { return sendError(response, error); }
  });

  router.get('/messages', async (request, response) => {
    try {
      const sessionData = await sessionFromRequest(request);
      const after = Number(request.query.after ?? 0);
      if (!Number.isInteger(after) || after < 0) throw httpError(400, 'INVALID_REQUEST');
      const messages = await store.listMessages({ sessionId: sessionData.session.id, conversationId: sessionData.conversation.id, after });
      const activeTurn = await store.getActiveTurn({ sessionId: sessionData.session.id, conversationId: sessionData.conversation.id });
      return response.json({ data: { conversation: sessionData.conversation, messages: messages.map(publicMessage), activeTurn: publicTurn(activeTurn) }, error: null, requestId: response.locals.requestId });
    } catch (error) { return sendError(response, error); }
  });

  router.post('/messages', async (request, response) => {
    try {
      const sessionData = await sessionFromRequest(request);
      const clientMessageId = request.body?.clientMessageId;
      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      const voiceDraftId = request.body?.voiceDraftId ?? null;
      const replyLanguage = request.body?.replyLanguage;
      const replyMode = request.body?.replyMode;
      const timing = acceptanceTimingContext({
        windowId: request.get('x-acceptance-window-id'),
        correlationId: request.get('x-acceptance-correlation-id'),
      });
      const controlledTtsFailureHeader = request.get('x-acceptance-controlled-tts-failure');
      if (!UUID.test(clientMessageId ?? '') || text.length < 1 || text.length > 4000
        || (voiceDraftId !== null && typeof voiceDraftId !== 'string')
        || !REPLY_LANGUAGES.has(replyLanguage) || !REPLY_MODES.has(replyMode)) throw httpError(400, 'INVALID_REQUEST');
      if (controlledTtsFailureHeader !== undefined && (
        controlledTtsFailureHeader !== 'provider-rejection-v1'
        || replyMode !== 'voice'
        || !timing
        || request.get('origin') !== config.candidateOrigin
      )) throw httpError(400, 'INVALID_REQUEST');
      const payloadHash = requestHash({ text, voiceDraftId, replyLanguage, replyMode });
      const subject = sessionData.session.id;
      const now = Date.now();
      const accepted = await store.acceptMessageWithRateLimits({
        sessionId: sessionData.session.id, conversationId: sessionData.conversation.id, clientMessageId, requestHash: payloadHash, text, voiceDraftId,
        replyLanguage, replyMode,
        rateLimits: [
          rateLimitBucket({ secret: config.sessionSecret ?? 'local-development-session-secret', subject, quota: 'messages-5m', limit: limits.message5m, durationMs: 5 * 60 * 1000, now }),
          rateLimitBucket({ secret: config.sessionSecret ?? 'local-development-session-secret', subject, quota: 'messages-day', limit: limits.messageDaily, durationMs: 24 * 60 * 60 * 1000, now }),
        ],
      });
      if (!accepted.idempotent) {
        if (timing) acceptanceTimingRecorder?.bindTurn?.({
          ...timing,
          turnId: accepted.turn.id,
          sessionId: sessionData.session.id,
          ...(controlledTtsFailureHeader === 'provider-rejection-v1' ? { controlledTtsFailure: true } : {}),
        });
        await dispatcher?.kick?.().catch(() => false);
      }
      response.status(202).json({ data: { idempotent: accepted.idempotent, message: publicMessage(accepted.message), turn: publicTurn(accepted.turn) }, error: null, requestId: response.locals.requestId });
      queueMicrotask(() => {
        eventHub?.publish({ sessionId: accepted.event.sessionId, conversationId: accepted.event.conversationId, cursor: accepted.event.cursor });
        dispatcher?.wake?.();
      });
      return undefined;
    } catch (error) {
      if (error.code === 'RATE_LIMITED' && error.expiresAt) response.set('Retry-After', String(Math.max(1, Math.ceil((new Date(error.expiresAt).getTime() - Date.now()) / 1000))));
      return sendError(response, error);
    }
  });

  router.delete('/session', async (request, response) => {
    try {
      const sessionData = await sessionFromRequest(request);
      await store.revokeSessionAndEnqueueMedia({
        sessionId: sessionData.session.id,
        now: now(),
        cleanupNotBefore: now(),
      });
      eventHub?.closeConversation(sessionData.conversation.id);
      await cleanupService?.drainOnce?.().catch(() => undefined);
      response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', path: '/' });
      return response.json({ data: { deleted: true }, error: null, requestId: response.locals.requestId });
    } catch (error) { return sendError(response, error); }
  });

  if (eventHub) {
    router.get('/events', createEventStreamHandler({
      store,
      eventHub,
      resolveSession: sessionFromRequest,
      pageSize: config.sse?.pageSize,
      bufferSize: config.sse?.bufferSize,
      heartbeatMs: config.sse?.heartbeatMs,
    }));
  }

  return router;
}
