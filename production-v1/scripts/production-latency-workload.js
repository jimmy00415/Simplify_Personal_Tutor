import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateCanonicalWav } from '../src/media/canonical-wav.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';
export { decodeCanonicalMp3, validateCanonicalMp3 } from '../src/media/canonical-mp3.js';
import { decodeCanonicalMp3 } from '../src/media/canonical-mp3.js';
import {
  createDefaultGcloudAuthenticatedRequest,
  createDefaultGcloudTextExecutor,
} from './gcp-provision.js';

const execFileAsync = promisify(execFile);
const PROJECT = GCP_IDENTITY.projectId;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const REGION = GCP_IDENTITY.region;
const STABLE_SERVICE = GCP_IDENTITY.service;
const CANDIDATE_SERVICE = GCP_IDENTITY.candidateService;
const QA_PRINCIPAL = 'admin@motionexp.com';
const ACCEPTANCE_PRINCIPAL = GCP_IDENTITY.serviceAccounts.acceptance;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CANDIDATE_REVISION = /^hkbuddy-v1-api-candidate-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAMPLE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const REPLY_LANGUAGES = Object.freeze(['en', 'yue-Hant-HK', 'cmn-Hans-CN']);
const DEFAULT_OPERATION_DEADLINE_MS = 30_000;
const DEFAULT_FETCH_DEADLINE_MS = 30_000;
const DEFAULT_POLL_DEADLINE_MS = 30_000;
const DEFAULT_REQUEST_DEADLINE_MS = 45_000;
const DEFAULT_COMMAND_DEADLINE_MS = 20 * 60_000;
const CONTROL_PLANE_RECEIPT_ATTEMPTS = 13;
const CONTROL_PLANE_RECEIPT_DELAY_MS = 5_000;
const MAX_DEADLINE_MS = 60 * 60_000;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const MAX_MEDIA_BODY_BYTES = 4 * 1024 * 1024;
const productionRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultArtifactDirectory = join(productionRoot, 'reports', 'latency');

export const LATENCY_ACCEPTANCE_CONTRACT = Object.freeze({
  schemaVersion: 5,
  text: {
    sessions: 20,
    turns: 200,
    turnsPerSession: 10,
    concurrency: 5,
    promptMix: { grounded: 80, abstention: 60, casual: 60 },
    voiceModeTurns: 31,
  },
  asr: {
    requests: 30,
    concurrency: 5,
    durationBucketsSeconds: { 10: 10, 30: 10, 55: 10 },
    languages: { cantonese: 10, english: 10, mandarin: 10 },
    wireLanguages: ['en', 'yue-Hant-HK', 'cmn-Hans-CN'],
  },
  tts: { requests: 31, successfulRequests: 30, controlledProviderFailures: 1, concurrency: 5 },
  thresholdsMs: {
    sendAckP95: 300,
    processingVisibleP95: 500,
    groundedResponseP50: 2_500,
    groundedResponseP95: 6_000,
    asr10P50: 2_500,
    asr10P95: 4_000,
    asr30P95: 6_000,
    asr55P95: 6_000,
    ttsReadyP50: 2_500,
    ttsReadyP95: 5_000,
  },
});

const PROMPTS = Object.freeze([
  { promptClass: 'grounded', text: 'How do I activate my SSOid?', expectedGrounding: { claimId: 'evidence.ito.account.student-activation', evidenceId: 'evidence.ito.account.student-activation', sourceId: 'hkbu.ito.account', url: 'https://ito.hkbu.edu.hk/services/account-password.html' } },
  { promptClass: 'grounded', text: 'What food outlets are at JC³?', expectedGrounding: { claimId: 'evidence.eo.dining-inventory.jc3', evidenceId: 'evidence.eo.dining-inventory.jc3', sourceId: 'hkbu.eo.dining-overview', url: 'https://eo.hkbu.edu.hk/eo-services/services-facilities/Catering-Services.html' } },
  { promptClass: 'grounded', text: 'Where can I use my student e-Card?', expectedGrounding: { claimId: 'evidence.ar.student-e-card.listed-facilities-only', evidenceId: 'evidence.ar.student-e-card.listed-facilities-only', sourceId: 'hkbu.ar.student-e-card', url: 'https://ar.hkbu.edu.hk/student-services/useful-information/student-e-card' } },
  { promptClass: 'grounded', text: 'How do I set up Duo on a new phone?', expectedGrounding: { claimId: 'evidence.ito.duo.new-phone', evidenceId: 'evidence.ito.duo.new-phone', sourceId: 'hkbu.ito.duo', url: 'https://ito.hkbu.edu.hk/services/it-security/mfa.html' } },
  { promptClass: 'abstention', text: 'Where can I rent a purple submarine on campus?' },
  { promptClass: 'abstention', text: 'Does HKBU provide free helicopter rides?' },
  { promptClass: 'abstention', text: 'What is the exact queue length at every canteen right now?' },
  { promptClass: 'casual', text: 'Hello, what can you help me with?' },
  { promptClass: 'casual', text: 'Thank you for helping me.' },
  { promptClass: 'casual', text: 'Tell me a short study tip.' },
]);

function deadlineValue(value, fallback) {
  const selected = value === undefined ? fallback : value;
  return Number.isSafeInteger(selected) && selected > 0 && selected <= MAX_DEADLINE_MS
    ? selected
    : null;
}

function deadlineError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deadlineReason(signal, fallbackCode) {
  return signal?.reason instanceof Error ? signal.reason : deadlineError(fallbackCode);
}

function createDeadlineSignal({ timeoutMs, code, parentSignal = null }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deadlineReason(parentSignal, code));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = controller.signal.aborted ? null : setTimeout(() => {
    controller.abort(deadlineError(code));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function withDeadline(operation, { timeoutMs, code, parentSignal = null } = {}) {
  const deadline = createDeadlineSignal({ timeoutMs, code, parentSignal });
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(deadlineReason(deadline.signal, code));
    if (deadline.signal.aborted) rejectOnAbort();
    else deadline.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(deadline.signal)),
      aborted,
    ]);
  } finally {
    deadline.signal.removeEventListener('abort', rejectOnAbort);
    deadline.dispose();
  }
}

