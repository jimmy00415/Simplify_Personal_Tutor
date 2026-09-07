import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { GCP_IDENTITY } from '../src/gcp-identity.js';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  assertImageReleaseFileList,
  assertImageReleaseScriptList,
  verifyImageReleaseRoot,
} from '../scripts/image-release-contract.js';
import { writeImageReleaseManifest } from '../scripts/create-image-release-manifest.js';
import { CANONICAL_WAV } from '../src/media/canonical-wav.js';
import { finalizeReleaseEvidenceRecord } from '../src/services/release-evidence.js';
import {
  finalizeEvidenceRecord,
  iosVoiceEvidenceContract,
  iosVoiceNormalizationBinding,
} from '../src/services/voice-evidence.js';
import {
  LATENCY_ACCEPTANCE_CONTRACT,
  finalizeLatencyAcceptanceRecord,
} from '../scripts/production-latency-workload.js';
import {
  CANDIDATE_PRIVACY_SCHEMA_VERSION,
  candidatePrivacyBoundarySha256,
  finalizeCandidatePrivacyProof,
} from '../scripts/candidate-privacy-proof.js';
import * as gcpReleaseContract from '../scripts/gcp-release.js';
import { finalizeTask8ReadinessRecord } from '../scripts/task8-readiness-producer.js';
import {
  MOBILE_BROWSER_CONTRACT,
  MOBILE_CHECK_IDS,
  MOBILE_WAV_CONTRACT,
  finalizeTask8MobileRecord,
} from '../scripts/task8-mobile-producer.js';
import {
  buildReleasePlan,
  candidatePrivacyAuthorityFromJournal,
  containsForbiddenPersistedSecret,
  createReleaseGcloudExecutor,
  inspectCollectedEvidenceArtifact,
  prepareReleaseArchive,
  runPrepareReleaseArchive,
  runGcpRelease as runGcpReleaseImpl,
  releasePhaseIdentitySha256,
  releaseMutationPlanIdentity,
  releaseActionReceiptPath,
  finalizeReleasePhaseReceipt,
  validateBuildReceipt,
  validateCandidateReadback,
  validateCandidateControlPlaneReadbacks,
  validateAcceptanceObjectReceipt,
  validateEvidenceArtifactFile,
  validateEvidenceVersionReceipt,
  validateMigrationExecutionReceipt,
  validateFailedReleaseJobExecutionReceipt,
  validateRejectedCloudRunExecutionLog,
  validateReleaseReceiptChain,
  validateReleaseJobReadback,
  validateReadyReleaseJobReadback,
  validateServiceIamReceipt,
  validateTrafficReceipt,
  validateTask8EvidenceArtifact,
} from '../scripts/gcp-release.js';

const PROJECT = 'motion-expert-hk-ltd-webpage';
const REGION = 'asia-east2';
const RELEASE_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(64);
const BUILD_CONFIG_SHA = 'e'.repeat(64);
const BUILD_CONFIG = `C:\\release\\${RELEASE_SHA}.${BUILD_CONFIG_SHA}.cloudbuild.yaml`;
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const PREVIOUS_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const PROJECT_NUMBER = '582852715831';
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SA = `projects/${PROJECT}/serviceAccounts/hkbuddy-v1-build@${PROJECT}.iam.gserviceaccount.com`;
const BUILD_ID = '12345678-1234-4234-8234-123456789abc';
const NODE_BUILDER = 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const DOCKER_BUILDER = 'gcr.io/cloud-builders/docker@sha256:2e8d40d8e48dc14fab4213d5e532d74f63fd403d9e8d7f6463096a75820286c3';
const RUNTIME_SA = `hkbuddy-v1-runtime@${PROJECT}.iam.gserviceaccount.com`;
const ACCEPTANCE_SA = `hkbuddy-v1-acceptance@${PROJECT}.iam.gserviceaccount.com`;
const ACCEPTANCE_RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const STABLE_SERVICE = 'hkbuddy-v1-api';
const CANDIDATE_SERVICE = 'hkbuddy-v1-api-candidate';
const CANDIDATE_TAG = `candidate-${RELEASE_SHA.slice(0, 12)}`;
const REVISION = `${CANDIDATE_SERVICE}-${RELEASE_SHA.slice(0, 12)}`;
const STABLE_REVISION = `${STABLE_SERVICE}-${RELEASE_SHA.slice(0, 12)}`;
const STABLE_ORIGIN = `https://${STABLE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
const CANDIDATE_ROOT = `https://${CANDIDATE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
const CANDIDATE_ORIGIN = `https://${CANDIDATE_TAG}---${CANDIDATE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
const QA_SUBJECT_SHA256 = createHash('sha256').update(ACCEPTANCE_SA).digest('hex');
const IMAGE_SCRIPTS = Object.freeze([
  'scripts/image-release-contract.js',
  'scripts/provider-smoke.js',
  'scripts/real-dependencies-acceptance.js',
  'scripts/run-migrations.js',
  'scripts/voice-provider-smoke.js',
]);

function artifactReadback(image) {
  const separator = image.lastIndexOf('@');
  assert.notEqual(separator, -1, 'test artifact image must be digest-qualified');
  return {
    image_summary: {
      digest: image.slice(separator + 1),
      fully_qualified_digest: image,
    },
  };
}

const EVIDENCE = Object.freeze({
  legacyInventory: Object.freeze({
    secret: 'hkbuddy-v1-legacy-inventory', secretVersion: '11',
    artifactSha256: '1'.repeat(64), objectSha256: 'a'.repeat(64), filePath: 'C:\\release\\legacy-inventory.json',
  }),
  dependencyAcceptance: Object.freeze({
    secret: 'hkbuddy-v1-dependency-acceptance', secretVersion: '12',
    artifactSha256: '2'.repeat(64), objectSha256: 'b'.repeat(64), filePath: 'C:\\release\\dependency-acceptance.json',
  }),
  llmSmoke: Object.freeze({
    secret: 'hkbuddy-v1-llm-smoke', secretVersion: '13',
    artifactSha256: '3'.repeat(64), objectSha256: 'c'.repeat(64), filePath: 'C:\\release\\llm-smoke.json',
  }),
  asrSmoke: Object.freeze({
    secret: 'hkbuddy-v1-asr-smoke', secretVersion: '14',
    artifactSha256: '4'.repeat(64), objectSha256: 'd'.repeat(64), filePath: 'C:\\release\\asr-smoke.json',
  }),
  ttsSmoke: Object.freeze({
    secret: 'hkbuddy-v1-tts-smoke', secretVersion: '15',
    artifactSha256: '5'.repeat(64), objectSha256: 'e'.repeat(64), filePath: 'C:\\release\\tts-smoke.json',
  }),
  iosVoiceAcceptance: Object.freeze({
    secret: 'hkbuddy-v1-ios-voice-acceptance', secretVersion: '16',
    artifactSha256: '6'.repeat(64), objectSha256: 'f'.repeat(64), filePath: 'C:\\release\\ios-voice-acceptance.json',
  }),
});

const ACCEPTANCE_OUTPUTS = Object.freeze({
  dependencyAcceptance: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/dependency-acceptance/${ACCEPTANCE_RUN_ID}.json`,
    generation: '101',
    filePath: EVIDENCE.dependencyAcceptance.filePath,
  }),
  llmSmoke: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/llm-smoke/llm-${ACCEPTANCE_RUN_ID}.json`,
    generation: '102',
    filePath: EVIDENCE.llmSmoke.filePath,
  }),
  asrSmoke: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/asr-${ACCEPTANCE_RUN_ID}.json`,
    generation: '103',
    filePath: EVIDENCE.asrSmoke.filePath,
  }),
  ttsSmoke: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/tts-${ACCEPTANCE_RUN_ID}.json`,
    generation: '104',
    filePath: EVIDENCE.ttsSmoke.filePath,
  }),
});

function task8PrivacyProofReference(phase, boundary) {
  const digit = {
    readiness: { start: 'a', end: 'b' },
    workload: { start: 'c', end: 'd' },
    mobile: { start: 'e', end: 'f' },
  }[phase][boundary];
  const observedAt = boundary === 'start'
    ? '2026-08-26T08:00:00.000Z' : '2026-08-26T08:10:00.000Z';
  const expiresAt = boundary === 'start'
    ? '2026-08-26T08:05:00.000Z' : '2026-08-26T08:15:00.000Z';
  return {
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    filePath: `C:\\release\\${phase}-${boundary}-privacy.json`,
    artifactSha256: digit.repeat(64),
    objectSha256: digit.repeat(64),
    boundarySha256: digit.repeat(64),
    observedAt,
    expiresAt,
  };
}

function task8Entry(phase, stableTrafficState) {
  const digit = { readiness: '7', workload: '8', mobile: '9' }[phase];
  return {
    schemaVersion: 3,
    filePath: `C:\\release\\${phase}.json`,
    artifactSha256: digit.repeat(64),
    objectSha256: digit.repeat(64),
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: 'candidate-service-private-100',
    stableTrafficState,
    privacyProofs: {
      start: task8PrivacyProofReference(phase, 'start'),
      end: task8PrivacyProofReference(phase, 'end'),
    },
  };
}

function candidatePrivacyReference(plan) {
  return {
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    filePath: plan.candidatePrivacyProofPath,
    artifactSha256: '1'.repeat(64),
    objectSha256: '2'.repeat(64),
    boundarySha256: candidatePrivacyBoundarySha256({
      projectId: PROJECT,
      projectNumber: PROJECT_NUMBER,
      organizationId: GCP_IDENTITY.organizationId,
      region: REGION,
      releaseSha: plan.releaseSha,
      imageDigest: plan.imageDigest,
      image: plan.expectedCandidate.image,
      candidateService: plan.candidateService,
      candidateRevision: plan.candidateRevision,
      candidateTag: plan.candidateTag,
      candidateOrigin: plan.candidateOrigin,
      candidateAudience: plan.candidateServiceOrigin,
      acceptanceServiceAccount: ACCEPTANCE_SA,
      operator: 'admin@motionexp.com',
      expectedCandidate: plan.expectedCandidate,
    }),
    observedAt: '2026-08-26T08:00:00.000Z',
    expiresAt: '2026-08-26T08:05:00.000Z',
  };
}

function releaseInput(overrides = {}) {
  const previousRevision = Object.hasOwn(overrides, 'previousRevision')
    ? overrides.previousRevision : `${STABLE_SERVICE}-111111111111`;
  const stableTrafficState = previousRevision === null ? 'stable-absent' : 'stable-prior-100';
  return {
    releaseSha: RELEASE_SHA,
    sourceArchive: 'C:\\release\\source.tar.gz',
    sourceArchiveSha256: SOURCE_SHA,
    buildConfig: BUILD_CONFIG,
    buildConfigSha256: BUILD_CONFIG_SHA,
    imageDigest: IMAGE_DIGEST,
    projectNumber: PROJECT_NUMBER,
    databaseSecretVersions: { app: '7', migrator: '8', session: '9' },
    acceptanceRunId: ACCEPTANCE_RUN_ID,
    acceptanceOutputs: ACCEPTANCE_OUTPUTS,
    task8Evidence: Object.fromEntries(['readiness', 'workload', 'mobile'].map((phase) => [
      phase, task8Entry(phase, stableTrafficState),
    ])),
    legacyInventory: EVIDENCE.legacyInventory,
    evidence: EVIDENCE,
    previousRevision,
    previousImageDigest: PREVIOUS_IMAGE_DIGEST,
    ...overrides,
  };
}

function validIosVoiceAcceptancePayload(occurredAt = '2026-08-29T08:00:00.000Z') {
  const platform = 'win32-x64';
  const payload = {
    schemaVersion: iosVoiceEvidenceContract.schemaVersion,
    commitSha: RELEASE_SHA,
    capability: 'ios-voice',
    normalizerContractVersion: CANONICAL_WAV.contractVersion,
    reportSource: iosVoiceEvidenceContract.reportSource,
    deviceReportSha256: '4'.repeat(64),
    deviceReportByteLength: 1_024,
    deviceRunId: '88888888-8888-4888-8888-888888888888',
    deviceModelIdentifier: 'iPhone16,1',
    iosVersion: '19.0',
    safariVersion: '19.0',
    captureMimeType: 'audio/mp4',
    deviceObservedAt: occurredAt,
    rawCaptureFormat: iosVoiceEvidenceContract.rawCaptureFormat,
    rawCaptureSha256: '1'.repeat(64),
    rawCaptureByteLength: 4_096,
    fixtureSha256: '2'.repeat(64),
    fixtureDurationMs: 1_000,
    fixtureByteLength: 32_044,
    normalizationStepsSha256: '3'.repeat(64),
    normalizationStepsByteLength: 2_048,
    normalizerPackage: iosVoiceEvidenceContract.normalizer.package,
    normalizerPlatform: platform,
    normalizerBinarySha256: iosVoiceEvidenceContract.normalizer.platforms[platform].binarySha256,
    normalizerVersion: iosVoiceEvidenceContract.normalizer.platforms[platform].version,
    normalizerArguments: [...iosVoiceEvidenceContract.normalizer.arguments],
    normalizerExitCode: 0,
    normalizationBindingSha256: null,
    verifiedStepIds: [...iosVoiceEvidenceContract.stepIds],
    occurredAt,
    result: 'pass',
  };
  payload.normalizationBindingSha256 = iosVoiceNormalizationBinding(payload);
  return payload;
}

function validIosVoiceWaiverPayload(approvedAt = '2026-08-29T08:00:00.000Z') {
  return {
    schemaVersion: 1,
    commitSha: RELEASE_SHA,
    capability: 'ios-voice',
    decision: 'waived',
    scope: 'real-iphone-safari',
    approvedBy: 'admin@motionexp.com',
    approvedAt,
    expiresAt: new Date(Date.parse(approvedAt) + (7 * 24 * 60 * 60 * 1_000)).toISOString(),
    reasonCode: 'product-owner-deferred-device-test',
    limitations: ['not-real-ios-tested'],
    result: 'waived',
  };
}

async function materializedReleaseEvidenceInput(t, { mutateIos, iosPayload: selectedIosPayload } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-release-semantic-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const iosPayload = selectedIosPayload ?? validIosVoiceAcceptancePayload();
  mutateIos?.(iosPayload);
  if (iosPayload.schemaVersion === iosVoiceEvidenceContract.schemaVersion) {
    iosPayload.normalizationBindingSha256 = iosVoiceNormalizationBinding(iosPayload);
  }
  const records = {
    legacyInventory: finalizeReleaseEvidenceRecord({
      schemaVersion: 1, commitSha: RELEASE_SHA, result: true,
    }),
    dependencyAcceptance: finalizeReleaseEvidenceRecord({
      schemaVersion: 1, commitSha: RELEASE_SHA, result: true,
    }),
    llmSmoke: finalizeReleaseEvidenceRecord({
      schemaVersion: 1, commitSha: RELEASE_SHA, capability: 'llm', result: 'pass',
    }),
    asrSmoke: finalizeEvidenceRecord({
      schemaVersion: 1, commitSha: RELEASE_SHA, capability: 'asr', result: 'pass',
    }),
    ttsSmoke: finalizeEvidenceRecord({
      schemaVersion: 1, commitSha: RELEASE_SHA, capability: 'tts', result: 'pass',
    }),
    iosVoiceAcceptance: finalizeEvidenceRecord(iosPayload),
  };
  const evidence = {};
  for (const [key, record] of Object.entries(records)) {
    const filePath = join(directory, `${key}.json`);
    const contents = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(filePath, contents, { flag: 'wx' });
    evidence[key] = {
      ...EVIDENCE[key],
      filePath,
      artifactSha256: record.artifactSha256,
      objectSha256: createHash('sha256').update(contents).digest('hex'),
    };
  }
  const acceptanceOutputs = Object.fromEntries(Object.entries(ACCEPTANCE_OUTPUTS)
    .map(([key, output]) => [key, { ...output, filePath: evidence[key].filePath }]));
  return releaseInput({
    acceptanceOutputs,
    evidence,
    legacyInventory: evidence.legacyInventory,
  });
}

function exactCloudBuildReceipt() {
  const imageName = `asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy-v1/hkbuddy-v1-api:${RELEASE_SHA}`;
  const validateInputs = "if (!/^[0-9a-f]{40}$/.test(process.env.RELEASE_SHA || '') || !/^[0-9a-f]{64}$/.test(process.env.SOURCE_SHA256 || '') || !/^[0-9a-f]{64}$/.test(process.env.BUILD_CONFIG_SHA256 || '')) { process.stderr.write('invalid release SHA\\n'); process.exit(2); }";
  const verifyLabels = [
    `test "$(docker inspect --format='{{ index .Config.Labels "org.opencontainers.image.revision" }}' ${imageName})" = "${RELEASE_SHA}"`,
    `test "$(docker inspect --format='{{ index .Config.Labels "com.simplify.source-archive-sha256" }}' ${imageName})" = "${SOURCE_SHA}"`,
    `test "$(docker inspect --format='{{ index .Config.Labels "com.simplify.build-config-sha256" }}' ${imageName})" = "${BUILD_CONFIG_SHA}"`,
    `test "$(docker inspect --format='{{ index .Config.Labels "org.opencontainers.image.source" }}' ${imageName})" = "https://github.com/jimmy00415/Cantonese_Learning_Full_stack"`,
  ].join(' && ');
  const storageSource = {
    bucket: 'hkbuddy-v1-582852715831-build-source',
    object: 'source/source.tgz',
    generation: '123',
  };
  const sourceUri = `gs://${storageSource.bucket}/${storageSource.object}#${storageSource.generation}`;
  return {
    id: BUILD_ID,
    name: `projects/${PROJECT}/locations/${REGION}/builds/${BUILD_ID}`,
    projectId: PROJECT,
    status: 'SUCCESS',
    serviceAccount: BUILD_SA,
    timeout: '1200s',
    images: [imageName],
    substitutions: {
      _BUILD_CONFIG_SHA256: BUILD_CONFIG_SHA,
      _RELEASE_SHA: RELEASE_SHA,
      _SOURCE_SHA256: SOURCE_SHA,
    },
    options: {
      logging: 'CLOUD_LOGGING_ONLY',
      requestedVerifyOption: 'VERIFIED',
      sourceProvenanceHash: ['SHA256'],
    },
    steps: [
      {
        id: 'validate-release-sha', name: NODE_BUILDER, entrypoint: 'node',
        args: ['-e', validateInputs],
        env: [
          `RELEASE_SHA=${RELEASE_SHA}`,
          `SOURCE_SHA256=${SOURCE_SHA}`,
          `BUILD_CONFIG_SHA256=${BUILD_CONFIG_SHA}`,
        ],
        waitFor: ['-'], status: 'SUCCESS',
      },
      {
        id: 'dependency-security-gate', name: NODE_BUILDER, entrypoint: 'sh',
        args: ['-ceu', 'npm ci --omit=dev --ignore-scripts --no-audit && npm run --silent security:dependencies'],
        env: [], waitFor: ['validate-release-sha'], status: 'SUCCESS', exitCode: 0,
      },
      {
        id: 'build', name: DOCKER_BUILDER, entrypoint: 'docker',
        args: [
          'build', '--file=Dockerfile', `--tag=${imageName}`,
          `--label=org.opencontainers.image.revision=${RELEASE_SHA}`,
          '--label=org.opencontainers.image.source=https://github.com/jimmy00415/Cantonese_Learning_Full_stack',
          `--label=com.simplify.source-archive-sha256=${SOURCE_SHA}`,
          `--label=com.simplify.build-config-sha256=${BUILD_CONFIG_SHA}`,
          `--build-arg=V1_RELEASE_COMMIT_SHA=${RELEASE_SHA}`,
          `--build-arg=V1_SOURCE_ARCHIVE_SHA256=${SOURCE_SHA}`,
          `--build-arg=V1_BUILD_CONFIG_SHA256=${BUILD_CONFIG_SHA}`,
          '.',
        ],
        env: [], waitFor: ['dependency-security-gate'], status: 'SUCCESS',
      },
      {
        id: 'verify-image-contract', name: DOCKER_BUILDER, entrypoint: 'docker',
        args: [
          'run', '--rm', '--entrypoint=node',
          `--env=V1_RELEASE_COMMIT_SHA=${RELEASE_SHA}`,
          `--env=V1_SOURCE_ARCHIVE_SHA256=${SOURCE_SHA}`,
          `--env=V1_BUILD_CONFIG_SHA256=${BUILD_CONFIG_SHA}`,
          imageName, 'scripts/image-release-contract.js',
        ],
        env: [], waitFor: ['build'], status: 'SUCCESS',
      },
      {
        id: 'verify-oci-labels', name: DOCKER_BUILDER, entrypoint: 'sh',
        args: ['-ceu', verifyLabels],
        env: [], waitFor: ['verify-image-contract'], status: 'SUCCESS',
      },
    ],
    source: { storageSource },
    sourceProvenance: {
      resolvedStorageSource: storageSource,
      fileHashes: {
        [sourceUri]: {
          fileHash: [{ type: 'SHA256', value: Buffer.from(SOURCE_SHA, 'hex').toString('base64') }],
        },
      },
    },
    results: {
      buildStepImages: [
        `sha256:${NODE_BUILDER.split('@sha256:')[1]}`,
        `sha256:${NODE_BUILDER.split('@sha256:')[1]}`,
        `sha256:${DOCKER_BUILDER.split('@sha256:')[1]}`,
        `sha256:${DOCKER_BUILDER.split('@sha256:')[1]}`,
        `sha256:${DOCKER_BUILDER.split('@sha256:')[1]}`,
      ],
      images: [{
        name: imageName,
        digest: IMAGE_DIGEST,
        artifactRegistryPackage: `projects/${PROJECT}/locations/${REGION}/repositories/hkbuddy-v1/packages/hkbuddy-v1-api/versions/${IMAGE_DIGEST}`,
      }],
    },
  };
}

function canonicalFixture(value) {
  if (Array.isArray(value)) return value.map(canonicalFixture);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalFixture(value[key])]));
  }
  return value;
}

test('release command histories bind only the selected V1 resource island', () => {
  const plan = buildReleasePlan(releaseInput());
  const contract = JSON.stringify(plan);
  const history = JSON.stringify(plan.operations);
  for (const expected of [
    '--project=motion-expert-hk-ltd-webpage',
    'asia-east2-docker.pkg.dev/motion-expert-hk-ltd-webpage/hkbuddy-v1/hkbuddy-v1-api@sha256:',
    'projects/motion-expert-hk-ltd-webpage/serviceAccounts/hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com',
    'hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com',
    'hkbuddy-v1-migrator@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com',
    'hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com',
    'hkbuddy-v1-migrate',
    'hkbuddy-v1-dependency-acceptance',
    'hkbuddy-v1-llm-smoke',
    'hkbuddy-v1-asr-smoke',
    'hkbuddy-v1-tts-smoke',
    'hkbuddy-v1-582852715831-media',
    'https://hkbuddy-v1-api-582852715831.asia-east2.run.app',
  ]) assert.equal(contract.includes(expected), true, expected);
  for (const forbidden of [
    'hkbuddy-prod-v1-20260826',
    '93662314720',
    '/hkbuddy/hkbuddy-api',
    'hkbuddy-runtime@',
    'hkbuddy-migrate"',
    'foreign-project-999',
  ]) assert.equal(history.includes(forbidden), false, forbidden);
});

test('release plan rejects old and foreign project numbers before producing commands', () => {
  for (const projectNumber of ['93662314720', '999999999999']) {
    assert.throws(() => buildReleasePlan(releaseInput({ projectNumber })), /release contract/i);
  }
});

test('Cloud Build is pinned to the governed source staging bucket and receipt prefix', () => {
  const plan = buildReleasePlan(releaseInput());
  const submit = plan.operations.find(({ id }) => id === 'build-submit');
  assert.equal(submit.argv.includes(
    '--gcs-source-staging-dir=gs://hkbuddy-v1-582852715831-build-source/source',
  ), true);

  const receipt = exactCloudBuildReceipt();
  assert.doesNotThrow(() => validateBuildReceipt(receipt, {
    releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  }));
  for (const [bucket, object] of [
    ['foreign-build-source', 'source/source.tgz'],
    ['hkbuddy-v1-582852715831-build-source', 'other/source.tgz'],
  ]) {
    const drift = structuredClone(receipt);
    const oldUri = Object.keys(drift.sourceProvenance.fileHashes)[0];
    const newUri = `gs://${bucket}/${object}#123`;
    drift.source.storageSource = { bucket, object, generation: '123' };
    drift.sourceProvenance.resolvedStorageSource = { bucket, object, generation: '123' };
    drift.sourceProvenance.fileHashes[newUri] = drift.sourceProvenance.fileHashes[oldUri];
    delete drift.sourceProvenance.fileHashes[oldUri];
    assert.throws(() => validateBuildReceipt(drift, {
      releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
      buildConfigSha256: BUILD_CONFIG_SHA,
    }), /Cloud Build receipt/i);
  }
});

test('rollback identity accepts only controller-generated revision grammar and paired image digest', () => {
  for (const input of [
    releaseInput({ previousRevision: 'hkbuddy-v1-api-stable123456' }),
    releaseInput({ previousRevision: 'hkbuddy-v1-api-ABCDEF123456' }),
    releaseInput({ previousRevision: 'hkbuddy-v1-api-12345678901' }),
    releaseInput({ previousImageDigest: null }),
  ]) assert.throws(() => buildReleasePlan(input), /release contract/i);
  assert.doesNotThrow(() => buildReleasePlan(releaseInput({
    previousRevision: null, previousImageDigest: null,
  }), { phase: 'candidate' }));
});

function validWorkloadAcceptanceRecord() {
  const queryDigests = Array.from({ length: 20 }, (_, index) => (
    createHash('sha256').update(`query-${index}`).digest('hex')
  )).sort();
  const uuid = (group, ordinal) => (
    `00000000-0000-4000-8${group.toString(16).padStart(3, '0')}-${String(ordinal).padStart(12, '0')}`
  );
  const textTurns = Array.from({ length: 200 }, (_, index) => {
    const sessionIndex = Math.floor(index / 10);
    const turnIndex = index % 10;
    const promptClass = turnIndex < 4 ? 'grounded' : (turnIndex < 7 ? 'abstention' : 'casual');
    const correlationId = uuid(1, index + 1);
    return {
      sequence: index + 1,
      sessionIndex,
      turnIndex,
      sessionIdSha256: createHash('sha256').update(`session-${sessionIndex}`).digest('hex'),
      clientMessageId: uuid(2, index + 1),
      correlationId,
      traceId: createHash('sha256').update(`trace-${index + 1}`).digest('hex').slice(0, 32),
      controlledTtsFailure: turnIndex === 1 && sessionIndex === 10,
      promptClass,
      replyLanguage: ['en', 'yue-Hant-HK', 'cmn-Hans-CN'][index % 3],
      replyMode: turnIndex === 0 || (turnIndex === 1 && sessionIndex < 11) ? 'voice' : 'text',
      acknowledged: true,
      ackMs: 200,
      processingVisible: true,
      processingVisibleMs: 400,
      delivered: true,
      finalAnswerMs: 2_400,
      messageLost: false,
      duplicateAssistantReplyCount: 0,
      unsupportedVerifiedClaimCount: 0,
      assistantMessageId: `assistant-${sessionIndex}-${turnIndex}`,
      requestStatus: 202,
      requestId: uuid(3, index + 1),
      responseStatus: 200,
      responseRequestId: uuid(4, index + 1),
      groundingSatisfied: true,
      groundingVerified: promptClass === 'grounded',
      groundingEvidenceSha256: createHash('sha256').update(`grounding-${index + 1}`).digest('hex'),
    };
  });
  const asrRequests = Array.from({ length: 30 }, (_, index) => {
    const durationBucketSeconds = [10, 30, 55][Math.floor(index / 10)];
    const language = ['cantonese', 'english', 'mandarin'][index % 3];
    const bindingId = uuid(5, index + 1);
    return {
      sequence: index + 1,
      sessionIndex: index % 20,
      sampleIndex: index,
      fixtureId: `${language}-${durationBucketSeconds}-${index + 1}`,
      fixtureSha256: createHash('sha256').update(`fixture-${index + 1}`).digest('hex'),
      language,
      wireLanguage: { cantonese: 'yue-Hant-HK', english: 'en', mandarin: 'cmn-Hans-CN' }[language],
      clientUploadId: bindingId,
      ready: true,
      correlationId: uuid(6, index + 1),
      bindingId,
      durationMs: durationBucketSeconds * 1_000,
      durationBucketSeconds,
      requestStatus: 202,
      requestId: uuid(7, index + 1),
      responseStatus: 200,
      responseRequestId: uuid(8, index + 1),
    };
  });
  const voiceSources = [
    ...Array.from({ length: 20 }, (_, sessionIndex) => textTurns[sessionIndex * 10]),
    ...Array.from({ length: 11 }, (_, sessionIndex) => textTurns[sessionIndex * 10 + 1]),
  ];
  const ttsRequests = voiceSources.map((source, index) => {
    const failure = index === 30;
    return {
      sequence: index + 1,
      requestIndex: index,
      sessionIndex: source.sessionIndex,
      sourceTurnIndex: source.turnIndex,
      ready: !failure,
      correlationId: source.correlationId,
      bindingId: source.assistantMessageId,
      durationMs: null,
      expectedProviderFailure: failure,
      providerFailureObserved: failure,
      failureCode: failure ? 'VOICE_SYNTHESIS_REJECTED' : null,
      textAvailable: true,
      mediaValidated: !failure,
      messageIdMatches: true,
      requestStatus: 200,
      requestId: uuid(9, index + 1),
      responseStatus: 200,
      responseRequestId: uuid(10, index + 1),
    };
  });
  const samplesBySession = Array.from({ length: 20 }, () => []);
  for (const item of textTurns) {
    samplesBySession[item.sessionIndex].push({
      correlationId: item.correlationId, bindingId: item.assistantMessageId, durationMs: null,
      operation: 'text', layer: 'server', latencyMs: 2_300, outcome: 'success', failureCode: null,
    });
    if (item.promptClass === 'grounded') samplesBySession[item.sessionIndex].push({
      correlationId: item.correlationId, bindingId: item.assistantMessageId, durationMs: null,
      operation: 'text', layer: 'provider', latencyMs: 1_800, outcome: 'success', failureCode: null,
    });
  }
  for (const item of asrRequests) {
    for (const [layer, latencyMs] of [['provider', 1_800], ['server', item.durationBucketSeconds === 10 ? 2_000 : 5_000]]) {
      samplesBySession[item.sessionIndex].push({
        correlationId: item.correlationId, bindingId: item.bindingId, durationMs: item.durationMs,
        operation: 'asr', layer, latencyMs, outcome: 'success', failureCode: null,
      });
    }
  }
  for (const item of ttsRequests) {
    for (const [layer, latencyMs] of [['provider', 1_700], ['server', 1_900]]) {
      samplesBySession[item.sessionIndex].push({
        correlationId: item.correlationId, bindingId: item.bindingId, durationMs: null,
        operation: 'tts', layer, latencyMs,
        outcome: item.expectedProviderFailure ? 'failure' : 'success',
        failureCode: item.expectedProviderFailure ? 'VOICE_SYNTHESIS_REJECTED' : null,
      });
    }
  }
  const timingQueries = Array.from({ length: 20 }, (_, index) => ({
    sequence: index + 1, sessionIndex: index, queryDigest: queryDigests[index], samples: samplesBySession[index],
  }));
  const controlPlaneRequests = textTurns.map((item, index) => ({
    sequence: index + 1,
    insertId: `request-${String(index + 1).padStart(3, '0')}`,
    latencyMs: 200,
    status: 202,
    timestamp: new Date(Date.parse('2026-08-26T08:00:00.000Z') + index).toISOString(),
    trace: `projects/${PROJECT}/traces/${item.traceId}`,
  }));
  const rawPayload = {
    schemaVersion: 2,
    acceptanceWindowId: createHash('sha256').update('acceptance-window').digest('hex'),
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: 'candidate-service-private-100',
    stableTrafficState: 'stable-prior-100',
    textTurns,
    asrRequests,
    ttsRequests,
    timingQueries,
    controlPlaneRequests,
  };
  const rawReceipts = {
    ...rawPayload,
    receiptsSha256: createHash('sha256').update(JSON.stringify(canonicalFixture(rawPayload))).digest('hex'),
  };
  return finalizeLatencyAcceptanceRecord({
    schemaVersion: 5,
    commitSha: RELEASE_SHA,
    candidateOrigin: CANDIDATE_ORIGIN,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: 'candidate-service-private-100',
    stableTrafficState: 'stable-prior-100',
    access: {
      authenticated: true,
      audience: CANDIDATE_ROOT,
      issuer: 'https://accounts.google.com',
      subjectSha256: QA_SUBJECT_SHA256,
      taggedUrl: CANDIDATE_ORIGIN,
    },
    releaseBinding: {
      project: PROJECT,
      region: REGION,
      candidateService: CANDIDATE_SERVICE,
      stableService: STABLE_SERVICE,
      releaseSha: RELEASE_SHA,
      sourceArchiveSha256: SOURCE_SHA,
      imageDigest: IMAGE_DIGEST,
      candidateRevision: REVISION,
      candidateTag: CANDIDATE_TAG,
      serviceOrigin: STABLE_ORIGIN,
      candidateOrigin: CANDIDATE_ORIGIN,
      candidateAudience: CANDIDATE_ROOT,
      trafficPercent: 100,
      trafficState: 'candidate-service-private-100',
      stableTrafficState: 'stable-prior-100',
    },
    fixtureSetSha256: 'd'.repeat(64),
    workload: LATENCY_ACCEPTANCE_CONTRACT,
    counts: {
      sessionsCreated: 20,
      textTurnsAttempted: 200,
      textTurnsAcknowledged: 200,
      textTurnsDelivered: 200,
      asrRequestsAttempted: 30,
      asrReady: 30,
      ttsRequestsAttempted: 31,
      ttsReady: 30,
      ttsControlledProviderFailures: 1,
    },
    metrics: {
      sendAck: { sampleCount: 200, p95Ms: 200, p95ThresholdMs: 300, pass: true },
      processingVisible: { sampleCount: 200, p95Ms: 400, p95ThresholdMs: 500, pass: true },
      groundedResponse: {
        sampleCount: 80, p50Ms: 2_400, p50ThresholdMs: 2_500,
        p95Ms: 2_400, p95ThresholdMs: 6_000, pass: true,
      },
      asr10: {
        sampleCount: 10, p50Ms: 2_000, p50ThresholdMs: 2_500,
        p95Ms: 2_000, p95ThresholdMs: 4_000, pass: true,
      },
      asr30: { sampleCount: 10, p95Ms: 5_000, p95ThresholdMs: 6_000, pass: true },
      asr55: { sampleCount: 10, p95Ms: 5_000, p95ThresholdMs: 6_000, pass: true },
      ttsReady: {
        sampleCount: 30, p50Ms: 1_900, p50ThresholdMs: 2_500,
        p95Ms: 1_900, p95ThresholdMs: 5_000, pass: true,
      },
    },
    invariants: {
      acknowledgedMessageLossCount: 0,
      duplicateAssistantReplyCount: 0,
      unsupportedVerifiedClaimCount: 0,
      ttsFailureTextLossCount: 0,
      ttsMediaValidationFailureCount: 0,
      ttsMessageBindingMismatchCount: 0,
      controlledTtsProviderFailureMismatchCount: 0,
    },
    observations: {
      releaseCommitSha: RELEASE_SHA,
      queryDigests: { sampleCount: 20, values: queryDigests, pass: true },
      provider: {
        text: { available: true, sampleCount: 80, p50Ms: 1_800, p95Ms: 1_800 },
        asr: { available: true, sampleCount: 30, p50Ms: 1_800, p95Ms: 1_800 },
        tts: { available: true, sampleCount: 30, p50Ms: 1_700, p95Ms: 1_700 },
      },
      server: {
        text: { available: true, sampleCount: 200, p50Ms: 2_300, p95Ms: 2_300 },
        asr: { available: true, sampleCount: 30, p50Ms: 5_000, p95Ms: 5_000 },
        tts: { available: true, sampleCount: 30, p50Ms: 1_900, p95Ms: 1_900 },
      },
      pairs: {
        text: {
          available: true, expectedServerCount: 200, serverBoundCount: 200,
          expectedProviderCount: 80, providerPairedCount: 80,
        },
        asr: { available: true, expectedCount: 30, pairedCount: 30 },
        tts: {
          available: true, expectedSuccessCount: 30, successPairedCount: 30,
          expectedFailureCount: 1, failurePairedCount: 1,
        },
      },
    },
    rawReceipts,
    occurredAt: '2026-08-26T08:00:00.000Z',
    result: true,
  });
}

function controlPlaneLogEntries(record) {
  return record.rawReceipts.controlPlaneRequests.map((entry) => ({
    insertId: entry.insertId,
    timestamp: entry.timestamp,
    trace: entry.trace,
    resource: {
      type: 'cloud_run_revision',
      labels: {
        project_id: PROJECT, location: REGION, service_name: CANDIDATE_SERVICE,
        revision_name: REVISION,
      },
    },
    httpRequest: {
      requestMethod: 'POST', requestUrl: `${CANDIDATE_ORIGIN}/api/v1/messages`,
      status: 202, latency: `${entry.latencyMs / 1_000}s`,
      userAgent: `hkbuddy-v1-acceptance/${record.rawReceipts.acceptanceWindowId}`,
    },
  }));
}

async function exerciseControlledWorkloadNetwork(fetchImpl, record, {
  messageReadCount = 231,
} = {}) {
  const invoke = (path, method = 'GET', headers = {}) => fetchImpl(
    new URL(path, CANDIDATE_ORIGIN), { method, headers: {
      ...headers,
      Authorization: `Bearer ${'a'.repeat(80)}`,
      'User-Agent': `hkbuddy-v1-acceptance/${record.rawReceipts.acceptanceWindowId}`,
    } },
  );
  for (let index = 0; index < 21; index += 1) await invoke('/api/v1/session', 'POST');
  for (let index = 0; index < 200; index += 1) {
    await invoke('/api/v1/messages', 'POST', {
      'X-Acceptance-Correlation-Id': record.rawReceipts.textTurns[index].correlationId,
    });
  }
  for (let index = 0; index < messageReadCount; index += 1) {
    await invoke('/api/v1/messages?after=0');
  }
  for (let index = 0; index < 30; index += 1) {
    await invoke('/api/v1/voice/transcriptions', 'POST', {
      'X-Client-Upload-Id': record.rawReceipts.asrRequests[index].bindingId,
    });
  }
  for (let index = 0; index < 20; index += 1) {
    await invoke(`/api/v1/acceptance/timings?windowId=${record.rawReceipts.acceptanceWindowId}`);
  }
  for (const item of record.rawReceipts.ttsRequests) {
    await invoke(`/api/v1/messages/${item.bindingId}/audio/status`);
  }
  for (let index = 0; index < 30; index += 1) {
    const path = `/api/v1/media/media-${String(index).padStart(2, '0')}`;
    await invoke(path, 'HEAD');
    await invoke(path, 'GET', { Range: 'bytes=0-3' });
    await invoke(path);
  }
}

function realV1JobReadback(expected) {
  const environment = Object.entries(expected.environment).map(([name, value]) => ({ name, value }));
  const secretEnvironment = Object.entries(expected.secretEnvironment).map(([name, value]) => ({
    name,
    valueFrom: { secretKeyRef: { name: value.secret, key: value.version } },
  }));
  const secretMounts = Object.entries(expected.secretMounts);
  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Job',
    metadata: {
      name: expected.job,
      labels: structuredClone(expected.labels),
      uid: '123e4567-e89b-42d3-a456-426614174000',
      generation: 1,
    },
    spec: {
      template: {
        metadata: {
          annotations: {
            'run.googleapis.com/network-interfaces': JSON.stringify([{
              network: expected.network, subnetwork: expected.subnet,
            }]),
            'run.googleapis.com/vpc-access-egress': expected.vpcEgress,
          },
        },
        spec: {
          taskCount: expected.taskCount,
          parallelism: expected.parallelism,
          template: {
            spec: {
              serviceAccountName: expected.serviceAccount,
              maxRetries: expected.maxRetries,
              timeoutSeconds: `${expected.timeoutSeconds}s`,
              containers: [{
                image: expected.image,
                command: structuredClone(expected.command),
                args: structuredClone(expected.args),
                env: [...environment, ...secretEnvironment],
                volumeMounts: secretMounts.map(([name, mount]) => ({
                  name,
                  mountPath: mount.path.slice(0, mount.path.lastIndexOf('/')),
                  readOnly: true,
                })),
              }],
              volumes: secretMounts.map(([name, mount]) => ({
                name,
                secret: {
                  secretName: mount.secret,
                  items: [{
                    key: mount.version,
                    path: mount.path.slice(mount.path.lastIndexOf('/') + 1),
                  }],
                },
              })),
            },
          },
        },
      },
    },
    status: {
      observedGeneration: 1,
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  };
}

function canonicalFixtureSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonicalFixture(value))).digest('hex');
}

function realV1ExecutionReadback(expected, name = `${expected.job}-release-001`) {
  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Execution',
    metadata: { name, labels: { 'run.googleapis.com/job': expected.job } },
    spec: { taskCount: expected.taskCount, parallelism: expected.parallelism },
    status: {
      conditions: [{ type: 'Completed', status: 'True' }],
      completionTime: '2026-08-26T08:00:00.000Z',
      succeededCount: expected.taskCount,
    },
  };
}

function fixtureReceiptOutputs(plan, phase) {
  if (phase === 'build') return {
    buildConfigSha256: plan.buildConfigSha256,
    buildId: '12345678-1234-4234-8234-123456789abc',
    buildReceiptSha256: 'f'.repeat(64),
    imageDigest: plan.imageDigest,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    sourceProvenance: {
      uri: 'gs://hkbuddy-v1-582852715831-build-source/source/source.tgz#123',
      sha256: plan.sourceArchiveSha256,
    },
    ociLabels: {
      'com.simplify.build-config-sha256': plan.buildConfigSha256,
      'com.simplify.source-archive-sha256': plan.sourceArchiveSha256,
      'org.opencontainers.image.revision': plan.releaseSha,
      'org.opencontainers.image.source': 'https://github.com/jimmy00415/Cantonese_Learning_Full_stack',
    },
  };
  if (phase === 'migration') return {
    executionName: 'hkbuddy-v1-migrate-release-001',
    job: 'hkbuddy-v1-migrate', imageDigest: plan.imageDigest,
  };
  if (phase === 'inventory') return {
    evidenceSecretVersions: { legacyInventory: plan.evidence.legacyInventory.secretVersion },
  };
  if (phase === 'acceptance') return {
    jobs: Object.fromEntries(Object.entries(plan.expectedJobs).map(([key, value]) => [
      key, { image: value.image, serviceAccount: value.serviceAccount },
    ])),
    executions: Object.fromEntries(Object.entries(plan.expectedJobs).map(([key, value]) => [
      key, {
        name: `${value.job}-release-001`,
        job: value.job,
        taskCount: value.taskCount,
        parallelism: value.parallelism,
        succeededCount: value.taskCount,
        completionTime: '2026-08-26T08:00:00.000Z',
      },
    ])),
  };
  if (phase === 'collect') return {
    evidence: Object.fromEntries(['dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke'].map((key) => [
      key, {
        artifactSha256: plan.evidence[key].artifactSha256,
        objectSha256: plan.evidence[key].objectSha256,
      },
    ])),
  };
  if (phase === 'evidence') return {
    evidenceSecretVersions: Object.fromEntries(Object.entries(plan.evidence).map(([key, value]) => [
      key, value.secretVersion,
    ])),
    outputResidueCount: 0,
  };
  if (phase === 'candidate') return {
    privacyProofReferenceSha256: createHash('sha256')
      .update(JSON.stringify(canonicalFixture(candidatePrivacyReference(plan)))).digest('hex'),
    access: structuredClone(plan.candidateAccess),
    candidateContractSha256: createHash('sha256')
      .update(JSON.stringify(canonicalFixture(plan.expectedCandidate))).digest('hex'),
    candidateService: CANDIDATE_SERVICE,
    imageDigest: plan.imageDigest,
    origin: plan.candidateOrigin,
    privacyProof: candidatePrivacyReference(plan),
    publicInvoker: false,
    priorRelease: plan.previousRevision === null ? null : {
      image: plan.previousImage,
      imageDigest: plan.previousImageDigest,
      revision: plan.previousRevision,
    },
    revision: plan.candidateRevision,
    stableService: STABLE_SERVICE,
    stableTrafficState: plan.expectedStable.initialTrafficState,
    tag: plan.candidateTag,
    trafficPercent: 100,
    trafficState: 'candidate-service-private-100',
  };
  const output = {
    artifactSha256: plan.task8Evidence[phase].artifactSha256,
    objectSha256: plan.task8Evidence[phase].objectSha256,
    candidateOrigin: plan.candidateOrigin,
    candidateRevision: plan.candidateRevision,
    candidateService: CANDIDATE_SERVICE,
    imageDigest: plan.imageDigest,
    privacyProofs: structuredClone(plan.task8Evidence[phase].privacyProofs),
    stableService: STABLE_SERVICE,
    stableTrafficState: plan.expectedStable.initialTrafficState,
    trafficState: 'candidate-service-private-100',
  };
  if (phase === 'workload') {
    output.execution = {
      acceptanceWindowId: createHash('sha256').update('acceptance-window').digest('hex'),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      gateStartedAt: '2026-08-26T08:00:00.000Z',
      gateEndedAt: '2026-08-26T08:09:00.000Z',
      networkWitnessSha256: createHash('sha256').update('network-witness').digest('hex'),
      observedRequestCount: 592,
    };
  }
  if (phase === 'mobile') {
    output.access = structuredClone(plan.candidateAccess);
    output.viewport = { width: 390, height: 844 };
  }
  return output;
}

function fixtureReceiptChain(plan, through) {
  const phases = ['build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence',
    'candidate', 'readiness', 'workload', 'mobile'];
  const receipts = [];
  for (const [index, phase] of phases.entries()) {
    const receipt = finalizeReleasePhaseReceipt({
      schemaVersion: 2,
      phase,
      sequence: index + 1,
      releaseSha: plan.releaseSha,
      releaseIdentitySha256: plan.releaseIdentitySha256,
      phaseIdentitySha256: releasePhaseIdentitySha256(plan, phase),
      candidateService: CANDIDATE_SERVICE,
      stableService: STABLE_SERVICE,
      trafficState: 'candidate-service-private-100',
      stableTrafficState: plan.expectedStable.initialTrafficState,
      previousReceiptSha256: receipts.at(-1)?.receiptSha256 ?? null,
      completed: plan.operations.filter((member) => member.phase === phase).map(({ id }) => id),
      outputs: fixtureReceiptOutputs(plan, phase),
    });
    receipts.push(receipt);
    if (phase === 'candidate') {
      Object.defineProperty(receipts, 'candidatePrivacyAnchor', {
        value: {
          privacyProof: candidatePrivacyReference(plan),
          candidateReceiptSha256: receipt.receiptSha256,
        },
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    if (phase === through) return receipts;
  }
  throw new Error('unknown fixture receipt phase');
}

test('candidate receipt binds the complete exact privacy-proof reference', async (t) => {
  const plan = buildReleasePlan(releaseInput());
  const valid = fixtureReceiptChain(plan, 'mobile');
  const candidateIndex = valid.findIndex(({ phase }) => phase === 'candidate');
  const anchor = {
    privacyProof: candidatePrivacyReference(plan),
    candidateReceiptSha256: valid[candidateIndex].receiptSha256,
  };
  assert.equal(validateReleaseReceiptChain(valid, plan, {
    through: 'mobile', candidatePrivacyAnchor: anchor,
  }), true);
  const mutations = [
    ['missing artifact digest', (value) => { delete value.artifactSha256; }],
    ['artifact digest drift', (value) => { value.artifactSha256 = 'a'.repeat(64); }],
    ['object digest drift', (value) => { value.objectSha256 = 'b'.repeat(64); }],
    ['schema drift', (value) => { value.schemaVersion = 3; }],
    ['file path drift', (value) => { value.filePath = `${value.filePath}.other`; }],
    ['boundary drift', (value) => { value.boundarySha256 = 'c'.repeat(64); }],
    ['observed clock drift', (value) => { value.observedAt = '2026-08-26T08:00:01.000Z'; }],
    ['expiry clock drift', (value) => { value.expiresAt = '2026-08-26T08:05:01.000Z'; }],
    ['extra field', (value) => { value.extra = true; }],
    ['wrong field type', (value) => { value.objectSha256 = 2; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const receipts = structuredClone(valid);
      const candidate = receipts[candidateIndex];
      mutate(candidate.outputs.privacyProof);
      candidate.outputs.privacyProofReferenceSha256 = createHash('sha256')
        .update(JSON.stringify(canonicalFixture(candidate.outputs.privacyProof))).digest('hex');
      for (let index = candidateIndex; index < receipts.length; index += 1) {
        if (index > candidateIndex) receipts[index].previousReceiptSha256 = receipts[index - 1].receiptSha256;
        receipts[index] = finalizeReleasePhaseReceipt(receipts[index]);
      }
      assert.throws(
        () => validateReleaseReceiptChain(receipts, plan, {
          through: 'mobile', candidatePrivacyAnchor: anchor,
        }),
        /receipt (?:authority|chain|outputs)/i,
      );
    });
  }
  const missingAnchor = structuredClone(valid);
  delete missingAnchor.candidatePrivacyAnchor;
  assert.throws(
    () => validateReleaseReceiptChain(missingAnchor, plan, { through: 'mobile' }),
    /authority/i,
  );
  assert.throws(
    () => validateReleaseReceiptChain(valid, plan, {
      through: 'mobile',
      candidatePrivacyAnchor: { ...anchor, candidateReceiptSha256: 'f'.repeat(64) },
    }),
    /authority/i,
  );
});

function controlledReadinessExecution(plan) {
  const binding = {
    projectId: PROJECT,
    projectNumber: PROJECT_NUMBER,
    organizationId: GCP_IDENTITY.organizationId,
    region: REGION,
    releaseSha: plan.releaseSha,
    imageDigest: plan.imageDigest,
    image: plan.expectedCandidate.image,
    candidateService: plan.candidateService,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    acceptanceServiceAccount: ACCEPTANCE_SA,
    operator: 'admin@motionexp.com',
    expectedCandidate: plan.expectedCandidate,
  };
  const boundarySha256 = candidatePrivacyBoundarySha256(binding);
  const entry = plan.task8Evidence.readiness;
  const privacyArtifact = (boundary, digit, observedAt) => {
    const contents = `${JSON.stringify({
      schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
      proofType: 'controlled-test-privacy', artifactSha256: digit.repeat(64),
    }, null, 2)}\n`;
    return {
      contents,
      reference: {
        schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
        filePath: entry.privacyProofs[boundary].filePath,
        artifactSha256: digit.repeat(64),
        objectSha256: createHash('sha256').update(contents).digest('hex'),
        boundarySha256,
        observedAt,
        expiresAt: new Date(Date.parse(observedAt) + 5 * 60_000).toISOString(),
      },
    };
  };
  const privacyStart = privacyArtifact('start', '1', '2026-08-27T08:00:00.000Z');
  const privacyEnd = privacyArtifact('end', '2', '2026-08-27T08:01:00.000Z');
  const readiness = {
    status: 'ready', productionReady: true, boundary: 'production-v1',
    checks: [
      'configuration', 'release-evidence', 'llm-smoke', 'database', 'media',
      'corpus', 'retention', 'dispatcher', 'runtime',
    ].map((name) => ({ name, status: 'ready' })),
  };
  const record = finalizeTask8ReadinessRecord({
    schemaVersion: 3,
    gate: 'readiness',
    result: 'pass',
    occurredAt: privacyStart.reference.observedAt,
    expiresAt: privacyStart.reference.expiresAt,
    commitSha: plan.releaseSha,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    imageDigest: plan.imageDigest,
    candidateService: plan.candidateService,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    stableService: plan.stableService,
    trafficState: 'candidate-service-private-100',
    stableTrafficState: plan.expectedStable.initialTrafficState,
    trafficPercent: 100,
    privacyProofs: { start: privacyStart.reference, end: privacyEnd.reference },
    controlPlane: {
      stable: true, beforeSha256: '3'.repeat(64), afterSha256: '3'.repeat(64),
    },
    probes: {
      live: {
        status: 200, responseSha256: '4'.repeat(64), logSha256: '5'.repeat(64),
        traceSha256: '6'.repeat(64), userAgentSha256: '7'.repeat(64),
      },
      ready: {
        status: 200, responseSha256: '8'.repeat(64), logSha256: '9'.repeat(64),
        traceSha256: 'a'.repeat(64), userAgentSha256: 'b'.repeat(64),
      },
    },
    readiness,
  });
  const readinessContents = `${JSON.stringify(record, null, 2)}\n`;
  const evidence = {
    ...entry,
    artifactSha256: record.artifactSha256,
    objectSha256: createHash('sha256').update(readinessContents).digest('hex'),
    privacyProofs: structuredClone(record.privacyProofs),
  };
  return {
    record,
    evidence,
    artifacts: {
      privacyStart: { ...privacyStart, filePath: privacyStart.reference.filePath },
      privacyEnd: { ...privacyEnd, filePath: privacyEnd.reference.filePath },
      readiness: {
        filePath: evidence.filePath,
        contents: readinessContents,
        artifactSha256: evidence.artifactSha256,
        objectSha256: evidence.objectSha256,
      },
    },
  };
}

function controlledMobileExecution(plan) {
  const entry = plan.task8Evidence.mobile;
  const boundarySha256 = candidatePrivacyBoundarySha256({
    projectId: PROJECT,
    projectNumber: PROJECT_NUMBER,
    organizationId: GCP_IDENTITY.organizationId,
    region: REGION,
    releaseSha: plan.releaseSha,
    imageDigest: plan.imageDigest,
    image: plan.expectedCandidate.image,
    candidateService: plan.candidateService,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    acceptanceServiceAccount: ACCEPTANCE_SA,
    operator: 'admin@motionexp.com',
    expectedCandidate: plan.expectedCandidate,
  });
  const privacyArtifact = (boundary, digit, observedAt) => {
    const proof = {
      schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
      artifactSha256: digit.repeat(64),
    };
    const contents = `${JSON.stringify(proof, null, 2)}\n`;
    return {
      filePath: entry.privacyProofs[boundary].filePath,
      contents,
      reference: {
        schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
        filePath: entry.privacyProofs[boundary].filePath,
        artifactSha256: proof.artifactSha256,
        objectSha256: createHash('sha256').update(contents).digest('hex'),
        boundarySha256,
        observedAt,
        expiresAt: new Date(Date.parse(observedAt) + 5 * 60_000).toISOString(),
      },
    };
  };
  const privacyStart = privacyArtifact('start', '1', '2026-08-27T08:00:00.000Z');
  const privacyEnd = privacyArtifact('end', '2', '2026-08-27T08:01:00.000Z');
  const screenshots = ['first-visit', 'text-source', 'voice-transcript', 'mobile-safe-area']
    .map((id, index) => {
      const contents = Buffer.alloc(128, index + 1);
      return {
        id,
        filePath: join(dirname(entry.filePath), `mobile-${id}.png`),
        contents,
        metadata: {
          width: 390,
          height: 844,
          rawSha256: createHash('sha256').update(contents).digest('hex'),
          pixelSha256: ['8', '9', 'a', 'b'][index].repeat(64),
          colorCount: 128,
          luminanceSpan: 96,
          luminanceVariance: 512,
          dominantRatio: 0.2,
          nonDominantRatio: 0.8,
          byteLength: contents.length,
        },
      };
    });
  const record = finalizeTask8MobileRecord({
    schemaVersion: 3,
    gate: 'mobile',
    result: 'pass',
    occurredAt: privacyStart.reference.observedAt,
    expiresAt: privacyStart.reference.expiresAt,
    commitSha: plan.releaseSha,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    imageDigest: plan.imageDigest,
    candidateService: plan.candidateService,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    stableService: plan.stableService,
    trafficState: 'candidate-service-private-100',
    stableTrafficState: plan.expectedStable.initialTrafficState,
    trafficPercent: 100,
    privacyProofs: { start: privacyStart.reference, end: privacyEnd.reference },
    controlPlane: { stable: true, beforeSha256: '3'.repeat(64), afterSha256: '3'.repeat(64) },
    browser: MOBILE_BROWSER_CONTRACT,
    fixture: MOBILE_WAV_CONTRACT,
    voiceWitness: {
      baseFixtureSha256: MOBILE_WAV_CONTRACT.sha256,
      challengeCommitmentSha256: '5'.repeat(64),
      uploadSha256: '6'.repeat(64),
      durationMs: 1080,
      durationDeltaMs: 80,
      comparedSamples: 15_665,
      baseCorrelation: 0.993541,
      watermarkCorrelation: 0.544045,
      commandLineVerified: true,
      playbackObserved: true,
      witnessed: true,
    },
    viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    access: structuredClone(plan.candidateAccess),
    finalNavigationUrl: plan.candidateOrigin,
    checks: MOBILE_CHECK_IDS.map((id) => ({ id, derived: true })),
    screenshots: screenshots.map(({ id, filePath, metadata }) => ({ id, filePath, ...metadata })),
    network: { eventCount: 2, traceSha256: '4'.repeat(64) },
  });
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const evidence = {
    ...entry,
    artifactSha256: record.artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
    privacyProofs: structuredClone(record.privacyProofs),
  };
  return {
    record,
    evidence,
    artifacts: {
      privacyStart,
      screenshots,
      privacyEnd,
      mobile: {
        filePath: evidence.filePath,
        contents,
        artifactSha256: evidence.artifactSha256,
        objectSha256: evidence.objectSha256,
      },
    },
  };
}

function controlledWorkloadPrivacyArtifact(plan, locator, boundary) {
  const digit = boundary === 'start' ? 'c' : 'd';
  const observedAt = boundary === 'start'
    ? '2026-08-26T08:04:00.000Z' : '2026-08-26T08:06:00.000Z';
  const expiresAt = new Date(Date.parse(observedAt) + 5 * 60_000).toISOString();
  const boundarySha256 = candidatePrivacyBoundarySha256({
    projectId: PROJECT,
    projectNumber: PROJECT_NUMBER,
    organizationId: GCP_IDENTITY.organizationId,
    region: REGION,
    releaseSha: plan.releaseSha,
    imageDigest: plan.imageDigest,
    image: plan.expectedCandidate.image,
    candidateService: plan.candidateService,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    acceptanceServiceAccount: ACCEPTANCE_SA,
    operator: 'admin@motionexp.com',
    expectedCandidate: plan.expectedCandidate,
  });
  const record = {
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    proofType: 'controlled-test-privacy',
    artifactSha256: digit.repeat(64),
    binding: { boundarySha256 },
    occurredAt: observedAt,
    expiresAt,
  };
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  return {
    filePath: locator.filePath,
    contents,
    reference: {
      schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
      filePath: locator.filePath,
      artifactSha256: record.artifactSha256,
      objectSha256: createHash('sha256').update(contents).digest('hex'),
      boundarySha256,
      observedAt,
      expiresAt,
    },
  };
}

function controlledReleasePrivacyArtifact(plan, locator) {
  const rawBinding = {
    projectId: PROJECT,
    projectNumber: PROJECT_NUMBER,
    organizationId: GCP_IDENTITY.organizationId,
    region: REGION,
    releaseSha: plan.releaseSha,
    imageDigest: plan.imageDigest,
    image: plan.expectedCandidate.image,
    candidateService: plan.candidateService,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    acceptanceServiceAccount: ACCEPTANCE_SA,
    operator: 'admin@motionexp.com',
    expectedCandidate: plan.expectedCandidate,
  };
  const candidateResource = `//run.googleapis.com/projects/${PROJECT}/locations/${REGION}/services/${CANDIDATE_SERVICE}`;
  const proofBindingPayload = {
    projectId: PROJECT,
    projectNumber: PROJECT_NUMBER,
    organizationId: GCP_IDENTITY.organizationId,
    region: REGION,
    releaseSha: plan.releaseSha,
    imageDigest: plan.imageDigest,
    image: plan.expectedCandidate.image,
    candidateContractSha256: canonicalFixtureSha256(plan.expectedCandidate),
    candidateService: plan.candidateService,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    candidateResource,
  };
  const proofBinding = {
    ...proofBindingPayload,
    boundarySha256: canonicalFixtureSha256(proofBindingPayload),
  };
  assert.equal(proofBinding.boundarySha256, candidatePrivacyBoundarySha256(rawBinding));
  const hierarchyChain = [
    candidateResource,
    `projects/${PROJECT_NUMBER}`,
    `organizations/${GCP_IDENTITY.organizationId}`,
  ];
  const effectivePolicyProjection = {
    policyResults: [{
      fullResourceName: candidateResource,
      policies: [{
        attachedResource: candidateResource,
        policy: {
          bindings: [{
            role: 'roles/run.servicesInvoker',
            members: [`serviceAccount:${ACCEPTANCE_SA}`],
          }],
          auditConfigs: [],
        },
      }],
    }],
  };
  const roleDefinitions = [];
  const denialPayload = {
    method: 'effective-policy-role-definition-exclusion-v1',
    permission: 'run.routes.invoke',
    hierarchyChain,
    effectivePolicyProjection,
    sources: {
      effectiveIamSha256: canonicalFixtureSha256(effectivePolicyProjection),
      hierarchyChainSha256: canonicalFixtureSha256(hierarchyChain),
      roleDefinitionsSha256: canonicalFixtureSha256(roleDefinitions),
    },
    roleDefinitions,
    principals: {
      allAuthenticatedUsers: { decision: 'DENIED', bindingCount: 0, bindings: [] },
      allUsers: { decision: 'DENIED', bindingCount: 0, bindings: [] },
    },
  };
  const proof = finalizeCandidatePrivacyProof({
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    proofType: 'candidate-effective-privacy',
    binding: proofBinding,
    occurredAt: '2026-08-27T08:00:00.000Z',
    expiresAt: '2026-08-27T08:05:00.000Z',
    result: 'pass',
    controlPlane: {
      stable: true,
      beforeSha256: canonicalFixtureSha256({ state: 'candidate-private' }),
      afterSha256: canonicalFixtureSha256({ state: 'candidate-private' }),
    },
    identity: {
      acceptanceServiceAccount: ACCEPTANCE_SA,
      invokerMember: `serviceAccount:${ACCEPTANCE_SA}`,
      invokerPermission: 'run.routes.invoke',
      invokerRole: 'roles/run.servicesInvoker',
      subjectSha256: canonicalFixtureSha256('acceptance-subject'),
      tokenCreatorPrincipal: 'user:admin@motionexp.com',
      tokenCreatorPrerequisite: 'roles/iam.serviceAccountOpenIdTokenCreator',
      tokenPrerequisitePolicySha256: canonicalFixtureSha256({ prerequisite: 'present' }),
    },
    hierarchy: {
      stable: true,
      chainSha256: denialPayload.sources.hierarchyChainSha256,
      firstReadSha256: canonicalFixtureSha256({ snapshot: 'stable' }),
      secondReadSha256: canonicalFixtureSha256({ snapshot: 'stable' }),
      policyRoleDefinitionsSha256: denialPayload.sources.roleDefinitionsSha256,
      policyRoleDefinitionsSecondReadSha256: denialPayload.sources.roleDefinitionsSha256,
    },
    cloudAsset: {
      quotaProject: GCP_IDENTITY.assetInventoryConsumerProjectId,
      effectiveIamSha256: denialPayload.sources.effectiveIamSha256,
      publicPrincipalDenial: {
        ...denialPayload,
        attestationSha256: canonicalFixtureSha256(denialPayload),
      },
    },
    troubleshooter: {
      decision: 'GRANTED',
      responseSha256: canonicalFixtureSha256({ access: 'GRANTED' }),
    },
    edge: {
      anonymous: {
        status: 403,
        logSha256: canonicalFixtureSha256('anonymous-log'),
        traceSha256: canonicalFixtureSha256('anonymous-trace'),
        userAgentSha256: canonicalFixtureSha256('anonymous-user-agent'),
      },
      authenticated: {
        status: 200,
        logSha256: canonicalFixtureSha256('authenticated-log'),
        traceSha256: canonicalFixtureSha256('authenticated-trace'),
        userAgentSha256: canonicalFixtureSha256('authenticated-user-agent'),
      },
    },
  });
  const contents = `${JSON.stringify(proof, null, 2)}\n`;
  return {
    filePath: locator.filePath,
    contents,
    reference: {
      schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
      filePath: locator.filePath,
      artifactSha256: proof.artifactSha256,
      objectSha256: createHash('sha256').update(contents).digest('hex'),
      boundarySha256: proof.binding.boundarySha256,
      observedAt: proof.occurredAt,
      expiresAt: proof.expiresAt,
    },
  };
}

function candidatePrivacyJournalFixture(plan, mutateProof = () => undefined) {
  const locator = { filePath: plan.candidatePrivacyProofPath };
  const source = controlledReleasePrivacyArtifact(plan, locator);
  const proof = JSON.parse(source.contents);
  mutateProof(proof);
  const contents = `${JSON.stringify(proof, null, 2)}\n`;
  const bytes = Buffer.from(contents);
  const intentRecordSha256 = '4'.repeat(64);
  const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const receipt = fixtureReceiptChain(plan, 'candidate').at(-1);
  return {
    receipt,
    records: [
      {
        phase: 'candidate',
        attemptId,
        recordType: 'intent',
        operationId: 'candidate-privacy-publish',
        recordSha256: intentRecordSha256,
        payload: {
          publication: {
            artifacts: [{
              role: 'privacy-proof',
              filePath: locator.filePath,
              byteLength: bytes.length,
              objectSha256: createHash('sha256').update(bytes).digest('hex'),
              contentsBase64: bytes.toString('base64'),
            }],
          },
        },
      },
      {
        phase: 'candidate',
        attemptId,
        recordType: 'checkpoint',
        operationId: 'candidate-privacy-publish',
        payload: { intentRecordSha256 },
      },
      {
        phase: 'candidate',
        attemptId,
        recordType: 'terminal',
        operationId: null,
        payload: { receiptSha256: receipt.receiptSha256 },
      },
    ],
  };
}

test('candidate journal authority validates the complete historical schema-v4 privacy proof', () => {
  const plan = buildReleasePlan(releaseInput(), { phase: 'candidate-cleanup' });
  const valid = candidatePrivacyJournalFixture(plan);
  const authority = candidatePrivacyAuthorityFromJournal(valid.records, valid.receipt, plan);
  assert.equal(authority.candidateReceiptSha256, valid.receipt.receiptSha256);
  assert.equal(authority.privacyProof.expiresAt, '2026-08-27T08:05:00.000Z');

  const forged = candidatePrivacyJournalFixture(plan, (proof) => {
    proof.troubleshooter.decision = 'DENIED';
    proof.artifactSha256 = finalizeCandidatePrivacyProof(proof).artifactSha256;
  });
  assert.throws(
    () => candidatePrivacyAuthorityFromJournal(forged.records, forged.receipt, plan),
    /privacy receipt authority/i,
  );
});

async function verifyControlledReleasePrivacyArtifact(reference, _plan, clock) {
  const instant = typeof clock === 'function' ? clock() : clock;
  assert.equal(Number.isFinite(instant?.getTime?.()), true);
  if (instant.getTime() >= Date.parse(reference.expiresAt)) {
    throw new Error('controlled promotion privacy proof expired');
  }
  return true;
}

function createTestStateStore({
  attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', records = [],
} = {}) {
  const append = (record) => {
    const stored = {
      ...structuredClone(record),
      attemptId,
      recordSha256: createHash('sha256')
        .update(JSON.stringify({ sequence: records.length + 1, record }))
        .digest('hex'),
    };
    records.push(stored);
    return stored;
  };
  return {
    attemptId,
    records,
    appendIntent: async (payload, { operationId } = {}) => append({
      recordType: 'intent', operationId, payload,
    }),
    appendCheckpoint: async (payload) => append({
      recordType: 'checkpoint',
      operationId: records.findLast((record) => record.recordType === 'intent')?.operationId,
      payload,
    }),
    appendAbort: async (payload) => append({
      recordType: 'abort',
      operationId: records.findLast((record) => record.recordType === 'intent')?.operationId,
      payload,
    }),
    appendTerminal: async (payload) => append({
      recordType: 'terminal', operationId: null, payload,
    }),
    close: async () => undefined,
  };
}

async function appendTestMutationCheckpoint(store, {
  operationId, mutationOrdinal, reconcileKind, outcome = 'applied', plan,
  safeResult = { kind: 'none' },
}) {
  const intent = await appendTestMutationIntent(store, {
    operationId, mutationOrdinal, reconcileKind, plan,
  });
  await store.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome,
    observationSha256: intent.payload.afterSha256,
    safeResult,
  });
  return intent;
}

function secretVersionSafeResult(expected, version = expected.secretVersion) {
  return {
    artifactSha256: expected.artifactSha256,
    kind: 'secret-version',
    name: `projects/${PROJECT}/secrets/${expected.secret}`,
    objectSha256: expected.objectSha256,
    version,
  };
}

function cloudRunExecutionListMember(expected, {
  name = `${expected.job}-abc12`,
  uid = '223e4567-e89b-42d3-a456-426614174000',
} = {}) {
  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Execution',
    metadata: {
      labels: {
        'cloud.googleapis.com/location': REGION,
        'run.googleapis.com/job': expected.job,
      },
      name,
      namespace: PROJECT_NUMBER,
      uid,
    },
  };
}

function cloudRunExecutionBaseline(expected, executions, {
  jobGeneration = 1,
  jobUid = '123e4567-e89b-42d3-a456-426614174000',
} = {}) {
  const identities = executions.map(({ metadata }) => ({
    name: metadata.name,
    uid: metadata.uid.toLowerCase(),
  })).sort((left, right) => left.name.localeCompare(right.name));
  return {
    executionCount: identities.length,
    executionSetSha256: createHash('sha256').update(JSON.stringify(identities)).digest('hex'),
    job: expected.job,
    jobGeneration,
    jobUid,
    project: PROJECT,
    projectNumber: PROJECT_NUMBER,
    region: REGION,
  };
}

function cloudRunJobSafeResult(plan, operationId, job) {
  const expected = operationId === 'migration-deploy' ? plan.expectedMigrationJob
    : plan.expectedJobs[operationId.slice(0, -'-deploy'.length)];
  return {
    generation: job.metadata.generation,
    identitySha256: releaseMutationPlanIdentity(
      plan, plan.operations.find(({ id }) => id === operationId),
    ).specSha256,
    job: expected.job,
    kind: 'cloud-run-job',
    uid: job.metadata.uid,
    valueSha256: createHash('sha256').update(JSON.stringify(canonicalFixture({
      job: expected,
      kind: 'cloud-run-job',
    }))).digest('hex'),
  };
}

async function appendTestMutationIntent(store, {
  operationId, mutationOrdinal, reconcileKind, plan = buildReleasePlan(releaseInput()),
  executionBaseline, beforeObservation,
}) {
  const digit = String((mutationOrdinal % 9) + 1);
  const member = plan.operations.find(({ id }) => id === operationId)
    ?? { id: operationId, phase: store.phase ?? 'candidate', argv: [] };
  const identity = releaseMutationPlanIdentity(plan, member);
  const stateSha256 = (value) => createHash('sha256')
    .update(JSON.stringify(canonicalFixture(value))).digest('hex');
  assert.equal(identity.reconcileKind, reconcileKind);
  const expectedBefore = beforeObservation === undefined
    ? identity.expectedBefore
    : {
      ...identity.expectedBefore,
      observationSha256: stateSha256(beforeObservation),
    };
  return store.appendIntent({
    mutationOrdinal,
    operationAttemptId: digit.repeat(32),
    commandSha256: digit.repeat(64),
    reconcileKind,
    beforeSha256: stateSha256(expectedBefore),
    afterSha256: stateSha256(identity.expectedAfter),
    ...(executionBaseline === undefined ? {} : { executionBaseline }),
  }, { operationId });
}

async function rejectedExecutionRecoveryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-execute-rejection-matrix-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'acceptance' });
  const key = 'dependency-acceptance';
  const job = plan.expectedJobs[key];
  const jobUid = '12d057cc-bcf8-4192-95fa-bd7527627e46';
  const historicalExecutions = [cloudRunExecutionListMember(job)];
  const store = createTestStateStore();
  const deployIntent = await appendTestMutationIntent(store, {
    operationId: `${key}-deploy`, mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace', plan,
  });
  await store.appendCheckpoint({
    intentRecordSha256: deployIntent.recordSha256,
    classification: 'after', outcome: 'applied',
    observationSha256: deployIntent.payload.afterSha256,
    safeResult: {
      kind: 'resource', state: 'present',
      identitySha256: '1'.repeat(64), valueSha256: '2'.repeat(64),
    },
  });
  const executeIntent = await appendTestMutationIntent(store, {
    operationId: `${key}-execute`, mutationOrdinal: 2,
    reconcileKind: 'cloud-run-job-execute', plan,
    executionBaseline: cloudRunExecutionBaseline(job, historicalExecutions, { jobUid }),
  });
  executeIntent.createdAt = '2026-09-01T06:42:26.179Z';
  const rejectionMessage = `Job '${job.job}' cannot be run because is in an error state. Please check the job's Ready status condition.`;
  const log = [
    `2026-09-01 14:42:27,212 DEBUG root Running [gcloud.run.jobs.execute] with arguments: [--format: "json", --project: "${PROJECT}", --quiet: "True", --region: "${REGION}", --wait: "True", JOB: "${job.job}"]`,
    `2026-09-01 14:42:27,888 DEBUG urllib3.connectionpool https://${REGION}-run.googleapis.com:443 "POST /apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${job.job}:run?alt=json HTTP/1.1" 400 None`,
    `response: <{'date': 'Tue, 01 Sep 2026 06:42:27 GMT', 'status': 400}>, content <{`,
    '  "error": {',
    '    "code": 400,',
    `    "message": "${rejectionMessage}",`,
    '    "status": "FAILED_PRECONDITION"',
    '  }',
    '}>',
    `2026-09-01 14:42:27,978 ERROR root (gcloud.run.jobs.execute) FAILED_PRECONDITION: ${rejectionMessage}`,
    '',
  ].join('\n');
  const logPath = join(directory, 'execute-rejection.log');
  await writeFile(logPath, log);
  const logSha256 = createHash('sha256').update(log).digest('hex');
  const liveJob = realV1JobReadback(job);
  liveJob.metadata.uid = jobUid;
  liveJob.metadata.generation = 1;
  liveJob.status = {
    observedGeneration: 1,
    conditions: [{ type: 'Ready', status: 'False', reason: 'SecretsAccessCheckFailed' }],
  };
  return {
    executeIntent, historicalExecutions, input, job, liveJob,
    logPath, logSha256, plan, store,
  };
}

async function appendTestPrivacyCheckpoint(store, {
  operationId, mutationOrdinal, plan,
}) {
  const locator = {
    filePath: operationId === 'candidate-privacy-publish'
      ? plan.candidatePrivacyProofPath
      : join(
        plan.releaseReceiptDirectory,
        `promotion-privacy-proof.${store.attemptId}.json`,
      ),
  };
  const artifact = controlledReleasePrivacyArtifact(plan, locator);
  const bytes = Buffer.from(artifact.contents);
  const artifacts = [{
    role: 'privacy-proof',
    filePath: locator.filePath,
    byteLength: bytes.length,
    objectSha256: createHash('sha256').update(bytes).digest('hex'),
    contentsBase64: bytes.toString('base64'),
  }];
  const bundleSha256 = createHash('sha256')
    .update(JSON.stringify(canonicalFixture(artifacts))).digest('hex');
  const intent = await store.appendIntent({
    mutationOrdinal,
    operationAttemptId: String(mutationOrdinal).repeat(32).slice(0, 32),
    commandSha256: createHash('sha256').update(operationId).digest('hex'),
    reconcileKind: 'local-artifact-create',
    beforeSha256: createHash('sha256').update('absent').digest('hex'),
    afterSha256: bundleSha256,
    publication: { artifacts, bundleSha256 },
  }, { operationId });
  await store.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: 'applied',
    observationSha256: bundleSha256,
    safeResult: { kind: 'artifact-bundle', artifactCount: 1, bundleSha256 },
  });
}

function runGcpRelease(options) {
  return runGcpReleaseImpl({
    loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
    persistReceipt: async () => true,
    verifyEvidence: async () => true,
    verifyTask8Evidence: async () => true,
    verifyReleasePrivacyArtifact: async () => true,
    validateReleasePrivacyProof: () => true,
    releasePrivacyTokenExecutor: async () => 'unused',
    now: () => new Date('2026-08-27T08:02:00.000Z'),
    produceReleasePrivacyArtifact: async ({ plan, locator }) => (
      controlledReleasePrivacyArtifact(plan, locator)
    ),
    writeReleasePrivacyArtifact: async () => true,
    openStateStore: async () => createTestStateStore(),
    unsafeTestOnlyAllowSingletonRollingRelease: true,
    ...options,
  });
}

function candidateServiceReadback(plan) {
  return {
    service: CANDIDATE_SERVICE,
    invokerIamDisabled: false,
    serviceMaxScale: 1,
    traffic: [{
      revision: plan.candidateRevision, tag: plan.candidateTag, percent: 100,
    }],
  };
}

function stablePriorReadback(plan) {
  return {
    service: STABLE_SERVICE,
    invokerIamDisabled: false,
    serviceMaxScale: 1,
    traffic: [{ revision: plan.previousRevision, tag: null, percent: 100 }],
  };
}

function stableStagedReadback(plan) {
  return {
    service: STABLE_SERVICE,
    invokerIamDisabled: false,
    serviceMaxScale: 1,
    traffic: plan.expectedStable.stagedTraffic.map(({ revision, tag, percent }) => ({
      revision, tag, percent,
    })),
  };
}

function stablePromotedReadback(plan) {
  return {
    service: STABLE_SERVICE,
    invokerIamDisabled: false,
    serviceMaxScale: 1,
    traffic: [{ revision: plan.stableRevision, tag: null, percent: 100 }],
  };
}

function trafficTargetAcknowledgement(revision) {
  return [{
    displayPercent: '100%',
    displayRevisionId: revision,
    displayTags: '',
    key: revision,
    latestRevision: false,
    revisionName: revision,
    serviceUrl: STABLE_ORIGIN,
    specPercent: '100',
    specTags: '-',
    statusPercent: '100',
    statusTags: '-',
    tags: [],
    urls: [],
  }];
}

function candidatePrivateIam(etag = 'candidate-private') {
  return {
    bindings: [{
      role: 'roles/run.servicesInvoker',
      members: [`serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`],
    }],
    etag,
    version: 1,
  };
}

function stablePrivateIam(etag = 'stable-private') {
  return { bindings: [], etag, version: 1 };
}

function stablePublicIam(etag = 'stable-public') {
  return {
    bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }],
    etag,
    version: 1,
  };
}

test('built image contract loads the governed corpus and rejects every unrelated data or report file', async (t) => {
  const imageRoot = await mkdtemp(join(tmpdir(), 'hkbuddy-image-contract-'));
  t.after(() => rm(imageRoot, { recursive: true, force: true }));
  await mkdir(join(imageRoot, 'data', 'knowledge'), { recursive: true });
  await copyFile(
    join(APP_ROOT, 'data', 'knowledge', 'hkbu-v1.json'),
    join(imageRoot, 'data', 'knowledge', 'hkbu-v1.json'),
  );
  await mkdir(join(imageRoot, 'scripts'), { recursive: true });
  for (const filePath of IMAGE_SCRIPTS) {
    await copyFile(join(APP_ROOT, filePath), join(imageRoot, filePath));
  }
  await writeImageReleaseManifest({
    appRoot: imageRoot,
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  });
  const verified = await verifyImageReleaseRoot({ appRoot: imageRoot });
  assert.equal(verified.ok, true);
  assert.equal(verified.dataFiles.join(','), 'data/knowledge/hkbu-v1.json');
  assert.deepEqual(verified.scriptFiles, IMAGE_SCRIPTS);
  assert.deepEqual(verified.releaseManifest, {
    schemaVersion: 1,
    buildConfigSha256: BUILD_CONFIG_SHA,
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    sourcePath: 'git-archive:production-v1',
  });
  assert.equal(verified.sourceCount > 0, true);
  assert.equal(verified.claimCount > 0, true);

  assert.throws(
    () => assertImageReleaseFileList(['data/knowledge/hkbu-v1.json', 'data/store.json']),
    /image release/i,
  );
  assert.throws(
    () => assertImageReleaseFileList(['data/knowledge/hkbu-v1.json', 'reports/release.json']),
    /image release/i,
  );
  assert.throws(() => assertImageReleaseFileList([]), /image release/i);
  assert.throws(
    () => assertImageReleaseScriptList([...IMAGE_SCRIPTS, 'scripts/debug-release.js']),
    /image release/i,
  );
});

test('release source archive is deterministic, commit-bound, and refuses a dirty worktree', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hkbuddy-release-archive-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const repositoryRoot = join(fixtureRoot, 'repository');
  await mkdir(join(repositoryRoot, 'production-v1', 'data', 'knowledge'), { recursive: true });
  await writeFile(join(repositoryRoot, 'production-v1', 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(repositoryRoot, 'production-v1', 'cloudbuild.yaml'), 'steps: []\n');
  await writeFile(
    join(repositoryRoot, 'production-v1', 'data', 'knowledge', 'hkbu-v1.json'),
    '{"sources":[],"claims":[]}\n',
  );
  const git = (...argv) => execFileSync('git', argv, {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Release Contract');
  git('config', 'user.email', 'release-contract@example.invalid');
  git('add', 'production-v1');
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '1704067200 +0000',
      GIT_COMMITTER_DATE: '1704067200 +0000',
    },
  });
  const releaseSha = git('rev-parse', 'HEAD');
  const firstReleaseRoot = join(fixtureRoot, 'release-one');
  const secondReleaseRoot = join(fixtureRoot, 'release-two');
  await mkdir(firstReleaseRoot);
  await mkdir(secondReleaseRoot);

  const first = await prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(firstReleaseRoot, 'source.tar.gz'),
  });
  const second = await prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(secondReleaseRoot, 'source.tar.gz'),
  });
  assert.equal(first.releaseSha, releaseSha);
  assert.match(first.sourceArchiveSha256, /^[0-9a-f]{64}$/);
  const firstArchive = await readFile(first.sourceArchive);
  const secondArchive = await readFile(second.sourceArchive);
  const firstTar = gunzipSync(firstArchive);
  const firstHeaderMtime = Number.parseInt(
    firstTar.subarray(136, 148).toString('ascii').replaceAll('\0', '').trim(),
    8,
  );
  assert.equal(
    firstHeaderMtime,
    1704067200,
    'git archive members must inherit the immutable release commit timestamp',
  );
  assert.equal(
    createHash('sha256').update(firstTar).digest('hex'),
    createHash('sha256').update(gunzipSync(secondArchive)).digest('hex'),
    'git archive tar bytes must be deterministic',
  );
  assert.deepEqual(firstArchive.subarray(0, 10), secondArchive.subarray(0, 10));
  assert.equal(second.sourceArchiveSha256, first.sourceArchiveSha256);
  assert.equal(firstArchive.length > 0, true);

  await writeFile(join(repositoryRoot, 'production-v1', 'dirty.txt'), 'not committed\n');
  await assert.rejects(() => prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(fixtureRoot, 'dirty.tar.gz'),
  }), /clean commit/i);
});

test('release archive command is inert until its exact SHA confirmation', async () => {
  const calls = [];
  const base = [
    '--prepare-archive',
    '--repository-root=C:\\reviewed\\repository',
    '--destination=C:\\release\\source.tar.gz',
    `--release-sha=${RELEASE_SHA}`,
  ];
  const prepare = async (input) => {
    calls.push(input);
    return { ...input, sourceArchive: input.destination, sourceArchiveSha256: SOURCE_SHA };
  };
  const dryRun = await runPrepareReleaseArchive({
    argv: base, prepare, writeOutput: () => undefined,
  });
  assert.equal(dryRun.exitCode, 0);
  assert.equal(dryRun.publicReport.status, 'dry-run');
  assert.equal(calls.length, 0);

  const confirmed = await runPrepareReleaseArchive({
    argv: [...base, `--confirm-archive=${RELEASE_SHA}`], prepare,
    writeOutput: () => undefined,
  });
  assert.equal(confirmed.exitCode, 0);
  assert.equal(confirmed.publicReport.sourceArchiveSha256, SOURCE_SHA);
  assert.equal(calls.length, 1);

  const invalid = await runPrepareReleaseArchive({
    argv: [...base, `--confirm-archive=${RELEASE_SHA}`, '--extra'], prepare,
    writeOutput: () => undefined,
  });
  assert.equal(invalid.exitCode, 2);
  assert.equal(calls.length, 1);
});

test('release plan is archive-bound, digest-pinned, evidence-first, probe-exact, and reversible', () => {
  const plan = buildReleasePlan(releaseInput());
  assert.equal(plan.releaseSha, RELEASE_SHA);
  assert.equal(plan.serviceOrigin, STABLE_ORIGIN);
  assert.equal(plan.candidateOrigin, CANDIDATE_ORIGIN);
  assert.equal(plan.candidateRevision, REVISION);
  assert.equal(plan.candidateTag, CANDIDATE_TAG);

  const ids = plan.operations.map(({ id }) => id);
  assert.equal(ids[0], 'build-submit');
  assert.equal(ids.indexOf('migration-execute') < ids.indexOf('inventory-publish:legacyInventory'), true);
  assert.equal(ids.indexOf('inventory-readback:legacyInventory') < ids.indexOf('dependency-acceptance-deploy'), true);
  assert.equal(ids.indexOf('dependency-acceptance-execute') < ids.indexOf('llm-smoke-deploy'), true);
  assert.equal(ids.indexOf('tts-smoke-execute') < ids.indexOf('evidence-collect-describe:dependencyAcceptance'), true);
  assert.equal(ids.indexOf('evidence-collect-copy:ttsSmoke') < ids.indexOf('evidence-publish:dependencyAcceptance'), true);
  assert.equal(ids.indexOf('evidence-readback:ttsSmoke') < ids.indexOf('evidence-output-delete:dependencyAcceptance'), true);
  assert.equal(ids.indexOf('evidence-output-zero-readback') < ids.indexOf('candidate-deploy'), true);
  assert.equal(ids.indexOf('evidence-readback:iosVoiceAcceptance') < ids.indexOf('candidate-deploy'), true);
  assert.equal(ids.filter((id) => id.startsWith('candidate-')).every((id) => (
    !plan.operations.find((operation) => operation.id === id).argv.includes('--member=allUsers')
  )), true);
  assert.equal(ids.includes('promote-authority-readback'), true);
  assert.equal(ids.indexOf('promote-stable-deploy') < ids.indexOf('promote-traffic'), true);
  assert.equal(ids.indexOf('promote-traffic') < ids.indexOf('promote-public-iam-readback'), true);
  assert.equal(ids.indexOf('promote-traffic') < ids.indexOf('rollback-traffic'), true);

  const artifactDescribeOperations = plan.operations.filter(({ argv }) => (
    argv.slice(0, 4).join(' ') === 'artifacts docker images describe'
  ));
  assert.equal(artifactDescribeOperations.length > 0, true);
  for (const { argv } of artifactDescribeOperations) {
    assert.equal(argv.some((member) => member.startsWith('--location=')), false);
    assert.deepEqual(argv.slice(-2), [
      `--project=${PROJECT}`,
      '--format=json(image_summary.digest,image_summary.fully_qualified_digest)',
    ]);
  }

  const build = plan.operations.find(({ id }) => id === 'build-submit');
  assert.equal(build.argv.at(-1), 'C:\\release\\source.tar.gz');
  assert.equal(build.argv.includes(`--config=${BUILD_CONFIG}`), true);
  assert.equal(build.argv.includes(`--service-account=${BUILD_SA}`), true);
  assert.equal(build.argv.includes(
    `--substitutions=_BUILD_CONFIG_SHA256=${BUILD_CONFIG_SHA},_RELEASE_SHA=${RELEASE_SHA},_SOURCE_SHA256=${SOURCE_SHA}`,
  ), true);
  assert.equal(plan.buildConfig, BUILD_CONFIG);
  assert.equal(plan.buildConfigSha256, BUILD_CONFIG_SHA);

  const candidate = plan.operations.find(({ id }) => id === 'candidate-deploy');
  assert.deepEqual(candidate.argv.slice(0, 3), ['run', 'services', 'replace']);
  assert.equal(candidate.argv[3], plan.candidateServiceSpecPath);
  const serviceSpec = plan.candidateServiceSpec;
  assert.equal(serviceSpec.apiVersion, 'serving.knative.dev/v1');
  assert.equal(serviceSpec.metadata.annotations['run.googleapis.com/maxScale'], '1');
  assert.equal(serviceSpec.spec.template.metadata.name, REVISION);
  assert.equal(serviceSpec.spec.template.spec.containers[0].image,
    `asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy-v1/hkbuddy-v1-api@${IMAGE_DIGEST}`);
  assert.equal(serviceSpec.spec.template.spec.containers[0].startupProbe.httpGet.path, '/api/health/ready');
  assert.equal(serviceSpec.spec.template.spec.containers[0].livenessProbe.httpGet.path, '/api/health/live');
  assert.equal(serviceSpec.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/api/health/ready');
  assert.equal(typeof serviceSpec.spec.template.spec.timeoutSeconds, 'number');
  assert.equal(serviceSpec.spec.template.spec.timeoutSeconds, 60);
  const mountPaths = serviceSpec.spec.template.spec.containers[0].volumeMounts
    .map(({ mountPath }) => mountPath);
  assert.equal(new Set(mountPaths).size, mountPaths.length,
    'Cloud Run v1 rejects multiple secret volumes mounted at one directory');
  assert.deepEqual(serviceSpec.spec.traffic, [
    { revisionName: REVISION, tag: CANDIDATE_TAG, percent: 100 },
  ]);
  const specEnv = Object.fromEntries(serviceSpec.spec.template.spec.containers[0].env
    .filter(({ value }) => value !== undefined).map(({ name, value }) => [name, value]));
  assert.equal(specEnv.V1_PUBLIC_ORIGIN, STABLE_ORIGIN);
  assert.equal(specEnv.V1_CANDIDATE_ORIGIN, CANDIDATE_ORIGIN);
  assert.equal(specEnv.V1_RUNTIME_SERVICE_ACCOUNT, RUNTIME_SA);
  assert.equal(specEnv.V1_RELEASE_COMMIT_SHA, RELEASE_SHA);
  for (const { artifactSha256 } of Object.values(EVIDENCE)) {
    assert.equal(Object.values(specEnv).includes(artifactSha256), true);
  }

  assert.deepEqual(plan.candidateAccess, {
    authenticated: true,
    audience: CANDIDATE_ROOT,
    issuer: 'https://accounts.google.com',
    subjectSha256: QA_SUBJECT_SHA256,
    taggedUrl: CANDIDATE_ORIGIN,
  });
  assert.equal(plan.operations.some(({ id }) => id === 'promote-public-service'), false,
    'later promotions preserve stable public IAM read-only');
  const firstReleasePlan = buildReleasePlan(releaseInput({
    previousRevision: null, previousImageDigest: null,
  }));
  const publicAuth = firstReleasePlan.operations.find(({ id }) => id === 'promote-public-service');
  assert.deepEqual(publicAuth.argv.slice(0, 5), [
    'run', 'services', 'add-iam-policy-binding', 'hkbuddy-v1-api', '--member=allUsers',
  ]);
  assert.equal(publicAuth.argv.includes('--role=roles/run.invoker'), true);
  const rollback = plan.operations.find(({ id }) => id === 'rollback-traffic');
  assert.equal(rollback.argv.includes('--to-revisions=hkbuddy-v1-api-111111111111=100'), true);

  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(':latest'), false);
  assert.equal(serialized.includes('roles/run.admin'), false);
  assert.equal(serialized.toLowerCase().includes('private_key'), false);
  assert.equal(serialized.includes('add-cloudsql-instances'), false);
});

test('immutable release identity and resolved candidate phase identity separate semantic secret-version drift', async () => {
  const baselineInput = releaseInput();
  const driftedInput = releaseInput({
    databaseSecretVersions: { app: '70', migrator: '8', session: '9' },
  });
  const baselinePlan = buildReleasePlan(baselineInput);
  const driftedPlan = buildReleasePlan(driftedInput);
  assert.equal(baselinePlan.releaseIdentitySha256, driftedPlan.releaseIdentitySha256);
  assert.notEqual(
    releasePhaseIdentitySha256(baselinePlan, 'candidate'),
    releasePhaseIdentitySha256(driftedPlan, 'candidate'),
  );

  const phasePlanHashes = [];
  for (const input of [baselineInput, driftedInput]) {
    const result = await runGcpRelease({
      argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
      input,
      openStateStore: async ({ phasePlanSha256 }) => {
        phasePlanHashes.push(phasePlanSha256);
        throw new Error('captured phase plan');
      },
      execute: async () => { throw new Error('must remain inert'); },
      writeOutput: () => undefined,
    });
    assert.equal(result.publicReport.code, 'RELEASE_STATE_INVALID');
  }
  assert.notEqual(phasePlanHashes[0], phasePlanHashes[1]);
});

test('candidate deploy is fenced by the canonical gcloud Service v1 dry-run result', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    writeCandidateSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
      }
      if (argv.includes('--dry-run')) {
        const drift = structuredClone(plan.candidateServiceSpec);
        drift.spec.template.spec.timeoutSeconds = 61;
        return drift;
      }
      throw new Error('candidate deploy must remain inert after dry-run drift');
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.some((argv) => (
    argv[0] === 'run' && argv[1] === 'services' && argv[2] === 'replace'
    && !argv.includes('--dry-run')
  )), false);
});

test('candidate Service dry-run rejects missing or drifted service maxScale before mutation', async () => {
  const cases = [
    ['missing', (service) => { delete service.metadata.annotations['run.googleapis.com/maxScale']; }],
    ['wrong value', (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = '10'; }],
    ['wrong type', (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = 1; }],
  ];
  for (const [name, mutate] of cases) {
    const input = releaseInput();
    const plan = buildReleasePlan(input);
    let deployReached = false;
    const result = await runGcpRelease({
      argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
      input,
      writeCandidateSpec: async () => true,
      execute: async (argv) => {
        if (argv[1] === 'services' && argv[2] === 'describe') {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        if (argv.includes('--dry-run')) {
          const response = structuredClone(plan.candidateServiceSpec);
          mutate(response);
          return response;
        }
        deployReached = true;
        throw new Error('candidate deploy must remain inert after service maxScale drift');
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.publicReport.resumeBoundary, 'candidate-spec-dry-run', name);
    assert.equal(deployReached, false, name);
  }
});

test('stable Service dry-run rejects missing or drifted service maxScale before mutation', async () => {
  const cases = [
    ['missing', (service) => { delete service.metadata.annotations['run.googleapis.com/maxScale']; }],
    ['wrong value', (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = '10'; }],
    ['wrong type', (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = 1; }],
  ];
  for (const [name, mutate] of cases) {
    const input = releaseInput();
    const plan = buildReleasePlan(input);
    let stableMutationReached = false;
    const result = await runGcpRelease({
      argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
      input,
      writeStableSpec: async () => true,
      execute: async (argv) => {
        if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
        if (argv[0] === 'artifacts') {
          return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
        }
        if (argv.includes('get-iam-policy')) {
          return argv.includes(CANDIDATE_SERVICE) ? candidatePrivateIam() : stablePublicIam();
        }
        if (argv[1] === 'revisions') {
          return argv[3] === plan.candidateRevision
            ? structuredClone(plan.expectedCandidate)
            : { revision: plan.previousRevision, image: plan.previousImage };
        }
        if (argv[1] === 'services' && argv[2] === 'describe') {
          return argv[3] === CANDIDATE_SERVICE
            ? candidateServiceReadback(plan) : stablePriorReadback(plan);
        }
        if (argv[1] === 'services' && argv[2] === 'replace') {
          if (argv.includes('--dry-run')) {
            const response = structuredClone(plan.stableServiceSpec);
            mutate(response);
            return response;
          }
          stableMutationReached = true;
          throw new Error('stable deploy must remain inert after service maxScale drift');
        }
        throw new Error(`unexpected operation: ${argv.join(' ')}`);
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.publicReport.resumeBoundary, 'promote-stable-spec-dry-run', name);
    assert.equal(stableMutationReached, false, name);
  }
});

test('candidate dry-run accepts only an omitted or safely spelled enabled IAM check', async () => {
  const cases = [
    ['omitted', undefined, true],
    ['canonical false', 'false', true],
    ['case-insensitive false', 'FALSE', true],
    ['true', 'true', false],
    ['whitespace', 'false ', false],
    ['boolean', false, false],
    ['null', null, false],
  ];
  for (const [name, annotation, accepted] of cases) {
    const input = releaseInput();
    const plan = buildReleasePlan(input);
    let deployReached = false;
    const result = await runGcpRelease({
      argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
      input,
      writeCandidateSpec: async () => true,
      execute: async (argv) => {
        if (argv[1] === 'services' && argv[2] === 'describe') {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        if (argv.includes('--dry-run')) {
          const response = structuredClone(plan.candidateServiceSpec);
          if (annotation === undefined) {
            delete response.metadata.annotations['run.googleapis.com/invoker-iam-disabled'];
          } else {
            response.metadata.annotations['run.googleapis.com/invoker-iam-disabled'] = annotation;
          }
          return response;
        }
        deployReached = true;
        throw new Error('stop before candidate mutation');
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1, name);
    assert.equal(deployReached, accepted, name);
    assert.equal(result.publicReport.resumeBoundary,
      accepted ? 'candidate-deploy' : 'candidate-spec-dry-run', name);
  }
});

test('candidate phase feeds raw Service JSON through gcloud 553-compatible secret-mount semantics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-candidate-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = releaseInput({
    sourceArchive: join(directory, 'source.tar.gz'),
    buildConfig: join(directory, `${RELEASE_SHA}.${BUILD_CONFIG_SHA}.cloudbuild.yaml`),
  });
  const plan = buildReleasePlan(input);
  let describeCount = 0;
  let iamGranted = false;
  const dryRun = (service) => {
    const revisionSpec = service?.spec?.template?.spec;
    const container = revisionSpec?.containers?.[0];
    if (!Number.isInteger(revisionSpec?.timeoutSeconds)) throw new Error('invalid v1 timeout');
    const paths = container?.volumeMounts?.map(({ mountPath }) => mountPath) ?? [];
    if (paths.length !== new Set(paths).size) throw new Error('duplicate v1 mount path');
    const envValues = new Set((container?.env ?? []).map(({ value }) => value).filter(Boolean));
    for (const mount of container?.volumeMounts ?? []) {
      const volume = revisionSpec.volumes.find(({ name }) => name === mount.name);
      const itemPath = volume?.secret?.items?.[0]?.path;
      if (!itemPath || !envValues.has(`${mount.mountPath}/${itemPath}`)) {
        throw new Error('secret file environment path is not volume-bound');
      }
    }
    return service;
  };
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      if (argv[1] === 'services' && argv[2] === 'replace') {
        const raw = JSON.parse(await readFile(argv[3], 'utf8'));
        dryRun(raw);
        if (argv.includes('--dry-run')) {
          const serverValidated = structuredClone(raw);
          delete serverValidated.metadata.annotations['run.googleapis.com/invoker-iam-disabled'];
          return serverValidated;
        }
        return candidateServiceReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        describeCount += 1;
        if (describeCount === 1) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return {
          service: CANDIDATE_SERVICE,
          invokerIamDisabled: false,
          serviceMaxScale: 1,
          traffic: [{ revision: REVISION, tag: CANDIDATE_TAG, percent: 100 }],
        };
      }
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv.includes('get-iam-policy')) return !iamGranted
        ? { bindings: [], etag: 'candidate-private-baseline', version: 1 }
        : {
          bindings: [{
            role: 'roles/run.servicesInvoker',
            members: [`serviceAccount:${ACCEPTANCE_SA}`],
          }],
          etag: 'candidate-private-granted', version: 1,
        };
      if (argv.includes('add-iam-policy-binding')) {
        iamGranted = true;
        return {
          bindings: [{
            role: 'roles/run.servicesInvoker',
            members: [`serviceAccount:${ACCEPTANCE_SA}`],
          }],
          etag: 'candidate-private-granted', version: 1,
        };
      }
      if (argv[0] === 'artifacts') return artifactReadback(plan.expectedCandidate.image);
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.doesNotThrow(() => validateCandidateControlPlaneReadbacks({
    service: {
      service: CANDIDATE_SERVICE,
      invokerIamDisabled: false,
      serviceMaxScale: 1,
      traffic: [{ revision: REVISION, tag: CANDIDATE_TAG, percent: 100 }],
    },
    revision: structuredClone(plan.expectedCandidate),
    artifact: artifactReadback(plan.expectedCandidate.image),
    iam: {
      bindings: [{
        role: 'roles/run.servicesInvoker',
        members: [`serviceAccount:${ACCEPTANCE_SA}`],
      }],
      etag: 'candidate-private-granted', version: 1,
    },
  }, plan));
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.phaseReceipt.outputs.privacyProof.filePath,
    plan.candidatePrivacyProofPath);
  assert.match(result.publicReport.phaseReceipt.outputs.privacyProof.objectSha256, /^[0-9a-f]{64}$/);
  const invalid = structuredClone(plan.candidateServiceSpec);
  invalid.spec.template.spec.containers[0].volumeMounts[1].mountPath
    = invalid.spec.template.spec.containers[0].volumeMounts[0].mountPath;
  assert.throws(() => dryRun(invalid), /duplicate v1 mount path/);
});

test('preboot acceptance jobs are digest-pinned, identity-exact, and produce evidence before candidate boot', () => {
  const plan = buildReleasePlan(releaseInput());
  const dependency = plan.operations.find(({ id }) => id === 'dependency-acceptance-deploy');
  assert.equal(dependency.phase, 'acceptance');
  assert.equal(dependency.argv.includes(`--image=asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy-v1/hkbuddy-v1-api@${IMAGE_DIGEST}`), true);
  assert.equal(dependency.argv.includes(`--service-account=${ACCEPTANCE_SA}`), true);
  assert.equal(dependency.argv.includes('--command=node'), true);
  assert.equal(dependency.argv.includes(`--args=scripts/real-dependencies-acceptance.js,--release-sha=${RELEASE_SHA}`), true);
  assert.equal(dependency.argv.includes('--max-retries=0'), true);
  const dependencyEnv = dependency.argv.find((value) => value.startsWith('--set-env-vars='));
  assert.match(dependencyEnv, new RegExp(`V1_RELEASE_MANIFEST_FILE=/app/release-manifest\\.json`));
  assert.match(dependencyEnv, new RegExp(`V1_ACCEPTANCE_SCHEMA=v1_accept_${ACCEPTANCE_RUN_ID.replaceAll('-', '')}`));
  assert.match(dependencyEnv, new RegExp(`V1_ACCEPTANCE_GCS_PREFIX=v1-accept/${ACCEPTANCE_RUN_ID}/`));
  assert.match(dependencyEnv, new RegExp(`V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT=release-evidence/${RELEASE_SHA}/dependency-acceptance/${ACCEPTANCE_RUN_ID}\\.json`));
  const dependencySecrets = dependency.argv.find((value) => value.startsWith('--set-secrets='));
  assert.match(dependencySecrets, /V1_DATABASE_URL=hkbuddy-v1-db-app-url:7/);
  assert.match(dependencySecrets, /V1_ACCEPTANCE_DATABASE_URL=hkbuddy-v1-db-app-url:7/);
  assert.match(dependencySecrets, /V1_ACCEPTANCE_MIGRATOR_DATABASE_URL=hkbuddy-v1-db-migrator-url:8/);
  assert.match(dependencySecrets, /\/var\/run\/secrets\/hkbuddy\/legacy-inventory\/legacy-inventory\.json=hkbuddy-v1-legacy-inventory:11/);

  const expected = {
    'dependency-acceptance': { serviceAccount: ACCEPTANCE_SA, script: 'scripts/real-dependencies-acceptance.js' },
    'llm-smoke': { serviceAccount: RUNTIME_SA, script: 'scripts/provider-smoke.js' },
    'asr-smoke': { serviceAccount: RUNTIME_SA, script: 'scripts/voice-provider-smoke.js' },
    'tts-smoke': { serviceAccount: RUNTIME_SA, script: 'scripts/voice-provider-smoke.js' },
  };
  for (const [key, contract] of Object.entries(expected)) {
    const deploy = plan.operations.find(({ id }) => id === `${key}-deploy`);
    assert.equal(deploy.argv.includes(`--service-account=${contract.serviceAccount}`), true, key);
    assert.equal(deploy.argv.includes(`--image=asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy-v1/hkbuddy-v1-api@${IMAGE_DIGEST}`), true, key);
    assert.equal(deploy.argv.some((value) => value.includes(contract.script)), true, key);
    assert.equal(plan.operations.some(({ id }) => id === `${key}-readback`), true, key);
    assert.equal(plan.operations.some(({ id }) => id === `${key}-execute`), true, key);
    assert.equal(plan.operations.some(({ id }) => id === `${key}-execution-readback`), true, key);
    assert.equal(plan.expectedJobs[key].serviceAccount, contract.serviceAccount, key);
    assert.equal(plan.expectedJobs[key].image.endsWith(`@${IMAGE_DIGEST}`), true, key);
  }
  const asr = plan.operations.find(({ id }) => id === 'asr-smoke-deploy');
  assert.equal(asr.argv.includes('--args=scripts/voice-provider-smoke.js,--capability,asr,--generate-asr-fixtures-with-pinned-tts,--confirm-real-voice-provider,--confirm-asr-audio-nonsensitive'), true);
  const tts = plan.operations.find(({ id }) => id === 'tts-smoke-deploy');
  assert.equal(tts.argv.includes('--args=scripts/voice-provider-smoke.js,--capability,tts,--confirm-real-voice-provider'), true);
  assert.equal(JSON.stringify(plan.expectedJobs).includes('ios-voice-evidence'), false);
  assert.equal(plan.expectedJobs['llm-smoke'].environment.V1_LLM_SMOKE_OUTPUT_OBJECT, ACCEPTANCE_OUTPUTS.llmSmoke.object);
  assert.equal(plan.expectedJobs['asr-smoke'].environment.V1_VOICE_SMOKE_OUTPUT_OBJECT, ACCEPTANCE_OUTPUTS.asrSmoke.object);
  assert.equal(plan.expectedJobs['tts-smoke'].environment.V1_VOICE_SMOKE_OUTPUT_OBJECT, ACCEPTANCE_OUTPUTS.ttsSmoke.object);

  for (const [key, output] of Object.entries(ACCEPTANCE_OUTPUTS)) {
    const source = `gs://${output.bucket}/${output.object}#${output.generation}`;
    const describe = plan.operations.find(({ id }) => id === `evidence-collect-describe:${key}`);
    const copy = plan.operations.find(({ id }) => id === `evidence-collect-copy:${key}`);
    const remove = plan.operations.find(({ id }) => id === `evidence-output-delete:${key}`);
    assert.equal(describe.argv.includes(source), true, key);
    assert.equal(copy.argv.includes(source), true, key);
    assert.equal(copy.argv.includes(output.filePath), true, key);
    assert.equal(remove.argv.includes(source), true, key);
  }
});

test('release-evidence storage boundary rejects every widened collect cleanup or list target', () => {
  const validate = gcpReleaseContract.validateReleaseEvidenceStorageOperations;
  assert.equal(typeof validate, 'function');
  const plan = buildReleasePlan(releaseInput());
  assert.equal(validate(plan), true);
  const exactPrefix = `gs://${GCP_IDENTITY.bucket}/release-evidence/${RELEASE_SHA}/`;
  const storageOperations = plan.operations.filter(({ id }) => (
    id.startsWith('evidence-collect-') || id.startsWith('evidence-output-')
  ));
  assert.equal(storageOperations.length, 17);
  for (const member of storageOperations) {
    const targets = member.argv.filter((value) => value.startsWith('gs://'));
    assert.equal(targets.length, 1, member.id);
    assert.equal(targets[0].startsWith(exactPrefix), true, member.id);
  }

  const cases = [
    ['foreign bucket', (candidate) => {
      candidate.acceptanceOutputs.dependencyAcceptance.bucket = 'foreign-bucket';
      for (const member of candidate.operations.filter(({ id }) => id.endsWith(':dependencyAcceptance'))) {
        member.argv = member.argv.map((value) => value.replace(GCP_IDENTITY.bucket, 'foreign-bucket'));
      }
    }],
    ['sibling prefix', (candidate) => {
      candidate.acceptanceOutputs.dependencyAcceptance.object = candidate.acceptanceOutputs.dependencyAcceptance.object
        .replace('release-evidence/', 'release-evidence-evil/');
      for (const member of candidate.operations.filter(({ id }) => id.endsWith(':dependencyAcceptance'))) {
        member.argv = member.argv.map((value) => value.replace('release-evidence/', 'release-evidence-evil/'));
      }
    }],
    ['another release SHA', (candidate) => {
      const otherSha = 'f'.repeat(40);
      candidate.acceptanceOutputs.dependencyAcceptance.object = candidate.acceptanceOutputs.dependencyAcceptance.object
        .replace(RELEASE_SHA, otherSha);
      for (const member of candidate.operations.filter(({ id }) => id.endsWith(':dependencyAcceptance'))) {
        member.argv = member.argv.map((value) => value.replace(RELEASE_SHA, otherSha));
      }
    }],
    ['widened residue list', (candidate) => {
      const member = candidate.operations.find(({ id }) => id === 'evidence-output-zero-readback');
      member.argv[3] = `gs://${GCP_IDENTITY.bucket}/release-evidence/**`;
    }],
    ['invalid generation', (candidate) => {
      candidate.acceptanceOutputs.dependencyAcceptance.generation = 'latest';
      for (const member of candidate.operations.filter(({ id }) => id.endsWith(':dependencyAcceptance'))) {
        member.argv = member.argv.map((value) => value.replace('#101', '#latest'));
      }
    }],
    ['ungenerated collect target', (candidate) => {
      const member = candidate.operations.find(({ id }) => (
        id === 'evidence-collect-copy:dependencyAcceptance'
      ));
      member.argv[2] = member.argv[2].replace('#101', '');
    }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = structuredClone(plan);
    mutate(candidate);
    assert.throws(() => validate(candidate), /release evidence storage boundary/i, name);
  }
});

test('acceptance execution reads back each exact Job identity before running it', async () => {
  const input = releaseInput({
    acceptanceOutputs: null, evidence: null, previousRevision: null, previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'acceptance' });
  const expectedByJob = Object.fromEntries(Object.values(plan.expectedJobs).map((value) => (
    [value.job, value]
  )));
  const historicalByJob = Object.fromEntries(Object.values(plan.expectedJobs).map((value, index) => (
    [value.job, [cloudRunExecutionListMember(value, {
      uid: `223e4567-e89b-42d3-a456-42661417400${index}`,
    })]]
  )));
  const store = createTestStateStore();
  const events = [];
  const appendIntent = store.appendIntent;
  store.appendIntent = async (payload, options) => {
    events.push(`intent:${payload.executionBaseline?.job ?? options.operationId}`);
    return appendIntent(payload, options);
  };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'describe') return realV1JobReadback(expectedByJob[argv[3]]);
      if (argv[2] === 'deploy') return { done: true };
      if (argv[2] === 'executions' && argv[3] === 'list') {
        const job = argv.find((value) => value.startsWith('--job='))?.slice('--job='.length);
        events.push(`list:${job}`);
        return structuredClone(historicalByJob[job]);
      }
      if (argv[2] === 'execute') {
        events.push(`execute:${argv[3]}`);
        return {
          apiVersion: 'run.googleapis.com/v1',
          kind: 'Execution',
          metadata: {
            name: `${argv[3]}-release-001`,
            labels: { 'run.googleapis.com/job': argv[3] },
          },
        };
      }
      if (argv[2] === 'executions' && argv[3] === 'describe') {
        const name = argv[4];
        const job = name.slice(0, -'-release-001'.length);
        const expected = expectedByJob[job];
        return {
          apiVersion: 'run.googleapis.com/v1',
          kind: 'Execution',
          metadata: { name, labels: { 'run.googleapis.com/job': job } },
          spec: { taskCount: expected.taskCount, parallelism: expected.parallelism },
          status: {
            conditions: [{ type: 'Completed', status: 'True' }],
            completionTime: '2026-08-26T08:00:00.000Z',
            succeededCount: expected.taskCount,
          },
        };
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.length, 20);
  for (const [key, expected] of Object.entries(plan.expectedJobs)) {
    assert.equal(validateReleaseJobReadback(structuredClone(expected), expected), true);
    const mismatched = structuredClone(expected);
    mismatched.serviceAccount = 'hkbuddy-deployer@example.invalid';
    assert.throws(() => validateReleaseJobReadback(mismatched, expected), /Job readback/i);
    const listIndex = calls.findIndex((argv) => (
      argv[2] === 'executions' && argv[3] === 'list'
      && argv.includes(`--job=${expected.job}`)
    ));
    const executeIndex = calls.findIndex((argv) => (
      argv[2] === 'execute' && argv[3] === expected.job
    ));
    assert.notEqual(listIndex, -1, expected.job);
    assert.equal(listIndex < executeIndex, true, expected.job);
    const executeIntent = store.records.find(({ recordType, operationId }) => (
      recordType === 'intent' && operationId === `${key}-execute`
    ));
    assert.deepEqual(executeIntent.payload.executionBaseline,
      cloudRunExecutionBaseline(expected, historicalByJob[expected.job]));
    assert.deepEqual(events.filter((value) => value.endsWith(`:${expected.job}`)), [
      `list:${expected.job}`, `intent:${expected.job}`, `execute:${expected.job}`,
    ]);
  }
});

test('dependency acceptance accepts the real v1 directory mount plus secret item filename', () => {
  const plan = buildReleasePlan(
    releaseInput({
      acceptanceOutputs: null, evidence: null, previousRevision: null, previousImageDigest: null,
    }),
    { phase: 'acceptance' },
  );
  const expected = plan.expectedJobs['dependency-acceptance'];
  const readback = realV1JobReadback(expected);
  assert.equal(validateReleaseJobReadback(readback, expected), true);

  for (const mutate of [
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.secretName = 'wrong-secret'; },
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.items[0].key = 'latest'; },
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.items[0].path = 'wrong.json'; },
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.items.push({ key: '11', path: 'extra.json' }); },
  ]) {
    const drift = structuredClone(readback);
    mutate(drift);
    assert.throws(() => validateReleaseJobReadback(drift, expected), /Job readback/i);
  }
});

test('authoritative Job readiness requires one stable UID, observed generation, and Ready=True', () => {
  const plan = buildReleasePlan(
    releaseInput({
      acceptanceOutputs: null, evidence: null, previousRevision: null, previousImageDigest: null,
    }),
    { phase: 'acceptance' },
  );
  const expected = plan.expectedJobs['dependency-acceptance'];
  const readback = realV1JobReadback(expected);
  assert.deepEqual(validateReadyReleaseJobReadback(readback, expected), {
    generation: 1,
    job: expected.job,
    uid: '123e4567-e89b-42d3-a456-426614174000',
  });
  for (const mutate of [
    (value) => { delete value.metadata.uid; },
    (value) => { value.metadata.uid = 'not-a-uid'; },
    (value) => { value.metadata.uid = '123e4567-e89b-12d3-a456-426614174000'; },
    (value) => { value.metadata.generation = 0; },
    (value) => { value.metadata.generation = true; },
    (value) => { value.metadata.generation = '01'; },
    (value) => { value.status.observedGeneration = 2; },
    (value) => { value.status.conditions = []; },
    (value) => { value.status.conditions[0].status = 'False'; },
    (value) => { value.status.conditions[0].status = 'Unknown'; },
    (value) => { value.status.conditions[0].type = 'Completed'; },
    (value) => { value.status.conditions.push({ type: 'Ready', status: 'True' }); },
  ]) {
    const drift = structuredClone(readback);
    mutate(drift);
    assert.throws(
      () => validateReadyReleaseJobReadback(drift, expected),
      /Job authority/i,
    );
  }
  assert.throws(
    () => validateReadyReleaseJobReadback(structuredClone(expected), expected),
    /Job authority/i,
  );
});

test('release contract separates numeric Secret versions from immutable evidence artifact digests', () => {
  for (const input of [
    releaseInput({ databaseSecretVersions: { app: 'latest', migrator: '8', session: '9' } }),
    releaseInput({ evidence: { ...EVIDENCE, llmSmoke: { ...EVIDENCE.llmSmoke, secretVersion: 'latest' } } }),
    releaseInput({ evidence: { ...EVIDENCE, llmSmoke: { ...EVIDENCE.llmSmoke, artifactSha256: '13' } } }),
    releaseInput({ evidence: { ...EVIDENCE, llmSmoke: { ...EVIDENCE.llmSmoke, objectSha256: '13' } } }),
    releaseInput({ imageDigest: `sha256:${'A'.repeat(64)}` }),
    releaseInput({ sourceArchive: '.' }),
    releaseInput({ previousRevision: 'other-service-revision' }),
    releaseInput({
      acceptanceOutputs: {
        ...ACCEPTANCE_OUTPUTS,
        llmSmoke: { ...ACCEPTANCE_OUTPUTS.llmSmoke, generation: 'latest' },
      },
    }),
    releaseInput({
      acceptanceOutputs: {
        ...ACCEPTANCE_OUTPUTS,
        asrSmoke: { ...ACCEPTANCE_OUTPUTS.asrSmoke, object: 'release-evidence/wrong.json' },
      },
    }),
  ]) assert.throws(() => buildReleasePlan(input), /release contract/i);
});

test('evidence artifact verification separates semantic digest from exact object bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-evidence-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'dependency-acceptance.json');
  const record = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: RELEASE_SHA,
    result: true,
  });
  const artifactSha256 = record.artifactSha256;
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(filePath, contents);
  const objectSha256 = createHash('sha256').update(contents).digest('hex');
  const verified = await validateEvidenceArtifactFile({
    filePath, artifactSha256, objectSha256,
  }, { releaseSha: RELEASE_SHA });
  assert.equal(verified.artifactSha256, artifactSha256);
  assert.equal(verified.objectSha256, objectSha256);
  assert.equal(verified.byteLength, Buffer.byteLength(contents));

  await assert.rejects(() => validateEvidenceArtifactFile({
    filePath, artifactSha256, objectSha256: '8'.repeat(64),
  }, { releaseSha: RELEASE_SHA }), /evidence artifact/i);
});

test('release gcloud executor writes one exact evidence buffer to stdin', async () => {
  const payload = Buffer.from('{"artifact":"verified"}\n');
  let invocation = null;
  let written = null;
  const receipt = {
    name: `projects/${PROJECT}/secrets/hkbuddy-v1-legacy-inventory/versions/11`,
    state: 'ENABLED',
  };
  const executor = createReleaseGcloudExecutor({
    ordinaryExecutor: async () => { throw new Error('ordinary executor must remain inert'); },
    resolveLaunch: () => ({ executable: 'controlled-gcloud', prefixArgs: ['gcloud.py'] }),
    execFileImpl: (executable, argv, options, callback) => {
      invocation = { executable, argv, options };
      return {
        kill: () => undefined,
        stdin: {
          once: () => undefined,
          end: (bytes) => {
            written = Buffer.from(bytes);
            queueMicrotask(() => callback(null, JSON.stringify(receipt)));
          },
        },
      };
    },
  });
  const actual = await executor([
    'secrets', 'versions', 'add', 'hkbuddy-v1-legacy-inventory', '--data-file=-',
    `--project=${PROJECT}`, '--format=json',
  ], { stdin: payload });
  assert.deepEqual(actual, receipt);
  assert.deepEqual(written, payload);
  assert.equal(invocation.executable, 'controlled-gcloud');
  assert.deepEqual(invocation.argv, [
    'gcloud.py', 'secrets', 'versions', 'add', 'hkbuddy-v1-legacy-inventory',
    '--data-file=-', `--project=${PROJECT}`, '--format=json', '--quiet',
  ]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.timeout, 120_000);
});

test('release gcloud executor reads one exact Secret payload as private base64url text', async () => {
  const payload = Buffer.from('{"artifact":"verified"}\n').toString('base64url');
  let invocation = null;
  const executor = createReleaseGcloudExecutor({
    ordinaryExecutor: async () => { throw new Error('ordinary executor must remain inert'); },
    resolveLaunch: () => ({ executable: 'controlled-gcloud', prefixArgs: ['gcloud.py'] }),
    execFileImpl: (executable, argv, options, callback) => {
      invocation = { executable, argv, options };
      queueMicrotask(() => callback(null, `${payload}\n`));
      return { kill: () => undefined };
    },
  });
  const actual = await executor([
    'secrets', 'versions', 'access', '11', '--secret=hkbuddy-v1-legacy-inventory',
    `--project=${PROJECT}`, '--format=get(payload.data)',
  ], { maxBuffer: 2 * 1024 * 1024, text: true });
  assert.equal(actual, payload);
  assert.equal(invocation.executable, 'controlled-gcloud');
  assert.deepEqual(invocation.argv, [
    'gcloud.py', 'secrets', 'versions', 'access', '11',
    '--secret=hkbuddy-v1-legacy-inventory', `--project=${PROJECT}`,
    '--format=get(payload.data)', '--quiet',
  ]);
  assert.equal(invocation.options.encoding, 'utf8');
  assert.equal(invocation.options.maxBuffer, 2 * 1024 * 1024);
});

test('evidence phase rejects self-hashed invalid iOS voice semantics before Secret mutation', async (t) => {
  const current = new Date('2026-08-29T08:00:00.000Z');
  const mutations = [
    ['schema', (value) => { value.schemaVersion = 3; }],
    ['result', (value) => { value.result = 'fail'; }],
    ['normalizer contract', (value) => { value.normalizerContractVersion = 'canonical-wav-v999'; }],
    ['normalizer binary', (value) => { value.normalizerBinarySha256 = '5'.repeat(64); }],
    ['stale', (value) => {
      value.occurredAt = '2026-05-29T07:59:59.000Z';
      value.deviceObservedAt = value.occurredAt;
    }],
    ['future', (value) => {
      value.occurredAt = '2026-08-29T08:05:01.000Z';
      value.deviceObservedAt = value.occurredAt;
    }],
  ];
  for (const [name, mutateIos] of mutations) {
    await t.test(name, async (st) => {
      const input = await materializedReleaseEvidenceInput(st, { mutateIos });
      const calls = [];
      const result = await runGcpRelease({
        argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
        input,
        verifyEvidence: undefined,
        execute: async (argv) => {
          calls.push(argv);
          throw new Error('Secret mutation must remain inert');
        },
        now: () => current,
        writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1, name);
      assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED', name);
      assert.equal(result.publicReport.mutationPerformed, false, name);
      assert.deepEqual(calls, [], name);
    });
  }
});

test('evidence phase rejects invalid iOS semantics when the current clock is undefined', async (t) => {
  const input = await materializedReleaseEvidenceInput(t, {
    mutateIos: (value) => { value.schemaVersion = 3; },
  });
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    execute: async (argv) => {
      calls.push(argv);
      throw new Error('Secret mutation must remain inert');
    },
    now: () => undefined,
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('evidence phase accepts one current iOS voice v4 artifact and publishes assigned versions', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const versionsBySecret = Object.fromEntries(Object.values(input.evidence).map((value) => (
    [value.secret, value.secretVersion]
  )));
  const calls = [];
  const publishedBySecret = new Map();
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    execute: async (argv, { stdin } = {}) => {
      calls.push(argv);
      if (argv[0] === 'storage') {
        return argv[1] === 'objects' && argv[2] === 'list' ? [] : { done: true };
      }
      const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
      const secret = isPublish
        ? argv[3]
        : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
      if (isPublish) publishedBySecret.set(secret, Buffer.from(stdin));
      if (argv[2] === 'access') return publishedBySecret.get(secret).toString('base64url');
      const version = isPublish ? versionsBySecret[secret] : argv[3];
      return { name: `projects/${PROJECT}/secrets/${secret}/versions/${version}`, state: 'ENABLED' };
    },
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv[0] === 'secrets'
    && argv[1] === 'versions' && argv[2] === 'add'), true);
});

test('evidence phase accepts the exact current iOS owner waiver before publishing assigned versions', async (t) => {
  const input = await materializedReleaseEvidenceInput(t, {
    iosPayload: validIosVoiceWaiverPayload(),
  });
  const versionsBySecret = Object.fromEntries(Object.values(input.evidence).map((value) => (
    [value.secret, value.secretVersion]
  )));
  const calls = [];
  const publishedBySecret = new Map();
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    execute: async (argv, { stdin } = {}) => {
      calls.push(argv);
      if (argv[0] === 'storage') {
        return argv[1] === 'objects' && argv[2] === 'list' ? [] : { done: true };
      }
      const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
      const secret = isPublish
        ? argv[3]
        : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
      if (isPublish) publishedBySecret.set(secret, Buffer.from(stdin));
      if (argv[2] === 'access') return publishedBySecret.get(secret).toString('base64url');
      const version = isPublish ? versionsBySecret[secret] : argv[3];
      return { name: `projects/${PROJECT}/secrets/${secret}/versions/${version}`, state: 'ENABLED' };
    },
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  const firstPublication = calls.findIndex((argv) => argv[0] === 'secrets'
    && argv[1] === 'versions' && argv[2] === 'add');
  assert.notEqual(firstPublication, -1);
  assert.equal(calls.slice(0, firstPublication).some((argv) => argv[0] === 'secrets'), false);
});

test('evidence publication streams the verified bytes after the source path is replaced', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const iosEntry = input.evidence.iosVoiceAcceptance;
  const verifiedBytes = await readFile(iosEntry.filePath);
  const versionsBySecret = Object.fromEntries(Object.values(input.evidence).map((value) => (
    [value.secret, value.secretVersion]
  )));
  let sourceReplaced = false;
  let publishedIosBytes = null;
  const publishedBySecret = new Map();
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    execute: async (argv, { stdin } = {}) => {
      if (argv[0] === 'storage') {
        return argv[1] === 'objects' && argv[2] === 'list' ? [] : { done: true };
      }
      const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
      if (isPublish && !sourceReplaced) {
        await writeFile(iosEntry.filePath, '{"tampered":true}\n');
        sourceReplaced = true;
      }
      const secret = isPublish
        ? argv[3]
        : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
      const version = isPublish ? versionsBySecret[secret] : argv[3];
      if (isPublish) publishedBySecret.set(secret, Buffer.from(stdin));
      if (isPublish && secret === iosEntry.secret) {
        const dataFile = argv.find((value) => value.startsWith('--data-file='))
          ?.slice('--data-file='.length);
        publishedIosBytes = dataFile === '-' ? Buffer.from(stdin) : await readFile(dataFile);
      }
      if (argv[2] === 'access') return publishedBySecret.get(secret).toString('base64url');
      return { name: `projects/${PROJECT}/secrets/${secret}/versions/${version}`, state: 'ENABLED' };
    },
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(sourceReplaced, true);
  assert.equal(createHash('sha256').update(publishedIosBytes).digest('hex'), iosEntry.objectSha256);
  assert.deepEqual(publishedIosBytes, verifiedBytes);
  assert.notEqual(createHash('sha256').update(await readFile(iosEntry.filePath)).digest('hex'),
    iosEntry.objectSha256);
});

test('inventory publication streams the verified legacy bytes after the source path is replaced', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const legacyEntry = input.evidence.legacyInventory;
  const verifiedBytes = await readFile(legacyEntry.filePath);
  let publishedBytes = null;
  const result = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    execute: async (argv, { stdin } = {}) => {
      const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
      if (isPublish) {
        await writeFile(legacyEntry.filePath, '{"tampered":true}\n');
        const dataFile = argv.find((value) => value.startsWith('--data-file='))
          ?.slice('--data-file='.length);
        publishedBytes = dataFile === '-' ? Buffer.from(stdin) : await readFile(dataFile);
      }
      if (argv[2] === 'access') return publishedBytes.toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${legacyEntry.secret}/versions/${legacyEntry.secretVersion}`,
        state: 'ENABLED',
      };
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(createHash('sha256').update(publishedBytes).digest('hex'), legacyEntry.objectSha256);
  assert.deepEqual(publishedBytes, verifiedBytes);
  assert.notEqual(createHash('sha256').update(await readFile(legacyEntry.filePath)).digest('hex'),
    legacyEntry.objectSha256);
});

test('evidence publication stops before GCS deletion when Secret payload readback drifts', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const versionsBySecret = Object.fromEntries(Object.values(input.evidence).map((value) => (
    [value.secret, value.secretVersion]
  )));
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'storage') throw new Error('GCS deletion must remain inert');
      const secret = argv[2] === 'add'
        ? argv[3] : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
      const version = argv[2] === 'add' ? versionsBySecret[secret] : argv[3];
      if (argv[2] === 'access') return Buffer.from('{"tampered":true}\n').toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${secret}/versions/${version}`,
        state: 'ENABLED',
      };
    },
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.equal(calls.some((argv) => argv[0] === 'secrets' && argv[2] === 'access'), true);
  assert.equal(calls.some((argv) => argv[0] === 'storage'), false);
});

test('inventory publication rejects a drifted Secret payload readback', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const legacyEntry = input.evidence.legacyInventory;
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'access') return Buffer.from('{"tampered":true}\n').toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${legacyEntry.secret}/versions/${legacyEntry.secretVersion}`,
        state: 'ENABLED',
      };
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.equal(calls.some((argv) => argv[0] === 'secrets' && argv[2] === 'access'), true);
});

test('receipt-bound cleanup and rollback do not reapply current iOS freshness to historical evidence', async (t) => {
  const input = await materializedReleaseEvidenceInput(t, {
    mutateIos: (value) => {
      value.occurredAt = '2026-05-29T07:59:59.000Z';
      value.deviceObservedAt = value.occurredAt;
    },
  });
  for (const phase of ['candidate-cleanup', 'rollback']) {
    await t.test(phase, async () => {
      const calls = [];
      const result = await runGcpRelease({
        argv: [`--phase=${phase}`, `--confirm-release=${RELEASE_SHA}`],
        input,
        verifyEvidence: undefined,
        execute: async (argv) => {
          calls.push(argv);
          throw new Error('stop after historical evidence verification');
        },
        now: () => new Date('2026-08-29T08:00:00.000Z'),
        writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1, phase);
      assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED', phase);
      assert.equal(result.publicReport.mutationPerformed, false, phase);
      assert.equal(calls.length, 1, phase);
    });
  }
});

test('generation-bound private evidence collection derives exact safe digests from downloaded bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-collected-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputs = Object.fromEntries(Object.entries(ACCEPTANCE_OUTPUTS).map(([key, value]) => [
    key, { ...value, filePath: join(directory, `${key}.json`) },
  ]));
  const fixtureByPath = {};
  for (const [index, [key, output]] of Object.entries(outputs).entries()) {
    const capability = key === 'llmSmoke' ? 'llm' : key === 'asrSmoke' ? 'asr' : 'tts';
    const payload = {
      schemaVersion: 1,
      commitSha: RELEASE_SHA,
      ...(key === 'dependencyAcceptance' ? { result: true } : { capability, result: 'pass' }),
    };
    const record = ['asrSmoke', 'ttsSmoke'].includes(key)
      ? finalizeEvidenceRecord(payload) : finalizeReleaseEvidenceRecord(payload);
    const contents = `${JSON.stringify(record)}\n`;
    fixtureByPath[output.filePath] = contents;
  }
  const described = [];
  const copied = [];
  const result = await runGcpRelease({
    argv: ['--phase=collect', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      acceptanceOutputs: outputs,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
      previousImageDigest: null,
    }),
    execute: async (argv) => {
      if (argv[1] === 'objects') {
        const source = argv[3];
        const output = Object.values(outputs).find((value) => (
          source === `gs://${value.bucket}/${value.object}#${value.generation}`
        ));
        described.push(source);
        return {
          bucket: output.bucket,
          name: output.object,
          generation: output.generation,
          size: String(Buffer.byteLength(fixtureByPath[output.filePath])),
          contentType: 'application/json',
        };
      }
      const output = Object.values(outputs).find(({ filePath }) => filePath === argv[3]);
      copied.push(argv[2]);
      await writeFile(output.filePath, fixtureByPath[output.filePath], { flag: 'wx' });
      return null;
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(described.length, 4);
  assert.equal(copied.length, 4);
  assert.deepEqual(Object.keys(result.publicReport.collectedEvidence), Object.keys(outputs));
  for (const [key, receipt] of Object.entries(result.publicReport.collectedEvidence)) {
    assert.equal(Object.hasOwn(receipt, 'filePath'), false);
    assert.match(receipt.artifactSha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.objectSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(receipt.artifactSha256, receipt.objectSha256);
    assert.equal((await inspectCollectedEvidenceArtifact(outputs[key].filePath, {
      releaseSha: RELEASE_SHA, kind: key,
    })).objectSha256, receipt.objectSha256);
  }

  assert.equal(validateAcceptanceObjectReceipt({
    bucket: outputs.llmSmoke.bucket,
    name: outputs.llmSmoke.object,
    generation: outputs.llmSmoke.generation,
    size: '100',
    contentType: 'application/json',
  }, outputs.llmSmoke).generation, outputs.llmSmoke.generation);
  assert.throws(() => validateAcceptanceObjectReceipt({
    bucket: outputs.llmSmoke.bucket,
    name: outputs.llmSmoke.object,
    generation: '999',
    size: '100',
  }, outputs.llmSmoke), /object receipt/i);

  const preexisting = await runGcpRelease({
    argv: ['--phase=collect', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      acceptanceOutputs: outputs,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
      previousImageDigest: null,
    }),
    execute: async () => { throw new Error('must stop before GCP readback'); },
    writeOutput: () => undefined,
  });
  assert.equal(preexisting.exitCode, 1);
  assert.equal(preexisting.publicReport.mutationPerformed, false);
  assert.deepEqual(preexisting.publicReport.completed, []);
});

test('collection restart adopts one exact local copy and leaves untouched destinations absent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-collect-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputs = Object.fromEntries(Object.entries(ACCEPTANCE_OUTPUTS).map(([key, value]) => [
    key, { ...value, filePath: join(directory, `${key}.json`) },
  ]));
  const firstKey = Object.keys(outputs)[0];
  await writeFile(outputs[firstKey].filePath, 'controlled-copy', { flag: 'wx' });

  const input = releaseInput({
    acceptanceOutputs: outputs,
    databaseSecretVersions: null,
    evidence: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'collect' });
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: `evidence-collect-copy:${firstKey}`,
    mutationOrdinal: 1,
    reconcileKind: 'gcs-object-write',
    plan,
  });
  const appendCheckpoint = store.appendCheckpoint;
  const checkpoints = [];
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=collect', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    inspectCollected: async (filePath) => ({
      artifactSha256: createHash('sha256').update(`artifact:${filePath}`).digest('hex'),
      objectSha256: createHash('sha256').update(`object:${filePath}`).digest('hex'),
      byteLength: 15,
    }),
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'objects' && argv[2] === 'describe') {
        const output = Object.values(outputs).find(({ bucket, object, generation }) => (
          argv[3] === `gs://${bucket}/${object}#${generation}`
        ));
        return {
          bucket: output.bucket,
          name: output.object,
          generation: output.generation,
          size: '15',
          contentType: 'application/json',
        };
      }
      if (argv[1] === 'cp') return null;
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.filter((argv) => argv[1] === 'cp'
    && argv[3] === outputs[firstKey].filePath).length, 0);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
  assert.deepEqual(Object.keys(result.publicReport.collectedEvidence), Object.keys(outputs));
});

test('evidence publication validates explicit receipts and reads back assigned numeric versions', async (t) => {
  assert.equal(validateEvidenceVersionReceipt({
    name: `projects/${PROJECT}/secrets/hkbuddy-v1-llm-smoke/versions/13`,
    state: 'ENABLED',
  }, { secret: 'hkbuddy-v1-llm-smoke', secretVersion: '13' }), true);
  assert.equal(validateEvidenceVersionReceipt({
    name: `projects/${PROJECT_NUMBER}/secrets/hkbuddy-v1-llm-smoke/versions/13`,
    state: 'ENABLED',
  }, { secret: 'hkbuddy-v1-llm-smoke', secretVersion: '13' }), true);
  assert.throws(() => validateEvidenceVersionReceipt({
    name: `projects/${PROJECT}/secrets/hkbuddy-v1-llm-smoke/versions/14`,
    state: 'ENABLED',
  }, { secret: 'hkbuddy-v1-llm-smoke', secretVersion: '13' }), /evidence version/i);
  assert.throws(() => validateEvidenceVersionReceipt({
    name: 'projects/999999999999/secrets/hkbuddy-v1-llm-smoke/versions/13',
    state: 'ENABLED',
  }, { secret: 'hkbuddy-v1-llm-smoke', secretVersion: '13' }), /evidence version/i);

  const input = await materializedReleaseEvidenceInput(t);
  const versionsBySecret = Object.fromEntries(Object.values(input.evidence).map((value) => (
    [value.secret, value.secretVersion]
  )));
  const evidenceCalls = [];
  const publishedBySecret = new Map();
  const executor = async (argv, { stdin } = {}) => {
    evidenceCalls.push(argv);
    if (argv[0] === 'storage') {
      return argv[1] === 'objects' && argv[2] === 'list' ? [] : { done: true };
    }
    const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
    const secret = isPublish
      ? argv[3]
      : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
    if (isPublish) publishedBySecret.set(secret, Buffer.from(stdin));
    if (argv[2] === 'access') return publishedBySecret.get(secret).toString('base64url');
    const version = isPublish ? versionsBySecret[secret] : argv[3];
    return { name: `projects/${PROJECT_NUMBER}/secrets/${secret}/versions/${version}`, state: 'ENABLED' };
  };
  const inventory = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: executor,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(inventory.exitCode, 0);
  assert.deepEqual(inventory.publicReport.evidenceSecretVersions, { legacyInventory: '11' });

  const accepted = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input, executor,
    execute: executor,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(accepted.exitCode, 0);
  assert.deepEqual(accepted.publicReport.evidenceSecretVersions, Object.fromEntries(
    Object.entries(EVIDENCE).filter(([key]) => key !== 'legacyInventory')
      .map(([key, value]) => [key, value.secretVersion]),
  ));
  for (const output of Object.values(ACCEPTANCE_OUTPUTS)) {
    const deletion = evidenceCalls.findIndex((argv) => argv[0] === 'storage'
      && argv[1] === 'rm'
      && argv[2] === `gs://${output.bucket}/${output.object}#${output.generation}`);
    const absence = evidenceCalls.findIndex((argv, index) => index > deletion
      && argv[0] === 'storage' && argv[1] === 'objects' && argv[2] === 'list'
      && argv[3] === `gs://${output.bucket}/${output.object}`);
    assert.notEqual(deletion, -1);
    assert.notEqual(absence, -1);
    const nextDeletion = evidenceCalls.findIndex((argv, index) => index > deletion
      && argv[0] === 'storage' && argv[1] === 'rm');
    assert.equal(nextDeletion === -1 || absence < nextDeletion, true);
  }

  const mismatched = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    execute: async (argv) => {
      if (argv[2] === 'add') return {
        name: `projects/${PROJECT}/secrets/${argv[3]}/versions/99`, state: 'ENABLED',
      };
      throw new Error('must stop before readback');
    },
    writeOutput: () => undefined,
  });
  assert.equal(mismatched.exitCode, 1);
  assert.equal(mismatched.publicReport.mutationPerformed, true);
});

test('evidence publication binds arbitrary assigned versions through readback, journal, and receipt', async (t) => {
  const materialized = await materializedReleaseEvidenceInput(t);
  const input = {
    ...materialized,
    evidence: Object.fromEntries(Object.entries(materialized.evidence).map(([key, value]) => [
      key,
      key === 'legacyInventory' ? value : { ...value, secretVersion: null },
    ])),
  };
  const assignedVersions = {
    dependencyAcceptance: '101',
    llmSmoke: '203',
    asrSmoke: '305',
    ttsSmoke: '407',
    iosVoiceAcceptance: '509',
  };
  const assignedBySecret = Object.fromEntries(Object.entries(assignedVersions).map(([key, version]) => (
    [input.evidence[key].secret, version]
  )));
  const publishedBySecret = new Map();
  const calls = [];
  const store = createTestStateStore();
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    persistReceipt: async (_plan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    execute: async (argv, { stdin } = {}) => {
      calls.push([...argv]);
      if (argv[0] === 'storage') {
        return argv[1] === 'objects' && argv[2] === 'list' ? [] : { done: true };
      }
      const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
      const secret = isPublish
        ? argv[3]
        : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
      const assignedVersion = assignedBySecret[secret];
      assert.equal(typeof assignedVersion, 'string');
      if (isPublish) {
        publishedBySecret.set(secret, Buffer.from(stdin));
        return {
          name: `projects/${PROJECT_NUMBER}/secrets/${secret}/versions/${assignedVersion}`,
          state: 'ENABLED',
        };
      }
      assert.equal(argv[3], assignedVersion, `${argv[2]} must use the version returned by add`);
      if (argv[2] === 'access') return publishedBySecret.get(secret).toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${secret}/versions/${assignedVersion}`,
        state: 'ENABLED',
      };
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.deepEqual(result.publicReport.evidenceSecretVersions, assignedVersions);
  assert.deepEqual(persisted.outputs.evidenceSecretVersions, {
    legacyInventory: input.evidence.legacyInventory.secretVersion,
    ...assignedVersions,
  });
  const publicationCheckpoints = store.records.filter((record) => (
    record.recordType === 'checkpoint' && record.operationId.startsWith('evidence-publish:')
  ));
  assert.deepEqual(Object.fromEntries(publicationCheckpoints.map((record) => [
    record.operationId.slice(record.operationId.indexOf(':') + 1),
    record.payload.safeResult.version,
  ])), assignedVersions);

  const resolvedInput = {
    ...input,
    evidence: Object.fromEntries(Object.entries(input.evidence).map(([key, value]) => [
      key,
      key === 'legacyInventory' ? value : { ...value, secretVersion: assignedVersions[key] },
    ])),
  };
  const resolvedPlan = buildReleasePlan(resolvedInput, { phase: 'candidate' });
  const priorReceipts = fixtureReceiptChain(resolvedPlan, 'collect');
  assert.equal(validateReleaseReceiptChain(
    [...priorReceipts, persisted], resolvedPlan, { through: 'evidence' },
  ), true);
  assert.equal(calls.some((argv) => argv.includes('latest')), false);
});

test('inventory publication resolves its server-assigned version before acceptance', async (t) => {
  const materialized = await materializedReleaseEvidenceInput(t);
  const input = releaseInput({
    legacyInventory: { ...materialized.legacyInventory, secretVersion: null },
    evidence: null,
    acceptanceOutputs: null,
  });
  const store = createTestStateStore();
  let persisted = null;
  let publishedBytes = null;
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    persistReceipt: async (_plan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    verifyEvidence: undefined,
    execute: async (argv, { stdin } = {}) => {
      calls.push([...argv]);
      if (argv[2] === 'add') {
        publishedBytes = Buffer.from(stdin);
        return {
          name: `projects/${PROJECT_NUMBER}/secrets/${materialized.legacyInventory.secret}/versions/87`,
          state: 'ENABLED',
        };
      }
      assert.equal(argv[3], '87');
      if (argv[2] === 'access') return publishedBytes.toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${materialized.legacyInventory.secret}/versions/87`,
        state: 'ENABLED',
      };
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.deepEqual(result.publicReport.evidenceSecretVersions, { legacyInventory: '87' });
  assert.deepEqual(persisted.outputs.evidenceSecretVersions, { legacyInventory: '87' });
  const checkpoint = store.records.find((record) => (
    record.recordType === 'checkpoint' && record.operationId === 'inventory-publish:legacyInventory'
  ));
  assert.equal(checkpoint.payload.safeResult.version, '87');
});

test('inventory receipt-written terminal-missing restart recovers the assigned version before receipt validation', async (t) => {
  const materialized = await materializedReleaseEvidenceInput(t);
  const input = releaseInput({
    legacyInventory: { ...materialized.legacyInventory, secretVersion: null },
    evidence: null,
    acceptanceOutputs: null,
  });
  const store = createTestStateStore();
  const appendTerminal = store.appendTerminal;
  let publishedBytes = null;
  let persisted = null;
  store.appendTerminal = async () => { throw new Error('simulated terminal write loss'); };
  const first = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    persistReceipt: async (_plan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    verifyEvidence: undefined,
    execute: async (argv, { stdin } = {}) => {
      if (argv[2] === 'add') {
        publishedBytes = Buffer.from(stdin);
        return {
          name: `projects/${PROJECT_NUMBER}/secrets/${materialized.legacyInventory.secret}/versions/87`,
          state: 'ENABLED',
        };
      }
      assert.equal(argv[3], '87');
      if (argv[2] === 'access') return publishedBytes.toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${materialized.legacyInventory.secret}/versions/87`,
        state: 'ENABLED',
      };
    },
    writeOutput: () => undefined,
  });
  assert.equal(first.exitCode, 1);
  assert.equal(first.publicReport.code, 'RELEASE_JOURNAL_WRITE_FAILED');
  assert.equal(persisted.outputs.evidenceSecretVersions.legacyInventory, '87');

  store.appendTerminal = appendTerminal;
  const calls = [];
  let recoveryCalls = 0;
  const recovered = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => structuredClone(persisted),
    recoverTerminal: async ({ receipt, terminalState, appendTerminal: append }) => {
      recoveryCalls += 1;
      return append({
        status: 'phase-complete',
        checkpointRecordSha256: store.records.at(-1).recordSha256,
        receiptSha256: receipt.receiptSha256,
        terminalState,
        mutationCount: 1,
        responseLossOperationIds: [],
      });
    },
    execute: async (argv) => {
      calls.push([...argv]);
      assert.deepEqual(argv.slice(0, 3), ['secrets', 'versions', argv[2]]);
      assert.equal(argv[3], '87');
      if (argv[2] === 'access') return publishedBytes.toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${materialized.legacyInventory.secret}/versions/87`,
        state: 'ENABLED',
      };
    },
    persistReceipt: async () => { throw new Error('receipt recovery must not rewrite receipt'); },
    writeOutput: () => undefined,
  });

  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.publicReport));
  assert.equal(recovered.publicReport.recoveredTerminal, true);
  assert.equal(recovered.publicReport.mutationPerformed, false);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(calls.map((argv) => argv[2]), ['describe', 'access']);
  assert.equal(calls.some((argv) => argv[2] === 'add' || argv.includes('latest')), false);
});

test('evidence receipt-written terminal-missing restart recovers every assigned version before receipt validation', async (t) => {
  const materialized = await materializedReleaseEvidenceInput(t);
  const input = {
    ...materialized,
    evidence: Object.fromEntries(Object.entries(materialized.evidence).map(([key, value]) => [
      key,
      key === 'legacyInventory' ? value : { ...value, secretVersion: null },
    ])),
  };
  const assignedVersions = {
    dependencyAcceptance: '101',
    llmSmoke: '203',
    asrSmoke: '305',
    ttsSmoke: '407',
    iosVoiceAcceptance: '509',
  };
  const assignedBySecret = Object.fromEntries(Object.entries(assignedVersions).map(([key, version]) => (
    [input.evidence[key].secret, version]
  )));
  const publishedBySecret = new Map();
  const store = createTestStateStore();
  const appendTerminal = store.appendTerminal;
  let persisted = null;
  store.appendTerminal = async () => { throw new Error('simulated terminal write loss'); };
  const first = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    persistReceipt: async (_plan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    execute: async (argv, { stdin } = {}) => {
      if (argv[0] === 'storage') {
        return argv[1] === 'objects' && argv[2] === 'list' ? [] : null;
      }
      const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
      const secret = isPublish
        ? argv[3]
        : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
      const assignedVersion = assignedBySecret[secret];
      if (isPublish) {
        publishedBySecret.set(secret, Buffer.from(stdin));
        return {
          name: `projects/${PROJECT_NUMBER}/secrets/${secret}/versions/${assignedVersion}`,
          state: 'ENABLED',
        };
      }
      assert.equal(argv[3], assignedVersion);
      if (argv[2] === 'access') return publishedBySecret.get(secret).toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${secret}/versions/${assignedVersion}`,
        state: 'ENABLED',
      };
    },
    writeOutput: () => undefined,
  });
  assert.equal(first.exitCode, 1);
  assert.equal(first.publicReport.code, 'RELEASE_JOURNAL_WRITE_FAILED');
  assert.deepEqual(persisted.outputs.evidenceSecretVersions, {
    legacyInventory: input.evidence.legacyInventory.secretVersion,
    ...assignedVersions,
  });

  store.appendTerminal = appendTerminal;
  const calls = [];
  let recoveryCalls = 0;
  const recovered = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => structuredClone(persisted),
    recoverTerminal: async ({ receipt, terminalState, appendTerminal: append }) => {
      recoveryCalls += 1;
      return append({
        status: 'phase-complete',
        checkpointRecordSha256: store.records.at(-1).recordSha256,
        receiptSha256: receipt.receiptSha256,
        terminalState,
        mutationCount: 9,
        responseLossOperationIds: [],
      });
    },
    execute: async (argv) => {
      calls.push([...argv]);
      assert.equal(argv[0], 'secrets');
      assert.notEqual(argv[2], 'add');
      const secret = argv.find((value) => value.startsWith('--secret='))
        .slice('--secret='.length);
      const assignedVersion = assignedBySecret[secret];
      assert.equal(argv[3], assignedVersion);
      if (argv[2] === 'access') return publishedBySecret.get(secret).toString('base64url');
      return {
        name: `projects/${PROJECT}/secrets/${secret}/versions/${assignedVersion}`,
        state: 'ENABLED',
      };
    },
    persistReceipt: async () => { throw new Error('receipt recovery must not rewrite receipt'); },
    writeOutput: () => undefined,
  });

  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.publicReport));
  assert.equal(recovered.publicReport.recoveredTerminal, true);
  assert.equal(recovered.publicReport.mutationPerformed, false);
  assert.equal(recoveryCalls, 1);
  assert.equal(calls.length, 10);
  assert.equal(calls.some((argv) => argv[2] === 'add' || argv.includes('latest')), false);
});

test('evidence publication restart with only an intent fails closed without guessing a version', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const plan = buildReleasePlan(input, { phase: 'evidence' });
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'evidence-publish:dependencyAcceptance',
    mutationOrdinal: 1,
    reconcileKind: 'secret-version-add',
    plan,
  });
  store.appendIntent = async () => { throw new Error('restart must not add another version'); };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    execute: async (argv) => {
      calls.push(argv);
      throw new Error('uncheckpointed Secret version has no authoritative correlation');
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('evidence deletion restart proves exact object absence before advancing without a duplicate delete', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  const assignedVersions = {
    dependencyAcceptance: '101',
    llmSmoke: '203',
    asrSmoke: '305',
    ttsSmoke: '407',
    iosVoiceAcceptance: '509',
  };
  const publishIds = plan.operations
    .filter(({ phase, id }) => phase === 'evidence' && id.startsWith('evidence-publish:'))
    .map(({ id }) => id);
  let ordinal = 0;
  for (const operationId of publishIds) {
    ordinal += 1;
    await appendTestMutationCheckpoint(store, {
      operationId, mutationOrdinal: ordinal, reconcileKind: 'secret-version-add',
      plan,
      safeResult: secretVersionSafeResult(
        plan.evidence[operationId.slice(operationId.indexOf(':') + 1)],
        assignedVersions[operationId.slice(operationId.indexOf(':') + 1)],
      ),
    });
  }
  const firstKey = Object.keys(ACCEPTANCE_OUTPUTS)[0];
  ordinal += 1;
  await appendTestMutationIntent(store, {
    operationId: `evidence-output-delete:${firstKey}`,
    mutationOrdinal: ordinal,
    reconcileKind: 'gcs-object-delete',
    plan,
  });
  const appendIntent = store.appendIntent;
  store.appendIntent = async (payload, options) => {
    assert.notEqual(options?.operationId, `evidence-output-delete:${firstKey}`);
    return appendIntent(payload, options);
  };
  const checkpoints = [];
  const appendCheckpoint = store.appendCheckpoint;
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'storage') {
        if (argv[1] === 'objects' && argv[2] === 'list') return [];
        if (argv[1] === 'rm') return null;
      }
      if (argv[0] === 'secrets') {
        if (argv[2] === 'add') throw new Error('restart must not add another version');
        const secret = argv.find((value) => value.startsWith('--secret='))
          ?.slice('--secret='.length);
        const expected = Object.values(input.evidence).find((value) => value.secret === secret);
        if (argv[2] === 'access') {
          return (await readFile(expected.filePath)).toString('base64url');
        }
        const version = argv[3];
        return {
          name: `projects/${PROJECT}/secrets/${secret}/versions/${version}`,
          state: 'ENABLED',
        };
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  const firstOutput = ACCEPTANCE_OUTPUTS[firstKey];
  assert.equal(calls.some((argv) => argv[0] === 'storage' && argv[1] === 'rm'
    && argv[2] === `gs://${firstOutput.bucket}/${firstOutput.object}#${firstOutput.generation}`), false);
  assert.equal(calls.filter((argv) => argv[0] === 'storage' && argv[1] === 'objects'
    && argv[2] === 'list'
    && argv[3] === `gs://${firstOutput.bucket}/${firstOutput.object}`).length, 2);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
});

test('inventory publication restart with only an intent fails closed without guessing a version', async (t) => {
  const materialized = await materializedReleaseEvidenceInput(t);
  const input = releaseInput({
    legacyInventory: { ...materialized.legacyInventory, secretVersion: null },
    evidence: null,
    acceptanceOutputs: null,
  });
  const plan = buildReleasePlan(input, { phase: 'inventory' });
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'inventory-publish:legacyInventory',
    mutationOrdinal: 1,
    reconcileKind: 'secret-version-add',
    plan,
  });
  store.appendIntent = async () => { throw new Error('restart must not add another version'); };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    execute: async (argv) => {
      calls.push(argv);
      throw new Error('uncheckpointed Secret version has no authoritative correlation');
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('build receipt captures one successful verified build, source hash, and final image digest', () => {
  const build = exactCloudBuildReceipt();
  const receipt = validateBuildReceipt(build, {
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  });

  assert.deepEqual({ ...receipt, buildReceiptSha256: '<sha256>' }, {
    buildConfigSha256: BUILD_CONFIG_SHA,
    buildId: BUILD_ID,
    buildReceiptSha256: '<sha256>',
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    sourceProvenance: {
      uri: 'gs://hkbuddy-v1-582852715831-build-source/source/source.tgz#123', sha256: SOURCE_SHA,
    },
    imageDigest: IMAGE_DIGEST,
    provenance: 'VERIFIED',
    ociLabels: {
      'com.simplify.build-config-sha256': BUILD_CONFIG_SHA,
      'com.simplify.source-archive-sha256': SOURCE_SHA,
      'org.opencontainers.image.revision': RELEASE_SHA,
      'org.opencontainers.image.source': 'https://github.com/jimmy00415/Cantonese_Learning_Full_stack',
    },
  });
  assert.match(receipt.buildReceiptSha256, /^[0-9a-f]{64}$/);

  const sdkObserved = structuredClone(build);
  Object.assign(sdkObserved, {
    artifacts: { images: [...build.images] },
    createTime: '2026-08-26T01:00:00.123456Z',
    startTime: '2026-08-26T01:00:01.123456Z',
    finishTime: '2026-08-26T01:01:01.123456Z',
    name: `projects/${PROJECT_NUMBER}/locations/${REGION}/builds/${BUILD_ID}`,
    logUrl: `https://console.cloud.google.com/cloud-build/builds;region=${REGION}/${BUILD_ID}?project=${PROJECT}`,
    queueTtl: '3600s',
    timing: {
      BUILD: { startTime: '2026-08-26T01:00:01.123456Z', endTime: '2026-08-26T01:01:00.123456Z' },
      FETCHSOURCE: { startTime: '2026-08-26T01:00:00.123456Z', endTime: '2026-08-26T01:00:01.123456Z' },
      PUSH: { startTime: '2026-08-26T01:01:00.123456Z', endTime: '2026-08-26T01:01:01.123456Z' },
      SETUPBUILD: { startTime: '2026-08-26T01:00:01.000000Z', endTime: '2026-08-26T01:00:01.123456Z' },
      STORAGE_SOURCE: { startTime: '2026-08-26T01:00:00.123456Z', endTime: '2026-08-26T01:00:01.123456Z' },
    },
  });
  sdkObserved.steps = sdkObserved.steps.map((step, index) => ({
    ...step,
    pullTiming: {
      startTime: `2026-08-26T01:00:0${index}.000000Z`,
      endTime: `2026-08-26T01:00:0${index}.100000Z`,
    },
    timing: {
      startTime: `2026-08-26T01:00:0${index}.100000Z`,
      endTime: `2026-08-26T01:00:0${index}.900000Z`,
    },
  }));
  sdkObserved.results.images[0].pushTiming = {
    startTime: '2026-08-26T01:01:00.123456Z',
    endTime: '2026-08-26T01:01:01.123456Z',
  };
  sdkObserved.options.pool = {};
  const sdkSourceUri = Object.keys(sdkObserved.sourceProvenance.fileHashes)[0];
  sdkObserved.sourceProvenance.fileHashes[sdkSourceUri].fileHash.push({
    type: 'MD5',
    value: 'VK3mYmoHJY_f-ksa5llUWA==',
  });
  sdkObserved.results.buildStepOutputs = sdkObserved.steps.map(() => '');
  sdkObserved.results.buildStepResults = Object.fromEntries(
    sdkObserved.steps.map(({ id }) => [id, {}]),
  );
  const sdkReceipt = validateBuildReceipt(sdkObserved, {
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  });
  assert.equal(sdkReceipt.buildReceiptSha256, receipt.buildReceiptSha256);

  const urlSafeSourceSha = 'f5fd199d013332165346b8bf3e13f702ac4b3ce4e267d365713f147f8d2db708';
  const urlSafeObserved = JSON.parse(JSON.stringify(build).replaceAll(SOURCE_SHA, urlSafeSourceSha));
  const urlSafeSourceUri = Object.keys(urlSafeObserved.sourceProvenance.fileHashes)[0];
  urlSafeObserved.sourceProvenance.fileHashes[urlSafeSourceUri].fileHash[0].value = Buffer
    .from(urlSafeSourceSha, 'hex').toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  assert.doesNotThrow(() => validateBuildReceipt(urlSafeObserved, {
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: urlSafeSourceSha,
    buildConfigSha256: BUILD_CONFIG_SHA,
  }));

  const invalidReceipts = [
    (value) => { delete value.name; },
    (value) => { value.name = `projects/999999999999/locations/${REGION}/builds/${BUILD_ID}`; },
    (value) => { value.projectId = 'foreign-project'; },
    (value) => { value.timeout = '1201s'; },
    (value) => { value.substitutions.EXTRA = 'drift'; },
    (value) => { value.substitutions._BUILD_CONFIG_SHA256 = 'f'.repeat(64); },
    (value) => { value.options.workerPool = 'projects/foreign/workerPools/pool'; },
    (value) => { value.options.pool = { name: 'projects/foreign/workerPools/pool' }; },
    (value) => { value.steps[0].name = 'node:latest'; },
    (value) => { value.steps[1].status = 'FAILURE'; },
    (value) => { value.steps[2].args.push('--secret=forbidden'); },
    (value) => { value.steps[3].secretEnv = ['TOKEN']; },
    (value) => { value.steps.reverse(); },
    (value) => { value.source.storageSource.generation = '124'; },
    (value) => { value.sourceProvenance.fileHashes.extra = { fileHash: [] }; },
    (value) => { value.results.buildStepImages.pop(); },
    (value) => { value.results.buildStepOutputs = ['', '', '', '', 'smuggled']; },
    (value) => {
      value.results.buildStepResults = Object.fromEntries(
        value.steps.map(({ id }) => [id, id === 'build' ? { unexpected: true } : {}]),
      );
    },
    (value) => { value.results.images[0].name = `${value.results.images[0].name}-foreign`; },
    (value) => { delete value.results.images[0].artifactRegistryPackage; },
    (value) => { value.results.images[0].artifactRegistryPackage = value.results.images[0].artifactRegistryPackage.replace('/hkbuddy-v1/', '/foreign/'); },
    (value) => { value.results.images[0].pushTiming = { recipe: 'smuggled' }; },
    (value) => { value.results.images[0].status = 'SUCCESS'; },
    (value) => { value.approval = { result: 'APPROVED' }; },
    (value) => { value.artifacts = { images: ['foreign-image'] }; },
    (value) => { value.queueTtl = '3601s'; },
    (value) => { value.warning = [{ priority: 'INFO' }]; },
    (value) => { value.warnings = [{ priority: 'INFO' }]; },
    (value) => { value.createTime = 'not-rfc3339'; },
    (value) => { value.steps[0].timing = { recipe: 'smuggled' }; },
    (value) => {
      value.timing = {
        FETCHSOURCE: { startTime: '2026-08-26T01:00:00.123456Z', endTime: '2026-08-26T01:00:01.123456Z' },
        STORAGE_SOURCE: { startTime: '2026-08-26T01:00:00.123456Z', endTime: '2026-08-26T01:00:02.123456Z' },
      };
    },
  ];
  for (const mutate of invalidReceipts) {
    const changed = structuredClone(build);
    mutate(changed);
    assert.throws(() => validateBuildReceipt(changed, {
      releaseSha: RELEASE_SHA,
      sourceArchiveSha256: SOURCE_SHA,
      buildConfigSha256: BUILD_CONFIG_SHA,
    }), /Cloud Build receipt/i);
  }
  for (const mutate of [
    (value) => { value.sourceProvenance.fileHashes[sdkSourceUri].fileHash[1].value = 'not-base64'; },
    (value) => { value.sourceProvenance.fileHashes[sdkSourceUri].fileHash[1].type = 'SHA512'; },
    (value) => { value.sourceProvenance.fileHashes[sdkSourceUri].fileHash.push({ ...value.sourceProvenance.fileHashes[sdkSourceUri].fileHash[1] }); },
  ]) {
    const changed = structuredClone(sdkObserved);
    mutate(changed);
    assert.throws(() => validateBuildReceipt(changed, {
      releaseSha: RELEASE_SHA,
      sourceArchiveSha256: SOURCE_SHA,
      buildConfigSha256: BUILD_CONFIG_SHA,
    }), /Cloud Build receipt/i);
  }
  assert.throws(() => validateBuildReceipt({ ...receipt, status: 'SUCCESS' }, {
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  }), /build receipt/i);

  const calls = [];
  let configChecks = 0;
  return runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    execute: async (argv) => {
      calls.push(argv);
      return structuredClone(build);
    },
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => { configChecks += 1; return true; },
    writeOutput: () => undefined,
  }).then((result) => {
    assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
    assert.deepEqual(result.publicReport.buildReceipt, receipt);
    assert.equal(configChecks, 2);
    assert.deepEqual(calls[1], [
      'builds', 'describe', BUILD_ID,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]);
    assert.equal(calls.flat().includes('list'), false);
    return runGcpRelease({
      argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
      input: releaseInput({ imageDigest: null }),
      execute: async () => { throw new Error('candidate must remain inert'); },
      writeOutput: () => undefined,
    });
  }).then((result) => {
    assert.equal(result.exitCode, 2);
    assert.equal(result.publicReport.code, 'RELEASE_CONTRACT_INVALID');
  });
});

test('Cloud Build submit response loss is ambiguous and never searches or adopts a build', async () => {
  const calls = [];
  let configChecks = 0;
  const result = await runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      imageDigest: null,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
      previousImageDigest: null,
    }),
    execute: async (argv) => {
      calls.push(argv);
      throw new Error('submit response lost before a validated build id');
    },
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => { configChecks += 1; return true; },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.deepEqual(calls.map((argv) => argv.slice(0, 2)), [['builds', 'submit']]);
  assert.equal(calls.flat().includes('list'), false);
  assert.equal(calls.flat().includes('describe'), false);
  assert.equal(configChecks, 2);
});

test('Cloud Build restart with only an open intent is fail-closed and never resubmits', async () => {
  const store = createTestStateStore();
  await store.appendIntent({
    mutationOrdinal: 1,
    operationAttemptId: '1'.repeat(32),
    commandSha256: '2'.repeat(64),
    reconcileKind: 'cloud-build-submit',
    beforeSha256: '3'.repeat(64),
    afterSha256: '4'.repeat(64),
  }, { operationId: 'build-submit' });
  store.appendIntent = async () => { throw new Error('restart must not append intent'); };
  let executorCalls = 0;
  const result = await runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => true,
    openStateStore: async () => store,
    execute: async () => { executorCalls += 1; throw new Error('must not resubmit build'); },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(executorCalls, 0);
  assert.equal(store.records.at(-1).recordType, 'intent');
});

test('confirmed release cannot call a mutation executor before its intent is durable', async () => {
  const calls = [];
  let closed = false;
  const result = await runGcpReleaseImpl({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      imageDigest: null,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
      previousImageDigest: null,
    }),
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => true,
    openStateStore: async () => ({
      records: [],
      appendIntent: async () => { throw new Error('journal disk unavailable'); },
      appendCheckpoint: async () => { throw new Error('must not checkpoint'); },
      appendTerminal: async () => { throw new Error('must not terminate'); },
      close: async () => { closed = true; },
    }),
    execute: async (argv) => { calls.push(argv); return exactCloudBuildReceipt(); },
    persistReceipt: async () => true,
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_JOURNAL_WRITE_FAILED');
  assert.deepEqual(calls, []);
  assert.equal(closed, true);
});

test('build checkpoint follows authoritative describe and receipt precedes terminal', async () => {
  const events = [];
  let intentPayload = null;
  let checkpointPayload = null;
  const store = createTestStateStore();
  const appendIntent = store.appendIntent;
  const appendCheckpoint = store.appendCheckpoint;
  const appendTerminal = store.appendTerminal;
  store.appendIntent = async (...args) => {
    events.push('intent');
    [intentPayload] = structuredClone(args);
    return appendIntent(...args);
  };
  store.appendCheckpoint = async (...args) => {
    events.push('checkpoint');
    [checkpointPayload] = structuredClone(args);
    return appendCheckpoint(...args);
  };
  store.appendTerminal = async (...args) => {
    events.push('terminal');
    return appendTerminal(...args);
  };
  const buildInput = releaseInput({
    imageDigest: null,
    databaseSecretVersions: null,
    evidence: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  const result = await runGcpReleaseImpl({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: buildInput,
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => true,
    openStateStore: async () => store,
    journalAttemptId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    execute: async (argv) => {
      events.push(argv[1] === 'submit' ? 'submit' : 'describe');
      return exactCloudBuildReceipt();
    },
    persistReceipt: async () => { events.push('receipt'); return true; },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.deepEqual(events, [
    'intent', 'submit', 'describe', 'checkpoint', 'receipt', 'terminal',
  ]);
  const normalized = validateBuildReceipt(exactCloudBuildReceipt(), {
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  });
  assert.deepEqual(checkpointPayload.safeResult, {
    kind: 'build', buildId: BUILD_ID, receiptSha256: normalized.buildReceiptSha256,
  });
  assert.equal(checkpointPayload.observationSha256, intentPayload.afterSha256);
  const buildPlan = buildReleasePlan(buildInput, { phase: 'build' });
  const buildMutation = buildPlan.operations.find(({ id }) => id === 'build-submit');
  assert.deepEqual(releaseMutationPlanIdentity(buildPlan, buildMutation).expectedAfter.observation, {
    buildConfigSha256: BUILD_CONFIG_SHA,
    image: `asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy-v1/hkbuddy-v1-api:${RELEASE_SHA}`,
    kind: 'cloud-build',
    ociLabels: normalized.ociLabels,
    provenance: 'VERIFIED',
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
  });
  for (const state of ['before', 'after']) {
    const syntheticMarkerSha256 = createHash('sha256').update(JSON.stringify(canonicalFixture({
      operationId: 'build-submit',
      phase: 'build',
      releaseIdentitySha256: buildReleasePlan(buildInput, { phase: 'build' }).releaseIdentitySha256,
      state,
    }))).digest('hex');
    assert.notEqual(intentPayload[`${state}Sha256`], syntheticMarkerSha256);
  }
});

test('build readAfter must be present and exact before an observation checkpoint is written', async () => {
  const buildInput = releaseInput({
    imageDigest: null,
    databaseSecretVersions: null,
    evidence: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  for (const describeResult of [
    undefined,
    (() => {
      const changed = exactCloudBuildReceipt();
      changed.results.images[0].digest = `sha256:${'9'.repeat(64)}`;
      return changed;
    })(),
  ]) {
    const store = createTestStateStore();
    let call = 0;
    const result = await runGcpReleaseImpl({
      argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
      input: buildInput,
      verifySourceArchive: async () => true,
      verifyBuildConfig: async () => true,
      openStateStore: async () => store,
      execute: async () => {
        call += 1;
        return call === 1 ? exactCloudBuildReceipt() : structuredClone(describeResult);
      },
      persistReceipt: async () => true,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(store.records.some(({ recordType }) => recordType === 'checkpoint'), false);
  }
});

test('one immutable build identity validly precedes resolved migration while migration secret drift stays bound', async () => {
  const common = {
    previousRevision: null,
    previousImageDigest: null,
    evidence: null,
    acceptanceOutputs: null,
  };
  const buildInput = releaseInput({
    ...common,
    imageDigest: null,
    databaseSecretVersions: null,
  });
  const migrationInput = releaseInput(common);
  const buildPlan = buildReleasePlan(buildInput, { phase: 'build' });
  const migrationPlan = buildReleasePlan(migrationInput, { phase: 'migration' });
  assert.equal(buildPlan.releaseIdentitySha256, migrationPlan.releaseIdentitySha256);

  const buildReceipt = finalizeReleasePhaseReceipt({
    schemaVersion: 2,
    phase: 'build',
    sequence: 1,
    releaseSha: buildPlan.releaseSha,
    releaseIdentitySha256: buildPlan.releaseIdentitySha256,
    phaseIdentitySha256: releasePhaseIdentitySha256(buildPlan, 'build'),
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: 'candidate-service-private-100',
    stableTrafficState: buildPlan.expectedStable.initialTrafficState,
    previousReceiptSha256: null,
    completed: buildPlan.operations.filter(({ phase }) => phase === 'build').map(({ id }) => id),
    outputs: fixtureReceiptOutputs(migrationPlan, 'build'),
  });
  const store = createTestStateStore();
  let stateOpened = false;
  let migrationReceipt = null;
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input: migrationInput,
    loadReceipts: async () => [structuredClone(buildReceipt)],
    openStateStore: async () => {
      stateOpened = true;
      return store;
    },
    persistReceipt: async (_plan, receipt) => {
      migrationReceipt = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      if (argv[2] === 'deploy') return { metadata: { name: 'hkbuddy-v1-migrate' } };
      if (argv[2] === 'describe') return realV1JobReadback(migrationPlan.expectedMigrationJob);
      if (argv[2] === 'executions' && argv[3] === 'list') return [];
      if (argv[2] === 'execute') return realV1ExecutionReadback(migrationPlan.expectedMigrationJob);
      if (argv[2] === 'executions' && argv[3] === 'describe') {
        return realV1ExecutionReadback(migrationPlan.expectedMigrationJob);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(stateOpened, true);
  assert.equal(migrationReceipt.phase, 'migration');

  const drifted = buildReleasePlan(releaseInput({
    ...common,
    databaseSecretVersions: { app: '7', migrator: '10', session: '9' },
  }), { phase: 'migration' });
  assert.notEqual(migrationPlan.semanticReleaseSpecSha256, drifted.semanticReleaseSpecSha256);
  assert.notEqual(
    releasePhaseIdentitySha256(migrationPlan, 'migration'),
    releasePhaseIdentitySha256(drifted, 'migration'),
  );
  assert.throws(
    () => validateReleaseReceiptChain([buildReceipt, migrationReceipt], drifted, {
      through: 'migration',
    }),
    /receipt chain/i,
  );
});

test('receipt-before-terminal restart appends only the missing terminal record', async () => {
  const store = createTestStateStore();
  const intent = await store.appendIntent({
    mutationOrdinal: 1,
    operationAttemptId: '1'.repeat(32),
    commandSha256: '2'.repeat(64),
    reconcileKind: 'cloud-build-submit',
    beforeSha256: '3'.repeat(64),
    afterSha256: '4'.repeat(64),
  }, { operationId: 'build-submit' });
  await store.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: 'applied',
    observationSha256: '4'.repeat(64),
    safeResult: { kind: 'none' },
  });
  let terminalAppends = 0;
  const appendTerminal = store.appendTerminal;
  store.appendTerminal = async (payload) => {
    terminalAppends += 1;
    return appendTerminal(payload);
  };
  let recoveryCalls = 0;
  const result = await runGcpReleaseImpl({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => true,
    openStateStore: async () => store,
    loadPhaseReceipt: async (plan) => fixtureReceiptChain(plan, 'build')[0],
    recoverTerminal: async ({ receipt, terminalState, appendTerminal: append }) => {
      recoveryCalls += 1;
      return append({
        status: 'phase-complete',
        checkpointRecordSha256: store.records.at(-1).recordSha256,
        receiptSha256: receipt.receiptSha256,
        terminalState,
        mutationCount: 1,
        responseLossOperationIds: [],
      });
    },
    execute: async () => { throw new Error('receipt recovery must not call GCP'); },
    persistReceipt: async () => { throw new Error('receipt recovery must not rewrite receipt'); },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(result.publicReport.phaseReceipt.phase, 'build');
  assert.equal(recoveryCalls, 1);
  assert.equal(terminalAppends, 1);
});

test('all-checkpoint build restart reconstructs a missing receipt by exact describe and closes terminal', async () => {
  const rawBuild = exactCloudBuildReceipt();
  const normalizedBuild = validateBuildReceipt(rawBuild, {
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  });
  const store = createTestStateStore();
  const intent = await appendTestMutationIntent(store, {
    operationId: 'build-submit',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-build-submit',
  });
  await store.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: 'applied',
    observationSha256: intent.payload.afterSha256,
    safeResult: {
      kind: 'build',
      buildId: normalizedBuild.buildId,
      receiptSha256: normalizedBuild.buildReceiptSha256,
    },
  });
  const calls = [];
  let persisted = null;
  const result = await runGcpReleaseImpl({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({ imageDigest: null }),
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => true,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_plan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      assert.deepEqual(argv.slice(0, 3), ['builds', 'describe', BUILD_ID]);
      return structuredClone(rawBuild);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, 1);
  assert.equal(persisted.phase, 'build');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('all-checkpoint migration restart reconstructs exact Job and execution outputs without mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'migration' });
  const job = realV1JobReadback(plan.expectedMigrationJob);
  const execution = realV1ExecutionReadback(
    plan.expectedMigrationJob, 'hkbuddy-v1-migrate-release-001',
  );
  const store = createTestStateStore();
  await appendTestMutationCheckpoint(store, {
    operationId: 'migration-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace',
    plan,
    safeResult: cloudRunJobSafeResult(plan, 'migration-deploy', job),
  });
  await appendTestMutationCheckpoint(store, {
    operationId: 'migration-execute',
    mutationOrdinal: 2,
    reconcileKind: 'cloud-run-job-execute',
    plan,
    safeResult: {
      kind: 'execution', name: execution.metadata.name, status: 'SUCCEEDED',
    },
  });
  const calls = [];
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'jobs' && argv[2] === 'describe') return structuredClone(job);
      if (argv[2] === 'executions' && argv[3] === 'describe') return structuredClone(execution);
      throw new Error(`recovery attempted a mutation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls.map((argv) => argv.slice(0, 5)), [
    ['run', 'jobs', 'describe', 'hkbuddy-v1-migrate', `--project=${PROJECT}`],
    ['run', 'jobs', 'executions', 'describe', execution.metadata.name],
  ]);
  assert.equal(persisted.outputs.executionName, execution.metadata.name);
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('migration receipt-write crash tolerates only server-managed Job status drift on read-only restart', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'migration' });
  const execution = realV1ExecutionReadback(
    plan.expectedMigrationJob, 'hkbuddy-v1-migrate-release-001',
  );
  const initialJob = realV1JobReadback(plan.expectedMigrationJob);
  initialJob.status = { ...initialJob.status, executionCount: 0 };
  const store = createTestStateStore();
  const first = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async () => { throw new Error('injected receipt write failure'); },
    execute: async (argv) => {
      if (argv[1] === 'jobs' && argv[2] === 'deploy') {
        return { metadata: { name: plan.expectedMigrationJob.job } };
      }
      if (argv[1] === 'jobs' && argv[2] === 'describe') {
        return structuredClone(initialJob);
      }
      if (argv[2] === 'executions' && argv[3] === 'list') return [];
      if (argv[1] === 'jobs' && argv[2] === 'execute') return structuredClone(execution);
      if (argv[2] === 'executions' && argv[3] === 'describe') {
        return structuredClone(execution);
      }
      throw new Error(`unexpected initial migration operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(first.exitCode, 1);
  assert.equal(first.publicReport.code, 'RELEASE_RECEIPT_WRITE_FAILED');
  assert.equal(store.records.filter(({ recordType }) => recordType === 'checkpoint').length, 2);
  assert.equal(store.records.some(({ recordType }) => recordType === 'terminal'), false);

  const currentJob = realV1JobReadback(plan.expectedMigrationJob);
  currentJob.status = {
    ...currentJob.status,
    executionCount: 1,
    latestCreatedExecution: {
      name: execution.metadata.name,
      creationTimestamp: '2026-08-26T07:59:00.000Z',
      completionTimestamp: '2026-08-26T08:00:00.000Z',
    },
  };
  const restartCalls = [];
  let persisted = null;
  const restarted = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      restartCalls.push(argv);
      if (argv[1] === 'jobs' && argv[2] === 'describe') return structuredClone(currentJob);
      if (argv[2] === 'executions' && argv[3] === 'describe') {
        return structuredClone(execution);
      }
      throw new Error(`restart attempted a migration mutation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(restarted.exitCode, 0, JSON.stringify(restarted.publicReport));
  assert.equal(restarted.publicReport.mutationPerformed, false);
  assert.equal(restartCalls.some((argv) => ['deploy', 'execute'].includes(argv[2])), false);
  assert.equal(persisted.phase, 'migration');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('all-checkpoint acceptance restart reconstructs every exact Job execution without mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'acceptance' });
  const store = createTestStateStore();
  const readbacks = new Map();
  let mutationOrdinal = 0;
  for (const [key, expected] of Object.entries(plan.expectedJobs)) {
    const job = realV1JobReadback(expected);
    const execution = realV1ExecutionReadback(expected);
    readbacks.set(expected.job, { execution, job, key });
    mutationOrdinal += 1;
    await appendTestMutationCheckpoint(store, {
      operationId: `${key}-deploy`,
      mutationOrdinal,
      reconcileKind: 'cloud-run-job-replace',
      plan,
      safeResult: cloudRunJobSafeResult(plan, `${key}-deploy`, job),
    });
    mutationOrdinal += 1;
    await appendTestMutationCheckpoint(store, {
      operationId: `${key}-execute`,
      mutationOrdinal,
      reconcileKind: 'cloud-run-job-execute',
      plan,
      safeResult: {
        kind: 'execution', name: execution.metadata.name, status: 'SUCCEEDED',
      },
    });
  }
  const calls = [];
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'jobs' && argv[2] === 'describe') {
        return structuredClone(readbacks.get(argv[3]).job);
      }
      if (argv[2] === 'executions' && argv[3] === 'describe') {
        const match = [...readbacks.values()].find(({ execution }) => (
          execution.metadata.name === argv[4]
        ));
        return structuredClone(match.execution);
      }
      throw new Error(`recovery attempted a mutation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, Object.keys(plan.expectedJobs).length * 2);
  assert.equal(calls.every((argv) => argv[2] === 'describe'
    || (argv[2] === 'executions' && argv[3] === 'describe')), true);
  assert.deepEqual(Object.keys(persisted.outputs.executions), Object.keys(plan.expectedJobs));
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('all-checkpoint inventory restart reconstructs the exact Secret version without adding one', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const plan = buildReleasePlan(input, { phase: 'inventory' });
  const expected = plan.evidence.legacyInventory;
  const store = createTestStateStore();
  await appendTestMutationCheckpoint(store, {
    operationId: 'inventory-publish:legacyInventory',
    mutationOrdinal: 1,
    reconcileKind: 'secret-version-add',
    plan,
    safeResult: secretVersionSafeResult(expected),
  });
  const calls = [];
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      assert.deepEqual(argv.slice(0, 2), ['secrets', 'versions']);
      assert.equal(argv[3], expected.secretVersion);
      if (argv[2] === 'access') {
        return (await readFile(expected.filePath)).toString('base64url');
      }
      assert.equal(argv[2], 'describe');
      return {
        name: `projects/${PROJECT_NUMBER}/secrets/${expected.secret}/versions/${expected.secretVersion}`,
        state: 'ENABLED',
      };
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(persisted.outputs.evidenceSecretVersions, {
    legacyInventory: expected.secretVersion,
  });
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('all-checkpoint evidence restart reconstructs exact Secret versions and deleted object truth', async (t) => {
  const input = await materializedReleaseEvidenceInput(t);
  const plan = buildReleasePlan(input, { phase: 'evidence' });
  const store = createTestStateStore();
  let mutationOrdinal = 0;
  for (const [key, expected] of Object.entries(plan.evidence)) {
    if (key === 'legacyInventory') continue;
    mutationOrdinal += 1;
    await appendTestMutationCheckpoint(store, {
      operationId: `evidence-publish:${key}`,
      mutationOrdinal,
      reconcileKind: 'secret-version-add',
      plan,
      safeResult: secretVersionSafeResult(expected),
    });
  }
  for (const key of Object.keys(plan.acceptanceOutputs)) {
    const operationId = `evidence-output-delete:${key}`;
    const member = plan.operations.find(({ id }) => id === operationId);
    mutationOrdinal += 1;
    await appendTestMutationCheckpoint(store, {
      operationId,
      mutationOrdinal,
      reconcileKind: 'gcs-object-delete',
      plan,
      safeResult: {
        kind: 'resource',
        state: 'absent',
        identitySha256: releaseMutationPlanIdentity(plan, member).specSha256,
        valueSha256: createHash('sha256')
          .update(JSON.stringify(canonicalFixture({
            bucket: plan.acceptanceOutputs[key].bucket,
            generation: plan.acceptanceOutputs[key].generation,
            kind: 'gcs-object-absence',
            object: plan.acceptanceOutputs[key].object,
            state: 'absent',
          }))).digest('hex'),
      },
    });
  }
  const calls = [];
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    verifyEvidence: undefined,
    now: () => new Date('2026-08-29T08:00:00.000Z'),
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'secrets' && argv[2] === 'describe') {
        const secret = argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
        return {
          name: `projects/${PROJECT}/secrets/${secret}/versions/${argv[3]}`,
          state: 'ENABLED',
        };
      }
      if (argv[0] === 'secrets' && argv[2] === 'access') {
        const secret = argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
        const expected = Object.values(input.evidence).find((value) => value.secret === secret);
        return (await readFile(expected.filePath)).toString('base64url');
      }
      if (argv[0] === 'storage' && argv[1] === 'objects' && argv[2] === 'list') return [];
      throw new Error(`recovery attempted a mutation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.every((argv) => ['access', 'describe', 'list'].includes(argv[2])), true);
  assert.equal(calls.filter((argv) => argv[0] === 'storage').length,
    Object.keys(plan.acceptanceOutputs).length + 1);
  assert.equal(persisted.outputs.outputResidueCount, 0);
  assert.deepEqual(persisted.outputs.evidenceSecretVersions,
    Object.fromEntries(Object.entries(plan.evidence).map(([key, value]) => [
      key, value.secretVersion,
    ])));
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('all-checkpoint collect restart reconstructs generation-bound local evidence without copying', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-collect-receipt-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputs = Object.fromEntries(Object.entries(ACCEPTANCE_OUTPUTS).map(([key, value]) => [
    key, { ...value, filePath: join(directory, `${key}.json`) },
  ]));
  const inspected = {};
  for (const [key, output] of Object.entries(outputs)) {
    const contents = `controlled-${key}`;
    await writeFile(output.filePath, contents, { flag: 'wx' });
    inspected[key] = {
      artifactSha256: createHash('sha256').update(`artifact:${key}`).digest('hex'),
      objectSha256: createHash('sha256').update(contents).digest('hex'),
      byteLength: Buffer.byteLength(contents),
    };
  }
  const input = releaseInput({
    acceptanceOutputs: outputs,
    databaseSecretVersions: null,
    evidence: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'collect' });
  const store = createTestStateStore();
  let mutationOrdinal = 0;
  for (const [key, output] of Object.entries(plan.acceptanceOutputs)) {
    mutationOrdinal += 1;
    await appendTestMutationCheckpoint(store, {
      operationId: `evidence-collect-copy:${key}`,
      mutationOrdinal,
      reconcileKind: 'gcs-object-write',
      plan,
      safeResult: {
        kind: 'object',
        bucketSha256: createHash('sha256')
          .update(JSON.stringify(canonicalFixture(output.bucket))).digest('hex'),
        objectSha256: createHash('sha256')
          .update(JSON.stringify(canonicalFixture(output.object))).digest('hex'),
        generation: output.generation,
        valueSha256: createHash('sha256')
          .update(JSON.stringify(canonicalFixture(inspected[key]))).digest('hex'),
      },
    });
  }
  const calls = [];
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=collect', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    inspectCollected: async (filePath) => {
      const key = Object.keys(outputs).find((candidate) => outputs[candidate].filePath === filePath);
      return structuredClone(inspected[key]);
    },
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] !== 'objects' || argv[2] !== 'describe') {
        throw new Error(`recovery attempted a mutation: ${argv.join(' ')}`);
      }
      const [key, output] = Object.entries(outputs).find(([, value]) => (
        argv[3] === `gs://${value.bucket}/${value.object}#${value.generation}`
      ));
      return {
        bucket: output.bucket,
        name: output.object,
        generation: output.generation,
        size: String(inspected[key].byteLength),
        contentType: 'application/json',
      };
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, Object.keys(outputs).length);
  assert.equal(calls.some((argv) => argv[1] === 'cp'), false);
  assert.deepEqual(persisted.outputs.evidence,
    Object.fromEntries(Object.entries(inspected).map(([key, value]) => [key, {
      artifactSha256: value.artifactSha256,
      objectSha256: value.objectSha256,
    }])));
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('all-checkpoint candidate restart reconstructs exact private Service and IAM without mutation', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input, { phase: 'candidate' });
  const service = candidateServiceReadback(plan);
  const iam = candidatePrivateIam();
  const revision = {
    revision: plan.expectedCandidate.revision,
    image: plan.expectedCandidate.image,
    serviceAccount: plan.expectedCandidate.serviceAccount,
    executionEnvironment: plan.expectedCandidate.executionEnvironment,
    cpu: plan.expectedCandidate.cpu,
    memory: plan.expectedCandidate.memory,
    concurrency: plan.expectedCandidate.concurrency,
    minInstances: plan.expectedCandidate.minInstances,
    maxInstances: plan.expectedCandidate.maxInstances,
    cpuThrottling: plan.expectedCandidate.cpuThrottling,
    startupCpuBoost: plan.expectedCandidate.startupCpuBoost,
    timeoutSeconds: plan.expectedCandidate.timeoutSeconds,
    network: plan.expectedCandidate.network,
    subnet: plan.expectedCandidate.subnet,
    vpcEgress: plan.expectedCandidate.vpcEgress,
    environment: plan.expectedCandidate.environment,
    secretEnvironment: plan.expectedCandidate.secretEnvironment,
    secretMounts: plan.expectedCandidate.secretMounts,
    probes: plan.expectedCandidate.probes,
  };
  const store = createTestStateStore();
  for (const [index, [operationId, reconcileKind, semanticObservation]] of [
    ['candidate-deploy', 'cloud-run-service-replace', {
      artifact: plan.image,
      kind: 'cloud-run-service',
      revision,
      service,
    }],
    ['candidate-private-iam-grant', 'cloud-run-service-iam', {
      bindings: [{
        members: [`serviceAccount:${ACCEPTANCE_SA}`], role: 'roles/run.servicesInvoker',
      }],
      kind: 'cloud-run-service-iam',
      service: CANDIDATE_SERVICE,
    }],
  ].entries()) {
    const member = plan.operations.find(({ id }) => id === operationId);
    await appendTestMutationCheckpoint(store, {
      operationId,
      mutationOrdinal: index + 1,
      reconcileKind,
      plan,
      safeResult: {
        kind: 'resource',
        state: 'present',
        identitySha256: releaseMutationPlanIdentity(plan, member).specSha256,
        valueSha256: createHash('sha256')
          .update(JSON.stringify(canonicalFixture(semanticObservation))).digest('hex'),
      },
    });
  }
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'candidate-privacy-publish', mutationOrdinal: 3, plan,
  });
  const calls = [];
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv.includes('replace') || argv.includes('add-iam-policy-binding')) {
        throw new Error(`recovery attempted a mutation: ${argv.join(' ')}`);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === STABLE_SERVICE) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return structuredClone(service);
      }
      if (argv[1] === 'revisions' && argv[2] === 'describe') {
        return structuredClone(plan.expectedCandidate);
      }
      if (argv.includes('get-iam-policy')) return structuredClone(iam);
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      throw new Error(`unexpected recovery read: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((argv) => argv.includes('replace')
    || argv.includes('add-iam-policy-binding')), false);
  assert.equal(calls.length, 5);
  assert.equal(calls.some((argv) => argv[1] === 'services'
    && argv[2] === 'describe' && argv[3] === STABLE_SERVICE), true);
  assert.equal(persisted.outputs.candidateService, CANDIDATE_SERVICE);
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('all-checkpoint first-release candidate restart still rejects a live stable service', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input, { phase: 'candidate' });
  const service = candidateServiceReadback(plan);
  const iam = candidatePrivateIam();
  const revision = {
    revision: plan.expectedCandidate.revision,
    image: plan.expectedCandidate.image,
    serviceAccount: plan.expectedCandidate.serviceAccount,
    executionEnvironment: plan.expectedCandidate.executionEnvironment,
    cpu: plan.expectedCandidate.cpu,
    memory: plan.expectedCandidate.memory,
    concurrency: plan.expectedCandidate.concurrency,
    minInstances: plan.expectedCandidate.minInstances,
    maxInstances: plan.expectedCandidate.maxInstances,
    cpuThrottling: plan.expectedCandidate.cpuThrottling,
    startupCpuBoost: plan.expectedCandidate.startupCpuBoost,
    timeoutSeconds: plan.expectedCandidate.timeoutSeconds,
    network: plan.expectedCandidate.network,
    subnet: plan.expectedCandidate.subnet,
    vpcEgress: plan.expectedCandidate.vpcEgress,
    environment: plan.expectedCandidate.environment,
    secretEnvironment: plan.expectedCandidate.secretEnvironment,
    secretMounts: plan.expectedCandidate.secretMounts,
    probes: plan.expectedCandidate.probes,
  };
  const store = createTestStateStore();
  for (const [index, [operationId, reconcileKind, semanticObservation]] of [
    ['candidate-deploy', 'cloud-run-service-replace', {
      artifact: plan.image,
      kind: 'cloud-run-service',
      revision,
      service,
    }],
    ['candidate-private-iam-grant', 'cloud-run-service-iam', {
      bindings: [{
        members: [`serviceAccount:${ACCEPTANCE_SA}`], role: 'roles/run.servicesInvoker',
      }],
      kind: 'cloud-run-service-iam',
      service: CANDIDATE_SERVICE,
    }],
  ].entries()) {
    const member = plan.operations.find(({ id }) => id === operationId);
    await appendTestMutationCheckpoint(store, {
      operationId,
      mutationOrdinal: index + 1,
      reconcileKind,
      plan,
      safeResult: {
        kind: 'resource',
        state: 'present',
        identitySha256: releaseMutationPlanIdentity(plan, member).specSha256,
        valueSha256: createHash('sha256')
          .update(JSON.stringify(canonicalFixture(semanticObservation))).digest('hex'),
      },
    });
  }
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'candidate-privacy-publish', mutationOrdinal: 3, plan,
  });
  const calls = [];
  let persisted = false;
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async () => { persisted = true; return true; },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === STABLE_SERVICE) {
          return {
            service: STABLE_SERVICE,
            invokerIamDisabled: false,
            serviceMaxScale: 1,
            traffic: [],
          };
        }
        return structuredClone(service);
      }
      if (argv[1] === 'revisions' && argv[2] === 'describe') {
        return structuredClone(plan.expectedCandidate);
      }
      if (argv.includes('get-iam-policy')) return structuredClone(iam);
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      throw new Error(`recovery continued past live stable precheck: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, 5);
  assert.equal(calls.some((argv) => argv[1] === 'services'
    && argv[2] === 'describe' && argv[3] === STABLE_SERVICE), true);
  assert.equal(persisted, false);
  assert.equal(store.records.at(-1).recordType, 'checkpoint');
});

test('candidate receipt-write crash hashes authoritative readbacks and ignores only Service resourceVersion drift', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'candidate' });
  const opaqueRoot = 'https://provider-opaque-restart-identifier.run.app';
  const service = (resourceVersion) => ({
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: CANDIDATE_SERVICE,
      resourceVersion,
      annotations: {
        'run.googleapis.com/invoker-iam-disabled': 'false',
        'run.googleapis.com/maxScale': '1',
        'run.googleapis.com/urls': JSON.stringify([CANDIDATE_ROOT, opaqueRoot]),
      },
    },
    status: {
      address: { url: opaqueRoot },
      url: opaqueRoot,
      traffic: [{
        revisionName: plan.candidateRevision,
        tag: plan.candidateTag,
        url: `https://${plan.candidateTag}---provider-opaque-restart-identifier.run.app`,
        percent: 100,
      }],
    },
  });
  const revision = structuredClone(plan.expectedCandidate);
  const artifact = artifactReadback(plan.image);
  const privateIam = candidatePrivateIam('candidate-private-final');
  const store = createTestStateStore();
  let deployed = false;
  let iamGranted = false;
  const first = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async () => { throw new Error('injected receipt write failure'); },
    writeCandidateSpec: async () => true,
    execute: async (argv) => {
      if (argv.includes('--dry-run')) return structuredClone(plan.candidateServiceSpec);
      if (argv[1] === 'services' && argv[2] === 'replace') {
        deployed = true;
        return service('mutation-ack-version');
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (!deployed) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return service('authoritative-version-1');
      }
      if (argv[1] === 'revisions' && argv[2] === 'describe') {
        return structuredClone(revision);
      }
      if (argv[0] === 'artifacts') return structuredClone(artifact);
      if (argv.includes('add-iam-policy-binding')) {
        iamGranted = true;
        return structuredClone(privateIam);
      }
      if (argv.includes('get-iam-policy')) {
        return iamGranted ? structuredClone(privateIam) : stablePrivateIam('candidate-baseline');
      }
      throw new Error(`unexpected initial candidate operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(first.exitCode, 1);
  assert.equal(first.publicReport.code, 'RELEASE_RECEIPT_WRITE_FAILED');
  assert.equal(store.records.filter(({ recordType }) => recordType === 'checkpoint').length, 3);
  assert.equal(store.records.some(({ recordType }) => recordType === 'terminal'), false);

  const restartCalls = [];
  let persisted = null;
  const restarted = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    loadPhaseReceipt: async () => null,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      restartCalls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return service('authoritative-version-2');
      }
      if (argv[1] === 'revisions' && argv[2] === 'describe') {
        return structuredClone(revision);
      }
      if (argv[0] === 'artifacts') return structuredClone(artifact);
      if (argv.includes('get-iam-policy')) return structuredClone(privateIam);
      throw new Error(`restart attempted a candidate mutation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(restarted.exitCode, 0, JSON.stringify(restarted.publicReport));
  assert.equal(restarted.publicReport.mutationPerformed, false);
  assert.equal(restartCalls.some((argv) => argv[2] === 'replace'
    || argv.includes('add-iam-policy-binding')), false);
  assert.equal(persisted.phase, 'candidate');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('normal terminal records response-loss operation IDs from the current attempt only', async () => {
  const store = createTestStateStore();
  store.records.push(
    {
      recordType: 'checkpoint',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      operationId: 'prior-adoption',
      payload: { outcome: 'adopted-restart' },
      recordSha256: '1'.repeat(64),
    },
    {
      recordType: 'terminal',
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      operationId: null,
      payload: { status: 'phase-complete' },
      recordSha256: '2'.repeat(64),
    },
  );
  let terminalPayload = null;
  const appendTerminal = store.appendTerminal;
  store.appendTerminal = async (payload) => {
    terminalPayload = structuredClone(payload);
    return appendTerminal(payload);
  };
  const build = exactCloudBuildReceipt();
  const result = await runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({ imageDigest: null }),
    openStateStore: async () => store,
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => true,
    execute: async () => structuredClone(build),
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.deepEqual(terminalPayload.responseLossOperationIds, []);
});

test('Cloud Build describe must deep-match submit after strict normalization', async () => {
  const submitted = exactCloudBuildReceipt();
  const described = structuredClone(submitted);
  described.results.images[0].digest = `sha256:${'f'.repeat(64)}`;
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      imageDigest: null,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
      previousImageDigest: null,
    }),
    execute: async (argv) => {
      calls.push(argv);
      return argv[1] === 'submit' ? structuredClone(submitted) : structuredClone(described);
    },
    verifySourceArchive: async () => true,
    verifyBuildConfig: async () => true,
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 3), ['builds', 'describe', BUILD_ID]);
});

test('candidate readback requires private authenticated tagged QA and the exact immutable revision', () => {
  const plan = buildReleasePlan(releaseInput());
  const candidate = plan.expectedCandidate;
  assert.equal(validateCandidateReadback(structuredClone(candidate), plan), true);
  for (const mutate of [
    (value) => { value.image = value.image.replace('@sha256:', ':latest'); },
    (value) => { value.probes.startup.path = '/api/health/live'; },
    (value) => { value.traffic.at(-1).percent = 0; },
    (value) => { value.iam.policy = 'stable-public'; },
    (value) => { value.access.audience = value.access.taggedUrl; },
    (value) => { value.secretMounts.legacyInventory.version = 'latest'; },
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.throws(() => validateCandidateReadback(changed, plan), /candidate readback/i);
  }
});

test('confirmed candidate fails closed unless every control-plane readback matches the exact revision contract', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const readbacks = {
    service: {
      service: CANDIDATE_SERVICE,
      invokerIamDisabled: false,
      serviceMaxScale: 1,
      traffic: [{ revision: REVISION, tag: CANDIDATE_TAG, percent: 100 }],
    },
    revision: structuredClone(plan.expectedCandidate),
    iam: {
      bindings: [{
        role: 'roles/run.servicesInvoker',
        members: [`serviceAccount:${ACCEPTANCE_SA}`],
      }],
      etag: 'Bw-candidate=',
      version: 1,
    },
    artifact: artifactReadback(plan.expectedCandidate.image),
  };
  assert.equal(validateCandidateControlPlaneReadbacks(structuredClone(readbacks), plan), true);
  const contradictoryArtifact = structuredClone(readbacks);
  contradictoryArtifact.artifact.image_summary.fully_qualified_digest
    = `asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy-v1/foreign@${IMAGE_DIGEST}`;
  assert.throws(() => validateCandidateControlPlaneReadbacks(contradictoryArtifact, plan),
    /Artifact Registry image readback is invalid/);
  const publicDrift = structuredClone(readbacks);
  publicDrift.iam.bindings[0].members.push('allUsers');
  assert.throws(() => validateCandidateControlPlaneReadbacks(publicDrift, plan), /IAM readback/i);
  const drift = structuredClone(readbacks);
  drift.revision.probes.startup.path = '/api/health/live';
  assert.throws(() => validateCandidateControlPlaneReadbacks(drift, plan), /revision readback/i);

  const createExecutor = ({ artifact = readbacks.artifact } = {}) => {
    let serviceDescribeCount = 0;
    let iamGranted = false;
    return async (argv) => {
    if (argv[0] === 'artifacts') return argv.includes(plan.previousImage)
      ? artifactReadback(plan.previousImage) : structuredClone(artifact);
    if (argv.includes('--dry-run')) return structuredClone(plan.candidateServiceSpec);
    if (argv.includes('get-iam-policy')) return iamGranted
      ? structuredClone(readbacks.iam)
      : { bindings: [], etag: 'Bw-private-baseline=', version: 1 };
    if (argv.includes('add-iam-policy-binding')) {
      iamGranted = true;
      return structuredClone(readbacks.iam);
    }
    if (argv[1] === 'revisions' && argv[3] === input.previousRevision) {
      return { revision: input.previousRevision, image: plan.previousImage };
    }
    if (argv[1] === 'revisions') return structuredClone(readbacks.revision);
    if (argv[1] === 'services' && argv[2] === 'describe') {
      serviceDescribeCount += 1;
      if (serviceDescribeCount === 1) {
        throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
      }
      return structuredClone(readbacks.service);
    }
    if (argv[1] === 'services' && argv[2] === 'replace') {
      return structuredClone(readbacks.service);
    }
    return { deployed: true };
    };
  };
  const execute = createExecutor();
  const accepted = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input, execute, writeCandidateSpec: async () => true, writeOutput: () => undefined,
  });
  assert.equal(accepted.exitCode, 0);

  const rejected = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: createExecutor({ artifact: {} }),
    writeCandidateSpec: async () => true,
    writeOutput: () => undefined,
  });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.publicReport.mutationPerformed, true);
});

test('candidate IAM restart reconstructs exact candidate readbacks and never repeats either mutation', async () => {
  const store = createTestStateStore();
  await appendTestMutationCheckpoint(store, {
    operationId: 'candidate-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-service-replace',
  });
  await appendTestMutationIntent(store, {
    operationId: 'candidate-private-iam-grant',
    mutationOrdinal: 2,
    reconcileKind: 'cloud-run-service-iam',
  });
  const appendCandidateRestartIntent = store.appendIntent;
  store.appendIntent = async (payload, options) => {
    assert.equal(options.operationId, 'candidate-privacy-publish');
    return appendCandidateRestartIntent(payload, options);
  };
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv.includes('replace') || argv.includes('add-iam-policy-binding')) {
        throw new Error('restart attempted a duplicate candidate mutation');
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === STABLE_SERVICE) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return candidateServiceReadback(plan);
      }
      if (argv[1] === 'revisions' && argv[2] === 'describe') {
        return structuredClone(plan.expectedCandidate);
      }
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv.includes('get-iam-policy')) return candidatePrivateIam();
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((argv) => argv.includes('replace')
    || argv.includes('add-iam-policy-binding')), false);
  assert.equal(calls.some((argv) => argv[1] === 'services' && argv[2] === 'describe'), true);
  assert.equal(calls.some((argv) => argv[1] === 'revisions' && argv[2] === 'describe'), true);
  assert.equal(calls.some((argv) => argv[0] === 'artifacts'), true);
});

test('candidate deploy restart adopts exact service state before the one untouched IAM mutation', async () => {
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'candidate-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-service-replace',
  });
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  let iamGranted = false;
  const calls = [];
  const checkpoints = [];
  const appendCheckpoint = store.appendCheckpoint;
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv.includes('replace')) throw new Error('restart must not replace the candidate service');
      if (argv.includes('add-iam-policy-binding')) {
        iamGranted = true;
        return candidatePrivateIam('candidate-granted');
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === STABLE_SERVICE) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return candidateServiceReadback(plan);
      }
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv.includes('get-iam-policy')) {
        return iamGranted ? candidatePrivateIam('candidate-granted') : stablePrivateIam();
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv.includes('replace')), false);
  assert.equal(calls.filter((argv) => argv.includes('add-iam-policy-binding')).length, 1);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
});

test('release orchestrator is dry-run first and executes only one exactly confirmed phase', async () => {
  const calls = [];
  const input = releaseInput();
  const dryRun = await runGcpRelease({
    argv: ['--phase=candidate'], input,
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.equal(dryRun.exitCode, 0);
  assert.equal(dryRun.publicReport.status, 'dry-run');
  assert.equal(calls.length, 0);

  const plan = buildReleasePlan(input);
  let rolledBack = false;
  const result = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') return rolledBack
        ? { service: 'hkbuddy-v1-api', invokerIamDisabled: false, serviceMaxScale: 1, traffic: [{ revision: input.previousRevision, tag: null, percent: 100 }] }
        : { service: 'hkbuddy-v1-api', invokerIamDisabled: false, serviceMaxScale: 1, traffic: [{ revision: STABLE_REVISION, tag: null, percent: 100 }] };
      if (argv[1] === 'revisions') return argv[3] === input.previousRevision
        ? { revision: input.previousRevision, image: plan.previousImage }
        : structuredClone(plan.expectedStable);
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('update-traffic')) {
        rolledBack = true;
        return trafficTargetAcknowledgement(input.previousRevision);
      }
      if (argv.includes('get-iam-policy')) return {
        bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }],
        etag: 'stable-public', version: 1,
      };
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, planPhase(buildReleasePlan(input), 'rollback').map(({ argv }) => argv));

  const invalid = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`, '--extra'], input,
    execute: async () => { throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.publicReport.mutationPerformed, false);
});

test('rollback mutates only stable traffic and never references the candidate service or tag', () => {
  const plan = buildReleasePlan(releaseInput());
  const rollback = plan.operations.find(({ id }) => id === 'rollback-traffic');
  assert.equal(rollback.argv.includes(`--remove-tags=${CANDIDATE_TAG}`), false);
  assert.equal(rollback.argv.includes(CANDIDATE_SERVICE), false);
  assert.equal(rollback.argv.includes(STABLE_SERVICE), true);
  assert.equal(rollback.argv.includes('--to-revisions=hkbuddy-v1-api-111111111111=100'), true);
});

test('rollback rejects a zero-percent candidate tag that remains reachable', async () => {
  const input = releaseInput();
  const staleTaggedService = {
    service: 'hkbuddy-v1-api',
    invokerIamDisabled: false,
    serviceMaxScale: 1,
    traffic: [
      { revision: input.previousRevision, tag: null, percent: 100 },
      { revision: REVISION, tag: CANDIDATE_TAG, percent: 0 },
    ],
  };
  const result = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: async () => structuredClone(staleTaggedService),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
});

test('promotion requires the reviewed owner identity before its first mutation', async () => {
  const calls = [];
  const rejected = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') {
        return [{ account: 'hkbuddy-deployer@example.invalid', status: 'ACTIVE' }];
      }
      throw new Error('promotion must remain inert');
    },
    writeOutput: () => undefined,
  });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.publicReport.mutationPerformed, false);
  assert.deepEqual(rejected.publicReport.completed, []);
  assert.equal(calls.length, 1);
  assert.equal(validateServiceIamReceipt(stablePublicIam(), { policy: 'stable-public' }), true);
  assert.throws(() => validateServiceIamReceipt({
    bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }],
  }, { policy: 'stable-public' }), /IAM readback/i);
  assert.equal(validateTrafficReceipt(stablePromotedReadback(buildReleasePlan(releaseInput())), {
    revision: STABLE_REVISION,
  }), true);
});

test('later singleton candidate and promotion remain inert until rollout lanes exist', async () => {
  for (const phase of ['candidate', 'promote']) {
    const calls = [];
    const result = await runGcpRelease({
      argv: [`--phase=${phase}`, `--confirm-release=${RELEASE_SHA}`],
      input: releaseInput(),
      unsafeTestOnlyAllowSingletonRollingRelease: false,
      execute: async (argv) => { calls.push(argv); return {}; },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1, phase);
    assert.equal(result.publicReport.code, 'ROLLING_RELEASE_UNSUPPORTED_SINGLETON', phase);
    assert.equal(result.publicReport.mutationPerformed, false, phase);
    assert.deepEqual(calls, [], phase);
  }
});

test('later singleton candidate and promotion remain previewable before confirmation', async () => {
  for (const phase of ['candidate', 'promote']) {
    const calls = [];
    const result = await runGcpReleaseImpl({
      argv: [`--phase=${phase}`],
      input: releaseInput(),
      execute: async (argv) => { calls.push(argv); throw new Error('dry run must remain inert'); },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 0, phase);
    assert.equal(result.publicReport.code, 'GCP_RELEASE_DRY_RUN', phase);
    assert.equal(result.publicReport.mutationPerformed, false, phase);
    assert.equal(result.publicReport.plannedOperations.length > 0, true, phase);
    assert.deepEqual(calls, [], phase);
  }
});

test('later promotion rejects every stable-service tag before its first stable mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const calls = [];
  let stableMutationAttempted = false;
  const taggedPrior = stablePriorReadback(plan);
  taggedPrior.traffic[0].tag = 'foreign-direct-route';

  const rejected = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    now: () => new Date('2026-08-27T08:04:00.000Z'),
    writeStableSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePublicIam();
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.previousRevision) {
          return { revision: plan.previousRevision, image: plan.previousImage };
        }
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return argv[3] === CANDIDATE_SERVICE
          ? candidateServiceReadback(plan) : structuredClone(taggedPrior);
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableMutationAttempted = true;
        throw new Error('stable mutation must remain unreachable');
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(rejected.publicReport.mutationPerformed, false);
  assert.equal(stableMutationAttempted, false);
  assert.equal(calls.some((argv) => (
    argv[1] === 'services' && argv[2] === 'replace' && !argv.includes('--dry-run')
  )), false);
});

test('later promotion performs no cloud mutation after the final traffic mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const publicPolicy = stablePublicIam('public-baseline');
  const priorRevision = { revision: plan.previousRevision, image: plan.previousImage };
  const priorArtifact = artifactReadback(plan.previousImage);
  const calls = [];
  let stableState = stablePriorReadback(plan);
  let trafficAttempted = false;
  let postTrafficDescribeCount = 0;
  let promotionPrivacyProduced = false;
  const store = createTestStateStore();

  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    now: () => new Date('2026-08-27T08:04:00.000Z'),
    openStateStore: async () => store,
    verifyReleasePrivacyArtifact: verifyControlledReleasePrivacyArtifact,
    produceReleasePrivacyArtifact: async ({ plan: privacyPlan, locator }) => {
      assert.deepEqual(stableState, stableStagedReadback(plan));
      promotionPrivacyProduced = true;
      return controlledReleasePrivacyArtifact(privacyPlan, locator);
    },
    writeStableSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return structuredClone(
        argv.includes(plan.previousImage) ? priorArtifact : artifactReadback(plan.image),
      );
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : structuredClone(publicPolicy);
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        if (argv[3] === plan.previousRevision) return structuredClone(priorRevision);
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) {
          const serverValidated = structuredClone(plan.stableServiceSpec);
          delete serverValidated.metadata.annotations['run.googleapis.com/invoker-iam-disabled'];
          return serverValidated;
        }
        stableState = stableStagedReadback(plan);
        return structuredClone(stableState);
      }
      if (argv.includes('update-traffic')
        && argv.includes(`--to-revisions=${plan.stableRevision}=100`)) {
        assert.equal(promotionPrivacyProduced, true);
        assert.equal(store.records.some(({ recordType, operationId }) => (
          recordType === 'checkpoint' && operationId === 'promote-privacy-publish'
        )), true);
        trafficAttempted = true;
        stableState = stablePromotedReadback(plan);
        throw new Error('promotion traffic response was lost');
      }
      if (argv.includes('update-traffic')
        && argv.includes(`--to-revisions=${plan.previousRevision}=100`)) {
        stableState = stablePriorReadback(plan);
        return trafficTargetAcknowledgement(plan.previousRevision);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) return candidateServiceReadback(plan);
        if (trafficAttempted) {
          postTrafficDescribeCount += 1;
          if (postTrafficDescribeCount === 2) throw new Error('fresh promotion readback unavailable');
        }
        return structuredClone(stableState);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED', JSON.stringify(result.publicReport));
  assert.deepEqual(result.publicReport.responseLossRecoveries, ['promote-traffic']);
  assert.deepEqual(stableState, stablePromotedReadback(plan));
  assert.equal(calls.some((argv) => argv.includes('set-iam-policy')), false);
  const trafficCalls = calls.filter((argv) => argv.includes('update-traffic'));
  assert.equal(trafficCalls.length, 1);
  const finalMutationIndex = calls.findIndex((argv) => argv.includes('update-traffic'));
  assert.equal(calls.slice(finalMutationIndex + 1).every((argv) => (
    argv[2] === 'describe' || argv.includes('get-iam-policy') || argv[0] === 'artifacts'
  )), true);
});

test('promotion drift during privacy production blocks the final intent and public mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  let stableState = stablePriorReadback(plan);
  let candidateDrifted = false;
  let finalMutations = 0;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    now: () => new Date('2026-08-27T08:04:00.000Z'),
    openStateStore: async () => store,
    writeStableSpec: async () => true,
    produceReleasePrivacyArtifact: async ({ plan: privacyPlan, locator }) => {
      const artifact = controlledReleasePrivacyArtifact(privacyPlan, locator);
      candidateDrifted = true;
      return artifact;
    },
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePublicIam();
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        return { revision: plan.previousRevision, image: plan.previousImage };
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableState = stableStagedReadback(plan);
        return structuredClone(stableState);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === STABLE_SERVICE) return structuredClone(stableState);
        const candidate = candidateServiceReadback(plan);
        if (candidateDrifted) candidate.traffic[0].percent = 99;
        return candidate;
      }
      if (argv.includes('update-traffic')) {
        finalMutations += 1;
        return trafficTargetAcknowledgement(plan.stableRevision);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(finalMutations, 0);
  assert.equal(store.records.some(({ recordType, operationId }) => (
    recordType === 'intent' && operationId === 'promote-traffic'
  )), false);
});

async function runPromotionExpiryCrossing({ firstRelease, crossing }) {
  const input = releaseInput(firstRelease
    ? { previousRevision: null, previousImageDigest: null } : {});
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  const appendIntent = store.appendIntent;
  let current = new Date('2026-08-27T08:04:59.999Z');
  let proofProduced = false;
  let candidateExists = true;
  let stableExists = !firstRelease;
  let stableState = firstRelease ? null : stablePriorReadback(plan);
  let stablePolicy = firstRelease ? stablePrivateIam() : stablePublicIam();
  let finalMutations = 0;
  if (crossing === 'intent') {
    store.appendIntent = async (payload, options) => {
      const record = await appendIntent(payload, options);
      if (['promote-public-service', 'promote-traffic'].includes(options?.operationId)) {
        current = new Date('2026-08-27T08:05:00.000Z');
      }
      return record;
    };
  } else if (crossing === 'delete-intent') {
    store.appendIntent = async (payload, options) => {
      const record = await appendIntent(payload, options);
      if (options?.operationId === 'candidate-cleanup-delete') {
        current = new Date('2026-08-27T08:05:00.000Z');
      }
      return record;
    };
  }
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    now: () => new Date(current),
    writeStableSpec: async () => true,
    produceReleasePrivacyArtifact: async ({ plan: privacyPlan, locator }) => {
      proofProduced = true;
      return controlledReleasePrivacyArtifact(privacyPlan, locator);
    },
    verifyReleasePrivacyArtifact: async (reference, _plan, clock) => {
      const instant = typeof clock === 'function' ? clock() : clock;
      if (!(instant instanceof Date) || instant.getTime() >= Date.parse(reference.expiresAt)) {
        throw new Error('controlled promotion privacy proof expired');
      }
      return true;
    },
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) {
        if (argv[3] === CANDIDATE_SERVICE) return candidatePrivateIam();
        if (crossing === 'read' && proofProduced) {
          current = new Date('2026-08-27T08:05:00.000Z');
        }
        return structuredClone(stablePolicy);
      }
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        return { revision: plan.previousRevision, image: plan.previousImage };
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableExists = true;
        stableState = stableStagedReadback(plan);
        if (firstRelease && crossing === 'after-handoff') {
          current = new Date('2026-08-27T08:05:00.000Z');
        }
        return structuredClone(stableState);
      }
      if (argv[1] === 'services' && argv[2] === 'delete') {
        candidateExists = false;
        return null;
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) {
          if (!candidateExists) {
            throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
          }
          return candidateServiceReadback(plan);
        }
        if (!stableExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return structuredClone(stableState);
      }
      if (argv.includes('add-iam-policy-binding') || argv.includes('update-traffic')) {
        finalMutations += 1;
        if (firstRelease) {
          stablePolicy = stablePublicIam('public-after');
          return structuredClone(stablePolicy);
        }
        stableState = stablePromotedReadback(plan);
        return trafficTargetAcknowledgement(plan.stableRevision);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  return { result, store, finalMutations, candidateExists };
}

test('later promotion proof exact-expiry during the final read creates no unsafe intent', async () => {
  const { result, store, finalMutations } = await runPromotionExpiryCrossing({
    firstRelease: false, crossing: 'read',
  });
  assert.equal(result.exitCode, 1, JSON.stringify({ report: result.publicReport, records: store.records }));
  assert.equal(result.publicReport.code, 'PROMOTION_REPROOF_REQUIRED', JSON.stringify(store.records));
  assert.equal(finalMutations, 0);
  assert.equal(store.records.some(({ recordType, operationId }) => (
    recordType === 'intent' && operationId === 'promote-traffic'
  )), false);
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('later promotion proof exact-expiry while appending final intent aborts before traffic', async () => {
  const { result, store, finalMutations } = await runPromotionExpiryCrossing({
    firstRelease: false, crossing: 'intent',
  });
  assert.equal(result.exitCode, 1, JSON.stringify({ report: result.publicReport, records: store.records }));
  assert.equal(result.publicReport.code, 'PROMOTION_REPROOF_REQUIRED', JSON.stringify(store.records));
  assert.equal(finalMutations, 0);
  const finalIntentIndex = store.records.findIndex(({ recordType, operationId }) => (
    recordType === 'intent' && operationId === 'promote-traffic'
  ));
  assert.equal(finalIntentIndex >= 0, true);
  assert.equal(store.records[finalIntentIndex + 1].recordType, 'abort');
  assert.equal(store.records[finalIntentIndex + 1].payload.reason, 'expired-before-final-mutation');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('first promotion keeps a fresh-at-handoff proof authoritative after candidate deletion', async () => {
  const { result, finalMutations } = await runPromotionExpiryCrossing({
    firstRelease: true, crossing: 'after-handoff',
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(finalMutations, 1);
  assert.equal(result.publicReport.candidateCleanupState, 'deleted');
});

test('first promotion proof expiry while journaling candidate deletion aborts before deletion', async () => {
  const { result, store, finalMutations, candidateExists } = await runPromotionExpiryCrossing({
    firstRelease: true, crossing: 'delete-intent',
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.code, 'PROMOTION_REPROOF_REQUIRED');
  assert.equal(candidateExists, true);
  assert.equal(finalMutations, 0);
  const deleteIntentIndex = store.records.findIndex(({ recordType, operationId }) => (
    recordType === 'intent' && operationId === 'candidate-cleanup-delete'
  ));
  assert.equal(deleteIntentIndex >= 0, true);
  assert.equal(store.records[deleteIntentIndex + 1].recordType, 'abort');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('promotion proof expires at the exact boundary before the final intent', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  let stableState = stablePriorReadback(plan);
  let publicMutations = 0;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    now: () => new Date('2026-08-27T08:05:00.000Z'),
    writeStableSpec: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePublicIam();
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        return { revision: plan.previousRevision, image: plan.previousImage };
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableState = stableStagedReadback(plan);
        return structuredClone(stableState);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return argv[3] === CANDIDATE_SERVICE
          ? candidateServiceReadback(plan) : structuredClone(stableState);
      }
      if (argv.includes('update-traffic')) {
        publicMutations += 1;
        return trafficTargetAcknowledgement(plan.stableRevision);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'PROMOTION_REPROOF_REQUIRED');
  assert.equal(publicMutations, 0);
  assert.equal(store.records.some(({ recordType, operationId }) => (
    recordType === 'intent' && operationId === 'promote-traffic'
  )), false);
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('expired open promotion-proof intent is adopted as audit evidence then closed for re-proof', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestMutationCheckpoint(store, {
    operationId: 'promote-stable-deploy', mutationOrdinal: 1,
    reconcileKind: 'cloud-run-service-replace', plan,
  });
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 2, plan,
  });
  store.records.pop();
  let writes = 0;
  let finalMutations = 0;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    now: () => new Date('2026-08-27T08:05:00.000Z'),
    writeReleasePrivacyArtifact: async () => { writes += 1; return true; },
    execute: async (argv) => {
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePublicIam();
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        return structuredClone(plan.expectedStable);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return argv[3] === CANDIDATE_SERVICE
          ? candidateServiceReadback(plan) : stableStagedReadback(plan);
      }
      if (argv.includes('update-traffic') || argv.includes('set-iam-policy')) {
        finalMutations += 1;
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.code, 'PROMOTION_REPROOF_REQUIRED');
  assert.equal(writes, 1);
  assert.equal(finalMutations, 0);
  assert.equal(store.records.at(-2).operationId, 'promote-privacy-publish');
  assert.equal(store.records.at(-2).recordType, 'checkpoint');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('expired unperformed final intent is aborted without replay and permits a new attempt', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestMutationCheckpoint(store, {
    operationId: 'promote-stable-deploy', mutationOrdinal: 1,
    reconcileKind: 'cloud-run-service-replace', plan,
  });
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 2, plan,
  });
  await appendTestMutationIntent(store, {
    operationId: 'promote-traffic', mutationOrdinal: 3,
    reconcileKind: 'cloud-run-traffic', plan,
  });
  const finalIntent = store.records.at(-1);
  const finalIdentity = releaseMutationPlanIdentity(
    plan, plan.operations.find(({ id }) => id === 'promote-traffic'),
  );
  finalIntent.payload.beforeSha256 = createHash('sha256').update(JSON.stringify(canonicalFixture({
    ...finalIdentity.expectedBefore,
    observationSha256: createHash('sha256')
      .update(JSON.stringify(canonicalFixture(stableStagedReadback(plan)))).digest('hex'),
  }))).digest('hex');
  let finalMutations = 0;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    now: () => new Date('2026-08-27T08:06:00.000Z'),
    execute: async (argv) => {
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return stableStagedReadback(plan);
      }
      if (argv.includes('update-traffic')) finalMutations += 1;
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.code, 'PROMOTION_REPROOF_REQUIRED');
  assert.equal(finalMutations, 0);
  assert.equal(store.records.at(-2).recordType, 'abort');
  assert.equal(store.records.at(-2).payload.reason, 'expired-before-final-mutation');
  assert.equal(store.records.at(-1).recordType, 'terminal');

  const freshStore = createTestStateStore();
  let freshStableState = stablePriorReadback(plan);
  let freshPrivacyProofs = 0;
  let freshFinalMutations = 0;
  const recovered = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => freshStore,
    now: () => new Date('2026-08-27T08:04:00.000Z'),
    verifyReleasePrivacyArtifact: verifyControlledReleasePrivacyArtifact,
    produceReleasePrivacyArtifact: async ({ plan: privacyPlan, locator }) => {
      freshPrivacyProofs += 1;
      return controlledReleasePrivacyArtifact(privacyPlan, locator);
    },
    writeStableSpec: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePublicIam();
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        return { revision: plan.previousRevision, image: plan.previousImage };
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        freshStableState = stableStagedReadback(plan);
        return structuredClone(freshStableState);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return argv[3] === CANDIDATE_SERVICE
          ? candidateServiceReadback(plan) : structuredClone(freshStableState);
      }
      if (argv.includes('update-traffic')) {
        freshFinalMutations += 1;
        freshStableState = stablePromotedReadback(plan);
        return trafficTargetAcknowledgement(plan.stableRevision);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.publicReport));
  assert.equal(freshPrivacyProofs, 1);
  assert.equal(freshFinalMutations, 1);
  assert.equal(freshStore.records.some(({ operationId, recordType }) => (
    operationId === 'promote-privacy-publish' && recordType === 'checkpoint'
  )), true);
  assert.equal(freshStore.records.some(({ recordType }) => recordType === 'abort'), false);
});

test('later-traffic restart adopts exact promoted service truth without a second update', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestMutationCheckpoint(store, {
    operationId: 'promote-stable-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-service-replace',
    plan,
  });
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 2, plan,
  });
  await appendTestMutationIntent(store, {
    operationId: 'promote-traffic',
    mutationOrdinal: 3,
    reconcileKind: 'cloud-run-traffic',
    plan,
  });
  store.appendIntent = async () => { throw new Error('restart must not update traffic'); };
  const checkpoints = [];
  const appendCheckpoint = store.appendCheckpoint;
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv.includes('get-iam-policy')) return stablePublicIam();
      assert.deepEqual(argv.slice(0, 4), ['run', 'services', 'describe', STABLE_SERVICE]);
      return stablePromotedReadback(plan);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, 3);
  assert.equal(calls.some((argv) => argv.includes('update-traffic')), false);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
  assert.equal(result.publicReport.phaseReceipt.phase, 'promote');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('stable deploy restart adopts exact staged state and preserves one bounded final traffic mutation', async () => {
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'promote-stable-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-service-replace',
  });
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  let stableState = stableStagedReadback(plan);
  const calls = [];
  const checkpoints = [];
  const appendCheckpoint = store.appendCheckpoint;
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    now: () => new Date('2026-08-27T08:04:00.000Z'),
    openStateStore: async () => store,
    verifyReleasePrivacyArtifact: verifyControlledReleasePrivacyArtifact,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv.includes('replace')) throw new Error('restart must not replace the stable service');
      if (argv.includes('update-traffic')) {
        stableState = stablePromotedReadback(plan);
        return trafficTargetAcknowledgement(plan.stableRevision);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return argv[3] === CANDIDATE_SERVICE
          ? candidateServiceReadback(plan) : structuredClone(stableState);
      }
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        return { revision: plan.previousRevision, image: plan.previousImage };
      }
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) {
        return argv.includes(CANDIDATE_SERVICE) ? candidatePrivateIam() : stablePublicIam();
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv.includes('replace')), false);
  assert.equal(calls.filter((argv) => argv.includes('update-traffic')).length, 1);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
});

test('later promotion never issues restore traffic when post-mutation read fails', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const priorRevision = { revision: plan.previousRevision, image: plan.previousImage };
  const calls = [];
  let stableState = stablePriorReadback(plan);
  let trafficAttempted = false;
  let postTrafficDescribeCount = 0;
  let malformedRestoreReturned = false;

  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    now: () => new Date('2026-08-27T08:04:00.000Z'),
    verifyReleasePrivacyArtifact: verifyControlledReleasePrivacyArtifact,
    writeStableSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePublicIam();
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        return structuredClone(priorRevision);
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableState = stableStagedReadback(plan);
        return structuredClone(stableState);
      }
      if (argv.includes('update-traffic')
        && argv.includes(`--to-revisions=${plan.stableRevision}=100`)) {
        trafficAttempted = true;
        stableState = stablePromotedReadback(plan);
        throw new Error('promotion traffic response was lost');
      }
      if (argv.includes('update-traffic')
        && argv.includes(`--to-revisions=${plan.previousRevision}=100`)) {
        malformedRestoreReturned = true;
        stableState = stablePriorReadback(plan);
        return {};
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) return candidateServiceReadback(plan);
        if (trafficAttempted && !malformedRestoreReturned) {
          postTrafficDescribeCount += 1;
          if (postTrafficDescribeCount === 2) throw new Error('fresh promotion readback unavailable');
        }
        return structuredClone(stableState);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.deepEqual(result.publicReport.responseLossRecoveries, ['promote-traffic']);
  assert.equal(malformedRestoreReturned, false);
  assert.equal(calls.some((argv) => argv.includes(
    `--to-revisions=${plan.previousRevision}=100`,
  )), false);
});

test('later promotion blocks on staged drift without a recovery mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const priorRevision = { revision: plan.previousRevision, image: plan.previousImage };
  let stableDeployed = false;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    writeStableSpec: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(plan.previousImage) ? plan.previousImage : plan.image);
      }
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePublicIam();
      if (argv[1] === 'revisions') {
        if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
        if (argv[3] === plan.stableRevision) return structuredClone(plan.expectedStable);
        if (argv[3] === plan.previousRevision) return structuredClone(priorRevision);
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableDeployed = true;
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) return candidateServiceReadback(plan);
        if (!stableDeployed) return stablePriorReadback(plan);
        return {
          service: STABLE_SERVICE,
          invokerIamDisabled: false,
          serviceMaxScale: 1,
          traffic: [{ revision: `${STABLE_SERVICE}-foreign000000`, percent: 100 }],
        };
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
});

test('first promotion IAM response loss never triggers an automatic restore mutation', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const attemptId = '55555555-5555-4555-8555-555555555555';
  const restorePath = join(
    dirname(plan.sourceArchive), `${plan.stableRevision}.iam-restore.${attemptId}.json`,
  );
  let stableExists = false;
  let candidateExists = true;
  let stablePolicy = stablePrivateIam('stable-private-baseline');
  let stablePublicReads = 0;
  let restorePolicy = null;
  let restoreRemoved = false;
  const calls = [];

  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    now: () => new Date('2026-08-27T08:04:00.000Z'),
    verifyReleasePrivacyArtifact: verifyControlledReleasePrivacyArtifact,
    randomUUID: () => attemptId,
    writeStableSpec: async () => true,
    writeIamRestorePolicy: async (releasePlan, policy, options) => {
      assert.equal(releasePlan.stableRevision, plan.stableRevision);
      assert.equal(options.attemptId, attemptId);
      restorePolicy = structuredClone(policy);
      return restorePath;
    },
    removeIamRestorePolicy: async (releasePlan, filePath) => {
      assert.equal(releasePlan.stableRevision, plan.stableRevision);
      assert.equal(filePath, restorePath);
      restoreRemoved = true;
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv[1] === 'revisions') return argv[3] === plan.candidateRevision
        ? structuredClone(plan.expectedCandidate) : structuredClone(plan.expectedStable);
      if (argv.includes('get-iam-policy')) {
        if (argv[3] === CANDIDATE_SERVICE) return candidatePrivateIam();
        if (stablePolicy.bindings.length > 0) {
          stablePublicReads += 1;
          if (stablePublicReads === 2) throw new Error('fresh stable IAM readback unavailable');
        }
        return structuredClone(stablePolicy);
      }
      if (argv.includes('add-iam-policy-binding')) {
        stablePolicy = stablePublicIam('stable-public-landed');
        throw new Error('public IAM response was lost');
      }
      if (argv[1] === 'services' && argv[2] === 'delete') {
        candidateExists = false;
        return null;
      }
      if (argv.includes('set-iam-policy')) {
        assert.equal(argv[3], STABLE_SERVICE);
        assert.equal(argv[4], restorePath);
        assert.deepEqual(restorePolicy, {
          bindings: [], etag: 'stable-public-landed', version: 1,
        });
        stablePolicy = stablePrivateIam('stable-private-restored');
        return structuredClone(stablePolicy);
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableExists = true;
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) {
          if (!candidateExists) {
            throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
          }
          return candidateServiceReadback(plan);
        }
        if (!stableExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return stablePromotedReadback(plan);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED', JSON.stringify(result.publicReport));
  assert.deepEqual(result.publicReport.responseLossRecoveries, ['promote-public-service']);
  assert.deepEqual(stablePolicy.bindings, stablePublicIam('stable-public-landed').bindings);
  assert.equal(restorePolicy, null);
  assert.equal(restoreRemoved, false);
  const publicIndex = calls.findIndex((argv) => argv.includes('add-iam-policy-binding'));
  const restoreIndex = calls.findIndex((argv) => argv.includes('set-iam-policy'));
  assert.equal(publicIndex >= 0, true);
  assert.equal(restoreIndex, -1);
});

test('first public-IAM restart rereads exact staged service state without repeating the final grant', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
  });
  const cleanupIdentity = releaseMutationPlanIdentity(
    plan, plan.operations.find(({ id }) => id === 'candidate-cleanup-delete'),
  );
  await appendTestMutationCheckpoint(store, {
    operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
    reconcileKind: 'cloud-run-service-delete', plan,
    safeResult: {
      kind: 'resource', state: 'absent', identitySha256: cleanupIdentity.specSha256,
      valueSha256: createHash('sha256')
        .update(JSON.stringify(canonicalFixture(cleanupIdentity.expectedAfter.observation))).digest('hex'),
    },
  });
  await appendTestMutationCheckpoint(store, {
    operationId: 'promote-stable-deploy',
    mutationOrdinal: 3,
    reconcileKind: 'cloud-run-service-replace',
    plan,
  });
  await appendTestMutationIntent(store, {
    operationId: 'promote-public-service',
    mutationOrdinal: 4,
    reconcileKind: 'cloud-run-service-iam',
    plan,
  });
  store.appendIntent = async () => { throw new Error('restart must not append another intent'); };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv.includes('add-iam-policy-binding')) {
        throw new Error('restart attempted a duplicate public grant');
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'revisions') {
        return argv[3] === plan.candidateRevision
          ? structuredClone(plan.expectedCandidate) : structuredClone(plan.expectedStable);
      }
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv.includes('get-iam-policy')) {
        return argv.includes(CANDIDATE_SERVICE) ? candidatePrivateIam() : stablePublicIam();
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((argv) => argv.includes('add-iam-policy-binding')), false);
  assert.equal(calls.some((argv) => argv[1] === 'services' && argv[2] === 'describe'
    && argv[3] === STABLE_SERVICE), true);
  assert.equal(calls.some((argv) => argv[1] === 'revisions' && argv[3] === plan.stableRevision), true);
  assert.equal(calls.some((argv) => argv[0] === 'artifacts' && argv.includes(plan.image)), true);
});

test('first public-IAM restart retries an unperformed grant and completes the original handoff', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  let candidateExists = true;
  let stableExists = false;
  let stablePolicy = stablePrivateIam('stable-private-before-public');
  let publicGrantAttempts = 0;
  const calls = [];
  const execute = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
    if (argv[1] === 'revisions') return argv[3] === plan.candidateRevision
      ? structuredClone(plan.expectedCandidate) : structuredClone(plan.expectedStable);
    if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
      ? candidatePrivateIam() : structuredClone(stablePolicy);
    if (argv[1] === 'services' && argv[2] === 'delete') {
      candidateExists = false;
      return null;
    }
    if (argv[1] === 'services' && argv[2] === 'replace') {
      if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
      stableExists = true;
      return stableStagedReadback(plan);
    }
    if (argv.includes('add-iam-policy-binding')) {
      publicGrantAttempts += 1;
      if (publicGrantAttempts === 1) {
        throw new Error('public grant request was not performed');
      }
      stablePolicy = stablePublicIam('stable-public-after-retry');
      return structuredClone(stablePolicy);
    }
    if (argv[1] === 'services' && argv[2] === 'describe') {
      if (argv[3] === CANDIDATE_SERVICE) {
        if (!candidateExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return candidateServiceReadback(plan);
      }
      if (!stableExists) {
        throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
      }
      return stableStagedReadback(plan);
    }
    throw new Error(`unexpected operation: ${argv.join(' ')}`);
  };
  const options = {
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    writeStableSpec: async () => true,
    execute,
    writeOutput: () => undefined,
  };

  const interrupted = await runGcpRelease(options);
  assert.equal(interrupted.exitCode, 1, JSON.stringify(interrupted.publicReport));
  assert.equal(interrupted.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(candidateExists, false);
  assert.equal(stableExists, true);
  assert.deepEqual(stablePolicy.bindings, []);
  assert.equal(store.records.at(-1).recordType, 'intent');
  assert.equal(store.records.at(-1).operationId, 'promote-public-service');

  const resumeCallOffset = calls.length;
  const resumed = await runGcpRelease(options);
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.publicReport));
  assert.equal(resumed.publicReport.mutationPerformed, true);
  assert.equal(calls.slice(resumeCallOffset).some((argv) => argv[0] === 'auth'
    && argv[1] === 'list'), true);
  assert.equal(publicGrantAttempts, 2);
  assert.deepEqual(stablePolicy.bindings,
    stablePublicIam('stable-public-after-retry').bindings);
  assert.equal(store.records.findLast((record) => record.recordType === 'checkpoint'
    && record.operationId === 'promote-public-service').payload.outcome, 'applied');
  assert.equal(store.records.at(-1).recordType, 'terminal');
  assert.deepEqual(store.records.at(-1).payload.responseLossOperationIds, []);
});

test('first-release mutation retries require fresh approved promotion authority', async (t) => {
  for (const operationId of [
    'candidate-cleanup-delete',
    'promote-stable-deploy',
    'promote-public-service',
  ]) {
    await t.test(operationId, async () => {
      const input = releaseInput({ previousRevision: null, previousImageDigest: null });
      const plan = buildReleasePlan(input);
      const store = createTestStateStore();
      await appendTestPrivacyCheckpoint(store, {
        operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
      });
      const cleanupIdentity = releaseMutationPlanIdentity(
        plan, plan.operations.find(({ id }) => id === 'candidate-cleanup-delete'),
      );
      if (operationId !== 'candidate-cleanup-delete') {
        await appendTestMutationCheckpoint(store, {
          operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
          reconcileKind: 'cloud-run-service-delete', plan,
          safeResult: {
            kind: 'resource', state: 'absent', identitySha256: cleanupIdentity.specSha256,
            valueSha256: createHash('sha256')
              .update(JSON.stringify(canonicalFixture(cleanupIdentity.expectedAfter.observation)))
              .digest('hex'),
          },
        });
      }
      if (operationId === 'promote-public-service') {
        await appendTestMutationCheckpoint(store, {
          operationId: 'promote-stable-deploy', mutationOrdinal: 3,
          reconcileKind: 'cloud-run-service-replace', plan,
        });
      }
      const mutationOrdinal = {
        'candidate-cleanup-delete': 2,
        'promote-stable-deploy': 3,
        'promote-public-service': 4,
      }[operationId];
      const reconcileKind = {
        'candidate-cleanup-delete': 'cloud-run-service-delete',
        'promote-stable-deploy': 'cloud-run-service-replace',
        'promote-public-service': 'cloud-run-service-iam',
      }[operationId];
      const beforeObservation = operationId === 'candidate-cleanup-delete'
        ? candidateServiceReadback(plan)
        : (operationId === 'promote-stable-deploy'
          ? { state: 'absent' }
          : stablePrivateIam('stable-private-before-authority-check'));
      await appendTestMutationIntent(store, {
        operationId,
        mutationOrdinal,
        reconcileKind,
        plan,
        beforeObservation,
      });
      const calls = [];
      const result = await runGcpRelease({
        argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
        input,
        openStateStore: async () => store,
        execute: async (argv) => {
          calls.push(argv);
          if (argv[0] === 'auth') {
            return [{ account: 'wrong-account@example.com', status: 'ACTIVE' }];
          }
          throw new Error(`authority failure continued to operation: ${argv.join(' ')}`);
        },
        writeOutput: () => undefined,
      });

      assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
      assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.deepEqual(calls, [[
        'auth', 'list', '--filter=status:ACTIVE', '--format=json',
      ]]);
      assert.equal(store.records.at(-1).recordType, 'intent');
      assert.equal(store.records.at(-1).operationId, operationId);
    });
  }
});

test('first promotion adopts landed candidate deletion and completes without repeating delete', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
  });
  await appendTestMutationIntent(store, {
    operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
    reconcileKind: 'cloud-run-service-delete', plan,
    beforeObservation: candidateServiceReadback(plan),
  });
  let stableExists = false;
  let stablePolicy = stablePrivateIam('stable-private-after-deploy');
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    openStateStore: async () => store,
    writeStableSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv[1] === 'revisions') return structuredClone(plan.expectedStable);
      if (argv.includes('get-iam-policy')) return structuredClone(stablePolicy);
      if (argv[1] === 'services' && argv[2] === 'delete') {
        throw new Error('landed candidate deletion must not be repeated');
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        stableExists = true;
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE || !stableExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return stableStagedReadback(plan);
      }
      if (argv.includes('add-iam-policy-binding')) {
        stablePolicy = stablePublicIam('stable-public-after-landed-delete');
        return structuredClone(stablePolicy);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv[1] === 'services'
    && argv[2] === 'delete'), false);
  assert.equal(calls.some((argv) => argv[1] === 'services'
    && argv[2] === 'replace'), true);
});

test('first promotion retries an unperformed journaled candidate deletion exactly once', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
  });
  await appendTestMutationIntent(store, {
    operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
    reconcileKind: 'cloud-run-service-delete', plan,
    beforeObservation: candidateServiceReadback(plan),
  });
  let candidateExists = true;
  let stableExists = false;
  let stablePolicy = stablePrivateIam('stable-private-after-delete-retry');
  let deleteCount = 0;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    openStateStore: async () => store,
    writeStableSpec: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv[1] === 'revisions') return argv[3] === plan.candidateRevision
        ? structuredClone(plan.expectedCandidate) : structuredClone(plan.expectedStable);
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : structuredClone(stablePolicy);
      if (argv[1] === 'services' && argv[2] === 'delete') {
        deleteCount += 1;
        candidateExists = false;
        return null;
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        stableExists = true;
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) {
          if (!candidateExists) {
            throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
          }
          return candidateServiceReadback(plan);
        }
        if (!stableExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return stableStagedReadback(plan);
      }
      if (argv.includes('add-iam-policy-binding')) {
        stablePolicy = stablePublicIam('stable-public-after-delete-retry');
        return structuredClone(stablePolicy);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(deleteCount, 1);
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.equal(store.records.findLast((record) => record.recordType === 'checkpoint'
    && record.operationId === 'candidate-cleanup-delete').payload.outcome, 'applied');
  assert.deepEqual(store.records.at(-1).payload.responseLossOperationIds, []);
});

test('first promotion adopts a landed stable deployment without replacing it', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
  });
  const cleanupIdentity = releaseMutationPlanIdentity(
    plan, plan.operations.find(({ id }) => id === 'candidate-cleanup-delete'),
  );
  await appendTestMutationCheckpoint(store, {
    operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
    reconcileKind: 'cloud-run-service-delete', plan,
    safeResult: {
      kind: 'resource', state: 'absent', identitySha256: cleanupIdentity.specSha256,
      valueSha256: createHash('sha256')
        .update(JSON.stringify(canonicalFixture(cleanupIdentity.expectedAfter.observation))).digest('hex'),
    },
  });
  await appendTestMutationIntent(store, {
    operationId: 'promote-stable-deploy', mutationOrdinal: 3,
    reconcileKind: 'cloud-run-service-replace', plan,
    beforeObservation: { state: 'absent' },
  });
  let stablePolicy = stablePrivateIam('stable-private-landed');
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv[1] === 'revisions') return structuredClone(plan.expectedStable);
      if (argv.includes('get-iam-policy')) return structuredClone(stablePolicy);
      if (argv[1] === 'services' && argv[2] === 'replace') {
        throw new Error('landed stable deployment must not be repeated');
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return stableStagedReadback(plan);
      }
      if (argv.includes('add-iam-policy-binding')) {
        stablePolicy = stablePublicIam('stable-public-after-landed-stable');
        return structuredClone(stablePolicy);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv[1] === 'services'
    && argv[2] === 'replace'), false);
  assert.equal(calls.some((argv) => argv.includes('add-iam-policy-binding')), true);
});

test('first promotion retries an unperformed journaled stable deployment exactly once', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
  });
  const cleanupIdentity = releaseMutationPlanIdentity(
    plan, plan.operations.find(({ id }) => id === 'candidate-cleanup-delete'),
  );
  await appendTestMutationCheckpoint(store, {
    operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
    reconcileKind: 'cloud-run-service-delete', plan,
    safeResult: {
      kind: 'resource', state: 'absent', identitySha256: cleanupIdentity.specSha256,
      valueSha256: createHash('sha256')
        .update(JSON.stringify(canonicalFixture(cleanupIdentity.expectedAfter.observation))).digest('hex'),
    },
  });
  await appendTestMutationIntent(store, {
    operationId: 'promote-stable-deploy', mutationOrdinal: 3,
    reconcileKind: 'cloud-run-service-replace', plan,
    beforeObservation: { state: 'absent' },
  });
  let stableExists = false;
  let stablePolicy = stablePrivateIam('stable-private-after-deploy-retry');
  let replaceCount = 0;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    openStateStore: async () => store,
    writeStableSpec: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv[1] === 'revisions') return structuredClone(plan.expectedStable);
      if (argv.includes('get-iam-policy')) return structuredClone(stablePolicy);
      if (argv[1] === 'services' && argv[2] === 'replace') {
        replaceCount += 1;
        stableExists = true;
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE || !stableExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return stableStagedReadback(plan);
      }
      if (argv.includes('add-iam-policy-binding')) {
        stablePolicy = stablePublicIam('stable-public-after-deploy-retry');
        return structuredClone(stablePolicy);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(replaceCount, 1);
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.equal(store.records.findLast((record) => record.recordType === 'checkpoint'
    && record.operationId === 'promote-stable-deploy').payload.outcome, 'applied');
  assert.deepEqual(store.records.at(-1).payload.responseLossOperationIds, []);
});

test('first-promotion retries reject a durable before-state mismatch before delete or replace', async (t) => {
  await t.test('candidate deletion', async () => {
    const input = releaseInput({ previousRevision: null, previousImageDigest: null });
    const plan = buildReleasePlan(input);
    const store = createTestStateStore();
    await appendTestPrivacyCheckpoint(store, {
      operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
    });
    await appendTestMutationIntent(store, {
      operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
      reconcileKind: 'cloud-run-service-delete', plan,
      beforeObservation: {
        ...candidateServiceReadback(plan),
        resourceVersion: 'durable-intent-version',
      },
    });
    const calls = [];
    const result = await runGcpRelease({
      argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
      openStateStore: async () => store,
      execute: async (argv) => {
        calls.push(argv);
        if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
        if (argv[1] === 'services' && argv[2] === 'delete') {
          throw new Error('before-state drift must block candidate deletion');
        }
        if (argv[1] === 'services' && argv[2] === 'describe') {
          if (argv[3] === STABLE_SERVICE) {
            throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
          }
          return {
            ...candidateServiceReadback(plan),
            resourceVersion: 'current-version',
          };
        }
        if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
        if (argv.includes('get-iam-policy')) return candidatePrivateIam();
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
        throw new Error(`unexpected operation: ${argv.join(' ')}`);
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
    assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(calls.some((argv) => argv[1] === 'services'
      && argv[2] === 'describe' && argv[3] === CANDIDATE_SERVICE), true);
    assert.equal(calls.some((argv) => argv[1] === 'services'
      && argv[2] === 'delete'), false);
  });

  await t.test('stable deployment', async () => {
    const input = releaseInput({ previousRevision: null, previousImageDigest: null });
    const plan = buildReleasePlan(input);
    const store = createTestStateStore();
    await appendTestPrivacyCheckpoint(store, {
      operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
    });
    const cleanupIdentity = releaseMutationPlanIdentity(
      plan, plan.operations.find(({ id }) => id === 'candidate-cleanup-delete'),
    );
    await appendTestMutationCheckpoint(store, {
      operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
      reconcileKind: 'cloud-run-service-delete', plan,
      safeResult: {
        kind: 'resource', state: 'absent', identitySha256: cleanupIdentity.specSha256,
        valueSha256: createHash('sha256')
          .update(JSON.stringify(canonicalFixture(cleanupIdentity.expectedAfter.observation)))
          .digest('hex'),
      },
    });
    await appendTestMutationIntent(store, {
      operationId: 'promote-stable-deploy', mutationOrdinal: 3,
      reconcileKind: 'cloud-run-service-replace', plan,
      beforeObservation: { state: 'absent', witness: 'durable-intent-version' },
    });
    const calls = [];
    const result = await runGcpRelease({
      argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
      openStateStore: async () => store,
      writeStableSpec: async () => true,
      execute: async (argv) => {
        calls.push(argv);
        if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
        if (argv[1] === 'services' && argv[2] === 'replace') {
          throw new Error('before-state drift must block stable deployment');
        }
        if (argv[1] === 'services' && argv[2] === 'describe') {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        throw new Error(`unexpected operation: ${argv.join(' ')}`);
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
    assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(calls.some((argv) => argv[1] === 'services'
      && argv[2] === 'describe' && argv[3] === STABLE_SERVICE), true);
    assert.equal(calls.some((argv) => argv[1] === 'services'
      && argv[2] === 'replace'), false);
  });
});

test('expired first-promotion proof checkpoint closes for re-proof before candidate deletion', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
  });
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    openStateStore: async () => store,
    now: () => new Date('2026-08-27T08:05:00.000Z'),
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[1] === 'services' && argv[2] === 'delete') {
        throw new Error('expired proof must not delete candidate');
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === STABLE_SERVICE) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return candidateServiceReadback(plan);
      }
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv.includes('get-iam-policy')) return candidatePrivateIam();
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.code, 'PROMOTION_REPROOF_REQUIRED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((argv) => argv[1] === 'services' && argv[2] === 'delete'), false);
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('first promotion resumes after durable candidate absence without recreating candidate', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestPrivacyCheckpoint(store, {
    operationId: 'promote-privacy-publish', mutationOrdinal: 1, plan,
  });
  const cleanupIdentity = releaseMutationPlanIdentity(
    plan, plan.operations.find(({ id }) => id === 'candidate-cleanup-delete'),
  );
  await appendTestMutationCheckpoint(store, {
    operationId: 'candidate-cleanup-delete', mutationOrdinal: 2,
    reconcileKind: 'cloud-run-service-delete', plan,
    safeResult: {
      kind: 'resource', state: 'absent', identitySha256: cleanupIdentity.specSha256,
      valueSha256: createHash('sha256')
        .update(JSON.stringify(canonicalFixture(cleanupIdentity.expectedAfter.observation))).digest('hex'),
    },
  });
  let stableExists = false;
  let stablePolicy = stablePrivateIam();
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    openStateStore: async () => store,
    now: () => new Date('2026-08-27T08:06:00.000Z'),
    writeStableSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv[1] === 'revisions') return structuredClone(plan.expectedStable);
      if (argv.includes('get-iam-policy')) return structuredClone(stablePolicy);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE || !stableExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'replace') {
        stableExists = true;
        return stableStagedReadback(plan);
      }
      if (argv.includes('add-iam-policy-binding')) {
        stablePolicy = stablePublicIam('public-after-resume');
        return structuredClone(stablePolicy);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv[1] === 'services' && argv[2] === 'delete'), false);
  assert.equal(calls.some((argv) => argv[1] === 'services' && argv[2] === 'replace'), true);
});

test('first promotion blocks on foreign staged state without compensation', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  let stableExists = false;
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    writeStableSpec: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : stablePrivateIam();
      if (argv[1] === 'revisions') return argv[3] === plan.candidateRevision
        ? structuredClone(plan.expectedCandidate) : structuredClone(plan.expectedStable);
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
        stableExists = true;
        return stableStagedReadback(plan);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) return candidateServiceReadback(plan);
        if (!stableExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return {
          service: STABLE_SERVICE,
          invokerIamDisabled: false,
          serviceMaxScale: 1,
          traffic: [{ revision: `${STABLE_SERVICE}-foreign000000`, percent: 100 }],
        };
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
});

test('candidate cleanup is receipt-bound and recovers a lost delete response without stable mutation', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  let candidateExists = true;
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=candidate-cleanup', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv.includes('get-iam-policy')) return candidatePrivateIam();
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv[1] === 'services' && argv[2] === 'delete') {
        candidateExists = false;
        throw new Error('delete response was lost');
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (!candidateExists) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return candidateServiceReadback(plan);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.deepEqual(result.publicReport.responseLossRecoveries, ['candidate-cleanup-delete']);
  assert.equal(candidateExists, false);
  assert.equal(calls.some((argv) => argv[1] === 'services' && argv[2] === 'delete'
    && argv[3] === CANDIDATE_SERVICE), true);
  assert.equal(calls.some((argv) => argv.includes(STABLE_SERVICE)), false);

  let invalidReceiptCalls = 0;
  const invalidReceipt = await runGcpRelease({
    argv: ['--phase=candidate-cleanup', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async (releasePlan, { through }) => {
      const chain = structuredClone(fixtureReceiptChain(releasePlan, through));
      chain.at(-1).outputs.revision = `${CANDIDATE_SERVICE}-foreign000000`;
      return chain;
    },
    execute: async () => { invalidReceiptCalls += 1; throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(invalidReceipt.exitCode, 1);
  assert.equal(invalidReceipt.publicReport.code, 'RELEASE_RECEIPT_CHAIN_INVALID');
  assert.equal(invalidReceiptCalls, 0);

  let rollbackCalls = 0;
  const rollback = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: async () => { rollbackCalls += 1; throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(rollback.exitCode, 1);
  assert.equal(rollback.publicReport.code, 'ROLLBACK_UNAVAILABLE_NO_PRIOR_RELEASE');
  assert.equal(rollbackCalls, 0);
});

test('restart adopts a durable cleanup intent from exact absence without repeating delete', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input);
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'candidate-cleanup-delete',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-service-delete',
    plan,
  });
  store.appendIntent = async () => { throw new Error('restart must not append a duplicate intent'); };
  const checkpoints = [];
  const appendCheckpoint = store.appendCheckpoint;
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=candidate-cleanup', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
      }
      throw new Error(`restart attempted a mutation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(result.publicReport.candidateCleanupState, 'deleted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'describe');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
  assert.equal(result.publicReport.phaseReceipt.phase, 'candidate-cleanup');
  assert.equal(result.publicReport.phaseReceipt.receiptType, 'action-outcome');
  assert.equal(result.publicReport.phaseReceipt.attemptId, store.attemptId);
  assert.equal(result.publicReport.phaseReceipt.receiptHeadSha256,
    fixtureReceiptChain(plan, 'candidate').at(-1).receiptSha256);
  assert.deepEqual(result.publicReport.phaseReceipt.operationOutcomes.map((value) => ({
    operationId: value.operationId, outcome: value.outcome,
  })), [{ operationId: 'candidate-cleanup-delete', outcome: 'adopted-restart' }]);
  const otherAttempt = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.notEqual(
    releaseActionReceiptPath(plan, 'candidate-cleanup', store.attemptId),
    releaseActionReceiptPath(plan, 'candidate-cleanup', otherAttempt),
  );
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('candidate deployment uses a controlled Service YAML and never the unsupported deploy readiness flag', () => {
  const plan = buildReleasePlan(releaseInput());
  const candidate = plan.operations.find(({ id }) => id === 'candidate-deploy');
  assert.deepEqual(candidate.argv.slice(0, 3), ['run', 'services', 'replace']);
  assert.equal(candidate.argv.some((value) => value.startsWith('--readiness-probe=')), false);
  assert.equal(candidate.argv.some((value) => value === 'deploy'), false);

  const publicPreview = plan.operations.find(({ id }) => id === 'candidate-public-service');
  assert.equal(publicPreview, undefined);
  assert.equal(plan.operations.some(({ phase, argv }) => (
    ['candidate', 'candidate-cleanup'].includes(phase) && argv.includes('--member=allUsers')
  )), false);
  assert.equal(plan.operations.some(({ id }) => id === 'promote-public-service'), false);
  const firstReleasePlan = buildReleasePlan(releaseInput({
    previousRevision: null, previousImageDigest: null,
  }));
  assert.equal(firstReleasePlan.operations.some(({ id }) => id === 'promote-public-service'), true);
  assert.equal(plan.operations.some(({ id }) => id === 'candidate-cleanup-public-service'), false);
});

test('empty-host bootstrap is allowed only on canonical NOT_FOUND and creates a private tagged 100-percent candidate', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input, { phase: 'candidate' });
  assert.deepEqual(plan.candidateServiceSpec.spec.traffic, [{
    revisionName: REVISION, tag: CANDIDATE_TAG, percent: 100,
  }]);
  assert.deepEqual(plan.expectedCandidate.traffic, [{
    revision: REVISION, tag: CANDIDATE_TAG, percent: 100,
  }]);
  assert.deepEqual(plan.candidateAccess, {
    authenticated: true,
    audience: CANDIDATE_ROOT,
    issuer: 'https://accounts.google.com',
    subjectSha256: QA_SUBJECT_SHA256,
    taggedUrl: CANDIDATE_ORIGIN,
  });
  let candidateServiceDescribeCount = 0;
  let iamGranted = false;
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`], input,
    writeCandidateSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === STABLE_SERVICE) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        candidateServiceDescribeCount += 1;
        if (candidateServiceDescribeCount === 1) {
          throw Object.assign(new Error('not found'), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
        }
        return { service: CANDIDATE_SERVICE, invokerIamDisabled: false, serviceMaxScale: 1, traffic: [
          { revision: REVISION, tag: CANDIDATE_TAG, percent: 100 },
        ] };
      }
      if (argv.includes('--dry-run')) return structuredClone(plan.candidateServiceSpec);
      if (argv[1] === 'services' && argv[2] === 'replace') {
        return candidateServiceReadback(plan);
      }
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv.includes('get-iam-policy')) return iamGranted
        ? candidatePrivateIam('candidate-private-granted')
        : stablePrivateIam('candidate-private-baseline');
      if (argv.includes('add-iam-policy-binding')) {
        iamGranted = true;
        return candidatePrivateIam('candidate-private-granted');
      }
      if (argv[0] === 'artifacts') return artifactReadback(plan.expectedCandidate.image);
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv.includes('--member=allUsers')), false);
  assert.equal(calls.some((argv) => argv.includes('update-traffic')), false);
  assert.equal(result.publicReport.phaseReceipt.outputs.trafficState, 'candidate-service-private-100');
  assert.equal(result.publicReport.phaseReceipt.outputs.trafficPercent, 100);
  assert.equal(result.publicReport.phaseReceipt.outputs.priorRelease, null);

  for (const error of [
    Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }),
    Object.assign(new Error('generic absence is ambiguous'), { code: 'NOT_FOUND' }),
    new Error('not found text without canonical code'),
  ]) {
    const rejectedCalls = [];
    const rejected = await runGcpRelease({
      argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`], input,
      writeCandidateSpec: async () => true,
      execute: async (argv) => { rejectedCalls.push(argv); throw error; },
      writeOutput: () => undefined,
    });
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.publicReport.mutationPerformed, false);
    assert.equal(rejectedCalls.length, 1);
  }
});

test('first-release Service API traffic requires explicit percent and an exact tag URL', () => {
  const plan = buildReleasePlan(releaseInput({ previousRevision: null, previousImageDigest: null }));
  const opaqueRoot = 'https://provider-opaque-identifier.run.app';
  const opaqueTagUrl = `https://${CANDIDATE_TAG}---provider-opaque-identifier.run.app`;
  const serviceReadback = () => ({
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: CANDIDATE_SERVICE,
      annotations: {
        'run.googleapis.com/maxScale': '1',
        'run.googleapis.com/urls': JSON.stringify([CANDIDATE_ROOT, opaqueRoot]),
      },
    },
    status: {
      address: { url: opaqueRoot },
      url: opaqueRoot,
      traffic: [{
        revisionName: REVISION, tag: CANDIDATE_TAG, url: opaqueTagUrl, percent: 100,
      }],
    },
  });
  assert.doesNotThrow(() => validateCandidateControlPlaneReadbacks({
    service: serviceReadback(),
    revision: structuredClone(plan.expectedCandidate),
    iam: candidatePrivateIam(),
    artifact: artifactReadback(plan.expectedCandidate.image),
  }, plan));
  const rejects = [
    (service) => { delete service.metadata.annotations['run.googleapis.com/maxScale']; },
    (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = '10'; },
    (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = 1; },
    (service) => { service.status.traffic[0].percent = 0; },
    (service) => { delete service.status.traffic[0].percent; },
    (service) => {
      service.metadata.annotations['run.googleapis.com/urls'] = JSON.stringify([opaqueRoot]);
    },
    (service) => { service.status.address.url = CANDIDATE_ROOT; },
    (service) => {
      service.status.traffic[0].url = `https://${CANDIDATE_TAG}---undeclared.run.app`;
    },
  ];
  for (const mutate of rejects) {
    const service = serviceReadback();
    mutate(service);
    assert.throws(() => validateCandidateControlPlaneReadbacks({
      service,
      revision: structuredClone(plan.expectedCandidate),
      iam: candidatePrivateIam(),
    artifact: artifactReadback(plan.expectedCandidate.image),
    }, plan), /candidate service readback/i);
  }
});

test('authoritative stable Service traffic readback rejects missing or drifted maxScale', () => {
  const opaqueRoot = 'https://provider-opaque-stable-identifier.run.app';
  const serviceReadback = () => ({
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: STABLE_SERVICE,
      annotations: {
        'run.googleapis.com/maxScale': '1',
        'run.googleapis.com/urls': JSON.stringify([STABLE_ORIGIN, opaqueRoot]),
      },
    },
    status: {
      address: { url: opaqueRoot },
      url: opaqueRoot,
      traffic: [{ revisionName: STABLE_REVISION, percent: 100 }],
    },
  });
  assert.equal(validateTrafficReceipt(serviceReadback(), { revision: STABLE_REVISION }), true);
  for (const mutate of [
    (service) => { delete service.metadata.annotations['run.googleapis.com/maxScale']; },
    (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = '10'; },
    (service) => { service.metadata.annotations['run.googleapis.com/maxScale'] = 1; },
  ]) {
    const service = serviceReadback();
    mutate(service);
    assert.throws(
      () => validateTrafficReceipt(service, { revision: STABLE_REVISION }),
      /traffic readback/i,
    );
  }
});

test('later rollback validates immutable receipts and fresh revision/image/service/evidence before traffic mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const forged = fixtureReceiptChain(plan, 'mobile').map((value) => structuredClone(value));
  forged.find(({ phase }) => phase === 'candidate').outputs.priorRelease.imageDigest
    = `sha256:${'e'.repeat(64)}`;
  const forgedCalls = [];
  const forgedResult = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => forged,
    execute: async (argv) => { forgedCalls.push(argv); throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(forgedResult.exitCode, 1);
  assert.equal(forgedResult.publicReport.code, 'RELEASE_RECEIPT_CHAIN_INVALID');
  assert.deepEqual(forgedCalls, []);

  const calls = [];
  const driftResult = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return { service: 'hkbuddy-v1-api', invokerIamDisabled: false, serviceMaxScale: 1, traffic: [{ revision: REVISION, percent: 100 }] };
      }
      if (argv[1] === 'revisions' && argv[3] === REVISION) {
        return structuredClone(plan.expectedCandidate);
      }
      if (argv[0] === 'artifacts') return artifactReadback(plan.image);
      if (argv[1] === 'revisions' && argv[3] === input.previousRevision) {
        return { revision: 'hkbuddy-v1-api-222222222222', image: plan.previousImage };
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(driftResult.exitCode, 1);
  assert.equal(driftResult.publicReport.mutationPerformed, false);
  assert.equal(calls.some((argv) => argv.includes('update-traffic')), false);

  const staleImageCalls = [];
  const staleImageResult = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      staleImageCalls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return { service: 'hkbuddy-v1-api', invokerIamDisabled: false, serviceMaxScale: 1, traffic: [{ revision: REVISION, percent: 100 }] };
      }
      if (argv[1] === 'revisions') return argv[3] === input.previousRevision
        ? { revision: input.previousRevision, image: plan.previousImage }
        : structuredClone(plan.expectedCandidate);
      if (argv[0] === 'artifacts') return argv.includes(plan.previousImage)
        ? artifactReadback(`${plan.previousImage.slice(0, -64)}${'f'.repeat(64)}`)
        : artifactReadback(plan.image);
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(staleImageResult.exitCode, 1);
  assert.equal(staleImageResult.publicReport.mutationPerformed, false);
  assert.equal(staleImageCalls.some((argv) => argv.includes('update-traffic')), false);
});

test('rollback restart adopts exact prior traffic and never repeats the final traffic mutation', async () => {
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'rollback-traffic',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-traffic',
  });
  store.appendIntent = async () => { throw new Error('restart must not append a second intent'); };
  const checkpoints = [];
  const appendCheckpoint = store.appendCheckpoint;
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv.includes('get-iam-policy')) return stablePublicIam();
      assert.deepEqual(argv.slice(0, 4), ['run', 'services', 'describe', STABLE_SERVICE]);
      return stablePriorReadback(plan);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((argv) => argv.includes('update-traffic')), false);
  assert.equal(calls.length, 3);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
  assert.equal(result.publicReport.phaseReceipt.phase, 'rollback');
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('changed release archive bytes are rejected before the first Cloud Build mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-release-build-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceArchive = join(directory, 'source.tar.gz');
  const buildConfigContents = 'steps: []\n';
  const buildConfigSha256 = createHash('sha256').update(buildConfigContents).digest('hex');
  const buildConfig = join(directory, `${RELEASE_SHA}.${buildConfigSha256}.cloudbuild.yaml`);
  await writeFile(buildConfig, buildConfigContents);
  await writeFile(sourceArchive, 'original archive bytes');
  const claimed = createHash('sha256').update('original archive bytes').digest('hex');
  await writeFile(sourceArchive, 'changed after manifest freeze');
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      sourceArchive,
      sourceArchiveSha256: claimed,
      buildConfig,
      buildConfigSha256,
      imageDigest: null,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
      previousImageDigest: null,
    }),
    execute: async (argv) => { calls.push(argv); throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('receipt idempotency metadata rejects symlinks and non-files before byte reads', async () => {
  const module = await import('../scripts/gcp-release.js');
  assert.throws(() => module.assertReceiptIdempotencyMetadata({
    isFile: () => true,
    isSymbolicLink: () => true,
  }), /receipt|symlink/i);
  assert.throws(() => module.assertReceiptIdempotencyMetadata({
    isFile: () => false,
    isSymbolicLink: () => false,
  }), /receipt|file/i);
  assert.equal(module.assertReceiptIdempotencyMetadata({
    isFile: () => true,
    isSymbolicLink: () => false,
  }), true);
});

test('receipt idempotency rejects an EEXIST directory junction before reading target bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-receipt-junction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceArchive = join(directory, 'source.tar.gz');
  const input = releaseInput({
    sourceArchive,
    buildConfig: join(directory, `${RELEASE_SHA}.${BUILD_CONFIG_SHA}.cloudbuild.yaml`),
  });
  const plan = buildReleasePlan(input);
  const receipt = fixtureReceiptChain(plan, 'build')[0];
  await mkdir(plan.releaseReceiptDirectory);
  const target = join(directory, 'forged-receipt-directory');
  await mkdir(target);
  await writeFile(join(target, 'target-bytes.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  await symlink(target, plan.releaseReceiptPaths.build, 'junction');
  const module = await import('../scripts/gcp-release.js');
  let reads = 0;
  await assert.rejects(
    () => module.persistReleaseReceipt(plan, receipt, {
      readExisting: async () => { reads += 1; throw new Error('target bytes were read'); },
    }),
    /receipt|symlink/i,
  );
  assert.equal(reads, 0);
});

test('Cloud Build receipt requires the exact generation-bound SHA256 source provenance', () => {
  const sourceHash = Buffer.from(SOURCE_SHA, 'hex').toString('base64');
  const build = exactCloudBuildReceipt();
  assert.doesNotThrow(() => validateBuildReceipt(build, {
    releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
    buildConfigSha256: BUILD_CONFIG_SHA,
  }));
  for (const sourceProvenance of [
    {},
    { ...build.sourceProvenance, fileHashes: {} },
    {
      ...build.sourceProvenance,
      fileHashes: {
        'gs://hkbuddy-v1-582852715831-build-source/source/source.tar.gz#123': {
          fileHash: [{ type: 'SHA256', value: Buffer.from('f'.repeat(64), 'hex').toString('base64') }],
        },
      },
    },
    {
      ...build.sourceProvenance,
      fileHashes: {
        'gs://hkbuddy-v1-582852715831-build-source/source/source.tar.gz': {
          fileHash: [{ type: 'SHA256', value: sourceHash }],
        },
      },
    },
  ]) {
    assert.throws(() => validateBuildReceipt({ ...build, sourceProvenance }, {
      releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
      buildConfigSha256: BUILD_CONFIG_SHA,
    }), /Cloud Build receipt/i);
  }
});

test('evidence validation rejects a forged self-reported semantic digest even when object bytes match', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-forged-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'forged.json');
  const artifactSha256 = '7'.repeat(64);
  const contents = `${JSON.stringify({
    schemaVersion: 1, commitSha: RELEASE_SHA, result: true, artifactSha256,
  })}\n`;
  await writeFile(filePath, contents);
  await assert.rejects(() => validateEvidenceArtifactFile({
    filePath,
    artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
  }, { releaseSha: RELEASE_SHA }), /evidence artifact/i);
});

test('release evidence recursively rejects persisted authorization and token material', () => {
  for (const value of [
    { trace: { request: { headers: { Authorization: 'redacted' } } } },
    { screenshot: { metadata: { note: `Bearer ${'x'.repeat(40)}` } } },
    { events: [{ evidence: `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(20)}` }] },
    { nested: [{ id_token: 'redacted' }] },
  ]) assert.equal(containsForbiddenPersistedSecret(value), true);

  assert.equal(containsForbiddenPersistedSecret({
    access: {
      authenticated: true,
      audience: STABLE_ORIGIN,
      issuer: 'https://accounts.google.com',
      subjectSha256: QA_SUBJECT_SHA256,
      taggedUrl: CANDIDATE_ORIGIN,
    },
    evidence: 'Authenticated request returned the expected candidate release binding.',
  }), false);
});

test('migration refuses execution when the exact deployed Job readback drifts', async () => {
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      evidence: null, acceptanceOutputs: null, previousRevision: null, previousImageDigest: null,
    }),
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'describe') return { serviceAccount: 'unexpected@example.invalid' };
      return { done: true };
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.some((argv) => argv[2] === 'execute'), false);
});

test('migration execution accepts the real Cloud Run Jobs v1 terminal success shape', () => {
  const execution = {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Execution',
    metadata: {
      name: 'hkbuddy-v1-migrate-release-001',
      labels: { 'run.googleapis.com/job': 'hkbuddy-v1-migrate' },
    },
    spec: { taskCount: 1, parallelism: 1 },
    status: {
      conditions: [{ type: 'Completed', status: 'True' }],
      completionTime: '2026-08-26T08:00:00.000Z',
      runningCount: 0,
      succeededCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      retriedCount: 0,
    },
  };
  assert.deepEqual(validateMigrationExecutionReceipt(execution, { releaseSha: RELEASE_SHA }), {
    name: 'hkbuddy-v1-migrate-release-001',
    job: 'hkbuddy-v1-migrate',
    taskCount: 1,
    parallelism: 1,
    succeededCount: 1,
    completionTime: '2026-08-26T08:00:00.000Z',
  });
  const omittedZeroCounters = structuredClone(execution);
  for (const key of ['runningCount', 'failedCount', 'cancelledCount', 'retriedCount']) {
    delete omittedZeroCounters.status[key];
  }
  assert.deepEqual(
    validateMigrationExecutionReceipt(omittedZeroCounters, { releaseSha: RELEASE_SHA }),
    validateMigrationExecutionReceipt(execution, { releaseSha: RELEASE_SHA }),
  );
  for (const mutate of [
    (value) => { value.status.conditions[0].status = 'False'; },
    (value) => { value.status.succeededCount = 0; },
    (value) => { value.status.failedCount = 1; },
    (value) => { value.status.cancelledCount = 1; },
    (value) => { value.status.runningCount = 1; },
    (value) => { delete value.status.completionTime; },
  ]) {
    const drift = structuredClone(execution);
    mutate(drift);
    assert.throws(
      () => validateMigrationExecutionReceipt(drift, { releaseSha: RELEASE_SHA }),
      /migration execution receipt/i,
    );
  }
});

test('Job deploy restart blocks on a drifted first authoritative observation', async () => {
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'migration-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace',
  });
  const input = releaseInput({
    evidence: null,
    acceptanceOutputs: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'migration' });
  let describeCount = 0;
  let executeCount = 0;
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      if (argv[2] === 'deploy') throw new Error('restart must not redeploy the Job');
      if (argv[2] === 'describe') {
        describeCount += 1;
        const receipt = realV1JobReadback(plan.expectedMigrationJob);
        if (describeCount === 1) receipt.metadata.name = 'foreign-job';
        return receipt;
      }
      if (argv[2] === 'execute') {
        executeCount += 1;
        return {
          apiVersion: 'run.googleapis.com/v1',
          kind: 'Execution',
          metadata: {
            name: 'hkbuddy-v1-migrate-release-001',
            labels: { 'run.googleapis.com/job': 'hkbuddy-v1-migrate' },
          },
          spec: { taskCount: 1, parallelism: 1 },
          status: {
            conditions: [{ type: 'Completed', status: 'True' }],
            completionTime: '2026-08-26T08:00:00.000Z',
            succeededCount: 1,
          },
        };
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(executeCount, 0);
  assert.equal(describeCount, 1);
});

test('Job deploy readback never checkpoints or executes while Ready is false', async () => {
  const store = createTestStateStore();
  const input = releaseInput({
    evidence: null,
    acceptanceOutputs: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'migration' });
  const notReady = realV1JobReadback(plan.expectedMigrationJob);
  notReady.status.conditions[0] = {
    type: 'Ready', status: 'False', reason: 'SecretsAccessCheckFailed',
  };
  let executeCount = 0;
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      if (argv[2] === 'deploy') return { metadata: { name: plan.expectedMigrationJob.job } };
      if (argv[2] === 'describe') return structuredClone(notReady);
      if (argv[2] === 'execute') executeCount += 1;
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(executeCount, 0);
  assert.equal(store.records.filter(({ recordType }) => recordType === 'checkpoint').length, 0);
  assert.equal(store.records.at(-1).recordType, 'intent');
  assert.equal(store.records.at(-1).operationId, 'migration-deploy');
});

test('partial Job deploy checkpoints are revalidated before a resumed execute intent', async (t) => {
  const cases = [
    {
      name: 'migration Ready=False',
      phase: 'migration',
      deployOperationId: 'migration-deploy',
      executeOperationId: 'migration-execute',
      mutate(value) { value.status.conditions[0].status = 'False'; },
    },
    {
      name: 'migration UID drift',
      phase: 'migration',
      deployOperationId: 'migration-deploy',
      executeOperationId: 'migration-execute',
      mutate(value) { value.metadata.uid = '223e4567-e89b-42d3-a456-426614174000'; },
    },
    {
      name: 'migration generation drift',
      phase: 'migration',
      deployOperationId: 'migration-deploy',
      executeOperationId: 'migration-execute',
      mutate(value) {
        value.metadata.generation = 2;
        value.status.observedGeneration = 2;
      },
    },
    {
      name: 'acceptance Ready=False',
      phase: 'acceptance',
      deployOperationId: 'dependency-acceptance-deploy',
      executeOperationId: 'dependency-acceptance-execute',
      mutate(value) { value.status.conditions[0].status = 'False'; },
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const input = releaseInput({
        evidence: null,
        acceptanceOutputs: null,
        previousRevision: null,
        previousImageDigest: null,
      });
      const plan = buildReleasePlan(input, { phase: current.phase });
      const expectedJob = current.phase === 'migration' ? plan.expectedMigrationJob
        : plan.expectedJobs['dependency-acceptance'];
      const checkpointedJob = realV1JobReadback(expectedJob);
      const store = createTestStateStore();
      await appendTestMutationCheckpoint(store, {
        operationId: current.deployOperationId,
        mutationOrdinal: 1,
        reconcileKind: 'cloud-run-job-replace',
        plan,
        safeResult: cloudRunJobSafeResult(
          plan, current.deployOperationId, checkpointedJob,
        ),
      });
      const liveJob = structuredClone(checkpointedJob);
      current.mutate(liveJob);
      let describeCount = 0;
      let executeCount = 0;
      const result = await runGcpRelease({
        argv: [`--phase=${current.phase}`, `--confirm-release=${RELEASE_SHA}`],
        input,
        openStateStore: async () => store,
        execute: async (argv) => {
          if (argv[2] === 'describe') {
            describeCount += 1;
            return structuredClone(liveJob);
          }
          if (argv[2] === 'execute') executeCount += 1;
          throw new Error(`unexpected operation: ${argv.join(' ')}`);
        },
        writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(describeCount, 1, JSON.stringify({
        publicReport: result.publicReport,
        records: store.records,
      }));
      assert.equal(executeCount, 0);
      assert.deepEqual(store.records.map(({ recordType }) => recordType), [
        'intent', 'checkpoint',
      ]);
      assert.equal(store.records.some(({ operationId }) => (
        operationId === current.executeOperationId
      )), false);
    });
  }
});

test('first-release candidate rejects a live stable service before any mutation', async () => {
  const input = releaseInput({ previousRevision: null, previousImageDigest: null });
  const plan = buildReleasePlan(input, { phase: 'candidate' });
  const candidate = plan.operations.filter(({ phase }) => phase === 'candidate');
  assert.equal(candidate[0].id, 'candidate-stable-service-precheck');
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe'
        && argv[3] === STABLE_SERVICE) {
        return {
          service: STABLE_SERVICE,
          invokerIamDisabled: false,
          serviceMaxScale: 1,
          traffic: [{ revision: `${STABLE_SERVICE}-existing0000`, tag: null, percent: 100 }],
        };
      }
      throw new Error(`mutation became reachable: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls.some((argv) => argv.includes('replace')
    || argv.includes('add-iam-policy-binding')), false);
});

test('an exact partial Job deploy checkpoint resumes execute only after fresh authority', async () => {
  const input = releaseInput({
    evidence: null,
    acceptanceOutputs: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'migration' });
  const liveJob = realV1JobReadback(plan.expectedMigrationJob);
  const store = createTestStateStore();
  await appendTestMutationCheckpoint(store, {
    operationId: 'migration-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace',
    plan,
    safeResult: cloudRunJobSafeResult(plan, 'migration-deploy', liveJob),
  });
  let describeCount = 0;
  let executeCount = 0;
  let listCount = 0;
  const execution = {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Execution',
    metadata: {
      name: 'hkbuddy-v1-migrate-release-001',
      labels: { 'run.googleapis.com/job': 'hkbuddy-v1-migrate' },
    },
    spec: { taskCount: 1, parallelism: 1 },
    status: {
      conditions: [{ type: 'Completed', status: 'True' }],
      completionTime: '2026-08-26T08:00:00.000Z',
      succeededCount: 1,
    },
  };
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      if (argv[2] === 'describe') {
        describeCount += 1;
        return structuredClone(liveJob);
      }
      if (argv[2] === 'executions' && argv[3] === 'list') {
        listCount += 1;
        return [];
      }
      if (argv[2] === 'execute') {
        executeCount += 1;
        return structuredClone(execution);
      }
      if (argv[2] === 'executions') return structuredClone(execution);
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(describeCount, 1, JSON.stringify({
    publicReport: result.publicReport,
    records: store.records,
  }));
  assert.equal(listCount, 1);
  assert.equal(executeCount, 1);
  const executeIntent = store.records.find(({ recordType, operationId }) => (
    recordType === 'intent' && operationId === 'migration-execute'
  ));
  assert.deepEqual(executeIntent.payload.executionBaseline,
    cloudRunExecutionBaseline(plan.expectedMigrationJob, []));
});

test('an ambiguous pre-execution snapshot blocks before the execute intent and request', async (t) => {
  for (const current of ['foreign execution scope', 'list read failure']) {
    await t.test(current, async () => {
      const input = releaseInput({
        evidence: null, acceptanceOutputs: null,
        previousRevision: null, previousImageDigest: null,
      });
      const plan = buildReleasePlan(input, { phase: 'migration' });
      const liveJob = realV1JobReadback(plan.expectedMigrationJob);
      const store = createTestStateStore();
      await appendTestMutationCheckpoint(store, {
        operationId: 'migration-deploy', mutationOrdinal: 1,
        reconcileKind: 'cloud-run-job-replace', plan,
        safeResult: cloudRunJobSafeResult(plan, 'migration-deploy', liveJob),
      });
      let executeCount = 0;
      const result = await runGcpRelease({
        argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
        input,
        openStateStore: async () => store,
        execute: async (argv) => {
          if (argv[2] === 'describe') return structuredClone(liveJob);
          if (argv[2] === 'executions' && argv[3] === 'list') {
            if (current === 'list read failure') throw new Error('ambiguous list read');
            const row = cloudRunExecutionListMember(plan.expectedMigrationJob);
            row.metadata.namespace = '999999999999';
            return [row];
          }
          if (argv[2] === 'execute') executeCount += 1;
          throw new Error(`unexpected operation: ${argv.join(' ')}`);
        },
        writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(executeCount, 0);
      assert.equal(store.records.some(({ recordType, operationId }) => (
        recordType === 'intent' && operationId === 'migration-execute'
      )), false);
    });
  }
});

test('Job deploy restart adopts an exact readback without redeploying', async () => {
  const store = createTestStateStore();
  await appendTestMutationIntent(store, {
    operationId: 'migration-deploy',
    mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace',
  });
  const input = releaseInput({
    evidence: null,
    acceptanceOutputs: null,
    previousRevision: null,
    previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'migration' });
  const calls = [];
  const checkpoints = [];
  const appendCheckpoint = store.appendCheckpoint;
  store.appendCheckpoint = async (payload) => {
    checkpoints.push(payload);
    return appendCheckpoint(payload);
  };
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    openStateStore: async () => store,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'deploy') throw new Error('restart must not redeploy the Job');
      if (argv[2] === 'describe') return realV1JobReadback(plan.expectedMigrationJob);
      if (argv[2] === 'executions' && argv[3] === 'list') return [];
      if (argv[2] === 'execute' || argv[2] === 'executions') return {
        apiVersion: 'run.googleapis.com/v1',
        kind: 'Execution',
        metadata: {
          name: 'hkbuddy-v1-migrate-release-001',
          labels: { 'run.googleapis.com/job': 'hkbuddy-v1-migrate' },
        },
        spec: { taskCount: 1, parallelism: 1 },
        status: {
          conditions: [{ type: 'Completed', status: 'True' }],
          completionTime: '2026-08-26T08:00:00.000Z',
          succeededCount: 1,
        },
      };
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(calls.some((argv) => argv[2] === 'deploy'), false);
  assert.equal(calls.filter((argv) => argv[2] === 'execute').length, 1);
  assert.equal(checkpoints[0].outcome, 'adopted-restart');
});

test('Job execution restart without an exact execution identity never executes a duplicate', async () => {
  const store = createTestStateStore();
  const deployIntent = await store.appendIntent({
    mutationOrdinal: 1,
    operationAttemptId: '1'.repeat(32),
    commandSha256: '2'.repeat(64),
    reconcileKind: 'cloud-run-job-replace',
    beforeSha256: '3'.repeat(64),
    afterSha256: '4'.repeat(64),
  }, { operationId: 'migration-deploy' });
  await store.appendCheckpoint({
    intentRecordSha256: deployIntent.recordSha256,
    classification: 'after',
    outcome: 'applied',
    observationSha256: '4'.repeat(64),
    safeResult: { kind: 'none' },
  });
  await store.appendIntent({
    mutationOrdinal: 2,
    operationAttemptId: '5'.repeat(32),
    commandSha256: '6'.repeat(64),
    reconcileKind: 'cloud-run-job-execute',
    beforeSha256: '7'.repeat(64),
    afterSha256: '8'.repeat(64),
  }, { operationId: 'migration-execute' });
  store.appendIntent = async () => { throw new Error('restart must not append intent'); };
  let executorCalls = 0;
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    openStateStore: async () => store,
    execute: async () => { executorCalls += 1; throw new Error('must not execute duplicate Job'); },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(executorCalls, 0);
  assert.equal(store.records.at(-1).recordType, 'intent');
});

test('an exact Cloud Run FAILED_PRECONDITION accepts an unchanged non-empty execution baseline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-execute-rejection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'acceptance' });
  const key = 'dependency-acceptance';
  const job = plan.expectedJobs[key];
  const store = createTestStateStore();
  const deployIntent = await appendTestMutationIntent(store, {
    operationId: `${key}-deploy`, mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace', plan,
  });
  await store.appendCheckpoint({
    intentRecordSha256: deployIntent.recordSha256,
    classification: 'after', outcome: 'adopted-restart',
    observationSha256: deployIntent.payload.afterSha256,
    safeResult: { kind: 'resource', state: 'present', identitySha256: '1'.repeat(64), valueSha256: '2'.repeat(64) },
  });
  const historicalExecutions = [
    cloudRunExecutionListMember(job),
    cloudRunExecutionListMember(job, {
      name: `${job.job}-def34`, uid: '323e4567-e89b-42d3-a456-426614174001',
    }),
  ];
  const jobUid = '12d057cc-bcf8-4192-95fa-bd7527627e46';
  const executeIntent = await appendTestMutationIntent(store, {
    operationId: `${key}-execute`, mutationOrdinal: 2,
    reconcileKind: 'cloud-run-job-execute', plan,
    executionBaseline: cloudRunExecutionBaseline(job, historicalExecutions, { jobUid }),
  });
  executeIntent.createdAt = '2026-09-01T06:42:26.179Z';
  const rejectionMessage = `Job '${job.job}' cannot be run because is in an error state. Please check the job's Ready status condition.`;
  const log = [
    `2026-09-01 14:42:27,212 DEBUG root Running [gcloud.run.jobs.execute] with arguments: [--format: "json", --project: "${PROJECT}", --quiet: "True", --region: "${REGION}", --wait: "True", JOB: "${job.job}"]`,
    `2026-09-01 14:42:27,888 DEBUG urllib3.connectionpool https://${REGION}-run.googleapis.com:443 "POST /apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${job.job}:run?alt=json HTTP/1.1" 400 None`,
    `response: <{'date': 'Tue, 01 Sep 2026 06:42:27 GMT', 'status': 400}>, content <{`,
    '  "error": {',
    '    "code": 400,',
    `    "message": "${rejectionMessage}",`,
    '    "status": "FAILED_PRECONDITION"',
    '  }',
    '}>',
    `2026-09-01 14:42:27,978 ERROR root (gcloud.run.jobs.execute) FAILED_PRECONDITION: ${rejectionMessage}`,
    '',
  ].join('\n');
  const logPath = join(directory, 'execute-rejection.log');
  await writeFile(logPath, log);
  const logSha256 = createHash('sha256').update(log).digest('hex');
  const parsed = validateRejectedCloudRunExecutionLog(Buffer.from(log), {
    expectedLogSha256: logSha256,
    intent: executeIntent,
    job: job.job,
    project: PROJECT,
    region: REGION,
  });
  assert.equal(parsed.httpStatus, 400);
  assert.equal(parsed.rpcStatus, 'FAILED_PRECONDITION');
  assert.equal(parsed.requestObservedAt, '2026-09-01T06:42:27.000Z');

  const liveJob = realV1JobReadback(job);
  liveJob.metadata.uid = jobUid;
  liveJob.metadata.generation = 1;
  liveJob.status = {
    observedGeneration: 1,
    conditions: [{ type: 'Ready', status: 'False', reason: 'SecretsAccessCheckFailed' }],
  };
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'inventory'),
    openStateStore: async () => store,
    environment: {
      V1_REJECTED_EXECUTION_LOG_PATH: logPath,
      V1_REJECTED_EXECUTION_LOG_SHA256: logSha256,
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'describe') return structuredClone(liveJob);
      if (argv[2] === 'executions' && argv[3] === 'list') {
        return structuredClone([...historicalExecutions].reverse());
      }
      throw new Error(`unexpected recovery operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'CLOUD_RUN_EXECUTION_REJECTION_RECOVERED');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls.map((argv) => argv.slice(0, 4)), [
    ['run', 'jobs', 'describe', job.job],
    ['run', 'jobs', 'executions', 'list'],
  ]);
  assert.equal(store.records.at(-2).recordType, 'abort');
  assert.equal(store.records.at(-2).payload.evidence.logSha256, logSha256);
  assert.equal(store.records.at(-2).payload.evidence.executionListSha256,
    executeIntent.payload.executionBaseline.executionSetSha256);
  assert.equal(store.records.at(-1).recordType, 'terminal');
});

test('Cloud Run rejected-command recovery fails closed on every execution-set ambiguity', async (t) => {
  const cases = [
    {
      name: 'added execution',
      current({ historicalExecutions, job }) {
        return [...historicalExecutions, cloudRunExecutionListMember(job, {
          name: `${job.job}-def34`, uid: '323e4567-e89b-42d3-a456-426614174001',
        })];
      },
    },
    {
      name: 'removed execution',
      current() { return []; },
    },
    {
      name: 'duplicate execution',
      current({ historicalExecutions }) {
        return [historicalExecutions[0], structuredClone(historicalExecutions[0])];
      },
    },
    {
      name: 'malformed execution metadata',
      current({ historicalExecutions }) {
        const rows = structuredClone(historicalExecutions);
        delete rows[0].metadata.namespace;
        return rows;
      },
    },
    {
      name: 'foreign project execution',
      current({ historicalExecutions }) {
        const rows = structuredClone(historicalExecutions);
        rows[0].metadata.namespace = '999999999999';
        return rows;
      },
    },
    {
      name: 'foreign region execution',
      current({ historicalExecutions }) {
        const rows = structuredClone(historicalExecutions);
        rows[0].metadata.labels['cloud.googleapis.com/location'] = 'us-central1';
        return rows;
      },
    },
    {
      name: 'wrong Job execution',
      current({ historicalExecutions }) {
        const rows = structuredClone(historicalExecutions);
        rows[0].metadata.name = 'hkbuddy-v1-llm-smoke-abc12';
        rows[0].metadata.labels['run.googleapis.com/job'] = 'hkbuddy-v1-llm-smoke';
        return rows;
      },
    },
    {
      name: 'current-attempt execution',
      current({ historicalExecutions, job }) {
        return [...historicalExecutions, cloudRunExecutionListMember(job, {
          name: `${job.job}-ghi56`, uid: '423e4567-e89b-42d3-a456-426614174002',
        })];
      },
    },
    {
      name: 'execution list read failure',
      failureAt: 'list',
    },
    {
      name: 'Job authority read failure',
      failureAt: 'describe',
    },
    {
      name: 'Job generation drift',
      prepare({ liveJob }) {
        liveJob.metadata.generation = 2;
        liveJob.status.observedGeneration = 2;
      },
    },
    {
      name: 'Job UID drift',
      prepare({ liveJob }) {
        liveJob.metadata.uid = '523e4567-e89b-42d3-a456-426614174003';
      },
    },
    {
      name: 'non-array execution list',
      current() { return {}; },
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async (subtest) => {
      const fixture = await rejectedExecutionRecoveryFixture(subtest);
      current.prepare?.(fixture);
      const recordCount = fixture.store.records.length;
      const calls = [];
      const result = await runGcpRelease({
        argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`],
        input: fixture.input,
        loadReceipts: async () => fixtureReceiptChain(fixture.plan, 'inventory'),
        openStateStore: async () => fixture.store,
        environment: {
          V1_REJECTED_EXECUTION_LOG_PATH: fixture.logPath,
          V1_REJECTED_EXECUTION_LOG_SHA256: fixture.logSha256,
        },
        execute: async (argv) => {
          calls.push(argv);
          if (argv[2] === 'describe') {
            if (current.failureAt === 'describe') throw new Error('ambiguous Job read failure');
            return structuredClone(fixture.liveJob);
          }
          if (argv[2] === 'executions' && argv[3] === 'list') {
            if (current.failureAt === 'list') throw new Error('ambiguous execution list failure');
            return structuredClone(current.current?.(fixture) ?? fixture.historicalExecutions);
          }
          throw new Error(`restart must never re-execute the Job: ${argv.join(' ')}`);
        },
        writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'CLOUD_RUN_EXECUTION_REJECTION_EVIDENCE_INVALID');
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(fixture.store.records.length, recordCount);
      assert.equal(calls.some((argv) => argv[2] === 'execute'), false);
    });
  }
});

test('an exact accepted but failed Cloud Run execution is terminalized once and never executed again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-execute-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'acceptance' });
  const key = 'dependency-acceptance';
  const job = plan.expectedJobs[key];
  const store = createTestStateStore();
  const liveJob = realV1JobReadback(job);
  liveJob.metadata.uid = '12d057cc-bcf8-4192-95fa-bd7527627e46';
  liveJob.metadata.generation = 2;
  liveJob.status = {
    observedGeneration: 2,
    conditions: [{ type: 'Ready', status: 'True' }],
    executionCount: 2,
    latestCreatedExecution: {
      name: `${job.job}-zpxcw`,
      completionStatus: 'EXECUTION_FAILED',
    },
  };
  await appendTestMutationCheckpoint(store, {
    operationId: `${key}-deploy`, mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace', plan,
    safeResult: cloudRunJobSafeResult(plan, `${key}-deploy`, liveJob),
  });
  const executeIntent = await appendTestMutationIntent(store, {
    operationId: `${key}-execute`, mutationOrdinal: 2,
    reconcileKind: 'cloud-run-job-execute', plan,
  });
  executeIntent.payload.commandSha256 = createHash('sha256').update(JSON.stringify(canonicalFixture(
    plan.operations.find(({ id }) => id === `${key}-execute`).argv,
  ))).digest('hex');
  executeIntent.createdAt = '2026-09-01T07:23:29.795Z';
  const execution = {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Execution',
    metadata: {
      annotations: { 'run.googleapis.com/operation-id': 'a92d7b02-9063-4a63-99c8-12f48faf7fdd' },
      creationTimestamp: '2026-09-01T07:23:31.115251Z',
      labels: {
        'run.googleapis.com/job': job.job,
        'run.googleapis.com/jobGeneration': '2',
        'run.googleapis.com/jobUid': liveJob.metadata.uid,
      },
      name: `${job.job}-zpxcw`,
      uid: '1b7e2daa-49a8-4e2e-8813-5de165d60c1d',
    },
    spec: { taskCount: job.taskCount, parallelism: job.parallelism },
    status: {
      completionTime: '2026-09-01T07:23:46.489773Z',
      conditions: [{
        lastTransitionTime: '2026-09-01T07:23:46.489773Z',
        message: 'Task exited with a redacted error.',
        reason: 'NonZeroExitCode',
        status: 'False',
        type: 'Completed',
      }],
      failedCount: 1,
    },
  };
  const explicitNullCounter = structuredClone(execution);
  explicitNullCounter.status.succeededCount = null;
  assert.throws(() => validateFailedReleaseJobExecutionReceipt(explicitNullCounter, {
    expectedJob: job,
    executionName: execution.metadata.name,
    intentCreatedAt: executeIntent.createdAt,
    jobGeneration: 2,
    jobUid: liveJob.metadata.uid,
  }), /failed execution readback/i);
  const executeLog = [
    `2026-09-01 15:23:30,884 DEBUG root Running [gcloud.run.jobs.execute] with arguments: [--format: "json", --project: "${PROJECT}", --quiet: "True", --region: "${REGION}", --wait: "True", JOB: "${job.job}"]`,
    `2026-09-01 15:23:31,756 DEBUG urllib3.connectionpool https://${REGION}-run.googleapis.com:443 "POST /apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${job.job}:run?alt=json HTTP/1.1" 200 None`,
    '2026-09-01 15:23:47,295 DEBUG root (gcloud.run.jobs.execute) The execution failed.',
    `gcloud run jobs executions describe ${execution.metadata.name}`,
    `Or visit https://console.cloud.google.com/run/jobs/executions/details/${REGION}/${execution.metadata.name}?project=${PROJECT_NUMBER}`,
    '',
  ].join('\n');
  const executeLogPath = join(directory, 'execute-failure.log');
  await writeFile(executeLogPath, executeLog);
  const executeLogSha256 = createHash('sha256').update(executeLog).digest('hex');

  const auditEntry = {
    labels: { 'run.googleapis.com/execution_name': execution.metadata.name },
    logName: `projects/${PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event`,
    protoPayload: {
      methodName: '/Jobs.RunJob',
      resourceName: `namespaces/${PROJECT}/executions/${execution.metadata.name}`,
      response: structuredClone(execution),
      status: {
        code: 10,
        message: `Execution ${execution.metadata.name} has failed to complete, 0/1 tasks were a success.`,
      },
    },
    resource: {
      labels: { job_name: job.job, location: REGION, project_id: PROJECT },
      type: 'cloud_run_job',
    },
  };
  const auditJson = JSON.stringify([{ textPayload: 'unrelated' }, auditEntry], null, 2);
  const auditLog = [
    `2026-09-01 15:24:34,722 DEBUG root Running [gcloud.logging.read] with arguments: [--format: "json", --limit: "100", --order: "asc", --project: "${PROJECT}", LOG_FILTER: "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${job.job}\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution.metadata.name}\""]`,
    `2026-09-01 15:25:19,247 INFO ___FILE_ONLY___ ${auditJson}`,
    '',
  ].join('\n');
  const auditLogPath = join(directory, 'audit.log');
  await writeFile(auditLogPath, auditLog);
  const auditLogSha256 = createHash('sha256').update(auditLog).digest('hex');

  liveJob.status.executionCount = 0;
  const recordCountBeforeInvalidRecovery = store.records.length;
  const invalidCountResult = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'inventory'),
    openStateStore: async () => store,
    environment: {
      V1_FAILED_EXECUTION_LOG_PATH: executeLogPath,
      V1_FAILED_EXECUTION_LOG_SHA256: executeLogSha256,
      V1_FAILED_EXECUTION_AUDIT_LOG_PATH: auditLogPath,
      V1_FAILED_EXECUTION_AUDIT_LOG_SHA256: auditLogSha256,
    },
    execute: async (argv) => {
      if (argv[1] === 'jobs' && argv[2] === 'describe') return structuredClone(liveJob);
      throw new Error(`unexpected invalid-count recovery operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(invalidCountResult.publicReport.code,
    'CLOUD_RUN_EXECUTION_FAILURE_EVIDENCE_INVALID');
  assert.equal(store.records.length, recordCountBeforeInvalidRecovery);
  liveJob.status.executionCount = 2;

  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'inventory'),
    openStateStore: async () => store,
    environment: {
      V1_FAILED_EXECUTION_LOG_PATH: executeLogPath,
      V1_FAILED_EXECUTION_LOG_SHA256: executeLogSha256,
      V1_FAILED_EXECUTION_AUDIT_LOG_PATH: auditLogPath,
      V1_FAILED_EXECUTION_AUDIT_LOG_SHA256: auditLogSha256,
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'jobs' && argv[2] === 'describe') return structuredClone(liveJob);
      if (argv[1] === 'jobs' && argv[2] === 'executions' && argv[3] === 'describe') {
        return structuredClone(execution);
      }
      throw new Error(`unexpected recovery operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'CLOUD_RUN_EXECUTION_FAILURE_RECOVERED', JSON.stringify({
    calls, records: store.records,
  }));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.length, 3);
  assert.equal(calls.some((argv) => argv[2] === 'execute'), false);
  assert.equal(store.records.at(-2).recordType, 'abort');
  assert.equal(store.records.at(-2).payload.reason, 'authoritative-cloud-run-execution-failed');
  assert.equal(store.records.at(-1).recordType, 'terminal');
  assert.equal(JSON.stringify(store.records).includes('redacted error'), false);

  store.records.pop();
  let restartExecutorCalls = 0;
  let acceptancePhasePlanSha256 = null;
  const resumed = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'inventory'),
    openStateStore: async (options) => {
      acceptancePhasePlanSha256 = options.phasePlanSha256;
      return store;
    },
    execute: async () => {
      restartExecutorCalls += 1;
      throw new Error('abort-tail recovery must not call GCP');
    },
    writeOutput: () => undefined,
  });
  assert.equal(resumed.exitCode, 1);
  assert.equal(resumed.publicReport.code, 'CLOUD_RUN_EXECUTION_FAILURE_TERMINAL_RECOVERED');
  assert.equal(resumed.publicReport.mutationPerformed, false);
  assert.equal(restartExecutorCalls, 0);
  assert.equal(store.records.at(-2).recordType, 'abort');
  assert.equal(store.records.at(-1).recordType, 'terminal');
  for (const record of store.records) {
    record.phase = 'acceptance';
    record.phasePlanSha256 = acceptancePhasePlanSha256;
  }
  const recordCount = store.records.length;
  let tombstoneExecutorCalls = 0;
  const tombstoned = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'inventory'),
    openStateStore: async () => store,
    execute: async () => {
      tombstoneExecutorCalls += 1;
      throw new Error('terminal tombstone must not call GCP');
    },
    writeOutput: () => undefined,
  });
  assert.equal(tombstoned.exitCode, 1);
  assert.equal(tombstoned.publicReport.code, 'CLOUD_RUN_EXECUTION_FAILED');
  assert.equal(tombstoned.publicReport.tombstoned, true);
  assert.equal(tombstoned.publicReport.mutationPerformed, false);
  assert.equal(tombstoneExecutorCalls, 0);
  assert.equal(store.records.length, recordCount);
});

test('an exact failed LLM smoke execution terminalizes its full acceptance prefix', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-llm-execute-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = releaseInput();
  const plan = buildReleasePlan(input, { phase: 'acceptance' });
  const key = 'llm-smoke';
  const job = plan.expectedJobs[key];
  const store = createTestStateStore();

  await appendTestMutationCheckpoint(store, {
    operationId: 'dependency-acceptance-deploy', mutationOrdinal: 1,
    reconcileKind: 'cloud-run-job-replace', plan,
  });
  await appendTestMutationCheckpoint(store, {
    operationId: 'dependency-acceptance-execute', mutationOrdinal: 2,
    reconcileKind: 'cloud-run-job-execute', plan, outcome: 'adopted-restart',
  });
  const liveJob = realV1JobReadback(job);
  liveJob.metadata.uid = '12d057cc-bcf8-4192-95fa-bd7527627e46';
  liveJob.metadata.generation = 1;
  liveJob.status = {
    observedGeneration: 1,
    conditions: [{ type: 'Ready', status: 'True' }],
    executionCount: 1,
    latestCreatedExecution: {
      name: `${job.job}-bdv6v`,
      completionStatus: 'EXECUTION_FAILED',
    },
  };
  await appendTestMutationCheckpoint(store, {
    operationId: `${key}-deploy`, mutationOrdinal: 3,
    reconcileKind: 'cloud-run-job-replace', plan,
    safeResult: cloudRunJobSafeResult(plan, `${key}-deploy`, liveJob),
  });
  const llmDeployCheckpoint = store.records.at(-1);
  const executeIntent = await appendTestMutationIntent(store, {
    operationId: `${key}-execute`, mutationOrdinal: 4,
    reconcileKind: 'cloud-run-job-execute', plan,
  });
  executeIntent.payload.commandSha256 = createHash('sha256').update(JSON.stringify(canonicalFixture(
    plan.operations.find(({ id }) => id === `${key}-execute`).argv,
  ))).digest('hex');
  executeIntent.createdAt = '2026-09-01T08:22:20.298629Z';

  const execution = {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Execution',
    metadata: {
      annotations: { 'run.googleapis.com/operation-id': 'e6319080-2839-444c-8f61-6a48ad7a42f6' },
      creationTimestamp: '2026-09-01T08:22:20.881140Z',
      labels: {
        'run.googleapis.com/job': job.job,
        'run.googleapis.com/jobGeneration': '1',
        'run.googleapis.com/jobUid': liveJob.metadata.uid,
      },
      name: `${job.job}-bdv6v`,
      uid: 'ad5590ab-eea7-4a47-ab8d-e65dc6377040',
    },
    spec: { taskCount: job.taskCount, parallelism: job.parallelism },
    status: {
      completionTime: '2026-09-01T08:22:30.446069Z',
      conditions: [{
        lastTransitionTime: '2026-09-01T08:22:30.446069Z',
        message: 'Task exited with a redacted error.',
        reason: 'NonZeroExitCode',
        status: 'False',
        type: 'Completed',
      }],
      failedCount: 1,
    },
  };
  const executeLog = [
    `2026-09-01 16:22:20,298 DEBUG root Running [gcloud.run.jobs.execute] with arguments: [--format: "json", --project: "${PROJECT}", --quiet: "True", --region: "${REGION}", --wait: "True", JOB: "${job.job}"]`,
    `2026-09-01 16:22:20,881 DEBUG urllib3.connectionpool https://${REGION}-run.googleapis.com:443 "POST /apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${job.job}:run?alt=json HTTP/1.1" 200 None`,
    '2026-09-01 16:22:31,000 DEBUG root (gcloud.run.jobs.execute) The execution failed.',
    `gcloud run jobs executions describe ${execution.metadata.name}`,
    '',
  ].join('\n');
  const executeLogPath = join(directory, 'execute-failure.log');
  await writeFile(executeLogPath, executeLog);
  const executeLogSha256 = createHash('sha256').update(executeLog).digest('hex');
  const auditEntry = {
    labels: { 'run.googleapis.com/execution_name': execution.metadata.name },
    logName: `projects/${PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event`,
    protoPayload: {
      methodName: '/Jobs.RunJob',
      resourceName: `namespaces/${PROJECT}/executions/${execution.metadata.name}`,
      response: structuredClone(execution),
      status: {
        code: 10,
        message: `Execution ${execution.metadata.name} has failed to complete, 0/1 tasks were a success.`,
      },
    },
    resource: {
      labels: { job_name: job.job, location: REGION, project_id: PROJECT },
      type: 'cloud_run_job',
    },
  };
  const auditJson = JSON.stringify([auditEntry], null, 2);
  const auditLog = [
    `2026-09-01 16:23:00,000 DEBUG root Running [gcloud.logging.read] with arguments: [--format: "json", --limit: "100", --order: "asc", --project: "${PROJECT}", LOG_FILTER: "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${job.job}\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution.metadata.name}\""]`,
    `2026-09-01 16:23:01,000 INFO ___FILE_ONLY___ ${auditJson}`,
    '',
  ].join('\n');
  const auditLogPath = join(directory, 'audit.log');
  await writeFile(auditLogPath, auditLog);
  const auditLogSha256 = createHash('sha256').update(auditLog).digest('hex');

  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'inventory'),
    openStateStore: async () => store,
    environment: {
      V1_FAILED_EXECUTION_LOG_PATH: executeLogPath,
      V1_FAILED_EXECUTION_LOG_SHA256: executeLogSha256,
      V1_FAILED_EXECUTION_AUDIT_LOG_PATH: auditLogPath,
      V1_FAILED_EXECUTION_AUDIT_LOG_SHA256: auditLogSha256,
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'jobs' && argv[2] === 'describe') return structuredClone(liveJob);
      if (argv[1] === 'jobs' && argv[2] === 'executions' && argv[3] === 'describe') {
        return structuredClone(execution);
      }
      throw new Error(`unexpected recovery operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'CLOUD_RUN_EXECUTION_FAILURE_RECOVERED', JSON.stringify({
    calls, records: store.records,
  }));
  assert.deepEqual(result.publicReport.completed, [
    'dependency-acceptance-deploy',
    'dependency-acceptance-execute',
    'llm-smoke-deploy',
  ]);
  assert.equal(result.publicReport.recoveredOperationId, 'llm-smoke-execute');
  assert.equal(calls.length, 3);
  assert.equal(calls.some((argv) => argv[2] === 'execute'), false);
  assert.equal(store.records.at(-2).operationId, 'llm-smoke-execute');
  assert.equal(store.records.at(-1).payload.mutationCount, 3);
  assert.equal(store.records.at(-1).payload.checkpointRecordSha256,
    llmDeployCheckpoint.recordSha256);

  let acceptancePhasePlanSha256 = null;
  for (const record of store.records) {
    record.phase = 'acceptance';
  }
  const recordCount = store.records.length;
  let tombstoneExecutorCalls = 0;
  const tombstoned = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'inventory'),
    openStateStore: async (options) => {
      acceptancePhasePlanSha256 = options.phasePlanSha256;
      for (const record of store.records) record.phasePlanSha256 = acceptancePhasePlanSha256;
      return store;
    },
    execute: async () => {
      tombstoneExecutorCalls += 1;
      throw new Error('LLM terminal tombstone must not call GCP');
    },
    writeOutput: () => undefined,
  });
  assert.equal(tombstoned.publicReport.code, 'CLOUD_RUN_EXECUTION_FAILED');
  assert.equal(tombstoned.publicReport.tombstoned, true);
  assert.deepEqual(tombstoned.publicReport.completed, [
    'dependency-acceptance-deploy',
    'dependency-acceptance-execute',
    'llm-smoke-deploy',
  ]);
  assert.equal(tombstoneExecutorCalls, 0);
  assert.equal(store.records.length, recordCount);
});

test('migration phase persists the canonical short v1 execution identity with omitted zero counters', async () => {
  const input = releaseInput({
    evidence: null, acceptanceOutputs: null, previousRevision: null, previousImageDigest: null,
  });
  const plan = buildReleasePlan(input, { phase: 'migration' });
  let persisted = null;
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'deploy') return { metadata: { name: 'hkbuddy-v1-migrate' } };
      if (argv[2] === 'describe') return realV1JobReadback(plan.expectedMigrationJob);
      if (argv[2] === 'executions' && argv[3] === 'list') return [];
      if (argv[2] === 'execute') return {
        apiVersion: 'run.googleapis.com/v1',
        kind: 'Execution',
        metadata: {
          name: 'hkbuddy-v1-migrate-release-001',
          labels: { 'run.googleapis.com/job': 'hkbuddy-v1-migrate' },
        },
      };
      if (argv[2] === 'executions' && argv[3] === 'describe') return {
        apiVersion: 'run.googleapis.com/v1',
        kind: 'Execution',
        metadata: {
          name: 'hkbuddy-v1-migrate-release-001',
          labels: { 'run.googleapis.com/job': 'hkbuddy-v1-migrate' },
        },
        spec: { taskCount: 1, parallelism: 1 },
        status: {
          conditions: [{ type: 'Completed', status: 'True' }],
          completionTime: '2026-08-26T08:00:00.000Z',
          succeededCount: 1,
        },
      };
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.migrationExecutionReceipt.name, 'hkbuddy-v1-migrate-release-001');
  assert.equal(persisted.outputs.executionName, 'hkbuddy-v1-migrate-release-001');
  assert.doesNotMatch(persisted.outputs.executionName, /\/executions\//);
  assert.equal(calls.some((argv) => argv[2] === 'executions'
    && argv[3] === 'describe'
    && argv[4] === 'hkbuddy-v1-migrate-release-001'), true);
});

test('promotion without the complete predecessor receipt chain remains inert', async () => {
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    loadReceipts: async () => [],
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('promotion revalidates every Task 8 artifact before any control-plane call', async () => {
  const calls = [];
  const verified = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    verifyTask8Evidence: async (_entry, phase) => {
      verified.push(phase);
      if (phase === 'mobile') throw new Error('mobile bytes drifted');
      return true;
    },
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(verified, ['readiness', 'workload', 'mobile']);
  assert.deepEqual(calls, []);
  assert.equal(result.publicReport.mutationPerformed, false);
});

test('candidate and promotion privacy proof operations fence their phase boundaries', () => {
  for (const previousRevision of [null, `${STABLE_SERVICE}-111111111111`]) {
    const plan = buildReleasePlan(releaseInput(previousRevision === null ? {
      previousRevision: null, previousImageDigest: null,
    } : { previousRevision }), { phase: 'promote' });
    const candidate = plan.operations.filter(({ phase }) => phase === 'candidate');
    assert.equal(candidate.at(-1).id, 'candidate-privacy-publish');
    assert.equal(candidate.at(-2).id, 'candidate-private-iam-readback');
    const promotion = plan.operations.filter(({ phase }) => phase === 'promote');
    const privacyIndex = promotion.findIndex(({ id }) => id === 'promote-privacy-publish');
    const finalId = previousRevision === null ? 'promote-public-service' : 'promote-traffic';
    assert.ok(privacyIndex > 0);
    if (previousRevision === null) {
      assert.equal(promotion[privacyIndex + 1].id, 'candidate-cleanup-delete');
      assert.deepEqual(promotion.slice(privacyIndex + 1).filter(({ id }) => (
        ['candidate-cleanup-delete', 'promote-stable-deploy', 'promote-public-service'].includes(id)
      )).map(({ id }) => id), [
        'candidate-cleanup-delete', 'promote-stable-deploy', 'promote-public-service',
      ]);
    } else {
      assert.equal(promotion[privacyIndex + 1].id, finalId);
      assert.deepEqual(promotion.slice(privacyIndex + 1).filter(({ id }) => (
        ['promote-public-service', 'promote-traffic', 'promote-stable-deploy'].includes(id)
      )).map(({ id }) => id), [finalId]);
    }
  }
});

test('default Task 8 verifier reads and hash-binds both privacy files before accepting workload evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-task8-privacy-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = validWorkloadAcceptanceRecord();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const base = releaseInput();
  const workload = {
    ...base.task8Evidence.workload,
    filePath: join(directory, 'workload.json'),
    artifactSha256: record.artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
    privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
      ...base.task8Evidence.workload.privacyProofs[boundary],
      filePath: join(directory, `privacy-${boundary}.json`),
    }])),
  };
  await writeFile(workload.filePath, contents);
  const input = releaseInput({
    task8Evidence: { ...base.task8Evidence, workload },
  });
  const plan = buildReleasePlan(input, { phase: 'workload' });
  const options = {
    now: new Date('2026-08-26T08:05:00.000Z'),
    gateWindow: {
      gateStartedAt: '2026-08-26T08:00:00.000Z',
      gateEndedAt: '2026-08-26T08:05:00.000Z',
    },
  };
  await assert.rejects(
    () => validateTask8EvidenceArtifact(workload, 'workload', plan, options),
    /Task 8 workload evidence is invalid/,
  );
  await writeFile(workload.privacyProofs.start.filePath, '{}\n');
  await writeFile(workload.privacyProofs.end.filePath, '{}\n');
  await assert.rejects(
    () => validateTask8EvidenceArtifact(workload, 'workload', plan, options),
    /Task 8 workload evidence is invalid/,
  );
});

test('historical Task 8 proofs are validated at their recorded gate instants, not promotion time', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-task8-historical-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = validWorkloadAcceptanceRecord();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const base = releaseInput();
  const calls = [];
  const privacyProofs = {};
  const boundarySha256 = '1'.repeat(64);
  for (const [boundary, observedAt] of [
    ['start', '2026-08-26T08:00:00.000Z'],
    ['end', '2026-08-26T08:10:00.000Z'],
  ]) {
    const proof = {
      schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
      artifactSha256: createHash('sha256').update(`privacy-${boundary}`).digest('hex'),
      binding: { boundarySha256 },
      occurredAt: observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 5 * 60_000).toISOString(),
    };
    const bytes = `${JSON.stringify(proof, null, 2)}\n`;
    const filePath = join(directory, `privacy-${boundary}.json`);
    await writeFile(filePath, bytes);
    privacyProofs[boundary] = {
      ...base.task8Evidence.workload.privacyProofs[boundary],
      filePath,
      artifactSha256: proof.artifactSha256,
      objectSha256: createHash('sha256').update(bytes).digest('hex'),
      boundarySha256,
      observedAt,
      expiresAt: proof.expiresAt,
    };
  }
  const workload = {
    ...base.task8Evidence.workload,
    filePath: join(directory, 'workload.json'),
    artifactSha256: record.artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
    privacyProofs,
  };
  await writeFile(workload.filePath, contents);
  const plan = buildReleasePlan(releaseInput({
    task8Evidence: { ...base.task8Evidence, workload },
  }), { phase: 'promote' });
  const verified = await validateTask8EvidenceArtifact(workload, 'workload', plan, {
    now: new Date('2026-09-26T08:10:00.000Z'),
    historical: true,
    gateWindow: {
      gateStartedAt: '2026-08-26T08:00:00.000Z',
      gateEndedAt: '2026-08-26T08:09:00.000Z',
    },
    validatePrivacyProof: (_proof, { now }) => {
      calls.push(new Date(now).toISOString());
      return true;
    },
  });
  assert.notEqual(verified, false);
  assert.deepEqual(calls, [
    '2026-08-26T08:00:00.000Z',
    '2026-08-26T08:09:00.000Z',
  ]);
});

test('readiness wrapper validates against a post-producer clock and rejects expired output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-readiness-post-clock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = releaseInput();
  const unresolved = {
    ...base.task8Evidence.readiness,
    filePath: join(directory, 'readiness.json'),
    artifactSha256: '0'.repeat(64),
    objectSha256: '0'.repeat(64),
    privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
      ...base.task8Evidence.readiness.privacyProofs[boundary],
      schemaVersion: 3,
      filePath: join(directory, `privacy-${boundary}.json`),
      artifactSha256: '0'.repeat(64),
      objectSha256: '0'.repeat(64),
      boundarySha256: '0'.repeat(64),
    }])),
  };
  const input = releaseInput({
    task8Evidence: { ...base.task8Evidence, readiness: unresolved },
  });
  const fixture = controlledReadinessExecution(buildReleasePlan(input, { phase: 'readiness' }));
  let producerCalls = 0;
  const instants = [
    new Date('2026-08-27T08:00:00.000Z'),
    new Date('2026-08-27T08:06:00.000Z'),
  ];
  const result = await runGcpRelease({
    argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
    executeReadiness: async ({ now: producerNow }) => {
      producerCalls += 1;
      producerNow();
      return fixture;
    },
    readinessTokenExecutor: async () => 'unused',
    execute: async () => { throw new Error('must remain inert'); },
    now: () => instants.shift() ?? new Date('2026-08-27T08:06:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(producerCalls, 1, JSON.stringify(result.publicReport));
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'READINESS_CONTROLLED_OUTPUT_INVALID');
});

test('readiness receipt is created only from one controlled fresh producer run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-controlled-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = releaseInput();
  const unresolved = {
    ...base.task8Evidence.readiness,
    filePath: join(directory, 'readiness.json'),
    artifactSha256: '0'.repeat(64),
    objectSha256: '0'.repeat(64),
    privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
      ...base.task8Evidence.readiness.privacyProofs[boundary],
      filePath: join(directory, `privacy-${boundary}.json`),
      artifactSha256: '0'.repeat(64),
      objectSha256: '0'.repeat(64),
      boundarySha256: '0'.repeat(64),
    }])),
  };
  const input = releaseInput({
    task8Evidence: { ...base.task8Evidence, readiness: unresolved },
  });
  const fixtureExecution = controlledReadinessExecution(
    buildReleasePlan(input, { phase: 'readiness' }),
  );
  assert.equal(fixtureExecution.evidence.filePath, unresolved.filePath);
  let producerCalls = 0;
  let persisted = null;
  let persistedPlan = null;
  const result = await runGcpRelease({
    argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
    executeReadiness: async ({ plan }) => {
      producerCalls += 1;
      return controlledReadinessExecution(plan);
    },
    readinessTokenExecutor: async () => { throw new Error('injected producer owns token transport'); },
    verifyTask8Evidence: async (entry, phase) => {
      assert.equal(phase, 'readiness');
      assert.notEqual(entry.artifactSha256, '0'.repeat(64));
      assert.equal(await readFile(entry.filePath, 'utf8').then((value) => value.length > 0), true);
      return true;
    },
    execute: async () => { throw new Error('controlled readiness fixture must not call gcloud'); },
    persistReceipt: async (plan, receipt) => {
      persistedPlan = plan;
      persisted = receipt;
      return true;
    },
    now: () => new Date('2026-08-27T08:02:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(producerCalls, 1);
  assert.ok(persisted);
  assert.notEqual(persisted.outputs.artifactSha256, '0'.repeat(64));
  assert.notEqual(persisted.outputs.objectSha256, '0'.repeat(64));
  assert.deepEqual(persisted.outputs.privacyProofs, persistedPlan.task8Evidence.readiness.privacyProofs);
  assert.equal((await readFile(unresolved.filePath, 'utf8')).endsWith('\n'), true);
  assert.equal((await readFile(unresolved.privacyProofs.start.filePath, 'utf8')).endsWith('\n'), true);
  assert.equal((await readFile(unresolved.privacyProofs.end.filePath, 'utf8')).endsWith('\n'), true);

  const prebuiltInput = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      readiness: { ...unresolved, artifactSha256: '7'.repeat(64) },
    },
  });
  const prebuilt = await runGcpRelease({
    argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
    input: prebuiltInput,
    loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
    executeReadiness: async () => { producerCalls += 1; throw new Error('must remain inert'); },
    execute: async () => { throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(prebuilt.exitCode, 1);
  assert.equal(prebuilt.publicReport.code, 'READINESS_PREBUILT_EVIDENCE_FORBIDDEN');
  assert.equal(producerCalls, 1);
});

test('checkpointed readiness recovery validates at the durable checkpoint instant', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-readiness-checkpoint-clock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = releaseInput();
  const unresolved = {
    ...base.task8Evidence.readiness,
    filePath: join(directory, 'readiness.json'),
    artifactSha256: '0'.repeat(64),
    objectSha256: '0'.repeat(64),
    privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
      ...base.task8Evidence.readiness.privacyProofs[boundary],
      filePath: join(directory, `privacy-${boundary}.json`),
      artifactSha256: '0'.repeat(64),
      objectSha256: '0'.repeat(64),
      boundarySha256: '0'.repeat(64),
    }])),
  };
  const input = releaseInput({
    task8Evidence: { ...base.task8Evidence, readiness: unresolved },
  });
  const initialPlan = buildReleasePlan(input, { phase: 'readiness' });
  const records = [];
  const first = await runGcpRelease({
    argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
    executeReadiness: async () => controlledReadinessExecution(initialPlan),
    readinessTokenExecutor: async () => 'unused',
    openStateStore: async () => createTestStateStore({ records }),
    verifyTask8Evidence: async () => true,
    execute: async () => { throw new Error('controlled readiness fixture must not call gcloud'); },
    persistReceipt: async () => { throw new Error('simulated receipt write loss'); },
    now: () => new Date('2026-08-27T08:02:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(first.exitCode, 1);
  assert.deepEqual(records.map(({ recordType }) => recordType), ['intent', 'checkpoint']);
  records.at(-1).createdAt = '2026-08-27T08:02:00.000Z';

  let verification = null;
  const resumed = await runGcpRelease({
    argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
    executeReadiness: async () => { throw new Error('checkpoint recovery must not rerun readiness'); },
    readinessTokenExecutor: async () => 'unused',
    openStateStore: async () => createTestStateStore({ records }),
    verifyTask8Evidence: async (_entry, phase, _plan, options) => {
      verification = { phase, historical: options.historical, now: options.now.toISOString() };
      return options.now.toISOString() === records.at(-1).createdAt;
    },
    execute: async () => { throw new Error('checkpoint recovery must remain inert'); },
    persistReceipt: async () => true,
    now: () => new Date('2026-08-27T08:10:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.publicReport));
  assert.deepEqual(verification, {
    phase: 'readiness', historical: false, now: '2026-08-27T08:02:00.000Z',
  });
  assert.deepEqual(records.map(({ recordType }) => recordType), [
    'intent', 'checkpoint', 'terminal',
  ]);
});

test('readiness publication journals exact bytes before every write and adopts all crash boundaries', async (t) => {
  for (const crashAfter of [1, 2, 3]) {
    await t.test(`crash after artifact ${crashAfter}`, async (st) => {
      const directory = await mkdtemp(join(tmpdir(), `hkbuddy-readiness-crash-${crashAfter}-`));
      st.after(() => rm(directory, { recursive: true, force: true }));
      const base = releaseInput();
      const unresolved = {
        ...base.task8Evidence.readiness,
        filePath: join(directory, 'readiness.json'),
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
        privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
          ...base.task8Evidence.readiness.privacyProofs[boundary],
          filePath: join(directory, `privacy-${boundary}.json`),
          artifactSha256: '0'.repeat(64),
          objectSha256: '0'.repeat(64),
          boundarySha256: '0'.repeat(64),
        }])),
      };
      const input = releaseInput({
        task8Evidence: { ...base.task8Evidence, readiness: unresolved },
      });
      const fixture = controlledReadinessExecution(buildReleasePlan(input, { phase: 'readiness' }));
      const records = [];
      let producerCalls = 0;
      let writes = 0;
      const first = await runGcpRelease({
        argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
        input,
        loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
        executeReadiness: async () => { producerCalls += 1; return fixture; },
        readinessTokenExecutor: async () => 'unused',
        openStateStore: async () => createTestStateStore({ records }),
        writeControlledArtifact: async (filePath, bytes) => {
          assert.equal(records.at(-1)?.recordType, 'intent');
          await writeFile(filePath, bytes, { flag: 'wx' });
          writes += 1;
          if (writes === crashAfter) throw new Error('simulated publication crash');
        },
        verifyTask8Evidence: async () => true,
        execute: async () => { throw new Error('must remain inert'); },
        now: () => new Date('2026-08-27T08:02:00.000Z'),
        writeOutput: () => undefined,
      });
      assert.equal(first.exitCode, 1);
      assert.equal(records.length, 1);
      assert.equal(records[0].recordType, 'intent');
      assert.equal(records[0].payload.reconcileKind, 'local-artifact-create');
      assert.equal(records[0].payload.publication.artifacts.length, 3);

      if (crashAfter === 1) {
        const firstArtifact = records[0].payload.publication.artifacts[0];
        await writeFile(firstArtifact.filePath, 'foreign-bytes');
        const rejectOptions = {
          argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
          input,
          loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
          executeReadiness: async () => { producerCalls += 1; throw new Error('must not rerun'); },
          readinessTokenExecutor: async () => 'unused',
          openStateStore: async () => createTestStateStore({ records }),
          verifyTask8Evidence: async () => true,
          execute: async () => { throw new Error('must remain inert'); },
          now: () => new Date('2026-08-27T08:02:00.000Z'),
          writeOutput: () => undefined,
        };
        const foreign = await runGcpRelease(rejectOptions);
        assert.equal(foreign.exitCode, 1);
        assert.equal(foreign.publicReport.code, 'READINESS_CONTROLLED_PUBLISH_INVALID');
        assert.equal(await readFile(firstArtifact.filePath, 'utf8'), 'foreign-bytes');

        await rm(firstArtifact.filePath);
        const junctionTarget = join(directory, 'foreign-junction-target');
        await mkdir(junctionTarget);
        await writeFile(join(junctionTarget, 'target-bytes'), 'must-not-be-adopted');
        await symlink(junctionTarget, firstArtifact.filePath, 'junction');
        let publicationWrites = 0;
        const junction = await runGcpRelease({
          ...rejectOptions,
          writeControlledArtifact: async () => { publicationWrites += 1; return true; },
        });
        assert.equal(junction.exitCode, 1);
        assert.equal(junction.publicReport.code, 'READINESS_CONTROLLED_PUBLISH_INVALID');
        assert.equal(publicationWrites, 0);
        await rm(firstArtifact.filePath);
        await writeFile(firstArtifact.filePath, Buffer.from(firstArtifact.contentsBase64, 'base64'), {
          flag: 'wx',
        });
      }

      let persisted = null;
      const resumed = await runGcpRelease({
        argv: ['--phase=readiness', `--confirm-release=${RELEASE_SHA}`],
        input,
        loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
        executeReadiness: async () => { producerCalls += 1; throw new Error('must not rerun'); },
        readinessTokenExecutor: async () => 'unused',
        openStateStore: async () => createTestStateStore({ records }),
        verifyTask8Evidence: async () => true,
        execute: async () => { throw new Error('must remain inert'); },
        persistReceipt: async (_plan, receipt) => { persisted = receipt; return true; },
        now: () => new Date('2026-08-27T08:02:00.000Z'),
        writeOutput: () => undefined,
      });
      assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.publicReport));
      assert.equal(producerCalls, 1);
      assert.ok(persisted);
      assert.deepEqual(records.map(({ recordType }) => recordType), [
        'intent', 'checkpoint', 'terminal',
      ]);
      for (const filePath of [
        unresolved.privacyProofs.start.filePath,
        unresolved.privacyProofs.end.filePath,
        unresolved.filePath,
      ]) assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true);
    });
  }
});

test('mobile phase rejects prebuilt evidence and publishes only one controlled journaled run', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-controlled-mobile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = releaseInput();
  const unresolved = {
    ...base.task8Evidence.mobile,
    filePath: join(directory, 'mobile.json'),
    artifactSha256: '0'.repeat(64),
    objectSha256: '0'.repeat(64),
    privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
      ...base.task8Evidence.mobile.privacyProofs[boundary],
      filePath: join(directory, `mobile-privacy-${boundary}.json`),
      artifactSha256: '0'.repeat(64),
      objectSha256: '0'.repeat(64),
      boundarySha256: '0'.repeat(64),
    }])),
  };
  const input = releaseInput({
    task8Evidence: { ...base.task8Evidence, mobile: unresolved },
  });
  const initialPlan = buildReleasePlan(input, { phase: 'mobile' });
  const fixture = controlledMobileExecution(initialPlan);
  const records = [];
  let persisted = null;
  let producerCalls = 0;
  let privacyCalls = 0;
  let controlPlaneCalls = 0;
  const mobileTokenRequests = [];
  const result = await runGcpRelease({
    argv: ['--phase=mobile', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async () => fixtureReceiptChain(initialPlan, 'workload'),
    openStateStore: async () => createTestStateStore({ records }),
    execute: async () => { throw new Error('injected mobile adapters own all live reads'); },
    mobileTokenExecutor: async (request) => {
      mobileTokenRequests.push(structuredClone(request));
      return 't'.repeat(64);
    },
    produceMobilePrivacyArtifact: async ({ locator }) => {
      privacyCalls += 1;
      return locator.filePath.endsWith('start.json')
        ? fixture.artifacts.privacyStart : fixture.artifacts.privacyEnd;
    },
    captureMobileControlPlane: async () => {
      controlPlaneCalls += 1;
      return { stable: true, sha256: '3'.repeat(64) };
    },
    executeMobile: async (options) => {
      producerCalls += 1;
      await options.producePrivacyArtifact('start');
      await options.captureControlPlane();
      await options.captureControlPlane();
      await options.producePrivacyArtifact('end');
      return fixture;
    },
    writeControlledArtifact: async (filePath, bytes) => {
      await writeFile(filePath, bytes, { flag: 'wx' });
      return true;
    },
    verifyTask8Evidence: async (entry, phase) => {
      assert.equal(phase, 'mobile');
      assert.equal((await readFile(entry.filePath, 'utf8')).endsWith('\n'), true);
      return true;
    },
    persistReceipt: async (_plan, receipt) => { persisted = receipt; return true; },
    now: () => new Date('2026-08-27T08:02:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(producerCalls, 1);
  assert.equal(privacyCalls, 2);
  assert.equal(controlPlaneCalls, 2);
  assert.deepEqual(mobileTokenRequests, [{
    generateIdToken: {
      endpoint: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(GCP_IDENTITY.serviceAccounts.acceptance)}:generateIdToken`,
      body: { audience: CANDIDATE_ROOT, includeEmail: true },
    },
  }]);
  assert.equal(records[0].operationId, 'mobile-evidence-publish');
  assert.equal(records[0].payload.reconcileKind, 'local-artifact-create');
  assert.equal(records[0].payload.publication.artifacts.length, 7);
  assert.deepEqual(records[0].payload.publication.artifacts.map(({ role }) => role), [
    'privacy-start', 'screenshot', 'screenshot', 'screenshot', 'screenshot',
    'privacy-end', 'evidence',
  ]);
  assert.equal(persisted.outputs.artifactSha256, fixture.evidence.artifactSha256);
  assert.deepEqual(persisted.outputs.privacyProofs, fixture.evidence.privacyProofs);

  let forbiddenProducerCalls = 0;
  const prebuiltPlan = buildReleasePlan(base, { phase: 'mobile' });
  const rejected = await runGcpRelease({
    argv: ['--phase=mobile', `--confirm-release=${RELEASE_SHA}`],
    input: base,
    loadReceipts: async () => fixtureReceiptChain(prebuiltPlan, 'workload'),
    openStateStore: async () => createTestStateStore(),
    executeMobile: async () => { forbiddenProducerCalls += 1; throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.publicReport.code, 'MOBILE_PREBUILT_EVIDENCE_FORBIDDEN');
  assert.equal(forbiddenProducerCalls, 0);
});

test('mobile publication adopts only the exact journaled bytes after a partial crash', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-mobile-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = releaseInput();
  const unresolved = {
    ...base.task8Evidence.mobile,
    filePath: join(directory, 'mobile.json'),
    artifactSha256: '0'.repeat(64),
    objectSha256: '0'.repeat(64),
    privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
      ...base.task8Evidence.mobile.privacyProofs[boundary],
      filePath: join(directory, `mobile-privacy-${boundary}.json`),
      artifactSha256: '0'.repeat(64), objectSha256: '0'.repeat(64),
      boundarySha256: '0'.repeat(64),
    }])),
  };
  const input = releaseInput({ task8Evidence: { ...base.task8Evidence, mobile: unresolved } });
  const plan = buildReleasePlan(input, { phase: 'mobile' });
  const fixture = controlledMobileExecution(plan);
  const records = [];
  let producerCalls = 0;
  let writes = 0;
  const common = {
    argv: ['--phase=mobile', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'workload'),
    mobileTokenExecutor: async () => 't'.repeat(64),
    produceMobilePrivacyArtifact: async ({ locator }) => (
      locator.filePath.endsWith('start.json')
        ? fixture.artifacts.privacyStart : fixture.artifacts.privacyEnd
    ),
    captureMobileControlPlane: async () => ({ stable: true, sha256: '3'.repeat(64) }),
    verifyTask8Evidence: async () => true,
    now: () => new Date('2026-08-27T08:02:00.000Z'),
    writeOutput: () => undefined,
  };
  const crashed = await runGcpRelease({
    ...common,
    openStateStore: async () => createTestStateStore({ records }),
    execute: async () => { throw new Error('injected mobile adapters own all live reads'); },
    executeMobile: async (options) => {
      producerCalls += 1;
      await options.producePrivacyArtifact('start');
      await options.captureControlPlane();
      await options.captureControlPlane();
      await options.producePrivacyArtifact('end');
      return fixture;
    },
    writeControlledArtifact: async (filePath, bytes) => {
      writes += 1;
      await writeFile(filePath, bytes, { flag: 'wx' });
      if (writes === 3) throw new Error('simulated publication crash');
      return true;
    },
  });
  assert.equal(crashed.exitCode, 1);
  assert.equal(crashed.publicReport.code, 'MOBILE_CONTROLLED_PUBLISH_INVALID');
  assert.equal(records.filter(({ recordType }) => recordType === 'intent').length, 1);
  assert.equal(records.some(({ recordType }) => recordType === 'checkpoint'), false);

  const resumed = await runGcpRelease({
    ...common,
    openStateStore: async () => createTestStateStore({ records }),
    executeMobile: async () => { producerCalls += 1; throw new Error('must not rerun'); },
    writeControlledArtifact: async (filePath, bytes) => {
      await writeFile(filePath, bytes, { flag: 'wx' });
      return true;
    },
    persistReceipt: async () => true,
  });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed.publicReport));
  assert.equal(producerCalls, 1);
  assert.equal(records.filter(({ recordType }) => recordType === 'intent').length, 1);
  assert.equal(records.find(({ recordType }) => recordType === 'checkpoint').payload.outcome,
    'adopted-restart');
  for (const artifact of records[0].payload.publication.artifacts) {
    assert.equal((await readFile(artifact.filePath)).toString('base64'), artifact.contentsBase64);
  }
});

test('workload phase rejects every pre-existing artifact even with a complete-looking record and 200 matching logs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-workload-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let artifactIndex = 0;
  const runRecord = async (record) => {
    artifactIndex += 1;
    const finalized = finalizeLatencyAcceptanceRecord(record);
    const contents = `${JSON.stringify(finalized, null, 2)}\n`;
    const filePath = join(directory, `${artifactIndex}.json`);
    await writeFile(filePath, contents);
    const workload = {
      ...releaseInput().task8Evidence.workload,
      filePath,
      artifactSha256: finalized.artifactSha256,
      objectSha256: createHash('sha256').update(contents).digest('hex'),
    };
    const input = releaseInput({
      task8Evidence: { ...releaseInput().task8Evidence, workload },
    });
    let controlledExecutions = 0;
    const result = await runGcpRelease({
      argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`],
      input,
      loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
      persistReceipt: async () => true,
      executeWorkload: async () => { controlledExecutions += 1; throw new Error('must remain inert'); },
      execute: async (argv) => {
        assert.deepEqual(argv.slice(0, 2), ['logging', 'read']);
        return controlPlaneLogEntries(finalized);
      },
      now: () => new Date('2026-08-26T08:05:00.000Z'),
      writeOutput: () => undefined,
    });
    return { result, controlledExecutions };
  };

  const valid = validWorkloadAcceptanceRecord();
  const prebuilt = await runRecord(valid);
  assert.equal(prebuilt.result.exitCode, 1);
  assert.equal(prebuilt.result.publicReport.code, 'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN');
  assert.equal(prebuilt.result.publicReport.mutationPerformed, false);
  assert.equal(prebuilt.controlledExecutions, 0);

  const syntheticSummary = structuredClone(valid);
  delete syntheticSummary.rawReceipts;
  syntheticSummary.artifactSha256 = finalizeLatencyAcceptanceRecord(syntheticSummary).artifactSha256;
  const syntheticRejected = (await runRecord(syntheticSummary)).result;
  assert.equal(syntheticRejected.exitCode, 1,
    'aggregate-only evidence must not certify a workload with zero HTTP turns');

  const forgedFiveField = finalizeLatencyAcceptanceRecord({
    schemaVersion: 3,
    commitSha: RELEASE_SHA,
    candidateOrigin: CANDIDATE_ORIGIN,
    occurredAt: '2026-08-26T08:00:00.000Z',
    result: true,
  });
  const missingCounts = structuredClone(valid);
  delete missingCounts.counts;
  const mutatedMetric = structuredClone(valid);
  mutatedMetric.metrics.sendAck.sampleCount = 199;
  const duplicateObservation = structuredClone(valid);
  duplicateObservation.observations.queryDigests.values[1]
    = duplicateObservation.observations.queryDigests.values[0];
  const staleReplay = structuredClone(valid);
  staleReplay.occurredAt = '2026-08-24T08:00:00.000Z';
  const refinalizeRaw = (record) => {
    const { receiptsSha256: ignored, ...payload } = record.rawReceipts;
    void ignored;
    record.rawReceipts.receiptsSha256 = createHash('sha256')
      .update(JSON.stringify(canonicalFixture(payload))).digest('hex');
    return record;
  };
  const mutatedRawStatus = structuredClone(valid);
  mutatedRawStatus.rawReceipts.textTurns[0].requestStatus = 500;
  refinalizeRaw(mutatedRawStatus);
  const duplicatedControlPlane = structuredClone(valid);
  duplicatedControlPlane.rawReceipts.controlPlaneRequests[1] = {
    ...structuredClone(duplicatedControlPlane.rawReceipts.controlPlaneRequests[0]), sequence: 2,
  };
  refinalizeRaw(duplicatedControlPlane);
  const reorderedTurns = structuredClone(valid);
  [reorderedTurns.rawReceipts.textTurns[0], reorderedTurns.rawReceipts.textTurns[1]] = [
    reorderedTurns.rawReceipts.textTurns[1], reorderedTurns.rawReceipts.textTurns[0],
  ];
  refinalizeRaw(reorderedTurns);

  for (const [name, record] of [
    ['forged five-field record', forgedFiveField],
    ['missing 200-turn counts', missingCounts],
    ['mutated metric sample count', mutatedMetric],
    ['duplicate timing query observation', duplicateObservation],
    ['stale replay', staleReplay],
    ['mutated raw request status with recomputed receipts digest', mutatedRawStatus],
    ['duplicate control-plane request with recomputed receipts digest', duplicatedControlPlane],
    ['reordered raw turns with recomputed receipts digest', reorderedTurns],
  ]) {
    const rejected = (await runRecord(record)).result;
    assert.equal(rejected.exitCode, 1, name);
    assert.equal(rejected.publicReport.code, 'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN', name);
    assert.equal(rejected.publicReport.mutationPerformed, false, name);
  }
});

test('workload receipt is created only by one controlled immutable run with witnessed text ASR TTS and timing traffic', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-controlled-workload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workloadPath = join(directory, 'workload.json');
  const fixtureManifestPath = join(directory, 'asr-fixtures.json');
  const base = releaseInput();
  const input = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        ...base.task8Evidence.workload,
        filePath: workloadPath,
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
        privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
          ...base.task8Evidence.workload.privacyProofs[boundary],
          filePath: join(directory, `privacy-${boundary}.json`),
          artifactSha256: '0'.repeat(64),
          objectSha256: '0'.repeat(64),
          boundarySha256: '0'.repeat(64),
        }])),
      },
    },
  });
  const plan = buildReleasePlan(input);
  const record = validWorkloadAcceptanceRecord();
  assert.equal(new Set(record.rawReceipts.textTurns.map(({ correlationId }) => correlationId)).size, 200);
  assert.equal(new Set(record.rawReceipts.asrRequests.map(({ bindingId }) => bindingId)).size, 30);
  assert.equal(new Set(record.rawReceipts.ttsRequests.map(({ bindingId }) => bindingId)).size, 31);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let persisted = null;
  let runnerCalls = 0;
  let privacyProducerCalls = 0;
  let publishedBeforeRunnerCompleted = false;
  let runnerCompleted = false;
  const workloadState = createTestStateStore();
  let controlledWrites = 0;
  const result = await runGcpRelease({
    argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`], input,
    environment: { V1_LATENCY_ASR_FIXTURE_MANIFEST: fixtureManifestPath },
    randomUUID: () => attemptId,
    loadReceipts: async (_releasePlan, { through }) => fixtureReceiptChain(plan, through),
    openStateStore: async () => workloadState,
    journalAttemptId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    writeControlledArtifact: async (filePath, bytes) => {
      assert.equal(workloadState.records.at(-1)?.recordType, 'intent');
      controlledWrites += 1;
      await writeFile(filePath, bytes, { flag: 'wx' });
      return true;
    },
    executeWorkload: async (options) => {
      runnerCalls += 1;
      assert.deepEqual(options.argv, [
        '--candidate-origin', CANDIDATE_ORIGIN,
        '--asr-manifest', fixtureManifestPath,
        '--confirm-approved-candidate',
      ]);
      assert.equal(options.environment.V1_LOAD_TEST_CONFIRM, 'true');
      assert.equal(options.environment.V1_RELEASE_COMMIT_SHA, RELEASE_SHA);
      assert.equal(options.environment.V1_SOURCE_ARCHIVE_SHA256, SOURCE_SHA);
      assert.equal(options.environment.V1_CANDIDATE_IMAGE_DIGEST, IMAGE_DIGEST);
      assert.equal(options.environment.V1_CANDIDATE_REVISION, REVISION);
      await exerciseControlledWorkloadNetwork(options.fetchImpl, record, {
        messageReadCount: 5_100,
      });
      await options.writeArtifact({
        filePath: join(directory, `${RELEASE_SHA}-${record.artifactSha256}.json`), contents, record,
      });
      runnerCompleted = true;
      return {
        exitCode: 0,
        publicReport: { status: 'recorded', code: 'LATENCY_ACCEPTANCE_PASSED', artifactSha256: record.artifactSha256 },
      };
    },
    workloadFetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const status = path === '/api/v1/messages' && options.method === 'POST' ? 202
        : path === '/api/v1/voice/transcriptions' && options.method === 'POST' ? 202
          : options.headers?.Range === 'bytes=0-3' ? 206 : 200;
      return { status };
    },
    workloadPrivacyTokenExecutor: async () => { throw new Error('injected privacy producer owns token transport'); },
    produceWorkloadPrivacyArtifact: async ({ plan: privacyPlan, locator }) => {
      privacyProducerCalls += 1;
      const boundary = locator.filePath.endsWith('privacy-start.json') ? 'start' : 'end';
      return controlledWorkloadPrivacyArtifact(privacyPlan, locator, boundary);
    },
    verifyTask8Evidence: async (entry, phase, _releasePlan, { gateWindow }) => {
      assert.equal(phase, 'workload');
      assert.deepEqual(gateWindow, {
        gateStartedAt: '2026-08-26T08:05:00.000Z',
        gateEndedAt: '2026-08-26T08:05:00.000Z',
      });
      for (const reference of [entry.privacyProofs.start, entry.privacyProofs.end]) {
        const bytes = await readFile(reference.filePath);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.objectSha256);
      }
      return true;
    },
    execute: async (argv) => {
      assert.deepEqual(argv.slice(0, 2), ['logging', 'read']);
      return controlPlaneLogEntries(record);
    },
    persistReceipt: async (_releasePlan, receipt) => {
      publishedBeforeRunnerCompleted = !runnerCompleted;
      persisted = structuredClone(receipt);
      return true;
    },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(runnerCalls, 1);
  assert.equal(privacyProducerCalls, 2);
  assert.equal(controlledWrites, 3);
  assert.deepEqual(workloadState.records.map(({ recordType }) => recordType), [
    'intent', 'checkpoint', 'terminal',
  ]);
  assert.equal(publishedBeforeRunnerCompleted, false);
  assert.equal((await readFile(workloadPath, 'utf8')), contents);
  assert.equal(persisted.outputs.artifactSha256, record.artifactSha256);
  assert.equal(persisted.outputs.objectSha256,
    createHash('sha256').update(contents).digest('hex'));
  assert.equal(persisted.outputs.execution.attemptId, attemptId);
  assert.equal(persisted.outputs.execution.acceptanceWindowId,
    record.rawReceipts.acceptanceWindowId);
  assert.deepEqual(persisted.outputs.privacyProofs, result.publicReport.phaseReceipt.outputs.privacyProofs);
  assert.equal((await readFile(input.task8Evidence.workload.privacyProofs.start.filePath, 'utf8')).endsWith('\n'), true);
  assert.equal((await readFile(input.task8Evidence.workload.privacyProofs.end.filePath, 'utf8')).endsWith('\n'), true);
  assert.match(persisted.outputs.execution.networkWitnessSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(persisted).includes('Authorization'), false);
  assert.equal(JSON.stringify(persisted).includes('Bearer'), false);
});

test('workload publication adopts every artifact, receipt, and terminal crash boundary', async (t) => {
  for (const crashBoundary of [
    'privacy-start', 'privacy-end', 'workload-json', 'before-receipt', 'before-terminal',
  ]) {
    await t.test(crashBoundary, async (st) => {
      const directory = await mkdtemp(join(tmpdir(), `hkbuddy-workload-${crashBoundary}-`));
      st.after(() => rm(directory, { recursive: true, force: true }));
      const base = releaseInput();
      const unresolved = {
        ...base.task8Evidence.workload,
        filePath: join(directory, 'workload.json'),
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
        privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
          ...base.task8Evidence.workload.privacyProofs[boundary],
          filePath: join(directory, `privacy-${boundary}.json`),
          artifactSha256: '0'.repeat(64), objectSha256: '0'.repeat(64),
          boundarySha256: '0'.repeat(64),
        }])),
      };
      const input = releaseInput({ task8Evidence: { ...base.task8Evidence, workload: unresolved } });
      const plan = buildReleasePlan(input, { phase: 'workload' });
      const record = validWorkloadAcceptanceRecord();
      const contents = `${JSON.stringify(record, null, 2)}\n`;
      const records = [];
      let producerCalls = 0;
      let writes = 0;
      let persistedReceipt = null;
      let crashTerminal = crashBoundary === 'before-terminal';
      const stateStore = () => {
        const store = createTestStateStore({ records });
        if (crashTerminal) {
          store.appendTerminal = async () => {
            crashTerminal = false;
            throw new Error('simulated terminal crash');
          };
        }
        return store;
      };
      const baseOptions = {
        argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`],
        input,
        environment: { V1_LATENCY_ASR_FIXTURE_MANIFEST: join(directory, 'fixtures.json') },
        randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        journalAttemptId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        loadReceipts: async (_plan, { through }) => fixtureReceiptChain(plan, through),
        openStateStore: async () => stateStore(),
        recoverTerminal: async ({ receipt, terminalState, appendTerminal: append }) => append({
          status: 'phase-complete',
          checkpointRecordSha256: records.findLast(({ recordType }) => (
            recordType === 'checkpoint'
          )).recordSha256,
          receiptSha256: receipt.receiptSha256,
          terminalState,
          mutationCount: 1,
          responseLossOperationIds: [],
        }),
        workloadFetch: async (url, options = {}) => {
          const path = new URL(url).pathname;
          return { status: path === '/api/v1/messages' && options.method === 'POST' ? 202
            : path === '/api/v1/voice/transcriptions' && options.method === 'POST' ? 202
              : options.headers?.Range === 'bytes=0-3' ? 206 : 200 };
        },
        workloadPrivacyTokenExecutor: async () => 'unused',
        produceWorkloadPrivacyArtifact: async ({ plan: privacyPlan, locator }) => (
          controlledWorkloadPrivacyArtifact(
            privacyPlan,
            locator,
            locator.filePath.endsWith('privacy-start.json') ? 'start' : 'end',
          )
        ),
        execute: async () => controlPlaneLogEntries(record),
        validateWorkloadPrivacyProof: () => true,
        verifyTask8Evidence: async () => true,
        now: () => new Date('2026-08-26T08:05:00.000Z'),
        writeOutput: () => undefined,
      };
      const first = await runGcpRelease({
        ...baseOptions,
        executeWorkload: async (options) => {
          producerCalls += 1;
          await exerciseControlledWorkloadNetwork(options.fetchImpl, record);
          await options.writeArtifact({
            filePath: join(directory, `${RELEASE_SHA}-${record.artifactSha256}.json`),
            contents,
            record,
          });
          return {
            exitCode: 0,
            publicReport: {
              status: 'recorded', code: 'LATENCY_ACCEPTANCE_PASSED',
              artifactSha256: record.artifactSha256,
            },
          };
        },
        writeControlledArtifact: async (filePath, bytes) => {
          assert.equal(records.at(-1)?.recordType, 'intent');
          await writeFile(filePath, bytes, { flag: 'wx' });
          writes += 1;
          const writeCrash = {
            'privacy-start': 1, 'privacy-end': 2, 'workload-json': 3,
          }[crashBoundary];
          if (writes === writeCrash) throw new Error('simulated artifact crash');
          return true;
        },
        persistReceipt: async (_plan, receipt) => {
          if (crashBoundary === 'before-receipt') throw new Error('simulated receipt crash');
          persistedReceipt = structuredClone(receipt);
          return true;
        },
      });
      assert.equal(first.exitCode, 1, `${crashBoundary}: ${JSON.stringify(first.publicReport)}`);
      assert.equal(records[0].recordType, 'intent');
      assert.equal(records[0].payload.publication.artifacts.length, 3);
      assert.deepEqual(records[0].payload.publication.artifacts.map(({ role }) => role), [
        'privacy-start', 'privacy-end', 'evidence',
      ]);
      assert.equal(producerCalls, 1);

      let resumedReceipt = null;
      const resumed = await runGcpRelease({
        ...baseOptions,
        executeWorkload: async () => { producerCalls += 1; throw new Error('producer replay'); },
        writeControlledArtifact: async (filePath, bytes) => {
          await writeFile(filePath, bytes, { flag: 'wx' });
          return true;
        },
        loadPhaseReceipt: async () => persistedReceipt,
        persistReceipt: async (_plan, receipt) => {
          resumedReceipt = structuredClone(receipt);
          return true;
        },
      });
      assert.equal(resumed.exitCode, 0, `${crashBoundary}: ${JSON.stringify(resumed.publicReport)}`);
      assert.equal(producerCalls, 1);
      assert.equal(records.at(-1).recordType, 'terminal');
      assert.ok(resumedReceipt ?? persistedReceipt);
      for (const filePath of [
        unresolved.privacyProofs.start.filePath,
        unresolved.privacyProofs.end.filePath,
        unresolved.filePath,
      ]) assert.equal((await readFile(filePath, 'utf8')).endsWith('\n'), true);
    });
  }
});

test('valid-looking constants and 200 request logs cannot create a receipt without witnessed ASR TTS and semantic traffic', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-unwitnessed-workload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = releaseInput();
  const input = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        ...base.task8Evidence.workload,
        filePath: join(directory, 'workload.json'),
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
        privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
          ...base.task8Evidence.workload.privacyProofs[boundary],
          filePath: join(directory, `privacy-${boundary}.json`),
          artifactSha256: '0'.repeat(64),
          objectSha256: '0'.repeat(64),
          boundarySha256: '0'.repeat(64),
        }])),
      },
    },
  });
  const plan = buildReleasePlan(input);
  const record = validWorkloadAcceptanceRecord();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  let persisted = false;
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`], input,
    environment: { V1_LATENCY_ASR_FIXTURE_MANIFEST: join(directory, 'fixtures.json') },
    loadReceipts: async (_releasePlan, { through }) => fixtureReceiptChain(plan, through),
    executeWorkload: async ({ writeArtifact }) => {
      await writeArtifact({
        filePath: join(directory, `${RELEASE_SHA}-${record.artifactSha256}.json`), contents, record,
      });
      return {
        exitCode: 0,
        publicReport: { status: 'recorded', code: 'LATENCY_ACCEPTANCE_PASSED', artifactSha256: record.artifactSha256 },
      };
    },
    workloadFetch: async () => ({ status: 200 }),
    workloadPrivacyTokenExecutor: async () => { throw new Error('injected privacy producer owns token transport'); },
    produceWorkloadPrivacyArtifact: async ({ plan: privacyPlan, locator }) => (
      controlledWorkloadPrivacyArtifact(
        privacyPlan,
        locator,
        locator.filePath.endsWith('privacy-start.json') ? 'start' : 'end',
      )
    ),
    execute: async (argv) => { calls.push(argv); return controlPlaneLogEntries(record); },
    persistReceipt: async () => { persisted = true; return true; },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'WORKLOAD_CONTROLLED_NETWORK_INVALID');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(persisted, false);
  assert.deepEqual(calls, []);
});

test('promotion rejects a fresh workload execution-window mismatch before any control-plane mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'mobile'),
    verifyTask8Evidence: async (_entry, phase) => phase === 'workload' ? {
      acceptanceWindowId: 'f'.repeat(64),
      candidateOrigin: CANDIDATE_ORIGIN,
      candidateRevision: REVISION,
      controlPlaneRequests: [],
      expectedTraceIds: [],
    } : true,
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'TASK8_EVIDENCE_INVALID');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('real-shape migration, authenticated workload, and tag-free promotion share one receipt chain', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-integrated-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workloadRecord = validWorkloadAcceptanceRecord();
  const workloadBytes = `${JSON.stringify(workloadRecord, null, 2)}\n`;
  const workloadPath = join(directory, 'workload.json');
  const fixtureManifestPath = join(directory, 'asr-fixtures.json');
  const base = releaseInput();
  const input = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        ...base.task8Evidence.workload,
        filePath: workloadPath,
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
        privacyProofs: Object.fromEntries(['start', 'end'].map((boundary) => [boundary, {
          ...base.task8Evidence.workload.privacyProofs[boundary],
          filePath: join(directory, `privacy-${boundary}.json`),
          artifactSha256: '0'.repeat(64),
          objectSha256: '0'.repeat(64),
          boundarySha256: '0'.repeat(64),
        }])),
      },
    },
  });
  const plan = buildReleasePlan(input);
  const receipts = fixtureReceiptChain(plan, 'build');
  const persistReceipt = async (_releasePlan, receipt) => {
    receipts.push(structuredClone(receipt));
    return true;
  };

  const migration = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => structuredClone(receipts),
    persistReceipt,
    execute: async (argv) => {
      if (argv[2] === 'deploy') return { metadata: { name: 'hkbuddy-v1-migrate' } };
      if (argv[2] === 'describe') return realV1JobReadback(plan.expectedMigrationJob);
      if (argv[2] === 'executions' && argv[3] === 'list') return [];
      if (argv[2] === 'execute' || argv[2] === 'executions') return {
        apiVersion: 'run.googleapis.com/v1', kind: 'Execution',
        metadata: {
          name: 'hkbuddy-v1-migrate-release-001',
          labels: { 'run.googleapis.com/job': 'hkbuddy-v1-migrate' },
        },
        spec: { taskCount: 1, parallelism: 1 },
        status: {
          conditions: [{ type: 'Completed', status: 'True' }],
          completionTime: '2026-08-26T08:00:00.000Z', succeededCount: 1,
        },
      };
      throw new Error(`unexpected migration operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(migration.exitCode, 0);

  for (const phase of ['inventory', 'acceptance', 'collect', 'evidence', 'candidate', 'readiness']) {
    const receipt = finalizeReleasePhaseReceipt({
      schemaVersion: 2,
      phase,
      sequence: receipts.length + 1,
      releaseSha: plan.releaseSha,
      releaseIdentitySha256: plan.releaseIdentitySha256,
      phaseIdentitySha256: releasePhaseIdentitySha256(plan, phase),
      candidateService: CANDIDATE_SERVICE,
      stableService: STABLE_SERVICE,
      trafficState: 'candidate-service-private-100',
      stableTrafficState: plan.expectedStable.initialTrafficState,
      previousReceiptSha256: receipts.at(-1).receiptSha256,
      completed: plan.operations.filter((member) => member.phase === phase).map(({ id }) => id),
      outputs: fixtureReceiptOutputs(plan, phase),
    });
    receipts.push(receipt);
    if (phase === 'candidate') {
      Object.defineProperty(receipts, 'candidatePrivacyAnchor', {
        value: {
          privacyProof: candidatePrivacyReference(plan),
          candidateReceiptSha256: receipt.receiptSha256,
        },
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }

  const workload = await runGcpRelease({
    argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`], input,
    environment: { V1_LATENCY_ASR_FIXTURE_MANIFEST: fixtureManifestPath },
    randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    loadReceipts: async () => structuredClone(receipts),
    persistReceipt,
    executeWorkload: async (options) => {
      await exerciseControlledWorkloadNetwork(options.fetchImpl, workloadRecord);
      await options.writeArtifact({
        filePath: join(directory, `${RELEASE_SHA}-${workloadRecord.artifactSha256}.json`),
        contents: workloadBytes,
        record: workloadRecord,
      });
      return {
        exitCode: 0,
        publicReport: {
          status: 'recorded', code: 'LATENCY_ACCEPTANCE_PASSED',
          artifactSha256: workloadRecord.artifactSha256,
        },
      };
    },
    workloadFetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const status = path === '/api/v1/messages' && options.method === 'POST' ? 202
        : path === '/api/v1/voice/transcriptions' && options.method === 'POST' ? 202
          : options.headers?.Range === 'bytes=0-3' ? 206 : 200;
      return { status };
    },
    workloadPrivacyTokenExecutor: async () => { throw new Error('injected privacy producer owns token transport'); },
    produceWorkloadPrivacyArtifact: async ({ plan: privacyPlan, locator }) => (
      controlledWorkloadPrivacyArtifact(
        privacyPlan,
        locator,
        locator.filePath.endsWith('privacy-start.json') ? 'start' : 'end',
      )
    ),
    verifyTask8Evidence: async (_entry, phase) => {
      assert.equal(phase, 'workload');
      return true;
    },
    execute: async (argv) => {
      assert.deepEqual(argv.slice(0, 2), ['logging', 'read']);
      return controlPlaneLogEntries(workloadRecord);
    },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(workload.exitCode, 0, JSON.stringify(workload.publicReport));

  const refreshedInput = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        ...base.task8Evidence.workload,
        filePath: workloadPath,
        artifactSha256: workloadRecord.artifactSha256,
        objectSha256: createHash('sha256').update(workloadBytes).digest('hex'),
        privacyProofs: structuredClone(receipts.at(-1).outputs.privacyProofs),
      },
    },
  });
  const refreshedPlan = buildReleasePlan(refreshedInput);

  receipts.push(finalizeReleasePhaseReceipt({
    schemaVersion: 2,
    phase: 'mobile',
    sequence: receipts.length + 1,
    releaseSha: refreshedPlan.releaseSha,
    releaseIdentitySha256: refreshedPlan.releaseIdentitySha256,
    phaseIdentitySha256: releasePhaseIdentitySha256(refreshedPlan, 'mobile'),
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: 'candidate-service-private-100',
    stableTrafficState: refreshedPlan.expectedStable.initialTrafficState,
    previousReceiptSha256: receipts.at(-1).receiptSha256,
    completed: refreshedPlan.operations.filter((member) => member.phase === 'mobile').map(({ id }) => id),
    outputs: fixtureReceiptOutputs(refreshedPlan, 'mobile'),
  }));

  const currentCandidate = candidateServiceReadback(refreshedPlan);
  let currentStable = stablePriorReadback(refreshedPlan);
  const currentPolicy = stablePublicIam();
  let postPromotionReadbacks = 0;
  const promotion = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input: refreshedInput,
    loadReceipts: async () => structuredClone(receipts),
    verifyReleasePrivacyArtifact: verifyControlledReleasePrivacyArtifact,
    verifyTask8Evidence: async (_entry, phase) => phase === 'workload' ? {
      acceptanceWindowId: workloadRecord.rawReceipts.acceptanceWindowId,
      candidateOrigin: CANDIDATE_ORIGIN,
      candidateRevision: REVISION,
      candidateService: CANDIDATE_SERVICE,
      stableService: STABLE_SERVICE,
      trafficState: 'candidate-service-private-100',
      stableTrafficState: refreshedPlan.expectedStable.initialTrafficState,
      controlPlaneRequests: workloadRecord.rawReceipts.controlPlaneRequests,
      expectedTraceIds: workloadRecord.rawReceipts.textTurns.map(({ traceId }) => traceId),
    } : true,
    writeStableSpec: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'logging') return controlPlaneLogEntries(workloadRecord);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') {
        return artifactReadback(argv.includes(refreshedPlan.previousImage)
          ? refreshedPlan.previousImage : refreshedPlan.image);
      }
      if (argv[1] === 'revisions') {
        if (argv[3] === refreshedPlan.candidateRevision) {
          return structuredClone(refreshedPlan.expectedCandidate);
        }
        if (argv[3] === refreshedPlan.stableRevision) {
          return structuredClone(refreshedPlan.expectedStable);
        }
        return { revision: refreshedPlan.previousRevision, image: refreshedPlan.previousImage };
      }
      if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
        ? candidatePrivateIam() : structuredClone(currentPolicy);
      if (argv[1] === 'services' && argv[2] === 'replace') {
        if (argv.includes('--dry-run')) return structuredClone(refreshedPlan.stableServiceSpec);
        currentStable = stableStagedReadback(refreshedPlan);
        return structuredClone(currentStable);
      }
      if (argv.includes('update-traffic')) {
        currentStable = stablePromotedReadback(refreshedPlan);
        return trafficTargetAcknowledgement(refreshedPlan.stableRevision);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (argv[3] === CANDIDATE_SERVICE) return structuredClone(currentCandidate);
        if (currentStable.traffic[0].revision === STABLE_REVISION) postPromotionReadbacks += 1;
        return structuredClone(currentStable);
      }
      throw new Error(`unexpected promotion operation: ${argv.join(' ')}`);
    },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(promotion.exitCode, 0, JSON.stringify(promotion.publicReport));
  assert.equal(postPromotionReadbacks, 1);
  assert.deepEqual(currentStable.traffic, [{ revision: STABLE_REVISION, tag: null, percent: 100 }]);
  assert.equal(JSON.stringify(currentStable).includes(CANDIDATE_TAG), false);
  assert.deepEqual(currentCandidate, candidateServiceReadback(refreshedPlan));
  assert.equal(currentPolicy.bindings[0].members.includes('allUsers'), true);
});

test('later promotion rereads private candidate and public prior stable before atomic stable switch', () => {
  const plan = buildReleasePlan(releaseInput());
  const operations = plan.operations;
  const ids = operations.map(({ id }) => id);
  for (const id of [
    'promote-candidate-service-readback', 'promote-candidate-revision-readback',
    'promote-candidate-iam-readback', 'promote-candidate-artifact-readback',
  ]) {
    assert.equal(ids.includes(id), true, id);
    assert.equal(ids.indexOf(id) < ids.indexOf('promote-traffic'), true, id);
  }
  assert.equal(ids.includes('promote-public-service'), false);
  assert.equal(ids.indexOf('promote-candidate-artifact-readback')
    < ids.indexOf('promote-stable-service-precheck'), true);
  assert.equal(ids.indexOf('promote-stable-public-iam-precheck')
    < ids.indexOf('promote-stable-deploy'), true);
  assert.equal(ids.indexOf('promote-stable-staged-readback') < ids.indexOf('promote-traffic'), true);
  assert.equal(ids.indexOf('promote-traffic') < ids.indexOf('promote-readback'), true);
  assert.equal(ids.indexOf('promote-readback') < ids.indexOf('promote-public-iam-readback'), true);
  const traffic = operations.find(({ id }) => id === 'promote-traffic');
  assert.equal(traffic.argv.includes(`--to-revisions=${STABLE_REVISION}=100`), true);
  assert.equal(traffic.argv.includes(CANDIDATE_SERVICE), false);
  assert.deepEqual(plan.stableServiceSpec.spec.traffic, [
    { revisionName: plan.previousRevision, percent: 100 },
    { revisionName: STABLE_REVISION, percent: 0 },
  ]);
  const readback = operations.find(({ id }) => id === 'promote-readback');
  assert.deepEqual(readback.argv.slice(0, 4), ['run', 'services', 'describe', 'hkbuddy-v1-api']);
});

function planPhase(plan, phase) {
  return plan.operations.filter((operation) => operation.phase === phase);
}

test('Cloud Build and infrastructure contracts pin the reviewed build identity and dependency-safe startup', async () => {
  const cloudbuild = await readFile(new URL('../cloudbuild.yaml', import.meta.url), 'utf8');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const dockerignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.match(cloudbuild, new RegExp(`serviceAccount: projects/${PROJECT}/serviceAccounts/hkbuddy-v1-build@${PROJECT.replaceAll('.', '\\.')}`));
  assert.match(cloudbuild, /asia-east2-docker\.pkg\.dev\/\$PROJECT_ID\/hkbuddy-v1\/hkbuddy-v1-api:\$_RELEASE_SHA/);
  for (const forbidden of [
    'hkbuddy-prod-v1-20260826',
    '/hkbuddy/hkbuddy-api:',
    'serviceAccounts/hkbuddy-build@',
  ]) assert.equal(cloudbuild.includes(forbidden), false, forbidden);
  assert.match(cloudbuild, /requestedVerifyOption: VERIFIED/);
  assert.match(cloudbuild, /sourceProvenanceHash:\s*\n\s*- SHA256/);
  assert.match(cloudbuild, /gcr\.io\/cloud-builders\/docker@sha256:[0-9a-f]{64}/);
  assert.match(cloudbuild, /--build-arg=V1_RELEASE_COMMIT_SHA=\$_RELEASE_SHA/);
  assert.match(cloudbuild, /--build-arg=V1_SOURCE_ARCHIVE_SHA256=\$_SOURCE_SHA256/);
  assert.match(cloudbuild, /BUILD_CONFIG_SHA256=\$_BUILD_CONFIG_SHA256/);
  assert.match(cloudbuild, /--build-arg=V1_BUILD_CONFIG_SHA256=\$_BUILD_CONFIG_SHA256/);
  assert.match(cloudbuild, /--label=com\.simplify\.build-config-sha256=\$_BUILD_CONFIG_SHA256/);
  assert.match(cloudbuild, /index \.Config\.Labels "com\.simplify\.build-config-sha256"/);
  assert.match(cloudbuild, /--label=org\.opencontainers\.image\.source=https:\/\/github\.com\/jimmy00415\/Cantonese_Learning_Full_stack/);
  assert.match(cloudbuild, /index \.Config\.Labels "org\.opencontainers\.image\.source"/);
  const dependencyGate = cloudbuild.indexOf('- id: dependency-security-gate');
  const dependencyInstall = cloudbuild.indexOf(
    'npm ci --omit=dev --ignore-scripts --no-audit', dependencyGate,
  );
  const dependencyAudit = cloudbuild.indexOf(
    'npm run --silent security:dependencies', dependencyInstall,
  );
  const imageBuild = cloudbuild.indexOf('- id: build');
  assert.notEqual(dependencyGate, -1);
  assert.equal(dependencyInstall > dependencyGate, true);
  assert.equal(dependencyAudit > dependencyInstall, true);
  assert.equal(imageBuild > dependencyAudit, true);
  assert.match(cloudbuild, /npm run --silent security:dependencies/);
  assert.match(cloudbuild, /waitFor:\s*\n\s*- dependency-security-gate/);
  assert.match(dockerfile, /ARG V1_RELEASE_COMMIT_SHA/);
  assert.match(dockerfile, /ARG V1_SOURCE_ARCHIVE_SHA256/);
  assert.match(dockerfile, /ARG V1_BUILD_CONFIG_SHA256/);
  assert.match(dockerfile, /COPY --chown=node:node scripts\/create-image-release-manifest\.js \.\/scripts\/create-image-release-manifest\.js/);
  assert.match(dockerfile, /RUN node scripts\/create-image-release-manifest\.js/);
  assert.equal(dockerignore.includes('!scripts/create-image-release-manifest.js'), true);
  for (const filePath of IMAGE_SCRIPTS) {
    assert.equal(dockerfile.includes(`COPY --chown=node:node ${filePath} ./${filePath}`), true, filePath);
    assert.equal(dockerignore.includes(`!${filePath}`), true, filePath);
  }

  const contract = JSON.parse(await readFile(new URL('../infra/gcp/resource-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.resources.cloudRun.startupProbe.path, '/api/health/ready');
  const deployer = `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`;
  const acceptance = `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`;
  assert.equal(contract.resources.serviceAccounts.some(({ id }) => id === 'hkbuddy-v1-acceptance'), true);
  assert.deepEqual(contract.iam.bindings.filter(({ member }) => member === acceptance), [
    { scope: `bucket:${GCP_IDENTITY.bucket}`, member: acceptance, role: 'roles/storage.objectUser' },
    {
      scope: `bucket:${GCP_IDENTITY.bucket}`, member: acceptance,
      role: `projects/${GCP_IDENTITY.projectId}/roles/hkbuddyV1AcceptanceBucketMetadataReader`,
    },
    { scope: `secret:${GCP_IDENTITY.secrets.dbAppUrl}`, member: acceptance, role: 'roles/secretmanager.secretAccessor' },
    { scope: `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}`, member: acceptance, role: 'roles/secretmanager.secretAccessor' },
    { scope: 'project', member: acceptance, role: 'roles/logging.logWriter' },
    { scope: `secret:${GCP_IDENTITY.secrets.legacy}`, member: acceptance, role: 'roles/secretmanager.secretAccessor' },
  ]);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'service-account:hkbuddy-v1-acceptance' && member === deployer
      && role === 'roles/iam.serviceAccountUser'
  )), true);
  assert.equal(contract.iam.bindings.some(({ member, role }) => (
    member === acceptance && role === 'roles/secretmanager.secretVersionAdder'
  )), false);
  assert.equal(contract.iam.bindings.some(({ member, role }) => (
    member === acceptance && ['roles/aiplatform.user', 'roles/speech.client',
      'roles/serviceusage.serviceUsageConsumer'].includes(role)
  )), false);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'project' && member === deployer && role === 'roles/cloudbuild.builds.editor'
  )), true);
  for (const { secret: v1Secret } of Object.values(EVIDENCE)) {
    assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
      scope === `secret:${v1Secret}` && member === deployer
        && role === 'roles/secretmanager.secretVersionAdder'
    )), true, v1Secret);
  }
  assert.equal(JSON.stringify(contract).includes('roles/run.admin'), true);
  assert.equal(contract.iam.bindings.some(({ role }) => role === 'roles/run.admin'), false);
});

test('operator docs require the complete receipt sequence and manifest refresh boundaries', async () => {
  const [operator, readme] = await Promise.all([
    readFile(new URL('../infra/gcp/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);
  for (const phase of [
    'build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence', 'candidate',
    'readiness', 'workload', 'mobile', 'promote',
  ]) assert.equal([...operator.matchAll(new RegExp(`--phase=${phase}(?:\\s|$)`, 'g'))].length >= 2, true, phase);
  for (const phase of ['candidate-cleanup', 'rollback']) {
    assert.equal([...operator.matchAll(new RegExp(`--phase=${phase}(?:\\s|$)`, 'g'))].length >= 2, true, phase);
  }
  for (const text of [
    'previousImageDigest', 'ROLLBACK_UNAVAILABLE_NO_PRIOR_RELEASE',
    'candidate-service-private-100', 'manifest is deliberately refreshed',
  ]) assert.equal(operator.includes(text), true, text);
  assert.match(readme, /candidate -> readiness -> workload -> mobile -> promote/);
  assert.match(readme, /hkbuddy-v1-api-candidate/);
  assert.match(readme, /ROLLING_RELEASE_UNSUPPORTED_SINGLETON/);
  assert.match(readme, /candidate(?:-service)? absence/);
});
