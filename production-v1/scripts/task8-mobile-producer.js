import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { CANDIDATE_PRIVACY_SCHEMA_VERSION } from './candidate-privacy-proof.js';
import { containsForbiddenPersistedSecret } from './persisted-secret-contract.js';
import { validateUniqueScreenshots } from './png-evidence.js';
import { validateCanonicalWav } from '../src/media/canonical-wav.js';

export const MOBILE_CHECK_IDS = Object.freeze([
  'first-visit', 'response-language-mode-change', 'text-send', 'editable-voice-transcript',
  'assistant-audio-ready-no-autoplay', 'verified-official-source',
  'unsupported-honest-handoff', 'retry-reload-retention', 'consent',
  'clear-conversation', 'keyboard-focus', 'bottom-safe-area', 'no-horizontal-overflow',
]);
export const MOBILE_SCREENSHOT_IDS = Object.freeze([
  'first-visit', 'text-source', 'voice-transcript', 'mobile-safe-area',
]);
export const MOBILE_BROWSER_CONTRACT = Object.freeze({
  engine: 'chromium',
  playwrightVersion: '1.62.1',
  revision: '1234',
  browserVersion: '151.0.7922.34',
  pinned: true,
  realIosSafari: false,
});
export const MOBILE_WAV_CONTRACT = Object.freeze({
  sha256: '92bb7f07a1d1f95bf037dd805f3d5d06fb837a72839698e2b5f10674f095cf33',
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  durationMs: 1_000,
  mimeType: 'audio/wav',
});
const FIXTURE_PATH = fileURLToPath(new URL('../tests/fixtures/mobile-voice-en.wav', import.meta.url));
const DIGEST = /^[0-9a-f]{64}$/;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_EVIDENCE_AGE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const browserOwnedFlows = new WeakSet();
const WATERMARK_AMPLITUDE = 256;
const WITNESS_WORLD = '__hkbuddy_browser_witness_v1';