function defaultPollSleep(milliseconds, { signal } = {}) {
  return new Promise((resolveSleep, rejectSleep) => {
    let timer = null;
    const abort = () => {
      if (timer !== null) clearTimeout(timer);
      rejectSleep(deadlineReason(signal, 'LATENCY_POLL_DEADLINE_EXCEEDED'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolveSleep();
    }, milliseconds);
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 16 * 1024
    || /\s/.test(token) || token.split('.').length !== 3) return null;
  try {
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (header?.alg !== 'RS256' || header?.typ !== 'JWT' || !signaturePart
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch { return null; }
}

function authenticatedAccess(token, { audience, taggedUrl, now }) {
  const payload = decodeJwtPayload(token);
  const nowSeconds = Math.floor(new Date(now).getTime() / 1_000);
  const issuer = payload?.iss;
  if (!payload || !Number.isFinite(nowSeconds)
    || !['accounts.google.com', 'https://accounts.google.com'].includes(issuer)
    || payload.aud !== audience || payload.email !== ACCEPTANCE_PRINCIPAL
    || typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 256
    || payload.email_verified === false
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.iat > nowSeconds + 60 || payload.exp <= nowSeconds || payload.exp - payload.iat > 3_700) return null;
  return Object.freeze({
    authenticated: true,
    audience,
    issuer: issuer === 'accounts.google.com' ? 'https://accounts.google.com' : issuer,
    subjectSha256: sha256(payload.email),
    taggedUrl,
  });
}

export async function mintGcloudIdentityToken({
  audience, signal, environment = process.env, request,
} = {}) {
  if (typeof audience !== 'string' || !audience.startsWith('https://') || signal?.aborted) {
    throw new Error('identity token request is invalid');
  }
  const authenticatedRequest = request ?? createDefaultGcloudAuthenticatedRequest({
    environment,
    account: QA_PRINCIPAL,
  });
  if (typeof authenticatedRequest !== 'function'
    || typeof authenticatedRequest.getPrincipal !== 'function'
    || await authenticatedRequest.getPrincipal(signal) !== QA_PRINCIPAL) {
    throw new Error('identity token request principal is invalid');
  }
  const response = await authenticatedRequest({
    method: 'POST',
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(ACCEPTANCE_PRINCIPAL)}:generateIdToken`,
    body: { audience, includeEmail: true },
    signal,
  });
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || Object.keys(response).length !== 1) throw new Error('identity token response is invalid');
  const token = response.token;
  if (!token || /[\r\n\s]/.test(token)) throw new Error('identity token response is invalid');
  return token;
}

export async function readGcloudControlPlaneReceipts({
  acceptanceWindowId, candidateOrigin, candidateRevision, occurredAt,
}, { signal, executeFile = execFileAsync, environment = process.env } = {}) {
  const userAgent = `hkbuddy-v1-acceptance/${acceptanceWindowId}`;
  const filter = [
    'resource.type="cloud_run_revision"',
    `logName="projects/${PROJECT}/logs/run.googleapis.com%2Frequests"`,
    `resource.labels.project_id="${PROJECT}"`,
    `resource.labels.location="${REGION}"`,
    `resource.labels.service_name="${CANDIDATE_SERVICE}"`,
    `resource.labels.revision_name="${candidateRevision}"`,
    'httpRequest.requestMethod="POST"',
    `httpRequest.requestUrl="${candidateOrigin}/api/v1/messages"`,
    'httpRequest.status=202',
    `httpRequest.userAgent="${userAgent}"`,
    `timestamp>="${occurredAt}"`,
  ].join(' AND ');
  const executeGcloud = createDefaultGcloudTextExecutor({ environment, execFile: executeFile });
  const stdout = await executeGcloud([
    'logging', 'read', filter, `--project=${PROJECT}`, '--order=asc', '--limit=201', '--format=json',
  ], { maxBuffer: 4 * 1024 * 1024, signal });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('control-plane workload receipts are invalid');
  return parsed;
}

export function normalizeControlPlaneTurnReceipts(entries, {
  acceptanceWindowId, candidateOrigin, candidateRevision, expectedTraceIds,
} = {}) {
  const userAgent = `hkbuddy-v1-acceptance/${acceptanceWindowId}`;
  if (!SHA256.test(String(acceptanceWindowId ?? ''))
    || !CANDIDATE_REVISION.test(String(candidateRevision ?? ''))
    || !Array.isArray(expectedTraceIds) || expectedTraceIds.length !== 200
    || expectedTraceIds.some((value) => !/^[0-9a-f]{32}$/.test(String(value ?? '')))
    || new Set(expectedTraceIds).size !== 200
    || typeof candidateOrigin !== 'string' || !Array.isArray(entries) || entries.length !== 200) return null;
  const normalized = [];
  for (const value of entries) {
    const labels = value?.resource?.labels;
    const request = value?.httpRequest;
    const latency = /^([0-9]+(?:\.[0-9]{1,9})?)s$/.exec(String(request?.latency ?? ''));
    const latencyMs = latency ? Number(latency[1]) * 1_000 : NaN;
    if (value?.resource?.type !== 'cloud_run_revision'
      || labels?.project_id !== PROJECT || labels?.location !== REGION
      || labels?.service_name !== CANDIDATE_SERVICE || labels?.revision_name !== candidateRevision
      || request?.requestMethod !== 'POST' || request?.requestUrl !== `${candidateOrigin}/api/v1/messages`
      || request?.userAgent !== userAgent || Number(request?.status) !== 202
      || typeof value?.insertId !== 'string' || value.insertId.length < 1 || value.insertId.length > 256
      || typeof value?.trace !== 'string' || !new RegExp(`^projects/${PROJECT}/traces/[0-9a-f]{32}$`, 'i').test(value.trace)
      || typeof value?.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))
      || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60_000) return null;
    normalized.push({
      insertId: value.insertId,
      latencyMs,
      status: 202,
      timestamp: new Date(value.timestamp).toISOString(),
      trace: value.trace,
    });
  }
  normalized.sort((left, right) => (
    left.timestamp.localeCompare(right.timestamp) || left.insertId.localeCompare(right.insertId)
  ));
  if (new Set(normalized.map(({ insertId }) => insertId)).size !== 200
    || new Set(normalized.map(({ trace }) => trace)).size !== 200
    || !expectedTraceIds.every((traceId) => normalized.some(({ trace }) => (
      trace === `projects/${PROJECT}/traces/${traceId}`
    )))) return null;
  return Object.freeze(normalized.map((value, index) => Object.freeze({ sequence: index + 1, ...value })));
}

export function finalizeLatencyAcceptanceRecord(record) {
  const { artifactSha256: ignored, ...payload } = record;
  void ignored;
  return {
    ...payload,
    artifactSha256: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
  };
}

function nearestRank(values, percentile) {
  if (!Array.isArray(values)) throw new TypeError('latency samples must be an array');
  if (values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('latency samples must contain finite non-negative numbers');
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(percentile * ordered.length) - 1];
}

export function nearestRankP50(values) { return nearestRank(values, 0.5); }
export function nearestRankP95(values) { return nearestRank(values, 0.95); }

function exactArguments(argv) {
  if (!Array.isArray(argv)
    || argv.length !== 5
    || argv[0] !== '--candidate-origin'
    || typeof argv[1] !== 'string'
    || argv[2] !== '--asr-manifest'
    || typeof argv[3] !== 'string'
    || !isAbsolute(argv[3])
    || extname(argv[3]).toLowerCase() !== '.json'
    || argv[4] !== '--confirm-approved-candidate') return null;
  return { candidateOrigin: argv[1], asrManifestPath: argv[3] };
}

function safeCandidateOrigin(value, { commitSha, stableOrigin, configuredCandidateOrigin } = {}) {
  let url;
  try { url = new URL(value); } catch { return null; }
  let stable;
  try { stable = new URL(stableOrigin); } catch { return null; }
  const expectedStable = `https://${STABLE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
  if (stable.origin !== stableOrigin || stable.protocol !== 'https:' || stableOrigin !== expectedStable) return null;
  const expected = `https://candidate-${String(commitSha).slice(0, 12)}---${CANDIDATE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
  if (url.protocol !== 'https:'
    || value !== url.origin
    || url.username || url.password || url.port
    || value !== expected || configuredCandidateOrigin !== expected) return null;
  return url.origin;
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'));
}

function fixtureDescriptor(sample) {
  return {
    byteLength: sample.byteLength,
    durationBucketSeconds: sample.durationBucketSeconds,
    durationMs: sample.durationMs,
    id: sample.id,
    language: sample.language,
    sha256: sample.sha256,
  };
}

function validateFixtureSet(samples) {
  if (!Array.isArray(samples) || samples.length !== LATENCY_ACCEPTANCE_CONTRACT.asr.requests) return null;
  const ids = new Set();
  const combinations = new Map();
  const safeSamples = [];
  for (const sample of samples) {
    const bytes = sample?.bytes;
    const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : -1;
    if (!SAMPLE_ID.test(String(sample?.id ?? '')) || ids.has(sample.id)
      || !['cantonese', 'english', 'mandarin'].includes(sample?.language)
      || ![10, 30, 55].includes(sample?.durationBucketSeconds)
      || !Number.isFinite(sample?.durationMs)
      || Math.abs(sample.durationMs - sample.durationBucketSeconds * 1_000) > 1_000
      || !SHA256.test(String(sample?.sha256 ?? ''))
      || !Number.isSafeInteger(sample?.byteLength) || sample.byteLength <= 44
      || byteLength !== sample.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== sample.sha256) return null;
    ids.add(sample.id);
    const combination = `${sample.durationBucketSeconds}:${sample.language}`;
    combinations.set(combination, (combinations.get(combination) ?? 0) + 1);
    safeSamples.push({ ...fixtureDescriptor(sample), bytes });
  }
  for (const duration of [10, 30, 55]) {
    const count = [...combinations.entries()]
      .filter(([combination]) => combination.startsWith(`${duration}:`))
      .reduce((sum, [, value]) => sum + value, 0);
    if (count !== LATENCY_ACCEPTANCE_CONTRACT.asr.durationBucketsSeconds[duration]) return null;
  }
  for (const language of ['cantonese', 'english', 'mandarin']) {
    const count = [...combinations.entries()]
      .filter(([combination]) => combination.endsWith(`:${language}`))
      .reduce((sum, [, value]) => sum + value, 0);
    if (count !== LATENCY_ACCEPTANCE_CONTRACT.asr.languages[language]) return null;
  }
  const descriptors = safeSamples.map(fixtureDescriptor).sort((left, right) => left.id.localeCompare(right.id));
  return {
    samples: safeSamples,
    fixtureSetSha256: createHash('sha256').update(canonicalJson(descriptors)).digest('hex'),
  };
}

async function defaultLoadAsrFixtures(manifestPath, { signal } = {}) {
  const raw = await readFile(manifestPath, { encoding: 'utf8', signal });
  if (raw.length > 128 * 1_024) throw new Error('fixture manifest too large');
  const manifest = JSON.parse(raw);
  if (!exactKeys(manifest, ['samples', 'schemaVersion'])
    || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.samples)
    || manifest.samples.length !== LATENCY_ACCEPTANCE_CONTRACT.asr.requests) {
    throw new Error('invalid fixture manifest');
  }
  const samples = [];
  for (const entry of manifest.samples) {
    if (signal?.aborted) throw deadlineReason(signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    if (!exactKeys(entry, ['durationBucketSeconds', 'filePath', 'id', 'language', 'sha256'])
      || !isAbsolute(entry.filePath)
      || extname(entry.filePath).toLowerCase() !== '.wav') throw new Error('invalid fixture entry');
    const bytes = await readFile(entry.filePath, { signal });
    const wav = validateCanonicalWav(bytes, { expectedSha256: entry.sha256 });
    samples.push({
      id: entry.id,
      language: entry.language,
      durationBucketSeconds: entry.durationBucketSeconds,
      durationMs: wav.durationMs,
      byteLength: wav.byteLength,
      sha256: wav.sha256,
      bytes: wav.buffer,
    });
  }
  return samples;
}

export async function inspectGitState(cwd, { signal, executeFile = execFileAsync } = {}) {
  const headResult = await executeFile('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1_024, signal,
  });
  const statusResult = await executeFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1_024, signal,
  });
  return {
    head: headResult.stdout.replace(/[\r\n]+$/, ''),
    clean: statusResult.stdout.length === 0,
  };
}

async function defaultWriteArtifact({ filePath, contents }, { signal } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx', signal });
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function finiteLatency(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function latencyMetric(values, expectedCount, { p50 = null, p95 } = {}) {
  const samples = values.filter((value) => finiteLatency(value) !== null);
  const p50Ms = nearestRankP50(samples);
  const p95Ms = nearestRankP95(samples);
  return {
    sampleCount: samples.length,
    ...(p50 !== null ? { p50Ms, p50ThresholdMs: p50 } : {}),
    p95Ms,
    p95ThresholdMs: p95,
    pass: samples.length === expectedCount
      && p95Ms !== null && p95Ms <= p95
      && (p50 === null || (p50Ms !== null && p50Ms <= p50)),
  };
}

function normalizeTextResult(value) {
  const acknowledged = value?.acknowledged === true;
  const processingVisible = value?.processingVisible === true;
  const delivered = value?.delivered === true;
  return {
    acknowledged,
    ackMs: acknowledged ? finiteLatency(value?.ackMs) : null,
    processingVisible,
    processingVisibleMs: processingVisible ? finiteLatency(value?.processingVisibleMs) : null,
    delivered,
    finalAnswerMs: delivered ? finiteLatency(value?.finalAnswerMs) : null,
    messageLost: acknowledged && value?.messageLost === true,
    duplicateAssistantReplyCount: Math.max(0, nonNegativeInteger(value?.assistantReplyCount, 0) - 1),
    unsupportedVerifiedClaimCount: nonNegativeInteger(value?.unsupportedVerifiedClaimCount, 0),
    requestStatus: nonNegativeInteger(value?.requestStatus, 0),
    requestId: UUID.test(String(value?.requestId ?? '')) ? value.requestId.toLowerCase() : null,
    responseStatus: nonNegativeInteger(value?.responseStatus, 0),
    responseRequestId: UUID.test(String(value?.responseRequestId ?? ''))
      ? value.responseRequestId.toLowerCase() : null,
    groundingSatisfied: value?.groundingSatisfied === true,
    groundingVerified: value?.groundingVerified === true,
    groundingEvidenceSha256: SHA256.test(String(value?.groundingEvidenceSha256 ?? ''))
      ? value.groundingEvidenceSha256 : null,
    replyMode: value?.replyMode === 'voice' ? 'voice' : 'text',
    assistantMessageId: delivered && typeof value?.assistantMessageId === 'string' && value.assistantMessageId
      ? value.assistantMessageId : null,
  };
}

function normalizeAsrResult(value, expected = {}) {
  const ready = value?.ready === true;
  return {
    ready,
    correlationId: expected.correlationId ?? null,
    bindingId: expected.bindingId ?? null,
    durationMs: Number.isFinite(expected.durationMs) ? expected.durationMs : null,
    durationBucketSeconds: [10, 30, 55].includes(expected.durationBucketSeconds)
      ? expected.durationBucketSeconds : null,
    requestStatus: nonNegativeInteger(value?.requestStatus, 0),
    requestId: UUID.test(String(value?.requestId ?? '')) ? value.requestId.toLowerCase() : null,
    responseStatus: nonNegativeInteger(value?.responseStatus, 0),
    responseRequestId: UUID.test(String(value?.responseRequestId ?? ''))
      ? value.responseRequestId.toLowerCase() : null,
  };
}

function normalizeTtsResult(value, expected = {}) {
  const ready = value?.ready === true;
  return {
    ready,
    correlationId: expected.correlationId ?? null,
    bindingId: expected.bindingId ?? null,
    durationMs: null,
    expectedProviderFailure: expected.expectedProviderFailure === true,
    providerFailureObserved: value?.providerFailureObserved === true,
    failureCode: typeof value?.failureCode === 'string' ? value.failureCode : null,
    textAvailable: value?.textAvailable === true,
    mediaValidated: value?.mediaValidated === true,
    messageIdMatches: value?.messageIdMatches === true,
    requestStatus: nonNegativeInteger(value?.requestStatus, 0),
    requestId: UUID.test(String(value?.requestId ?? '')) ? value.requestId.toLowerCase() : null,
    responseStatus: nonNegativeInteger(value?.responseStatus, 0),
    responseRequestId: UUID.test(String(value?.responseRequestId ?? ''))
      ? value.responseRequestId.toLowerCase() : null,
  };
}

const RETRY_SAFE_OPERATIONS = new Set(['asr', 'timings', 'tts', 'verifyCandidate']);

export async function safeRequest(requester, input, {
  parentSignal = null,
  requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS,
} = {}) {
  try {
    const result = await withDeadline(
      async (signal) => {
        const maximumAttempts = RETRY_SAFE_OPERATIONS.has(input?.operation) ? 2 : 1;
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
          try {
            return await requester(input, { signal });
          } catch (error) {
            if (signal.aborted) throw deadlineReason(signal, 'LATENCY_REQUEST_DEADLINE_EXCEEDED');
            if (attempt === maximumAttempts) throw error;
          }
        }
        return null;
      },
      {
        timeoutMs: requestDeadlineMs,
        code: 'LATENCY_REQUEST_DEADLINE_EXCEEDED',
        parentSignal,
      },
    );
    return result && typeof result === 'object' ? result : null;
  } catch {
    if (parentSignal?.aborted) {
      throw deadlineReason(parentSignal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    return null;
  }
}

function exactCapabilities(value, commitSha) {
  return Boolean(value && typeof value === 'object'
    && value.releaseCommitSha === commitSha
    && value.productionReady === true
    && value.voiceInput === true
    && value.voiceOutput === true);
}

function releaseMatches(value, commitSha) {
  return value?.releaseCommitSha === commitSha;
}

function timingQueryDigest({ releaseCommitSha, windowId, sessionId }) {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 2, releaseCommitSha, windowId, sessionId,
  })).digest('hex');
}

function normalizeTimingQuery(value, { commitSha, acceptanceWindowId, sessionId }) {
  if (!value || value.schemaVersion !== 2
    || value.releaseCommitSha !== commitSha
    || value.windowId !== acceptanceWindowId
    || value.queryDigest !== timingQueryDigest({ releaseCommitSha: commitSha, windowId: acceptanceWindowId, sessionId })
    || !Array.isArray(value.samples)) return null;
  const samples = [];
  for (const sample of value.samples) {
    if (!exactKeys(sample, [
      'bindingId', 'correlationId', 'durationMs', 'failureCode',
      'latencyMs', 'layer', 'operation', 'outcome',
    ])
      || !/^[0-9a-f-]{36}$/i.test(String(sample.correlationId ?? ''))
      || !/^[0-9a-z][0-9a-z._-]{0,127}$/i.test(String(sample.bindingId ?? ''))
      || !['text', 'asr', 'tts'].includes(sample.operation)
      || !['provider', 'server'].includes(sample.layer)
      || !['success', 'failure'].includes(sample.outcome)
      || (sample.operation === 'asr'
        ? !Number.isFinite(sample.durationMs) || sample.durationMs <= 0 || sample.durationMs > 60_000
        : sample.durationMs !== null)
      || (sample.outcome === 'success'
        ? sample.failureCode !== null
        : !/^[A-Z][A-Z0-9_]{0,79}$/.test(String(sample.failureCode ?? '')))
      || finiteLatency(sample.latencyMs) === null) return null;
    samples.push({
      correlationId: sample.correlationId.toLowerCase(),
      bindingId: sample.bindingId,
      durationMs: sample.durationMs,
      operation: sample.operation,
      layer: sample.layer,
      latencyMs: sample.latencyMs,
      outcome: sample.outcome,
      failureCode: sample.failureCode,
    });
  }
  return { queryDigest: value.queryDigest, samples };
}

function timingObservation(samples, operation, layer, expectedCount) {
  const values = samples
    .filter((sample) => sample.operation === operation && sample.layer === layer && sample.outcome === 'success')
    .map((sample) => finiteLatency(sample.latencyMs))
    .filter((value) => value !== null);
  return {
    available: values.length === expectedCount,
    sampleCount: values.length,
    p50Ms: nearestRankP50(values),
    p95Ms: nearestRankP95(values),
  };
}

function correlatedTimingPairs(samples, expected, operation) {
  const operationSamples = samples.filter((sample) => sample.operation === operation);
  const expectedKeys = new Set();
  const pairs = [];
  for (const item of expected) {
    const key = `${item.correlationId}\0${item.bindingId}`;
    if (expectedKeys.has(key)) continue;
    expectedKeys.add(key);
    const expectedOutcome = item.expectedProviderFailure === true ? 'failure' : 'success';
    const expectedFailureCode = expectedOutcome === 'failure' ? 'VOICE_SYNTHESIS_REJECTED' : null;
    const matched = operationSamples.filter((sample) => (
      sample.correlationId === item.correlationId
      && sample.bindingId === item.bindingId
    ));
    const provider = matched.find(({ layer }) => layer === 'provider');
    const server = matched.find(({ layer }) => layer === 'server');
    if (matched.length !== 2 || !provider || !server
      || provider.outcome !== expectedOutcome || server.outcome !== expectedOutcome
      || provider.failureCode !== expectedFailureCode || server.failureCode !== expectedFailureCode
      || provider.durationMs !== item.durationMs || server.durationMs !== item.durationMs) continue;
    pairs.push({
      ...item,
      outcome: expectedOutcome,
      providerLatencyMs: provider.latencyMs,
      serverLatencyMs: server.latencyMs,
    });
  }
  return {
    available: expectedKeys.size === expected.length
      && pairs.length === expected.length
      && operationSamples.length === expected.length * 2,
    pairs,
  };
}

function correlatedTextTimings(samples, expected) {
  const operationSamples = samples.filter((sample) => sample.operation === 'text');
  const expectedKeys = new Set();
  const serverSamples = [];
  const providerSamples = [];
  const providerPairs = [];
  let expectedProviderCount = 0;
  for (const item of expected) {
    const correlationId = String(item?.correlationId ?? '').toLowerCase();
    const bindingId = String(item?.bindingId ?? '');
    const key = `${correlationId}\0${bindingId}`;
    if (!/^[0-9a-f-]{36}$/.test(correlationId)
      || !/^[0-9a-z][0-9a-z._-]{0,127}$/i.test(bindingId)
      || expectedKeys.has(key)) continue;
    expectedKeys.add(key);
    const providerExpected = item.expectedProvider === true;
    if (providerExpected) expectedProviderCount += 1;
    const matched = operationSamples.filter((sample) => (
      sample.correlationId === correlationId && sample.bindingId === bindingId
    ));
    const servers = matched.filter(({ layer }) => layer === 'server');
    const providers = matched.filter(({ layer }) => layer === 'provider');
    const server = servers[0];
    const provider = providers[0];
    const serverValid = servers.length === 1
      && server.outcome === 'success' && server.failureCode === null && server.durationMs === null;
    const providerValid = providerExpected
      ? providers.length === 1
        && provider.outcome === 'success' && provider.failureCode === null && provider.durationMs === null
      : providers.length === 0;
    if (!serverValid || !providerValid) continue;
    serverSamples.push(server);
    if (providerExpected) {
      providerSamples.push(provider);
      providerPairs.push({
        correlationId,
        bindingId,
        providerLatencyMs: provider.latencyMs,
        serverLatencyMs: server.latencyMs,
      });
    }
  }
  return {
    available: expectedKeys.size === expected.length
      && serverSamples.length === expected.length
      && providerSamples.length === expectedProviderCount
      && operationSamples.length === expected.length + expectedProviderCount,
    expectedServerCount: expected.length,
    serverSamples,
    expectedProviderCount,
    providerSamples,
    providerPairs,
  };
}

function buildRawReceipts({
  acceptanceWindowId, textOperational, asrResults, ttsResults, timingQueries,
  controlPlaneRequests, releaseBinding,
}) {
  const textTurns = textOperational.map((item, index) => ({
    sequence: index + 1,
    sessionIndex: item.sessionIndex,
    turnIndex: item.turnIndex,
    sessionIdSha256: typeof item.session?.id === 'string' && item.session.id
      ? sha256(item.session.id) : null,
    clientMessageId: item.clientMessageId,
    correlationId: item.correlationId,
    traceId: item.traceId,
    controlledTtsFailure: item.controlledTtsFailure,
    promptClass: item.normalized.promptClass,
    replyLanguage: item.normalized.replyLanguage,
    replyMode: item.normalized.replyMode,
    acknowledged: item.normalized.acknowledged,
    ackMs: item.normalized.ackMs,
    processingVisible: item.normalized.processingVisible,
    processingVisibleMs: item.normalized.processingVisibleMs,
    delivered: item.normalized.delivered,
    finalAnswerMs: item.normalized.finalAnswerMs,
    messageLost: item.normalized.messageLost,
    duplicateAssistantReplyCount: item.normalized.duplicateAssistantReplyCount,
    unsupportedVerifiedClaimCount: item.normalized.unsupportedVerifiedClaimCount,
    assistantMessageId: item.normalized.assistantMessageId,
    requestStatus: item.normalized.requestStatus,
    requestId: item.normalized.requestId,
    responseStatus: item.normalized.responseStatus,
    responseRequestId: item.normalized.responseRequestId,
    groundingSatisfied: item.normalized.groundingSatisfied,
    groundingVerified: item.normalized.groundingVerified,
    groundingEvidenceSha256: item.normalized.groundingEvidenceSha256,
  }));
  const asrRequests = asrResults.map((item, index) => ({ sequence: index + 1, ...item }));
  const ttsRequests = ttsResults.map((item, index) => ({ sequence: index + 1, ...item }));
  const normalizedTimingQueries = timingQueries.map((item, index) => ({
    sequence: index + 1,
    sessionIndex: index,
    queryDigest: item?.queryDigest ?? null,
    samples: item?.samples ?? [],
  }));
  const payload = {
    schemaVersion: 2,
    acceptanceWindowId,
    candidateService: releaseBinding.candidateService,
    stableService: releaseBinding.stableService,
    trafficState: releaseBinding.trafficState,
    stableTrafficState: releaseBinding.stableTrafficState,
    textTurns,
    asrRequests,
    ttsRequests,
    timingQueries: normalizedTimingQueries,
    controlPlaneRequests,
  };
  return Object.freeze({ ...payload, receiptsSha256: sha256(canonicalJson(payload)) });
}

function acceptanceRecord({
  commitSha, candidateOrigin, fixtureSetSha256, occurredAt,
  sessions, textResults, asrResults, ttsResults, timingSamples, timingQueryDigests,
  rawReceipts, access, releaseBinding,
}) {
  const thresholds = LATENCY_ACCEPTANCE_CONTRACT.thresholdsMs;
  const textTimings = correlatedTextTimings(timingSamples, textResults);
  const asrPairs = correlatedTimingPairs(timingSamples, asrResults, 'asr');
  const ttsPairs = correlatedTimingPairs(timingSamples, ttsResults, 'tts');
  const successfulTtsPairs = ttsPairs.pairs.filter(({ outcome }) => outcome === 'success');
  const failedTtsPairs = ttsPairs.pairs.filter(({ outcome }) => outcome === 'failure');
  const metrics = {
    sendAck: latencyMetric(textResults.map((item) => item.ackMs), 200, { p95: thresholds.sendAckP95 }),
    processingVisible: latencyMetric(textResults.map((item) => item.processingVisibleMs), 200, { p95: thresholds.processingVisibleP95 }),
    groundedResponse: latencyMetric(
      textResults.filter((item) => item.promptClass === 'grounded').map((item) => item.finalAnswerMs),
      LATENCY_ACCEPTANCE_CONTRACT.text.promptMix.grounded,
      { p50: thresholds.groundedResponseP50, p95: thresholds.groundedResponseP95 },
    ),
    asr10: latencyMetric(asrPairs.pairs.filter((item) => item.durationBucketSeconds === 10).map((item) => item.serverLatencyMs), 10, { p50: thresholds.asr10P50, p95: thresholds.asr10P95 }),
    asr30: latencyMetric(asrPairs.pairs.filter((item) => item.durationBucketSeconds === 30).map((item) => item.serverLatencyMs), 10, { p95: thresholds.asr30P95 }),
    asr55: latencyMetric(asrPairs.pairs.filter((item) => item.durationBucketSeconds === 55).map((item) => item.serverLatencyMs), 10, { p95: thresholds.asr55P95 }),
    ttsReady: latencyMetric(successfulTtsPairs.map((item) => item.serverLatencyMs), 30, { p50: thresholds.ttsReadyP50, p95: thresholds.ttsReadyP95 }),
  };
  const invariants = {
    acknowledgedMessageLossCount: textResults.filter((item) => item.messageLost).length,
    duplicateAssistantReplyCount: textResults.reduce((sum, item) => sum + item.duplicateAssistantReplyCount, 0),
    unsupportedVerifiedClaimCount: textResults.reduce((sum, item) => sum + item.unsupportedVerifiedClaimCount, 0),
    ttsFailureTextLossCount: ttsResults.filter((item) => !item.textAvailable).length,
    ttsMediaValidationFailureCount: ttsResults.filter((item) => !item.expectedProviderFailure && !item.mediaValidated).length,
    ttsMessageBindingMismatchCount: ttsResults.filter((item) => !item.messageIdMatches).length,
    controlledTtsProviderFailureMismatchCount: ttsResults.filter((item) => item.expectedProviderFailure && (
      item.ready || !item.providerFailureObserved || item.failureCode !== 'VOICE_SYNTHESIS_REJECTED'
    )).length,
  };
  const counts = {
    sessionsCreated: sessions.filter(Boolean).length,
    textTurnsAttempted: 200,
    textTurnsAcknowledged: textResults.filter((item) => item.acknowledged).length,
    textTurnsDelivered: textResults.filter((item) => item.delivered).length,
    asrRequestsAttempted: 30,
    asrReady: asrResults.filter((item) => item.ready).length,
    ttsRequestsAttempted: 31,
    ttsReady: ttsResults.filter((item) => item.ready).length,
    ttsControlledProviderFailures: ttsResults.filter((item) => (
      item.expectedProviderFailure && item.providerFailureObserved
      && item.failureCode === 'VOICE_SYNTHESIS_REJECTED'
    )).length,
  };
  const expectedTimingCounts = { text: { provider: 80, server: 200 }, asr: { provider: 30, server: 30 }, tts: { provider: 30, server: 30 } };
  const observations = {
    releaseCommitSha: commitSha,
    queryDigests: {
      sampleCount: timingQueryDigests.length,
      values: [...timingQueryDigests].sort(),
      pass: timingQueryDigests.length === 20 && new Set(timingQueryDigests).size === 20,
    },
    provider: {
      text: timingObservation(textTimings.providerSamples, 'text', 'provider', expectedTimingCounts.text.provider),
      asr: timingObservation(timingSamples, 'asr', 'provider', expectedTimingCounts.asr.provider),
      tts: timingObservation(timingSamples, 'tts', 'provider', expectedTimingCounts.tts.provider),
    },
    server: {
      text: timingObservation(textTimings.serverSamples, 'text', 'server', expectedTimingCounts.text.server),
      asr: timingObservation(timingSamples, 'asr', 'server', expectedTimingCounts.asr.server),
      tts: timingObservation(timingSamples, 'tts', 'server', expectedTimingCounts.tts.server),
    },
    pairs: {
      text: {
        available: textTimings.available,
        expectedServerCount: textTimings.expectedServerCount,
        serverBoundCount: textTimings.serverSamples.length,
        expectedProviderCount: textTimings.expectedProviderCount,
        providerPairedCount: textTimings.providerPairs.length,
      },
      asr: { available: asrPairs.available, expectedCount: 30, pairedCount: asrPairs.pairs.length },
      tts: {
        available: ttsPairs.available,
        expectedSuccessCount: 30,
        successPairedCount: successfulTtsPairs.length,
        expectedFailureCount: 1,
        failurePairedCount: failedTtsPairs.length,
      },
    },
  };
  const result = Object.values(metrics).every((metric) => metric.pass)
    && Object.values(invariants).every((count) => count === 0)
    && counts.sessionsCreated === 20
    && counts.textTurnsAcknowledged === 200
    && counts.textTurnsDelivered === 200
    && counts.asrReady === 30
    && counts.ttsReady === 30
    && counts.ttsControlledProviderFailures === 1
    && observations.queryDigests.pass
    && observations.pairs.text.available
    && observations.pairs.asr.available
    && observations.pairs.tts.available
    && ['provider', 'server'].every((layer) => Object.values(observations[layer]).every((item) => item.available));
  return finalizeLatencyAcceptanceRecord({
    schemaVersion: 5,
    commitSha,
    candidateOrigin,
    candidateService: releaseBinding.candidateService,
    stableService: releaseBinding.stableService,
    trafficState: releaseBinding.trafficState,
    stableTrafficState: releaseBinding.stableTrafficState,
    access,
    releaseBinding,
    fixtureSetSha256,
    workload: LATENCY_ACCEPTANCE_CONTRACT,
    counts,
    metrics,
    invariants,
    observations,
    rawReceipts,
    occurredAt,
    result,
  });
}

function sameOriginUrl(origin, path) {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error('cross-origin request refused');
  return url;
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = values.map((value) => value.split(';', 1)[0]).find((value) => value.startsWith('hb_v1_session='));
  return cookie ?? null;
}

function cancelResponseReader(reader) {
  try {
    const cancellation = reader?.cancel?.('bounded response reader stopped');
    void Promise.resolve(cancellation).catch(() => undefined);
  } catch {
    // Cancellation is best effort; the enclosing operation deadline remains authoritative.
  }
}

async function responseJson(response, { signal = null } = {}) {
  const declaredLength = response?.headers?.get?.('content-length');
  if (/^\d+$/.test(String(declaredLength ?? '').trim())
    && Number(declaredLength) > MAX_RESPONSE_BODY_BYTES) {
    cancelResponseReader(response?.body);
    throw new Error('response too large');
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new Error('response body unavailable');
  }

  const reader = response.body.getReader();
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => {
      cancelResponseReader(reader);
      reject(deadlineReason(signal, 'LATENCY_HTTP_DEADLINE_EXCEEDED'));
    };
    if (signal?.aborted) rejectOnAbort();
    else signal?.addEventListener('abort', rejectOnAbort, { once: true });
  });
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        cancelResponseReader(reader);
        throw new Error('invalid response body');
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        cancelResponseReader(reader);
        throw new Error('response too large');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    signal?.removeEventListener('abort', rejectOnAbort);
    try { reader.releaseLock(); } catch { /* A pending read owns the lock until cancellation settles. */ }
  }
  const text = Buffer.concat(chunks, totalBytes).toString('utf8');
  const value = JSON.parse(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

async function responseBytes(response, { signal = null, maximumBytes = MAX_MEDIA_BODY_BYTES } = {}) {
  const declaredLength = response?.headers?.get?.('content-length');
  if (/^\d+$/.test(String(declaredLength ?? '').trim()) && Number(declaredLength) > maximumBytes) {
    cancelResponseReader(response?.body);
    throw new Error('media response too large');
  }
  if (!response?.body || typeof response.body.getReader !== 'function') throw new Error('media body unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        cancelResponseReader(reader);
        throw deadlineReason(signal, 'LATENCY_HTTP_DEADLINE_EXCEEDED');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('invalid media body');
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        cancelResponseReader(reader);
        throw new Error('media response too large');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* cancellation may still own the reader */ }
  }
  return Buffer.concat(chunks, totalBytes);
}

function exactGroundingCitation(citation, expectedGrounding) {
  if (!expectedGrounding
    || expectedGrounding.claimId !== expectedGrounding.evidenceId
    || citation?.evidenceId !== expectedGrounding.evidenceId
    || citation?.sourceId !== expectedGrounding.sourceId
    || citation?.url !== expectedGrounding.url) return false;
  try {
    const url = new URL(citation?.url);
    const host = url.hostname.toLowerCase();
    return citation?.status === 'verified'
      && url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (host === 'hkbu.edu.hk' || host.endsWith('.hkbu.edu.hk'));
  } catch {
    return false;
  }
}

function exactGroundingResponse(assistant, promptClass, expectedGrounding) {
  const citations = Array.isArray(assistant?.citations) ? assistant.citations : [];
  if (promptClass !== 'grounded') {
    return assistant?.groundingStatus !== 'verified' && citations.length === 0;
  }
  return assistant?.groundingStatus === 'verified'
    && citations.length === 1
    && exactGroundingCitation(citations[0], expectedGrounding);
}

function retryDelay(response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(50, Math.min(1_000, seconds * 1_000)) : 100;
}

export function createLatencyHttpRequester({
  candidateOrigin,
  identityToken = null,
  acceptanceUserAgent = null,
  fetchImpl = globalThis.fetch,
  monotonicNow = () => performance.now(),
  sleep = defaultPollSleep,
  fetchDeadlineMs = DEFAULT_FETCH_DEADLINE_MS,
  pollDeadlineMs = DEFAULT_POLL_DEADLINE_MS,
} = {}) {
  fetchDeadlineMs = deadlineValue(fetchDeadlineMs, DEFAULT_FETCH_DEADLINE_MS);
  pollDeadlineMs = deadlineValue(pollDeadlineMs, DEFAULT_POLL_DEADLINE_MS);
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function'
    || fetchDeadlineMs === null || pollDeadlineMs === null) throw new Error('fetch unavailable');
  if (identityToken !== null && (typeof identityToken !== 'string' || identityToken.length < 40
    || identityToken.length > 16 * 1024 || /\s/.test(identityToken))) throw new Error('identity token is invalid');
  if (acceptanceUserAgent !== null
    && !/^hkbuddy-v1-acceptance\/[0-9a-f]{64}$/.test(acceptanceUserAgent)) {
    throw new Error('acceptance user agent is invalid');
  }
  const privateHeaders = Object.freeze({
    ...(identityToken === null ? {} : { Authorization: `Bearer ${identityToken}` }),
    ...(acceptanceUserAgent === null ? {} : { 'User-Agent': acceptanceUserAgent }),
  });

  const fetchJson = (path, options = {}, parentSignal = null) => withDeadline(async (signal) => {
    const response = await fetchImpl(sameOriginUrl(candidateOrigin, path), {
      ...options,
      headers: { ...(options.headers ?? {}), ...privateHeaders },
      redirect: 'error',
      signal,
    });
    return { response, body: await responseJson(response, { signal }) };
  }, {
    timeoutMs: fetchDeadlineMs,
    code: 'LATENCY_HTTP_DEADLINE_EXCEEDED',
    parentSignal,
  });

  const fetchRaw = (path, options = {}, parentSignal = null) => withDeadline(async (deadlineSignal) => fetchImpl(
    sameOriginUrl(candidateOrigin, path),
    { ...options, headers: { ...(options.headers ?? {}), ...privateHeaders }, redirect: 'error', signal: deadlineSignal },
  ), {
    timeoutMs: fetchDeadlineMs,
    code: 'LATENCY_HTTP_DEADLINE_EXCEEDED',
    parentSignal,
  });

  const poll = async ({ path, session, inspect, parentSignal = null }) => {
    try {
      return await withDeadline(async (pollSignal) => {
        const startedAt = monotonicNow();
        while (monotonicNow() - startedAt <= pollDeadlineMs) {
          const result = await fetchJson(path, { headers: { Cookie: session.cookie } }, pollSignal);
          const inspected = inspect(result);
          if (inspected?.done) return {
            ...inspected,
            responseStatus: result.response.status,
            responseRequestId: UUID.test(String(result.body?.requestId ?? ''))
              ? result.body.requestId.toLowerCase() : null,
          };
          await sleep(retryDelay(result.response), { signal: pollSignal });
        }
        return { done: true, failed: true };
      }, {
        timeoutMs: pollDeadlineMs,
        code: 'LATENCY_POLL_DEADLINE_EXCEEDED',
        parentSignal,
      });
    } catch (error) {
      if (parentSignal?.aborted) throw deadlineReason(parentSignal, 'LATENCY_REQUEST_DEADLINE_EXCEEDED');
      if (error?.code === 'LATENCY_POLL_DEADLINE_EXCEEDED') return { done: true, failed: true };
      throw error;
    }
  };

  return async function request(input, { signal = null } = {}) {
    if (input.operation === 'bootstrap') {
      const { response, body } = await fetchJson('/api/v1/session', {
        method: 'POST', headers: {
          Origin: candidateOrigin,
          ...(input.clientInstanceId ? { 'X-Client-Instance-Id': input.clientInstanceId } : {}),
        },
      }, signal);
      const cookie = cookieFrom(response);
      return {
        ok: [200, 201].includes(response.status) && Boolean(cookie) && Boolean(body?.data?.session),
        session: cookie ? {
          cookie,
          id: typeof body?.data?.session?.id === 'string' ? body.data.session.id : null,
          sessionIndex: input.sessionIndex,
        } : null,
        capabilities: body?.data?.capabilities ?? null,
      };
    }

    if (input.operation === 'verifyCandidate') {
      const { response, body } = await fetchJson('/api/v1/session', {
        method: 'POST',
        headers: { Origin: candidateOrigin, Cookie: input.session?.cookie ?? '' },
      }, signal);
      return {
        ok: response.status === 200,
        capabilities: body?.data?.capabilities ?? null,
      };
    }

    if (!input.session?.cookie) return null;
    if (input.operation === 'timings') {
      const path = `/api/v1/acceptance/timings?windowId=${encodeURIComponent(input.acceptanceWindowId ?? '')}`;
      const { response, body } = await fetchJson(path, { headers: { Cookie: input.session.cookie } }, signal);
      return response.status === 200 ? body?.data ?? null : null;
    }
    if (input.operation === 'text') {
      const startedAt = monotonicNow();
      const posted = await fetchJson('/api/v1/messages', {
        method: 'POST',
        headers: {
          Origin: candidateOrigin,
          Cookie: input.session.cookie,
          'Content-Type': 'application/json',
          ...(input.acceptanceWindowId ? { 'X-Acceptance-Window-Id': input.acceptanceWindowId } : {}),
          ...(input.correlationId ? { 'X-Acceptance-Correlation-Id': input.correlationId } : {}),
          ...(input.traceId ? { 'X-Cloud-Trace-Context': `${input.traceId}/1;o=1` } : {}),
          ...(input.controlledTtsFailure === true
            ? { 'X-Acceptance-Controlled-TTS-Failure': 'provider-rejection-v1' } : {}),
        },
        body: JSON.stringify({
          clientMessageId: input.clientMessageId,
          text: input.prompt,
          replyLanguage: input.replyLanguage,
          replyMode: input.replyMode,
        }),
      }, signal);
      const acknowledgedAt = monotonicNow();
      const accepted = posted.response.status === 202
        && posted.body?.data?.message?.clientMessageId === input.clientMessageId;
      if (!accepted) return { acknowledged: false };
      const turnId = posted.body.data.turn?.id;
      let processingVisibleMs = null;
      let canonicalUserSeen = false;
      let finalAnswerMs = null;
      let finalMessages = [];
      const final = await poll({
        path: '/api/v1/messages?after=0',
        session: input.session,
        parentSignal: signal,
        inspect({ body }) {
          const data = body?.data;
          const messages = Array.isArray(data?.messages) ? data.messages : [];
          canonicalUserSeen ||= messages.some((message) => message.clientMessageId === input.clientMessageId && message.role === 'user');
          const assistants = messages.filter((message) => message.turnId === turnId && message.role === 'assistant');
          if (processingVisibleMs === null && (data?.activeTurn?.id === turnId || assistants.length > 0)) {
            processingVisibleMs = monotonicNow() - acknowledgedAt;
          }
          if (assistants.some((message) => message.status === 'delivered')) {
            finalAnswerMs = monotonicNow() - acknowledgedAt;
            finalMessages = assistants;
            return { done: true };
          }
          if (data?.activeTurn?.id === turnId && data.activeTurn.state === 'failed') return { done: true, failed: true };
          return { done: false };
        },
      });
      const assistant = finalMessages.find((message) => message.status === 'delivered') ?? null;
      const groundingSatisfied = exactGroundingResponse(
        assistant, input.promptClass, input.expectedGrounding,
      );
      const groundingEvidenceSha256 = sha256(canonicalJson({
        citations: Array.isArray(assistant?.citations) ? assistant.citations.map((citation) => ({
          evidenceId: citation?.evidenceId ?? null,
          sourceId: citation?.sourceId ?? null,
          status: citation?.status ?? null,
          url: citation?.url ?? null,
        })) : [],
        groundingStatus: assistant?.groundingStatus ?? null,
      }));
      return {
        acknowledged: true,
        ackMs: acknowledgedAt - startedAt,
        processingVisible: processingVisibleMs !== null,
        processingVisibleMs,
        delivered: Boolean(assistant) && !final.failed,
        finalAnswerMs,
        messageLost: !canonicalUserSeen,
        assistantReplyCount: finalMessages.length,
        unsupportedVerifiedClaimCount: groundingSatisfied ? 0 : 1,
        assistantMessageId: assistant?.id ?? null,
        requestStatus: posted.response.status,
        requestId: UUID.test(String(posted.body?.requestId ?? '')) ? posted.body.requestId.toLowerCase() : null,
        responseStatus: final.responseStatus ?? 0,
        responseRequestId: final.responseRequestId ?? null,
        groundingSatisfied,
        groundingVerified: assistant?.groundingStatus === 'verified',
        groundingEvidenceSha256,
      };
    }

    if (input.operation === 'asr') {
      let uploadCompletedAt = null;
      const bytes = input.sample.bytes;
      const body = (async function* measuredUpload() {
        yield bytes;
        uploadCompletedAt = monotonicNow();
      }());
      const posted = await fetchJson('/api/v1/voice/transcriptions', {
        method: 'POST', duplex: 'half', body,
        headers: {
          Origin: candidateOrigin,
          Cookie: input.session.cookie,
          'Content-Type': 'audio/wav',
          'Content-Length': String(input.sample.byteLength),
          'X-Client-Upload-Id': input.clientUploadId,
          'X-Content-SHA256': input.sample.sha256,
          'X-ASR-Language': input.responseLanguage,
          ...(input.acceptanceWindowId ? { 'X-Acceptance-Window-Id': input.acceptanceWindowId } : {}),
          ...(input.correlationId ? { 'X-Acceptance-Correlation-Id': input.correlationId } : {}),
        },
      }, signal);
      const inspect = ({ response, body: value }) => {
        if ([200, 201].includes(response.status) && value?.data?.state === 'ready') {
          return { done: true, ready: true };
        }
        if (response.status !== 202) return { done: true, ready: false };
        return { done: false };
      };
      let outcome = inspect(posted);
      if (outcome.done) outcome = {
        ...outcome,
        responseStatus: posted.response.status,
        responseRequestId: UUID.test(String(posted.body?.requestId ?? ''))
          ? posted.body.requestId.toLowerCase() : null,
      };
      if (!outcome.done) {
        outcome = await poll({
          path: `/api/v1/voice/uploads/${input.clientUploadId}`,
          session: input.session,
          inspect,
          parentSignal: signal,
        });
      }
      return {
        ready: outcome.ready === true && uploadCompletedAt !== null,
        transcriptMs: outcome.ready && uploadCompletedAt !== null ? monotonicNow() - uploadCompletedAt : null,
        durationBucketSeconds: input.sample.durationBucketSeconds ?? null,
        requestStatus: posted.response.status,
        requestId: UUID.test(String(posted.body?.requestId ?? '')) ? posted.body.requestId.toLowerCase() : null,
        responseStatus: outcome.responseStatus ?? 0,
        responseRequestId: outcome.responseRequestId ?? null,
      };
    }

    if (input.operation === 'tts') {
      const inspect = ({ response, body }) => {
        if (response.status === 404) return { done: false };
        if (response.status === 202) return { done: false };
        const messageIdMatches = body?.data?.messageId === input.assistantMessageId;
        if (response.status === 200 && messageIdMatches && body?.data?.state === 'pending') {
          return { done: false };
        }
        if (response.status === 200 && messageIdMatches && body?.data?.state === 'attached') {
          return { done: true, ready: true, mediaId: body.data.mediaId, messageIdMatches };
        }
        if (response.status === 200 && messageIdMatches && body?.data?.state === 'failed') {
          return {
            done: true, ready: false, providerFailureObserved: true,
            failureCode: body.data.failureCode, messageIdMatches,
          };
        }
        return { done: true, ready: false, providerFailureObserved: false, failureCode: null, messageIdMatches };
      };
      const outcome = await poll({
        path: `/api/v1/messages/${input.assistantMessageId}/audio/status`,
        session: input.session,
        inspect,
        parentSignal: signal,
      });
      let mediaValidated = false;
      if (outcome.ready && typeof outcome.mediaId === 'string' && outcome.mediaId) {
        const mediaPath = `/api/v1/media/${encodeURIComponent(outcome.mediaId)}`;
        const headers = { Cookie: input.session.cookie };
        const head = await fetchRaw(mediaPath, { method: 'HEAD', headers }, signal);
        const byteLength = Number(head.headers.get('content-length'));
        const typeValid = head.status === 200
          && head.headers.get('content-type') === 'audio/mpeg'
          && head.headers.get('accept-ranges') === 'bytes'
          && Number.isSafeInteger(byteLength) && byteLength > 4 && byteLength <= MAX_MEDIA_BODY_BYTES;
        if (typeValid) {
          const rangeResponse = await fetchRaw(mediaPath, { headers: { ...headers, Range: 'bytes=0-3' } }, signal);
          const rangeBytes = await responseBytes(rangeResponse, { signal, maximumBytes: 4 });
          const rangeValid = rangeResponse.status === 206
            && rangeResponse.headers.get('content-type') === 'audio/mpeg'
            && rangeResponse.headers.get('content-range') === `bytes 0-3/${byteLength}`
            && rangeBytes.length === 4;
          const fullResponse = await fetchRaw(mediaPath, { headers }, signal);
          const fullBytes = await responseBytes(fullResponse, { signal, maximumBytes: MAX_MEDIA_BODY_BYTES });
          const fullValid = fullResponse.status === 200
            && fullResponse.headers.get('content-type') === 'audio/mpeg'
            && fullBytes.length === byteLength
            && fullBytes.subarray(0, 4).equals(rangeBytes);
          if (rangeValid && fullValid) {
            await decodeCanonicalMp3(fullBytes);
            mediaValidated = true;
          }
        }
      }
      const canonical = await fetchJson(
        '/api/v1/messages?after=0',
        { headers: { Cookie: input.session.cookie } },
        signal,
      );
      const textAvailable = canonical.body?.data?.messages?.some((message) => (
        message.id === input.assistantMessageId && message.role === 'assistant'
        && message.status === 'delivered' && typeof message.text === 'string' && message.text.length > 0
      )) === true;
      return {
        ready: outcome.ready === true,
        providerFailureObserved: outcome.providerFailureObserved === true,
        failureCode: typeof outcome.failureCode === 'string' ? outcome.failureCode : null,
        textAvailable,
        mediaValidated,
        messageIdMatches: outcome.messageIdMatches === true,
        requestStatus: outcome.responseStatus ?? 0,
        requestId: outcome.responseRequestId ?? null,
        responseStatus: canonical.response.status,
        responseRequestId: UUID.test(String(canonical.body?.requestId ?? ''))
          ? canonical.body.requestId.toLowerCase() : null,
      };
    }
    return null;
  };
}

export async function runLatencyAcceptance({
  argv = process.argv.slice(2),
  environment = process.env,
  cwd = productionRoot,
  artifactDirectory = defaultArtifactDirectory,
  now = () => new Date(),
  inspectGit = inspectGitState,
  loadAsrFixtures = defaultLoadAsrFixtures,
  mintIdentityToken = mintGcloudIdentityToken,
  readControlPlaneReceipts = readGcloudControlPlaneReceipts,
  controlPlaneReceiptSleep = defaultPollSleep,
  requester = null,
  fetchImpl = globalThis.fetch,
  randomUUID = systemRandomUUID,
  writeArtifact = defaultWriteArtifact,
  writeOutput = (line) => process.stdout.write(line),
  operationDeadlineMs = DEFAULT_OPERATION_DEADLINE_MS,
  fetchDeadlineMs = DEFAULT_FETCH_DEADLINE_MS,
  pollDeadlineMs = DEFAULT_POLL_DEADLINE_MS,
  requestDeadlineMs = DEFAULT_REQUEST_DEADLINE_MS,
  commandDeadlineMs = DEFAULT_COMMAND_DEADLINE_MS,
} = {}) {
  const selection = exactArguments(argv);
  if (!selection) return publish(writeOutput, 2, { status: 'not-run', code: 'LATENCY_ARGUMENTS_REQUIRED' });
  if (environment?.V1_LOAD_TEST_CONFIRM !== 'true') {
    return publish(writeOutput, 2, { status: 'not-run', code: 'LOAD_TEST_CONFIRMATION_REQUIRED' });
  }
  const commitSha = environment?.V1_RELEASE_COMMIT_SHA;
  if (!RELEASE_SHA.test(String(commitSha ?? ''))) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'RELEASE_COMMIT_INVALID' });
  }
  const candidateOrigin = safeCandidateOrigin(selection.candidateOrigin, {
    commitSha,
    stableOrigin: environment?.V1_PUBLIC_ORIGIN,
    configuredCandidateOrigin: environment?.V1_CANDIDATE_ORIGIN,
  });
  if (!candidateOrigin) return publish(writeOutput, 2, { status: 'not-run', code: 'CANDIDATE_ORIGIN_INVALID' });
  const sourceArchiveSha256 = environment?.V1_SOURCE_ARCHIVE_SHA256;
  const imageDigest = environment?.V1_CANDIDATE_IMAGE_DIGEST;
  const candidateRevision = environment?.V1_CANDIDATE_REVISION;
  const candidateTrafficPercent = Number(environment?.V1_CANDIDATE_TRAFFIC_PERCENT);
  const candidateAudience = environment?.V1_CANDIDATE_AUDIENCE;
  const candidateService = environment?.V1_CANDIDATE_SERVICE;
  const stableService = environment?.V1_STABLE_SERVICE;
  const trafficState = environment?.V1_CANDIDATE_TRAFFIC_STATE;
  const stableTrafficState = environment?.V1_STABLE_TRAFFIC_STATE;
  const candidateTag = `candidate-${commitSha.slice(0, 12)}`;
  const expectedCandidateAudience = `https://${CANDIDATE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
  if (!SHA256.test(String(sourceArchiveSha256 ?? ''))
    || !IMAGE_DIGEST.test(String(imageDigest ?? ''))
    || candidateRevision !== `${CANDIDATE_SERVICE}-${commitSha.slice(0, 12)}`
    || candidateTrafficPercent !== 100
    || candidateAudience !== expectedCandidateAudience
    || candidateService !== CANDIDATE_SERVICE || stableService !== STABLE_SERVICE
    || trafficState !== 'candidate-service-private-100'
    || !['stable-absent', 'stable-prior-100'].includes(stableTrafficState)) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'RELEASE_BINDING_INVALID' });
  }
  operationDeadlineMs = deadlineValue(operationDeadlineMs, DEFAULT_OPERATION_DEADLINE_MS);
  fetchDeadlineMs = deadlineValue(fetchDeadlineMs, DEFAULT_FETCH_DEADLINE_MS);
  pollDeadlineMs = deadlineValue(pollDeadlineMs, DEFAULT_POLL_DEADLINE_MS);
  requestDeadlineMs = deadlineValue(requestDeadlineMs, DEFAULT_REQUEST_DEADLINE_MS);
  commandDeadlineMs = deadlineValue(commandDeadlineMs, DEFAULT_COMMAND_DEADLINE_MS);
  if (typeof cwd !== 'string' || !isAbsolute(cwd)
    || typeof artifactDirectory !== 'string' || !isAbsolute(artifactDirectory)
    || typeof controlPlaneReceiptSleep !== 'function'
    || operationDeadlineMs === null || fetchDeadlineMs === null
    || pollDeadlineMs === null || requestDeadlineMs === null || commandDeadlineMs === null) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'COMMAND_CONTEXT_INVALID' });
  }

  const commandBudget = createDeadlineSignal({
    timeoutMs: commandDeadlineMs,
    code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
  });
  const commandOperation = (operation) => withDeadline(operation, {
    timeoutMs: operationDeadlineMs,
    code: 'LATENCY_OPERATION_DEADLINE_EXCEEDED',
    parentSignal: commandBudget.signal,
  });

  let identityToken = null;
  try {

  let gitState;
  try {
    gitState = await commandOperation((signal) => inspectGit(cwd, { signal }));
  } catch {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    gitState = null;
  }
  if (!gitState || gitState.head !== commitSha || gitState.clean !== true) {
    return publish(writeOutput, 1, { status: 'failed', code: 'RELEASE_GIT_STATE_INVALID' });
  }

  let fixtureSet;
  try {
    fixtureSet = validateFixtureSet(await commandOperation(
      (signal) => loadAsrFixtures(selection.asrManifestPath, { signal }),
    ));
  } catch {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    fixtureSet = null;
  }
  if (!fixtureSet) return publish(writeOutput, 1, { status: 'failed', code: 'ASR_FIXTURE_SET_INVALID' });

  let occurredAt;
  try {
    const instant = new Date(now());
    if (!Number.isFinite(instant.getTime())) throw new Error('invalid clock');
    occurredAt = instant.toISOString();
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'ACCEPTANCE_TIME_INVALID' });
  }
  const acceptanceWindowId = createHash('sha256').update(canonicalJson({
    commitSha,
    occurredAt,
    contractSchemaVersion: LATENCY_ACCEPTANCE_CONTRACT.schemaVersion,
  })).digest('hex');
  let access;
  try {
    identityToken = await commandOperation((signal) => mintIdentityToken({
      audience: candidateAudience,
      taggedUrl: candidateOrigin,
      signal,
    }));
    access = authenticatedAccess(identityToken, {
      audience: candidateAudience,
      taggedUrl: candidateOrigin,
      now: occurredAt,
    });
  } catch {
    access = null;
  }
  if (!access) return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_AUTHENTICATION_INVALID' });
  const acceptanceUserAgent = `hkbuddy-v1-acceptance/${acceptanceWindowId}`;

  let selectedRequester = requester;
  try {
    selectedRequester ??= createLatencyHttpRequester({
      candidateOrigin,
      identityToken,
      acceptanceUserAgent,
      fetchImpl,
      fetchDeadlineMs,
      pollDeadlineMs,
    });
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'REQUESTER_UNAVAILABLE' });
  }

  const bootstrapInput = (sessionIndex) => ({
    operation: 'bootstrap', candidateOrigin, releaseCommitSha: commitSha, sessionIndex,
    clientInstanceId: randomUUID(),
  });
  const requestContext = { parentSignal: commandBudget.signal, requestDeadlineMs };
  const firstBootstrap = await safeRequest(selectedRequester, bootstrapInput(0), requestContext);
  if (!firstBootstrap?.ok || !firstBootstrap.session) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_REQUEST_FAILED' });
  }
  if (!releaseMatches(firstBootstrap.capabilities, commitSha)) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_RELEASE_MISMATCH' });
  }
  if (!exactCapabilities(firstBootstrap.capabilities, commitSha)) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_NOT_READY' });
  }

  const remainingIndexes = Array.from({ length: 19 }, (_, index) => index + 1);
  const remaining = await mapConcurrent(remainingIndexes, 5, async (sessionIndex) => {
    const value = await safeRequest(selectedRequester, bootstrapInput(sessionIndex), requestContext);
    return value?.ok && value.session && exactCapabilities(value.capabilities, commitSha) ? value.session : null;
  });
  const sessions = [firstBootstrap.session, ...remaining];

  const textOperational = (await mapConcurrent(sessions.map((session, sessionIndex) => ({ session, sessionIndex })), 5, async ({ session, sessionIndex }) => {
    const turns = [];
    for (let turnIndex = 0; turnIndex < PROMPTS.length; turnIndex += 1) {
      const prompt = PROMPTS[turnIndex];
      const replyLanguage = REPLY_LANGUAGES[(sessionIndex * PROMPTS.length + turnIndex) % REPLY_LANGUAGES.length];
      const replyMode = turnIndex === 0 || (turnIndex === 1 && sessionIndex < 11) ? 'voice' : 'text';
      const controlledTtsFailure = turnIndex === 1 && sessionIndex === 10;
      const correlationId = randomUUID();
      const clientMessageId = randomUUID();
      const traceId = sha256(canonicalJson({ acceptanceWindowId, correlationId })).slice(0, 32);
      const raw = session ? await safeRequest(selectedRequester, {
        operation: 'text', candidateOrigin, releaseCommitSha: commitSha,
        session, sessionIndex, turnIndex,
        prompt: prompt.text, promptClass: prompt.promptClass,
        expectedGrounding: prompt.expectedGrounding ?? null,
        replyLanguage, replyMode, acceptanceWindowId, correlationId,
        controlledTtsFailure, traceId, clientMessageId,
      }, requestContext) : null;
      turns.push({
        session,
        sessionIndex,
        turnIndex,
        clientMessageId,
        correlationId,
        traceId,
        controlledTtsFailure,
        normalized: { ...normalizeTextResult(raw), promptClass: prompt.promptClass, replyLanguage, replyMode },
      });
    }
    return turns;
  })).flat();
  const textResults = textOperational.map((item) => ({
    ...item.normalized,
    correlationId: item.correlationId,
    bindingId: item.normalized.assistantMessageId,
    expectedProvider: item.normalized.promptClass === 'grounded',
  }));

  const asrResults = await mapConcurrent(fixtureSet.samples, 5, async (sample, sampleIndex) => {
    const sessionIndex = sampleIndex % sessions.length;
    const session = sessions[sessionIndex];
    const clientUploadId = randomUUID();
    const correlationId = randomUUID();
    const raw = session ? await safeRequest(selectedRequester, {
      operation: 'asr', candidateOrigin, releaseCommitSha: commitSha,
      session, sessionIndex, sample, sampleIndex, clientUploadId,
      responseLanguage: { cantonese: 'yue-Hant-HK', english: 'en', mandarin: 'cmn-Hans-CN' }[sample.language],
      acceptanceWindowId, correlationId,
    }, requestContext) : null;
    return {
      sessionIndex,
      sampleIndex,
      fixtureId: sample.id,
      fixtureSha256: sample.sha256,
      language: sample.language,
      wireLanguage: { cantonese: 'yue-Hant-HK', english: 'en', mandarin: 'cmn-Hans-CN' }[sample.language],
      clientUploadId,
      ...normalizeAsrResult(raw, {
      correlationId,
      bindingId: clientUploadId,
      durationMs: sample.durationMs,
      durationBucketSeconds: sample.durationBucketSeconds,
      }),
    };
  });

  const ttsCandidates = [];
  for (let turnIndex = 0; turnIndex < PROMPTS.length && ttsCandidates.length < 30; turnIndex += 1) {
    for (let sessionIndex = 0; sessionIndex < sessions.length && ttsCandidates.length < 30; sessionIndex += 1) {
      const candidate = textOperational.find((item) => (
        item.sessionIndex === sessionIndex
        && item.turnIndex === turnIndex
        && item.normalized.replyMode === 'voice'
        && item.controlledTtsFailure !== true
        && item.normalized.assistantMessageId
      ));
      if (candidate) ttsCandidates.push(candidate);
    }
  }
  const controlledTtsCandidate = textOperational.find((item) => (
    item.controlledTtsFailure === true && item.normalized.assistantMessageId
  )) ?? null;
  const ttsItems = [
    ...Array.from({ length: 30 }, (_, requestIndex) => ({
      requestIndex, candidate: ttsCandidates[requestIndex] ?? null, expectedProviderFailure: false,
    })),
    { requestIndex: 30, candidate: controlledTtsCandidate, expectedProviderFailure: true },
  ];
  const ttsResults = await mapConcurrent(ttsItems, 5, async ({ requestIndex, candidate, expectedProviderFailure }) => {
    const raw = candidate ? await safeRequest(selectedRequester, {
      operation: 'tts', candidateOrigin, releaseCommitSha: commitSha,
      session: candidate.session, sessionIndex: candidate.sessionIndex, requestIndex,
      assistantMessageId: candidate.normalized.assistantMessageId,
      acceptanceWindowId, correlationId: candidate.correlationId,
      expectedProviderFailure,
    }, requestContext) : null;
    return {
      requestIndex,
      sessionIndex: candidate?.sessionIndex ?? null,
      sourceTurnIndex: candidate?.turnIndex ?? null,
      ...normalizeTtsResult(raw, {
      correlationId: candidate?.correlationId ?? null,
      bindingId: candidate?.normalized.assistantMessageId ?? null,
      expectedProviderFailure,
      }),
    };
  });

  const timingQueries = await mapConcurrent(sessions.map((session, sessionIndex) => ({ session, sessionIndex })), 5, async ({ session, sessionIndex }) => {
    if (!session?.id) return null;
    const raw = await safeRequest(selectedRequester, {
      operation: 'timings', candidateOrigin, releaseCommitSha: commitSha,
      acceptanceWindowId, session, sessionIndex,
    }, requestContext);
    const normalized = normalizeTimingQuery(raw, {
      commitSha,
      acceptanceWindowId,
      sessionId: session.id,
    });
    return normalized ? { ...normalized, sessionIndex } : null;
  });
  const timingSamples = timingQueries.flatMap((query) => query?.samples ?? []);
  const timingQueryDigests = timingQueries.map((query) => query?.queryDigest).filter(Boolean);

  const finalCandidate = await safeRequest(selectedRequester, {
    operation: 'verifyCandidate',
    candidateOrigin,
    releaseCommitSha: commitSha,
    session: sessions[0],
    sessionIndex: 0,
  }, requestContext);
  if (!finalCandidate?.ok || !exactCapabilities(finalCandidate.capabilities, commitSha)) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CANDIDATE_RELEASE_CHANGED' });
  }

  const expectedTraceIds = textOperational.map(({ traceId }) => traceId);
  let controlPlaneRequests;
  try {
    for (let attempt = 0; attempt < CONTROL_PLANE_RECEIPT_ATTEMPTS; attempt += 1) {
      const rawControlPlane = await commandOperation((signal) => readControlPlaneReceipts({
        acceptanceWindowId,
        candidateOrigin,
        candidateRevision,
        occurredAt,
        expectedTraceIds,
      }, { signal }));
      controlPlaneRequests = normalizeControlPlaneTurnReceipts(rawControlPlane, {
        acceptanceWindowId,
        candidateOrigin,
        candidateRevision,
        expectedTraceIds,
      });
      if (controlPlaneRequests || !Array.isArray(rawControlPlane)
        || rawControlPlane.length >= 200
        || attempt === CONTROL_PLANE_RECEIPT_ATTEMPTS - 1) break;
      await commandOperation((signal) => controlPlaneReceiptSleep(
        CONTROL_PLANE_RECEIPT_DELAY_MS, { signal },
      ));
    }
  } catch {
    controlPlaneRequests = null;
  }
  if (!controlPlaneRequests) {
    return publish(writeOutput, 1, { status: 'failed', code: 'CONTROL_PLANE_RECEIPTS_INVALID' });
  }

  const releaseBinding = Object.freeze({
    project: PROJECT,
    region: REGION,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    releaseSha: commitSha,
    sourceArchiveSha256,
    imageDigest,
    candidateRevision,
    candidateTag,
    serviceOrigin: environment.V1_PUBLIC_ORIGIN,
    candidateOrigin,
    candidateAudience,
    trafficPercent: candidateTrafficPercent,
    trafficState,
    stableTrafficState,
  });
  const rawReceipts = buildRawReceipts({
    acceptanceWindowId,
    textOperational,
    asrResults,
    ttsResults,
    timingQueries,
    controlPlaneRequests,
    releaseBinding,
  });

  const record = acceptanceRecord({
    commitSha, candidateOrigin, fixtureSetSha256: fixtureSet.fixtureSetSha256,
    occurredAt, sessions, textResults, asrResults, ttsResults, timingSamples, timingQueryDigests,
    rawReceipts, access, releaseBinding,
  });
  let finalGitState;
  try {
    finalGitState = await commandOperation((signal) => inspectGit(cwd, { signal }));
  } catch {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    finalGitState = null;
  }
  if (!finalGitState || finalGitState.head !== commitSha || finalGitState.clean !== true) {
    return publish(writeOutput, 1, { status: 'failed', code: 'RELEASE_GIT_STATE_CHANGED' });
  }
  const filePath = join(artifactDirectory, `${commitSha}-${record.artifactSha256}.json`);
  try {
    await commandOperation((signal) => writeArtifact(
      { filePath, contents: `${JSON.stringify(record, null, 2)}\n`, record },
      { signal },
    ));
  } catch (error) {
    if (commandBudget.signal.aborted) {
      throw deadlineReason(commandBudget.signal, 'LATENCY_COMMAND_DEADLINE_EXCEEDED');
    }
    const code = error?.code === 'EEXIST' ? 'LATENCY_ARTIFACT_EXISTS' : 'LATENCY_ARTIFACT_WRITE_FAILED';
    return publish(writeOutput, 1, { status: 'failed', code });
  }
  return publish(writeOutput, record.result ? 0 : 1, {
    status: 'recorded',
    code: record.result ? 'LATENCY_ACCEPTANCE_PASSED' : 'LATENCY_ACCEPTANCE_FAILED',
    artifactSha256: record.artifactSha256,
  });
  } catch {
    if (commandBudget.signal.aborted) {
      return publish(writeOutput, 1, {
        status: 'failed',
        code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
      });
    }
    return publish(writeOutput, 1, { status: 'failed', code: 'LATENCY_COMMAND_FAILED' });
  } finally {
    identityToken = null;
    commandBudget.dispose();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runLatencyAcceptance();
  process.exitCode = result.exitCode;
}
