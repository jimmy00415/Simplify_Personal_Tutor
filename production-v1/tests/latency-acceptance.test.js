import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import { canonicalMp3Fixture } from './fixtures/canonical-mp3-fixture.js';
import * as latencyWorkload from '../scripts/production-latency-workload.js';

import {
  LATENCY_ACCEPTANCE_CONTRACT,
  createLatencyHttpRequester,
  finalizeLatencyAcceptanceRecord,
  inspectGitState,
  mintGcloudIdentityToken,
  nearestRankP50,
  nearestRankP95,
  runLatencyAcceptance,
  safeRequest,
} from '../scripts/production-latency-workload.js';
import { acceptanceTimingQueryDigest } from '../src/telemetry/acceptance-timings.js';

const COMMIT = '1'.repeat(40);
const PROJECT_NUMBER = '582852715831';
const STABLE_SERVICE = 'hkbuddy-v1-api';
const CANDIDATE_SERVICE = 'hkbuddy-v1-api-candidate';
const ACCEPTANCE_PRINCIPAL = 'hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com';
const STABLE_ORIGIN = `https://hkbuddy-v1-api-${PROJECT_NUMBER}.asia-east2.run.app`;
const ORIGIN = `https://candidate-${COMMIT.slice(0, 12)}---hkbuddy-v1-api-candidate-${PROJECT_NUMBER}.asia-east2.run.app`;
const CANDIDATE_ROOT = `https://${CANDIDATE_SERVICE}-${PROJECT_NUMBER}.asia-east2.run.app`;
const MANIFEST_PATH = resolve('latency-asr-fixtures.json');
const CWD = resolve('..');
const NOW = new Date('2026-08-25T12:00:00.000Z');
const SOURCE_ARCHIVE_SHA256 = '2'.repeat(64);
const CANDIDATE_IMAGE_DIGEST = `sha256:${'3'.repeat(64)}`;
const CANDIDATE_REVISION = `${CANDIDATE_SERVICE}-${COMMIT.slice(0, 12)}`;
const TEST_ID_TOKEN = [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: CANDIDATE_ROOT,
    sub: '1234567890',
    email: ACCEPTANCE_PRINCIPAL,
    iat: Math.floor(NOW.getTime() / 1000) - 30,
    exp: Math.floor(NOW.getTime() / 1000) + 3_600,
  })).toString('base64url'),
  'test-signature',
].join('.');

function exactArgv(origin = ORIGIN, manifestPath = MANIFEST_PATH) {
  return [
    '--candidate-origin', origin,
    '--asr-manifest', manifestPath,
    '--confirm-approved-candidate',
  ];
}

function fixtureSet() {
  const samples = [];
  const layout = {
    10: { cantonese: 4, english: 3, mandarin: 3 },
    30: { cantonese: 3, english: 4, mandarin: 3 },
    55: { cantonese: 3, english: 3, mandarin: 4 },
  };
  for (const durationBucketSeconds of [10, 30, 55]) {
    for (const language of ['cantonese', 'english', 'mandarin']) {
      for (let index = 0; index < layout[durationBucketSeconds][language]; index += 1) {
        const id = `${language}-${durationBucketSeconds}-${index + 1}`;
        const bytes = Buffer.from(`${id}-canonical-wav`.padEnd(64, 'x'));
        samples.push({
          id,
          language,
          durationBucketSeconds,
          durationMs: durationBucketSeconds * 1_000,
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        });
      }
    }
  }
  return samples;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function flushAsyncWork() {
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  await Promise.resolve();
}

function observeSettlement(promise) {
  const observation = { settled: false, status: null, value: null, error: null };
  promise.then(
    (value) => Object.assign(observation, { settled: true, status: 'fulfilled', value }),
    (error) => Object.assign(observation, { settled: true, status: 'rejected', error }),
  );
  return observation;
}

test('safe workload requests retry one transient failure only for idempotent operations', async () => {
  for (const operation of ['asr', 'tts', 'timings', 'verifyCandidate']) {
    let attempts = 0;
    const result = await safeRequest(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient network failure');
      return { ok: true, operation };
    }, { operation }, { requestDeadlineMs: 1_000 });
    assert.deepEqual(result, { ok: true, operation });
    assert.equal(attempts, 2);
  }

  for (const operation of ['bootstrap', 'text']) {
    let attempts = 0;
    const result = await safeRequest(async () => {
      attempts += 1;
      throw new Error('ambiguous mutation outcome');
    }, { operation }, { requestDeadlineMs: 1_000 });
    assert.equal(result, null);
    assert.equal(attempts, 1);
  }
});

