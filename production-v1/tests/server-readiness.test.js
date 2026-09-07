import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installProcessShutdown, startServer } from '../src/server.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';
import { PostgresStore } from '../src/stores/postgres-store.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function settleWithin(promise, timeoutMs, message) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function productionConfig() {
  const config = {
    nodeEnv: 'production',
    version: '0.1.0',
    publicOrigin: 'https://v1.example.test',
    sessionSecret: 's'.repeat(32),
    trustedProxyHops: 1,
    storeDriver: 'postgres',
    mediaDriver: 'gcs',
    gcsProjectId: 'motion-expert-hk-ltd-webpage',
    gcsBucket: 'hkbuddy-v1-582852715831-media',
    gcsResourceId: '//storage.googleapis.com/projects/_/buckets/hkbuddy-v1-582852715831-media',
    llm: { available: true, provider: 'hkbu', timeoutMs: 1_000 },
    asr: { available: false, provider: 'none', settings: {} },
    tts: { available: false, provider: 'none', settings: {} },
    instancePolicy: 'single',
    privacyNoticeApproved: true,
    retentionWorkerEnabled: true,
    dependencyInitTimeoutMs: 1_000,
    readinessCheckTimeoutMs: 1_000,
    startupStepTimeoutMs: 1_000,
    productionConfigurationReady: true,
    productionReady: false,
    releaseEvidence: { inventoryFile: 'private', dependencyFile: 'private' },
    rateLimits: {
      bootstrap: 20, message5m: 30, messageDaily: 300,
      asr10m: 10, asrDaily: 60, tts10m: 5, ttsDaily: 20,
    },
    sse: { pageSize: 100, bufferSize: 256, heartbeatMs: 20_000 },
  };
  config.getPublicStatus = () => ({
    productionReady: config.productionReady,
    llmAvailable: true,
    asrConfigured: false,
    ttsConfigured: false,
    voiceInputPreview: false,
    voiceOutputPreview: false,
    voiceInput: false,
    voiceOutput: false,
    asrEvidenceVersion: null,
    ttsEvidenceVersion: null,
    iosVoiceAcceptanceVersion: null,
    privacyNoticeVersion: 'notice-v1',
    releaseCommitSha: 'a'.repeat(40),
    normalizerContractVersion: 'canonical-wav-v1',
  });
  config.publicStatus = config.getPublicStatus();
  return config;
}

function runtimeFixture(order = []) {
  let lockOwned = true;
  const instanceLock = {
    get owned() { return lockOwned; },
    isOwned: () => lockOwned,
    healthCheck: async () => ({ owned: lockOwned }),
    release: async () => {
      lockOwned = false;
      order.push('lock:release');
    },
  };
  const store = {
    init: async () => order.push('store:init'),
    close: async () => order.push('store:close'),
    healthCheck: async () => ({ ok: true, driver: 'postgres' }),
    acquireInstanceLock: async () => {
      order.push('lock:acquire');
      return instanceLock;
    },
    dispatcherHealthCheck: async () => {
      order.push('dispatcher:probe');
      return { ok: true, driver: 'postgres', capability: 'turn-claim' };
    },
    claimNextTurn: async () => {
      order.push('dispatcher:claim');
      return null;
    },
    renewTurnLease: async () => true,
  };
  const mediaStore = {
    init: async () => order.push('media:init'),
    close: async () => order.push('media:close'),
    healthCheck: async () => ({ ok: true, driver: 'gcs', private: true }),
  };
  const cleanupService = {
    start: () => order.push('cleanup:start'),
    stop: async () => order.push('cleanup:stop'),
    drainOnce: async () => ({ idle: true }),
  };
  return { store, mediaStore, cleanupService };
}

function safeReadiness(ready) {
  return {
    exitCode: ready ? 0 : 1,
    publicReport: {
      status: ready ? 'ready' : 'not-ready',
      productionReady: ready,
      boundary: 'production-v1',
      checks: [{ name: 'runtime', status: ready ? 'ready' : 'not-ready', version: 'single-instance-v1' }],
    },
  };
}