function fail() {
  const error = new Error('Controlled mobile evidence is invalid');
  error.code = 'MOBILE_CONTROLLED_EVIDENCE_INVALID';
  throw error;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalSha256(value) {
  return sha256(JSON.stringify(canonical(value)));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  // Binary publication payloads are immutable by ownership, not by
  // Object.freeze(): Node rejects freezing non-empty typed-array views.
  if (ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function pcm16(buffer) {
  const view = new Int16Array((buffer.length - 44) / 2);
  for (let index = 0; index < view.length; index += 1) {
    view[index] = buffer.readInt16LE(44 + index * 2);
  }
  return view;
}

function watermarkSamples(seed, sampleCount) {
  const watermark = new Int16Array(sampleCount);
  const firstFrequency = 400 + (seed[0] % 48) * 20;
  let secondFrequency = 1_400 + (seed[1] % 48) * 20;
  if (secondFrequency === firstFrequency) secondFrequency += 20;
  const firstPhase = (seed.readUInt16BE(2) / 65_536) * 2 * Math.PI;
  const secondPhase = (seed.readUInt16BE(4) / 65_536) * 2 * Math.PI;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const seconds = sample / MOBILE_WAV_CONTRACT.sampleRate;
    watermark[sample] = Math.round(WATERMARK_AMPLITUDE * (
      Math.sin(2 * Math.PI * firstFrequency * seconds + firstPhase)
      + Math.sin(2 * Math.PI * secondFrequency * seconds + secondPhase)
    ));
  }
  return watermark;
}

export function deriveChallengeWav(baseValue, {
  seed = randomBytes(32), expectedBaseSha256 = MOBILE_WAV_CONTRACT.sha256,
} = {}) {
  try {
    const base = validateCanonicalWav(baseValue, { expectedSha256: expectedBaseSha256 });
    const secretSeed = Buffer.from(seed);
    if (secretSeed.length !== 32) fail();
    const bytes = Buffer.from(base.buffer);
    const samples = pcm16(bytes);
    const watermark = watermarkSamples(secretSeed, samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const watermarked = samples[index] + watermark[index];
      bytes.writeInt16LE(Math.max(-32_768, Math.min(32_767, watermarked)), 44 + index * 2);
    }
    validateCanonicalWav(bytes);
    return {
      bytes,
      commitmentSha256: sha256(secretSeed),
      seed: secretSeed,
      watermark,
    };
  } catch (error) {
    if (error?.code === 'MOBILE_CONTROLLED_EVIDENCE_INVALID') throw error;
    fail();
  }
}

function cosine(left, right, offset, stride = 1) {
  let dot = 0;
  let leftSq = 0;
  let rightSq = 0;
  let count = 0;
  const leftStart = Math.max(0, -offset);
  const rightStart = Math.max(0, offset);
  const length = Math.min(left.length - leftStart, right.length - rightStart);
  for (let index = 0; index < length; index += stride) {
    const a = left[leftStart + index];
    const b = right[rightStart + index];
    dot += a * b;
    leftSq += a * a;
    rightSq += b * b;
    count += 1;
  }
  return {
    count,
    value: leftSq > 0 && rightSq > 0 ? dot / Math.sqrt(leftSq * rightSq) : 0,
  };
}

export function verifyChallengeBoundUpload(uploadValue, {
  baseValue,
  challenge,
  onMetrics,
  expectedBaseSha256 = MOBILE_WAV_CONTRACT.sha256,
} = {}) {
  try {
    const upload = validateCanonicalWav(uploadValue);
    const base = validateCanonicalWav(baseValue, { expectedSha256: expectedBaseSha256 });
    if (!challenge || !Buffer.isBuffer(challenge.bytes) || !Buffer.isBuffer(challenge.seed)
      || challenge.seed.length !== 32 || upload.sha256 === base.sha256) fail();
    const uploadedSamples = pcm16(upload.buffer);
    const baseSamples = pcm16(base.buffer);
    const challengeSamples = pcm16(challenge.bytes);
    let best = { offset: 0, value: -1, count: 0 };
    for (let offset = -1_600; offset <= 1_600; offset += 1) {
      const candidate = cosine(challengeSamples, uploadedSamples, offset, 1);
      if (candidate.value > best.value) best = { offset, ...candidate };
    }
    // The base is periodic; its strongest peak alone can select a different
    // cycle and destroy an otherwise valid one-time watermark comparison.
    best = { ...best, ...cosine(baseSamples, uploadedSamples, best.offset, 4) };
    const baseStart = Math.max(0, -best.offset);
    const uploadStart = Math.max(0, best.offset);
    const comparedSamples = Math.min(
      baseSamples.length - baseStart,
      uploadedSamples.length - uploadStart,
      challenge.watermark.length - baseStart,
    );
    if (comparedSamples < 12_000) fail();
    let signalDot = 0;
    let baseSq = 0;
    for (let index = 0; index < comparedSamples; index += 1) {
      const baseSample = baseSamples[baseStart + index];
      signalDot += uploadedSamples[uploadStart + index] * baseSample;
      baseSq += baseSample * baseSample;
    }
    const fittedGain = baseSq > 0 ? signalDot / baseSq : 1;
    const residual = new Float64Array(comparedSamples);
    const expectedWatermark = new Float64Array(comparedSamples);
    for (let index = 0; index < comparedSamples; index += 1) {
      residual[index] = uploadedSamples[uploadStart + index]
        - fittedGain * baseSamples[baseStart + index];
      expectedWatermark[index] = challenge.watermark[baseStart + index];
    }
    const watermarkCorrelation = Math.abs(cosine(expectedWatermark, residual, 0).value);
    const durationDeltaMs = Math.abs(upload.durationMs - base.durationMs);
    const metrics = {
      baseFixtureSha256: base.sha256,
      challengeCommitmentSha256: challenge.commitmentSha256,
      uploadSha256: upload.sha256,
      durationMs: upload.durationMs,
      durationDeltaMs,
      comparedSamples,
      baseCorrelation: Number(best.value.toFixed(6)),
      watermarkCorrelation: Number(watermarkCorrelation.toFixed(6)),
      witnessed: true,
    };
    onMetrics?.(deepFreeze({ ...metrics }));
    if (best.value < 0.8 || watermarkCorrelation < 0.25 || durationDeltaMs > 250) fail();
    return deepFreeze(metrics);
  } catch (error) {
    if (error?.code === 'MOBILE_CONTROLLED_EVIDENCE_INVALID') throw error;
    fail();
  }
}

function taskOwnedTempRoot(value) {
  const root = resolve(String(value ?? ''));
  if (!isAbsolute(root) || !/^[dD]:\\/.test(root)
    || !root.toLowerCase().includes('\\.codex-task-5g-temp\\')) fail();
  return root;
}

async function createPrivateChallenge({ baseBytes, seed, tempRoot }) {
  const root = taskOwnedTempRoot(tempRoot);
  const directory = await mkdtemp(join(root, 'mobile-voice-challenge-'));
  const filePath = join(directory, 'capture.wav');
  if (relative(root, filePath).startsWith('..')) fail();
  const challenge = deriveChallengeWav(baseBytes, { seed });
  await writeFile(filePath, challenge.bytes, { flag: 'wx', mode: 0o600 });
  return {
    ...challenge,
    filePath,
    async dispose() {
      if (resolve(dirname(filePath)) !== resolve(directory)
        || relative(root, directory).startsWith('..')) fail();
      await unlink(filePath);
      await rmdir(directory);
    },
  };
}

export async function loadPinnedBrowserContract() {
  const packageJson = JSON.parse(await readFile(new URL('../node_modules/playwright/package.json', import.meta.url)));
  const browsers = JSON.parse(await readFile(new URL('../node_modules/playwright-core/browsers.json', import.meta.url)));
  const pinned = browsers.browsers.find(({ name }) => name === 'chromium');
  const actual = {
    engine: 'chromium',
    playwrightVersion: packageJson.version,
    revision: pinned?.revision,
    browserVersion: pinned?.browserVersion,
    pinned: true,
    realIosSafari: false,
  };
  if (JSON.stringify(actual) !== JSON.stringify(MOBILE_BROWSER_CONTRACT)) fail();
  return deepFreeze(actual);
}

export function finalizeTask8MobileRecord(record) {
  const { artifactSha256: ignored, ...payload } = record;
  void ignored;
  return deepFreeze({ ...payload, artifactSha256: canonicalSha256(payload) });
}

function assertPrivacyReference(value, boundarySha256) {
  const observed = Date.parse(value?.observedAt);
  const expires = Date.parse(value?.expiresAt);
  if (!exactKeys(value, [
    'artifactSha256', 'boundarySha256', 'expiresAt', 'filePath', 'objectSha256',
    'observedAt', 'schemaVersion',
  ]) || value.schemaVersion !== CANDIDATE_PRIVACY_SCHEMA_VERSION
    || !DIGEST.test(value.artifactSha256)
    || !DIGEST.test(value.objectSha256) || value.boundarySha256 !== boundarySha256
    || !Number.isFinite(observed) || expires - observed !== MAX_EVIDENCE_AGE_MS) fail();
  return value;
}

function assertVoiceWitness(value) {
  if (!exactKeys(value, [
    'baseCorrelation', 'baseFixtureSha256', 'challengeCommitmentSha256',
    'commandLineVerified', 'comparedSamples', 'durationDeltaMs', 'durationMs',
    'playbackObserved', 'uploadSha256', 'watermarkCorrelation', 'witnessed',
  ]) || value.baseFixtureSha256 !== MOBILE_WAV_CONTRACT.sha256
    || !DIGEST.test(value.challengeCommitmentSha256) || !DIGEST.test(value.uploadSha256)
    || value.commandLineVerified !== true || value.playbackObserved !== true
    || value.witnessed !== true || !Number.isSafeInteger(value.comparedSamples)
    || value.comparedSamples < 12_000 || !Number.isFinite(value.durationMs)
    || value.durationMs < 750 || value.durationMs > 1_250
    || !Number.isFinite(value.durationDeltaMs) || value.durationDeltaMs < 0
    || value.durationDeltaMs > 250 || !Number.isFinite(value.baseCorrelation)
    || value.baseCorrelation < 0.8 || value.baseCorrelation > 1
    || !Number.isFinite(value.watermarkCorrelation)
    || value.watermarkCorrelation < 0.25 || value.watermarkCorrelation > 1) fail();
  return value;
}

export function validateTask8MobileRecord(record, {
  binding,
  sourceArchiveSha256,
  boundarySha256,
  candidateAccess,
  now = new Date(),
} = {}) {
  try {
    const current = new Date(now).getTime();
    const occurredAt = Date.parse(record?.occurredAt);
    const expiresAt = Date.parse(record?.expiresAt);
    if (!RELEASE_SHA.test(binding?.releaseSha) || !IMAGE_DIGEST.test(binding?.imageDigest)
      || !DIGEST.test(sourceArchiveSha256) || !DIGEST.test(boundarySha256)
      || !exactKeys(record, [
        'access', 'artifactSha256', 'browser', 'candidateOrigin', 'candidateRevision',
        'candidateService', 'candidateTag', 'checks', 'commitSha', 'controlPlane',
        'expiresAt', 'finalNavigationUrl', 'fixture', 'gate', 'imageDigest', 'network',
        'occurredAt', 'privacyProofs', 'result', 'schemaVersion', 'screenshots',
        'sourceArchiveSha256', 'stableService', 'stableTrafficState', 'trafficPercent',
        'trafficState', 'viewport', 'voiceWitness',
      ]) || record.schemaVersion !== 3 || record.gate !== 'mobile' || record.result !== 'pass'
      || record.commitSha !== binding.releaseSha || record.sourceArchiveSha256 !== sourceArchiveSha256
      || record.imageDigest !== binding.imageDigest || record.candidateService !== binding.candidateService
      || record.candidateRevision !== binding.candidateRevision || record.candidateTag !== binding.candidateTag
      || record.candidateOrigin !== binding.candidateOrigin
      || !exactKeys(candidateAccess, [
        'authenticated', 'audience', 'issuer', 'subjectSha256', 'taggedUrl',
      ]) || !exactKeys(record.access, Object.keys(candidateAccess))
      || JSON.stringify(record.access) !== JSON.stringify(candidateAccess)
      || record.finalNavigationUrl !== binding.candidateOrigin
      || record.trafficPercent !== 100 || record.trafficState !== 'candidate-service-private-100'
      || !['stable-absent', 'stable-prior-100'].includes(record.stableTrafficState)
      || !Number.isFinite(current) || current < occurredAt - 30_000 || current >= expiresAt
      || JSON.stringify(record.browser) !== JSON.stringify(MOBILE_BROWSER_CONTRACT)
      || JSON.stringify(record.fixture) !== JSON.stringify(MOBILE_WAV_CONTRACT)
      || JSON.stringify(record.viewport) !== JSON.stringify({
        width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      }) || !exactKeys(record.privacyProofs, ['end', 'start'])) fail();
    assertVoiceWitness(record.voiceWitness);
    const start = assertPrivacyReference(record.privacyProofs.start, boundarySha256);
    const end = assertPrivacyReference(record.privacyProofs.end, boundarySha256);
    if (record.occurredAt !== start.observedAt
      || record.expiresAt !== (Date.parse(start.expiresAt) <= Date.parse(end.expiresAt)
        ? start.expiresAt : end.expiresAt)
      || Date.parse(end.observedAt) <= Date.parse(start.observedAt)
      || !Array.isArray(record.checks) || record.checks.length !== MOBILE_CHECK_IDS.length
      || record.checks.some((check, index) => !exactKeys(check, ['derived', 'id'])
        || check.id !== MOBILE_CHECK_IDS[index] || check.derived !== true)
      || !Array.isArray(record.screenshots) || record.screenshots.length !== 4
      || record.screenshots.some((shot, index) => !exactKeys(shot, [
        'byteLength', 'colorCount', 'dominantRatio', 'filePath', 'height', 'id',
        'luminanceSpan', 'luminanceVariance', 'nonDominantRatio', 'pixelSha256',
        'rawSha256', 'width',
      ]) || shot.id !== MOBILE_SCREENSHOT_IDS[index]
        || typeof shot.filePath !== 'string' || shot.filePath.length < 1
        || shot.width !== 390 || shot.height !== 844 || !DIGEST.test(shot.rawSha256)
        || !DIGEST.test(shot.pixelSha256) || !Number.isSafeInteger(shot.byteLength)
        || shot.byteLength < 128 || shot.byteLength > 4 * 1024 * 1024
        || !Number.isSafeInteger(shot.colorCount)
        || shot.colorCount < 64 || !Number.isFinite(shot.luminanceSpan)
        || shot.luminanceSpan < 32 || !Number.isFinite(shot.luminanceVariance)
        || shot.luminanceVariance <= 0 || !Number.isFinite(shot.dominantRatio)
        || !Number.isFinite(shot.nonDominantRatio) || shot.nonDominantRatio < 0.02
        || Math.abs(shot.dominantRatio + shot.nonDominantRatio - 1) > 1e-9)
      || new Set(record.screenshots.map(({ rawSha256 }) => rawSha256)).size !== 4
      || new Set(record.screenshots.map(({ pixelSha256 }) => pixelSha256)).size !== 4
      || !exactKeys(record.controlPlane, ['afterSha256', 'beforeSha256', 'stable'])
      || record.controlPlane.stable !== true
      || record.controlPlane.beforeSha256 !== record.controlPlane.afterSha256
      || !exactKeys(record.network, ['eventCount', 'traceSha256'])
      || !Number.isSafeInteger(record.network.eventCount) || record.network.eventCount < 1
      || !DIGEST.test(record.network.traceSha256)
      || containsForbiddenPersistedSecret(record)
      || JSON.stringify(finalizeTask8MobileRecord(record)) !== JSON.stringify(record)) fail();
    return true;
  } catch {
    fail();
  }
}

function exactCandidateOrigin(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash) fail();
    return parsed.origin;
  } catch {
    fail();
  }
}