function createHarness({
  environment = {
    V1_LOAD_TEST_CONFIRM: 'true',
    V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_PUBLIC_ORIGIN: STABLE_ORIGIN,
    V1_CANDIDATE_ORIGIN: ORIGIN,
    V1_SOURCE_ARCHIVE_SHA256: SOURCE_ARCHIVE_SHA256,
    V1_CANDIDATE_IMAGE_DIGEST: CANDIDATE_IMAGE_DIGEST,
    V1_CANDIDATE_REVISION: CANDIDATE_REVISION,
    V1_CANDIDATE_TRAFFIC_PERCENT: '100',
    V1_CANDIDATE_AUDIENCE: CANDIDATE_ROOT,
    V1_CANDIDATE_SERVICE: CANDIDATE_SERVICE,
    V1_STABLE_SERVICE: STABLE_SERVICE,
    V1_CANDIDATE_TRAFFIC_STATE: 'candidate-service-private-100',
    V1_STABLE_TRAFFIC_STATE: 'stable-prior-100',
  },
  argv = exactArgv(),
  gitState = { head: COMMIT, clean: true },
  fixtures = fixtureSet(),
  resultFor,
  requester: requesterOverride,
  writeArtifact: writeArtifactOverride,
  now = () => NOW,
} = {}) {
  const calls = [];
  const outputs = [];
  const artifacts = [];
  const active = { bootstrap: 0, verifyCandidate: 0, text: 0, asr: 0, tts: 0, timings: 0 };
  const maximum = { bootstrap: 0, verifyCandidate: 0, text: 0, asr: 0, tts: 0, timings: 0 };

  const defaultResult = (input) => {
    const ordinal = input.operation === 'text'
      ? input.sessionIndex * 10 + input.turnIndex + 1
      : (input.sampleIndex ?? input.requestIndex ?? input.sessionIndex ?? 0) + 1;
    const requestId = `00000000-0000-4000-8001-${String(ordinal).padStart(12, '0')}`;
    const responseRequestId = `00000000-0000-4000-8002-${String(ordinal).padStart(12, '0')}`;
    if (['bootstrap', 'verifyCandidate'].includes(input.operation)) {
      return {
        ok: true,
        session: { id: `session-${input.sessionIndex}`, sessionIndex: input.sessionIndex },
        capabilities: {
          productionReady: true,
          releaseCommitSha: COMMIT,
          voiceInput: true,
          voiceOutput: true,
        },
      };
    }
    if (input.operation === 'text') {
      return {
        acknowledged: true,
        ackMs: 200,
        processingVisible: true,
        processingVisibleMs: 400,
        delivered: true,
        finalAnswerMs: 2_400,
        messageLost: false,
        assistantReplyCount: 1,
        unsupportedVerifiedClaimCount: 0,
        assistantMessageId: `assistant-${input.sessionIndex}-${input.turnIndex}`,
        replyMode: input.replyMode,
        providerLatencyMs: 5_500,
        serverLatencyMs: 250,
        privateBody: 'must-not-enter-artifact',
        requestStatus: 202,
        requestId,
        responseStatus: 200,
        responseRequestId,
        groundingSatisfied: true,
        groundingVerified: input.promptClass === 'grounded',
        groundingEvidenceSha256: createHash('sha256').update(`grounding-${ordinal}`).digest('hex'),
      };
    }
    if (input.operation === 'asr') {
      return {
        ready: true,
        transcriptMs: input.sample.durationBucketSeconds === 10 ? 2_000 : 5_000,
        durationBucketSeconds: input.sample.durationBucketSeconds,
        providerLatencyMs: 4_400,
        serverLatencyMs: 300,
        transcript: 'private transcript must not enter artifact',
        requestStatus: 202,
        requestId,
        responseStatus: 200,
        responseRequestId,
      };
    }
    return {
      ready: input.expectedProviderFailure !== true,
      providerFailureObserved: input.expectedProviderFailure === true,
      failureCode: input.expectedProviderFailure === true ? 'VOICE_SYNTHESIS_REJECTED' : null,
      textAvailable: true,
      mediaValidated: input.expectedProviderFailure !== true,
      messageIdMatches: true,
      providerLatencyMs: 3_500,
      serverLatencyMs: 200,
      audio: 'private audio must not enter artifact',
      requestStatus: 200,
      requestId,
      responseStatus: 200,
      responseRequestId,
    };
  };

  const requester = requesterOverride ?? (async (input) => {
    calls.push(['request', input]);
    active[input.operation] += 1;
    maximum[input.operation] = Math.max(maximum[input.operation], active[input.operation]);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    active[input.operation] -= 1;
    if (input.operation === 'timings') {
      const completed = calls
        .filter(([kind, item]) => kind === 'request' && item?.sessionIndex === input.sessionIndex)
        .map(([, item]) => item);
      const samples = [];
      for (const item of completed.filter(({ operation }) => operation === 'text')) {
        const bindingId = `assistant-${item.sessionIndex}-${item.turnIndex}`;
        samples.push({ correlationId: item.correlationId, bindingId, durationMs: null, operation: 'text', layer: 'server', latencyMs: 2_300, outcome: 'success', failureCode: null });
        if (item.promptClass === 'grounded') samples.push({ correlationId: item.correlationId, bindingId, durationMs: null, operation: 'text', layer: 'provider', latencyMs: 1_800, outcome: 'success', failureCode: null });
      }
      for (const item of completed.filter(({ operation }) => operation === 'asr')) {
        samples.push({ correlationId: item.correlationId, bindingId: item.clientUploadId, durationMs: item.sample.durationMs, operation: 'asr', layer: 'provider', latencyMs: 1_800, outcome: 'success', failureCode: null });
        samples.push({ correlationId: item.correlationId, bindingId: item.clientUploadId, durationMs: item.sample.durationMs, operation: 'asr', layer: 'server', latencyMs: item.sample.durationBucketSeconds === 10 ? 2_000 : 5_000, outcome: 'success', failureCode: null });
      }
      for (const item of completed.filter(({ operation }) => operation === 'tts')) {
        const failure = item.expectedProviderFailure === true;
        samples.push({ correlationId: item.correlationId, bindingId: item.assistantMessageId, durationMs: null, operation: 'tts', layer: 'provider', latencyMs: 1_700, outcome: failure ? 'failure' : 'success', failureCode: failure ? 'VOICE_SYNTHESIS_REJECTED' : null });
        samples.push({ correlationId: item.correlationId, bindingId: item.assistantMessageId, durationMs: null, operation: 'tts', layer: 'server', latencyMs: 1_900, outcome: failure ? 'failure' : 'success', failureCode: failure ? 'VOICE_SYNTHESIS_REJECTED' : null });
      }
      const fallback = {
        schemaVersion: 2,
        releaseCommitSha: COMMIT,
        windowId: input.acceptanceWindowId,
        queryDigest: acceptanceTimingQueryDigest({
          releaseCommitSha: COMMIT,
          windowId: input.acceptanceWindowId,
          sessionId: input.session.id,
        }),
        samples,
      };
      return resultFor?.(input, fallback) ?? fallback;
    }
    return resultFor?.(input, defaultResult(input)) ?? defaultResult(input);
  });

  const run = (overrides = {}) => runLatencyAcceptance({
    argv,
    environment,
    cwd: CWD,
    artifactDirectory: resolve('reports', 'latency-test'),
    now,
    inspectGit: async (gitCwd) => {
      calls.push(['git', gitCwd]);
      return gitState;
    },
    loadAsrFixtures: async (manifestPath) => {
      calls.push(['fixtures', manifestPath]);
      return fixtures;
    },
    requester,
    randomUUID: (() => {
      let value = 0;
      return () => `00000000-0000-4000-8000-${String(value += 1).padStart(12, '0')}`;
    })(),
    writeArtifact: writeArtifactOverride ?? (async (input) => {
      calls.push(['write', input.filePath]);
      artifacts.push(input);
    }),
    writeOutput: (line) => outputs.push(line),
    mintIdentityToken: async ({ audience }) => {
      calls.push(['identity-token', audience]);
      return TEST_ID_TOKEN;
    },
    readControlPlaneReceipts: async (query) => {
      calls.push(['control-plane', query]);
      return Array.from({ length: 200 }, (_, index) => ({
        insertId: `request-${String(index + 1).padStart(3, '0')}`,
        timestamp: new Date(NOW.getTime() + index).toISOString(),
        trace: `projects/motion-expert-hk-ltd-webpage/traces/${query.expectedTraceIds[index]}`,
        resource: {
          type: 'cloud_run_revision',
          labels: {
            project_id: 'motion-expert-hk-ltd-webpage', location: 'asia-east2',
            service_name: CANDIDATE_SERVICE, revision_name: CANDIDATE_REVISION,
          },
        },
        httpRequest: {
          requestMethod: 'POST', requestUrl: `${ORIGIN}/api/v1/messages`,
          status: 202, latency: '0.200s',
          userAgent: `hkbuddy-v1-acceptance/${query.acceptanceWindowId}`,
        },
      }));
    },
    ...overrides,
  });

  return { active, artifacts, calls, maximum, outputs, run };
}