test('production startup waits for first retention success and all live checks before listening', async (t) => {
  const order = [];
  const firstRun = deferred();
  const config = productionConfig();
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: firstRun.promise,
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => order.push('retention:stop'),
  };
  let evaluated = false;
  let providerGenerateCalls = 0;
  const starting = startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: {
      provider: 'fake-real',
      generate: async () => {
        providerGenerateCalls += 1;
        return { text: 'unused' };
      },
    },
    evaluateReadiness: async ({ checks, allowPausedRuntime }) => {
      order.push('readiness:evaluate');
      for (const name of ['database', 'media', 'corpus', 'retention', 'dispatcher', 'runtime']) {
        assert.equal((await checks[name]({ allowPausedRuntime })).status, 'ready', name);
      }
      evaluated = true;
      return safeReadiness(true);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluated, false, 'readiness cannot pass before first retention completion');
  assert.equal(order.includes('dispatcher:claim'), false, 'startup must not consume turns before readiness');
  firstRun.resolve({ ok: true });
  const server = await starting;
  t.after(() => server.shutdown());

  assert.equal(evaluated, true);
  assert.equal(providerGenerateCalls, 0, 'startup and readiness never use a live provider health call');
  assert.equal(server.listening, true);
  assert.equal(config.productionReady, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(order.indexOf('dispatcher:probe') < order.indexOf('readiness:evaluate'));
  assert.ok(order.indexOf('readiness:evaluate') < order.indexOf('cleanup:start'),
    'periodic cleanup starts only after the initial retention/readiness gate');
  const claimIndex = order.indexOf('dispatcher:claim');
  assert.equal(claimIndex === -1 || order.indexOf('readiness:evaluate') < claimIndex, true);
  await server.shutdown();
  assert.equal(config.productionReady, false);
  assert.ok(order.indexOf('retention:stop') < order.indexOf('media:close'));
  assert.ok(order.indexOf('lock:release') < order.indexOf('media:close'));
  assert.ok(order.indexOf('media:close') < order.indexOf('store:close'));
});

test('production startup performs one real dispatcher poll even when scheduled timers are inert', async (t) => {
  const order = [];
  const config = productionConfig();
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker: {
      firstRun: Promise.resolve({ ok: true }),
      readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
      stop: async () => order.push('retention:stop'),
    },
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: {
      setTimeoutFn: (callback, delay) => ({ callback, delay, unref() {} }),
      clearTimeoutFn: () => undefined,
    },
  });
  t.after(() => server.shutdown());

  assert.equal(server.listening, true);
  assert.equal(order.filter((entry) => entry === 'dispatcher:claim').length, 1);
  await server.shutdown();
});

test('a failed production readiness gate never opens HTTP and closes every initialized runtime dependency', async () => {
  const order = [];
  const config = productionConfig();
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'stale', healthy: false }),
    stop: async () => order.push('retention:stop'),
  };

  await assert.rejects(startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(false),
  }), (error) => error?.code === 'PRODUCTION_NOT_READY');

  assert.equal(config.productionReady, false);
  assert.equal(order.includes('cleanup:start'), false,
    'failed startup never starts the periodic cleanup worker');
  assert.deepEqual(order.slice(-5), [
    'retention:stop', 'cleanup:stop', 'lock:release', 'media:close', 'store:close',
  ]);
});

test('startup rollback still closes cleanup and storage when retention stop itself fails', async () => {
  const order = [];
  const config = productionConfig();
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => {
      order.push('retention:stop');
      throw Object.assign(new Error('private retention stop detail'), { code: 'RETENTION_STOP_FAILED' });
    },
  };

  await assert.rejects(startServer({
    config,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(false),
  }), (error) => error?.code === 'PRODUCTION_NOT_READY');

  assert.deepEqual(order.slice(-5), [
    'retention:stop', 'cleanup:stop', 'lock:release', 'media:close', 'store:close',
  ]);
});

test('a never-settling singleton-lock startup step times out before workers and closes storage', async () => {
  const order = [];
  const config = productionConfig();
  config.startupStepTimeoutMs = 100;
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const lock = deferred();
  store.acquireInstanceLock = async () => {
    order.push('lock:pending');
    return lock.promise;
  };

  const starting = startServer({
    config,
    store,
    mediaStore,
    cleanupService,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
  });

  await assert.rejects(settleWithin(
    starting,
    1_000,
    'singleton lock startup step was not bounded',
  ).finally(() => lock.reject(new Error('private late lock failure'))), (error) => error?.code === 'PRODUCTION_NOT_READY');

  assert.equal(config.productionReady, false);
  assert.equal(order.includes('cleanup:start'), false);
  assert.equal(order.includes('dispatcher:claim'), false);
  assert.deepEqual(order.slice(-3), ['lock:pending', 'media:close', 'store:close']);
});

test('a never-settling retention first run times out and rolls back every acquired startup resource', async () => {
  const order = [];
  const config = productionConfig();
  config.startupStepTimeoutMs = 100;
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const firstRun = deferred();
  const retentionWorker = {
    firstRun: firstRun.promise,
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => order.push('retention:stop'),
  };

  const starting = startServer({
    config,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
  });

  await assert.rejects(settleWithin(
    starting,
    1_000,
    'retention first run was not bounded',
  ).finally(() => firstRun.reject(new Error('private late retention failure'))), (error) => error?.code === 'PRODUCTION_NOT_READY');

  assert.equal(config.productionReady, false);
  assert.equal(order.includes('cleanup:start'), false);
  assert.equal(order.includes('dispatcher:claim'), false);
  assert.deepEqual(order.slice(-5), [
    'retention:stop', 'cleanup:stop', 'lock:release', 'media:close', 'store:close',
  ]);
});

