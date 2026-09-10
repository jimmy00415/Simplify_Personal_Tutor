import { createHash } from 'node:crypto';
import express from 'express';

import { httpError, sendError } from './errors.js';
import { createSessionResolver } from './session.js';
import { assertAiConsent } from '../services/consent.js';
import { createTutorService } from '../services/tutor.js';
import { rateLimitBucket } from '../services/rate-limiter.js';
import { REPLY_LANGUAGES, REPLY_MODES } from '../stores/store-contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRACTICE_MODES = new Set(['teaching', 'freeChat']);
const SCENARIOS = new Set([
  'freeConversation', 'restaurant', 'meetingPeople', 'traveling', 'shopping', 'workplace',
]);

function requestHash({ text, voiceDraftId, replyLanguage, replyMode, mode, scenario }) {
  return createHash('sha256').update(JSON.stringify({
    text,
    voiceDraftId: voiceDraftId ?? null,
    replyLanguage,
    replyMode,
    mode,
    scenario,
  })).digest('hex');
}

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

export function createPracticeRouter({
  config, store, eventHub, dispatcher, tutorService, now = () => new Date(),
} = {}) {
  const router = express.Router();
  const sessionFromRequest = createSessionResolver({ store });
  const tutor = tutorService ?? createTutorService();
  const limits = config.rateLimits ?? {};

  router.get('/practice/messages', async (request, response) => {
    try {
      const { session } = await sessionFromRequest(request);
      const conversation = await store.getConversationForSession({ sessionId: session.id, kind: 'practice' });
      if (!conversation) {
        return response.json({
          data: { conversation: null, messages: [], activeTurn: null },
          error: null,
          requestId: response.locals.requestId,
        });
      }
      const after = Number(request.query.after ?? 0);
      if (!Number.isInteger(after) || after < 0) throw httpError(400, 'INVALID_REQUEST');
      const messages = await store.listMessages({ sessionId: session.id, conversationId: conversation.id, after });
      const activeTurn = await store.getActiveTurn({ sessionId: session.id, conversationId: conversation.id });
      return response.json({
        data: { conversation, messages: messages.map(publicMessage), activeTurn: publicTurn(activeTurn) },
        error: null,
        requestId: response.locals.requestId,
      });
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.post('/practice/messages', async (request, response) => {
    try {
      const { session } = await sessionFromRequest(request);
      assertAiConsent(session, config);
      const clientMessageId = request.body?.clientMessageId;
      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      const voiceDraftId = request.body?.voiceDraftId ?? null;
      const replyLanguage = request.body?.replyLanguage ?? 'en';
      const replyMode = request.body?.replyMode ?? 'text';
      const mode = request.body?.mode ?? 'teaching';
      const scenario = request.body?.scenario ?? 'freeConversation';
      if (!UUID.test(clientMessageId ?? '') || text.length < 1 || text.length > 4000
        || (voiceDraftId !== null && typeof voiceDraftId !== 'string')
        || !REPLY_LANGUAGES.has(replyLanguage) || !REPLY_MODES.has(replyMode)
        || !PRACTICE_MODES.has(mode) || !SCENARIOS.has(scenario)) {
        throw httpError(400, 'INVALID_REQUEST');
      }
      const conversation = await store.getOrCreateConversation({
        sessionId: session.id,
        kind: 'practice',
        mode,
        scenario,
        now: now(),
      });
      const payloadHash = requestHash({ text, voiceDraftId, replyLanguage, replyMode, mode, scenario });
      const accepted = await store.acceptMessageWithRateLimits({
        sessionId: session.id,
        conversationId: conversation.id,
        clientMessageId,
        requestHash: payloadHash,
        text,
        voiceDraftId,
        replyLanguage,
        replyMode,
        rateLimits: [
          rateLimitBucket({
            secret: config.sessionSecret ?? 'local-development-session-secret',
            subject: session.id,
            quota: 'practice-message-5m',
            limit: limits.practiceMessage5m ?? 30,
            durationMs: 5 * 60 * 1000,
            now: Date.now(),
          }),
          rateLimitBucket({
            secret: config.sessionSecret ?? 'local-development-session-secret',
            subject: session.id,
            quota: 'practice-message',
            limit: limits.practiceMessageDaily ?? 300,
            durationMs: 24 * 60 * 60 * 1000,
            now: Date.now(),
          }),
        ],
      });
      response.status(202).json({
        data: { idempotent: accepted.idempotent, message: publicMessage(accepted.message), turn: publicTurn(accepted.turn) },
        error: null,
        requestId: response.locals.requestId,
      });
      queueMicrotask(() => {
        eventHub?.publish({
          sessionId: accepted.event.sessionId,
          conversationId: accepted.event.conversationId,
          cursor: accepted.event.cursor,
        });
        dispatcher?.wake?.();
      });
      return undefined;
    } catch (error) {
      if (error.code === 'RATE_LIMITED' && error.expiresAt) {
        response.set('Retry-After', String(Math.max(1, Math.ceil((new Date(error.expiresAt).getTime() - Date.now()) / 1000))));
      }
      return sendError(response, error);
    }
  });

  router.post('/practice/correct', async (request, response) => {
    try {
      const { session } = await sessionFromRequest(request);
      assertAiConsent(session, config);
      const conversation = await store.getConversationForSession({ sessionId: session.id, kind: 'practice' });
      if (!conversation) throw httpError(400, 'INVALID_REQUEST');
      const limited = await store.consumeRateLimit(rateLimitBucket({
        secret: config.sessionSecret ?? 'local-development-session-secret',
        subject: session.id,
        quota: 'practice-correct',
        limit: limits.practiceCorrect5m ?? 20,
        durationMs: 5 * 60 * 1000,
        now: Date.now(),
      }));
      if (!limited.allowed) throw httpError(429, 'RATE_LIMITED');
      const messages = await store.listMessages({
        sessionId: session.id,
        conversationId: conversation.id,
        after: 0,
      });
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const text = typeof request.body?.text === 'string' && request.body.text.trim()
        ? request.body.text.trim()
        : lastUser?.text;
      if (!text) throw httpError(400, 'INVALID_REQUEST');
      const correction = await tutor.correct({
        text,
        mode: conversation.mode ?? 'teaching',
        scenario: conversation.scenario ?? 'freeConversation',
      });
      return response.json({
        data: {
          text: correction.text,
          coachNotes: correction.coachNotes,
          groundingStatus: 'unverified',
        },
        error: null,
        requestId: response.locals.requestId,
      });
    } catch (error) {
      return sendError(response, error);
    }
  });

  return router;
}
