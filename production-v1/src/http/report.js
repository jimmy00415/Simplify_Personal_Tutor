import express from 'express';

import { httpError, sendError } from './errors.js';
import { createSessionResolver } from './session.js';
import { assertAiConsent } from '../services/consent.js';
import { rateLimitBucket } from '../services/rate-limiter.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = new Set(['campus', 'practice', 'visit']);
const REASONS = new Set([
  'incorrect', 'outdated', 'unsafe', 'offensive', 'other',
]);

export function createReportRouter({ config, store, now = () => new Date() } = {}) {
  const router = express.Router();
  const sessionFromRequest = createSessionResolver({ store });
  const limits = config.rateLimits ?? {};

  router.post('/reports', async (request, response) => {
    try {
      const { session } = await sessionFromRequest(request);
      assertAiConsent(session, config);
      const messageId = request.body?.messageId ?? null;
      const conversationKind = request.body?.conversationKind ?? request.body?.kind;
      const reason = request.body?.reason;
      if ((messageId !== null && !UUID.test(messageId))
        || !KINDS.has(conversationKind)
        || !REASONS.has(reason)) {
        throw httpError(400, 'INVALID_REQUEST');
      }
      const limited = await store.consumeRateLimit(rateLimitBucket({
        secret: config.sessionSecret ?? 'local-development-session-secret',
        subject: session.id,
        quota: 'answer-report',
        limit: limits.report5m ?? 20,
        durationMs: 5 * 60 * 1000,
        now: Date.now(),
      }));
      if (!limited.allowed) throw httpError(429, 'RATE_LIMITED');
      const report = await store.createReport({
        sessionId: session.id,
        messageId,
        conversationKind,
        reason,
        now: now(),
      });
      return response.status(201).json({
        data: {
          id: report.id,
          messageId: report.messageId,
          conversationKind: report.conversationKind,
          reason: report.reason,
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