function parseJsonBody(value) {
  if (typeof value !== 'string' || value.length > 128 * 1024) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function canonicalEventSourceUrl(url, candidateOrigin) {
  if (url.origin !== candidateOrigin || url.pathname !== '/api/v1/events' || url.hash) return false;
  if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has('afterCursor')) return false;
  const cursor = url.searchParams.get('afterCursor');
  return /^(?:0|[1-9][0-9]*)$/.test(cursor) && Number.isSafeInteger(Number(cursor));
}

export async function runPinnedPlaywrightFlow({
  candidateOrigin,
  authorization,
  context,
  fixturePath,
  testProbeOnly = false,
  challengeSeed,
  testHooks = null,
}) {
  if (typeof authorization !== 'string' || authorization.length < 1 || authorization.length > 16_384) fail();
  const trustedOrigin = exactCandidateOrigin(candidateOrigin);
  const baseBytes = await readFile(fixturePath);
  const base = validateCanonicalWav(baseBytes, { expectedSha256: MOBILE_WAV_CONTRACT.sha256 });
  if (base.durationMs !== MOBILE_WAV_CONTRACT.durationMs) fail();
  const deterministicSeed = challengeSeed === undefined ? undefined : Buffer.from(challengeSeed);
  if (deterministicSeed !== undefined && deterministicSeed.length !== 32) fail();
  const challenge = await createPrivateChallenge({
    baseBytes: base.buffer,
    seed: deterministicSeed,
    tempRoot: process.env.TEMP,
  });
  await testHooks?.onChallengeCreated?.({ filePath: challenge.filePath, bytes: Buffer.from(challenge.bytes) });
  let browser;
  const failures = [];
  const network = [];
  const started = new Map();
  const responseTasks = [];
  const messageRequests = [];
  const uploadRequests = [];
  const uploadResponses = [];
  const audioRequests = [];
  const audioResponses = [];
  const expectedFailedRequests = new WeakSet();
  const nativePlayback = [];
  const mediaPlayback = [];
  const mediaPlayers = new Map();
  const mediaPlayer = (playerId) => {
    if (typeof playerId !== 'string' || playerId.length < 1 || playerId.length > 256) return null;
    if (!mediaPlayers.has(playerId)) {
      mediaPlayers.set(playerId, { properties: new Map(), lifecycleId: 0, currentLoad: null });
    }
    return mediaPlayers.get(playerId);
  };
  const parseMediaEvent = (value) => {
    const invalid = (name = null) => ({
      valid: false, name, pipelineState: null, sourceUrl: null,
    });
    if (typeof value !== 'string' || value.length < 2 || value.length > 8_192) return invalid();
    try {
      const event = JSON.parse(value);
      if (!event || typeof event !== 'object' || Array.isArray(event)) return invalid();
      const knownString = (key, maximumLength) => {
        if (!Object.hasOwn(event, key)) return { valid: true, value: null };
        return typeof event[key] === 'string' && event[key].length <= maximumLength
          ? { valid: true, value: event[key] }
          : { valid: false, value: null };
      };
      const name = knownString('event', 128);
      const pipelineState = knownString('pipeline_state', 128);
      const sourceUrl = knownString('url', 2_048);
      return {
        valid: name.valid && pipelineState.valid && sourceUrl.valid,
        name: name.value,
        pipelineState: pipelineState.value,
        sourceUrl: sourceUrl.value,
      };
    } catch {
      return invalid();
    }
  };
  const isMediaPlaybackEvent = ({ name, pipelineState } = {}) => (
    name === 'kPlay' || name === 'kPlaying' || pipelineState === 'kPlaying'
  );
  const snapshotDataObject = (value, allowedKeySets) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expectedKeys = allowedKeySets.find((keys) => ownKeys.length === keys.length
      && ownKeys.every((key) => typeof key === 'string' && keys.includes(key)));
    if (!expectedKeys) return null;
    const snapshot = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  };
  const snapshotControlledTestMediaWrapper = (wrapper) => {
    if (wrapper === null) return { valid: true, snapshot: null };
    const snapshot = snapshotDataObject(wrapper, [[], ['value']]);
    if (!snapshot) return { valid: false, snapshot: null };
    if (!Object.hasOwn(snapshot, 'value')) return { valid: true, snapshot };
    const { value } = snapshot;
    const valid = value === undefined || value === null || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 128 * 1024);
    return { valid, snapshot: valid ? snapshot : null };
  };
  const snapshotControlledTestMediaObservation = (observation) => {
    const snapshot = snapshotDataObject(observation, [[
      'name', 'pipelineState', 'sourceUrl',
    ]]);
    if (!snapshot || (snapshot.name !== null
      && (typeof snapshot.name !== 'string' || snapshot.name.length > 128))
      || (snapshot.pipelineState !== null
        && (typeof snapshot.pipelineState !== 'string' || snapshot.pipelineState.length > 128))
      || (snapshot.sourceUrl !== null
        && (typeof snapshot.sourceUrl !== 'string' || snapshot.sourceUrl.length > 2_048))) {
      return { valid: false, snapshot: null };
    }
    return { valid: true, snapshot };
  };
  const snapshotHookArray = (value, maximumLength, snapshotEntry) => {
    try {
      if (!Array.isArray(value)) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || lengthDescriptor.value > maximumLength) return null;
      const length = lengthDescriptor.value;
      const expectedKeys = ['length', ...Array.from({ length }, (_, index) => String(index))];
      if (ownKeys.length !== expectedKeys.length
        || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) return null;
      const snapshot = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
        const entry = snapshotEntry(descriptor.value);
        if (!entry.valid) return null;
        snapshot.push(entry.snapshot);
      }
      return Object.freeze(snapshot);
    } catch {
      return null;
    }
  };
  const mediaPlayerHasOwnedPlayback = (ownedMediaPath) => {
    for (const player of mediaPlayers.values()) {
      let frameOwned = false;
      try { frameOwned = new URL(player.properties.get('kFrameUrl')).origin === trustedOrigin; } catch { /* not owned */ }
      if (!frameOwned) continue;
      const sourceOwned = (() => {
        try {
          const url = new URL(player.currentLoad?.sourceUrl);
          return url.origin === trustedOrigin && url.pathname === ownedMediaPath && !url.search && !url.hash;
        } catch { return false; }
      })();
      if (sourceOwned && player.currentLoad?.loadAfterExplicitPlay === true
        && player.currentLoad.playAfterExplicitPlay === true) return true;
    }
    return false;
  };
  const webAudioContexts = new Map();
  const webAudioNodes = new Map();
  const webAudioEdges = new Map();
  const webAudioConnections = new Set();
  const webAudioNodeMap = (contextId) => {
    if (!webAudioNodes.has(contextId)) webAudioNodes.set(contextId, new Map());
    return webAudioNodes.get(contextId);
  };
  const webAudioEdgeMap = (contextId) => {
    if (!webAudioEdges.has(contextId)) webAudioEdges.set(contextId, new Map());
    return webAudioEdges.get(contextId);
  };
  const webAudioPathReachesDestination = (contextId) => {
    const nodes = webAudioNodes.get(contextId);
    const edges = webAudioEdges.get(contextId);
    if (!nodes || !edges) return false;
    const destinations = new Set();
    const pending = [];
    for (const [nodeId, node] of nodes.entries()) {
      const destination = /AudioDestination/i.test(node.nodeType);
      if (destination) destinations.add(nodeId);
      if (!destination && node.numberOfOutputs > 0) pending.push(nodeId);
    }
    if (destinations.size === 0 || pending.length === 0) return false;
    const adjacency = new Map();
    for (const { sourceId, destinationId } of edges.values()) {
      if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
      adjacency.get(sourceId).add(destinationId);
    }
    const visited = new Set();
    while (pending.length > 0) {
      const nodeId = pending.shift();
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      if (destinations.has(nodeId)) return true;
      for (const destinationId of adjacency.get(nodeId) ?? []) pending.push(destinationId);
    }
    return false;
  };
  const refreshWebAudioPath = (contextId) => {
    const reachesDestination = webAudioPathReachesDestination(contextId);
    if (reachesDestination) webAudioConnections.add(contextId);
    else webAudioConnections.delete(contextId);
    return reachesDestination;
  };
  let primaryPage = null;
  let abortNextMessage = false;
  let explicitPlayStarted = false;
  let commandLineVerified = false;
  let uploadWitness = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--enable-automation',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${challenge.filePath}`,
      ],
    });
    if (browser.version() !== MOBILE_BROWSER_CONTRACT.browserVersion) fail();
    const browserCdp = await browser.newBrowserCDPSession();
    const commandLine = await browserCdp.send('Browser.getBrowserCommandLine');
    const arguments_ = commandLine?.arguments;
    const expectedCaptureArgument = `--use-file-for-fake-audio-capture=${challenge.filePath}`;
    commandLineVerified = Array.isArray(arguments_)
      && arguments_.includes('--enable-automation')
      && arguments_.includes('--use-fake-ui-for-media-stream')
      && arguments_.includes('--use-fake-device-for-media-stream')
      && arguments_.some((argument) => argument.toLowerCase() === expectedCaptureArgument.toLowerCase());
    await browserCdp.detach();
    if (!commandLineVerified) fail();
    const browserContext = await browser.newContext(context);
    browserContext.on('serviceworker', (worker) => {
      failures.push('serviceworker');
      void worker.evaluate?.(() => self.close?.()).catch?.(() => undefined);
    });
    const installPageGuards = (page) => {
      page.on('pageerror', () => failures.push('pageerror'));
      page.on('worker', (worker) => {
        failures.push('worker');
        void worker.evaluate?.(() => self.close?.()).catch?.(() => undefined);
      });
      page.on('download', (download) => {
        failures.push('download');
        testHooks?.onDownloadAttempt?.({ primary: page === primaryPage });
        void download.cancel().catch(() => undefined);
      });
      page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        const expectedStreamClose = request.resourceType() === 'eventsource'
          && canonicalEventSourceUrl(url, trustedOrigin);
        if (!expectedFailedRequests.has(request) && !expectedStreamClose) {
          failures.push(`requestfailed:${url.pathname}`);
        }
      });
    };
    browserContext.on('page', (page) => {
      installPageGuards(page);
      if (primaryPage === null) {
        primaryPage = page;
        return;
      }
      if (page !== primaryPage) {
        failures.push('child-page');
        if (testHooks?.retainUnexpectedPages !== true) {
          void page.close().catch(() => undefined);
        }
      }
    });
    await browserContext.routeWebSocket('**/*', (socket) => {
      failures.push('websocket');
      socket.close({ code: 1008, reason: 'Blocked by mobile evidence privacy fence' });
    });
    await browserContext.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isEventSource = request.resourceType() === 'eventsource';
      if (url.origin !== trustedOrigin || request.redirectedFrom()
        || (isEventSource && !canonicalEventSourceUrl(url, trustedOrigin))) {
        failures.push(isEventSource ? 'eventsource-request' : 'external-request');
        await route.abort('blockedbyclient');
        return;
      }
      if (abortNextMessage && request.method() === 'POST' && url.pathname === '/api/v1/messages') {
        abortNextMessage = false;
        expectedFailedRequests.add(request);
        await route.abort('failed');
        return;
      }
      let headers = { ...request.headers(), authorization };
      let postData;
      if (request.method() === 'POST' && url.pathname === '/api/v1/voice/transcriptions') {
        let bytes = request.postDataBuffer();
        let claimedSha256 = headers['x-content-sha256'] ?? null;
        if (typeof testHooks?.transformUpload === 'function') {
          const transformed = await testHooks.transformUpload({
            bytes: Buffer.from(bytes ?? []), claimedSha256,
          });
          bytes = Buffer.from(transformed?.bytes ?? []);
          claimedSha256 = transformed?.claimedSha256 ?? null;
          headers = {
            ...headers,
            'content-length': String(bytes.length),
            'x-content-sha256': claimedSha256,
          };
          postData = bytes;
        }
        uploadRequests.push({
          clientUploadId: headers['x-client-upload-id'] ?? null,
          claimedSha256,
          contentSha256: bytes ? sha256(bytes) : null,
          language: headers['x-asr-language'] ?? null,
          byteLength: bytes?.length ?? null,
          bytes: bytes ? Buffer.from(bytes) : null,
          request,
        });
      }
      await route.continue({ headers, ...(postData === undefined ? {} : { postData }) });
    });
    const page = await browserContext.newPage();
    const pageCdp = await browserContext.newCDPSession(page);
    const isolatedContexts = new Set();
    const bindingName = `__hbw_${randomBytes(16).toString('hex')}`;
    pageCdp.on('Runtime.executionContextCreated', ({ context: executionContext }) => {
      if (executionContext?.name === WITNESS_WORLD) isolatedContexts.add(executionContext.id);
    });
    pageCdp.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
      if (name !== bindingName || !isolatedContexts.has(executionContextId)) {
        failures.push('witness-binding-origin');
        return;
      }
      try {
        const event = JSON.parse(payload);
        if (!exactKeys(event, ['isTrusted', 'kind', 'src']) || !['play', 'playing'].includes(event.kind)
          || typeof event.isTrusted !== 'boolean'
          || typeof event.src !== 'string' || event.src.length > 2_048) fail();
        if (event.isTrusted !== true) {
          failures.push('untrusted-native');
          return;
        }
        nativePlayback.push(event);
        testHooks?.onPlaybackEvent?.(event);
        if (!explicitPlayStarted) failures.push('preplay-native');
      } catch {
        failures.push('witness-binding-payload');
      }
    });
    pageCdp.on('Media.playerPropertiesChanged', ({ playerId, properties }) => {
      const player = mediaPlayer(playerId);
      if (!player || !Array.isArray(properties)) {
        failures.push('media-properties');
        return;
      }
      const applyProperties = () => {
        for (const property of properties) {
          if (typeof property?.name !== 'string' || property.name.length < 1 || property.name.length > 256
            || (property.value !== null
              && (typeof property.value !== 'string' || property.value.length > 8_192))) {
            failures.push('media-property');
            continue;
          }
          if (property.value === null) player.properties.delete(property.name);
          else player.properties.set(property.name, property.value);
        }
      };
      let testDelayMs = 0;
      if (typeof testHooks?.deferCdpMediaProperties === 'function') {
        try { testDelayMs = testHooks.deferCdpMediaProperties(); } catch {
          failures.push('media-property-test-hook');
          return;
        }
        if (!Number.isSafeInteger(testDelayMs) || testDelayMs < 1 || testDelayMs > 1_000) {
          failures.push('media-property-test-delay');
          return;
        }
      }
      if (testDelayMs > 0) setTimeout(applyProperties, testDelayMs);
      else applyProperties();
    });
    pageCdp.on('Media.playerEventsAdded', ({ playerId, events }) => {
      const player = mediaPlayer(playerId);
      if (!player || !Array.isArray(events)) {
        failures.push('media-events');
        return;
      }
      for (const event of events ?? []) {
        let wrappers = [event];
        if (typeof testHooks?.rewriteCdpMediaEventWrappers === 'function') {
          const originalWrapper = Object.freeze({ value: event?.value });
          try {
            wrappers = testHooks.rewriteCdpMediaEventWrappers(originalWrapper);
          } catch {
            failures.push('media-event-wrapper-test-hook');
            continue;
          }
          wrappers = snapshotHookArray(
            wrappers, 4, snapshotControlledTestMediaWrapper,
          );
          if (wrappers === null) {
            failures.push('media-event-wrapper-test-hook');
            continue;
          }
        }
        for (let wrapperIndex = 0; wrapperIndex < wrappers.length; wrapperIndex += 1) {
          const wrapper = wrappers[wrapperIndex];
          const wrapperValid = wrapper !== null && typeof wrapper === 'object'
            && !Array.isArray(wrapper) && Object.hasOwn(wrapper, 'value');
          const parsed = wrapperValid ? parseMediaEvent(wrapper.value) : {
            valid: false, name: null, pipelineState: null, sourceUrl: null,
          };
          if (!parsed.valid) {
            if (parsed.name === 'kLoad') {
              player.lifecycleId += 1;
              player.currentLoad = null;
            }
            failures.push('media-event');
            continue;
          }
          const parsedObservation = {
            name: parsed.name,
            pipelineState: parsed.pipelineState,
            sourceUrl: parsed.sourceUrl,
          };
          let observations = [parsedObservation];
          if (typeof testHooks?.rewriteCdpMediaEvents === 'function') {
            try {
              observations = testHooks.rewriteCdpMediaEvents(Object.freeze({ ...parsedObservation }));
            } catch {
              failures.push('media-event-test-hook');
              continue;
            }
            observations = snapshotHookArray(
              observations, 4, snapshotControlledTestMediaObservation,
            );
            if (observations === null) {
              failures.push('media-event-test-hook');
              continue;
            }
          }
          for (let observationIndex = 0; observationIndex < observations.length;
            observationIndex += 1) {
            const candidate = observations[observationIndex];
            const observed = Object.freeze({ ...candidate });
            if (typeof testHooks?.acceptCdpMediaEvent === 'function') {
              let accepted = false;
              try { accepted = testHooks.acceptCdpMediaEvent(observed) === true; } catch {
                failures.push('media-event-test-hook');
                continue;
              }
              if (!accepted) continue;
            }
            if (observed.name === 'kLoad') {
              player.lifecycleId += 1;
              player.currentLoad = null;
              try {
                new URL(observed.sourceUrl);
                player.currentLoad = {
                  lifecycleId: player.lifecycleId,
                  sourceUrl: observed.sourceUrl,
                  loadAfterExplicitPlay: explicitPlayStarted,
                  playAfterExplicitPlay: false,
                };
              } catch {
                failures.push('media-load');
              }
            }
            if (isMediaPlaybackEvent(observed)) {
              const observation = {
                name: observed.name,
                pipelineState: observed.pipelineState,
                afterExplicitPlay: explicitPlayStarted,
              };
              mediaPlayback.push({ playerId, ...observation });
              if (observed.name === 'kPlay') {
                if (player.currentLoad === null) failures.push('media-play-without-load');
                else player.currentLoad.playAfterExplicitPlay = explicitPlayStarted;
              }
              if (!explicitPlayStarted) failures.push('preplay-media');
            }
          }
        }
      }
    });
    pageCdp.on('WebAudio.contextCreated', ({ context: audioContext }) => {
      webAudioContexts.set(audioContext.contextId, {
        state: audioContext.contextState,
        type: audioContext.contextType,
      });
      if (audioContext.contextState === 'running'
        && audioContext.contextType === 'realtime'
        && refreshWebAudioPath(audioContext.contextId) && !explicitPlayStarted) {
        failures.push('preplay-webaudio');
      }
    });
    pageCdp.on('WebAudio.contextChanged', ({ context: audioContext }) => {
      webAudioContexts.set(audioContext.contextId, {
        state: audioContext.contextState,
        type: audioContext.contextType,
      });
      if (audioContext.contextState === 'running'
        && audioContext.contextType === 'realtime'
        && refreshWebAudioPath(audioContext.contextId) && !explicitPlayStarted) {
        failures.push('preplay-webaudio');
      }
    });
    pageCdp.on('WebAudio.audioNodeCreated', ({ node }) => {
      if (!node?.contextId || !node?.nodeId || typeof node.nodeType !== 'string') return;
      webAudioNodeMap(node.contextId).set(node.nodeId, {
        nodeType: node.nodeType,
        numberOfInputs: node.numberOfInputs,
        numberOfOutputs: node.numberOfOutputs,
      });
      refreshWebAudioPath(node.contextId);
    });
    pageCdp.on('WebAudio.audioNodeWillBeDestroyed', ({ contextId, nodeId }) => {
      webAudioNodes.get(contextId)?.delete(nodeId);
      const edges = webAudioEdges.get(contextId);
      if (edges) {
        for (const [key, edge] of edges.entries()) {
          if (edge.sourceId === nodeId || edge.destinationId === nodeId) edges.delete(key);
        }
      }
      refreshWebAudioPath(contextId);
    });
    pageCdp.on('WebAudio.contextWillBeDestroyed', ({ contextId }) => {
      webAudioContexts.delete(contextId);
      webAudioNodes.delete(contextId);
      webAudioEdges.delete(contextId);
      webAudioConnections.delete(contextId);
    });
    pageCdp.on('WebAudio.nodesConnected', ({
      contextId, sourceId, destinationId, sourceOutputIndex, destinationInputIndex,
    }) => {
      const key = JSON.stringify([sourceId, destinationId, sourceOutputIndex, destinationInputIndex]);
      webAudioEdgeMap(contextId).set(key, { sourceId, destinationId, sourceOutputIndex, destinationInputIndex });
      const reachesDestination = refreshWebAudioPath(contextId);
      if (reachesDestination) {
        const contextState = webAudioContexts.get(contextId);
        if (contextState?.state === 'running' && contextState.type === 'realtime'
          && !explicitPlayStarted) failures.push('preplay-webaudio');
      }
    });
    pageCdp.on('WebAudio.nodesDisconnected', ({
      contextId, sourceId, destinationId, sourceOutputIndex, destinationInputIndex,
    }) => {
      const edges = webAudioEdges.get(contextId);
      if (!edges) return;
      for (const [key, edge] of edges.entries()) {
        if (edge.sourceId !== sourceId) continue;
        if (typeof destinationId === 'string' && destinationId.length > 0
          && edge.destinationId !== destinationId) continue;
        if (sourceOutputIndex !== undefined && edge.sourceOutputIndex !== sourceOutputIndex) continue;
        if (destinationInputIndex !== undefined && edge.destinationInputIndex !== destinationInputIndex) continue;
        edges.delete(key);
      }
      refreshWebAudioPath(contextId);
    });
    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Page.enable');
    await pageCdp.send('Media.enable');
    await pageCdp.send('WebAudio.enable');
    await pageCdp.send('Runtime.addBinding', { name: bindingName, executionContextName: WITNESS_WORLD });
    await pageCdp.send('Page.addScriptToEvaluateOnNewDocument', {
      worldName: WITNESS_WORLD,
      source: `(() => {
        const report = (event) => {
          const target = event.target;
          const src = target instanceof HTMLMediaElement ? (target.currentSrc || target.src || '') : '';
          globalThis[${JSON.stringify(bindingName)}](JSON.stringify({
            kind: event.type,
            src,
            isTrusted: event.isTrusted,
          }));
        };
        document.addEventListener('play', report, true);
        document.addEventListener('playing', report, true);
      })();`,
    });
    page.on('request', (request) => {
      started.set(request, Date.now());
      const url = new URL(request.url());
      if (url.origin !== trustedOrigin) return;
      if (url.pathname === '/api/v1/messages' && request.method() === 'POST') {
        const body = parseJsonBody(request.postData());
        messageRequests.push({ body, request });
      }
      if ((/^\/api\/v1\/messages\/[^/]+\/audio(?:\/status)?$/.test(url.pathname)
        || /^\/api\/v1\/media\/[^/]+$/.test(url.pathname))) {
        audioRequests.push({
          path: url.pathname,
          method: request.method(),
          resourceType: request.resourceType(),
          request,
        });
      }
    });
    page.on('response', (response) => {
      const request = response.request();
      const url = new URL(response.url());
      const status = response.status();
      const method = request.method();
      const resourceType = request.resourceType();
      const isEventSource = resourceType === 'eventsource';
      const expectedMissingVoiceProbe = method === 'GET' && status === 404
        && /^\/api\/v1\/voice\/uploads\/[0-9a-f-]{36}$/i.test(url.pathname);
      const allowedStatus = (status >= 200 && status < 300) || expectedMissingVoiceProbe;
      if (url.origin !== trustedOrigin || request.redirectedFrom() || !allowedStatus
        || !['GET', 'POST', 'DELETE'].includes(method)
        || !['document', 'stylesheet', 'script', 'image', 'font', 'fetch', 'xhr', 'eventsource', 'media'].includes(resourceType)
        || (isEventSource && (!canonicalEventSourceUrl(url, trustedOrigin)
          || status !== 200 || !/^text\/event-stream(?:;|$)/i.test(response.headers()['content-type'] ?? '')))) {
        failures.push(`network-response:${method}:${url.pathname}:${status}:${resourceType}`);
      }
      network.push({
        path: url.pathname,
        method,
        resourceType,
        status,
        durationMs: Math.max(0, Date.now() - (started.get(request) ?? Date.now())),
      });
      if (!isEventSource && (
        url.pathname === '/api/v1/voice/transcriptions'
        || /^\/api\/v1\/voice\/uploads\/[^/]+$/.test(url.pathname)
        || /^\/api\/v1\/messages\/[^/]+\/audio(?:\/status)?$/.test(url.pathname)
      )) {
        responseTasks.push((async () => {
          const body = parseJsonBody(await response.text().catch(() => ''));
          if (url.pathname === '/api/v1/voice/transcriptions'
            || /^\/api\/v1\/voice\/uploads\/[^/]+$/.test(url.pathname)) {
            uploadResponses.push({
              path: url.pathname,
              method,
              status,
              location: response.headers().location ?? null,
              retryAfter: response.headers()['retry-after'] ?? null,
              data: body?.data ?? null,
            });
          } else {
            audioResponses.push({ path: url.pathname, method, status, data: body?.data ?? null });
          }
        })().catch(() => failures.push('response-observation')));
      }
    });
    await page.goto(trustedOrigin, { waitUntil: 'domcontentloaded' });
    await page.locator('.chat-shell[data-app-state="ready"]').waitFor({ state: 'visible' });
    await testHooks?.afterReady?.({ page, context: browserContext });
    if (testProbeOnly === true) {
      await page.waitForTimeout(250);
      if (failures.length > 0) fail();
      const finalNavigationUrl = new URL(page.url()).origin;
      await browserContext.close();
      return { browser: await loadPinnedBrowserContract(), finalNavigationUrl };
    }
    const screenshots = [];
    screenshots.push({ id: 'first-visit', bytes: await page.screenshot({ type: 'png' }) });
    const firstVisitVisible = await page.locator('#welcome').isVisible();
    const aiDisclosureVisible = await page.locator('#welcome-disclosure').isVisible();
    await page.locator('#reply-preferences-trigger').click();
    await page.locator('[name="reply-language"][value="yue-Hant-HK"]').check();
    await page.locator('[name="reply-mode"][value="voice"]').check();
    await page.locator('#save-reply-preferences').click();
    const responseLanguageModeChanged = (await page.locator('#reply-preference-value').textContent())
      ?.includes('廣東話') === true
      && (await page.locator('#reply-preference-value').textContent())?.includes('Voice') === true;
    await page.locator('#reply-preferences-trigger').click();
    await page.locator('[name="reply-language"][value="en"]').check();
    await page.locator('[name="reply-mode"][value="text"]').check();
    await page.locator('#save-reply-preferences').click();
    const supportedAssistantIds = new Set(await page.locator('.message-row--assistant[data-message-id]').evaluateAll(
      (rows) => rows.map((row) => row.dataset.messageId),
    ));
    await page.locator('#message-input').fill('How do I activate my SSOid?');
    await page.locator('#send-button').click();
    await page.waitForFunction((prior) => [...document.querySelectorAll('.message-row--assistant[data-message-id]')]
      .some((row) => !prior.includes(row.dataset.messageId)), [...supportedAssistantIds]);
    const supportedRow = page.locator('.message-row--assistant[data-message-id]').filter({
      has: page.locator('.message-text', { hasText: /.+/ }),
    }).last();
    const supportedAssistantId = await supportedRow.getAttribute('data-message-id');
    const supportedUserRequest = messageRequests.find(({ body }) => body?.text === 'How do I activate my SSOid?')?.body;
    const textMessageSent = UUID.test(supportedAssistantId ?? '') && UUID.test(supportedUserRequest?.clientMessageId ?? '');
    const source = supportedRow.locator('.source-card .source-freshness').first();
    const verifiedOfficialSourceVisible = await source.isVisible()
      && /^Checked /.test((await source.textContent()) ?? '');
    screenshots.push({ id: 'text-source', bytes: await page.screenshot({ type: 'png' }) });
    const supportedAudioButton = supportedRow.locator('.assistant-audio-button');
    await supportedAudioButton.waitFor({ state: 'visible' });
    const mediaFetchesBeforeGenerate = audioRequests.filter(({ path, method, resourceType }) => (
      path.startsWith('/api/v1/media/') && method === 'GET' && resourceType === 'media'
    )).length;
    const audioPostsBeforeGenerate = audioRequests.filter(({ method, path }) => method === 'POST'
      && path === `/api/v1/messages/${supportedAssistantId}/audio`).length;
    const generateLabelObserved = (await supportedAudioButton.textContent()) === 'Generate voice';
    await supportedAudioButton.click();
    await page.waitForFunction((id) => {
      const button = document.querySelector(`.message-row[data-message-id="${id}"] .assistant-audio-button`);
      return button?.textContent === 'Play voice';
    }, supportedAssistantId);
    const mediaFetchesBeforePlay = audioRequests.filter(({ path, method, resourceType }) => (
      path.startsWith('/api/v1/media/') && method === 'GET' && resourceType === 'media'
    )).length;
    const assistantAudioAutoplayed = mediaFetchesBeforePlay !== mediaFetchesBeforeGenerate;
    const audioPostObserved = audioRequests.filter(({ method, path }) => method === 'POST'
      && path === `/api/v1/messages/${supportedAssistantId}/audio`).length === audioPostsBeforeGenerate + 1;
    await Promise.all(responseTasks);
    const attachedAudio = audioResponses.find(({ path, method, status, data }) => (
      path === `/api/v1/messages/${supportedAssistantId}/audio` && method === 'POST'
      && status >= 200 && status < 300 && data?.messageId === supportedAssistantId
      && data?.state === 'attached' && UUID.test(data?.mediaId ?? '')
    ));
    let assistantAudioReady = generateLabelObserved && audioPostObserved && Boolean(attachedAudio)
      && (await supportedAudioButton.textContent()) === 'Play voice';
    const ownedMediaPath = `/api/v1/media/${attachedAudio?.data?.mediaId}`;
    const ownedMediaFetchesBeforePlay = audioRequests.filter(({ path, method, resourceType }) => (
      path === ownedMediaPath && method === 'GET' && resourceType === 'media'
    )).length;
    if (nativePlayback.length > 0 || mediaPlayback.length > 0
      || failures.some((item) => /^preplay-/.test(item))) fail();
    explicitPlayStarted = true;
    await supportedAudioButton.click();
    await page.waitForFunction((prior) => performance.getEntriesByType('resource')
      .filter((entry) => new URL(entry.name).pathname.startsWith('/api/v1/media/')).length > prior,
    mediaFetchesBeforePlay).catch(() => undefined);
    assistantAudioReady = assistantAudioReady
      && audioRequests.filter(({ path, method, resourceType }) => (
        path === ownedMediaPath && method === 'GET' && resourceType === 'media'
      )).length
        > ownedMediaFetchesBeforePlay;
    for (let attempt = 0; attempt < 80
      && !(nativePlayback.some(({ isTrusted, kind, src }) => {
        try {
          const url = new URL(src);
          return isTrusted === true && kind === 'playing' && url.origin === trustedOrigin
            && url.pathname === ownedMediaPath && !url.search && !url.hash;
        } catch { return false; }
      }) && mediaPlayerHasOwnedPlayback(ownedMediaPath)); attempt += 1) {
      await page.waitForTimeout(25);
    }
    const trustedNativePlayback = nativePlayback.some(({ isTrusted, kind, src }) => {
      try {
        const url = new URL(src);
        return isTrusted === true && kind === 'playing' && url.origin === trustedOrigin
          && url.pathname === ownedMediaPath && !url.search && !url.hash;
      } catch { return false; }
    });
    const playbackObserved = trustedNativePlayback && mediaPlayerHasOwnedPlayback(ownedMediaPath);
    if (!playbackObserved) fail();
    assistantAudioReady = assistantAudioReady && playbackObserved;

    const unsupportedPriorIds = new Set(await page.locator('.message-row--assistant[data-message-id]').evaluateAll(
      (rows) => rows.map((row) => row.dataset.messageId),
    ));
    await page.locator('#message-input').fill('Is H.F.C.@Scholars Court open today?');
    await page.locator('#send-button').click();
    await page.waitForFunction((prior) => [...document.querySelectorAll('.message-row--assistant[data-message-id]')]
      .some((row) => !prior.includes(row.dataset.messageId)), [...unsupportedPriorIds]);
    const unsupportedId = await page.locator('.message-row--assistant[data-message-id]')
      .evaluateAll((rows, prior) => rows.map((row) => row.dataset.messageId).find((id) => !prior.includes(id)), [...unsupportedPriorIds]);
    const unsupportedRow = page.locator(`.message-row--assistant[data-message-id="${unsupportedId}"]`);
    await unsupportedRow.locator('.action-card').waitFor({ state: 'visible' });
    const unsupportedHandoffVisible = UUID.test(unsupportedId ?? '')
      && (await unsupportedRow.getAttribute('data-grounding-status')) === 'unverified'
      && await unsupportedRow.locator('.action-card').isVisible()
      && /official|cannot|can.t verify|contact/i.test(await unsupportedRow.innerText());

    const retryPrompt = 'Retry identity probe: where is the library?';
    abortNextMessage = true;
    await page.locator('#message-input').fill(retryPrompt);
    await page.locator('#send-button').click();
    await page.waitForFunction((text) => [...document.querySelectorAll('.message-row--user')]
      .some((row) => row.querySelector('.message-text')?.textContent === text
        && !row.querySelector('.retry-message')?.hidden), retryPrompt);
    const abortedRequest = messageRequests.findLast(({ body }) => body?.text === retryPrompt)?.body;
    const retryClientMessageId = abortedRequest?.clientMessageId;
    const retryButton = page.locator(`.message-row--user[data-client-message-id="${retryClientMessageId}"] .retry-message[data-client-message-id="${retryClientMessageId}"]`);
    await retryButton.click();
    await page.waitForFunction((clientMessageId) => {
      const row = document.querySelector(`.message-row--user[data-client-message-id="${clientMessageId}"]`);
      return row && /^[0-9a-f-]{36}$/i.test(row.dataset.messageId ?? '')
        && row.querySelector('.retry-message')?.hidden === true;
    }, retryClientMessageId);
    const retryBodies = messageRequests.filter(({ body }) => body?.clientMessageId === retryClientMessageId).map(({ body }) => body);
    const canonicalRetryId = await page.locator(`.message-row--user[data-client-message-id="${retryClientMessageId}"]`).getAttribute('data-message-id');
    let retryReloadRetained = false;

    const messageCountBeforeVoice = messageRequests.length;
    const voiceButton = page.locator('#voice-button');
    await voiceButton.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#voice-button')?.textContent === 'Enable voice');
    let consentDialogObserved = false;
    for (let attempt = 0; attempt < 4 && !consentDialogObserved; attempt += 1) {
      await voiceButton.click();
      consentDialogObserved = await page.locator('#voice-consent').waitFor({ state: 'visible', timeout: 750 })
        .then(() => true, () => false);
    }
    if (!consentDialogObserved) fail();
    await page.locator('#voice-consent-continue').click();
    await page.locator('#voice-consent').waitFor({ state: 'hidden' });
    await voiceButton.press('Space');
    await page.waitForTimeout(1_100);
    await voiceButton.press('Space');
    for (let attempt = 0; attempt < 80 && uploadRequests.length === 0; attempt += 1) {
      await page.waitForTimeout(25);
    }
    const witnessedUpload = uploadRequests.at(-1);
    uploadWitness = verifyChallengeBoundUpload(witnessedUpload?.bytes, {
      baseValue: base.buffer,
      challenge,
      onMetrics: testHooks?.onWitnessMetrics,
    });
    await page.locator('#voice-draft').waitFor({ state: 'visible' });
    await page.locator('#voice-draft-state').filter({ hasText: 'Voice draft · Not sent' }).waitFor();
    const transcript = await page.locator('#message-input').inputValue();
    const voiceTranscriptEditable = !await page.locator('#message-input').isDisabled() && transcript.length > 0;
    await Promise.all(responseTasks);
    const upload = uploadRequests.at(-1);
    const correlatedResponses = uploadResponses.filter(({ data }) => data?.clientUploadId === upload?.clientUploadId);
    const terminal = correlatedResponses.findLast(({ data }) => typeof data?.transcript === 'string'
      && UUID.test(data?.voiceDraftId ?? ''));
    const voiceTranscriptUnsent = await page.locator('#voice-draft').isVisible()
      && messageRequests.length === messageCountBeforeVoice
      && terminal?.data?.transcript === transcript;
    screenshots.push({ id: 'voice-transcript', bytes: await page.screenshot({ type: 'png' }) });
    await page.locator('#remove-voice-draft').click();
    await page.locator('#voice-draft').waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.chat-shell[data-app-state="ready"]').waitFor({ state: 'visible' });
    const retainedRetryRow = page.locator(`.message-row--user[data-client-message-id="${retryClientMessageId}"][data-message-id="${canonicalRetryId}"]`);
    retryReloadRetained = UUID.test(retryClientMessageId ?? '') && UUID.test(canonicalRetryId ?? '')
      && retryBodies.length === 2 && JSON.stringify(retryBodies[0]) === JSON.stringify(retryBodies[1])
      && await retainedRetryRow.isVisible();
    await page.locator('#message-input').focus();
    await page.keyboard.press('Tab');
    const keyboardFocusVisible = await page.evaluate(() => (
      document.activeElement instanceof HTMLElement
      && getComputedStyle(document.activeElement).outlineStyle !== 'none'
    ));
    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const composer = document.querySelector('#composer');
      const controls = composer ? [...composer.querySelectorAll('button, textarea, input, a')]
        .map((control) => control.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0) : [];
      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        bottomSafeAreaPx: controls.length > 0
          ? Math.max(0, window.innerHeight - Math.max(...controls.map((rect) => rect.bottom))) : 0,
      };
    });
    const safeAreaScreenshot = { id: 'mobile-safe-area', bytes: await page.screenshot({ type: 'png' }) };
    await page.locator('.info-button').click();
    await page.locator('#clear-session').click();
    await page.locator('#clear-session').click();
    await page.locator('#message-feed > *').first().waitFor({ state: 'detached' });
    const clearConversationObserved = await page.locator('#message-feed > *').count() === 0;
    screenshots.push(safeAreaScreenshot);
    const pollResponses = uploadResponses.filter(({ path, method, status, data }) => (
      method === 'GET' && status >= 200 && status < 300
      && data?.clientUploadId === upload?.clientUploadId
      && path === `/api/v1/voice/uploads/${upload?.clientUploadId}`
    ));
    const initialUploadResponse = uploadResponses.find(({ path, method }) => (
      method === 'POST' && path === '/api/v1/voice/transcriptions'
    ));
    if (!uploadWitness || upload?.contentSha256 !== uploadWitness.uploadSha256) fail();
    if (failures.length > 0) fail();
    const finalNavigationUrl = new URL(page.url()).origin;
    await browserContext.close();
    const flow = {
      browser: await loadPinnedBrowserContract(),
      finalNavigationUrl,
      dom: {
        firstVisitVisible, aiDisclosureVisible, responseLanguageModeChanged, textMessageSent,
        voiceTranscriptEditable, voiceTranscriptUnsent, assistantAudioReady,
        assistantAudioAutoplayed, verifiedOfficialSourceVisible, unsupportedHandoffVisible,
        retryReloadRetained, consentDialogObserved, clearConversationObserved,
        keyboardFocusVisible, ...geometry,
      },
      voice: {
        upload: {
          clientUploadId: upload?.clientUploadId ?? null,
          claimedSha256: upload?.claimedSha256 ?? null,
          contentSha256: upload?.contentSha256 ?? null,
          language: upload?.language ?? null,
          byteLength: upload?.byteLength ?? null,
          status: initialUploadResponse?.status ?? null,
          location: initialUploadResponse?.location ?? null,
          retryAfter: initialUploadResponse?.retryAfter ?? null,
        },
        polls: pollResponses.map(({ data, status }) => ({
          clientUploadId: data?.clientUploadId ?? null,
          requestSha256: data?.requestSha256 ?? null,
          status,
        })),
        terminal: {
          clientUploadId: terminal?.data?.clientUploadId ?? null,
          requestSha256: terminal?.data?.requestSha256 ?? null,
          transcript: terminal?.data?.transcript ?? null,
          voiceDraftId: terminal?.data?.voiceDraftId ?? null,
          domTranscript: transcript,
        },
        transcriptEditable: voiceTranscriptEditable,
        transcriptSent: false,
        fixture: MOBILE_WAV_CONTRACT,
        witness: {
          ...uploadWitness,
          commandLineVerified,
          playbackObserved,
        },
      },
      network,
      screenshots,
    };
    browserOwnedFlows.add(flow);
    return flow;
  } finally {
    await browser?.close().catch(() => undefined);
    try { await challenge.dispose(); } catch { fail(); }
  }
}

