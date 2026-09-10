import express from 'express';

import { sendError } from './errors.js';
import { createSessionResolver } from './session.js';
import { normalizeConsentRequest, publicConsent } from '../services/consent.js';

export function createConsentRouter({ config, store, now = () => new Date() } = {}) {
  const router = express.Router();
  const sessionFromRequest = createSessionResolver({ store });

  function envelope(response, session) {
    return {
      data: { consent: publicConsent(session, config.privacyNoticeVersion) },
      error: null,
      requestId: response.locals.requestId,
    };
  }

  router.post('/consent', async (request, response) => {
    try {
      const { session } = await sessionFromRequest(request);
      const { kinds, version } = normalizeConsentRequest(request.body, config.privacyNoticeVersion);
      const updated = await store.recordConsent({
        sessionId: session.id,
        kinds,
        version,
        now: now(),
      });
      return response.json(envelope(response, updated));
    } catch (error) {
      return sendError(response, error);
    }
  });

  router.delete('/consent/voice', async (request, response) => {
    try {
      const { session } = await sessionFromRequest(request);
      const updated = await store.withdrawVoiceConsent({ sessionId: session.id, now: now() });
      return response.json(envelope(response, updated));
    } catch (error) {
      return sendError(response, error);
    }
  });

  return router;
}
