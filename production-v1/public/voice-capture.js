import { normalizeAudioBlobToCanonicalWav } from './audio-normalize.js';

export const CAPTURE_MIME_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/wav',
]);

export const VOICE_CAPTURE_MAX_MS = 55_000;

export function detectNativeWavPlugin(capacitor = globalThis.Capacitor) {
  if (!capacitor?.isNativePlatform?.() || !capacitor.Plugins?.NativeWav) return null;
  return capacitor.Plugins.NativeWav;
}

const CANCEL_REASONS = new Set([
  'cancel', 'dispose', 'escape', 'finish-before-start', 'hidden', 'lostpointercapture',
  'pagehide', 'pointercancel', 'visible-cancel',
]);

export class VoiceCaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VoiceCaptureError';
    this.code = code;
    this.textSafe = true;
  }
}

function captureError(code) {
  return new VoiceCaptureError(code);
}

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve, settled: false };
}

function settleDeferred(target, value) {
  if (target.settled) return;
  target.settled = true;
  target.resolve(value);
}

function tracksFrom(stream) {
  try {
    const tracks = stream?.getTracks?.();
    return Array.isArray(tracks) ? tracks : Array.from(tracks ?? []);
  } catch {
    return [];
  }
}

function stopLooseStream(stream) {
  for (const track of tracksFrom(stream)) {
    try { track?.stop?.(); } catch { /* best-effort privacy cleanup */ }
  }
}

export function selectRecordingMimeType(MediaRecorderClass) {
  if (typeof MediaRecorderClass !== 'function'
    || typeof MediaRecorderClass.isTypeSupported !== 'function') return null;
  for (const mimeType of CAPTURE_MIME_TYPES) {
    try {
      if (MediaRecorderClass.isTypeSupported(mimeType)) return mimeType;
    } catch {
      return null;
    }
  }
  return null;
}

function safeClock(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : 0;
}

function safeCancelReason(reason) {
  return CANCEL_REASONS.has(reason) ? reason : 'cancel';
}

function safeCompletionReason(reason) {
  return reason === 'max-duration' ? 'max-duration' : 'release';
}

function errorOutcome(code) {
  return { status: 'error', error: { code, textSafe: true } };
}

