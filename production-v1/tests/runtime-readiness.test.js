import assert from 'node:assert/strict';
import test from 'node:test';

import { createDispatcher } from '../src/services/dispatcher.js';
import { createRuntimeReadinessChecks } from '../src/services/runtime-readiness.js';

function runtimeFixture(overrides = {}) {
  return {
    config: {
      nodeEnv: 'production',
      productionConfigurationReady: true,
      storeDriver: 'postgres',
      mediaDriver: 'gcs',
    },
    store: { healthCheck: async () => ({ ok: true, driver: 'postgres' }) },
    mediaStore: { healthCheck: async () => ({ ok: true, driver: 'gcs', private: true }) },
    corpus: { schemaVersion: 'hkbu-campus-v1', snapshotAt: '2026-08-25T12:00:00+08:00', sources: [{}] },
    retentionWorker: {
      readiness: async () => ({
        name: 'retention', status: 'ready', healthy: true, policyVersion: 'retention-v1',
      }),
    },
    dispatcher: { readiness: () => ({ name: 'dispatcher', status: 'ready', healthy: true, version: 'dispatcher-v1' }) },
    instanceLock: {
      isOwned: () => true,
      healthCheck: async () => ({ owned: true }),
    },
    runtimeState: { accepting: true, instancePolicy: 'single', instanceLockOwned: true },
    ...overrides,
  };
}

test('runtime readiness adapters prove the six production boundaries with safe versions only', async () => {
  const checks = createRuntimeReadinessChecks(runtimeFixture());
  assert.deepEqual(Object.keys(checks), [
    'database', 'media', 'corpus', 'retention', 'dispatcher', 'runtime',
  ]);
  assert.deepEqual(await checks.database(), {
    name: 'database', status: 'ready', healthy: true, version: 'postgres-v1',
  });
  assert.deepEqual(await checks.media(), {
    name: 'media', status: 'ready', healthy: true, version: 'gcs-v1',
  });
  assert.deepEqual(await checks.corpus(), {
    name: 'corpus', status: 'ready', healthy: true, version: 'hkbu-campus-v1',
  });
  assert.deepEqual(await checks.retention(), {
    name: 'retention', status: 'ready', healthy: true, policyVersion: 'retention-v1',
  });
  assert.deepEqual(await checks.dispatcher(), {
    name: 'dispatcher', status: 'ready', healthy: true, version: 'dispatcher-v1',
  });
  assert.deepEqual(await checks.runtime(), {
    name: 'runtime', status: 'ready', healthy: true, version: 'single-instance-v1',
  });
});

test('runtime readiness checks fail closed for wrong drivers, public media, stale workers, and nonaccepting runtime', async () => {
  const checks = createRuntimeReadinessChecks(runtimeFixture({
    store: { healthCheck: async () => ({ ok: true, driver: 'atomic-file', privateUrl: 'private' }) },
    mediaStore: { healthCheck: async () => ({ ok: true, driver: 'gcs', private: false }) },
    corpus: { schemaVersion: 'hkbu-campus-v1', snapshotAt: 'invalid', sources: [] },
    retentionWorker: { readiness: async () => ({ status: 'stale', healthy: false, privateError: 'secret' }) },
    dispatcher: { readiness: () => ({ status: 'stopped', healthy: false, privateError: 'secret' }) },
    runtimeState: { accepting: false, instancePolicy: 'multiple', instanceLockOwned: false },
  }));

  for (const name of Object.keys(checks)) {
    const result = await checks[name]();
    assert.equal(result.status, 'not-ready', name);
    assert.equal(result.healthy, false, name);
    assert.equal(JSON.stringify(result).includes('secret'), false, name);
    assert.equal(JSON.stringify(result).includes('private'), false, name);
  }
});