test('a never-settling startup readiness evaluation times out with the dispatcher still paused and rolls back', async () => {
  const order = [];
  const config = productionConfig();
  // This reaches the final startup gate after filesystem and worker setup. Give
  // those prerequisites enough headroom when the full test suite is CPU-bound;
  // the injected readiness promise below is still the only step that can hang.
  config.startupStepTimeoutMs = 500;
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const readinessEvaluation = deferred();
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => order.push('retention:stop'),
  };

  const starting = startServer({
    config,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => {
      order.push('readiness:pending');
      return readinessEvaluation.promise;
    },
  });

  await assert.rejects(settleWithin(
    starting,
    2_000,
    'startup readiness evaluation was not bounded',
  ).finally(() => readinessEvaluation.reject(new Error('private late readiness failure'))), (error) => error?.code === 'PRODUCTION_NOT_READY');

  assert.equal(config.productionReady, false);
  assert.equal(order.includes('readiness:pending'), true);
  assert.equal(order.includes('dispatcher:claim'), false);
  assert.deepEqual(order.slice(-5), [
    'retention:stop', 'cleanup:stop', 'lock:release', 'media:close', 'store:close',
  ]);
});

test('startup rollback is deadline-bounded and still attempts later cleanup after retention stop stalls', async () => {
  const order = [];
  const config = productionConfig();
  config.startupStepTimeoutMs = 100;
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: () => {
      order.push('retention:stop:pending');
      return new Promise(() => undefined);
    },
  };

  await assert.rejects(settleWithin(startServer({
    config,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(false),
  }), 1_000, 'startup rollback waited indefinitely for retention stop'), (error) => error?.code === 'PRODUCTION_NOT_READY');

  for (const requiredAttempt of ['cleanup:stop', 'lock:release', 'media:close', 'store:close']) {
    assert.equal(order.includes(requiredAttempt), true, requiredAttempt);
  }
});

test('an HTTP bind that never emits listening or error times out and late listening is immediately closed', async () => {
  const order = [];
  const config = productionConfig();
  // Binding is the last startup step, so avoid turning normal full-suite
  // scheduling pressure into an earlier-step timeout.
  config.startupStepTimeoutMs = 500;
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => order.push('retention:stop'),
  };
  const fakeServer = new EventEmitter();
  fakeServer.listening = false;
  let closeCalls = 0;
  fakeServer.close = (callback) => {
    closeCalls += 1;
    fakeServer.listening = false;
    callback?.();
  };
  fakeServer.closeIdleConnections = () => undefined;

  let unexpectedlyResolved = null;
  const starting = startServer({
    config,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    createApp: () => ({ listen: () => fakeServer }),
  }).then((server) => {
    unexpectedlyResolved = server;
    return server;
  });

  try {
    await assert.rejects(settleWithin(
      starting,
      2_000,
      'HTTP bind was not deadline-bounded',
    ), (error) => error?.code === 'PRODUCTION_NOT_READY');
  } finally {
    await unexpectedlyResolved?.shutdown?.();
  }
  const closesAtTimeout = closeCalls;
  assert.equal(closesAtTimeout >= 1, true, 'timeout closes the pending server');
  fakeServer.listening = true;
  fakeServer.emit('listening');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls > closesAtTimeout, true, 'late listening is closed instead of orphaned');
  assert.equal(fakeServer.listening, false);
  assert.equal(config.productionReady, false);
});

test('a second production runtime that cannot own the singleton lock starts no workers', async () => {
  const order = [];
  const config = productionConfig();
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  store.acquireInstanceLock = async () => {
    order.push('lock:denied');
    return { owned: false, release: async () => assert.fail('unowned lock must not release') };
  };

  await assert.rejects(startServer({
    config,
    store,
    mediaStore,
    cleanupService,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
  }), (error) => error?.code === 'PRODUCTION_NOT_READY');

  assert.equal(order.includes('cleanup:start'), false);
  assert.equal(order.includes('dispatcher:probe'), false);
  assert.equal(order.includes('dispatcher:claim'), false);
  assert.deepEqual(order.slice(-3), ['lock:denied', 'media:close', 'store:close']);
});

test('a listen failure never resumes the dispatcher or consumes a persisted turn', async (t) => {
  const blocker = createHttpServer();
  blocker.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    blocker.once('listening', resolve);
    blocker.once('error', reject);
  });
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const order = [];
  const config = productionConfig();
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => order.push('retention:stop'),
  };

  await assert.rejects(startServer({
    config,
    host: '127.0.0.1',
    port: blocker.address().port,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => assert.fail('provider must not run') },
    evaluateReadiness: async () => safeReadiness(true),
  }), (error) => error?.code === 'EADDRINUSE');

  assert.equal(order.includes('dispatcher:claim'), false);
  assert.equal(order.includes('cleanup:start'), false,
    'periodic cleanup never starts when HTTP bind fails');
  assert.ok(order.indexOf('lock:release') < order.indexOf('store:close'));
});