export function createVoiceCapture({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderClass = globalThis.MediaRecorder,
  normalizer = normalizeAudioBlobToCanonicalWav,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
  maxDurationMs = VOICE_CAPTURE_MAX_MS,
} = {}) {
  const captureConstraints = Object.freeze({
    audio: Object.freeze({
      autoGainControl: false,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      sampleRate: 16_000,
    }),
  });
  let disposed = false;
  let permissionReady = false;
  let permissionEpoch = 0;
  let permissionAttempt = null;
  let interactionEpoch = 0;
  let active = null;

  function runtimeMimeType() {
    if (typeof mediaDevices?.getUserMedia !== 'function'
      || typeof normalizer !== 'function'
      || typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function') return null;
    return selectRecordingMimeType(MediaRecorderClass);
  }

  function isCurrent(interaction) {
    return active === interaction && !interaction.terminal && !disposed;
  }

  function removeListeners(interaction, predicate = () => true) {
    const retained = [];
    for (const entry of interaction.listeners) {
      if (!predicate(entry)) {
        retained.push(entry);
        continue;
      }
      try { entry.target.removeEventListener?.(entry.type, entry.listener); } catch { /* noop */ }
    }
    interaction.listeners = retained;
  }

  function listen(interaction, target, type, listener, kind) {
    target?.addEventListener?.(type, listener);
    interaction.listeners.push({ target, type, listener, kind });
  }

  function clearTimer(interaction) {
    if (interaction.timerId === null) return;
    clearTimeoutImpl(interaction.timerId);
    interaction.timerId = null;
  }

  function stopTracks(interaction) {
    for (const track of tracksFrom(interaction.stream)) {
      if (interaction.stoppedTracks.has(track)) continue;
      interaction.stoppedTracks.add(track);
      try { track?.stop?.(); } catch { /* best-effort privacy cleanup */ }
    }
  }

  function stopRecorder(interaction) {
    if (!interaction.recorder || interaction.recorderStopRequested) return;
    interaction.recorderStopRequested = true;
    if (interaction.recorder.state === 'inactive') return;
    interaction.recorder.stop();
  }

  function settle(interaction, outcome) {
    if (interaction.terminal) return interaction.result.promise;
    interaction.terminal = true;
    clearTimer(interaction);
    removeListeners(interaction);
    interaction.chunks.length = 0;
    try { stopRecorder(interaction); } catch { /* terminal outcome remains authoritative */ }
    stopTracks(interaction);
    if (active === interaction) active = null;
    if (!interaction.started.settled) settleDeferred(interaction.started, outcome);
    settleDeferred(interaction.result, outcome);
    return interaction.result.promise;
  }

  function fail(interaction, code) {
    return settle(interaction, errorOutcome(code));
  }

  function scheduleAutoFinish(interaction) {
    const tick = () => {
      interaction.timerId = null;
      if (!isCurrent(interaction) || !['starting', 'recording'].includes(interaction.phase)) return;
      const elapsed = Math.max(0, safeClock(now) - interaction.startedAt);
      const remaining = maxDurationMs - elapsed;
      if (remaining > 0) {
        interaction.timerId = setTimeoutImpl(tick, remaining);
        return;
      }
      void finish('max-duration');
    };
    interaction.timerId = setTimeoutImpl(tick, maxDurationMs);
  }

  async function normalizeStoppedRecording(interaction) {
    if (!isCurrent(interaction) || interaction.phase !== 'stopping') return;
    interaction.phase = 'normalizing';
    clearTimer(interaction);
    removeListeners(interaction);
    stopTracks(interaction);
    const chunks = interaction.chunks.splice(0);
    const rawBlob = new Blob(chunks, { type: interaction.mimeType });
    if (rawBlob.size < 1) {
      fail(interaction, 'VOICE_EMPTY_RECORDING');
      return;
    }

    let canonical;
    try {
      canonical = await normalizer(rawBlob);
    } catch {
      if (isCurrent(interaction)) fail(interaction, 'VOICE_NORMALIZATION_FAILED');
      return;
    }
    if (!isCurrent(interaction)) return;
    if (!canonical || canonical === rawBlob || canonical.type !== 'audio/wav'
      || !Number.isFinite(canonical.size) || canonical.size <= 44) {
      fail(interaction, 'VOICE_NORMALIZATION_FAILED');
      return;
    }
    settle(interaction, {
      status: 'ready',
      audio: canonical,
      mimeType: 'audio/wav',
      durationMs: interaction.durationMs,
      completionReason: interaction.completionReason,
    });
  }

  function attachRuntime(interaction, stream) {
    interaction.stream = stream;
    const tracks = tracksFrom(stream);
    if (tracks.length < 1) {
      fail(interaction, 'VOICE_STREAM_INVALID');
      return;
    }

    let recorder;
    try {
      recorder = new MediaRecorderClass(stream, { mimeType: interaction.mimeType });
    } catch {
      fail(interaction, 'VOICE_RECORDER_FAILED');
      return;
    }
    interaction.recorder = recorder;
    interaction.phase = 'starting';

    for (const track of tracks) {
      listen(interaction, track, 'ended', () => {
        if (isCurrent(interaction)) fail(interaction, 'VOICE_TRACK_ENDED');
      }, 'track');
    }
    listen(interaction, recorder, 'start', () => {
      if (!isCurrent(interaction) || interaction.phase !== 'starting') return;
      interaction.phase = 'recording';
      settleDeferred(interaction.started, { status: 'recording', mimeType: interaction.mimeType });
    }, 'recorder');
    listen(interaction, recorder, 'dataavailable', (event) => {
      if (!isCurrent(interaction) || !['recording', 'stopping'].includes(interaction.phase)) return;
      if (event?.data && Number(event.data.size) > 0) interaction.chunks.push(event.data);
    }, 'recorder');
    listen(interaction, recorder, 'stop', () => {
      if (!isCurrent(interaction)) return;
      if (interaction.phase !== 'stopping') {
        fail(interaction, 'VOICE_RECORDER_STOPPED');
        return;
      }
      void normalizeStoppedRecording(interaction);
    }, 'recorder');
    listen(interaction, recorder, 'error', () => {
      if (isCurrent(interaction)) fail(interaction, 'VOICE_RECORDER_FAILED');
    }, 'recorder');

    try {
      recorder.start();
      if (isCurrent(interaction)) {
        interaction.startedAt = safeClock(now);
        scheduleAutoFinish(interaction);
      }
    } catch {
      fail(interaction, 'VOICE_RECORDER_FAILED');
    }
  }

  async function acquireRuntime(interaction) {
    let stream;
    try {
      stream = await mediaDevices.getUserMedia(captureConstraints);
    } catch {
      if (isCurrent(interaction)) fail(interaction, 'VOICE_PERMISSION_DENIED');
      return;
    }
    if (!isCurrent(interaction) || interaction.phase !== 'acquiring') {
      stopLooseStream(stream);
      return;
    }
    attachRuntime(interaction, stream);
  }

  function cancelPermissionAttempt(reason) {
    const attempt = permissionAttempt;
    if (!attempt) return { status: 'idle' };
    permissionAttempt = null;
    permissionReady = false;
    permissionEpoch += 1;
    settleDeferred(attempt.cancelled, reason);
    return { status: 'cancelled', reason };
  }

  async function preflightPermission({ consent = false } = {}) {
    if (disposed) throw captureError('VOICE_CAPTURE_DISPOSED');
    if (consent !== true) throw captureError('VOICE_CONSENT_REQUIRED');
    if (permissionAttempt || active) throw captureError('VOICE_CAPTURE_BUSY');
    const mimeType = runtimeMimeType();
    if (!mimeType) throw captureError('VOICE_CAPTURE_UNSUPPORTED');
    const epoch = ++permissionEpoch;
    const attempt = { epoch, cancelled: deferred() };
    permissionAttempt = attempt;
    permissionReady = false;
    let request;
    try {
      request = Promise.resolve(mediaDevices.getUserMedia(captureConstraints));
    } catch (error) {
      request = Promise.reject(error);
    }
    const outcome = await Promise.race([
      request.then(
        (stream) => ({ kind: 'stream', stream }),
        () => ({ kind: 'error' }),
      ),
      attempt.cancelled.promise.then(() => ({ kind: 'cancelled' })),
    ]);
    if (outcome.kind === 'cancelled') {
      void request.then(stopLooseStream, () => undefined);
      throw captureError('VOICE_CAPTURE_CANCELLED');
    }
    if (outcome.kind === 'error') {
      if (permissionAttempt === attempt) permissionAttempt = null;
      if (disposed || epoch !== permissionEpoch) throw captureError('VOICE_CAPTURE_CANCELLED');
      throw captureError('VOICE_PERMISSION_DENIED');
    }
    stopLooseStream(outcome.stream);
    if (permissionAttempt !== attempt || disposed || epoch !== permissionEpoch) {
      throw captureError('VOICE_CAPTURE_CANCELLED');
    }
    permissionAttempt = null;
    permissionReady = true;
    return { status: 'ready', mimeType };
  }

  function begin() {
    if (disposed) throw captureError('VOICE_CAPTURE_DISPOSED');
    if (permissionAttempt) throw captureError('VOICE_CAPTURE_BUSY');
    if (!permissionReady) throw captureError('VOICE_PERMISSION_REQUIRED');
    if (active) throw captureError('VOICE_CAPTURE_BUSY');
    const mimeType = runtimeMimeType();
    if (!mimeType) throw captureError('VOICE_CAPTURE_UNSUPPORTED');
    const interaction = {
      id: ++interactionEpoch,
      mimeType,
      phase: 'acquiring',
      terminal: false,
      stream: null,
      recorder: null,
      recorderStopRequested: false,
      stoppedTracks: new Set(),
      chunks: [],
      listeners: [],
      timerId: null,
      startedAt: null,
      durationMs: 0,
      completionReason: 'release',
      started: deferred(),
      result: deferred(),
    };
    active = interaction;
    void acquireRuntime(interaction);
    return Object.freeze({ started: interaction.started.promise, result: interaction.result.promise });
  }

  function finish(reason = 'release') {
    const interaction = active;
    if (!interaction) {
      if (!permissionAttempt) return Promise.resolve({ status: 'idle' });
      return Promise.resolve(cancelPermissionAttempt('finish-before-start'));
    }
    if (interaction.phase === 'acquiring'
      || (interaction.phase === 'starting' && reason !== 'max-duration')) {
      return settle(interaction, { status: 'cancelled', reason: 'finish-before-start' });
    }
    if (['stopping', 'normalizing'].includes(interaction.phase)) return interaction.result.promise;
    if (!['starting', 'recording'].includes(interaction.phase)) return interaction.result.promise;

    interaction.phase = 'stopping';
    interaction.completionReason = safeCompletionReason(reason);
    interaction.durationMs = Math.min(
      maxDurationMs,
      Math.max(0, Math.round(safeClock(now) - interaction.startedAt)),
    );
    clearTimer(interaction);
    removeListeners(interaction, (entry) => entry.kind === 'track');
    try {
      stopRecorder(interaction);
    } catch {
      fail(interaction, 'VOICE_RECORDER_FAILED');
      return interaction.result.promise;
    }
    stopTracks(interaction);
    return interaction.result.promise;
  }

  function cancel(reason = 'cancel') {
    const interaction = active;
    if (!interaction) {
      if (!permissionAttempt) return Promise.resolve({ status: 'idle' });
      return Promise.resolve(cancelPermissionAttempt(safeCancelReason(reason)));
    }
    if (reason === 'lostpointercapture' && ['stopping', 'normalizing'].includes(interaction.phase)) {
      return interaction.result.promise;
    }
    return settle(interaction, { status: 'cancelled', reason: safeCancelReason(reason) });
  }

  function dispose() {
    if (disposed) return Promise.resolve({ status: 'idle' });
    disposed = true;
    permissionReady = false;
    if (permissionAttempt) return Promise.resolve(cancelPermissionAttempt('dispose'));
    permissionEpoch += 1;
    return cancel('dispose');
  }

  return Object.freeze({
    preflightPermission,
    begin,
    finish,
    cancel,
    dispose,
    getState: () => ({
      disposed,
      permission: permissionReady ? 'ready' : 'unknown',
      phase: active?.phase ?? (permissionAttempt ? 'permission' : 'idle'),
    }),
  });
}