test('nearest-rank percentiles are deterministic and the acceptance contract fixes every workload and threshold', () => {
  assert.equal(nearestRankP50([1, 2, 3, 4]), 2);
  assert.equal(nearestRankP95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  assert.equal(nearestRankP95(Array.from({ length: 30 }, (_, index) => index + 1)), 29);
  assert.equal(nearestRankP95([300]), 300);
  assert.equal(nearestRankP95([]), null);
  assert.throws(() => nearestRankP95([1, Number.NaN]), /finite/i);

  assert.deepEqual(LATENCY_ACCEPTANCE_CONTRACT, {
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
});

test('private candidate authentication mints an audience-bound acceptance-service-account ID token in memory', async () => {
  const calls = [];
  const request = Object.assign(async (input) => {
    calls.push({ kind: 'request', input });
    return { token: TEST_ID_TOKEN };
  }, {
    getPrincipal: async (signal) => {
      calls.push({ kind: 'principal', signal });
      return 'admin@motionexp.com';
    },
  });
  const token = await mintGcloudIdentityToken({
    audience: CANDIDATE_ROOT,
    request,
  });
  assert.equal(token, TEST_ID_TOKEN);
  assert.deepEqual(calls, [
    { kind: 'principal', signal: undefined },
    {
      kind: 'request',
      input: {
        method: 'POST',
        url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(ACCEPTANCE_PRINCIPAL)}:generateIdToken`,
        body: { audience: CANDIDATE_ROOT, includeEmail: true },
        signal: undefined,
      },
    },
  ]);
  assert.equal(JSON.stringify(calls).includes(TEST_ID_TOKEN), false);
});

test('Cloud Logging read uses the same real Windows bundled-Python launcher without a shell', async () => {
  const calls = [];
  const result = await latencyWorkload.readGcloudControlPlaneReceipts({
    acceptanceWindowId: 'a'.repeat(64),
    candidateOrigin: ORIGIN,
    candidateRevision: CANDIDATE_REVISION,
    occurredAt: NOW.toISOString(),
  }, {
    environment: {
      V1_GCP_PYTHON_EXECUTABLE: 'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe',
      V1_GCLOUD_PY_PATH: 'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\lib\\gcloud.py',
    },
    executeFile: async (file, argv, options) => {
      calls.push({ file, argv, options });
      return { stdout: '[]\n', stderr: '' };
    },
  });
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file,
    'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe');
  assert.equal(calls[0].argv[0],
    'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\lib\\gcloud.py');
  assert.deepEqual(calls[0].argv.slice(1, 3), ['logging', 'read']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(JSON.stringify(calls).includes('Authorization'), false);
  assert.equal(JSON.stringify(calls).includes(TEST_ID_TOKEN), false);
});

test('workload waits for eventual Cloud Logging visibility before rejecting receipts', async () => {
  const harness = createHarness();
  let reads = 0;
  const waits = [];
  const result = await harness.run({
    readControlPlaneReceipts: async (query) => {
      reads += 1;
      const count = reads === 1 ? 199 : 200;
      return Array.from({ length: count }, (_, index) => ({
        insertId: `request-${String(index + 1).padStart(3, '0')}`,
        timestamp: new Date(NOW.getTime() + index).toISOString(),
        trace: `projects/motion-expert-hk-ltd-webpage/traces/${query.expectedTraceIds[index]}`,
        resource: {
          type: 'cloud_run_revision',
          labels: {
            project_id: 'motion-expert-hk-ltd-webpage', location: 'asia-east2',
            service_name: CANDIDATE_SERVICE, revision_name: CANDIDATE_REVISION,
          },
        },
        httpRequest: {
          requestMethod: 'POST', requestUrl: `${ORIGIN}/api/v1/messages`,
          status: 202, latency: '0.200s',
          userAgent: `hkbuddy-v1-acceptance/${query.acceptanceWindowId}`,
        },
      }));
    },
    controlPlaneReceiptSleep: async (milliseconds, { signal } = {}) => {
      waits.push({ milliseconds, aborted: signal?.aborted ?? false });
    },
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(reads, 2);
  assert.deepEqual(waits, [{ milliseconds: 5_000, aborted: false }]);
});

test('command is inert unless exact arguments, explicit load confirmation, frozen SHA, and safe candidate are present', async (t) => {
  const cases = [
    ['missing arguments', { argv: [] }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['missing approval flag', { argv: exactArgv().slice(0, -1) }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['extra argument', { argv: [...exactArgv(), '--force'] }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['relative fixture manifest', { argv: exactArgv(ORIGIN, 'fixtures.json') }, 'LATENCY_ARGUMENTS_REQUIRED'],
    ['confirmation absent', { environment: { V1_RELEASE_COMMIT_SHA: COMMIT, V1_PUBLIC_ORIGIN: STABLE_ORIGIN, V1_CANDIDATE_ORIGIN: ORIGIN } }, 'LOAD_TEST_CONFIRMATION_REQUIRED'],
    ['confirmation is not exact lowercase true', { environment: { V1_LOAD_TEST_CONFIRM: 'TRUE', V1_RELEASE_COMMIT_SHA: COMMIT, V1_PUBLIC_ORIGIN: STABLE_ORIGIN, V1_CANDIDATE_ORIGIN: ORIGIN } }, 'LOAD_TEST_CONFIRMATION_REQUIRED'],
    ['release commit missing', { environment: { V1_LOAD_TEST_CONFIRM: 'true', V1_PUBLIC_ORIGIN: STABLE_ORIGIN, V1_CANDIDATE_ORIGIN: ORIGIN } }, 'RELEASE_COMMIT_INVALID'],
    ['release commit uppercase', { environment: { V1_LOAD_TEST_CONFIRM: 'true', V1_RELEASE_COMMIT_SHA: 'A'.repeat(40), V1_PUBLIC_ORIGIN: STABLE_ORIGIN, V1_CANDIDATE_ORIGIN: ORIGIN } }, 'RELEASE_COMMIT_INVALID'],
    ['http origin', { argv: exactArgv('http://v1-candidate.example.com') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['origin contains path', { argv: exactArgv(`${ORIGIN}/private`) }, 'CANDIDATE_ORIGIN_INVALID'],
    ['origin contains credentials', { argv: exactArgv('https://user:pass@v1-candidate.example.com') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['origin has explicit port', { argv: exactArgv('https://v1-candidate.example.com:8443') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['localhost', { argv: exactArgv('https://localhost') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['known legacy target', { argv: exactArgv('https://hkbuddy-pilot-0630.azurewebsites.net') }, 'CANDIDATE_ORIGIN_INVALID'],
    ['unrelated Cloud Run tag', { argv: exactArgv(`https://other---hkbuddy-v1-api-${PROJECT_NUMBER}.asia-east2.run.app`) }, 'CANDIDATE_ORIGIN_INVALID'],
    ['old service identity', { argv: exactArgv(`https://candidate-${COMMIT.slice(0, 12)}---hkbuddy-api-${PROJECT_NUMBER}.asia-east2.run.app`) }, 'CANDIDATE_ORIGIN_INVALID'],
    ['old project number', { argv: exactArgv(`https://candidate-${COMMIT.slice(0, 12)}---hkbuddy-v1-api-candidate-93662314720.asia-east2.run.app`) }, 'CANDIDATE_ORIGIN_INVALID'],
    ['foreign project number', { argv: exactArgv(`https://candidate-${COMMIT.slice(0, 12)}---hkbuddy-v1-api-candidate-999999999999.asia-east2.run.app`) }, 'CANDIDATE_ORIGIN_INVALID'],
    ['configured candidate mismatch', { environment: { V1_LOAD_TEST_CONFIRM: 'true', V1_RELEASE_COMMIT_SHA: COMMIT, V1_PUBLIC_ORIGIN: STABLE_ORIGIN, V1_CANDIDATE_ORIGIN: 'https://example.com' } }, 'CANDIDATE_ORIGIN_INVALID'],
  ];

  for (const [name, overrides, code] of cases) {
    await t.test(name, async () => {
      const fixture = createHarness(overrides);
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.publicReport, { status: 'not-run', code });
      assert.deepEqual(fixture.calls, []);
      assert.deepEqual(fixture.outputs, [`${JSON.stringify(result.publicReport)}\n`]);
    });
  }
});

test('an invalid audience-bound identity token fails before the first candidate HTTP request', async () => {
  const harness = createHarness();
  let requested = false;
  const result = await harness.run({
    mintIdentityToken: async () => 'not-a-jwt',
    requester: async () => { requested = true; throw new Error('must remain inert'); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(harness.outputs.at(-1)).code, 'CANDIDATE_AUTHENTICATION_INVALID');
  assert.equal(requested, false);
});

test('clean current HEAD must equal the frozen release SHA before fixture or network access', async (t) => {
  for (const [name, gitState] of [
    ['dirty', { head: COMMIT, clean: false }],
    ['different head', { head: '2'.repeat(40), clean: true }],
    ['malformed result', { head: COMMIT, clean: 'true' }],
  ]) {
    await t.test(name, async () => {
      const fixture = createHarness({ gitState });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'RELEASE_GIT_STATE_INVALID');
      assert.deepEqual(fixture.calls, [['git', CWD]]);
    });
  }
});

test('fixture set must contain exactly ten samples per language and duration bucket across Cantonese English and Mandarin', async (t) => {
  const cases = [
    ['missing sample', (samples) => samples.pop()],
    ['duplicate id', (samples) => { samples[1].id = samples[0].id; }],
    ['wrong language', (samples) => { samples[0].language = 'auto'; }],
    ['wrong bucket', (samples) => { samples[0].durationBucketSeconds = 12; }],
    ['duration outside approximate bucket', (samples) => { samples[0].durationMs = 12_001; }],
    ['bad lowercase digest', (samples) => { samples[0].sha256 = 'A'.repeat(64); }],
    ['byte length mismatch', (samples) => { samples[0].byteLength += 1; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const samples = fixtureSet();
      mutate(samples);
      const fixture = createHarness({ fixtures: samples });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'ASR_FIXTURE_SET_INVALID');
      assert.deepEqual(fixture.calls.map(([kind]) => kind), ['git', 'fixtures']);
    });
  }
});

test('candidate preflight uses the first of exactly 20 sessions and fences a mismatched or unavailable release', async (t) => {
  const cases = [
    ['wrong release', { releaseCommitSha: '2'.repeat(40), productionReady: true, voiceInput: true, voiceOutput: true }, 'CANDIDATE_RELEASE_MISMATCH'],
    ['not production ready', { releaseCommitSha: COMMIT, productionReady: false, voiceInput: true, voiceOutput: true }, 'CANDIDATE_NOT_READY'],
    ['voice input unavailable', { releaseCommitSha: COMMIT, productionReady: true, voiceInput: false, voiceOutput: true }, 'CANDIDATE_NOT_READY'],
    ['voice output unavailable', { releaseCommitSha: COMMIT, productionReady: true, voiceInput: true, voiceOutput: false }, 'CANDIDATE_NOT_READY'],
  ];

  for (const [name, capabilities, code] of cases) {
    await t.test(name, async () => {
      const fixture = createHarness({
        resultFor(input, fallback) {
          return input.operation === 'bootstrap' ? { ...fallback, capabilities } : fallback;
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, code);
      assert.deepEqual(fixture.calls.map(([kind]) => kind), ['git', 'fixtures', 'identity-token', 'request']);
      assert.equal(fixture.calls.at(-1)[1].operation, 'bootstrap');
      assert.equal(fixture.calls.at(-1)[1].sessionIndex, 0);
    });
  }
});

test('passing run executes the exact workload at concurrency five and writes one safe immutable digest-bound artifact', async () => {
  const fixture = createHarness();
  const result = await fixture.run();

  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.status, 'recorded');
  assert.equal(result.publicReport.code, 'LATENCY_ACCEPTANCE_PASSED');
  assert.match(result.publicReport.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(fixture.artifacts.length, 1);

  const requests = fixture.calls.filter(([kind]) => kind === 'request').map(([, input]) => input);
  assert.equal(requests.filter(({ operation }) => operation === 'bootstrap').length, 20);
  assert.equal(requests.filter(({ operation }) => operation === 'text').length, 200);
  assert.equal(requests.filter(({ operation }) => operation === 'asr').length, 30);
  assert.equal(requests.filter(({ operation }) => operation === 'tts').length, 31);
  assert.equal(requests.filter(({ operation }) => operation === 'timings').length, 20);
  assert.equal(requests.filter(({ operation }) => operation === 'verifyCandidate').length, 1);
  assert.deepEqual(
    Object.fromEntries(['grounded', 'abstention', 'casual'].map((kind) => [kind, requests.filter((item) => item.operation === 'text' && item.promptClass === kind).length])),
    { grounded: 80, abstention: 60, casual: 60 },
  );
  assert.deepEqual(
    Object.fromEntries([10, 30, 55].map((seconds) => [seconds, requests.filter((item) => item.operation === 'asr' && item.sample.durationBucketSeconds === seconds).length])),
    { 10: 10, 30: 10, 55: 10 },
  );
  assert.deepEqual(
    Object.fromEntries(['cantonese', 'english', 'mandarin'].map((language) => [language, requests.filter((item) => item.operation === 'asr' && item.sample.language === language).length])),
    { cantonese: 10, english: 10, mandarin: 10 },
  );
  const textRequests = requests.filter(({ operation }) => operation === 'text');
  assert.deepEqual([...new Set(textRequests.map(({ replyLanguage }) => replyLanguage))].sort(), ['cmn-Hans-CN', 'en', 'yue-Hant-HK']);
  assert.equal(textRequests.filter(({ replyMode }) => replyMode === 'voice').length, 31);
  assert.equal(textRequests.filter(({ controlledTtsFailure }) => controlledTtsFailure === true).length, 1);
  assert.equal(requests.filter(({ operation }) => operation === 'tts').every(({ assistantMessageId }) => {
    const source = textRequests.find(({ sessionIndex, turnIndex }) => assistantMessageId === `assistant-${sessionIndex}-${turnIndex}`);
    return source?.replyMode === 'voice';
  }), true);
  assert.equal(requests.filter(({ operation, expectedProviderFailure }) => (
    operation === 'tts' && expectedProviderFailure === true
  )).length, 1);
  const ttsBySession = new Map();
  for (const request of requests.filter(({ operation }) => operation === 'tts')) {
    ttsBySession.set(request.sessionIndex, (ttsBySession.get(request.sessionIndex) ?? 0) + 1);
  }
  assert.equal(Math.max(...ttsBySession.values()), 2, 'TTS requests must stay below the per-session five-per-10-minute quota');
  for (const operation of ['bootstrap', 'text', 'asr', 'tts']) {
    assert.ok(fixture.maximum[operation] <= 5, `${operation} must not exceed concurrency 5`);
  }
  assert.equal(fixture.maximum.text, 5);
  assert.equal(fixture.maximum.asr, 5);
  assert.equal(fixture.maximum.tts, 5);

  const { filePath, record, contents } = fixture.artifacts[0];
  assert.equal(record.schemaVersion, 5);
  assert.equal(record.rawReceipts.textTurns.length, 200);
  assert.equal(record.rawReceipts.asrRequests.length, 30);
  assert.equal(record.rawReceipts.ttsRequests.length, 31);
  assert.equal(record.rawReceipts.timingQueries.length, 20);
  assert.equal(record.rawReceipts.controlPlaneRequests.length, 200);
  assert.deepEqual(record.access, {
    authenticated: true,
    audience: CANDIDATE_ROOT,
    issuer: 'https://accounts.google.com',
    subjectSha256: createHash('sha256').update(ACCEPTANCE_PRINCIPAL).digest('hex'),
    taggedUrl: ORIGIN,
  });
  assert.equal(JSON.stringify(record).includes(TEST_ID_TOKEN), false);
  assert.equal(basename(filePath), `${COMMIT}-${record.artifactSha256}.json`);
  assert.deepEqual(record.workload, LATENCY_ACCEPTANCE_CONTRACT);
  assert.deepEqual(record.metrics, {
    sendAck: { sampleCount: 200, p95Ms: 200, p95ThresholdMs: 300, pass: true },
    processingVisible: { sampleCount: 200, p95Ms: 400, p95ThresholdMs: 500, pass: true },
    groundedResponse: { sampleCount: 80, p50Ms: 2_400, p50ThresholdMs: 2_500, p95Ms: 2_400, p95ThresholdMs: 6_000, pass: true },
    asr10: { sampleCount: 10, p50Ms: 2_000, p50ThresholdMs: 2_500, p95Ms: 2_000, p95ThresholdMs: 4_000, pass: true },
    asr30: { sampleCount: 10, p95Ms: 5_000, p95ThresholdMs: 6_000, pass: true },
    asr55: { sampleCount: 10, p95Ms: 5_000, p95ThresholdMs: 6_000, pass: true },
    ttsReady: { sampleCount: 30, p50Ms: 1_900, p50ThresholdMs: 2_500, p95Ms: 1_900, p95ThresholdMs: 5_000, pass: true },
  });
  assert.deepEqual(record.invariants, {
    acknowledgedMessageLossCount: 0,
    duplicateAssistantReplyCount: 0,
    unsupportedVerifiedClaimCount: 0,
    ttsFailureTextLossCount: 0,
    ttsMediaValidationFailureCount: 0,
    ttsMessageBindingMismatchCount: 0,
    controlledTtsProviderFailureMismatchCount: 0,
  });
  assert.equal(record.observations.releaseCommitSha, COMMIT);
  assert.equal(record.observations.queryDigests.sampleCount, 20);
  assert.equal(record.observations.queryDigests.values.length, 20);
  assert.equal(record.observations.queryDigests.pass, true);
  assert.deepEqual(record.observations.provider, {
    text: { available: true, sampleCount: 80, p50Ms: 1_800, p95Ms: 1_800 },
    asr: { available: true, sampleCount: 30, p50Ms: 1_800, p95Ms: 1_800 },
    tts: { available: true, sampleCount: 30, p50Ms: 1_700, p95Ms: 1_700 },
  });
  assert.deepEqual(record.observations.server, {
    text: { available: true, sampleCount: 200, p50Ms: 2_300, p95Ms: 2_300 },
    asr: { available: true, sampleCount: 30, p50Ms: 5_000, p95Ms: 5_000 },
    tts: { available: true, sampleCount: 30, p50Ms: 1_900, p95Ms: 1_900 },
  });
  assert.deepEqual(record.observations.pairs, {
    text: {
      available: true,
      expectedServerCount: 200,
      serverBoundCount: 200,
      expectedProviderCount: 80,
      providerPairedCount: 80,
    },
    asr: { available: true, expectedCount: 30, pairedCount: 30 },
    tts: {
      available: true, expectedSuccessCount: 30, successPairedCount: 30,
      expectedFailureCount: 1, failurePairedCount: 1,
    },
  });
  assert.deepEqual(record.counts, {
    sessionsCreated: 20,
    textTurnsAttempted: 200,
    textTurnsAcknowledged: 200,
    textTurnsDelivered: 200,
    asrRequestsAttempted: 30,
    asrReady: 30,
    ttsRequestsAttempted: 31,
    ttsReady: 30,
    ttsControlledProviderFailures: 1,
  });
  assert.equal(record.commitSha, COMMIT);
  assert.equal(record.candidateOrigin, ORIGIN);
  assert.equal(record.occurredAt, NOW.toISOString());
  assert.equal(record.result, true);
  assert.match(record.fixtureSetSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(finalizeLatencyAcceptanceRecord(record), record);
  assert.equal(record.artifactSha256, createHash('sha256').update(canonicalJson(
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'artifactSha256')),
  )).digest('hex'));
  assert.deepEqual(JSON.parse(contents), record);
  assert.equal(contents.endsWith('\n'), true);

  const publicText = fixture.outputs.join('');
  assert.deepEqual(JSON.parse(publicText), result.publicReport);
  for (const forbidden of [ORIGIN, MANIFEST_PATH, 'private', 'transcript', 'audio', 'canonical-wav']) {
    assert.equal(publicText.includes(forbidden), false);
  }
  const artifactText = JSON.stringify(record);
  for (const forbidden of ['must-not-enter-artifact', 'private transcript', 'private audio', MANIFEST_PATH]) {
    assert.equal(artifactText.includes(forbidden), false);
  }
});

test('real requester sends the private-candidate ID token only in memory on every request', async () => {
  const observed = [];
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    identityToken: TEST_ID_TOKEN,
    acceptanceUserAgent: `hkbuddy-v1-acceptance/${'a'.repeat(64)}`,
    fetchImpl: async (url, options) => {
      observed.push({ url: String(url), headers: { ...options.headers } });
      return new Response(JSON.stringify({ data: {
        session: { id: 'session-1' },
        capabilities: {
          productionReady: true, releaseCommitSha: COMMIT, voiceInput: true, voiceOutput: true,
        },
      }, error: null, requestId: '00000000-0000-4000-8000-000000000001' }), {
        status: 201,
        headers: { 'set-cookie': 'hb_v1_session=fake-local-cookie; HttpOnly' },
      });
    },
  });
  const result = await requester({ operation: 'bootstrap', sessionIndex: 0 });
  assert.equal(result.ok, true);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].headers.Authorization, `Bearer ${TEST_ID_TOKEN}`);
  assert.equal(observed[0].headers['X-Serverless-Authorization'], undefined);
  assert.equal(observed[0].headers['User-Agent'], `hkbuddy-v1-acceptance/${'a'.repeat(64)}`);
  assert.equal(JSON.stringify(result).includes(TEST_ID_TOKEN), false);
});

test('nearest-rank threshold overflow or any invariant/count failure records a failed artifact', async (t) => {
  const cases = [
    ['send P95 above 300 ms', (input, result) => input.operation === 'text' ? { ...result, ackMs: 301 } : result],
    ['duplicate assistant reply', (input, result) => input.operation === 'text' && input.turnIndex === 0 ? { ...result, assistantReplyCount: 2 } : result],
    ['unsupported verified claim', (input, result) => input.operation === 'text' && input.turnIndex === 0 ? { ...result, unsupportedVerifiedClaimCount: 1 } : result],
    ['acknowledged message lost', (input, result) => input.operation === 'text' && input.turnIndex === 0 ? { ...result, messageLost: true } : result],
    ['ASR not ready', (input, result) => input.operation === 'asr' && input.sampleIndex === 0 ? { ...result, ready: false, transcriptMs: null } : result],
    ['TTS failure loses text', (input, result) => input.operation === 'tts' && input.requestIndex === 0 ? { ...result, ready: false, readyMs: null, textAvailable: false } : result],
    ['TTS media is not structurally validated', (input, result) => input.operation === 'tts' && input.requestIndex === 0 ? { ...result, mediaValidated: false } : result],
    ['timing observation is missing', (input, result) => input.operation === 'timings' && input.sessionIndex === 0 ? { ...result, samples: [] } : result],
    ['ASR server timing exceeds its correlated 10-second bucket SLO', (input, result) => {
      if (input.operation !== 'timings') return result;
      const index = result.samples.findIndex((sample) => sample.operation === 'asr' && sample.layer === 'server' && sample.durationMs === 10_000);
      if (index < 0) return result;
      const samples = result.samples.map((sample, sampleIndex) => sampleIndex === index ? { ...sample, latencyMs: 4_001 } : sample);
      return { ...result, samples };
    }],
    ['ASR timing binding cannot be paired to its accepted upload', (input, result) => {
      if (input.operation !== 'timings') return result;
      const index = result.samples.findIndex((sample) => sample.operation === 'asr' && sample.layer === 'provider');
      if (index < 0) return result;
      const samples = result.samples.map((sample, sampleIndex) => sampleIndex === index ? { ...sample, bindingId: 'wrong-upload' } : sample);
      return { ...result, samples };
    }],
    ['duplicate LLM timing cannot replace a different expected original operation', (input, result) => {
      if (input.operation !== 'timings') return result;
      const indexes = result.samples
        .map((sample, index) => ({ sample, index }))
        .filter(({ sample }) => sample.operation === 'text' && sample.layer === 'provider');
      if (indexes.length < 2) return result;
      const samples = result.samples.map((sample, index) => (
        index === indexes[1].index ? { ...indexes[0].sample } : sample
      ));
      return { ...result, samples };
    }],
    ['mutated LLM correlation cannot satisfy exact provider pairing', (input, result) => {
      if (input.operation !== 'timings') return result;
      const index = result.samples.findIndex((sample) => (
        sample.operation === 'text' && sample.layer === 'provider'
      ));
      if (index < 0) return result;
      const samples = result.samples.map((sample, sampleIndex) => sampleIndex === index
        ? { ...sample, correlationId: '99999999-9999-4999-8999-999999999999' }
        : sample);
      return { ...result, samples };
    }],
    ['mutated LLM binding cannot satisfy exact server pairing', (input, result) => {
      if (input.operation !== 'timings') return result;
      const index = result.samples.findIndex((sample) => (
        sample.operation === 'text' && sample.layer === 'server'
      ));
      if (index < 0) return result;
      const samples = result.samples.map((sample, sampleIndex) => sampleIndex === index
        ? { ...sample, bindingId: 'assistant-mutation' }
        : sample);
      return { ...result, samples };
    }],
    ['controlled TTS provider failure cannot be reclassified as success', (input, result) => {
      if (input.operation !== 'timings') return result;
      const index = result.samples.findIndex((sample) => sample.operation === 'tts' && sample.outcome === 'failure');
      if (index < 0) return result;
      const samples = result.samples.map((sample, sampleIndex) => sampleIndex === index ? { ...sample, outcome: 'success', failureCode: null } : sample);
      return { ...result, samples };
    }],
    ['timing query digest is wrong', (input, result) => input.operation === 'timings' && input.sessionIndex === 0 ? { ...result, queryDigest: '0'.repeat(64) } : result],
  ];

  for (const [name, resultFor] of cases) {
    await t.test(name, async () => {
      const fixture = createHarness({ resultFor });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.status, 'recorded');
      assert.equal(result.publicReport.code, 'LATENCY_ACCEPTANCE_FAILED');
      assert.equal(fixture.artifacts.length, 1);
      assert.equal(fixture.artifacts[0].record.result, false);
      assert.equal(fixture.artifacts[0].record.artifactSha256, result.publicReport.artifactSha256);
    });
  }
});