test('shutdown stops dispatcher claims before waiting for retention to drain', async () => {
  const order = [];
  const config = productionConfig();
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  let claimCount = 0;
  store.claimNextTurn = async () => {
    claimCount += 1;
    return null;
  };
  const retentionStopEntered = deferred();
  const releaseRetentionStop = deferred();
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => {
      retentionStopEntered.resolve();
      await releaseRetentionStop.promise;
    },
  };
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
  });

  server.runtime.dispatcher.wake();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const claimsBeforeShutdown = claimCount;
  const shuttingDown = server.shutdown();
  await retentionStopEntered.promise;
  try {
    assert.equal(server.runtime.dispatcher.readiness().healthy, false,
      'dispatcher must become not-ready as soon as shutdown starts');
    assert.equal((await server.runtime.readiness()).exitCode, 1,
      'shutdown immediately replaces the public readiness cache with fail-closed state');
    server.runtime.dispatcher.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(claimCount, claimsBeforeShutdown,
      'no persisted turn may be claimed while retention stop is pending');
  } finally {
    releaseRetentionStop.resolve();
    await shuttingDown;
  }
});

test('configuration failure happens before any storage factory can open a connection', async () => {
  let storageFactoryCalls = 0;
  await assert.rejects(startServer({
    environment: { NODE_ENV: 'production' },
    loadConfig: () => { throw new Error('configuration blocked'); },
    createStorageRuntime: async () => {
      storageFactoryCalls += 1;
      throw new Error('must not run');
    },
  }), /configuration blocked/);
  assert.equal(storageFactoryCalls, 0);

  for (const nodeEnv of ['Production', 'staging', ' production ']) {
    await assert.rejects(startServer({
      environment: { NODE_ENV: nodeEnv },
      createStorageRuntime: async () => {
        storageFactoryCalls += 1;
        throw new Error('must not run');
      },
    }), /NODE_ENV/i, nodeEnv);
  }
  assert.equal(storageFactoryCalls, 0, 'unknown NODE_ENV values open no storage adapter');
});

test('server creates one shared ADC adapter for all configured Google providers', async (t) => {
  const config = productionConfig();
  config.llm = {
    available: true, provider: 'vertex-ai', timeoutMs: 1_000,
    settings: { projectId: 'motion-expert-hk-ltd-webpage', location: 'global', model: 'gemini-2.5-flash' },
  };
  config.asr = { available: true, provider: 'google-stt-v2', settings: {
    projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1', model: 'chirp_2', recognizer: '_',
    languageCodes: ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'], credentialVersion: 'runtime-sa-rotation-v1',
  } };
  config.tts = { available: true, provider: 'google-tts', settings: {
    projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1', credentialVersion: 'runtime-sa-rotation-v1',
    voices: {
      en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
      yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
      zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
    },
  } };
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  let authFactoryCalls = 0;
  const server = await startServer({
    config, host: '127.0.0.1', port: 0, store, mediaStore, cleanupService, retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    createGoogleAuthProvider: () => {
      authFactoryCalls += 1;
      return { fetch: async () => assert.fail('provider must not run during startup') };
    },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
  });
  t.after(() => server.shutdown());

  assert.equal(authFactoryCalls, 1);
  assert.equal(server.runtime.asrProvider.provider, 'google-stt-v2');
  assert.equal(server.runtime.ttsProvider.provider, 'google-tts');
});

test('server triggers bounded assistant audio recovery without waiting for TTS completion', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  const recovery = deferred();
  let recoveryCalls = 0;
  const voiceService = {
    recoverAssistantAudio() {
      recoveryCalls += 1;
      return recovery.promise;
    },
  };
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    voiceService,
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
  });
  t.after(() => server.shutdown());
  assert.equal(recoveryCalls, 1);
  recovery.resolve({ scanned: 0, attempted: 0, attached: 0, limit: 25 });
  await server.runtime.voiceRecovery;
});

test('server assistant audio recovery recurs without overlapping provider work', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  const first = deferred();
  const second = deferred();
  const scheduled = [];
  let recoveryCalls = 0;
  const voiceService = {
    recoverAssistantAudio() {
      recoveryCalls += 1;
      return recoveryCalls === 1 ? first.promise : second.promise;
    },
  };
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    voiceService,
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
    voiceRecoveryOptions: {
      intervalMs: 25,
      setTimeoutFn(callback, intervalMs) {
        const handle = { callback, intervalMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutFn: () => undefined,
    },
  });
  t.after(() => server.shutdown());

  assert.equal(recoveryCalls, 1);
  first.resolve({ scanned: 1, attempted: 1, attached: 0, limit: 25 });
  await server.runtime.voiceRecovery;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, 25);
  assert.equal(scheduled[0].unrefCalled, true);
  scheduled[0].callback();
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryCalls, 2, 'duplicate timer delivery must coalesce while recovery is live');
  second.resolve({ scanned: 1, attempted: 1, attached: 1, limit: 25 });
});

