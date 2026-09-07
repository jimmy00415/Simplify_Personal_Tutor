import { randomUUID } from 'node:crypto';

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('dispatcher clock returned an invalid instant');
  return date;
}

export const dispatcherLimits = Object.freeze({ concurrency: 4 });

export function createDispatcher({
  store,
  processTurn,
  workerId = `worker-${randomUUID()}`,
  now = () => new Date(),
  pollIntervalMs = 250,
  leaseDurationMs = 15_000,
  renewalIntervalMs = 5_000,
  concurrency = dispatcherLimits.concurrency,
  pollStaleAfterMs = Math.max(pollIntervalMs * 4, 5_000),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  unrefPollTimer = true,
} = {}) {
  if (!store || typeof processTurn !== 'function') throw new Error('dispatcher dependencies are required');
  if (renewalIntervalMs >= leaseDurationMs) throw new Error('renewal interval must be shorter than lease duration');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('dispatcher concurrency must be between 1 and 16');
  if (!Number.isInteger(pollStaleAfterMs) || pollStaleAfterMs <= 0) {
    throw new Error('dispatcher poll staleness must be a positive integer');
  }
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new Error('dispatcher timer dependencies are required');
  }
  if (typeof unrefPollTimer !== 'boolean') throw new Error('dispatcher timer policy is invalid');
  let started = false;
  let stopped = false;
  let paused = false;
  let timer = null;
  let pumpPromise = null;
  let stopPromise = null;
  const activeJobs = new Set();
  const activeControllers = new Set();
  const activeRenewals = new Set();
  let lastPollSucceededAt = null;
  let lastPollOutcome = null;

  function observePoll(outcome) {
    lastPollOutcome = outcome;
    try { lastPollSucceededAt = outcome === 'success' ? asDate(now()) : lastPollSucceededAt; } catch {
      if (outcome === 'success') lastPollSucceededAt = null;
      lastPollOutcome = 'failure';
    }
  }

  async function executeClaim(turn, leaseToken, controller) {
    let renewalPromise = null;
    const renewal = setInterval(() => {
      if (renewalPromise || controller.signal.aborted) return;
      const renewedAt = asDate(now());
      const tracked = store.renewTurnLease({
        turnId: turn.id,
        leaseToken,
        now: renewedAt,
        leaseUntil: new Date(renewedAt.getTime() + leaseDurationMs),
      }).catch(() => controller.abort());
      renewalPromise = tracked;
      activeRenewals.add(tracked);
      void tracked.finally(() => {
        activeRenewals.delete(tracked);
        if (renewalPromise === tracked) renewalPromise = null;
      });
    }, renewalIntervalMs);
    renewal.unref?.();
    try {
      await processTurn({ turn, leaseToken, signal: controller.signal, workerId });
    } finally {
      clearInterval(renewal);
      controller.abort();
      await renewalPromise?.catch(() => undefined);
      activeControllers.delete(controller);
    }
  }

  function launch(turn, leaseToken) {
    const controller = new AbortController();
    activeControllers.add(controller);
    if (stopped) controller.abort();
    const job = executeClaim(turn, leaseToken, controller).catch(() => undefined);
    activeJobs.add(job);
    void job.finally(() => {
      activeJobs.delete(job);
      if (started && !stopped) schedule(0);
    });
    return job;
  }

  async function claimAndLaunch() {
    if (stopped || paused) return null;
    const claimedAt = asDate(now());
    const leaseToken = randomUUID();
    let turn;
    try {
      turn = await store.claimNextTurn({
        workerId,
        leaseToken,
        now: claimedAt,
        leaseUntil: new Date(claimedAt.getTime() + leaseDurationMs),
      });
      observePoll('success');
    } catch (error) {
      observePoll('failure');
      throw error;
    }
    if (stopped || paused) return null;
    if (!turn) return null;
    return { job: launch(turn, leaseToken) };
  }

  async function probe({ signal } = {}) {
    if (stopped || typeof store.dispatcherHealthCheck !== 'function') {
      observePoll('failure');
      throw Object.assign(new Error('Dispatcher health check is unavailable'), { code: 'DISPATCHER_NOT_READY' });
    }
    try {
      if (signal?.aborted) throw Object.assign(new Error('Dispatcher health check was aborted'), { code: 'DISPATCHER_NOT_READY' });
      const health = await store.dispatcherHealthCheck({ signal });
      if (signal?.aborted) throw Object.assign(new Error('Dispatcher health check was aborted'), { code: 'DISPATCHER_NOT_READY' });
      if (health?.ok !== true || health?.driver !== 'postgres' || health?.capability !== 'turn-claim') {
        throw Object.assign(new Error('Dispatcher health check failed'), { code: 'DISPATCHER_NOT_READY' });
      }
      observePoll('success');
      return true;
    } catch (error) {
      observePoll('failure');
      throw error;
    }
  }

  async function runOnce() {
    const claimed = await claimAndLaunch();
    if (!claimed) return false;
    await claimed.job;
    return true;
  }

  function schedule(delay = pollIntervalMs) {
    if (!started || stopped || paused || timer) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void pump();
    }, delay);
    if (unrefPollTimer) timer?.unref?.();
  }

  async function pump() {
    if (pumpPromise) return pumpPromise;
    const work = (async () => {
      try {
        while (started && !stopped && !paused && activeJobs.size < concurrency) {
          const claimed = await claimAndLaunch();
          if (!claimed) break;
        }
      } catch {
        // Durable polling retries on the next interval; request/provider data is never logged here.
      }
    })();
    pumpPromise = work;
    try {
      await work;
    } finally {
      if (pumpPromise === work) pumpPromise = null;
      if (started && !stopped && !paused && activeJobs.size < concurrency) schedule();
    }
  }

  function start({ paused: initiallyPaused = false } = {}) {
    if (started || stopped) return;
    started = true;
    paused = initiallyPaused;
    if (!paused) schedule(0);
  }

  function resume() {
    if (!started || stopped || !paused) return;
    paused = false;
    schedule(0);
  }

  function pause() {
    if (!started || stopped || paused) return;
    paused = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  function wake() {
    if (!started || stopped || paused) return;
    if (timer) clearTimeoutFn(timer);
    timer = null;
    schedule(0);
  }

  async function kick() {
    if (!started || stopped || paused) return false;
    await pump();
    return lastPollOutcome === 'success';
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    started = false;
    paused = false;
    if (timer) clearTimeoutFn(timer);
    timer = null;
    for (const controller of activeControllers) controller.abort();
    stopPromise = (async () => {
      await pumpPromise?.catch(() => undefined);
      for (const controller of activeControllers) controller.abort();
      while (activeJobs.size > 0 || activeRenewals.size > 0) {
        await Promise.allSettled([...activeJobs, ...activeRenewals]);
      }
    })();
    return stopPromise;
  }

  function readiness(options = {}) {
    let fresh = false;
    try {
      const current = asDate(options.now ?? now());
      const age = lastPollSucceededAt ? current.getTime() - lastPollSucceededAt.getTime() : Infinity;
      fresh = age >= 0 && (age <= pollStaleAfterMs || activeJobs.size >= concurrency);
    } catch { /* fail closed */ }
    const healthy = started && !stopped && lastPollOutcome === 'success' && fresh;
    return {
      name: 'dispatcher',
      status: healthy ? 'ready' : 'not-ready',
      healthy,
      version: 'dispatcher-v1',
    };
  }

  return { workerId, runOnce, probe, start, pause, resume, wake, kick, stop, readiness };
}