test('ASR and TTS thresholds ignore later client polling elapsed values and use only paired server timings', async () => {
  const fixture = createHarness({
    resultFor(input, fallback) {
      if (input.operation === 'asr') return { ...fallback, transcriptMs: 999_999 };
      if (input.operation === 'tts') return { ...fallback, readyMs: 999_999 };
      return fallback;
    },
  });
  const result = await fixture.run();
  assert.equal(result.exitCode, 0);
  assert.equal(fixture.artifacts[0].record.metrics.asr10.p95Ms, 2_000);
  assert.equal(fixture.artifacts[0].record.metrics.ttsReady.p95Ms, 1_900);
});

test('a release SHA or tracked-cleanliness change during the workload blocks artifact publication', async () => {
  const fixture = createHarness();
  let inspections = 0;
  const result = await fixture.run({
    inspectGit: async (gitCwd) => {
      fixture.calls.push(['git', gitCwd]);
      inspections += 1;
      return inspections === 1 ? { head: COMMIT, clean: true } : { head: COMMIT, clean: false };
    },
  });

  assert.equal(inspections, 2);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.publicReport, { status: 'failed', code: 'RELEASE_GIT_STATE_CHANGED' });
  assert.equal(fixture.artifacts.length, 0);
});

test('a candidate redeploy during the workload is detected with the existing session before artifact publication', async () => {
  const fixture = createHarness({
    resultFor(input, fallback) {
      if (input.operation !== 'verifyCandidate') return fallback;
      return {
        ...fallback,
        capabilities: {
          ...fallback.capabilities,
          releaseCommitSha: '2'.repeat(40),
        },
      };
    },
  });
  const result = await fixture.run();

  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.publicReport, { status: 'failed', code: 'CANDIDATE_RELEASE_CHANGED' });
  assert.equal(fixture.calls.filter(([, input]) => input?.operation === 'verifyCandidate').length, 1);
  assert.equal(fixture.artifacts.length, 0);
});