test('server startup and interval recovery never synthesize an untouched text answer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-server-text-recovery-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  const owner = await store.createOrResumeSession({
    tokenHash: '9'.repeat(64), now: '2026-08-25T00:00:00.000Z',
  });
  const accepted = await store.acceptMessage({
    sessionId: owner.session.id,
    conversationId: owner.conversation.id,
    clientMessageId: '99999999-9999-4999-8999-999999999999',
    requestHash: 'server-untouched-text-answer',
    text: 'Text only, please.',
    replyLanguage: 'en',
    replyMode: 'text',
    now: '2026-08-25T00:00:01.000Z',
  });
  const claimed = await store.claimNextTurn({
    workerId: 'server-test-worker', leaseToken: 'server-test-lease',
    now: new Date('2026-08-25T00:00:02.000Z'),
    leaseUntil: new Date('2026-08-25T00:01:00.000Z'),
  });
  await store.setTurnState({
    turnId: claimed.id, leaseToken: 'server-test-lease', state: 'retrieving',
    now: '2026-08-25T00:00:03.000Z',
  });
  await store.setTurnState({
    turnId: claimed.id, leaseToken: 'server-test-lease', state: 'generating',
    now: '2026-08-25T00:00:04.000Z',
  });
  await store.deliverAssistant({
    turnId: accepted.turn.id, leaseToken: 'server-test-lease',
    message: { text: 'This answer remains text only.' },
    now: '2026-08-25T00:00:05.000Z',
  });

  let providerCalls = 0;
  const voiceService = {
    async recoverAssistantAudio({ limit = 25 } = {}) {
      const candidates = await store.listAssistantAudioRecoveryCandidates({
        limit, now: '2026-08-25T00:00:06.000Z',
      });
      providerCalls += candidates.length;
      return { scanned: candidates.length, attempted: candidates.length, attached: 0, limit };
    },
  };
  const order = [];
  const runtime = runtimeFixture(order);
  const scheduled = [];
  const server = await startServer({
    config: productionConfig(), host: '127.0.0.1', port: 0,
    store: { ...runtime.store, listAssistantAudioRecoveryCandidates: store.listAssistantAudioRecoveryCandidates.bind(store) },
    mediaStore: runtime.mediaStore,
    cleanupService: runtime.cleanupService,
    retentionWorker: {
      firstRun: Promise.resolve({ ok: true }),
      readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
      stop: async () => undefined,
    },
    voiceService,
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
    voiceRecoveryOptions: {
      intervalMs: 25,
      setTimeoutFn(callback) {
        const handle = { callback, unref() {} };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutFn: () => undefined,
    },
  });
  t.after(async () => { await server.shutdown(); await store.close(); });

  await server.runtime.voiceRecovery;
  assert.equal(providerCalls, 0);
  assert.equal(scheduled.length, 1);
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls, 0);
});

test('server shutdown clears recovery timers and never waits for or rearms an in-flight sweep', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  const first = deferred();
  const second = deferred();
  const scheduled = [];
  const cleared = [];
  let recoveryCalls = 0;
  const voiceService = {
    recoverAssistantAudio({ signal } = {}) {
      recoveryCalls += 1;
      if (recoveryCalls === 2) {
        signal?.addEventListener('abort', () => order.push('recovery:aborted'), { once: true });
        return second.promise;
      }
      return first.promise;
    },
  };
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    voiceService,
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
    voiceRecoveryOptions: {
      intervalMs: 25,
      setTimeoutFn(callback) {
        const handle = { callback, unref() {} };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutFn: (handle) => cleared.push(handle),
    },
  });
  t.after(() => server.shutdown());

  first.resolve({ scanned: 0, attempted: 0, attached: 0, limit: 25 });
  await server.runtime.voiceRecovery;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryCalls, 2);

  await settleWithin(server.shutdown(), 250, 'shutdown waited for an in-flight recovery provider');
  assert.equal(order.includes('recovery:aborted'), true);
  second.resolve({ scanned: 1, attempted: 1, attached: 0, limit: 25 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1, 'shutdown must not rearm recovery');
  assert.equal(cleared.length, 0, 'the in-flight callback owns no pending timer');
});

test('server shutdown clears a pending assistant audio recovery timer', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  const scheduled = [];
  const cleared = [];
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    voiceService: { recoverAssistantAudio: async () => ({ scanned: 0, attempted: 0, attached: 0, limit: 25 }) },
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
    voiceRecoveryOptions: {
      intervalMs: 25,
      setTimeoutFn(callback) {
        const handle = { callback, unref() {} };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutFn: (handle) => cleared.push(handle),
    },
  });
  t.after(() => server.shutdown());
  await server.runtime.voiceRecovery;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  await server.shutdown();
  assert.deepEqual(cleared, [scheduled[0]]);
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1, 'a late cleared callback must not rearm recovery');
});