test('missing or throwing runtime dependencies produce safe not-ready checks', async () => {
  const checks = createRuntimeReadinessChecks(runtimeFixture({
    store: { healthCheck: async () => { throw new Error('postgres://private'); } },
    mediaStore: null,
    retentionWorker: null,
    dispatcher: null,
  }));

  for (const name of ['database', 'media', 'retention', 'dispatcher']) {
    const result = await checks[name]();
    assert.equal(result.status, 'not-ready');
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('runtime readiness forwards one cancellation signal to database, GCS, retention, and dispatcher probes', async () => {
  const controller = new AbortController();
  const observed = [];
  const checks = createRuntimeReadinessChecks(runtimeFixture({
    store: {
      healthCheck: async ({ signal } = {}) => {
        observed.push(['database', signal]);
        return { ok: true, driver: 'postgres' };
      },
    },
    mediaStore: {
      healthCheck: async ({ signal } = {}) => {
        observed.push(['media', signal]);
        return { ok: true, driver: 'gcs', private: true };
      },
    },
    retentionWorker: {
      readiness: async ({ signal } = {}) => {
        observed.push(['retention', signal]);
        return { status: 'ready', healthy: true, policyVersion: 'retention-v1' };
      },
    },
    dispatcher: {
      probe: async ({ signal } = {}) => {
        observed.push(['dispatcher', signal]);
        return true;
      },
      readiness: () => ({ status: 'ready', healthy: true, version: 'dispatcher-v1' }),
    },
    instanceLock: {
      isOwned: () => true,
      healthCheck: async ({ signal } = {}) => {
        observed.push(['instance-lock', signal]);
        return { owned: true };
      },
    },
  }));

  for (const name of ['database', 'media', 'retention', 'dispatcher', 'runtime']) {
    assert.equal((await checks[name]({ signal: controller.signal })).healthy, true, name);
  }
  assert.deepEqual(observed.map(([name]) => name), [
    'database', 'media', 'retention', 'dispatcher', 'instance-lock',
  ]);
  for (const [, signal] of observed) assert.equal(signal, controller.signal);
});

test('runtime readiness probes the dedicated singleton session and rejects dynamic lock loss', async () => {
  let owned = true;
  let probes = 0;
  const checks = createRuntimeReadinessChecks(runtimeFixture({
    instanceLock: {
      isOwned: () => owned,
      healthCheck: async () => {
        probes += 1;
        return { owned };
      },
    },
  }));

  assert.equal((await checks.runtime()).healthy, true);
  owned = false;
  const lost = await checks.runtime({ allowPausedRuntime: true });
  assert.deepEqual(lost, { name: 'runtime', status: 'not-ready', healthy: false });
  assert.equal(probes, 2);
});

test('dispatcher readiness requires a successful non-consuming probe and recovers after poll failure', async () => {
  let failNextPoll = false;
  const dispatcher = createDispatcher({
    store: {
      dispatcherHealthCheck: async () => ({ ok: true, driver: 'postgres', capability: 'turn-claim' }),
      claimNextTurn: async () => {
        if (failNextPoll) {
          failNextPoll = false;
          throw new Error('private database poll failure');
        }
        return null;
      },
      renewTurnLease: async () => true,
    },
    processTurn: async () => undefined,
    pollIntervalMs: 60_000,
  });
  assert.deepEqual(dispatcher.readiness(), {
    name: 'dispatcher', status: 'not-ready', healthy: false, version: 'dispatcher-v1',
  });
  dispatcher.start({ paused: true });
  assert.deepEqual(dispatcher.readiness(), {
    name: 'dispatcher', status: 'not-ready', healthy: false, version: 'dispatcher-v1',
  });
  await dispatcher.probe();
  assert.deepEqual(dispatcher.readiness(), {
    name: 'dispatcher', status: 'ready', healthy: true, version: 'dispatcher-v1',
  });
  dispatcher.resume();
  failNextPoll = true;
  await assert.rejects(dispatcher.runOnce(), /private database poll failure/);
  assert.deepEqual(dispatcher.readiness(), {
    name: 'dispatcher', status: 'not-ready', healthy: false, version: 'dispatcher-v1',
  });
  assert.equal(await dispatcher.runOnce(), false);
  assert.deepEqual(dispatcher.readiness(), {
    name: 'dispatcher', status: 'ready', healthy: true, version: 'dispatcher-v1',
  });
  await dispatcher.stop();
  assert.deepEqual(dispatcher.readiness(), {
    name: 'dispatcher', status: 'not-ready', healthy: false, version: 'dispatcher-v1',
  });
});

test('dispatcher pause is recoverable and fences polling until resume', async () => {
  let claims = 0;
  const dispatcher = createDispatcher({
    store: {
      dispatcherHealthCheck: async () => ({ ok: true, driver: 'postgres', capability: 'turn-claim' }),
      claimNextTurn: async () => { claims += 1; return null; },
      renewTurnLease: async () => true,
    },
    processTurn: async () => undefined,
    pollIntervalMs: 60_000,
  });
  dispatcher.start({ paused: true });
  dispatcher.resume();
  await new Promise((resolve) => setImmediate(resolve));
  const beforePause = claims;

  dispatcher.pause();
  dispatcher.wake();
  assert.equal(await dispatcher.runOnce(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, beforePause);

  dispatcher.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(claims > beforePause, true);
  await dispatcher.stop();
});

test('dispatcher keeps its poll timer referenced for an always-on production worker', async () => {
  const scheduled = [];
  const cleared = [];
  const dispatcher = createDispatcher({
    store: {
      dispatcherHealthCheck: async () => ({ ok: true, driver: 'postgres', capability: 'turn-claim' }),
      claimNextTurn: async () => null,
      renewTurnLease: async () => true,
    },
    processTurn: async () => undefined,
    pollIntervalMs: 60_000,
    unrefPollTimer: false,
    setTimeoutFn(callback, delay) {
      const handle = {
        callback,
        delay,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) { cleared.push(handle); },
  });

  dispatcher.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 0);
  assert.equal(scheduled[0].unrefCalled, false,
    'the durable worker timer must keep the Node process lifecycle referenced');

  await dispatcher.stop();
  assert.deepEqual(cleared, [scheduled[0]]);
});