test('real HTTP requester never re-synthesizes cached TTS and binds status/media to the requested message', async () => {
  let clock = 0;
  const requests = [];
  let audioStatusRequests = 0;
  const mp3 = canonicalMp3Fixture();
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: options.method ?? 'GET' });
    if (path === '/api/v1/voice/transcriptions') {
      for await (const ignored of options.body) {
        void ignored;
        clock += 1_000;
      }
      clock += 5_000;
      return new Response(JSON.stringify({ data: { state: 'ready' }, error: null }), { status: 201 });
    }
    if (path.endsWith('/audio/status')) {
      audioStatusRequests += 1;
      clock += 4_000;
      if (audioStatusRequests === 1) {
        return new Response(JSON.stringify({ data: {
          messageId: 'assistant-1', state: 'pending', mediaId: null,
        }, error: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {
        messageId: 'assistant-1', state: 'attached', mediaId: '99999999-9999-4999-8999-999999999999',
      }, error: null }), { status: 200 });
    }
    if (path.endsWith('/media/99999999-9999-4999-8999-999999999999')) {
      const baseHeaders = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' };
      if (options.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { ...baseHeaders, 'content-length': String(mp3.length) } });
      }
      if (options.headers?.Range === 'bytes=0-3') {
        return new Response(mp3.subarray(0, 4), { status: 206, headers: {
          ...baseHeaders, 'content-length': '4', 'content-range': `bytes 0-3/${mp3.length}`,
        } });
      }
      return new Response(mp3, { status: 200, headers: { ...baseHeaders, 'content-length': String(mp3.length) } });
    }
    if (path === '/api/v1/messages') {
      clock += 2_000;
      return new Response(JSON.stringify({
        data: { messages: [{ id: 'assistant-1', role: 'assistant', status: 'delivered', text: 'Text survives.' }] },
        error: null,
      }), { status: 200 });
    }
    throw new Error(`unexpected fake URL ${url}`);
  };
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchImpl,
    monotonicNow: () => clock,
    sleep: async () => {},
  });
  const bytes = Buffer.alloc(64, 1);
  const asr = await requester({
    operation: 'asr',
    session: { cookie: 'hb_v1_session=fake-local-cookie' },
    clientUploadId: '11111111-1111-4111-8111-111111111111',
    sample: {
      bytes,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
  assert.equal(asr.transcriptMs, 5_000, 'the 1-second upload must not enter ASR provider-to-transcript timing');

  clock = 0;
  const tts = await requester({
    operation: 'tts',
    session: { cookie: 'hb_v1_session=fake-local-cookie' },
    assistantMessageId: 'assistant-1',
  });
  assert.equal(tts.textAvailable, true);
  assert.equal(tts.mediaValidated, true);
  assert.equal(tts.messageIdMatches, true);
  assert.equal(audioStatusRequests, 2);
  assert.equal(requests.some(({ path, method }) => path.endsWith('/audio') && method === 'POST'), false);

  const mismatchedRequester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/audio/status')) {
        return new Response(JSON.stringify({ data: {
          messageId: 'different-assistant', state: 'ready', mediaId: '99999999-9999-4999-8999-999999999999',
        }, error: null }), { status: 200 });
      }
      return fetchImpl(url, options);
    },
  });
  const mismatched = await mismatchedRequester({
    operation: 'tts', session: { cookie: 'hb_v1_session=fake-local-cookie' }, assistantMessageId: 'assistant-1',
  });
  assert.equal(mismatched.messageIdMatches, false);
  assert.equal(mismatched.mediaValidated, false);
});