test('production lock loss synchronously clears a pending recovery timer and fences late callbacks', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  let owned = true;
  let loseLock;
  const instanceLock = {
    get owned() { return owned; },
    isOwned: () => owned,
    healthCheck: async () => ({ owned }),
    release: async () => { owned = false; },
  };
  store.acquireInstanceLock = async ({ onLost }) => {
    loseLock = () => { owned = false; onLost(); };
    return instanceLock;
  };
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  const scheduled = [];
  const cleared = [];
  let recoveryClaims = 0;
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    voiceService: {
      async recoverAssistantAudio() {
        recoveryClaims += 1;
        return { scanned: 0, attempted: 0, attached: 0, limit: 25 };
      },
    },
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
    readinessWatchdogOptions: {
      intervalMs: 60_000,
      setTimeoutFn: () => ({ unref() {} }),
      clearTimeoutFn: () => undefined,
    },
    voiceRecoveryOptions: {
      intervalMs: 25,
      setTimeoutFn(callback) {
        const handle = { callback, unref() {} };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutFn: (handle) => cleared.push(handle),
    },
  });
  t.after(() => server.shutdown());
  await server.runtime.voiceRecovery;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryClaims, 1);
  assert.equal(scheduled.length, 1);

  loseLock();
  assert.deepEqual(cleared, [scheduled[0]], 'lock loss clears recovery synchronously');
  assert.equal(server.runtime.runtimeState.instanceLockOwned, false);
  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryClaims, 1, 'a lock-lost instance cannot claim another recovery sweep');
  assert.equal(scheduled.length, 1, 'a late timer callback cannot rearm recovery');

  loseLock();
  await server.shutdown();
  assert.deepEqual(cleared, [scheduled[0]], 'lock loss and shutdown share one idempotent timer fence');
});

test('production lock loss synchronously aborts an in-flight recovery and prevents rearm', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  let owned = true;
  let loseLock;
  const instanceLock = {
    get owned() { return owned; },
    isOwned: () => owned,
    healthCheck: async () => ({ owned }),
    release: async () => { owned = false; },
  };
  store.acquireInstanceLock = async ({ onLost }) => {
    loseLock = () => { owned = false; onLost(); };
    return instanceLock;
  };
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  const recovery = deferred();
  const scheduled = [];
  let recoveryClaims = 0;
  let recoveryAborted = false;
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    voiceService: {
      recoverAssistantAudio({ signal }) {
        recoveryClaims += 1;
        signal.addEventListener('abort', () => { recoveryAborted = true; }, { once: true });
        return recovery.promise;
      },
    },
    corpus: {
      schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async () => safeReadiness(true),
    dispatcherOptions: { pollIntervalMs: 60_000 },
    readinessWatchdogOptions: {
      intervalMs: 60_000,
      setTimeoutFn: () => ({ unref() {} }),
      clearTimeoutFn: () => undefined,
    },
    voiceRecoveryOptions: {
      intervalMs: 25,
      setTimeoutFn(callback) {
        const handle = { callback, unref() {} };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutFn: () => undefined,
    },
  });
  t.after(() => server.shutdown());
  assert.equal(recoveryClaims, 1);

  loseLock();
  assert.equal(recoveryAborted, true, 'lock loss aborts provider work synchronously');
  assert.equal(server.runtime.runtimeState.accepting, false);
  recovery.resolve({ scanned: 1, attempted: 1, attached: 0, limit: 25 });
  await server.runtime.voiceRecovery;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryClaims, 1, 'the lock-lost instance starts no further store/provider work');
  assert.equal(scheduled.length, 0, 'late recovery settlement cannot rearm after ownership loss');

  await server.shutdown();
  assert.equal(recoveryClaims, 1, 'normal shutdown is idempotent after lock-loss abort');
});

