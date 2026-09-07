import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { loadDefaultCorpus } from './knowledge/corpus.js';
import { createRetriever } from './knowledge/retriever.js';
import { createAsrProvider } from './providers/asr.js';
import { createLlmProvider } from './providers/llm.js';
import { createTtsProvider } from './providers/tts.js';
import { createGoogleAccessTokenProvider } from './providers/google-auth.js';
import { createAnswerService } from './services/answer.js';
import { createDispatcher } from './services/dispatcher.js';
import { EventHub } from './services/events.js';
import { createMediaCleanupService } from './services/media-cleanup.js';
import { evaluateProductionReadiness } from './services/readiness.js';
import { startRetentionWorker } from './services/retention.js';
import { createRuntimeReadinessChecks } from './services/runtime-readiness.js';
import { createStorageRuntime } from './services/storage-runtime.js';
import { createTurnProcessor } from './services/turn-processor.js';
import { createAcceptanceTimingRecorder } from './telemetry/acceptance-timings.js';
import {
  assistantAudioRecoveryIntervalMs,
  assertVoiceOutputCapability,
  defaultVoiceIngressSpoolRoot,
  createVoiceService,
  recoverStaleVoiceIngressSpools,
} from './services/voice.js';
import { productionInstanceLockName } from './stores/postgres-store.js';

const DEFAULT_STARTUP_STEP_TIMEOUT_MS = 15_000;
const DEFAULT_READINESS_WATCHDOG_INTERVAL_MS = 30_000;

function unavailableReadiness() {
  return {
    exitCode: 1,
    publicReport: {
      status: 'not-ready',
      productionReady: false,
      boundary: 'production-v1',
      checks: [{ name: 'runtime', status: 'not-ready', version: 'single-instance-v1' }],
    },
  };
}

function productionReadinessIsReady(evaluated) {
  return evaluated?.exitCode === 0
    && evaluated?.publicReport?.status === 'ready'
    && evaluated.publicReport.productionReady === true
    && evaluated.publicReport.boundary === 'production-v1';
}

function productionNotReady() {
  const error = new Error('Production V1 runtime is not ready');
  error.code = 'PRODUCTION_NOT_READY';
  return error;
}

function startupStepTimeout(config) {
  const timeoutMs = config?.startupStepTimeoutMs;
  return Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000
    ? timeoutMs
    : DEFAULT_STARTUP_STEP_TIMEOUT_MS;
}

