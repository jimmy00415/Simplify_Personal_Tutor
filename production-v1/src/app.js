import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';

import { requireSameOrigin } from './http/security.js';
import { sendError } from './http/errors.js';
import { createConsentRouter } from './http/consent.js';
import { createLegalRouter } from './http/legal.js';
import { createPracticeRouter } from './http/practice.js';
import { createReportRouter } from './http/report.js';
import { createSessionRouter } from './http/session.js';
import { createVisitRouter } from './http/visit.js';
import { createVoiceConsentGate, createVoiceRouter } from './http/voice.js';
import { EventHub } from './services/events.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

function envelope(response, data, error = null) {
  return { data, error, requestId: response.locals.requestId };
}

const READINESS_STATUS = new Set(['not-ready', 'preview', 'ready']);
const READINESS_BOUNDARY = new Set(['local-preview-only', 'production-v1']);
const SAFE_READINESS_TOKEN = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function safeReadinessReport(report) {
  const status = READINESS_STATUS.has(report?.status) ? report.status : 'not-ready';
  const boundary = READINESS_BOUNDARY.has(report?.boundary) ? report.boundary : 'production-v1';
  const checks = Array.isArray(report?.checks) ? report.checks.map((check) => {
    const safe = {
      name: SAFE_READINESS_TOKEN.test(check?.name ?? '') ? check.name : 'unknown',
      status: READINESS_STATUS.has(check?.status) ? check.status : 'not-ready',
    };
    if (SAFE_READINESS_TOKEN.test(check?.version ?? '') && !/^[0-9a-f]{64}$/.test(check.version)) {
      safe.version = check.version;
    }
    return safe;
  }) : [];
  return {
    status,
    productionReady: status === 'ready' && report?.productionReady === true,
    boundary,
    checks,
  };
}

export function createApp({
  config, store, mediaStore, answerService, eventHub, dispatcher,
  asrProvider, ttsProvider, cleanupService, voiceService, spoolParentDirectory,
  readiness, runtimeState, acceptanceTimingRecorder,
  tutorService, visitService,
  now = () => new Date(),
} = {}) {
  void answerService;

  if (!config) throw new Error('createApp requires config');

  const app = express();
  app.set('trust proxy', config.trustedProxyHops);
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.set('X-Request-Id', requestId);
    next();
  });
  app.use(helmet());
  app.use('/api/v1', (request, response, next) => {
    const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const productionRuntimeGate = config.nodeEnv === 'production'
      && (runtimeState || config.productionConfigurationReady === true);
    if (productionRuntimeGate
      && runtimeState?.accepting !== true
      && stateChanging) {
      response.status(503).json(envelope(response, null, {
        code: 'PRODUCTION_NOT_READY',
        message: 'Production is temporarily unavailable.',
      }));
      return;
    }
    next();
  });
  app.use(requireSameOrigin(config.allowedOrigins ?? config.publicOrigin));
  const selectedEventHub = store ? (eventHub ?? new EventHub()) : null;
  if (store) {
    app.use('/api/v1', createVoiceConsentGate({ config, store }));
  }
  if (store && mediaStore) {
    app.use('/api/v1', createVoiceRouter({
      config, store, mediaStore, asrProvider, ttsProvider, cleanupService,
      eventHub: selectedEventHub, now, voiceService, spoolParentDirectory,
      acceptanceTimingRecorder,
    }));
  }
  app.use(express.json({ limit: '64kb', type: ['application/json', 'application/*+json'] }));

  app.get('/api/health/live', (request, response) => {
    response.json(envelope(response, { status: 'ok', version: config.version ?? '0.1.0' }));
  });
  app.get('/api/health/ready', async (request, response) => {
    void request;
    let report;
    try {
      const evaluated = typeof readiness === 'function' ? await readiness() : null;
      report = safeReadinessReport(evaluated?.publicReport);
    } catch {
      report = safeReadinessReport({ status: 'not-ready', productionReady: false, boundary: 'production-v1' });
    }
    response.status(report.productionReady ? 200 : 503).json(envelope(response, report));
  });
  if (store) {
    app.locals.eventHub = selectedEventHub;
    app.use('/api/v1', createSessionRouter({
      config, store, eventHub: selectedEventHub, dispatcher, cleanupService,
      acceptanceTimingRecorder, now,
    }));
    app.use('/api/v1', createConsentRouter({ config, store, now }));
    app.use('/api/v1', createPracticeRouter({
      config, store, eventHub: selectedEventHub, dispatcher, tutorService, now,
    }));
    app.use('/api/v1', createVisitRouter({
      config, store, visitService, now,
    }));
    app.use('/api/v1', createReportRouter({ config, store, now }));
  }
  app.use('/legal', createLegalRouter());
  app.use('/api', (request, response) => {
    response.status(404).json(envelope(response, null, { code: 'NOT_FOUND', message: 'The requested API route does not exist.' }));
  });
  app.use(express.static(publicDirectory, { index: 'index.html', fallthrough: false }));
  app.use((error, request, response, next) => {
    void request;
    void next;
    if (response.headersSent) return;
    sendError(response, error);
  });

  return app;
}