function deriveChecks(flow, { controlledBrowserAdapter = false } = {}) {
  const dom = flow?.dom;
  const voice = flow?.voice;
  if (!exactKeys(dom, [
    'aiDisclosureVisible', 'assistantAudioAutoplayed', 'assistantAudioReady',
    'bottomSafeAreaPx', 'clearConversationObserved', 'clientWidth', 'consentDialogObserved',
    'firstVisitVisible', 'keyboardFocusVisible', 'responseLanguageModeChanged',
    'retryReloadRetained', 'scrollWidth', 'textMessageSent', 'unsupportedHandoffVisible',
    'verifiedOfficialSourceVisible', 'voiceTranscriptEditable', 'voiceTranscriptUnsent',
  ]) || !exactKeys(voice, [
    'fixture', 'polls', 'terminal', 'transcriptEditable', 'transcriptSent', 'upload',
    'witness',
  ]) || (!controlledBrowserAdapter && !browserOwnedFlows.has(flow))) fail();
  const witness = assertVoiceWitness(voice.witness);
  const upload = voice.upload;
  const terminal = voice.terminal;
  const validPolls = Array.isArray(voice.polls)
    && voice.polls.every((poll) => exactKeys(poll, ['clientUploadId', 'requestSha256', 'status'])
      && poll.clientUploadId === upload?.clientUploadId
      && poll.requestSha256 === upload?.contentSha256
      && Number.isSafeInteger(poll.status) && poll.status >= 200 && poll.status < 300);
  const immediateReady = upload?.status === 201 && upload.location === null
    && upload.retryAfter === null && validPolls;
  const asynchronousReady = upload?.status === 202
    && upload.location === `/api/v1/voice/uploads/${upload.clientUploadId}`
    && typeof upload.retryAfter === 'string' && /^\d+$/.test(upload.retryAfter)
    && validPolls && voice.polls.length >= 1;
  const voiceCorrelated = exactKeys(upload, [
    'byteLength', 'claimedSha256', 'clientUploadId', 'contentSha256', 'language',
    'location', 'retryAfter', 'status',
  ]) && UUID.test(upload.clientUploadId ?? '') && upload.claimedSha256 === upload.contentSha256
    && DIGEST.test(upload.contentSha256 ?? '') && upload.language === 'en'
    && Number.isSafeInteger(upload.byteLength) && upload.byteLength > 44
    && upload.byteLength <= 10 * 1024 * 1024 && (immediateReady || asynchronousReady)
    && exactKeys(terminal, [
      'clientUploadId', 'domTranscript', 'requestSha256', 'transcript', 'voiceDraftId',
    ]) && terminal.clientUploadId === upload.clientUploadId
    && terminal.requestSha256 === upload.contentSha256 && UUID.test(terminal.voiceDraftId ?? '')
    && typeof terminal.transcript === 'string' && terminal.transcript.length > 0
    && terminal.domTranscript === terminal.transcript;
  const derived = {
    'first-visit': dom.firstVisitVisible === true && dom.aiDisclosureVisible === true,
    'response-language-mode-change': dom.responseLanguageModeChanged === true,
    'text-send': dom.textMessageSent === true,
    'editable-voice-transcript': dom.voiceTranscriptEditable === true
      && dom.voiceTranscriptUnsent === true && voice.transcriptEditable === true
      && voice.transcriptSent === false && voiceCorrelated && witness.witnessed === true
      && JSON.stringify(voice.fixture) === JSON.stringify(MOBILE_WAV_CONTRACT),
    'assistant-audio-ready-no-autoplay': dom.assistantAudioReady === true
      && dom.assistantAudioAutoplayed === false,
    'verified-official-source': dom.verifiedOfficialSourceVisible === true,
    'unsupported-honest-handoff': dom.unsupportedHandoffVisible === true,
    'retry-reload-retention': dom.retryReloadRetained === true,
    consent: dom.consentDialogObserved === true,
    'clear-conversation': dom.clearConversationObserved === true,
    'keyboard-focus': dom.keyboardFocusVisible === true,
    'bottom-safe-area': Number.isFinite(dom.bottomSafeAreaPx) && dom.bottomSafeAreaPx >= 8,
    'no-horizontal-overflow': Number.isFinite(dom.scrollWidth) && Number.isFinite(dom.clientWidth)
      && dom.scrollWidth <= dom.clientWidth,
  };
  if (Object.values(derived).some((value) => value !== true)) fail();
  return MOBILE_CHECK_IDS.map((id) => deepFreeze({ id, derived: true }));
}

