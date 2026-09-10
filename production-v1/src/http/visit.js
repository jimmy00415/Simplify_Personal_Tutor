import express from 'express';

import { httpError, sendError } from './errors.js';
import { createSessionResolver } from './session.js';
import { assertAiConsent } from '../services/consent.js';
import { createVisitTranslationService } from '../services/visit-translation.js';
import { rateLimitBucket } from '../services/rate-limiter.js';
import { VISIT_DIRECTIONS } from '../knowledge/visit-direction.js';

const CLIENT_TURN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createVisitRouter({
  config, store, visitService, now = () => new Date(),
} = {}) {
  const router = express.Router();
  const sessionFromRequest = createSessionResolver({ store });
  const translator = visitService ?? createVisitTranslationService();
  const limits = config.rateLimits ?? {};

  router.post('/visit-translate', async (request, response) => {
    try {
      const { session } = await sessionFromRequest(request);
      assertAiConsent(session, config);
      const sourceText = typeof request.body?.sourceText === 'string' ? request.body.sourceText.trim() : '';
      const direction = request.body?.direction;
      const clientTurnId = request.body?.clientTurnId;
      const voiceDraftId = request.body?.voiceDraftId ?? null;
      const inputType = request.body?.inputType === 'voice' ? 'voice' : 'text';
      const userJob = request.body?.userJob ?? null;
      if (!sourceText || sourceText.length > 4000 || !VISIT_DIRECTIONS.includes(direction)
        || !CLIENT_TURN.test(clientTurnId ?? '')
        || (voiceDraftId !== null && typeof voiceDraftId !== 'string')) {
        throw httpError(400, 'INVALID_REQUEST');
      }
      const existing = await store.getVisitTurn?.({ sessionId: session.id, clientTurnId });
      if (existing) {
        if (existing.sourceText !== sourceText || existing.direction !== direction) {
          throw httpError(409, 'IDEMPOTENCY_CONFLICT');
        }
        return response.json({
          data: publicVisit(existing),
          error: null,
          requestId: response.locals.requestId,
        });
      }
      const limited = await store.consumeRateLimit(rateLimitBucket({
        secret: config.sessionSecret ?? 'local-development-session-secret',
        subject: session.id,
        quota: 'visit-translate',
        limit: limits.visitTranslate5m ?? 30,
        durationMs: 5 * 60 * 1000,
        now: Date.now(),
      }));
      if (!limited.allowed) throw httpError(429, 'RATE_LIMITED');
      const translated = await translator.translate({ sourceText, direction, userJob });
      const stored = await store.createVisitTurn({
        sessionId: session.id,
        clientTurnId,
        sourceText,
        direction,
        userJob,
        inputType,
        voiceDraftId,
        result: translated,
        now: now(),
      });
      return response.json({
        data: publicVisit(stored),
        error: null,
        requestId: response.locals.requestId,
      });
    } catch (error) {
      return sendError(response, error);
    }
  });

  return router;
}

function publicVisit(row) {
  return {
    id: row.id,
    clientTurnId: row.clientTurnId,
    translatedText: row.translatedText,
    displayText: row.displayText,
    romanization: row.romanization ?? null,
    autoRouted: Boolean(row.autoRouted),
    routeReason: row.routeReason ?? null,
    needsConfirmation: Boolean(row.needsConfirmation),
    provider: row.provider,
    suppressTts: Boolean(row.suppressTts),
    requestedDirection: row.direction,
    effectiveDirection: row.effectiveDirection,
  };
}