test('real HTTP requester stops and cancels an oversized streamed JSON body before buffering it all', async () => {
  const chunkBytes = 256 * 1_024;
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      if (pulls === 10) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'set-cookie': 'hb_v1_session=fake-local-cookie; HttpOnly' },
    }),
  });

  await assert.rejects(
    requester({ operation: 'bootstrap', sessionIndex: 0 }),
    /response too large/,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 6, `expected a bounded read, observed ${pulls} chunks`);
});

test('real HTTP requester aborts and cancels a hung response body at the fetch deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchDeadlineMs: 25,
    fetchImpl: async () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }), { status: 200 }),
  });
  const pending = requester({ operation: 'bootstrap', sessionIndex: 0 });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  t.mock.timers.tick(25);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'rejected');
  assert.equal(observation.error?.code, 'LATENCY_HTTP_DEADLINE_EXCEEDED');
  assert.equal(cancelled, true);
});

test('Git inspection is sequential so an early failure cannot orphan a sibling subprocess', async () => {
  const calls = [];
  const executeFile = async (_command, args, options) => {
    calls.push({ args, signal: options.signal });
    if (args[0] === 'rev-parse') throw new Error('safe fake failure');
    return new Promise(() => {});
  };

  await assert.rejects(inspectGitState(CWD, { executeFile }), /safe fake failure/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['rev-parse', '--verify', 'HEAD']);
});