test('the single-flight readiness supervisor revokes, gates, and recovers while public ready stays cached', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  let evaluationCalls = 0;
  let activeEvaluations = 0;
  let maximumActiveEvaluations = 0;
  const redEvaluation = deferred();
  const redEvaluationStarted = deferred();
  const scheduled = [];
  const cleared = [];
  const setTimeoutFn = (callback, intervalMs) => {
    const handle = {
      callback,
      intervalMs,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
    };
    scheduled.push(handle);
    return handle;
  };
  const clearTimeoutFn = (handle) => { cleared.push(handle); };
  const evaluateReadiness = async () => {
    evaluationCalls += 1;
    activeEvaluations += 1;
    maximumActiveEvaluations = Math.max(maximumActiveEvaluations, activeEvaluations);
    try {
      if (evaluationCalls === 2) {
        redEvaluationStarted.resolve();
        return await redEvaluation.promise;
      }
      return safeReadiness(true);
    } finally {
      activeEvaluations -= 1;
    }
  };
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness,
    readinessWatchdogOptions: {
      intervalMs: 60_000,
      setTimeoutFn,
      clearTimeoutFn,
    },
  });
  t.after(() => server.shutdown());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(evaluationCalls, 1, 'startup performs the only initial live evaluation');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].unrefCalled, true);

  const firstWatchdog = scheduled.shift();
  firstWatchdog.callback();
  firstWatchdog.callback();
  await redEvaluationStarted.promise;
  assert.equal(evaluationCalls, 2, 'duplicate watchdog delivery coalesces into one live evaluation');
  assert.equal(maximumActiveEvaluations, 1);
  redEvaluation.resolve(safeReadiness(false));
  for (let index = 0; index < 20 && config.productionReady; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(config.productionReady, false);
  assert.equal(server.runtime.runtimeState.accepting, false);
  const claimsAtRevocation = order.filter((entry) => entry === 'dispatcher:claim').length;
  server.runtime.dispatcher.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(order.filter((entry) => entry === 'dispatcher:claim').length, claimsAtRevocation,
    'a revoked dispatcher makes no further claims');

  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).data.productionReady, false);
  }
  assert.equal(evaluationCalls, 2, 'public readiness performs zero live dependency evaluations');

  for (const [method, path] of [
    ['POST', '/api/v1/session'],
    ['POST', '/api/v1/messages'],
    ['DELETE', '/api/v1/session'],
    ['POST', '/api/v1/voice/transcriptions'],
    ['POST', '/api/v1/messages/11111111-1111-4111-8111-111111111111/audio'],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    const body = await response.json();
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal(body.error?.code, 'PRODUCTION_NOT_READY', `${method} ${path}`);
  }

  assert.equal(scheduled.length, 1, 'one next low-frequency watchdog is scheduled');
  scheduled.shift().callback();
  for (let index = 0; index < 20 && !config.productionReady; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(evaluationCalls, 3);
  assert.equal(config.productionReady, true);
  assert.equal(server.runtime.runtimeState.accepting, true);
  const recoveredResponse = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(recoveredResponse.status, 200);
  assert.equal(evaluationCalls, 3);
  server.runtime.dispatcher.wake();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(order.filter((entry) => entry === 'dispatcher:claim').length > claimsAtRevocation, true,
    'green recovery resumes dispatcher polling');

  const pendingAfterRecovery = scheduled.at(-1);
  await server.shutdown();
  assert.equal(cleared.includes(pendingAfterRecovery), true, 'shutdown clears the watchdog timer');
  const callsAtShutdown = evaluationCalls;
  pendingAfterRecovery.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(evaluationCalls, callsAtShutdown, 'a late watchdog callback is fenced after shutdown');
});