export async function runTask8Mobile({
  binding,
  sourceArchiveSha256,
  evidenceContract,
  stableService,
  stableTrafficState,
  candidateAccess,
  producePrivacyArtifact,
  authorization = null,
  executeBrowserFlow = runPinnedPlaywrightFlow,
  controlledBrowserAdapter = false,
  captureControlPlane,
  inspectScreenshots = validateUniqueScreenshots,
  now = () => new Date(),
} = {}) {
  try {
    if (!RELEASE_SHA.test(binding?.releaseSha) || !IMAGE_DIGEST.test(binding?.imageDigest)
      || !DIGEST.test(sourceArchiveSha256) || typeof producePrivacyArtifact !== 'function'
      || typeof executeBrowserFlow !== 'function'
      || typeof captureControlPlane !== 'function' || containsForbiddenPersistedSecret(candidateAccess)) fail();
    if (executeBrowserFlow !== runPinnedPlaywrightFlow && controlledBrowserAdapter !== true) fail();
    const fixtureBytes = await readFile(FIXTURE_PATH);
    const wav = validateCanonicalWav(fixtureBytes, { expectedSha256: MOBILE_WAV_CONTRACT.sha256 });
    if (wav.durationMs !== MOBILE_WAV_CONTRACT.durationMs) fail();
    const privacyStart = await producePrivacyArtifact('start');
    if (privacyStart?.filePath !== evidenceContract?.privacyProofs?.start?.filePath) fail();
    const before = await captureControlPlane();
    const flow = await executeBrowserFlow({
      candidateOrigin: binding.candidateOrigin,
      authorization,
      fixturePath: FIXTURE_PATH,
      context: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
      },
    });
    const after = await captureControlPlane();
    const privacyEnd = await producePrivacyArtifact('end');
    if (privacyEnd?.filePath !== evidenceContract?.privacyProofs?.end?.filePath) fail();
    if (!exactKeys(before, ['sha256', 'stable']) || !exactKeys(after, ['sha256', 'stable'])
      || before.stable !== true || after.stable !== true || before.sha256 !== after.sha256
      || !DIGEST.test(before.sha256) || flow.finalNavigationUrl !== binding.candidateOrigin
      || JSON.stringify(flow.browser) !== JSON.stringify(MOBILE_BROWSER_CONTRACT)
      || !Array.isArray(flow.network) || flow.network.length < 1 || flow.network.length > 512
      || flow.network.some((item) => !exactKeys(item, [
        'durationMs', 'method', 'path', 'resourceType', 'status',
      ]) || typeof item.path !== 'string' || item.path.length > 512
        || !item.path.startsWith('/') || item.path.includes('?')
        || !['GET', 'POST', 'DELETE'].includes(item.method)
        || !Number.isSafeInteger(item.status)
        || (!((item.status >= 200 && item.status < 300)
          || (item.method === 'GET' && item.status === 404
            && /^\/api\/v1\/voice\/uploads\/[0-9a-f-]{36}$/i.test(item.path))))
        || !Number.isFinite(item.durationMs) || item.durationMs < 0 || item.durationMs > 120_000)) fail();
    const checks = deriveChecks(flow, { controlledBrowserAdapter });
    const screenshotResults = inspectScreenshots(flow.screenshots);
    if (!Array.isArray(screenshotResults) || screenshotResults.length !== 4) fail();
    const screenshotArtifacts = flow.screenshots.map(({ id, bytes }, index) => ({
      id,
      filePath: join(dirname(evidenceContract.filePath), `mobile-${id}.png`),
      contents: Buffer.from(bytes),
      metadata: screenshotResults[index],
    }));
    const screenshots = screenshotArtifacts.map(({ id, filePath, metadata }) => deepFreeze({
      id,
      filePath,
      width: metadata.width,
      height: metadata.height,
      rawSha256: metadata.rawSha256,
      pixelSha256: metadata.pixelSha256,
      colorCount: metadata.colorCount,
      luminanceSpan: metadata.luminanceSpan,
      luminanceVariance: metadata.luminanceVariance,
      dominantRatio: metadata.dominantRatio,
      nonDominantRatio: metadata.nonDominantRatio,
      byteLength: metadata.byteLength,
    }));
    const start = privacyStart.reference;
    const end = privacyEnd.reference;
    const boundarySha256 = start.boundarySha256;
    assertPrivacyReference(start, boundarySha256);
    assertPrivacyReference(end, boundarySha256);
    const record = finalizeTask8MobileRecord({
      schemaVersion: 3,
      gate: 'mobile',
      result: 'pass',
      occurredAt: start.observedAt,
      expiresAt: Date.parse(start.expiresAt) <= Date.parse(end.expiresAt)
        ? start.expiresAt : end.expiresAt,
      commitSha: binding.releaseSha,
      sourceArchiveSha256,
      imageDigest: binding.imageDigest,
      candidateService: binding.candidateService,
      candidateRevision: binding.candidateRevision,
      candidateTag: binding.candidateTag,
      candidateOrigin: binding.candidateOrigin,
      stableService,
      trafficState: 'candidate-service-private-100',
      stableTrafficState,
      trafficPercent: 100,
      privacyProofs: { start, end },
      controlPlane: { stable: true, beforeSha256: before.sha256, afterSha256: after.sha256 },
      browser: MOBILE_BROWSER_CONTRACT,
      fixture: MOBILE_WAV_CONTRACT,
      voiceWitness: flow.voice.witness,
      viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
      access: candidateAccess,
      finalNavigationUrl: flow.finalNavigationUrl,
      checks,
      screenshots,
      network: { eventCount: flow.network.length, traceSha256: canonicalSha256(flow.network) },
    });
    validateTask8MobileRecord(record, {
      binding, sourceArchiveSha256, boundarySha256, candidateAccess, now: now(),
    });
    const contents = `${JSON.stringify(record, null, 2)}\n`;
    const evidence = deepFreeze({
      ...evidenceContract,
      artifactSha256: record.artifactSha256,
      objectSha256: sha256(contents),
      privacyProofs: record.privacyProofs,
    });
    const output = deepFreeze({
      record,
      evidence,
      artifacts: {
        privacyStart,
        privacyEnd,
        screenshots: screenshotArtifacts,
        mobile: {
          filePath: evidenceContract.filePath,
          contents,
          artifactSha256: record.artifactSha256,
          objectSha256: evidence.objectSha256,
        },
      },
    });
    if (containsForbiddenPersistedSecret(output)) fail();
    return output;
  } catch (error) {
    if (error?.code === 'MOBILE_CONTROLLED_EVIDENCE_INVALID') throw error;
    fail();
  }
}