test('real HTTP requester aborts a hung fetch at its operation deadline without exposing the private candidate URL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const privateOrigin = 'https://private-token@v1-candidate.example.com';
  let fetchSignal = null;
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchDeadlineMs: 25,
    fetchImpl: async (_url, options) => {
      fetchSignal = options.signal;
      return new Promise(() => {});
    },
  });
  const pending = requester({ operation: 'bootstrap', sessionIndex: 0 });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(fetchSignal instanceof AbortSignal);
  t.mock.timers.tick(25);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'rejected');
  assert.equal(observation.error?.code, 'LATENCY_HTTP_DEADLINE_EXCEEDED');
  assert.equal(fetchSignal.aborted, true);
  assert.equal(String(observation.error).includes(privateOrigin), false);
  assert.equal(String(observation.error).includes(ORIGIN), false);
});

test('poll deadline aborts an in-flight fetch instead of waiting for the fetch deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  let requestCount = 0;
  const requester = createLatencyHttpRequester({
    candidateOrigin: ORIGIN,
    fetchDeadlineMs: 1_000,
    pollDeadlineMs: 40,
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ data: { state: 'processing' }, error: null }), { status: 202 });
      }
      return new Promise(() => {});
    },
    sleep: async () => {},
  });
  const bytes = Buffer.alloc(64, 1);
  const pending = requester({
    operation: 'asr',
    session: { cookie: 'hb_v1_session=fake-local-cookie' },
    clientUploadId: '11111111-1111-4111-8111-111111111111',
    sample: {
      bytes,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.equal(requestCount, 2);
  t.mock.timers.tick(40);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'fulfilled');
  assert.deepEqual(observation.value, {
    ready: false, transcriptMs: null, durationBucketSeconds: null,
    requestStatus: 202, requestId: null, responseStatus: 0, responseRequestId: null,
  });
  assert.equal(signals[1].aborted, true);
});