test('dedicated PostgreSQL lock client error or end immediately revokes writes and dispatcher claims', async (t) => {
  for (const eventName of ['error', 'end']) {
    await t.test(eventName, async (subtest) => {
      const config = productionConfig();
      const order = [];
      const { store, mediaStore, cleanupService } = runtimeFixture(order);
      const lockClient = new EventEmitter();
      let lockClientReleases = 0;
      lockClient.query = async (query) => {
        const text = String(query?.text ?? query);
        if (/pg_try_advisory_lock/i.test(text)) return { rowCount: 1, rows: [{ acquired: true }] };
        if (/pg_advisory_unlock/i.test(text)) return { rowCount: 1, rows: [{ released: true }] };
        if (/FROM pg_locks/i.test(text)) return { rowCount: 1, rows: [{ owned: true }] };
        throw new Error('unexpected lock query');
      };
      lockClient.release = () => { lockClientReleases += 1; };
      const lockStore = new PostgresStore({
        ownsPool: false,
        pool: {
          query: async () => { throw new Error('lock supervision must use its dedicated client'); },
          connect: async () => lockClient,
        },
      });
      store.acquireInstanceLock = (options) => lockStore.acquireInstanceLock(options);
      const retentionWorker = {
        firstRun: Promise.resolve({ ok: true }),
        readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
        stop: async () => undefined,
      };
      const server = await startServer({
        config,
        host: '127.0.0.1',
        port: 0,
        store,
        mediaStore,
        cleanupService,
        retentionWorker,
        corpus: {
          schemaVersion: 'hkbu-campus-v1',
          snapshotAt: '2026-08-25T12:00:00+08:00',
          sources: [{ id: 'official-source' }],
        },
        llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
        evaluateReadiness: async () => safeReadiness(true),
        readinessWatchdogOptions: {
          intervalMs: 60_000,
          setTimeoutFn: () => ({ unref() {} }),
          clearTimeoutFn: () => undefined,
        },
      });
      subtest.after(() => server.shutdown());
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const claimsBeforeLoss = order.filter((entry) => entry === 'dispatcher:claim').length;

      assert.doesNotThrow(() => lockClient.emit(
        eventName,
        ...(eventName === 'error' ? [new Error('postgres://private-lock-host/db')] : []),
      ));
      for (let index = 0; index < 20 && config.productionReady; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      assert.equal(config.productionReady, false);
      assert.equal(server.runtime.runtimeState.accepting, false);
      assert.equal(server.runtime.runtimeState.instanceLockOwned, false);
      assert.equal((await server.runtime.readiness()).exitCode, 1);
      const ready = await fetch(`${baseUrl}/api/health/ready`);
      assert.equal(ready.status, 503);
      const write = await fetch(`${baseUrl}/api/v1/session`, { method: 'POST' });
      assert.equal(write.status, 503);
      assert.equal((await write.json()).error?.code, 'PRODUCTION_NOT_READY');

      server.runtime.dispatcher.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(order.filter((entry) => entry === 'dispatcher:claim').length, claimsBeforeLoss,
        'the instance that lost its lock must not consume another turn');
      assert.equal(lockClientReleases, 1, 'the failed lock session is disposed exactly once');
      await server.shutdown();
      assert.equal(lockClientReleases, 1, 'intentional shutdown is idempotent after lock loss');
    });
  }
});

test('the watchdog checks the dedicated singleton session and revokes a lock that becomes unowned', async (t) => {
  const config = productionConfig();
  const order = [];
  const { store, mediaStore, cleanupService } = runtimeFixture(order);
  let owned = true;
  let lockProbes = 0;
  const instanceLock = {
    get owned() { return owned; },
    isOwned: () => owned,
    healthCheck: async () => {
      lockProbes += 1;
      return { owned };
    },
    release: async () => { owned = false; },
  };
  store.acquireInstanceLock = async () => instanceLock;
  const retentionWorker = {
    firstRun: Promise.resolve({ ok: true }),
    readiness: async () => ({ status: 'ready', healthy: true, policyVersion: 'retention-v1' }),
    stop: async () => undefined,
  };
  const scheduled = [];
  const server = await startServer({
    config,
    host: '127.0.0.1',
    port: 0,
    store,
    mediaStore,
    cleanupService,
    retentionWorker,
    corpus: {
      schemaVersion: 'hkbu-campus-v1',
      snapshotAt: '2026-08-25T12:00:00+08:00',
      sources: [{ id: 'official-source' }],
    },
    llmProvider: { provider: 'fake-real', generate: async () => ({ text: 'unused' }) },
    evaluateReadiness: async ({ checks, allowPausedRuntime, signal }) => {
      const runtime = await checks.runtime({ allowPausedRuntime, signal });
      return safeReadiness(runtime.healthy === true);
    },
    readinessWatchdogOptions: {
      intervalMs: 60_000,
      setTimeoutFn: (callback) => {
        const handle = { callback, unref() {} };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutFn: () => undefined,
    },
  });
  t.after(() => server.shutdown());
  assert.equal(config.productionReady, true);
  assert.equal(lockProbes, 1, 'startup validates the owning lock session');

  owned = false;
  scheduled.shift().callback();
  for (let index = 0; index < 20 && config.productionReady; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(lockProbes, 2);
  assert.equal(config.productionReady, false);
  assert.equal(server.runtime.runtimeState.accepting, false);
});

test('SIGTERM and SIGINT share one graceful shutdown and remove their listeners', async () => {
  const processLike = new EventEmitter();
  processLike.exitCode = null;
  processLike.exit = () => assert.fail('graceful shutdown must not force exit');
  const closing = deferred();
  let shutdownCalls = 0;
  const control = installProcessShutdown({
    server: {
      shutdown: async () => {
        shutdownCalls += 1;
        await closing.promise;
      },
    },
    processLike,
    forceExitAfterMs: 1_000,
  });

  processLike.emit('SIGTERM');
  processLike.emit('SIGINT');
  assert.equal(shutdownCalls, 1);
  closing.resolve();
  await control.shutdown('SIGTERM');
  assert.equal(processLike.exitCode, 0);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
  assert.equal(processLike.listenerCount('SIGINT'), 0);
});

test('a stuck process shutdown reaches the bounded forced-exit path', () => {
  const processLike = new EventEmitter();
  processLike.exitCode = null;
  const exitCodes = [];
  processLike.exit = (code) => exitCodes.push(code);
  let forceCallback;
  const control = installProcessShutdown({
    server: { shutdown: () => new Promise(() => undefined) },
    processLike,
    forceExitAfterMs: 50,
    setTimeoutFn: (callback) => {
      forceCallback = callback;
      return { unref() {} };
    },
    clearTimeoutFn: () => undefined,
  });

  processLike.emit('SIGTERM');
  forceCallback();
  assert.deepEqual(exitCodes, [1]);
  assert.equal(processLike.exitCode, 1);
  control.dispose();
});