async function runStartupStep(operation, timeoutMs, { closeLateResult, onTimeout } = {}) {
  let timer;
  let timedOut = false;
  const work = Promise.resolve().then(operation);
  if (typeof closeLateResult === 'function') {
    void work.then((result) => {
      if (!timedOut) return undefined;
      try {
        return Promise.resolve(closeLateResult(result)).catch(() => undefined);
      } catch {
        return undefined;
      }
    }, () => undefined);
  }
  const deadline = new Promise((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => {
      timedOut = true;
      if (typeof onTimeout === 'function') {
        try { void Promise.resolve(onTimeout()).catch(() => undefined); } catch { /* best-effort timeout cleanup */ }
      }
      reject(productionNotReady());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function updatePublicStatus(config, now) {
  if (typeof config?.getPublicStatus === 'function') {
    config.publicStatus = config.getPublicStatus(now());
  } else if (config?.publicStatus && typeof config.publicStatus === 'object') {
    config.publicStatus = { ...config.publicStatus, productionReady: config.productionReady === true };
  }
}

export function installProcessShutdown({
  server,
  processLike = process,
  forceExitAfterMs = 10_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof server?.shutdown !== 'function'
    || typeof processLike?.once !== 'function'
    || typeof processLike?.off !== 'function'
    || typeof processLike?.exit !== 'function'
    || !Number.isInteger(forceExitAfterMs) || forceExitAfterMs <= 0) {
    throw new Error('Process shutdown dependencies are invalid');
  }
  const signals = ['SIGINT', 'SIGTERM'];
  let shutdownPromise = null;
  const handlers = new Map();
  const dispose = () => {
    for (const [signal, handler] of handlers) processLike.off(signal, handler);
  };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const forceTimer = setTimeoutFn(() => {
        processLike.exitCode = 1;
        processLike.exit(1);
      }, forceExitAfterMs);
      forceTimer?.unref?.();
      try {
        await server.shutdown();
        processLike.exitCode = 0;
      } catch {
        processLike.exitCode = 1;
      } finally {
        clearTimeoutFn(forceTimer);
        dispose();
      }
    })();
    return shutdownPromise;
  };
  for (const signal of signals) {
    const handler = () => { void shutdown(); };
    handlers.set(signal, handler);
    processLike.once(signal, handler);
  }
  return { shutdown, dispose };
}

export async function startServer({
  environment = process.env,
  config: suppliedConfig,
  loadConfig: loadConfigImpl = loadConfig,
  port = Number(environment.PORT ?? 3000),
  host,
  store: suppliedStore,
  corpus: suppliedCorpus,
  llmProvider: suppliedLlmProvider,
  eventHub: suppliedEventHub,
  mediaStore: suppliedMediaStore,
  asrProvider: suppliedAsrProvider,
  ttsProvider: suppliedTtsProvider,
  googleAuthProvider: suppliedGoogleAuthProvider,
  cleanupService: suppliedCleanupService,
  voiceService: suppliedVoiceService,
  acceptanceTimingRecorder: suppliedAcceptanceTimingRecorder,
  retentionWorker: suppliedRetentionWorker,
  createApp: createAppImpl = createApp,
  createStorageRuntime: createStorageRuntimeImpl = createStorageRuntime,
  createGoogleAuthProvider: createGoogleAuthProviderImpl = createGoogleAccessTokenProvider,
  startRetentionWorker: startRetentionWorkerImpl = startRetentionWorker,
  evaluateReadiness: evaluateReadinessImpl = evaluateProductionReadiness,
  poolFactory,
  azureCredential,
  gcsStorage,
  dispatcherOptions = {},
  retentionOptions = {},
  readinessWatchdogOptions = {},
  voiceRecoveryOptions = {},
  now = () => new Date(),
  spoolParentDirectory = defaultVoiceIngressSpoolRoot,
  spoolRecoveryLimit,
  spoolStaleAfterMs,
} = {}) {
  const config = suppliedConfig ?? loadConfigImpl(environment, { now });
  const acceptanceTimingRecorder = suppliedAcceptanceTimingRecorder
    ?? (/^[0-9a-f]{40}$/.test(String(config.releaseCommitSha ?? ''))
      ? createAcceptanceTimingRecorder({ releaseCommitSha: config.releaseCommitSha, now: () => new Date(now()).getTime() })
      : null);
  const startupTimeoutMs = startupStepTimeout(config);
  const runtimeState = {
    accepting: false,
    recoverable: false,
    instancePolicy: config.instancePolicy ?? null,
    instanceLockOwned: false,
  };
  let storageRuntime = null;
  let instanceLock = null;
  let dispatcher = null;
  let cleanupService = null;
  let retentionWorker = null;
  let eventHub = null;
  let voiceRecovery = null;
  let voiceRecoveryTimer = null;
  let voiceRecoveryController = null;
  let voiceRecoveryStopped = true;
  let voiceService = null;
  let server = null;
  let shutdownPromise = null;
  let cachedReadiness = config.nodeEnv === 'production'
    ? unavailableReadiness()
    : {
      exitCode: 2,
      publicReport: {
        status: 'preview',
        productionReady: false,
        boundary: 'local-preview-only',
        checks: [{ name: 'configuration', status: 'preview', version: 'local-preview-v1' }],
      },
    };
  let liveReadinessPromise = null;
  let liveReadinessController = null;
  let watchdogTimer = null;
  let watchdogStopped = true;
  let readinessChecks = null;
  const configuredWatchdogIntervalMs = Number.isInteger(config.readinessWatchdogIntervalMs)
    && config.readinessWatchdogIntervalMs >= 1_000
    && config.readinessWatchdogIntervalMs <= 300_000
    ? config.readinessWatchdogIntervalMs
    : DEFAULT_READINESS_WATCHDOG_INTERVAL_MS;
  const watchdogIntervalMs = Number.isInteger(readinessWatchdogOptions.intervalMs)
    && readinessWatchdogOptions.intervalMs >= 1
    ? readinessWatchdogOptions.intervalMs
    : configuredWatchdogIntervalMs;
  const watchdogSetTimeout = readinessWatchdogOptions.setTimeoutFn ?? setTimeout;
  const watchdogClearTimeout = readinessWatchdogOptions.clearTimeoutFn ?? clearTimeout;
  const voiceRecoveryIntervalMs = Number.isInteger(voiceRecoveryOptions.intervalMs)
    && voiceRecoveryOptions.intervalMs >= 1
    ? voiceRecoveryOptions.intervalMs
    : assistantAudioRecoveryIntervalMs;
  const voiceRecoverySetTimeout = voiceRecoveryOptions.setTimeoutFn ?? setTimeout;
  const voiceRecoveryClearTimeout = voiceRecoveryOptions.clearTimeoutFn ?? clearTimeout;

  const applyReadinessState = (evaluated) => {
    cachedReadiness = evaluated ?? unavailableReadiness();
    if (config.nodeEnv !== 'production') return;
    const ready = runtimeState.recoverable === true
      && productionReadinessIsReady(cachedReadiness);
    runtimeState.accepting = ready;
    config.productionReady = ready;
    updatePublicStatus(config, now);
    if (ready) dispatcher?.resume?.();
    else dispatcher?.pause?.();
  };

  const handleInstanceLockLost = () => {
    if (config.nodeEnv !== 'production') return;
    stopVoiceRecovery();
    runtimeState.instanceLockOwned = false;
    runtimeState.recoverable = false;
    try {
      applyReadinessState(unavailableReadiness());
    } catch {
      cachedReadiness = unavailableReadiness();
      runtimeState.accepting = false;
      config.productionReady = false;
      try { dispatcher?.pause?.(); } catch { /* lock loss must remain contained */ }
    }
  };

  const instanceLockIsOwned = () => config.nodeEnv !== 'production'
    || (instanceLock?.owned === true
      && typeof instanceLock?.isOwned === 'function'
      && instanceLock.isOwned() === true
      && runtimeState.instanceLockOwned === true);

  const runLiveReadiness = ({ applyState = true } = {}) => {
    if (liveReadinessPromise) return liveReadinessPromise;
    const controller = new AbortController();
    liveReadinessController = controller;
    const work = (async () => {
      let evaluated;
      try {
        evaluated = await evaluateReadinessImpl({
          config,
          checks: readinessChecks,
          now,
          signal: controller.signal,
          allowPausedRuntime: true,
        });
      } catch {
        evaluated = unavailableReadiness();
      }
      evaluated ??= unavailableReadiness();
      if (runtimeState.recoverable === true && !controller.signal.aborted) {
        if (applyState) applyReadinessState(evaluated);
        else cachedReadiness = evaluated;
      }
      return evaluated;
    })();
    const wrapped = work.finally(() => {
      if (liveReadinessPromise === wrapped) {
        liveReadinessPromise = null;
        liveReadinessController = null;
      }
    });
    liveReadinessPromise = wrapped;
    return wrapped;
  };

  const scheduleWatchdog = () => {
    if (watchdogStopped || watchdogTimer || runtimeState.recoverable !== true) return;
    watchdogTimer = watchdogSetTimeout(() => {
      watchdogTimer = null;
      if (watchdogStopped || runtimeState.recoverable !== true) return;
      void runLiveReadiness({ applyState: true }).finally(scheduleWatchdog);
    }, watchdogIntervalMs);
    watchdogTimer?.unref?.();
  };

  const startWatchdog = () => {
    if (config.nodeEnv !== 'production') return;
    watchdogStopped = false;
    scheduleWatchdog();
  };

  const stopWatchdog = async () => {
    watchdogStopped = true;
    if (watchdogTimer) {
      watchdogClearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    liveReadinessController?.abort();
    void liveReadinessPromise?.catch(() => undefined);
  };

  const scheduleVoiceRecovery = () => {
    if (voiceRecoveryStopped || voiceRecoveryTimer || voiceRecoveryController) return;
    const handle = voiceRecoverySetTimeout(() => {
      if (voiceRecoveryTimer !== handle) return;
      voiceRecoveryTimer = null;
      if (voiceRecoveryStopped) return;
      voiceRecovery = runVoiceRecovery();
    }, voiceRecoveryIntervalMs);
    voiceRecoveryTimer = handle;
    handle?.unref?.();
  };

  const runVoiceRecovery = () => {
    if (voiceRecoveryStopped) {
      return Promise.resolve({ scanned: 0, attempted: 0, attached: 0, limit: 0 });
    }
    if (voiceRecoveryController) return voiceRecovery;
    const controller = new AbortController();
    voiceRecoveryController = controller;
    const work = Promise.resolve()
      .then(() => voiceService?.recoverAssistantAudio?.({ signal: controller.signal }))
      .catch(() => ({ scanned: 0, attempted: 0, attached: 0, limit: 0 }));
    const wrapped = work.finally(() => {
      if (voiceRecoveryController === controller) voiceRecoveryController = null;
      scheduleVoiceRecovery();
    });
    voiceRecovery = wrapped;
    return wrapped;
  };

  const startVoiceRecovery = () => {
    voiceRecoveryStopped = false;
    return runVoiceRecovery();
  };

  const stopVoiceRecovery = () => {
    voiceRecoveryStopped = true;
    if (voiceRecoveryTimer) {
      voiceRecoveryClearTimeout(voiceRecoveryTimer);
      voiceRecoveryTimer = null;
    }
    voiceRecoveryController?.abort();
    void voiceRecovery?.catch(() => undefined);
  };

  const stopRuntime = ({ cleanupTimeoutMs } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let firstError = null;
      const cleanupDeadlineAt = Number.isInteger(cleanupTimeoutMs) && cleanupTimeoutMs >= 1
        ? Date.now() + cleanupTimeoutMs
        : null;
      const attempt = async (operation) => {
        let work;
        try { work = Promise.resolve(operation()); } catch (error) {
          firstError ??= error;
          return;
        }
        if (cleanupDeadlineAt === null) {
          try { await work; } catch (error) { firstError ??= error; }
          return;
        }
        const observed = work.then(
          () => ({ settled: true }),
          (error) => ({ settled: true, error }),
        );
        const remainingMs = Math.max(0, cleanupDeadlineAt - Date.now());
        if (remainingMs === 0) {
          void observed;
          return;
        }
        let timer;
        const outcome = await Promise.race([
          observed,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ settled: false }), remainingMs);
          }),
        ]);
        clearTimeout(timer);
        if (outcome.error) firstError ??= outcome.error;
      };
      runtimeState.recoverable = false;
      runtimeState.accepting = false;
      config.productionReady = false;
      cachedReadiness = unavailableReadiness();
      const watchdogStoppedPromise = attempt(() => stopWatchdog());
      stopVoiceRecovery();
      const dispatcherStopped = attempt(() => dispatcher?.stop?.());
      await attempt(() => updatePublicStatus(config, now));
      const httpClosed = server?.listening
        ? new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        : Promise.resolve();
      await attempt(() => eventHub?.close?.());
      await attempt(() => server?.closeIdleConnections?.());
      await attempt(() => retentionWorker?.stop?.());
      await attempt(() => cleanupService?.stop?.());
      await watchdogStoppedPromise;
      await dispatcherStopped;
      await attempt(() => httpClosed);
      await attempt(() => instanceLock?.release?.());
      runtimeState.instanceLockOwned = false;
      await attempt(() => storageRuntime?.close?.());
      if (firstError) throw firstError;
    })();
    return shutdownPromise;
  };

  try {
    storageRuntime = await runStartupStep(
      () => createStorageRuntimeImpl({
        config,
        store: suppliedStore,
        mediaStore: suppliedMediaStore,
        poolFactory,
        azureCredential,
        gcsStorage,
      }),
      startupTimeoutMs,
      { closeLateResult: (runtime) => runtime?.close?.() },
    );
    const { store, mediaStore } = storageRuntime;
    if (config.nodeEnv === 'production') {
      if (typeof store?.acquireInstanceLock !== 'function') throw productionNotReady();
      instanceLock = await runStartupStep(
        () => store.acquireInstanceLock({
          name: productionInstanceLockName,
          onLost: handleInstanceLockLost,
        }),
        startupTimeoutMs,
        { closeLateResult: (lock) => (lock?.owned === true ? lock.release?.() : undefined) },
      );
      if (instanceLock?.owned !== true
        || typeof instanceLock?.isOwned !== 'function'
        || instanceLock.isOwned() !== true) throw productionNotReady();
      runtimeState.instanceLockOwned = true;
    }
    const spoolRecovery = await runStartupStep(
      () => recoverStaleVoiceIngressSpools({
        parentDirectory: spoolParentDirectory,
        now,
        limit: spoolRecoveryLimit,
        staleAfterMs: spoolStaleAfterMs,
      }),
      startupTimeoutMs,
    );
    const corpus = suppliedCorpus ?? await runStartupStep(
      () => loadDefaultCorpus(),
      startupTimeoutMs,
    );
    const retriever = createRetriever({ corpus, now });
    const usesGoogleProvider = config.llm.provider === 'vertex-ai'
      || config.asr.provider === 'google-stt-v2'
      || config.tts.provider === 'google-tts';
    const googleAuthProvider = usesGoogleProvider
      ? suppliedGoogleAuthProvider ?? createGoogleAuthProviderImpl()
      : null;
    const llmProvider = suppliedLlmProvider
      ?? createLlmProvider({
        config: config.llm,
        totalDeadlineMs: config.llm.timeoutMs,
        googleAuthProvider,
      });
    const asrProvider = suppliedAsrProvider
      ?? (config.asr.available ? createAsrProvider({ config: config.asr, googleAuthProvider }) : null);
    const ttsProvider = suppliedTtsProvider
      ?? (config.tts.available ? createTtsProvider({ config: config.tts, googleAuthProvider }) : null);
    const answerService = createAnswerService({ corpus, retriever, llmProvider, now });
    eventHub = suppliedEventHub ?? new EventHub();
    cleanupService = suppliedCleanupService ?? createMediaCleanupService({ store, mediaStore, now });
    voiceService = suppliedVoiceService ?? createVoiceService({
      config, store, mediaStore, asrProvider, ttsProvider, cleanupService,
      eventHub, now, spoolParentDirectory, acceptanceTimingRecorder,
    });
    const turnProcessor = createTurnProcessor({
      store,
      answerService,
      voiceService,
      voiceOutputGate: () => assertVoiceOutputCapability(config, now()),
      eventHub,
      acceptanceTimingRecorder,
      now,
    });
    dispatcher = createDispatcher({
      store,
      processTurn: turnProcessor.processTurn,
      now,
      ...dispatcherOptions,
    });

    if (config.retentionWorkerEnabled) {
      retentionWorker = suppliedRetentionWorker ?? startRetentionWorkerImpl({
        store,
        mediaCleanup: cleanupService,
        now,
        ...retentionOptions,
      });
    }
    config.knowledgeSnapshotDate = corpus.snapshotAt?.slice(0, 10) ?? null;
    const checks = createRuntimeReadinessChecks({
      config,
      store,
      mediaStore,
      corpus,
      retentionWorker,
      dispatcher,
      instanceLock,
      runtimeState,
    });
    readinessChecks = checks;
    const readiness = async () => cachedReadiness;

    if (config.nodeEnv === 'production') {
      const firstRetention = await runStartupStep(
        () => retentionWorker?.firstRun,
        startupTimeoutMs,
      );
      if (firstRetention?.ok !== true) throw productionNotReady();
      try {
        await runStartupStep(() => dispatcher.probe(), startupTimeoutMs);
      } catch {
        throw productionNotReady();
      }
      dispatcher.start({ paused: true });
      if (!instanceLockIsOwned()) throw productionNotReady();
      runtimeState.recoverable = true;
      const startupReadiness = await runStartupStep(
        () => runLiveReadiness({ applyState: false }),
        startupTimeoutMs,
        { onTimeout: () => liveReadinessController?.abort() },
      );
      if (!productionReadinessIsReady(startupReadiness)) {
        throw productionNotReady();
      }
      if (!instanceLockIsOwned()) throw productionNotReady();
    } else {
      dispatcher.start();
      runtimeState.accepting = true;
      config.productionReady = false;
      updatePublicStatus(config, now);
    }

    const app = createAppImpl({
      config,
      store,
      mediaStore,
      answerService,
      eventHub,
      dispatcher,
      asrProvider,
      ttsProvider,
      cleanupService,
      voiceService,
      spoolParentDirectory,
      readiness,
      runtimeState,
      acceptanceTimingRecorder,
      now,
    });
    server = host ? app.listen(port, host) : app.listen(port);
    const closePendingServer = () => {
      try { server?.close?.(() => undefined); } catch { /* preserve the startup result */ }
    };
    await runStartupStep(
      () => new Promise((resolve, reject) => {
        const listening = () => {
          server.off?.('error', failed);
          resolve();
        };
        const failed = (error) => {
          server.off?.('listening', listening);
          reject(error);
        };
        server.once('listening', listening);
        server.once('error', failed);
      }),
      startupTimeoutMs,
      { onTimeout: closePendingServer, closeLateResult: closePendingServer },
    );
    if (!instanceLockIsOwned()) throw productionNotReady();
    cleanupService.start();
    if (config.nodeEnv === 'production') {
      applyReadinessState(cachedReadiness);
      if (await dispatcher.kick() !== true) throw productionNotReady();
      startWatchdog();
    }
    voiceRecovery = startVoiceRecovery();

    server.shutdown = stopRuntime;
    server.runtime = {
      config,
      store,
      mediaStore,
      dispatcher,
      eventHub,
      asrProvider,
      ttsProvider,
      cleanupService,
      voiceService,
      get voiceRecovery() { return voiceRecovery; },
      retentionWorker,
      readiness,
      runtimeState,
      spoolRecovery,
      shutdown: stopRuntime,
    };
    return server;
  } catch (error) {
    await stopRuntime({ cleanupTimeoutMs: startupTimeoutMs }).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:${process.argv[1]}`).href) {
  try {
    const server = await startServer({ dispatcherOptions: { unrefPollTimer: false } });
    installProcessShutdown({ server });
  } catch {
    process.stderr.write('Production V1 failed to start. Check safe configuration and dependency health.\n');
    process.exitCode = 1;
  }
}