test('total latency command deadline aborts a hung custom requester and emits only a safe bounded failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal = null;
  const fixture = createHarness({
    requester: async (_input, context) => {
      requestSignal = context?.signal ?? null;
      return new Promise(() => {});
    },
  });
  const pending = fixture.run({ commandDeadlineMs: 50, requestDeadlineMs: 1_000 });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(requestSignal instanceof AbortSignal);
  t.mock.timers.tick(50);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'fulfilled');
  assert.deepEqual(observation.value.publicReport, {
    status: 'failed',
    code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
  });
  assert.equal(requestSignal.aborted, true);
  assert.equal(fixture.artifacts.length, 0);
  const serialized = fixture.outputs.join('');
  assert.equal(serialized.includes(ORIGIN), false);
  assert.equal(serialized.includes('private-token'), false);
});

test('total latency command deadline is not downgraded to a Git-state error when Git inspection hangs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let gitSignal = null;
  let fixturesRead = false;
  const outputs = [];
  const pending = runLatencyAcceptance({
    argv: exactArgv(),
    environment: {
      V1_LOAD_TEST_CONFIRM: 'true', V1_RELEASE_COMMIT_SHA: COMMIT,
      V1_PUBLIC_ORIGIN: STABLE_ORIGIN, V1_CANDIDATE_ORIGIN: ORIGIN,
      V1_SOURCE_ARCHIVE_SHA256: SOURCE_ARCHIVE_SHA256,
      V1_CANDIDATE_IMAGE_DIGEST: CANDIDATE_IMAGE_DIGEST,
      V1_CANDIDATE_REVISION: CANDIDATE_REVISION,
      V1_CANDIDATE_TRAFFIC_PERCENT: '100',
      V1_CANDIDATE_AUDIENCE: CANDIDATE_ROOT,
      V1_CANDIDATE_SERVICE: CANDIDATE_SERVICE,
      V1_STABLE_SERVICE: STABLE_SERVICE,
      V1_CANDIDATE_TRAFFIC_STATE: 'candidate-service-private-100',
      V1_STABLE_TRAFFIC_STATE: 'stable-prior-100',
    },
    cwd: CWD,
    artifactDirectory: resolve('reports', 'latency-test'),
    commandDeadlineMs: 40,
    operationDeadlineMs: 1_000,
    inspectGit: async (_cwd, context) => {
      gitSignal = context?.signal ?? null;
      return new Promise(() => {});
    },
    loadAsrFixtures: async () => {
      fixturesRead = true;
      return fixtureSet();
    },
    requester: async () => { throw new Error('requester must not be reached'); },
    writeOutput: (line) => outputs.push(line),
  });
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(gitSignal instanceof AbortSignal);
  t.mock.timers.tick(40);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.deepEqual(observation.value.publicReport, {
    status: 'failed',
    code: 'LATENCY_COMMAND_DEADLINE_EXCEEDED',
  });
  assert.equal(gitSignal.aborted, true);
  assert.equal(fixturesRead, false);
  assert.equal(outputs.join('').includes(ORIGIN), false);
});

test('request failures and artifact failures are fail-closed and never print raw errors, URLs, or fixture paths', async (t) => {
  await t.test('request failure becomes a safe failed measurement', async () => {
    const fixture = createHarness({
      requester: async (input) => {
        fixture.calls.push(['request', input]);
        if (['bootstrap', 'verifyCandidate'].includes(input.operation)) {
          return {
            ok: true,
            session: { sessionIndex: input.sessionIndex },
            capabilities: { productionReady: true, releaseCommitSha: COMMIT, voiceInput: true, voiceOutput: true },
          };
        }
        throw new Error(`private-token at ${ORIGIN}${MANIFEST_PATH}`);
      },
    });
    const result = await fixture.run();

    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'LATENCY_ACCEPTANCE_FAILED');
    assert.equal(fixture.artifacts.length, 1);
    const output = fixture.outputs.join('');
    assert.equal(output.includes('private-token'), false);
    assert.equal(output.includes(ORIGIN), false);
    assert.equal(output.includes(MANIFEST_PATH), false);
  });

  await t.test('artifact write failure is safely normalized', async () => {
    const fixture = createHarness({
      writeArtifact: async ({ filePath }) => {
        throw new Error(`private-token ${filePath}`);
      },
    });
    const result = await fixture.run();

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.publicReport, { status: 'failed', code: 'LATENCY_ARTIFACT_WRITE_FAILED' });
    assert.equal(fixture.outputs.join('').includes('private-token'), false);
    assert.equal(fixture.outputs.join('').includes(ORIGIN), false);
  });
});

test('default artifact publication is immutable and cannot overwrite the same frozen-run record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hk-buddy-latency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = createHarness();
  const input = { artifactDirectory: directory };

  const first = await fixture.run({ ...input, writeArtifact: undefined });
  assert.equal(first.exitCode, 0);
  const files = await readdir(directory);
  assert.deepEqual(files, [`${COMMIT}-${first.publicReport.artifactSha256}.json`]);
  const filePath = join(directory, files[0]);
  const original = await readFile(filePath, 'utf8');

  const second = await createHarness().run({ ...input, writeArtifact: undefined });
  assert.equal(second.exitCode, 1);
  assert.deepEqual(second.publicReport, { status: 'failed', code: 'LATENCY_ARTIFACT_EXISTS' });
  assert.equal(await readFile(filePath, 'utf8'), original);
});
