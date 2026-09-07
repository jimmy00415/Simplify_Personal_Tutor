import { execFile } from 'node:child_process';
import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createDefaultGcloudAuthenticatedRequest,
  createDefaultGcloudExecutor,
  resolveDefaultGcloudLaunch,
} from './gcp-provision.js';
import {
  CANDIDATE_PRIVACY_SCHEMA_VERSION,
  candidatePrivacyBoundarySha256,
  createCandidatePrivacyCommandPlan,
  createIdentityTokenExecutor,
  runCandidatePrivacyProof,
  validateCandidatePrivacyProof,
} from './candidate-privacy-proof.js';
import { containsForbiddenPersistedSecret } from './persisted-secret-contract.js';
import {
  createFinalMutationGuard,
  recoverTerminalFromReceipt,
  validateReconciliationPrefix,
} from './release-reconciliation.js';
import {
  openReleaseStateStore, readBoundedOrdinaryFile, readReleaseJournalRecords,
  writeAtomicCreateOnly,
} from './release-state-store.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';
import {
  cloudRunTaggedUrl,
  normalizeCloudRunServiceUrlAliases,
  normalizeCloudRunV1ServiceUrls,
} from '../src/cloud-run-urls.js';
import { CANONICAL_WAV } from '../src/media/canonical-wav.js';
import { finalizeReleaseEvidenceRecord } from '../src/services/release-evidence.js';
import {
  finalizeEvidenceRecord,
  validateIosVoiceReleaseEvidence,
} from '../src/services/voice-evidence.js';
import {
  LATENCY_ACCEPTANCE_CONTRACT,
  finalizeLatencyAcceptanceRecord,
  normalizeControlPlaneTurnReceipts,
  runLatencyAcceptance,
} from './production-latency-workload.js';
import {
  runTask8Readiness,
  validateTask8ReadinessRecord,
} from './task8-readiness-producer.js';
import {
  runTask8Mobile,
  validateTask8MobileRecord,
} from './task8-mobile-producer.js';
import { inspectPngEvidence } from './png-evidence.js';

const PROJECT = GCP_IDENTITY.projectId;
const REGION = GCP_IDENTITY.region;
const STABLE_SERVICE = GCP_IDENTITY.service;
const CANDIDATE_SERVICE = GCP_IDENTITY.candidateService;
const MIGRATION_JOB = GCP_IDENTITY.jobs.migration;
const DEPENDENCY_ACCEPTANCE_JOB = GCP_IDENTITY.jobs.dependencies;
const LLM_SMOKE_JOB = GCP_IDENTITY.jobs.llm;
const ASR_SMOKE_JOB = GCP_IDENTITY.jobs.asr;
const TTS_SMOKE_JOB = GCP_IDENTITY.jobs.tts;
const FAILED_ACCEPTANCE_EXECUTION_JOBS = Object.freeze({
  'dependency-acceptance': DEPENDENCY_ACCEPTANCE_JOB,
  'llm-smoke': LLM_SMOKE_JOB,
  'asr-smoke': ASR_SMOKE_JOB,
  'tts-smoke': TTS_SMOKE_JOB,
});
const REPOSITORY = GCP_IDENTITY.repository;
const MEDIA_BUCKET = GCP_IDENTITY.bucket;
const BUILD_SERVICE_ACCOUNT = `projects/${PROJECT}/serviceAccounts/${GCP_IDENTITY.serviceAccounts.build}`;
const RUNTIME_SERVICE_ACCOUNT = GCP_IDENTITY.serviceAccounts.runtime;
const MIGRATOR_SERVICE_ACCOUNT = GCP_IDENTITY.serviceAccounts.migrator;
const ACCEPTANCE_SERVICE_ACCOUNT = GCP_IDENTITY.serviceAccounts.acceptance;
const PROMOTION_AUTHORITY = 'admin@motionexp.com';
const CANDIDATE_INVOKER_ROLE = 'roles/run.servicesInvoker';
const OCI_SOURCE = 'https://github.com/jimmy00415/Cantonese_Learning_Full_stack';
const MAX_CONTROLLED_WORKLOAD_REQUESTS = 20_000;

function createDefaultIdentityTokenExecutor(environment) {
  return createIdentityTokenExecutor({
    request: createDefaultGcloudAuthenticatedRequest({
      environment, account: PROMOTION_AUTHORITY,
    }),
  });
}
const INVOKER_IAM_DISABLED_ANNOTATION = 'run.googleapis.com/invoker-iam-disabled';
const SERVICE_MAX_SCALE_ANNOTATION = 'run.googleapis.com/maxScale';
const SERVICE_MAX_SCALE = '1';
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const NUMERIC_VERSION = /^[1-9]\d*$/;
const ASSIGNED_SECRET_VERSION = '{assigned-secret-version}';
const PROJECT_NUMBER = /^\d{6,20}$/;
const STABLE_REVISION = /^hkbuddy-v1-api-[0-9a-f]{12}$/;
const CANDIDATE_REVISION = /^hkbuddy-v1-api-candidate-[0-9a-f]{12}$/;
const BUILD_SOURCE_PREFIX = 'source/';
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NODE_BUILDER = 'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const DOCKER_BUILDER = 'gcr.io/cloud-builders/docker@sha256:2e8d40d8e48dc14fab4213d5e532d74f63fd403d9e8d7f6463096a75820286c3';
const ACCEPTANCE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failedAcceptanceExecutionContract(operationId) {
  if (typeof operationId !== 'string' || !operationId.endsWith('-execute')) return null;
  const key = operationId.slice(0, -'-execute'.length);
  const job = FAILED_ACCEPTANCE_EXECUTION_JOBS[key];
  if (!job || operationId !== `${key}-execute`) return null;
  return Object.freeze({ deployOperationId: `${key}-deploy`, job, key, operationId });
}
const PHASES = Object.freeze([
  'build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence', 'candidate',
  'readiness', 'workload', 'mobile', 'candidate-cleanup', 'promote', 'rollback',
]);
const RECEIPT_PHASES = Object.freeze([
  'build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence', 'candidate',
  'readiness', 'workload', 'mobile',
]);
const receiptChainAuthorities = new WeakMap();
const ACTION_RECEIPT_PHASES = new Set(['candidate-cleanup', 'promote', 'rollback']);
const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const execFileAsync = promisify(execFile);

const EVIDENCE_DEFINITIONS = Object.freeze({
  legacyInventory: Object.freeze({
    secret: GCP_IDENTITY.secrets.legacy,
    mountPath: '/var/run/secrets/hkbuddy/legacy-inventory/legacy-inventory.json',
    fileEnv: 'V1_LEGACY_RESOURCE_INVENTORY_FILE',
    versionEnv: 'V1_LEGACY_RESOURCE_INVENTORY_VERSION',
  }),
  dependencyAcceptance: Object.freeze({
    secret: GCP_IDENTITY.secrets.dependencies,
    mountPath: '/var/run/secrets/hkbuddy/dependency-acceptance/dependency-acceptance.json',
    fileEnv: 'V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE',
    versionEnv: 'V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION',
  }),
  llmSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.llm,
    mountPath: '/var/run/secrets/hkbuddy/llm-smoke/llm-smoke.json',
    fileEnv: 'V1_LLM_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_LLM_SMOKE_EVIDENCE_VERSION',
  }),
  asrSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.asr,
    mountPath: '/var/run/secrets/hkbuddy/asr-smoke/asr-smoke.json',
    fileEnv: 'V1_ASR_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_ASR_SMOKE_EVIDENCE_VERSION',
  }),
  ttsSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.tts,
    mountPath: '/var/run/secrets/hkbuddy/tts-smoke/tts-smoke.json',
    fileEnv: 'V1_TTS_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_TTS_SMOKE_EVIDENCE_VERSION',
  }),
  iosVoiceAcceptance: Object.freeze({
    secret: GCP_IDENTITY.secrets.ios,
    mountPath: '/var/run/secrets/hkbuddy/ios-voice-acceptance/ios-voice-acceptance.json',
    fileEnv: 'V1_IOS_VOICE_ACCEPTANCE_FILE',
    versionEnv: 'V1_IOS_VOICE_ACCEPTANCE_VERSION',
  }),
});

function releaseContractError() {
  return new Error('GCP release contract is invalid');
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'));
}

export { containsForbiddenPersistedSecret } from './persisted-secret-contract.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function exact(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function trafficContractError() {
  return new Error('Cloud Run traffic readback is invalid');
}

function exactTrafficService(value) {
  if (![STABLE_SERVICE, CANDIDATE_SERVICE].includes(value)) throw trafficContractError();
  return value;
}

function exactTrafficRevision(value, service) {
  const pattern = service === CANDIDATE_SERVICE ? CANDIDATE_REVISION : STABLE_REVISION;
  if (!pattern.test(String(value ?? ''))) throw trafficContractError();
  return value;
}

function exactTrafficPercent(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw trafficContractError();
  return value;
}

function exactCandidateTag(value, revision, service) {
  const suffix = String(revision).slice(-12);
  if (service !== CANDIDATE_SERVICE || value !== `candidate-${suffix}`) {
    throw trafficContractError();
  }
  return value;
}

function finalizeTrafficRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1) throw trafficContractError();
  const revisions = new Set();
  const tags = new Set();
  let total = 0;
  for (const row of rows) {
    if (revisions.has(row.revision)) throw trafficContractError();
    revisions.add(row.revision);
    if (row.tag !== null) {
      if (tags.has(row.tag)) throw trafficContractError();
      tags.add(row.tag);
    }
    total += row.percent;
  }
  if (total !== 100) throw trafficContractError();
  return rows.map((row) => ({ ...row })).sort((left, right) => (
    right.percent - left.percent
      || left.revision.localeCompare(right.revision)
      || String(left.tag ?? '').localeCompare(String(right.tag ?? ''))
  ));
}

export function normalizeControlledTraffic(value, { service } = {}) {
  exactTrafficService(service);
  if (!Array.isArray(value)) throw trafficContractError();
  const rows = value.map((row) => {
    const tagged = exactKeys(row, ['percent', 'revisionName', 'tag']);
    if (!tagged && !exactKeys(row, ['percent', 'revisionName'])) throw trafficContractError();
    const revision = exactTrafficRevision(row.revisionName, service);
    const tag = tagged ? exactCandidateTag(row.tag, revision, service) : null;
    return { revision, tag, percent: exactTrafficPercent(row.percent) };
  });
  return finalizeTrafficRows(rows);
}

export function normalizeInternalTraffic(value, { service } = {}) {
  exactTrafficService(service);
  if (!Array.isArray(value)) throw trafficContractError();
  const rows = value.map((row) => {
    if (!exactKeys(row, ['percent', 'revision', 'tag'])) throw trafficContractError();
    const revision = exactTrafficRevision(row.revision, service);
    const tag = row.tag === null ? null : exactCandidateTag(row.tag, revision, service);
    return { revision, tag, percent: exactTrafficPercent(row.percent) };
  });
  return finalizeTrafficRows(rows);
}

export function normalizeCloudRunV1Traffic(value, { service, serviceUrls } = {}) {
  exactTrafficService(service);
  if (!Array.isArray(value)) throw trafficContractError();
  let serviceUrlAliases;
  try {
    serviceUrlAliases = normalizeCloudRunServiceUrlAliases(serviceUrls, {
      service, projectNumber: GCP_IDENTITY.projectNumber, region: REGION,
    });
  } catch { throw trafficContractError(); }
  const rows = value.map((row) => {
    const tagged = exactKeys(row, ['percent', 'revisionName', 'tag', 'url']);
    if (!tagged && !exactKeys(row, ['percent', 'revisionName'])) throw trafficContractError();
    const revision = exactTrafficRevision(row.revisionName, service);
    const tag = tagged ? exactCandidateTag(row.tag, revision, service) : null;
    if (tagged) {
      const allowedTaggedUrls = new Set(
        serviceUrlAliases.map((url) => cloudRunTaggedUrl(tag, url)),
      );
      if (!allowedTaggedUrls.has(row.url)) throw trafficContractError();
    }
    return { revision, tag, percent: exactTrafficPercent(row.percent) };
  });
  return finalizeTrafficRows(rows);
}

export function assertExactTraffic(value, {
  kind, service, serviceUrls, expected,
} = {}) {
  const normalize = {
    controlled: normalizeControlledTraffic,
    internal: normalizeInternalTraffic,
    'raw-v1': normalizeCloudRunV1Traffic,
  }[kind];
  if (!normalize) throw trafficContractError();
  const actualRows = normalize(value, { service, serviceUrls });
  const expectedRows = normalizeInternalTraffic(expected, { service });
  if (!exact(actualRows, expectedRows)) throw trafficContractError();
  return true;
}

export function validateTrafficTargetAcknowledgement(value, { revision, serviceUrl } = {}) {
  const expected = [{
    displayPercent: '100%',
    displayRevisionId: revision,
    displayTags: '',
    key: revision,
    latestRevision: false,
    revisionName: revision,
    serviceUrl,
    specPercent: '100',
    specTags: '-',
    statusPercent: '100',
    statusTags: '-',
    tags: [],
    urls: [],
  }];
  if (!STABLE_REVISION.test(String(revision ?? ''))
    || serviceUrl !== `https://${STABLE_SERVICE}-${GCP_IDENTITY.projectNumber}.${REGION}.run.app`
    || !exact(value, expected)) throw trafficContractError();
  return true;
}

function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function finalizeReleasePhaseReceipt(record) {
  const { receiptSha256: ignored, ...payload } = record ?? {};
  void ignored;
  return Object.freeze({ ...payload, receiptSha256: canonicalSha256(payload) });
}

function isAbsoluteFile(value) {
  return typeof value === 'string' && value.length > 3
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
    && !/[\u0000\r\n]/.test(value);
}

function assertPrivacyProofReference(value, { allowLegacyUnresolved = false } = {}) {
  const observedAt = Date.parse(value?.observedAt);
  const expiresAt = Date.parse(value?.expiresAt);
  const unresolved = [value?.artifactSha256, value?.objectSha256, value?.boundarySha256]
    .every((member) => member === '0'.repeat(64));
  const validSchema = value?.schemaVersion === CANDIDATE_PRIVACY_SCHEMA_VERSION
    || (allowLegacyUnresolved && unresolved && value?.schemaVersion === 3);
  if (!exactKeys(value, [
    'artifactSha256', 'boundarySha256', 'expiresAt', 'filePath', 'objectSha256',
    'observedAt', 'schemaVersion',
  ])
    || !validSchema
    || !isAbsoluteFile(value.filePath)
    || !DIGEST.test(String(value.artifactSha256 ?? ''))
    || !DIGEST.test(String(value.objectSha256 ?? ''))
    || !DIGEST.test(String(value.boundarySha256 ?? ''))
    || !Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
    || expiresAt - observedAt !== 5 * 60_000
    || containsForbiddenPersistedSecret(value)) throw releaseContractError();
  return Object.freeze({ ...value });
}

export function assertTask8Evidence(value, { stableTrafficState, now = new Date() } = {}) {
  if (!exactKeys(value, ['mobile', 'readiness', 'workload'])) throw releaseContractError();
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!exactKeys(entry, [
      'artifactSha256', 'candidateService', 'filePath', 'objectSha256', 'schemaVersion',
      'privacyProofs', 'stableService', 'stableTrafficState', 'trafficState',
    ])
      || entry.schemaVersion !== 3
      || !isAbsoluteFile(entry.filePath)
      || !DIGEST.test(String(entry.artifactSha256 ?? ''))
      || !DIGEST.test(String(entry.objectSha256 ?? ''))
      || entry.candidateService !== CANDIDATE_SERVICE
      || entry.stableService !== STABLE_SERVICE
      || entry.trafficState !== 'candidate-service-private-100'
      || entry.stableTrafficState !== stableTrafficState
      || !exactKeys(entry.privacyProofs, ['end', 'start'])) throw releaseContractError();
    const start = assertPrivacyProofReference(entry.privacyProofs.start, {
      allowLegacyUnresolved: true,
    });
    const end = assertPrivacyProofReference(entry.privacyProofs.end, {
      allowLegacyUnresolved: true,
    });
    const startObserved = Date.parse(start.observedAt);
    const endObserved = Date.parse(end.observedAt);
    const unresolvedPair = [start, end].every((reference) => (
      reference.artifactSha256 === '0'.repeat(64)
        && reference.objectSha256 === '0'.repeat(64)
        && reference.boundarySha256 === '0'.repeat(64)
    ));
    const partlyUnresolved = [start, end].some((reference) => (
      [reference.artifactSha256, reference.objectSha256, reference.boundarySha256]
        .every((member) => member === '0'.repeat(64))
    ));
    if (endObserved <= startObserved
      || start.filePath === end.filePath
      || (partlyUnresolved && !unresolvedPair)
      || (!unresolvedPair && (start.artifactSha256 === end.artifactSha256
        || start.objectSha256 === end.objectSha256))) throw releaseContractError();
    if (now !== null) {
      const current = new Date(now).getTime();
      if (!Number.isFinite(current)
        || current < startObserved - 30_000 || current >= Date.parse(start.expiresAt)
        || current < endObserved - 30_000 || current >= Date.parse(end.expiresAt)) {
        throw releaseContractError();
      }
    }
    return [key, Object.freeze({
      ...entry, privacyProofs: Object.freeze({ start, end }),
    })];
  })));
}

export function candidatePrivateInvokerBinding() {
  return Object.freeze({
    member: `serviceAccount:${ACCEPTANCE_SERVICE_ACCOUNT}`,
    role: CANDIDATE_INVOKER_ROLE,
  });
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('end', resolveStream);
    stream.on('error', rejectStream);
  });
  return digest.digest('hex');
}

async function verifyReleaseArchiveBytes(filePath, expectedSha256) {
  const metadata = await lstat(filePath);
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0
    && await sha256File(filePath) === expectedSha256;
}

async function gitOutput(repositoryRoot, argv) {
  const result = await execFileAsync('git', [
    '--no-optional-locks', '-C', repositoryRoot, ...argv,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitBlob(repositoryRoot, releaseSha, member) {
  const result = await execFileAsync('git', [
    '--no-optional-locks', '-C', repositoryRoot, 'cat-file', 'blob', `${releaseSha}:${member}`,
  ], {
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
    throw new Error('release Git blob is empty');
  }
  return result.stdout;
}

function pathIsOutside(parent, child) {
  const member = relative(parent, child);
  return member === '..' || member.startsWith(`..${sep}`);
}

export async function prepareReleaseArchive({ repositoryRoot, releaseSha, destination } = {}) {
  if (!isAbsoluteFile(repositoryRoot) || !isAbsoluteFile(destination)
    || !RELEASE_SHA.test(String(releaseSha ?? ''))
    || !/\.(?:tar\.gz|tgz)$/i.test(destination)) {
    throw new Error('Release archive requires one clean commit');
  }
  let canonicalRepository;
  let canonicalDestination;
  let canonicalBuildConfig;
  let intermediateTar;
  let archiveStarted = false;
  let buildConfigStarted = false;
  try {
    canonicalRepository = await realpath(repositoryRoot);
    const canonicalParent = await realpath(dirname(destination));
    canonicalDestination = join(canonicalParent, basename(destination));
    intermediateTar = `${canonicalDestination}.partial.tar`;
    if (!pathIsOutside(canonicalRepository, canonicalDestination)) throw new Error('inside repository');
    try {
      await lstat(canonicalDestination);
      throw new Error('destination exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await lstat(intermediateTar);
      throw new Error('intermediate exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const [head, status, commitType, commitTimestamp, trackedFiles] = await Promise.all([
      gitOutput(canonicalRepository, ['rev-parse', '--verify', 'HEAD']),
      gitOutput(canonicalRepository, ['status', '--porcelain=v1', '--untracked-files=all']),
      gitOutput(canonicalRepository, ['cat-file', '-t', releaseSha]),
      gitOutput(canonicalRepository, ['show', '-s', '--format=%ct', releaseSha]),
      gitOutput(canonicalRepository, [
        'ls-tree', '-r', '--name-only', releaseSha, '--', 'production-v1',
      ]),
    ]);
    const members = trackedFiles.split(/\r?\n/u).filter(Boolean);
    if (head !== releaseSha || status !== '' || commitType !== 'commit'
      || !members.includes('production-v1/Dockerfile')
      || !members.includes('production-v1/cloudbuild.yaml')
      || !members.includes('production-v1/data/knowledge/hkbu-v1.json')
      || !/^[1-9][0-9]{8,11}$/u.test(commitTimestamp)) {
      throw new Error('release source is not one clean production commit');
    }

    const buildConfigBytes = await gitBlob(
      canonicalRepository,
      releaseSha,
      'production-v1/cloudbuild.yaml',
    );
    const buildConfigSha256 = createHash('sha256').update(buildConfigBytes).digest('hex');
    canonicalBuildConfig = join(
      canonicalParent,
      `${releaseSha}.${buildConfigSha256}.cloudbuild.yaml`,
    );
    if (!pathIsOutside(canonicalRepository, canonicalBuildConfig)) {
      throw new Error('build config inside repository');
    }
    try {
      await lstat(canonicalBuildConfig);
      throw new Error('build config exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await writeFile(canonicalBuildConfig, buildConfigBytes, { flag: 'wx', mode: 0o600 });
    buildConfigStarted = true;
    const frozenBuildConfig = await lstat(canonicalBuildConfig);
    const frozenBuildConfigBytes = await readFile(canonicalBuildConfig);
    if (!frozenBuildConfig.isFile() || frozenBuildConfig.isSymbolicLink()
      || frozenBuildConfig.size !== buildConfigBytes.length
      || createHash('sha256').update(frozenBuildConfigBytes).digest('hex') !== buildConfigSha256) {
      throw new Error('frozen build config drift');
    }

    archiveStarted = true;
    await gitOutput(canonicalRepository, [
      'archive', '--format=tar', `--mtime=@${commitTimestamp}`, `--output=${intermediateTar}`,
      `${releaseSha}:production-v1`,
    ]);
    await pipeline(
      createReadStream(intermediateTar),
      createGzip({ level: 9, mtime: 0 }),
      createWriteStream(canonicalDestination, { flags: 'wx' }),
    );
    await rm(intermediateTar, { force: true });
    const [headAfter, statusAfter] = await Promise.all([
      gitOutput(canonicalRepository, ['rev-parse', '--verify', 'HEAD']),
      gitOutput(canonicalRepository, ['status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    if (headAfter !== releaseSha || statusAfter !== '') {
      throw new Error('release source changed while archiving');
    }
    return Object.freeze({
      releaseSha,
      sourceArchive: canonicalDestination,
      sourceArchiveSha256: await sha256File(canonicalDestination),
      buildConfig: canonicalBuildConfig,
      buildConfigSha256,
    });
  } catch {
    if (archiveStarted && canonicalDestination) {
      await rm(canonicalDestination, { force: true }).catch(() => undefined);
    }
    if (archiveStarted && intermediateTar) {
      await rm(intermediateTar, { force: true }).catch(() => undefined);
    }
    if (buildConfigStarted && canonicalBuildConfig) {
      await rm(canonicalBuildConfig, { force: true }).catch(() => undefined);
    }
    throw new Error('Release archive requires one clean commit');
  }
}

function archiveCommandSelection(argv) {
  if (!Array.isArray(argv)) return null;
  const selected = {};
  let prepare = false;
  let confirmed = false;
  for (const member of argv) {
    if (member === '--prepare-archive' && !prepare) prepare = true;
    else if (typeof member === 'string' && member.startsWith('--repository-root=')
      && selected.repositoryRoot === undefined) {
      selected.repositoryRoot = member.slice('--repository-root='.length);
    } else if (typeof member === 'string' && member.startsWith('--destination=')
      && selected.destination === undefined) {
      selected.destination = member.slice('--destination='.length);
    } else if (typeof member === 'string' && member.startsWith('--release-sha=')
      && selected.releaseSha === undefined) {
      selected.releaseSha = member.slice('--release-sha='.length);
    } else if (typeof member === 'string' && member.startsWith('--confirm-archive=') && !confirmed) {
      selected.confirmationSha = member.slice('--confirm-archive='.length);
      confirmed = true;
    } else return null;
  }
  if (!prepare || !isAbsoluteFile(selected.repositoryRoot) || !isAbsoluteFile(selected.destination)
    || !RELEASE_SHA.test(String(selected.releaseSha ?? ''))
    || (confirmed && selected.confirmationSha !== selected.releaseSha)) return null;
  return { ...selected, confirmed };
}

export async function runPrepareReleaseArchive({
  argv = process.argv.slice(2),
  prepare = prepareReleaseArchive,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const selection = archiveCommandSelection(argv);
  if (!selection || typeof prepare !== 'function') {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'EXACT_ARCHIVE_CONFIRMATION_REQUIRED', mutationPerformed: false,
    });
  }
  if (!selection.confirmed) {
    return publish(writeOutput, 0, {
      status: 'dry-run', code: 'RELEASE_ARCHIVE_DRY_RUN', mutationPerformed: false,
      releaseSha: selection.releaseSha,
      sourceArchive: selection.destination,
    });
  }
  try {
    const result = await prepare({
      repositoryRoot: selection.repositoryRoot,
      releaseSha: selection.releaseSha,
      destination: selection.destination,
    });
    return publish(writeOutput, 0, {
      status: 'archive-complete', code: 'RELEASE_ARCHIVE_COMPLETE', mutationPerformed: true,
      releaseSha: result.releaseSha,
      sourceArchive: result.sourceArchive,
      sourceArchiveSha256: result.sourceArchiveSha256,
      buildConfig: result.buildConfig,
      buildConfigSha256: result.buildConfigSha256,
    });
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'RELEASE_ARCHIVE_FAILED', mutationPerformed: false,
      releaseSha: selection.releaseSha,
    });
  }
}

function assertEvidenceEntry(key, value, { allowUnresolvedSecretVersion = false } = {}) {
  const expected = EVIDENCE_DEFINITIONS[key];
  if (!expected || !exactKeys(value, [
    'artifactSha256', 'filePath', 'objectSha256', 'secret', 'secretVersion',
  ])
    || value.secret !== expected.secret
    || (!(allowUnresolvedSecretVersion && value.secretVersion === null)
      && !NUMERIC_VERSION.test(String(value.secretVersion ?? '')))
    || !DIGEST.test(String(value.artifactSha256 ?? ''))
    || !DIGEST.test(String(value.objectSha256 ?? ''))
    || !isAbsoluteFile(value.filePath)) throw releaseContractError();
  return Object.freeze({ ...value });
}

function assertEvidence(evidence, { allowUnresolvedSecretVersions = false } = {}) {
  const keys = Object.keys(EVIDENCE_DEFINITIONS);
  if (!exactKeys(evidence, keys)) throw releaseContractError();
  return Object.freeze(Object.fromEntries(keys.map((key) => [
    key, assertEvidenceEntry(key, evidence[key], {
      allowUnresolvedSecretVersion: allowUnresolvedSecretVersions && key !== 'legacyInventory',
    }),
  ])));
}

function expectedAcceptanceObjects(releaseSha, runId) {
  return Object.freeze({
    dependencyAcceptance: `release-evidence/${releaseSha}/dependency-acceptance/${runId}.json`,
    llmSmoke: `release-evidence/${releaseSha}/llm-smoke/llm-${runId}.json`,
    asrSmoke: `release-evidence/${releaseSha}/voice-smoke/asr-${runId}.json`,
    ttsSmoke: `release-evidence/${releaseSha}/voice-smoke/tts-${runId}.json`,
  });
}

function assertAcceptanceOutputs(value, { releaseSha, runId } = {}) {
  const expectedObjects = expectedAcceptanceObjects(releaseSha, runId);
  if (!exactKeys(value, Object.keys(expectedObjects))) throw releaseContractError();
  const normalized = {};
  const filePaths = new Set();
  for (const [key, object] of Object.entries(expectedObjects)) {
    const member = value[key];
    if (!exactKeys(member, ['bucket', 'filePath', 'generation', 'object'])
      || member.bucket !== MEDIA_BUCKET
      || member.object !== object
      || !NUMERIC_VERSION.test(String(member.generation ?? ''))
      || !isAbsoluteFile(member.filePath)
      || filePaths.has(member.filePath)) throw releaseContractError();
    filePaths.add(member.filePath);
    normalized[key] = Object.freeze({ ...member });
  }
  return Object.freeze(normalized);
}

function environmentFor({ releaseSha, serviceOrigin, candidateOrigin, evidence }) {
  const environment = {
    NODE_ENV: 'production',
    V1_PUBLIC_ORIGIN: serviceOrigin,
    V1_CANDIDATE_ORIGIN: candidateOrigin,
    V1_RUNTIME_SERVICE_ACCOUNT: RUNTIME_SERVICE_ACCOUNT,
    V1_TRUST_PROXY_HOPS: '1',
    V1_STORE_DRIVER: 'postgres',
    V1_POSTGRES_RESOURCE_ID: `//sqladmin.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}`,
    V1_MEDIA_DRIVER: 'gcs',
    V1_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_GCS_BUCKET: MEDIA_BUCKET,
    V1_GCS_RESOURCE_ID: `//storage.googleapis.com/projects/_/buckets/${MEDIA_BUCKET}`,
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    V1_LLM_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
    V1_RELEASE_COMMIT_SHA: releaseSha,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
    V1_INSTANCE_POLICY: 'single',
    V1_PRIVACY_NOTICE_VERSION: '2026-08-26-production-v1',
    V1_PRIVACY_NOTICE_APPROVED: 'true',
    V1_RETENTION_WORKER_ENABLED: 'true',
  };
  for (const [key, definition] of Object.entries(EVIDENCE_DEFINITIONS)) {
    environment[definition.fileEnv] = definition.mountPath;
    environment[definition.versionEnv] = evidence[key].artifactSha256;
  }
  return Object.freeze(environment);
}

function secretBindings(databaseSecretVersions, evidence) {
  const environment = Object.freeze({
    V1_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbAppUrl, version: databaseSecretVersions.app }),
    V1_SESSION_SECRET: Object.freeze({ secret: GCP_IDENTITY.secrets.session, version: databaseSecretVersions.session }),
  });
  const mounts = {};
  for (const [key, definition] of Object.entries(EVIDENCE_DEFINITIONS)) {
    mounts[key] = Object.freeze({
      path: definition.mountPath,
      secret: definition.secret,
      version: evidence[key].secretVersion,
      readOnly: true,
    });
  }
  return Object.freeze({ environment, mounts: Object.freeze(mounts) });
}

function envFlag(environment) {
  return `--set-env-vars=${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join(',')}`;
}

function secretsFlag(bindings) {
  return `--set-secrets=${[
    ...Object.entries(bindings.environment).map(([key, value]) => (
      `${key}=${value.secret}:${value.version}`
    )),
    ...Object.values(bindings.mounts).map((value) => (
      `${value.path}=${value.secret}:${value.version}`
    )),
  ].join(',')}`;
}

function operation(phase, id, argv) {
  if (!PHASES.includes(phase) || typeof id !== 'string' || !Array.isArray(argv)
    || argv.some((value) => typeof value !== 'string' || /[\u0000\r\n]/.test(value))) {
    throw releaseContractError();
  }
  return Object.freeze({ phase, id, argv: Object.freeze([...argv]) });
}

function candidateTrafficPercent() {
  return 100;
}

function candidateTrafficState() {
  return 'candidate-service-private-100';
}

function cloudRunServiceSpec({
  service, revision, releaseSha, image, environment, bindings, probes, traffic,
}) {
  const mountEntries = Object.entries(bindings.mounts).sort(([left], [right]) => left.localeCompare(right));
  const volumes = mountEntries.map(([key, value]) => {
    const separator = value.path.lastIndexOf('/');
    return {
      name: `evidence-${key.replace(/[A-Z]/g, (member) => `-${member.toLowerCase()}`)}`,
      secret: {
        secretName: value.secret,
        items: [{ key: value.version, path: value.path.slice(separator + 1) }],
      },
    };
  });
  const volumeMounts = mountEntries.map(([key, value]) => ({
    name: `evidence-${key.replace(/[A-Z]/g, (member) => `-${member.toLowerCase()}`)}`,
    mountPath: value.path.slice(0, value.path.lastIndexOf('/')),
    readOnly: true,
  }));
  const normalEnvironment = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
  const secretEnvironment = Object.entries(bindings.environment).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      valueFrom: { secretKeyRef: { name: value.secret, key: value.version } },
    }));
  const normalizeProbeForSpec = (value) => ({
    httpGet: { path: value.path, port: value.port },
    initialDelaySeconds: value.initialDelaySeconds,
    timeoutSeconds: value.timeoutSeconds,
    periodSeconds: value.periodSeconds,
    failureThreshold: value.failureThreshold,
  });
  return Object.freeze({
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: Object.freeze({
      name: service,
      annotations: Object.freeze({
        'run.googleapis.com/ingress': 'all',
        [INVOKER_IAM_DISABLED_ANNOTATION]: 'false',
        [SERVICE_MAX_SCALE_ANNOTATION]: SERVICE_MAX_SCALE,
      }),
    }),
    spec: Object.freeze({
      template: Object.freeze({
        metadata: Object.freeze({
          name: revision,
          labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
          annotations: Object.freeze({
            'autoscaling.knative.dev/minScale': '1',
            'autoscaling.knative.dev/maxScale': '1',
            'run.googleapis.com/cpu-throttling': 'false',
            'run.googleapis.com/startup-cpu-boost': 'true',
            'run.googleapis.com/execution-environment': 'gen2',
            'run.googleapis.com/network-interfaces': JSON.stringify([{
              network: GCP_IDENTITY.network, subnetwork: GCP_IDENTITY.subnet,
            }]),
            'run.googleapis.com/vpc-access-egress': 'private-ranges-only',
          }),
        }),
        spec: Object.freeze({
          serviceAccountName: RUNTIME_SERVICE_ACCOUNT,
          containerConcurrency: 40,
          timeoutSeconds: 60,
          containers: Object.freeze([Object.freeze({
            image,
            ports: Object.freeze([Object.freeze({ name: 'http1', containerPort: 8080 })]),
            env: Object.freeze([...normalEnvironment, ...secretEnvironment].map(Object.freeze)),
            resources: Object.freeze({ limits: Object.freeze({ cpu: '2', memory: '1Gi' }) }),
            startupProbe: Object.freeze(normalizeProbeForSpec(probes.startup)),
            livenessProbe: Object.freeze(normalizeProbeForSpec(probes.liveness)),
            readinessProbe: Object.freeze(normalizeProbeForSpec(probes.readiness)),
            volumeMounts: Object.freeze(volumeMounts.map(Object.freeze)),
          })]),
          volumes: Object.freeze(volumes.map(Object.freeze)),
        }),
      }),
      traffic: Object.freeze(traffic.map(({ revision: revisionName, tag, percent }) => Object.freeze({
        revisionName,
        ...(tag === null ? {} : { tag }),
        percent,
      }))),
    }),
  });
}

function candidateServiceSpec({
  candidateRevision, candidateTag, releaseSha, image, environment, bindings, probes,
}) {
  return cloudRunServiceSpec({
    service: CANDIDATE_SERVICE,
    revision: candidateRevision,
    releaseSha,
    image,
    environment,
    bindings,
    probes,
    traffic: [{ revision: candidateRevision, tag: candidateTag, percent: 100 }],
  });
}

function stableServiceSpec({
  stableRevision, previousRevision, releaseSha, image, environment, bindings, probes,
}) {
  return cloudRunServiceSpec({
    service: STABLE_SERVICE,
    revision: stableRevision,
    releaseSha,
    image,
    environment,
    bindings,
    probes,
    traffic: previousRevision === null
      ? [{ revision: stableRevision, tag: null, percent: 100 }]
      : [
        { revision: previousRevision, tag: null, percent: 100 },
        { revision: stableRevision, tag: null, percent: 0 },
      ],
  });
}

async function writeCandidateServiceSpecFile(plan) {
  const contents = `${JSON.stringify(plan.candidateServiceSpec, null, 2)}\n`;
  try {
    const metadata = await lstat(plan.candidateServiceSpecPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || !Buffer.from(await readFile(plan.candidateServiceSpecPath)).equals(Buffer.from(contents))) {
      throw new Error('candidate service specification drift');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(plan.candidateServiceSpecPath, contents, { encoding: 'utf8', flag: 'wx' });
  }
  return true;
}

async function writeStableServiceSpecFile(plan) {
  const contents = `${JSON.stringify(plan.stableServiceSpec, null, 2)}\n`;
  try {
    const metadata = await lstat(plan.stableServiceSpecPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || !Buffer.from(await readFile(plan.stableServiceSpecPath)).equals(Buffer.from(contents))) {
      throw new Error('stable service specification drift');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(plan.stableServiceSpecPath, contents, { encoding: 'utf8', flag: 'wx' });
  }
  return true;
}

function promotionIamRestorePolicyPath(plan, attemptId) {
  if (!UUID.test(String(attemptId ?? ''))) throw new Error('promotion IAM restore attempt is invalid');
  return join(dirname(plan.sourceArchive), `${plan.stableRevision}.iam-restore.${attemptId}.json`);
}

function promotionAttemptPrivacyProofPath(plan, attemptId) {
  if (!UUID.test(String(attemptId ?? ''))) throw new Error('promotion privacy attempt is invalid');
  return join(
    plan.releaseReceiptDirectory,
    `promotion-privacy-proof.${String(attemptId).toLowerCase()}.json`,
  );
}

function artifactDescribeArgv(image) {
  return [
    'artifacts', 'docker', 'images', 'describe', image,
    `--project=${PROJECT}`,
    '--format=json(image_summary.digest,image_summary.fully_qualified_digest)',
  ];
}

function promotionPrivacyReferenceFromJournal(plan, records, attemptId, {
  now,
  validatePrivacyProof,
}) {
  const intents = records.filter(({ recordType, operationId, attemptId: recordAttemptId }) => (
    recordType === 'intent'
    && operationId === 'promote-privacy-publish'
    && recordAttemptId === attemptId
  ));
  if (intents.length !== 1) throw new Error('Promotion privacy publication is unavailable');
  const publication = intents[0]?.payload?.publication;
  const proofRecord = JSON.parse(Buffer.from(
    publication.artifacts[0].contentsBase64, 'base64',
  ).toString('utf8'));
  return privacyArtifactFromPublication(
    plan,
    { filePath: promotionAttemptPrivacyProofPath(plan, attemptId) },
    publication,
    { now: now ?? new Date(proofRecord.occurredAt), validatePrivacyProof },
  ).reference;
}

async function writePromotionIamRestorePolicyFile(plan, policy, { attemptId } = {}) {
  const filePath = promotionIamRestorePolicyPath(plan, attemptId);
  const contents = `${JSON.stringify(policy, null, 2)}\n`;
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return filePath;
}

async function removePromotionIamRestorePolicyFile(plan, filePath) {
  if (filePath !== promotionIamRestorePolicyPath(
    plan,
    basename(filePath).slice(`${plan.stableRevision}.iam-restore.`.length, -'.json'.length),
  )) throw new Error('promotion IAM restore policy path is invalid');
  await rm(filePath);
  try {
    await lstat(filePath);
    throw new Error('promotion IAM restore policy residue remains');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

export function buildReleasePlan(input = {}, { phase = null } = {}) {
  if (phase !== null && !PHASES.includes(phase)) throw releaseContractError();
  const unresolvedImage = phase === 'build' && input.imageDigest === null;
  const unresolvedDatabase = ['build', 'inventory', 'collect', 'evidence', 'rollback'].includes(phase)
    && input.databaseSecretVersions === null;
  const unresolvedEvidence = ['build', 'migration', 'inventory', 'acceptance', 'collect', 'rollback'].includes(phase)
    && input.evidence === null;
  const unresolvedAcceptanceOutputs = ['build', 'migration', 'inventory', 'acceptance', 'rollback'].includes(phase)
    && input.acceptanceOutputs === null;
  if (!exactKeys(input, [
    'acceptanceOutputs', 'acceptanceRunId', 'buildConfig', 'buildConfigSha256', 'databaseSecretVersions', 'evidence', 'imageDigest', 'legacyInventory', 'previousRevision',
    'previousImageDigest', 'projectNumber', 'releaseSha', 'sourceArchive', 'sourceArchiveSha256', 'task8Evidence',
  ])
    || !RELEASE_SHA.test(String(input.releaseSha ?? ''))
    || !ACCEPTANCE_RUN_ID.test(String(input.acceptanceRunId ?? ''))
    || !DIGEST.test(String(input.sourceArchiveSha256 ?? ''))
    || (!IMAGE_DIGEST.test(String(input.imageDigest ?? '')) && !unresolvedImage)
    || !PROJECT_NUMBER.test(String(input.projectNumber ?? ''))
    || input.projectNumber !== GCP_IDENTITY.projectNumber
    || !isAbsoluteFile(input.sourceArchive)
    || !/\.(?:tar\.gz|tgz)$/i.test(input.sourceArchive)
    || !isAbsoluteFile(input.buildConfig)
    || !DIGEST.test(String(input.buildConfigSha256 ?? ''))
    || dirname(input.buildConfig) !== dirname(input.sourceArchive)
    || basename(input.buildConfig) !== `${input.releaseSha}.${input.buildConfigSha256}.cloudbuild.yaml`
    || (!unresolvedDatabase && (
      !exactKeys(input.databaseSecretVersions, ['app', 'migrator', 'session'])
      || Object.values(input.databaseSecretVersions).some((value) => !NUMERIC_VERSION.test(String(value ?? '')))
    ))
    || !((input.previousRevision === null && input.previousImageDigest === null)
      || (STABLE_REVISION.test(String(input.previousRevision ?? ''))
        && IMAGE_DIGEST.test(String(input.previousImageDigest ?? ''))))
    || (!unresolvedEvidence && (input.evidence === null || input.evidence === undefined))) {
    throw releaseContractError();
  }

  const legacyInventory = assertEvidenceEntry('legacyInventory', input.legacyInventory, {
    allowUnresolvedSecretVersion: ['build', 'migration', 'inventory'].includes(phase),
  });
  const evidence = unresolvedEvidence
    ? Object.freeze(Object.fromEntries(Object.entries(EVIDENCE_DEFINITIONS).map(([key, value]) => [
      key,
      key === 'legacyInventory' ? legacyInventory : Object.freeze({
        secret: value.secret,
        secretVersion: '1',
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
        filePath: `/unresolved/${value.secret}.json`,
      }),
    ])))
    : assertEvidence(input.evidence, { allowUnresolvedSecretVersions: phase === 'evidence' });
  if (!exact(evidence.legacyInventory, legacyInventory)) throw releaseContractError();
  const databaseSecretVersions = unresolvedDatabase
    ? Object.freeze({ app: '1', migrator: '1', session: '1' })
    : input.databaseSecretVersions;
  const previousRevision = input.previousRevision;
  const previousImageDigest = input.previousImageDigest;
  const releaseSha = input.releaseSha;
  const stableTrafficState = previousRevision === null ? 'stable-absent' : 'stable-prior-100';
  const task8Evidence = assertTask8Evidence(input.task8Evidence, {
    stableTrafficState, now: null,
  });
  const acceptanceOutputs = unresolvedAcceptanceOutputs
    ? assertAcceptanceOutputs(Object.fromEntries(Object.entries(
      expectedAcceptanceObjects(releaseSha, input.acceptanceRunId),
    ).map(([key, object]) => [key, {
      bucket: MEDIA_BUCKET, object, generation: '1', filePath: `/unresolved/${key}.json`,
    }])), { releaseSha, runId: input.acceptanceRunId })
    : assertAcceptanceOutputs(input.acceptanceOutputs, {
      releaseSha, runId: input.acceptanceRunId,
    });
  if (!unresolvedEvidence && !unresolvedAcceptanceOutputs
    && Object.keys(acceptanceOutputs).some((key) => (
      evidence[key].filePath !== acceptanceOutputs[key].filePath
    ))) throw releaseContractError();
  const candidateSuffix = releaseSha.slice(0, 12);
  const candidateRevision = `${CANDIDATE_SERVICE}-${candidateSuffix}`;
  const stableRevision = `${STABLE_SERVICE}-${candidateSuffix}`;
  const candidateTag = `candidate-${candidateSuffix}`;
  const serviceOrigin = `https://${STABLE_SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const candidateServiceOrigin = `https://${CANDIDATE_SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const candidateOrigin = `https://${candidateTag}---${CANDIDATE_SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const candidateAccess = Object.freeze({
    authenticated: true,
    audience: candidateServiceOrigin,
    issuer: 'https://accounts.google.com',
    subjectSha256: createHash('sha256').update(ACCEPTANCE_SERVICE_ACCOUNT).digest('hex'),
    taggedUrl: candidateOrigin,
  });
  const effectiveImageDigest = input.imageDigest ?? `sha256:${'0'.repeat(64)}`;
  const image = `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}@${effectiveImageDigest}`;
  const previousImage = previousImageDigest === null ? null
    : `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}@${previousImageDigest}`;
  const environment = environmentFor({ releaseSha, serviceOrigin, candidateOrigin, evidence });
  const bindings = secretBindings(databaseSecretVersions, evidence);
  const acceptanceRunId = input.acceptanceRunId;
  const acceptanceSchema = `v1_accept_${acceptanceRunId.replaceAll('-', '')}`;
  const acceptanceGcsPrefix = `v1-accept/${acceptanceRunId}/`;
  const acceptanceOutputObjects = expectedAcceptanceObjects(releaseSha, acceptanceRunId);
  const dependencyEvidenceOutputObject = acceptanceOutputObjects.dependencyAcceptance;
  const postgresResourceId = `//sqladmin.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}`;
  const gcsResourceId = `//storage.googleapis.com/projects/_/buckets/${MEDIA_BUCKET}`;
  const dependencyEnvironment = Object.freeze({
    V1_RELEASE_COMMIT_SHA: releaseSha,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_ACCEPTANCE_CONFIRM_EPHEMERAL: 'true',
    V1_ACCEPTANCE_SCHEMA: acceptanceSchema,
    V1_ACCEPTANCE_GCS_PREFIX: acceptanceGcsPrefix,
    V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT: dependencyEvidenceOutputObject,
    V1_ACCEPTANCE_POSTGRES_RESOURCE_ID: postgresResourceId,
    V1_POSTGRES_RESOURCE_ID: postgresResourceId,
    V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_ACCEPTANCE_GCS_BUCKET: MEDIA_BUCKET,
    V1_GCS_BUCKET: MEDIA_BUCKET,
    V1_ACCEPTANCE_GCS_RESOURCE_ID: gcsResourceId,
    V1_GCS_RESOURCE_ID: gcsResourceId,
    V1_MEDIA_DRIVER: 'gcs',
    V1_LEGACY_RESOURCE_INVENTORY_FILE: EVIDENCE_DEFINITIONS.legacyInventory.mountPath,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: legacyInventory.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
  });
  const dependencySecrets = Object.freeze({
    environment: Object.freeze({
      V1_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbAppUrl, version: databaseSecretVersions.app }),
      V1_ACCEPTANCE_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbAppUrl, version: databaseSecretVersions.app }),
      V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbMigratorUrl, version: databaseSecretVersions.migrator }),
    }),
    mounts: Object.freeze({
      legacyInventory: Object.freeze({
        path: EVIDENCE_DEFINITIONS.legacyInventory.mountPath,
        secret: EVIDENCE_DEFINITIONS.legacyInventory.secret,
        version: legacyInventory.secretVersion,
        readOnly: true,
      }),
    }),
  });
  const smokeEnvironment = Object.freeze({
    NODE_ENV: 'production',
    V1_RELEASE_COMMIT_SHA: releaseSha,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_RUNTIME_SERVICE_ACCOUNT: RUNTIME_SERVICE_ACCOUNT,
    V1_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    V1_LLM_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
  });
  const llmSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_LLM_SMOKE_OUTPUT_BUCKET: MEDIA_BUCKET,
    V1_LLM_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.llmSmoke,
  });
  const asrSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_VOICE_SMOKE_OUTPUT_BUCKET: MEDIA_BUCKET,
    V1_VOICE_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.asrSmoke,
  });
  const ttsSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_VOICE_SMOKE_OUTPUT_BUCKET: MEDIA_BUCKET,
    V1_VOICE_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.ttsSmoke,
  });
  const expectedJobs = Object.freeze({
    'dependency-acceptance': Object.freeze({
      project: PROJECT,
      region: REGION,
      job: DEPENDENCY_ACCEPTANCE_JOB,
      image,
      serviceAccount: ACCEPTANCE_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/real-dependencies-acceptance.js', `--release-sha=${releaseSha}`]),
      taskCount: 1,
      parallelism: 1,
      maxRetries: 0,
      timeoutSeconds: 3600,
      network: GCP_IDENTITY.network,
      subnet: GCP_IDENTITY.subnet,
      vpcEgress: 'private-ranges-only',
      environment: dependencyEnvironment,
      secretEnvironment: dependencySecrets.environment,
      secretMounts: dependencySecrets.mounts,
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
    'llm-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: LLM_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/provider-smoke.js', '--confirm-real-provider']),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 600,
      network: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, vpcEgress: 'private-ranges-only',
      environment: llmSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
    'asr-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: ASR_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze([
        'scripts/voice-provider-smoke.js', '--capability', 'asr',
        '--generate-asr-fixtures-with-pinned-tts', '--confirm-real-voice-provider',
        '--confirm-asr-audio-nonsensitive',
      ]),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 900,
      network: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, vpcEgress: 'private-ranges-only',
      environment: asrSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
    'tts-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: TTS_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/voice-provider-smoke.js', '--capability', 'tts', '--confirm-real-voice-provider']),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 900,
      network: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, vpcEgress: 'private-ranges-only',
      environment: ttsSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
  });
  const expectedMigrationJob = Object.freeze({
    project: PROJECT,
    region: REGION,
    job: MIGRATION_JOB,
    image,
    serviceAccount: MIGRATOR_SERVICE_ACCOUNT,
    command: Object.freeze(['node']),
    args: Object.freeze(['scripts/run-migrations.js']),
    taskCount: 1,
    parallelism: 1,
    maxRetries: 0,
    timeoutSeconds: 600,
    network: GCP_IDENTITY.network,
    subnet: GCP_IDENTITY.subnet,
    vpcEgress: 'private-ranges-only',
    environment: Object.freeze({}),
    secretEnvironment: Object.freeze({
      V1_DATABASE_URL: Object.freeze({
        secret: GCP_IDENTITY.secrets.dbMigratorUrl, version: databaseSecretVersions.migrator,
      }),
    }),
    secretMounts: Object.freeze({}),
    labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
  });
  const probes = Object.freeze({
    startup: Object.freeze({
      path: '/api/health/ready', port: 8080, initialDelaySeconds: 0,
      timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 12,
    }),
    liveness: Object.freeze({
      path: '/api/health/live', port: 8080, initialDelaySeconds: 30,
      timeoutSeconds: 5, periodSeconds: 30, failureThreshold: 3,
    }),
    readiness: Object.freeze({
      path: '/api/health/ready', port: 8080, initialDelaySeconds: 0,
      timeoutSeconds: 5, periodSeconds: 5, failureThreshold: 3,
    }),
  });
  const candidateServiceSpecPath = join(dirname(input.sourceArchive), `${candidateRevision}.service.yaml`);
  const stableServiceSpecPath = join(dirname(input.sourceArchive), `${stableRevision}.service.yaml`);
  const controlledCandidateServiceSpec = candidateServiceSpec({
    candidateRevision, candidateTag, releaseSha,
    image, environment, bindings, probes,
  });
  const controlledStableServiceSpec = stableServiceSpec({
    stableRevision, previousRevision, releaseSha,
    image, environment, bindings, probes,
  });
  const semanticReleaseSpecSha256 = canonicalSha256({
    acceptanceOutputs,
    databaseSecretVersions,
    evidence,
    expectedJobs,
    expectedMigrationJob,
    previousImage,
    previousImageDigest,
    previousRevision,
    candidateServiceSpec: controlledCandidateServiceSpec,
    stableServiceSpec: controlledStableServiceSpec,
    task8Evidence,
  });
  const releaseIdentitySha256 = canonicalSha256({
    project: PROJECT,
    region: REGION,
    releaseSha,
    sourceArchiveSha256: input.sourceArchiveSha256,
    buildConfig: input.buildConfig,
    buildConfigSha256: input.buildConfigSha256,
    projectNumber: input.projectNumber,
    acceptanceRunId,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: candidateTrafficState(),
    stableTrafficState,
    previousRevision,
    previousImageDigest,
  });
  const releaseReceiptDirectory = join(dirname(input.sourceArchive), `${releaseSha}-receipts`);
  const releaseReceiptPaths = Object.freeze(Object.fromEntries(
    RECEIPT_PHASES.map((receiptPhase, index) => [
      receiptPhase,
      join(releaseReceiptDirectory, `${String(index + 1).padStart(2, '0')}-${receiptPhase}.json`),
    ]),
  ));
  const candidatePrivacyProofPath = join(releaseReceiptDirectory, 'candidate-privacy-proof.json');
  const promotionPrivacyProofPath = join(releaseReceiptDirectory, 'promotion-privacy-proof.json');
  const jobDeployArgv = (contract) => [
    'run', 'jobs', 'deploy', contract.job, `--project=${PROJECT}`, `--region=${REGION}`,
    `--image=${contract.image}`, `--service-account=${contract.serviceAccount}`,
    `--command=${contract.command.join(',')}`, `--args=${contract.args.join(',')}`,
    `--tasks=${contract.taskCount}`, `--parallelism=${contract.parallelism}`,
    `--max-retries=${contract.maxRetries}`, `--task-timeout=${contract.timeoutSeconds}s`,
    `--network=${contract.network}`, `--subnet=${contract.subnet}`,
    `--vpc-egress=${contract.vpcEgress}`, `--labels=simplify-release-sha=${releaseSha}`,
    envFlag(contract.environment),
    Object.keys(contract.secretEnvironment).length + Object.keys(contract.secretMounts).length > 0
      ? secretsFlag({ environment: contract.secretEnvironment, mounts: contract.secretMounts })
      : '--clear-secrets',
    '--format=json',
  ];

  const operations = [
    operation('build', 'build-submit', [
      'builds', 'submit', `--config=${input.buildConfig}`,
      `--project=${PROJECT}`, `--region=${REGION}`,
      `--service-account=${BUILD_SERVICE_ACCOUNT}`,
      `--gcs-source-staging-dir=gs://${GCP_IDENTITY.buildSourceBucket}/source`,
      `--substitutions=_BUILD_CONFIG_SHA256=${input.buildConfigSha256},_RELEASE_SHA=${releaseSha},_SOURCE_SHA256=${input.sourceArchiveSha256}`,
      '--format=json', input.sourceArchive,
    ]),
    operation('build', 'build-readback', [
      'builds', 'describe', '{validated-build-id}',
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('migration', 'migration-deploy', [
      'run', 'jobs', 'deploy', MIGRATION_JOB, `--project=${PROJECT}`, `--region=${REGION}`,
      `--image=${image}`, `--service-account=${MIGRATOR_SERVICE_ACCOUNT}`,
      '--command=node', '--args=scripts/run-migrations.js', '--tasks=1', '--parallelism=1',
      '--max-retries=0', '--task-timeout=600s', `--network=${GCP_IDENTITY.network}`,
      `--subnet=${GCP_IDENTITY.subnet}`, '--vpc-egress=private-ranges-only',
      `--labels=simplify-release-sha=${releaseSha}`,
      `--set-secrets=V1_DATABASE_URL=${GCP_IDENTITY.secrets.dbMigratorUrl}:${databaseSecretVersions.migrator}`,
      '--format=json',
    ]),
    operation('migration', 'migration-readback', [
      'run', 'jobs', 'describe', MIGRATION_JOB, `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('migration', 'migration-execute', [
      'run', 'jobs', 'execute', MIGRATION_JOB, '--wait', `--project=${PROJECT}`,
      `--region=${REGION}`, '--format=json',
    ]),
    operation('migration', 'migration-execution-readback', [
      'run', 'jobs', 'executions', 'describe', '{validated-execution-id}',
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
  ];
  operations.push(
    operation('inventory', 'inventory-publish:legacyInventory', [
      'secrets', 'versions', 'add', EVIDENCE_DEFINITIONS.legacyInventory.secret,
      '--data-file=-', `--project=${PROJECT}`, '--format=json',
    ]),
    operation('inventory', 'inventory-readback:legacyInventory', [
      'secrets', 'versions', 'describe', ASSIGNED_SECRET_VERSION,
      `--secret=${EVIDENCE_DEFINITIONS.legacyInventory.secret}`, `--project=${PROJECT}`, '--format=json',
    ]),
    operation('inventory', 'inventory-payload-readback:legacyInventory', [
      'secrets', 'versions', 'access', ASSIGNED_SECRET_VERSION,
      `--secret=${EVIDENCE_DEFINITIONS.legacyInventory.secret}`, `--project=${PROJECT}`,
      '--format=get(payload.data)',
    ]),
  );
  for (const [key, contract] of Object.entries(expectedJobs)) {
    operations.push(
      operation('acceptance', `${key}-deploy`, jobDeployArgv(contract)),
      operation('acceptance', `${key}-readback`, [
        'run', 'jobs', 'describe', contract.job,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('acceptance', `${key}-execute`, [
        'run', 'jobs', 'execute', contract.job, '--wait',
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('acceptance', `${key}-execution-readback`, [
        'run', 'jobs', 'executions', 'describe', '{validated-execution-id}',
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
    );
  }
  for (const [key, output] of Object.entries(acceptanceOutputs)) {
    const generationBoundObject = `gs://${output.bucket}/${output.object}#${output.generation}`;
    operations.push(
      operation('collect', `evidence-collect-describe:${key}`, [
        'storage', 'objects', 'describe', generationBoundObject,
        `--project=${PROJECT}`, '--format=json',
      ]),
      operation('collect', `evidence-collect-copy:${key}`, [
        'storage', 'cp', generationBoundObject, output.filePath,
        '--no-clobber', `--project=${PROJECT}`, '--format=json',
      ]),
    );
  }
  for (const [key, definition] of Object.entries(EVIDENCE_DEFINITIONS)) {
    if (key === 'legacyInventory') continue;
    operations.push(operation('evidence', `evidence-publish:${key}`, [
      'secrets', 'versions', 'add', definition.secret,
      '--data-file=-', `--project=${PROJECT}`, '--format=json',
    ]));
    operations.push(operation('evidence', `evidence-readback:${key}`, [
      'secrets', 'versions', 'describe', ASSIGNED_SECRET_VERSION,
      `--secret=${definition.secret}`, `--project=${PROJECT}`, '--format=json',
    ]));
    operations.push(operation('evidence', `evidence-payload-readback:${key}`, [
      'secrets', 'versions', 'access', ASSIGNED_SECRET_VERSION,
      `--secret=${definition.secret}`, `--project=${PROJECT}`,
      '--format=get(payload.data)',
    ]));
  }
  for (const [key, output] of Object.entries(acceptanceOutputs)) {
    operations.push(operation('evidence', `evidence-output-delete:${key}`, [
      'storage', 'rm', `gs://${output.bucket}/${output.object}#${output.generation}`,
      `--project=${PROJECT}`, '--format=json',
    ]));
    operations.push(operation('evidence', `evidence-output-delete-readback:${key}`, [
      'storage', 'objects', 'list', `gs://${output.bucket}/${output.object}`,
      `--project=${PROJECT}`, '--format=json',
    ]));
  }
  operations.push(operation('evidence', 'evidence-output-zero-readback', [
    'storage', 'objects', 'list',
    `gs://${MEDIA_BUCKET}/release-evidence/${releaseSha}/**`,
    `--project=${PROJECT}`, '--format=json',
  ]));
  operations.push(
    ...(previousRevision === null ? [operation('candidate', 'candidate-stable-service-precheck', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ])] : []),
    operation('candidate', 'candidate-service-precheck', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('candidate', 'candidate-spec-dry-run', [
      'run', 'services', 'replace', candidateServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--dry-run', '--format=json',
    ]),
    operation('candidate', 'candidate-deploy', [
      'run', 'services', 'replace', candidateServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-service-readback', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('candidate', 'candidate-revision-readback', [
      'run', 'revisions', 'describe', candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-artifact-readback', artifactDescribeArgv(image)),
    operation('candidate', 'candidate-private-iam-baseline-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-private-iam-grant', [
      'run', 'services', 'add-iam-policy-binding', CANDIDATE_SERVICE,
      `--member=serviceAccount:${ACCEPTANCE_SERVICE_ACCOUNT}`, `--role=${CANDIDATE_INVOKER_ROLE}`,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-private-iam-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-privacy-publish', [
      'local-artifact-create', candidatePrivacyProofPath,
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-service-precheck', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-revision-readback', [
      'run', 'revisions', 'describe', candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-artifact-readback', artifactDescribeArgv(image)),
    operation('candidate-cleanup', 'candidate-cleanup-private-iam-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-delete', [
      'run', 'services', 'delete', CANDIDATE_SERVICE, '--quiet',
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-absence-readback', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('promote', 'promote-authority-readback', [
      'auth', 'list', '--filter=status:ACTIVE', '--format=json',
    ]),
    operation('promote', 'promote-candidate-service-readback', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('promote', 'promote-candidate-revision-readback', [
      'run', 'revisions', 'describe', candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-candidate-iam-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-candidate-artifact-readback', artifactDescribeArgv(image)),
    operation('promote', 'promote-stable-service-precheck', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    ...(previousRevision === null ? [] : [
      operation('promote', 'promote-stable-public-iam-precheck', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-prior-revision-readback', [
        'run', 'revisions', 'describe', previousRevision,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-prior-artifact-readback', artifactDescribeArgv(previousImage)),
    ]),
    operation('promote', 'promote-stable-spec-dry-run', [
      'run', 'services', 'replace', stableServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--dry-run', '--format=json',
    ]),
    ...(previousRevision === null ? [
      operation('promote', 'promote-privacy-publish', [
        'local-artifact-create', promotionPrivacyProofPath,
      ]),
      operation('promote', 'candidate-cleanup-delete', [
        'run', 'services', 'delete', CANDIDATE_SERVICE, '--quiet',
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'candidate-cleanup-absence-readback', [
        'run', 'services', 'describe', CANDIDATE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`,
        '--format=json',
      ]),
    ] : []),
    operation('promote', 'promote-stable-deploy', [
      'run', 'services', 'replace', stableServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-stable-staged-readback', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('promote', 'promote-stable-revision-readback', [
      'run', 'revisions', 'describe', stableRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-stable-artifact-readback', artifactDescribeArgv(image)),
    ...(previousRevision === null ? [
      operation('promote', 'promote-stable-private-iam-readback', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
    ] : []),
    ...(previousRevision === null ? [] : [
      operation('promote', 'promote-privacy-publish', [
        'local-artifact-create', promotionPrivacyProofPath,
      ]),
    ]),
    ...(previousRevision === null ? [
      operation('promote', 'promote-public-service', [
        'run', 'services', 'add-iam-policy-binding', STABLE_SERVICE, '--member=allUsers',
        '--role=roles/run.invoker', `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-public-iam-readback', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
    ] : [
      operation('promote', 'promote-traffic', [
        'run', 'services', 'update-traffic', STABLE_SERVICE,
        `--to-revisions=${stableRevision}=100`,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-readback', [
        'run', 'services', 'describe', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-public-iam-readback', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
    ]),
    ...(previousRevision === null ? [] : [
    operation('rollback', 'rollback-service-precheck', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('rollback', 'rollback-current-revision-readback', [
      'run', 'revisions', 'describe', stableRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-current-artifact-readback', artifactDescribeArgv(image)),
    operation('rollback', 'rollback-prior-revision-readback', [
      'run', 'revisions', 'describe', previousRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-prior-artifact-readback', artifactDescribeArgv(previousImage)),
    operation('rollback', 'rollback-public-iam-precheck', [
      'run', 'services', 'get-iam-policy', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-traffic', [
      'run', 'services', 'update-traffic', STABLE_SERVICE,
      `--to-revisions=${previousRevision}=100`,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-readback', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('rollback', 'rollback-public-iam-readback', [
      'run', 'services', 'get-iam-policy', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    ]),
  );

  const revisionContract = Object.freeze({
    image,
    serviceAccount: RUNTIME_SERVICE_ACCOUNT,
    executionEnvironment: 'gen2',
    cpu: 2,
    memory: '1Gi',
    concurrency: 40,
    minInstances: 1,
    maxInstances: 1,
    cpuThrottling: false,
    startupCpuBoost: true,
    timeoutSeconds: 60,
    network: GCP_IDENTITY.network,
    subnet: GCP_IDENTITY.subnet,
    vpcEgress: 'private-ranges-only',
    environment,
    secretEnvironment: bindings.environment,
    secretMounts: bindings.mounts,
    probes,
  });
  const expectedCandidate = Object.freeze({
    project: PROJECT,
    region: REGION,
    service: CANDIDATE_SERVICE,
    invokerIamDisabled: false,
    revision: candidateRevision,
    tag: candidateTag,
    ...revisionContract,
    traffic: Object.freeze([Object.freeze({
      revision: candidateRevision, tag: candidateTag, percent: 100,
    })]),
    trafficState: candidateTrafficState(),
    access: candidateAccess,
    iam: Object.freeze({ policy: 'candidate-private' }),
  });
  const expectedStable = Object.freeze({
    project: PROJECT,
    region: REGION,
    service: STABLE_SERVICE,
    invokerIamDisabled: false,
    revision: stableRevision,
    tag: null,
    ...revisionContract,
    stagedTraffic: Object.freeze((previousRevision === null ? [
      { revision: stableRevision, tag: null, percent: 100 },
    ] : [
      { revision: previousRevision, tag: null, percent: 100 },
      { revision: stableRevision, tag: null, percent: 0 },
    ]).map(Object.freeze)),
    traffic: Object.freeze([Object.freeze({
      revision: stableRevision, tag: null, percent: 100,
    })]),
    initialTrafficState: stableTrafficState,
  });
  const plan = Object.freeze({
    project: PROJECT,
    projectNumber: input.projectNumber,
    region: REGION,
    releaseSha,
    sourceArchive: input.sourceArchive,
    sourceArchiveSha256: input.sourceArchiveSha256,
    buildConfig: input.buildConfig,
    buildConfigSha256: input.buildConfigSha256,
    imageDigest: input.imageDigest,
    image,
    previousRevision,
    previousImageDigest,
    previousImage,
    candidateRevision,
    stableRevision,
    candidateTag,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    serviceOrigin,
    candidateServiceOrigin,
    candidateOrigin,
    candidateAccess,
    candidateServiceSpecPath,
    candidateServiceSpec: controlledCandidateServiceSpec,
    stableServiceSpecPath,
    stableServiceSpec: controlledStableServiceSpec,
    acceptanceRunId,
    semanticReleaseSpecSha256,
    releaseIdentitySha256,
    releaseReceiptDirectory,
    releaseReceiptPaths,
    candidatePrivacyProofPath,
    promotionPrivacyProofPath,
    task8Evidence,
    acceptanceOutputs,
    acceptanceEvidenceOutput: Object.freeze({
      bucket: MEDIA_BUCKET,
      object: dependencyEvidenceOutputObject,
    }),
    evidence,
    operations: Object.freeze(operations),
    expectedJobs,
    expectedMigrationJob,
    expectedCandidate,
    expectedStable,
  });
  validateReleaseEvidenceStorageOperations(plan);
  return plan;
}

export function validateReleaseEvidenceStorageOperations(plan) {
  try {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)
      || !RELEASE_SHA.test(String(plan.releaseSha ?? ''))
      || !ACCEPTANCE_RUN_ID.test(String(plan.acceptanceRunId ?? ''))
      || !Array.isArray(plan.operations)) {
      throw new Error('invalid release plan');
    }
    const outputs = assertAcceptanceOutputs(plan.acceptanceOutputs, {
      releaseSha: plan.releaseSha,
      runId: plan.acceptanceRunId,
    });
    const expectedOperations = [];
    for (const [key, output] of Object.entries(outputs)) {
      const generationBoundObject = `gs://${MEDIA_BUCKET}/${output.object}#${output.generation}`;
      expectedOperations.push(
        {
          phase: 'collect', id: `evidence-collect-describe:${key}`,
          argv: [
            'storage', 'objects', 'describe', generationBoundObject,
            `--project=${PROJECT}`, '--format=json',
          ],
        },
        {
          phase: 'collect', id: `evidence-collect-copy:${key}`,
          argv: [
            'storage', 'cp', generationBoundObject, output.filePath,
            '--no-clobber', `--project=${PROJECT}`, '--format=json',
          ],
        },
      );
    }
    for (const [key, output] of Object.entries(outputs)) {
      expectedOperations.push(
        {
          phase: 'evidence', id: `evidence-output-delete:${key}`,
          argv: [
            'storage', 'rm', `gs://${MEDIA_BUCKET}/${output.object}#${output.generation}`,
            `--project=${PROJECT}`, '--format=json',
          ],
        },
        {
          phase: 'evidence', id: `evidence-output-delete-readback:${key}`,
          argv: [
            'storage', 'objects', 'list', `gs://${MEDIA_BUCKET}/${output.object}`,
            `--project=${PROJECT}`, '--format=json',
          ],
        },
      );
    }
    expectedOperations.push({
      phase: 'evidence', id: 'evidence-output-zero-readback',
      argv: [
        'storage', 'objects', 'list',
        `gs://${MEDIA_BUCKET}/release-evidence/${plan.releaseSha}/**`,
        `--project=${PROJECT}`, '--format=json',
      ],
    });
    const actualOperations = plan.operations.filter(({ argv }) => (
      Array.isArray(argv) && argv[0] === 'storage'
    ));
    if (!exact(actualOperations, expectedOperations)) throw new Error('storage operation drift');
    return true;
  } catch {
    throw new Error('Release evidence storage boundary is invalid');
  }
}

function expectedCloudBuildSteps({ releaseSha, sourceArchiveSha256, buildConfigSha256 }) {
  const imageName = `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}:${releaseSha}`;
  const validateInputs = "if (!/^[0-9a-f]{40}$/.test(process.env.RELEASE_SHA || '') || !/^[0-9a-f]{64}$/.test(process.env.SOURCE_SHA256 || '') || !/^[0-9a-f]{64}$/.test(process.env.BUILD_CONFIG_SHA256 || '')) { process.stderr.write('invalid release SHA\\n'); process.exit(2); }";
  const verifyLabels = [
    `test "$(docker inspect --format='{{ index .Config.Labels "org.opencontainers.image.revision" }}' ${imageName})" = "${releaseSha}"`,
    `test "$(docker inspect --format='{{ index .Config.Labels "com.simplify.source-archive-sha256" }}' ${imageName})" = "${sourceArchiveSha256}"`,
    `test "$(docker inspect --format='{{ index .Config.Labels "com.simplify.build-config-sha256" }}' ${imageName})" = "${buildConfigSha256}"`,
    `test "$(docker inspect --format='{{ index .Config.Labels "org.opencontainers.image.source" }}' ${imageName})" = "${OCI_SOURCE}"`,
  ].join(' && ');
  return [
    {
      id: 'validate-release-sha', name: NODE_BUILDER, entrypoint: 'node',
      args: ['-e', validateInputs],
      env: [
        `RELEASE_SHA=${releaseSha}`,
        `SOURCE_SHA256=${sourceArchiveSha256}`,
        `BUILD_CONFIG_SHA256=${buildConfigSha256}`,
      ],
      waitFor: ['-'], status: 'SUCCESS', exitCode: 0,
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
        `--label=org.opencontainers.image.revision=${releaseSha}`,
        `--label=org.opencontainers.image.source=${OCI_SOURCE}`,
        `--label=com.simplify.source-archive-sha256=${sourceArchiveSha256}`,
        `--label=com.simplify.build-config-sha256=${buildConfigSha256}`,
        `--build-arg=V1_RELEASE_COMMIT_SHA=${releaseSha}`,
        `--build-arg=V1_SOURCE_ARCHIVE_SHA256=${sourceArchiveSha256}`,
        `--build-arg=V1_BUILD_CONFIG_SHA256=${buildConfigSha256}`,
        '.',
      ],
      env: [], waitFor: ['dependency-security-gate'], status: 'SUCCESS', exitCode: 0,
    },
    {
      id: 'verify-image-contract', name: DOCKER_BUILDER, entrypoint: 'docker',
      args: [
        'run', '--rm', '--entrypoint=node',
        `--env=V1_RELEASE_COMMIT_SHA=${releaseSha}`,
        `--env=V1_SOURCE_ARCHIVE_SHA256=${sourceArchiveSha256}`,
        `--env=V1_BUILD_CONFIG_SHA256=${buildConfigSha256}`,
        imageName, 'scripts/image-release-contract.js',
      ],
      env: [], waitFor: ['build'], status: 'SUCCESS', exitCode: 0,
    },
    {
      id: 'verify-oci-labels', name: DOCKER_BUILDER, entrypoint: 'sh',
      args: ['-ceu', verifyLabels],
      env: [], waitFor: ['verify-image-contract'], status: 'SUCCESS', exitCode: 0,
    },
  ];
}

const CLOUD_BUILD_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function validCloudBuildTimestamp(value) {
  return typeof value === 'string' && CLOUD_BUILD_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value));
}

function validCloudBuildTimeSpan(value) {
  return exactKeys(value, ['endTime', 'startTime'])
    && validCloudBuildTimestamp(value.startTime)
    && validCloudBuildTimestamp(value.endTime)
    && Date.parse(value.startTime) <= Date.parse(value.endTime);
}

function decodeCloudBuildHash(value, expectedByteLength) {
  if (typeof value !== 'string' || !Number.isSafeInteger(expectedByteLength)
    || expectedByteLength < 1) throw new Error();
  const decoded = Buffer.from(value, 'base64');
  const standard = decoded.toString('base64');
  const urlSafePadded = standard.replaceAll('+', '-').replaceAll('/', '_');
  if (decoded.length !== expectedByteLength
    || (value !== standard && value !== urlSafePadded)) throw new Error();
  return decoded;
}

function validateOutputOnlyBuildObservation(value) {
  const observedTimes = ['createTime', 'startTime', 'finishTime'].filter((key) => (
    Object.hasOwn(value, key)
  ));
  if (observedTimes.length > 0) {
    if (observedTimes.length !== 3
      || !observedTimes.every((key) => validCloudBuildTimestamp(value[key]))
      || Date.parse(value.createTime) > Date.parse(value.startTime)
      || Date.parse(value.startTime) > Date.parse(value.finishTime)) throw new Error();
  }
  if (Object.hasOwn(value, 'logUrl')
    && (typeof value.logUrl !== 'string' || value.logUrl.length > 2_048
      || !new RegExp(`^https://console\\.cloud\\.google\\.com/[^\\s]*${value.id}[^\\s]*$`)
        .test(value.logUrl))) throw new Error();
  if (Object.hasOwn(value, 'timing')) {
    const keys = Object.keys(value.timing ?? {});
    const allowed = new Set(['BUILD', 'FETCHSOURCE', 'PUSH', 'SETUPBUILD', 'STORAGE_SOURCE']);
    if (keys.length < 1 || keys.some((key) => !allowed.has(key)
      || !validCloudBuildTimeSpan(value.timing[key]))) throw new Error();
    if (Object.hasOwn(value.timing, 'STORAGE_SOURCE')
      && (!Object.hasOwn(value.timing, 'FETCHSOURCE')
        || !exact(value.timing.STORAGE_SOURCE, value.timing.FETCHSOURCE))) throw new Error();
  }
}

function normalizeCloudBuildReceipt(value, { releaseSha, sourceArchiveSha256, buildConfigSha256 }) {
  try {
    const requiredBuildKeys = [
      'id', 'images', 'name', 'options', 'projectId', 'results', 'serviceAccount',
      'source', 'sourceProvenance', 'status', 'steps', 'substitutions', 'timeout',
    ];
    const outputOnlyBuildKeys = [
      'artifacts', 'createTime', 'finishTime', 'logUrl', 'queueTtl', 'startTime', 'timing',
    ];
    const actualBuildKeys = Object.keys(value ?? {});
    if (!RELEASE_SHA.test(String(releaseSha ?? ''))
      || !DIGEST.test(String(sourceArchiveSha256 ?? ''))
      || !DIGEST.test(String(buildConfigSha256 ?? ''))
      || requiredBuildKeys.some((key) => !actualBuildKeys.includes(key))
      || actualBuildKeys.some((key) => !requiredBuildKeys.includes(key)
        && !outputOnlyBuildKeys.includes(key))
      || !BUILD_ID.test(String(value.id ?? ''))
      || ![
        `projects/${PROJECT}/locations/${REGION}/builds/${value.id}`,
        `projects/${GCP_IDENTITY.projectNumber}/locations/${REGION}/builds/${value.id}`,
      ].includes(value.name)
      || value.projectId !== PROJECT
      || value.status !== 'SUCCESS'
      || value.serviceAccount !== BUILD_SERVICE_ACCOUNT
      || value.timeout !== '1200s'
      || (Object.hasOwn(value, 'queueTtl') && value.queueTtl !== '3600s')) throw new Error();
    validateOutputOnlyBuildObservation(value);

    const imageName = `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}:${releaseSha}`;
    const optionKeys = Object.keys(value.options ?? {});
    if (!exact(value.images, [imageName])
      || !exactKeys(value.substitutions, [
        '_BUILD_CONFIG_SHA256', '_RELEASE_SHA', '_SOURCE_SHA256',
      ])
      || !exact(value.substitutions, {
        _BUILD_CONFIG_SHA256: buildConfigSha256,
        _RELEASE_SHA: releaseSha,
        _SOURCE_SHA256: sourceArchiveSha256,
      })
      || ['logging', 'requestedVerifyOption', 'sourceProvenanceHash']
        .some((key) => !optionKeys.includes(key))
      || optionKeys.some((key) => ![
        'logging', 'pool', 'requestedVerifyOption', 'sourceProvenanceHash',
      ].includes(key))
      || (Object.hasOwn(value.options, 'pool') && !exactKeys(value.options.pool, []))
      || value.options.logging !== 'CLOUD_LOGGING_ONLY'
      || value.options.requestedVerifyOption !== 'VERIFIED'
      || !exact(value.options.sourceProvenanceHash, ['SHA256'])
      || (Object.hasOwn(value, 'artifacts')
        && (!exactKeys(value.artifacts, ['images'])
          || !exact(value.artifacts.images, [imageName])))) throw new Error();
    const normalizedOptions = {
      logging: value.options.logging,
      requestedVerifyOption: value.options.requestedVerifyOption,
      sourceProvenanceHash: value.options.sourceProvenanceHash,
    };

    const expectedSteps = expectedCloudBuildSteps({
      releaseSha, sourceArchiveSha256, buildConfigSha256,
    });
    if (!Array.isArray(value.steps) || value.steps.length !== expectedSteps.length) throw new Error();
    const steps = value.steps.map((step, index) => {
      const keys = Object.keys(step ?? {}).sort();
      const required = ['args', 'entrypoint', 'id', 'name', 'status', 'waitFor'];
      const allowed = [...required, 'env', 'pullTiming', 'timing'];
      if (Object.hasOwn(step ?? {}, 'exitCode')) allowed.push('exitCode');
      if (required.some((key) => !keys.includes(key))
        || keys.some((key) => !allowed.includes(key))
        || (Object.hasOwn(step, 'pullTiming') && !validCloudBuildTimeSpan(step.pullTiming))
        || (Object.hasOwn(step, 'timing') && !validCloudBuildTimeSpan(step.timing))
        || (Object.hasOwn(step, 'exitCode') && step.exitCode !== 0)) throw new Error();
      const normalized = {
        id: step.id,
        name: step.name,
        entrypoint: step.entrypoint,
        args: step.args,
        env: step.env ?? [],
        waitFor: step.waitFor,
        status: step.status,
        exitCode: 0,
      };
      if (!exact(normalized, expectedSteps[index])) throw new Error();
      return normalized;
    });

    if (!exactKeys(value.source, ['storageSource'])
      || !exactKeys(value.source.storageSource, ['bucket', 'generation', 'object'])
      || value.source.storageSource.bucket !== GCP_IDENTITY.buildSourceBucket
      || typeof value.source.storageSource.object !== 'string'
      || !value.source.storageSource.object.startsWith(BUILD_SOURCE_PREFIX)
      || value.source.storageSource.object.length <= BUILD_SOURCE_PREFIX.length
      || !NUMERIC_VERSION.test(String(value.source.storageSource.generation ?? ''))
      || !exactKeys(value.sourceProvenance, ['fileHashes', 'resolvedStorageSource'])
      || !exact(value.sourceProvenance.resolvedStorageSource, value.source.storageSource)) throw new Error();
    const sourceUri = `gs://${value.source.storageSource.bucket}/${value.source.storageSource.object}#${value.source.storageSource.generation}`;
    if (!exactKeys(value.sourceProvenance.fileHashes, [sourceUri])) throw new Error();
    const hashRecord = value.sourceProvenance.fileHashes[sourceUri];
    if (!exactKeys(hashRecord, ['fileHash']) || !Array.isArray(hashRecord.fileHash)
      || ![1, 2].includes(hashRecord.fileHash.length)
      || hashRecord.fileHash.some((entry) => !exactKeys(entry, ['type', 'value']))) throw new Error();
    const hashesByType = new Map(hashRecord.fileHash.map((entry) => [entry.type, entry]));
    if (hashesByType.size !== hashRecord.fileHash.length
      || !hashesByType.has('SHA256')
      || [...hashesByType.keys()].some((type) => !['MD5', 'SHA256'].includes(type))
      || (hashRecord.fileHash.length === 2 && !hashesByType.has('MD5'))) throw new Error();
    const decoded = decodeCloudBuildHash(hashesByType.get('SHA256').value, 32);
    if (decoded.toString('hex') !== sourceArchiveSha256) throw new Error();
    if (hashesByType.has('MD5')) decodeCloudBuildHash(hashesByType.get('MD5').value, 16);
    const normalizedSourceProvenance = {
      fileHashes: {
        [sourceUri]: {
          fileHash: [{ type: 'SHA256', value: decoded.toString('base64') }],
        },
      },
      resolvedStorageSource: value.sourceProvenance.resolvedStorageSource,
    };

    const expectedBuilderImages = [NODE_BUILDER, NODE_BUILDER, DOCKER_BUILDER, DOCKER_BUILDER, DOCKER_BUILDER]
      .map((builder) => `sha256:${builder.split('@sha256:')[1]}`);
    const builtImage = value.results?.images?.[0];
    const builtImageKeys = Object.keys(builtImage ?? {}).sort();
    const expectedArtifactRegistryPackage = [
      `projects/${PROJECT}/locations/${REGION}/repositories/${REPOSITORY}`,
      `packages/${STABLE_SERVICE}/versions/${builtImage?.digest}`,
    ].join('/');
    const resultKeys = Object.keys(value.results ?? {});
    if (['buildStepImages', 'images'].some((key) => !resultKeys.includes(key))
      || resultKeys.some((key) => ![
        'buildStepImages', 'buildStepOutputs', 'buildStepResults', 'images',
      ].includes(key))
      || !exact(value.results.buildStepImages, expectedBuilderImages)
      || (Object.hasOwn(value.results, 'buildStepOutputs')
        && !exact(value.results.buildStepOutputs, expectedSteps.map(() => '')))
      || (Object.hasOwn(value.results, 'buildStepResults')
        && (!exactKeys(value.results.buildStepResults, expectedSteps.map(({ id }) => id))
          || Object.values(value.results.buildStepResults)
            .some((result) => !exactKeys(result, []))))
      || !Array.isArray(value.results.images) || value.results.images.length !== 1
      || !['artifactRegistryPackage', 'digest', 'name'].every((key) => builtImageKeys.includes(key))
      || builtImageKeys.some((key) => ![
        'artifactRegistryPackage', 'digest', 'name', 'pushTiming',
      ].includes(key))
      || builtImage.name !== imageName
      || !IMAGE_DIGEST.test(String(builtImage.digest ?? ''))
      || builtImage.artifactRegistryPackage !== expectedArtifactRegistryPackage
      || (Object.hasOwn(builtImage, 'pushTiming')
        && !validCloudBuildTimeSpan(builtImage.pushTiming))) throw new Error();

    const normalizedResults = {
      buildStepImages: value.results.buildStepImages,
      images: [{
        artifactRegistryPackage: builtImage.artifactRegistryPackage,
        digest: builtImage.digest,
        name: builtImage.name,
      }],
    };

    return Object.freeze(canonical({
      id: value.id,
      images: value.images,
      name: `projects/${PROJECT}/locations/${REGION}/builds/${value.id}`,
      options: normalizedOptions,
      projectId: value.projectId,
      results: normalizedResults,
      serviceAccount: value.serviceAccount,
      source: value.source,
      sourceProvenance: normalizedSourceProvenance,
      status: value.status,
      steps,
      substitutions: value.substitutions,
      timeout: value.timeout,
    }));
  } catch {
    throw new Error('Cloud Build receipt is invalid');
  }
}

export function validateBuildReceipt(value, {
  releaseSha, sourceArchiveSha256, buildConfigSha256,
} = {}) {
  const normalized = normalizeCloudBuildReceipt(value, {
    releaseSha, sourceArchiveSha256, buildConfigSha256,
  });
  const image = normalized.results.images;
  const source = normalized.source.storageSource;
  const sourceUri = `gs://${source.bucket}/${source.object}#${source.generation}`;
  return Object.freeze({
    buildConfigSha256,
    buildId: normalized.id,
    buildReceiptSha256: canonicalSha256(normalized),
    releaseSha,
    sourceArchiveSha256,
    sourceProvenance: Object.freeze({ uri: sourceUri, sha256: sourceArchiveSha256 }),
    imageDigest: image[0].digest,
    provenance: 'VERIFIED',
    ociLabels: Object.freeze({
      'com.simplify.build-config-sha256': buildConfigSha256,
      'com.simplify.source-archive-sha256': sourceArchiveSha256,
      'org.opencontainers.image.revision': releaseSha,
      'org.opencontainers.image.source': OCI_SOURCE,
    }),
  });
}

export function validateCandidateReadback(value, plan) {
  if (!plan || !exact(value, plan.expectedCandidate)) {
    throw new Error('Cloud Run candidate readback is invalid');
  }
  return true;
}

function candidateRevisionContract(value) {
  if (!value) return null;
  return {
    revision: value.revision,
    image: value.image,
    serviceAccount: value.serviceAccount,
    executionEnvironment: value.executionEnvironment,
    cpu: value.cpu,
    memory: value.memory,
    concurrency: value.concurrency,
    minInstances: value.minInstances,
    maxInstances: value.maxInstances,
    cpuThrottling: value.cpuThrottling,
    startupCpuBoost: value.startupCpuBoost,
    timeoutSeconds: value.timeoutSeconds,
    network: value.network,
    subnet: value.subnet,
    vpcEgress: value.vpcEgress,
    environment: value.environment,
    secretEnvironment: value.secretEnvironment,
    secretMounts: value.secretMounts,
    probes: value.probes,
  };
}

function normalizeProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    path: value.httpGet?.path,
    port: positiveOrZeroInteger(value.httpGet?.port),
    initialDelaySeconds: positiveOrZeroInteger(value.initialDelaySeconds ?? 0),
    timeoutSeconds: positiveOrZeroInteger(value.timeoutSeconds),
    periodSeconds: positiveOrZeroInteger(value.periodSeconds),
    failureThreshold: positiveOrZeroInteger(value.failureThreshold),
  };
}

function normalizeCandidateRevision(value, expected) {
  if (exact(candidateRevisionContract(value), candidateRevisionContract(expected))) {
    return candidateRevisionContract(value);
  }
  const spec = value?.spec;
  const containers = spec?.containers;
  if (!value?.metadata || !spec || !Array.isArray(containers) || containers.length !== 1) return null;
  const container = containers[0];
  const environment = {};
  const secretEnvironment = {};
  for (const member of container.env ?? []) {
    if (typeof member?.name !== 'string') return null;
    if (typeof member.value === 'string') environment[member.name] = member.value;
    else if (member.valueFrom?.secretKeyRef?.name && member.valueFrom.secretKeyRef.key) {
      secretEnvironment[member.name] = {
        secret: member.valueFrom.secretKeyRef.name,
        version: String(member.valueFrom.secretKeyRef.key),
      };
    } else return null;
  }
  const secretMounts = {};
  const expectedMounts = Object.entries(expected.secretMounts);
  for (const mount of container.volumeMounts ?? []) {
    const volume = (spec.volumes ?? []).find(({ name } = {}) => name === mount?.name);
    const items = volume?.secret?.items;
    if (!volume?.secret?.secretName || !Array.isArray(items) || items.length !== 1
      || typeof mount?.mountPath !== 'string') return null;
    const item = items[0];
    const path = join(mount.mountPath, String(item.path ?? '')).replaceAll('\\', '/');
    const match = expectedMounts.find(([, expectedMount]) => expectedMount.path === path);
    if (!match || !item.key) return null;
    secretMounts[match[0]] = {
      path,
      secret: volume.secret.secretName,
      version: String(item.key),
      readOnly: mount.readOnly !== false,
    };
  }
  const annotations = value.metadata.annotations ?? {};
  let networkInterfaces;
  try { networkInterfaces = JSON.parse(annotations['run.googleapis.com/network-interfaces']); } catch { return null; }
  const network = Array.isArray(networkInterfaces) && networkInterfaces.length === 1
    ? networkInterfaces[0] : null;
  return {
    revision: value.metadata.name,
    image: container.image,
    serviceAccount: spec.serviceAccountName,
    executionEnvironment: annotations['run.googleapis.com/execution-environment'],
    cpu: positiveOrZeroInteger(container.resources?.limits?.cpu),
    memory: container.resources?.limits?.memory,
    concurrency: positiveOrZeroInteger(spec.containerConcurrency),
    minInstances: positiveOrZeroInteger(annotations['autoscaling.knative.dev/minScale']),
    maxInstances: positiveOrZeroInteger(annotations['autoscaling.knative.dev/maxScale']),
    cpuThrottling: annotations['run.googleapis.com/cpu-throttling'] === 'true',
    startupCpuBoost: annotations['run.googleapis.com/startup-cpu-boost'] === 'true',
    timeoutSeconds: nonnegativeInteger(spec.timeoutSeconds),
    network: network?.network,
    subnet: network?.subnetwork,
    vpcEgress: annotations['run.googleapis.com/vpc-access-egress'],
    environment,
    secretEnvironment,
    secretMounts,
    probes: {
      startup: normalizeProbe(container.startupProbe),
      liveness: normalizeProbe(container.livenessProbe),
      readiness: normalizeProbe(container.readinessProbe),
    },
  };
}

function validateCandidateServiceSpecDryRun(value, plan) {
  const template = value?.spec?.template;
  const normalizedService = normalizeControlledServiceSpec(value);
  if (value?.apiVersion !== 'serving.knative.dev/v1' || value?.kind !== 'Service'
    || !template || normalizedService?.service !== CANDIDATE_SERVICE
    || normalizedService?.invokerIamDisabled !== false
    || normalizedService?.serviceMaxScale !== plan.expectedCandidate.maxInstances
    || !exact(normalizedService.traffic, [{
      revision: plan.candidateRevision,
      tag: plan.candidateTag,
      percent: 100,
    }])
    || !exact(
      normalizeCandidateRevision({ metadata: template.metadata, spec: template.spec }, plan.expectedCandidate),
      candidateRevisionContract(plan.expectedCandidate),
    )) {
    throw new Error('Cloud Run candidate Service dry-run is invalid');
  }
  return true;
}

function validateStableServiceSpecDryRun(value, plan) {
  const template = value?.spec?.template;
  const normalizedService = normalizeControlledServiceSpec(value);
  if (value?.apiVersion !== 'serving.knative.dev/v1' || value?.kind !== 'Service'
    || !template || normalizedService?.service !== STABLE_SERVICE
    || normalizedService?.invokerIamDisabled !== false
    || normalizedService?.serviceMaxScale !== plan.expectedStable.maxInstances
    || !exact(normalizedService.traffic, plan.expectedStable.stagedTraffic)
    || !exact(
      normalizeCandidateRevision({ metadata: template.metadata, spec: template.spec }, plan.expectedStable),
      candidateRevisionContract(plan.expectedStable),
    )) {
    throw new Error('Cloud Run stable Service dry-run is invalid');
  }
  return true;
}

function normalizeControlledServiceSpec(value) {
  if (value?.apiVersion !== 'serving.knative.dev/v1' || value?.kind !== 'Service'
    || typeof value?.metadata?.name !== 'string' || !Array.isArray(value?.spec?.traffic)) return null;
  const annotationsDefined = Object.hasOwn(value.metadata, 'annotations');
  const annotations = value.metadata.annotations;
  if (!annotationsDefined || annotations === null || typeof annotations !== 'object'
    || Array.isArray(annotations)
    || annotations[SERVICE_MAX_SCALE_ANNOTATION] !== SERVICE_MAX_SCALE) return null;
  if (annotationsDefined && Object.hasOwn(annotations, INVOKER_IAM_DISABLED_ANNOTATION)) {
    const annotation = annotations[INVOKER_IAM_DISABLED_ANNOTATION];
    if (typeof annotation !== 'string' || annotation !== annotation.trim()
      || annotation.toLowerCase() !== 'false') return null;
  }
  try {
    return {
      service: value.metadata.name,
      invokerIamDisabled: false,
      serviceMaxScale: Number(SERVICE_MAX_SCALE),
      traffic: normalizeControlledTraffic(value.spec.traffic, { service: value.metadata.name }),
    };
  } catch { return null; }
}

function normalizeCandidateService(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const direct = typeof value.service === 'string' && Array.isArray(value.traffic);
  const rawTraffic = value?.status?.traffic;
  const raw = value?.apiVersion === 'serving.knative.dev/v1' && value?.kind === 'Service'
    && typeof value?.metadata?.name === 'string' && Array.isArray(rawTraffic);
  if (direct === raw) return null;
  const service = direct ? value.service : value.metadata.name;
  const metadata = value?.metadata;
  const annotationsDefined = metadata && Object.hasOwn(metadata, 'annotations');
  const serviceAnnotations = metadata?.annotations;
  const annotationsPrototype = serviceAnnotations !== null
    && typeof serviceAnnotations === 'object'
    ? Object.getPrototypeOf(serviceAnnotations)
    : undefined;
  const annotationsValid = !annotationsDefined || (serviceAnnotations !== null
    && typeof serviceAnnotations === 'object' && !Array.isArray(serviceAnnotations)
    && (annotationsPrototype === Object.prototype || annotationsPrototype === null));
  if (!direct && !annotationsValid) return null;
  const rawAnnotationPresent = annotationsValid && annotationsDefined
    && Object.hasOwn(serviceAnnotations, INVOKER_IAM_DISABLED_ANNOTATION);
  let invokerIamDisabled;
  let serviceMaxScale;
  if (direct) {
    if (rawAnnotationPresent || !Object.hasOwn(value, 'invokerIamDisabled')
      || value.invokerIamDisabled !== false
      || value.serviceMaxScale !== Number(SERVICE_MAX_SCALE)) return null;
    invokerIamDisabled = false;
    serviceMaxScale = Number(SERVICE_MAX_SCALE);
  } else {
    if (!annotationsDefined
      || serviceAnnotations[SERVICE_MAX_SCALE_ANNOTATION] !== SERVICE_MAX_SCALE) return null;
    if (rawAnnotationPresent) {
      const annotation = serviceAnnotations[INVOKER_IAM_DISABLED_ANNOTATION];
      if (typeof annotation !== 'string' || annotation !== annotation.trim()
        || annotation.toLowerCase() !== 'false') return null;
    }
    invokerIamDisabled = false;
    serviceMaxScale = Number(SERVICE_MAX_SCALE);
  }
  try {
    return {
      service,
      invokerIamDisabled,
      serviceMaxScale,
      traffic: direct
        ? normalizeInternalTraffic(value.traffic, { service })
        : normalizeCloudRunV1Traffic(rawTraffic, {
          service,
          serviceUrls: normalizeCloudRunV1ServiceUrls(value, {
            service, projectNumber: GCP_IDENTITY.projectNumber, region: REGION,
          }).aliases,
        }),
    };
  } catch { return null; }
}

function validateCandidateService(value, expected) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== expected.service
    || normalized.invokerIamDisabled !== false
    || normalized.serviceMaxScale !== expected.maxInstances) {
    throw new Error('Cloud Run candidate service readback is invalid');
  }
  if (!exact(normalized.traffic, expected.traffic)) {
    throw new Error('Cloud Run candidate service readback is invalid');
  }
  return true;
}

function validateStableStagedService(value, plan) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE
    || normalized.invokerIamDisabled !== false
    || normalized.serviceMaxScale !== plan.expectedStable.maxInstances
    || !exact(normalized.traffic, plan.expectedStable.stagedTraffic)
    || normalized.traffic.some(({ tag }) => tag !== null)) {
    throw new Error('Cloud Run staged stable service readback is invalid');
  }
  return true;
}

function validateStableRevisionReadback(value, plan) {
  if (!exact(normalizeCandidateRevision(value, plan.expectedStable),
    candidateRevisionContract(plan.expectedStable))) {
    throw new Error('Cloud Run stable revision readback is invalid');
  }
  return true;
}

function validateStableService(value, { previousRevision } = {}) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE
    || normalized.invokerIamDisabled !== false
    || normalized.serviceMaxScale !== Number(SERVICE_MAX_SCALE)) {
    throw new Error('Cloud Run stable service readback is invalid');
  }
  if (!exact(normalized.traffic, [{ revision: previousRevision, tag: null, percent: 100 }])) {
    throw new Error('Cloud Run stable service readback is invalid');
  }
  return true;
}

function validateCandidateCleanupService(value, plan) {
  validateStableService(value, plan);
  return true;
}

function validatePromotedService(value, plan) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE
    || normalized.invokerIamDisabled !== false
    || normalized.serviceMaxScale !== plan.expectedStable.maxInstances) {
    throw new Error('Cloud Run promotion service readback is invalid');
  }
  validateTrafficReceipt(value, { revision: plan.stableRevision });
  if (normalized.traffic.some(({ tag }) => tag !== null)) {
    throw new Error('Cloud Run promotion tag cleanup readback is invalid');
  }
  return true;
}

function validatePromotionCompensationSource(value, plan) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE || normalized.traffic.length < 1
    || normalized.traffic.length > 2 || normalized.invokerIamDisabled !== false
    || normalized.serviceMaxScale !== plan.expectedStable.maxInstances) {
    throw new Error('Cloud Run promotion compensation source is invalid');
  }
  if (plan.previousRevision === null) {
    if (!exact(normalized.traffic, [{
      revision: plan.stableRevision,
      tag: null,
      percent: 100,
    }])) {
      throw new Error('Cloud Run promotion compensation source is invalid');
    }
    return true;
  }
  const seenRevisions = new Set();
  let routedRevision = null;
  for (const member of normalized.traffic) {
    if (![plan.previousRevision, plan.stableRevision].includes(member.revision)
      || member.tag !== null
      || ![0, 100].includes(member.percent) || seenRevisions.has(member.revision)) {
      throw new Error('Cloud Run promotion compensation source is invalid');
    }
    seenRevisions.add(member.revision);
    if (member.percent === 100) {
      if (routedRevision !== null) throw new Error('Cloud Run promotion compensation source is invalid');
      routedRevision = member.revision;
    }
  }
  if (![plan.previousRevision, plan.stableRevision].includes(routedRevision)) {
    throw new Error('Cloud Run promotion compensation source is invalid');
  }
  return true;
}

function validateCandidateRevisionReadback(value, plan) {
  if (!exact(normalizeCandidateRevision(value, plan.expectedCandidate),
    candidateRevisionContract(plan.expectedCandidate))) {
    throw new Error('Cloud Run candidate revision readback is invalid');
  }
  return true;
}

function validateCandidateArtifact(value, expectedImage) {
  if (!exactKeys(value, ['image_summary'])
    || !exactKeys(value.image_summary, ['digest', 'fully_qualified_digest'])) {
    throw new Error('Artifact Registry image readback is invalid');
  }
  const { digest, fully_qualified_digest: image } = value.image_summary;
  if (!IMAGE_DIGEST.test(String(digest ?? ''))
    || image !== expectedImage || !expectedImage.endsWith(`@${digest}`)) {
    throw new Error('Artifact Registry image readback is invalid');
  }
  return true;
}

function validatePriorRevisionReadback(value, plan) {
  const revision = value?.revision ?? value?.metadata?.name;
  const image = value?.image ?? value?.spec?.containers?.[0]?.image;
  if (plan.previousRevision === null || plan.previousImage === null
    || !STABLE_REVISION.test(String(revision ?? ''))
    || revision !== plan.previousRevision || image !== plan.previousImage) {
    throw new Error('Cloud Run prior revision readback is invalid');
  }
  return true;
}

function validateRecoveryPrecheck(value, plan, phase) {
  if (phase === 'candidate-cleanup') {
    return validateCandidateService(value, plan.expectedCandidate);
  }
  if (phase === 'rollback') return validatePromotedService(value, plan);
  throw new Error('Cloud Run recovery precheck is invalid');
}

export function validateCandidateControlPlaneReadbacks(value, plan) {
  if (!exactKeys(value, ['artifact', 'iam', 'revision', 'service']) || !plan?.expectedCandidate) {
    throw new Error('Cloud Run candidate control-plane readback is invalid');
  }
  const expected = plan.expectedCandidate;
  validateCandidateService(value.service, expected);
  if (!exact(normalizeCandidateRevision(value.revision, expected), candidateRevisionContract(expected))) {
    throw new Error('Cloud Run candidate revision readback is invalid');
  }
  validateServiceIamReceipt(value.iam, { policy: 'candidate-private' });
  validateCandidateArtifact(value.artifact, expected.image);
  return true;
}

function normalizeServiceIamPolicy(value, { requireEtag = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['bindings', 'etag', 'version'].includes(key))) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const bindings = value?.bindings ?? [];
  if (!Array.isArray(bindings)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const normalizedBindings = bindings.map((binding = {}) => {
    const allowedKeys = binding.condition === undefined
      ? ['members', 'role'] : ['condition', 'members', 'role'];
    const { condition, members, role } = binding;
    const conditionValid = condition === undefined || (
      condition && typeof condition === 'object' && !Array.isArray(condition)
      && Object.keys(condition).length > 0
      && Object.keys(condition).every((key) => ['description', 'expression', 'title'].includes(key))
      && Object.values(condition).every((member) => typeof member === 'string' && member.length > 0)
    );
    if (!exactKeys(binding, allowedKeys) || typeof role !== 'string' || role.length === 0
      || !Array.isArray(members) || members.length === 0
      || members.some((member) => typeof member !== 'string' || member.length === 0)
      || new Set(members).size !== members.length || !conditionValid) {
      throw new Error('Cloud Run service IAM readback is invalid');
    }
    return {
      role,
      members: [...members].sort(),
      ...(condition === undefined ? {} : { condition: canonical(condition) }),
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (new Set(normalizedBindings.map((binding) => JSON.stringify(binding))).size !== normalizedBindings.length) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const etag = value.etag ?? null;
  const version = value.version ?? null;
  if ((etag !== null && (typeof etag !== 'string' || etag.length === 0 || etag.length > 512))
    || (requireEtag && etag === null)
    || (version !== null && (!Number.isSafeInteger(version) || version < 0 || version > 3))) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  return Object.freeze({ bindings: Object.freeze(normalizedBindings), etag, version });
}

function iamPolicyState(value) {
  const normalized = value?.bindings ? value : normalizeServiceIamPolicy(value);
  return { bindings: normalized.bindings, version: normalized.version };
}

function publicIamPolicyState(privatePolicy) {
  const state = structuredClone(iamPolicyState(privatePolicy));
  let invoker = state.bindings.find((binding) => (
    binding.role === 'roles/run.invoker' && binding.condition === undefined
  ));
  if (!invoker) {
    invoker = { role: 'roles/run.invoker', members: [] };
    state.bindings.push(invoker);
  }
  invoker.members = [...invoker.members, 'allUsers'].sort();
  state.bindings.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return state;
}

function validateIamPolicyState(value, expected, { requireEtag = true } = {}) {
  const normalized = normalizeServiceIamPolicy(value, { requireEtag });
  if (!exact(iamPolicyState(normalized), expected)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  return normalized;
}

export function validateServiceIamReceipt(value, {
  policy = null, publicInvoker = null, requireEtag = false,
} = {}) {
  if (policy !== null && ![
    'candidate-private', 'stable-private', 'stable-public',
  ].includes(policy)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const normalized = normalizeServiceIamPolicy(value, { requireEtag });
  if (policy !== null) {
    const expectedBindings = {
      'candidate-private': [{
        role: CANDIDATE_INVOKER_ROLE, members: [`serviceAccount:${ACCEPTANCE_SERVICE_ACCOUNT}`],
      }],
      'stable-private': [],
      'stable-public': [{ role: 'roles/run.invoker', members: ['allUsers'] }],
    }[policy];
    if (!exact(normalized.bindings, expectedBindings)) {
      throw new Error('Cloud Run service IAM readback is invalid');
    }
    return true;
  }
  if (![true, false].includes(publicInvoker)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const publicMembers = normalized.bindings.flatMap((binding) => binding.members.map((member) => ({
    member, role: binding.role, conditioned: binding.condition !== undefined,
  }))).filter(({ member }) => member === 'allUsers' || member === 'allAuthenticatedUsers');
  const valid = publicInvoker
    ? publicMembers.length === 1 && publicMembers[0].member === 'allUsers'
      && publicMembers[0].role === 'roles/run.invoker' && publicMembers[0].conditioned === false
    : publicMembers.length === 0;
  if (!valid) throw new Error('Cloud Run service IAM readback is invalid');
  return true;
}

export function validateTrafficReceipt(value, { revision } = {}) {
  if (!(STABLE_REVISION.test(String(revision ?? ''))
    || CANDIDATE_REVISION.test(String(revision ?? '')))) {
    throw new Error('Cloud Run traffic readback is invalid');
  }
  const normalized = normalizeCandidateService(value);
  const service = CANDIDATE_REVISION.test(revision) ? CANDIDATE_SERVICE : STABLE_SERVICE;
  const tag = service === CANDIDATE_SERVICE ? `candidate-${revision.slice(-12)}` : null;
  if (!normalized || normalized.service !== service
    || normalized.serviceMaxScale !== Number(SERVICE_MAX_SCALE)
    || !exact(normalized.traffic, [{ revision, tag, percent: 100 }])) {
    throw new Error('Cloud Run traffic readback is invalid');
  }
  return true;
}

function positiveOrZeroInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeV1JobReadback(value) {
  const jobSpec = value?.spec?.template?.spec;
  const taskSpec = jobSpec?.template?.spec;
  const containers = taskSpec?.containers;
  if (!value?.metadata || !jobSpec || !taskSpec || !Array.isArray(containers)
    || containers.length !== 1) return null;
  const container = containers[0];
  const environment = {};
  const secretEnvironment = {};
  for (const member of container.env ?? []) {
    if (typeof member?.name !== 'string') return null;
    if (typeof member.value === 'string') environment[member.name] = member.value;
    else if (member.valueFrom?.secretKeyRef?.name && member.valueFrom.secretKeyRef.key) {
      secretEnvironment[member.name] = {
        secret: member.valueFrom.secretKeyRef.name,
        version: String(member.valueFrom.secretKeyRef.key),
      };
    } else return null;
  }
  const secretMounts = {};
  for (const mount of container.volumeMounts ?? []) {
    const volume = (taskSpec.volumes ?? []).find(({ name } = {}) => name === mount?.name);
    const items = volume?.secret?.items;
    if (!volume?.secret?.secretName || !Array.isArray(items) || items.length !== 1
      || !items[0]?.key || typeof items[0]?.path !== 'string'
      || typeof mount?.mountPath !== 'string') return null;
    const item = items[0];
    const path = join(mount.mountPath, item.path).replaceAll('\\', '/');
    const key = path.endsWith('/legacy-inventory.json') ? 'legacyInventory' : mount.name;
    secretMounts[key] = {
      path,
      secret: volume.secret.secretName,
      version: String(item.key),
      readOnly: mount.readOnly !== false,
    };
  }
  const annotations = value.spec?.template?.metadata?.annotations ?? value.metadata.annotations ?? {};
  let networkInterfaces;
  try { networkInterfaces = JSON.parse(annotations['run.googleapis.com/network-interfaces']); } catch { return null; }
  const network = Array.isArray(networkInterfaces) && networkInterfaces.length === 1
    ? networkInterfaces[0] : null;
  const timeoutSeconds = positiveOrZeroInteger(String(taskSpec.timeoutSeconds ?? '').replace(/s$/u, ''));
  return {
    project: PROJECT,
    region: REGION,
    job: value.metadata.name,
    image: container.image,
    serviceAccount: taskSpec.serviceAccountName,
    command: container.command ?? [],
    args: container.args ?? [],
    taskCount: positiveOrZeroInteger(jobSpec.taskCount),
    parallelism: positiveOrZeroInteger(jobSpec.parallelism),
    maxRetries: positiveOrZeroInteger(taskSpec.maxRetries),
    timeoutSeconds,
    network: network?.network,
    subnet: network?.subnetwork,
    vpcEgress: annotations['run.googleapis.com/vpc-access-egress'],
    environment,
    secretEnvironment,
    secretMounts,
    labels: { 'simplify-release-sha': value.metadata.labels?.['simplify-release-sha'] },
  };
}

export function validateReleaseJobReadback(value, expected) {
  const normalized = exact(value, expected) ? value : normalizeV1JobReadback(value);
  if (!expected || !exact(normalized, expected)) {
    throw new Error('Cloud Run release Job readback is invalid');
  }
  return true;
}

function positiveCanonicalInteger(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

export function validateReadyReleaseJobReadback(value, expected) {
  validateReleaseJobReadback(value, expected);
  const generation = positiveCanonicalInteger(value?.metadata?.generation);
  const observedGeneration = positiveCanonicalInteger(value?.status?.observedGeneration);
  const conditions = value?.status?.conditions;
  const ready = Array.isArray(conditions) && conditions.length === 1 ? conditions[0] : null;
  if (exact(value, expected) || value?.apiVersion !== 'run.googleapis.com/v1'
    || value?.kind !== 'Job' || !UUID_V4.test(String(value?.metadata?.uid ?? ''))
    || generation === null || observedGeneration !== generation
    || !ready || typeof ready !== 'object' || Array.isArray(ready)
    || ready.type !== 'Ready' || ready.status !== 'True') {
    throw new Error('Cloud Run Job authority is invalid');
  }
  return Object.freeze({
    generation,
    job: expected.job,
    uid: value.metadata.uid.toLowerCase(),
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateRejectedCloudRunExecutionLog(bytes, {
  expectedLogSha256, intent, job, project, region,
} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 128 * 1024
    || !DIGEST.test(String(expectedLogSha256 ?? ''))
    || createHash('sha256').update(bytes).digest('hex') !== expectedLogSha256
    || intent?.payload?.reconcileKind !== 'cloud-run-job-execute'
    || !intent?.operationId?.endsWith('-execute')
    || !DIGEST.test(String(intent.payload.commandSha256 ?? ''))
    || !/^[0-9a-f]{32}$/.test(String(intent.payload.operationAttemptId ?? ''))
    || !/^[a-z][a-z0-9-]{0,62}$/.test(String(job ?? ''))
    || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(String(project ?? ''))
    || !/^[a-z]+-[a-z]+[0-9]$/.test(String(region ?? ''))) {
    throw new Error('Cloud Run rejection evidence is invalid');
  }
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').length !== bytes.length || text.includes('\u0000')) {
    throw new Error('Cloud Run rejection evidence is invalid');
  }
  const runningLines = text.split(/\r?\n/u).filter((line) => (
    line.includes('Running [gcloud.run.jobs.execute] with arguments:')
  ));
  const commandLine = runningLines[0] ?? '';
  const postPattern = new RegExp([
    '"POST /apis/run\\.googleapis\\.com/v1/namespaces/',
    escapeRegex(project), '/jobs/', escapeRegex(job),
    ':run\\?alt=json HTTP/1\\.1" 400(?:\\s|$)',
  ].join(''), 'u');
  const postMatches = text.match(new RegExp(postPattern.source, 'gu')) ?? [];
  const message = `Job '${job}' cannot be run because is in an error state. Please check the job's Ready status condition.`;
  const dateMatches = [...text.matchAll(/'date': '([^'\r\n]+)'/gu)];
  const requestTime = dateMatches.length === 1 ? new Date(dateMatches[0][1]) : null;
  const intentTime = new Date(intent.createdAt);
  if (runningLines.length !== 1
    || !commandLine.includes(`--project: "${project}"`)
    || !commandLine.includes(`--region: "${region}"`)
    || !commandLine.includes('--wait: "True"')
    || !commandLine.includes('--format: "json"')
    || !commandLine.includes(`JOB: "${job}"`)
    || postMatches.length !== 1
    || !text.includes('"code": 400')
    || !text.includes(`"message": "${message}"`)
    || !text.includes('"status": "FAILED_PRECONDITION"')
    || !text.includes(`(gcloud.run.jobs.execute) FAILED_PRECONDITION: ${message}`)
    || !Number.isFinite(requestTime?.getTime())
    || !Number.isFinite(intentTime.getTime())
    || requestTime.getTime() < intentTime.getTime()
    || requestTime.getTime() - intentTime.getTime() > 5 * 60_000) {
    throw new Error('Cloud Run rejection evidence is invalid');
  }
  return Object.freeze({
    commandSha256: intent.payload.commandSha256,
    httpStatus: 400,
    logSha256: expectedLogSha256,
    operationAttemptId: intent.payload.operationAttemptId,
    rejectionMessageSha256: canonicalSha256(message),
    requestObservedAt: requestTime.toISOString(),
    rpcStatus: 'FAILED_PRECONDITION',
  });
}

function rfc3339Instant(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,9}Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

export function validateFailedCloudRunExecutionLog(bytes, {
  expectedLogSha256, intent, job, project, region,
} = {}) {
  const acceptanceExecution = failedAcceptanceExecutionContract(intent?.operationId);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 256 * 1024
    || !DIGEST.test(String(expectedLogSha256 ?? ''))
    || createHash('sha256').update(bytes).digest('hex') !== expectedLogSha256
    || intent?.recordType !== 'intent'
    || intent?.payload?.reconcileKind !== 'cloud-run-job-execute'
    || acceptanceExecution === null || acceptanceExecution.job !== job
    || !DIGEST.test(String(intent.payload.commandSha256 ?? ''))
    || !/^[0-9a-f]{32}$/u.test(String(intent.payload.operationAttemptId ?? ''))
    || !/^[a-z][a-z0-9-]{0,62}$/u.test(String(job ?? ''))
    || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(String(project ?? ''))
    || !/^[a-z]+-[a-z]+[0-9]$/u.test(String(region ?? ''))) {
    throw new Error('Cloud Run failed execution evidence is invalid');
  }
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').length !== bytes.length || text.includes('\u0000')) {
    throw new Error('Cloud Run failed execution evidence is invalid');
  }
  const runningLines = text.split(/\r?\n/u).filter((line) => (
    line.includes('Running [gcloud.run.jobs.execute] with arguments:')
  ));
  const commandLine = runningLines[0] ?? '';
  const postPattern = new RegExp([
    '"POST /apis/run\\.googleapis\\.com/v1/namespaces/',
    escapeRegex(project), '/jobs/', escapeRegex(job),
    ':run\\?alt=json HTTP/1\\.1" 200(?:\\s|$)',
  ].join(''), 'gu');
  const postMatches = text.match(postPattern) ?? [];
  const describePattern = new RegExp(`gcloud run jobs executions describe (${escapeRegex(job)}-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)`, 'gu');
  const executionNames = [...text.matchAll(describePattern)].map((match) => match[1]);
  const uniqueExecutionNames = [...new Set(executionNames)];
  if (runningLines.length !== 1
    || !commandLine.includes(`--project: "${project}"`)
    || !commandLine.includes(`--region: "${region}"`)
    || !commandLine.includes('--wait: "True"')
    || !commandLine.includes('--format: "json"')
    || !commandLine.includes(`JOB: "${job}"`)
    || postMatches.length !== 1
    || uniqueExecutionNames.length !== 1
    || !text.includes('(gcloud.run.jobs.execute) The execution failed.')) {
    throw new Error('Cloud Run failed execution evidence is invalid');
  }
  return Object.freeze({
    commandSha256: intent.payload.commandSha256,
    executionName: uniqueExecutionNames[0],
    httpStatus: 200,
    logSha256: expectedLogSha256,
    operationAttemptId: intent.payload.operationAttemptId,
  });
}

export function validateFailedReleaseJobExecutionReceipt(value, {
  expectedJob, executionName, intentCreatedAt, jobGeneration, jobUid,
} = {}) {
  const name = validateCloudRunExecutionIdentity(value, { job: expectedJob?.job });
  const metadata = value?.metadata;
  const status = value?.status;
  const generation = positiveCanonicalInteger(
    metadata?.labels?.['run.googleapis.com/jobGeneration'],
  );
  const labelledJobUid = String(metadata?.labels?.['run.googleapis.com/jobUid'] ?? '').toLowerCase();
  const executionUid = String(metadata?.uid ?? '').toLowerCase();
  const operationId = String(metadata?.annotations?.['run.googleapis.com/operation-id'] ?? '').toLowerCase();
  const createdAt = metadata?.creationTimestamp;
  const completionTime = status?.completionTime;
  const completed = Array.isArray(status?.conditions)
    ? status.conditions.filter(({ type } = {}) => type === 'Completed') : [];
  const condition = completed[0];
  const intentTime = Date.parse(intentCreatedAt);
  const createdTime = Date.parse(createdAt);
  const completionTimeMs = Date.parse(completionTime);
  const zeroCounter = (key) => Object.hasOwn(status ?? {}, key)
    ? nonnegativeInteger(status[key]) : 0;
  if (!expectedJob || name !== executionName
    || !UUID_V4.test(executionUid) || !UUID_V4.test(operationId)
    || !UUID_V4.test(String(jobUid ?? '')) || labelledJobUid !== String(jobUid).toLowerCase()
    || generation === null || generation !== jobGeneration
    || !rfc3339Instant(createdAt) || !rfc3339Instant(completionTime)
    || !Number.isFinite(intentTime) || createdTime < intentTime
    || createdTime - intentTime > 5 * 60_000
    || completionTimeMs < createdTime
    || completionTimeMs - createdTime > (expectedJob.timeoutSeconds + 300) * 1000
    || nonnegativeInteger(value?.spec?.taskCount) !== expectedJob.taskCount
    || nonnegativeInteger(value?.spec?.parallelism) !== expectedJob.parallelism
    || nonnegativeInteger(status?.failedCount) !== 1
    || zeroCounter('succeededCount') !== 0
    || zeroCounter('cancelledCount') !== 0
    || zeroCounter('retriedCount') !== 0
    || zeroCounter('runningCount') !== 0
    || completed.length !== 1 || condition?.status !== 'False'
    || condition?.reason !== 'NonZeroExitCode'
    || condition?.lastTransitionTime !== completionTime) {
    throw new Error('Cloud Run failed execution readback is invalid');
  }
  const terminalState = Object.freeze({
    cancelledCount: 0,
    completed: Object.freeze({
      lastTransitionTime: completionTime,
      reason: 'NonZeroExitCode',
      status: 'False',
      type: 'Completed',
    }),
    failedCount: 1,
    retriedCount: 0,
    runningCount: 0,
    succeededCount: 0,
  });
  return Object.freeze({
    completionTime,
    createdAt,
    executionName: name,
    executionUid,
    failedCount: 1,
    platformOperationId: operationId,
    terminalReason: 'NonZeroExitCode',
    terminalStateSha256: canonicalSha256(terminalState),
  });
}

function gcloudFileOnlyJson(text) {
  const lines = text.split(/\r?\n/u);
  const marker = '___FILE_ONLY___ ';
  const first = lines.findIndex((line) => line.includes(marker));
  if (first < 0) throw new Error('Cloud Run failed execution audit evidence is invalid');
  const payload = [];
  for (const line of lines.slice(first)) {
    if (/^\d{4}-\d{2}-\d{2} /u.test(line)) {
      const markerIndex = line.indexOf(marker);
      if (markerIndex >= 0) {
        const suffix = line.slice(markerIndex + marker.length);
        if (suffix.length > 0) payload.push(suffix);
      }
    } else {
      payload.push(line);
    }
  }
  try { return JSON.parse(payload.join('\n')); } catch {
    throw new Error('Cloud Run failed execution audit evidence is invalid');
  }
}

export function validateFailedCloudRunAuditLog(bytes, {
  expectedAuditLogSha256, expectedExecution, expectedJob, project, region,
} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 1024 * 1024
    || !DIGEST.test(String(expectedAuditLogSha256 ?? ''))
    || createHash('sha256').update(bytes).digest('hex') !== expectedAuditLogSha256
    || !expectedExecution || !expectedJob) {
    throw new Error('Cloud Run failed execution audit evidence is invalid');
  }
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').length !== bytes.length || text.includes('\u0000')) {
    throw new Error('Cloud Run failed execution audit evidence is invalid');
  }
  const runningLines = text.split(/\r?\n/u).filter((line) => (
    line.includes('Running [gcloud.logging.read] with arguments:')
  ));
  const commandLine = runningLines[0] ?? '';
  if (runningLines.length !== 1
    || !commandLine.includes('--format: "json"')
    || !commandLine.includes('--limit: "100"')
    || !commandLine.includes('--order: "asc"')
    || !commandLine.includes(`--project: "${project}"`)
    || !commandLine.includes(`job_name="${expectedJob.job}"`)
    || !commandLine.includes(`execution_name"="${expectedExecution.executionName}"`)) {
    throw new Error('Cloud Run failed execution audit evidence is invalid');
  }
  const entries = gcloudFileOnlyJson(text);
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) {
    throw new Error('Cloud Run failed execution audit evidence is invalid');
  }
  const expectedResourceName = `namespaces/${project}/executions/${expectedExecution.executionName}`;
  const matches = entries.filter((entry) => (
    entry?.protoPayload?.methodName === '/Jobs.RunJob'
    && entry?.protoPayload?.resourceName === expectedResourceName
    && entry?.labels?.['run.googleapis.com/execution_name'] === expectedExecution.executionName
  ));
  if (matches.length !== 1) throw new Error('Cloud Run failed execution audit evidence is invalid');
  const entry = matches[0];
  const expectedMessage = `Execution ${expectedExecution.executionName} has failed to complete, 0/1 tasks were a success.`;
  if (entry.logName !== `projects/${project}/logs/cloudaudit.googleapis.com%2Fsystem_event`
    || entry.resource?.type !== 'cloud_run_job'
    || entry.resource?.labels?.project_id !== project
    || entry.resource?.labels?.location !== region
    || entry.resource?.labels?.job_name !== expectedJob.job
    || entry.protoPayload?.status?.code !== 10
    || entry.protoPayload?.status?.message !== expectedMessage) {
    throw new Error('Cloud Run failed execution audit evidence is invalid');
  }
  const auditExecution = validateFailedReleaseJobExecutionReceipt(
    entry.protoPayload.response,
    {
      expectedJob,
      executionName: expectedExecution.executionName,
      intentCreatedAt: expectedExecution.intentCreatedAt,
      jobGeneration: expectedExecution.jobGeneration,
      jobUid: expectedExecution.jobUid,
    },
  );
  const comparable = ({ intentCreatedAt: ignored, jobGeneration: ignoredGeneration,
    jobUid: ignoredUid, ...member }) => member;
  if (!exact(comparable(expectedExecution), auditExecution)) {
    throw new Error('Cloud Run failed execution audit evidence is invalid');
  }
  return Object.freeze({ auditLogSha256: expectedAuditLogSha256 });
}

function validateFailedReleaseJobAuthority(value, expected) {
  validateReleaseJobReadback(value, expected);
  const generation = positiveOrZeroInteger(value?.metadata?.generation);
  const observedGeneration = positiveOrZeroInteger(value?.status?.observedGeneration);
  const ready = Array.isArray(value?.status?.conditions)
    ? value.status.conditions.filter(({ type } = {}) => type === 'Ready') : [];
  if (!UUID.test(String(value?.metadata?.uid ?? '')) || generation === null || generation < 1
    || generation !== observedGeneration || ready.length !== 1 || ready[0]?.status !== 'False') {
    throw new Error('Cloud Run rejected Job authority is invalid');
  }
  return Object.freeze({ generation, uid: value.metadata.uid.toLowerCase() });
}

export function validateMigrationExecutionReceipt(value, { releaseSha } = {}) {
  const name = value?.metadata?.name;
  const job = value?.metadata?.labels?.['run.googleapis.com/job'];
  const status = value?.status;
  const taskCount = nonnegativeInteger(value?.spec?.taskCount);
  const parallelism = nonnegativeInteger(value?.spec?.parallelism);
  const completed = Array.isArray(status?.conditions)
    ? status.conditions.filter(({ type } = {}) => type === 'Completed') : [];
  const completionTime = status?.completionTime;
  const validName = job === MIGRATION_JOB && typeof name === 'string'
    && new RegExp(`^${MIGRATION_JOB}-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`).test(name);
  if (!RELEASE_SHA.test(String(releaseSha ?? ''))
    || value?.apiVersion !== 'run.googleapis.com/v1' || value?.kind !== 'Execution'
    || !validName || taskCount !== 1 || parallelism !== 1
    || nonnegativeInteger(status?.succeededCount) !== 1
    || nonnegativeInteger(status?.failedCount ?? 0) !== 0
    || nonnegativeInteger(status?.cancelledCount ?? 0) !== 0
    || nonnegativeInteger(status?.retriedCount ?? 0) !== 0
    || nonnegativeInteger(status?.runningCount ?? 0) !== 0
    || completed.length !== 1 || completed[0]?.status !== 'True'
    || typeof completionTime !== 'string' || !Number.isFinite(Date.parse(completionTime))) {
    throw new Error('Cloud Run migration execution receipt is invalid');
  }
  return Object.freeze({
    name, job: MIGRATION_JOB, taskCount: 1, parallelism: 1,
    succeededCount: 1, completionTime,
  });
}

export function validateCloudRunExecutionIdentity(value, { job } = {}) {
  const name = value?.metadata?.name;
  const labelledJob = value?.metadata?.labels?.['run.googleapis.com/job'];
  const validName = typeof job === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(job)
    && typeof name === 'string'
    && new RegExp(`^${job}-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`).test(name);
  if (value?.apiVersion !== 'run.googleapis.com/v1' || value?.kind !== 'Execution'
    || labelledJob !== job || !validName) {
    throw new Error('Cloud Run execution identity is invalid');
  }
  return name;
}

function canonicalCloudRunExecutionBaseline(executions, {
  expectedJob, jobGeneration, jobUid,
} = {}) {
  if (!Array.isArray(executions) || executions.length > 10_000
    || !expectedJob || positiveCanonicalInteger(jobGeneration) === null
    || !UUID_V4.test(String(jobUid ?? ''))) {
    throw new Error('Cloud Run execution baseline is invalid');
  }
  const identities = executions.map((value) => {
    const name = validateCloudRunExecutionIdentity(value, { job: expectedJob.job });
    const metadata = value?.metadata;
    const labels = metadata?.labels;
    const uid = String(metadata?.uid ?? '').toLowerCase();
    const expectedSelfLink = `/apis/run.googleapis.com/v1/namespaces/${GCP_IDENTITY.projectNumber}/executions/${name}`;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || metadata.namespace !== GCP_IDENTITY.projectNumber
      || !labels || typeof labels !== 'object' || Array.isArray(labels)
      || labels['cloud.googleapis.com/location'] !== REGION
      || !UUID_V4.test(uid)
      || (metadata.selfLink !== undefined && metadata.selfLink !== expectedSelfLink)) {
      throw new Error('Cloud Run execution baseline is invalid');
    }
    return Object.freeze({ name, uid });
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(identities.map(({ name }) => name)).size !== identities.length
    || new Set(identities.map(({ uid }) => uid)).size !== identities.length) {
    throw new Error('Cloud Run execution baseline is invalid');
  }
  return Object.freeze({
    executionCount: identities.length,
    executionSetSha256: canonicalSha256(identities),
    job: expectedJob.job,
    jobGeneration,
    jobUid: String(jobUid).toLowerCase(),
    project: PROJECT,
    projectNumber: GCP_IDENTITY.projectNumber,
    region: REGION,
  });
}

async function readCloudRunExecutionBaseline(executor, expectedJob, rawJob) {
  const authority = validateReadyReleaseJobReadback(rawJob, expectedJob);
  const executions = await executor([
    'run', 'jobs', 'executions', 'list', `--job=${expectedJob.job}`,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  return canonicalCloudRunExecutionBaseline(executions, {
    expectedJob,
    jobGeneration: authority.generation,
    jobUid: authority.uid,
  });
}

export function validateReleaseJobExecutionReceipt(value, expected) {
  const name = validateCloudRunExecutionIdentity(value, { job: expected?.job });
  const taskCount = nonnegativeInteger(value?.spec?.taskCount);
  const parallelism = nonnegativeInteger(value?.spec?.parallelism);
  const status = value?.status;
  const completed = Array.isArray(status?.conditions)
    ? status.conditions.filter(({ type } = {}) => type === 'Completed') : [];
  const completionTime = status?.completionTime;
  if (!expected || taskCount !== expected.taskCount || parallelism !== expected.parallelism
    || nonnegativeInteger(status?.succeededCount) !== expected.taskCount
    || nonnegativeInteger(status?.failedCount ?? 0) !== 0
    || nonnegativeInteger(status?.cancelledCount ?? 0) !== 0
    || nonnegativeInteger(status?.retriedCount ?? 0) !== 0
    || nonnegativeInteger(status?.runningCount ?? 0) !== 0
    || completed.length !== 1 || completed[0]?.status !== 'True'
    || typeof completionTime !== 'string' || !Number.isFinite(Date.parse(completionTime))) {
    throw new Error('Cloud Run release Job execution receipt is invalid');
  }
  return Object.freeze({
    name,
    job: expected.job,
    taskCount,
    parallelism,
    succeededCount: expected.taskCount,
    completionTime,
  });
}

function normalizeEvidenceVersionReceipt(value, { secret, secretVersion = null } = {}) {
  if (typeof secret !== 'string' || !Object.values(EVIDENCE_DEFINITIONS)
    .some((definition) => definition.secret === secret)
    || !(secretVersion === null || NUMERIC_VERSION.test(String(secretVersion ?? '')))
    || !value || typeof value !== 'object' || Array.isArray(value)
    || value.state !== 'ENABLED' || typeof value.name !== 'string') {
    throw new Error('Evidence version receipt is invalid');
  }
  const prefixes = [PROJECT, GCP_IDENTITY.projectNumber].map(
    (project) => `projects/${project}/secrets/${secret}/versions/`,
  );
  const prefix = prefixes.find((candidate) => value.name.startsWith(candidate));
  const assignedVersion = prefix === undefined ? '' : value.name.slice(prefix.length);
  if (!NUMERIC_VERSION.test(assignedVersion)
    || (secretVersion !== null && assignedVersion !== secretVersion)) {
    throw new Error('Evidence version receipt is invalid');
  }
  return Object.freeze({
    name: `projects/${PROJECT}/secrets/${secret}/versions/${assignedVersion}`,
    state: 'ENABLED',
    version: assignedVersion,
  });
}

export function validateEvidenceVersionReceipt(value, expected) {
  normalizeEvidenceVersionReceipt(value, expected);
  return true;
}

function bindAssignedSecretVersion(argv, assignedVersion) {
  if (!Array.isArray(argv) || argv.length !== 7
    || !['describe', 'access'].includes(argv[2])
    || argv[3] !== ASSIGNED_SECRET_VERSION
    || !NUMERIC_VERSION.test(String(assignedVersion ?? ''))) {
    throw new Error('Assigned evidence Secret version is unavailable');
  }
  const bound = [...argv];
  bound[3] = assignedVersion;
  return bound;
}

function assignedSecretVersionOperationKey(operationId) {
  const match = /^(?:inventory|evidence)-(?:readback|payload-readback):([A-Za-z][A-Za-z0-9]*)$/u
    .exec(String(operationId ?? ''));
  return match?.[1] ?? null;
}

export function validateEvidencePayloadReceipt(value, expected) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)
    || !expected || !DIGEST.test(String(expected.artifactSha256 ?? ''))
    || !DIGEST.test(String(expected.objectSha256 ?? ''))) {
    throw new Error('Evidence payload readback is invalid');
  }
  const unpadded = value.replace(/=+$/u, '');
  let bytes;
  try { bytes = Buffer.from(unpadded, 'base64url'); } catch {
    throw new Error('Evidence payload readback is invalid');
  }
  if (bytes.length < 2 || bytes.length > 1024 * 1024
    || bytes.toString('base64url') !== unpadded
    || createHash('sha256').update(bytes).digest('hex') !== expected.objectSha256) {
    throw new Error('Evidence payload readback is invalid');
  }
  return Object.freeze({
    artifactSha256: expected.artifactSha256,
    byteLength: bytes.length,
    objectSha256: expected.objectSha256,
  });
}

function semanticEvidenceFinalizer(kind) {
  return ['asrSmoke', 'ttsSmoke', 'iosVoiceAcceptance'].includes(kind)
    ? finalizeEvidenceRecord : finalizeReleaseEvidenceRecord;
}

export async function validateEvidenceArtifactFile(value, {
  releaseSha, kind = null, iosVoiceMode = 'historical', iosVoiceNow,
} = {}) {
  if (!exactKeys(value, ['artifactSha256', 'filePath', 'objectSha256'])
    || !isAbsoluteFile(value.filePath)
    || !DIGEST.test(String(value.artifactSha256 ?? ''))
    || !DIGEST.test(String(value.objectSha256 ?? ''))
    || !RELEASE_SHA.test(String(releaseSha ?? ''))) {
    throw new Error('Evidence artifact file is invalid');
  }
  let metadata;
  let contents;
  try {
    metadata = await lstat(value.filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > 1024 * 1024) throw new Error('invalid size');
    contents = await readBoundedOrdinaryFile(value.filePath, {
      expectedByteLength: metadata.size, maximumBytes: 1024 * 1024,
    });
  } catch { throw new Error('Evidence artifact file is invalid'); }
  const textValue = contents.toString('utf8');
  if (!Buffer.from(textValue, 'utf8').equals(contents)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@|"(?:accessToken|access_token|private_key)"\s*:/i.test(textValue)
    || createHash('sha256').update(contents).digest('hex') !== value.objectSha256) {
    throw new Error('Evidence artifact file is invalid');
  }
  let record;
  try { record = JSON.parse(textValue); } catch { throw new Error('Evidence artifact file is invalid'); }
  if (containsForbiddenPersistedSecret(record)) throw new Error('Evidence artifact file is invalid');
  let semanticDigest;
  try { semanticDigest = semanticEvidenceFinalizer(kind)(record).artifactSha256; } catch {
    throw new Error('Evidence artifact file is invalid');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.commitSha !== releaseSha
    || record.artifactSha256 !== value.artifactSha256
    || semanticDigest !== value.artifactSha256) {
    throw new Error('Evidence artifact file is invalid');
  }
  if (kind === 'iosVoiceAcceptance') {
    if (!['current', 'historical'].includes(iosVoiceMode)) {
      throw new Error('Evidence artifact file is invalid');
    }
    if (iosVoiceMode === 'current') {
      const currentTime = new Date(iosVoiceNow).getTime();
      if (!Number.isFinite(currentTime) || !validateIosVoiceReleaseEvidence(record, {
        expectedVersion: value.artifactSha256,
        commitSha: releaseSha,
        normalizerContractVersion: CANONICAL_WAV.contractVersion,
        now: new Date(currentTime),
      })) {
        throw new Error('Evidence artifact file is invalid');
      }
    }
  }
  return Object.freeze({
    artifactSha256: value.artifactSha256,
    objectSha256: value.objectSha256,
    byteLength: contents.length,
    contentsBase64: contents.toString('base64'),
  });
}

export function validateAcceptanceObjectReceipt(value, output) {
  const size = Number(value?.size);
  if (!exactKeys(output, ['bucket', 'filePath', 'generation', 'object'])
    || value?.bucket !== output.bucket
    || value?.name !== output.object
    || String(value?.generation ?? '') !== output.generation
    || !Number.isSafeInteger(size) || size < 2 || size > 1024 * 1024
    || (value?.contentType !== undefined && value.contentType !== 'application/json')
    || (Array.isArray(value?.acl) && value.acl.some(({ entity } = {}) => (
      entity === 'allUsers' || entity === 'allAuthenticatedUsers'
    )))) {
    throw new Error('Acceptance evidence object receipt is invalid');
  }
  return Object.freeze({
    bucket: output.bucket,
    object: output.object,
    generation: output.generation,
    size,
  });
}

export async function inspectCollectedEvidenceArtifact(filePath, { releaseSha, kind = null } = {}) {
  if (!isAbsoluteFile(filePath) || !RELEASE_SHA.test(String(releaseSha ?? ''))) {
    throw new Error('Collected evidence artifact is invalid');
  }
  let contents;
  let metadata;
  try {
    metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > 1024 * 1024) throw new Error('invalid file');
    contents = await readBoundedOrdinaryFile(filePath, {
      expectedByteLength: metadata.size, maximumBytes: 1024 * 1024,
    });
  } catch { throw new Error('Collected evidence artifact is invalid'); }
  const textValue = contents.toString('utf8');
  if (!Buffer.from(textValue, 'utf8').equals(contents)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@|"(?:accessToken|access_token|private_key)"\s*:/i.test(textValue)) {
    throw new Error('Collected evidence artifact is invalid');
  }
  let record;
  try { record = JSON.parse(textValue); } catch { throw new Error('Collected evidence artifact is invalid'); }
  if (containsForbiddenPersistedSecret(record)) throw new Error('Collected evidence artifact is invalid');
  const artifactSha256 = record?.artifactSha256;
  const objectSha256 = createHash('sha256').update(contents).digest('hex');
  const expectedCapabilities = {
    llmSmoke: 'llm', asrSmoke: 'asr', ttsSmoke: 'tts',
  };
  const validKind = kind === null
    || (kind === 'dependencyAcceptance' && record?.result === true)
    || (Object.hasOwn(expectedCapabilities, kind)
      && record?.result === 'pass' && record?.capability === expectedCapabilities[kind]);
  if (!DIGEST.test(String(artifactSha256 ?? '')) || record?.commitSha !== releaseSha
    || ![1, 2].includes(record?.schemaVersion) || !validKind) {
    throw new Error('Collected evidence artifact is invalid');
  }
  await validateEvidenceArtifactFile({
    filePath, artifactSha256, objectSha256,
  }, { releaseSha, kind });
  return Object.freeze({ filePath, artifactSha256, objectSha256, byteLength: contents.length });
}

async function validateEvidenceArtifactSet(evidence, {
  releaseSha, iosVoiceMode = 'historical', iosVoiceNow,
} = {}) {
  if (!['current', 'historical'].includes(iosVoiceMode)
    || (iosVoiceMode === 'current' && !Number.isFinite(new Date(iosVoiceNow).getTime()))) {
    throw new Error('Evidence artifact set is invalid');
  }
  const validated = {};
  for (const [kind, value] of Object.entries(evidence)) {
    validated[kind] = await validateEvidenceArtifactFile({
      filePath: value.filePath,
      artifactSha256: value.artifactSha256,
      objectSha256: value.objectSha256,
    }, { releaseSha, kind, iosVoiceMode, iosVoiceNow });
  }
  return Object.freeze(validated);
}

function freezeEvidencePublicationPayloads(validation, evidence, selected) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
    throw new Error('Evidence publication payload is invalid');
  }
  const payloads = {};
  for (const { id } of selected) {
    if (!id.startsWith('inventory-publish:') && !id.startsWith('evidence-publish:')) continue;
    const key = id.slice(id.indexOf(':') + 1);
    const expected = evidence[key];
    const member = validation[key];
    if (!expected || !exactKeys(member, [
      'artifactSha256', 'byteLength', 'contentsBase64', 'objectSha256',
    ]) || member.artifactSha256 !== expected.artifactSha256
      || member.objectSha256 !== expected.objectSha256
      || !Number.isSafeInteger(member.byteLength) || member.byteLength < 2
      || member.byteLength > 1024 * 1024 || typeof member.contentsBase64 !== 'string') {
      throw new Error('Evidence publication payload is invalid');
    }
    const bytes = Buffer.from(member.contentsBase64, 'base64');
    if (bytes.length !== member.byteLength
      || bytes.toString('base64') !== member.contentsBase64
      || createHash('sha256').update(bytes).digest('hex') !== expected.objectSha256) {
      throw new Error('Evidence publication payload is invalid');
    }
    payloads[key] = member.contentsBase64;
  }
  return Object.freeze(payloads);
}

function evidencePublicationBytes(payloads, key, expected) {
  const contentsBase64 = payloads?.[key];
  if (typeof contentsBase64 !== 'string' || !expected) {
    throw new Error('Evidence publication payload is invalid');
  }
  const bytes = Buffer.from(contentsBase64, 'base64');
  if (bytes.length < 2 || bytes.length > 1024 * 1024
    || bytes.toString('base64') !== contentsBase64
    || createHash('sha256').update(bytes).digest('hex') !== expected.objectSha256) {
    throw new Error('Evidence publication payload is invalid');
  }
  return bytes;
}

export function createReleaseGcloudExecutor({
  environment = process.env,
  ordinaryExecutor = createDefaultGcloudExecutor({ environment }),
  execFileImpl = execFile,
  resolveLaunch = resolveDefaultGcloudLaunch,
} = {}) {
  if (typeof ordinaryExecutor !== 'function' || typeof execFileImpl !== 'function'
    || typeof resolveLaunch !== 'function') {
    throw new Error('Release gcloud executor configuration is invalid');
  }
  return async (argv, options = {}) => {
    const secrets = new Set(Object.values(EVIDENCE_DEFINITIONS).map(({ secret }) => secret));
    if (Object.hasOwn(options, 'text')) {
      if (!exactKeys(options, ['maxBuffer', 'text']) || options.text !== true
        || options.maxBuffer !== 2 * 1024 * 1024
        || !Array.isArray(argv) || argv.length !== 7
        || argv[0] !== 'secrets' || argv[1] !== 'versions' || argv[2] !== 'access'
        || !NUMERIC_VERSION.test(String(argv[3] ?? ''))
        || typeof argv[4] !== 'string' || !argv[4].startsWith('--secret=')
        || !secrets.has(argv[4].slice('--secret='.length))
        || argv[5] !== `--project=${PROJECT}` || argv[6] !== '--format=get(payload.data)') {
        throw new Error('Release gcloud text invocation is invalid');
      }
      const { executable, prefixArgs } = resolveLaunch(environment);
      return new Promise((resolveExecution, rejectExecution) => {
        try {
          execFileImpl(executable, [...prefixArgs, ...argv, '--quiet'], {
            encoding: 'utf8', maxBuffer: options.maxBuffer, windowsHide: true,
            shell: false, timeout: 120_000,
          }, (error, stdout) => {
            const textValue = String(stdout ?? '').trim();
            if (error || !textValue) {
              rejectExecution(new Error('Release gcloud text invocation failed'));
              return;
            }
            resolveExecution(textValue);
          });
        } catch {
          rejectExecution(new Error('Release gcloud text invocation failed'));
        }
      });
    }
    if (!Object.hasOwn(options, 'stdin')) return ordinaryExecutor(argv, options);
    const stdin = options.stdin;
    if (!exactKeys(options, ['stdin']) || !Buffer.isBuffer(stdin)
      || stdin.length < 2 || stdin.length > 1024 * 1024
      || !Array.isArray(argv) || argv.length !== 7
      || argv[0] !== 'secrets' || argv[1] !== 'versions' || argv[2] !== 'add'
      || !secrets.has(argv[3]) || argv[4] !== '--data-file=-'
      || argv[5] !== `--project=${PROJECT}` || argv[6] !== '--format=json') {
      throw new Error('Release gcloud stdin invocation is invalid');
    }
    const { executable, prefixArgs } = resolveLaunch(environment);
    return new Promise((resolveExecution, rejectExecution) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        rejectExecution(new Error('Release gcloud stdin invocation failed'));
      };
      const succeed = (value) => {
        if (settled) return;
        settled = true;
        resolveExecution(value);
      };
      let child;
      try {
        child = execFileImpl(executable, [...prefixArgs, ...argv, '--quiet'], {
          encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true,
          shell: false, timeout: 120_000,
        }, (error, stdout) => {
          if (error) { fail(); return; }
          const textValue = String(stdout ?? '').trim();
          if (!textValue) { succeed(null); return; }
          try { succeed(JSON.parse(textValue)); } catch { fail(); }
        });
      } catch { fail(); return; }
      if (!child?.stdin || typeof child.stdin.end !== 'function'
        || typeof child.stdin.once !== 'function') {
        child?.kill?.();
        fail();
        return;
      }
      child.stdin.once('error', () => {
        child?.kill?.();
        fail();
      });
      child.stdin.end(Buffer.from(stdin));
    });
  };
}

function recentEvidenceTime(value, now, maximumAgeMs = 24 * 60 * 60_000) {
  const observed = Date.parse(value);
  const current = new Date(now).getTime();
  return Number.isFinite(observed) && Number.isFinite(current)
    && observed <= current + 5 * 60_000 && current - observed <= maximumAgeMs;
}

function validateLatencyMetric(value, expected) {
  const hasP50 = expected.p50ThresholdMs !== undefined;
  const keys = hasP50
    ? ['p50Ms', 'p50ThresholdMs', 'p95Ms', 'p95ThresholdMs', 'pass', 'sampleCount']
    : ['p95Ms', 'p95ThresholdMs', 'pass', 'sampleCount'];
  return exactKeys(value, keys)
    && value.sampleCount === expected.sampleCount
    && value.p95ThresholdMs === expected.p95ThresholdMs
    && Number.isFinite(value.p95Ms) && value.p95Ms >= 0
    && value.p95Ms <= value.p95ThresholdMs
    && value.pass === true
    && (!hasP50 || (
      value.p50ThresholdMs === expected.p50ThresholdMs
      && Number.isFinite(value.p50Ms) && value.p50Ms >= 0
      && value.p50Ms <= value.p95Ms && value.p50Ms <= value.p50ThresholdMs
    ));
}

function validateLatencyObservation(value, expectedSampleCount) {
  return exactKeys(value, ['available', 'p50Ms', 'p95Ms', 'sampleCount'])
    && value.available === true && value.sampleCount === expectedSampleCount
    && Number.isFinite(value.p50Ms) && value.p50Ms >= 0
    && Number.isFinite(value.p95Ms) && value.p95Ms >= value.p50Ms;
}

function rawNearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function rawLatencyMetric(values, expectedCount, { p50 = null, p95 }) {
  const safe = values.filter((value) => Number.isFinite(value) && value >= 0);
  const p50Ms = rawNearestRank(safe, 0.5);
  const p95Ms = rawNearestRank(safe, 0.95);
  return {
    sampleCount: safe.length,
    ...(p50 === null ? {} : { p50Ms, p50ThresholdMs: p50 }),
    p95Ms,
    p95ThresholdMs: p95,
    pass: safe.length === expectedCount && p95Ms !== null && p95Ms <= p95
      && (p50 === null || (p50Ms !== null && p50Ms <= p50)),
  };
}

function rawTimingObservation(samples, operation, layer, expectedCount) {
  const values = samples.filter((sample) => (
    sample.operation === operation && sample.layer === layer && sample.outcome === 'success'
  )).map(({ latencyMs }) => latencyMs);
  return {
    available: values.length === expectedCount,
    sampleCount: values.length,
    p50Ms: rawNearestRank(values, 0.5),
    p95Ms: rawNearestRank(values, 0.95),
  };
}

function validateRawLatencyReceipts(record, plan) {
  const raw = record?.rawReceipts;
  if (!exactKeys(raw, [
    'acceptanceWindowId', 'asrRequests', 'controlPlaneRequests', 'receiptsSha256',
    'candidateService', 'schemaVersion', 'stableService', 'stableTrafficState',
    'textTurns', 'timingQueries', 'trafficState', 'ttsRequests',
  ]) || raw.schemaVersion !== 2 || !DIGEST.test(String(raw.acceptanceWindowId ?? ''))
    || raw.candidateService !== CANDIDATE_SERVICE || raw.stableService !== STABLE_SERVICE
    || raw.trafficState !== candidateTrafficState(plan)
    || raw.stableTrafficState !== plan.expectedStable.initialTrafficState
    || !DIGEST.test(String(raw.receiptsSha256 ?? ''))) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  const { receiptsSha256: ignored, ...rawPayload } = raw;
  void ignored;
  if (canonicalSha256(rawPayload) !== raw.receiptsSha256
    || !Array.isArray(raw.textTurns) || raw.textTurns.length !== 200
    || !Array.isArray(raw.asrRequests) || raw.asrRequests.length !== 30
    || !Array.isArray(raw.ttsRequests) || raw.ttsRequests.length !== 31
    || !Array.isArray(raw.timingQueries) || raw.timingQueries.length !== 20
    || !Array.isArray(raw.controlPlaneRequests) || raw.controlPlaneRequests.length !== 200) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  const textKeys = [
    'ackMs', 'acknowledged', 'assistantMessageId', 'clientMessageId', 'controlledTtsFailure',
    'correlationId', 'delivered', 'duplicateAssistantReplyCount', 'finalAnswerMs',
    'groundingEvidenceSha256', 'groundingSatisfied', 'groundingVerified', 'messageLost',
    'processingVisible', 'processingVisibleMs', 'promptClass', 'replyLanguage', 'replyMode',
    'requestId', 'requestStatus', 'responseRequestId', 'responseStatus', 'sequence',
    'sessionIdSha256', 'sessionIndex', 'traceId', 'turnIndex', 'unsupportedVerifiedClaimCount',
  ];
  const uuids = new Set();
  const traceIds = new Set();
  const assistantIds = new Set();
  const sessionHashes = new Map();
  for (const [index, turn] of raw.textTurns.entries()) {
    const sessionIndex = Math.floor(index / 10);
    const turnIndex = index % 10;
    const expectedClass = turnIndex < 4 ? 'grounded' : (turnIndex < 7 ? 'abstention' : 'casual');
    const expectedMode = turnIndex === 0 || (turnIndex === 1 && sessionIndex < 11) ? 'voice' : 'text';
    const expectedControlledFailure = turnIndex === 1 && sessionIndex === 10;
    if (!exactKeys(turn, textKeys) || turn.sequence !== index + 1
      || turn.sessionIndex !== sessionIndex || turn.turnIndex !== turnIndex
      || turn.promptClass !== expectedClass || turn.replyMode !== expectedMode
      || turn.controlledTtsFailure !== expectedControlledFailure
      || !['en', 'yue-Hant-HK', 'cmn-Hans-CN'].includes(turn.replyLanguage)
      || turn.replyLanguage !== ['en', 'yue-Hant-HK', 'cmn-Hans-CN'][index % 3]
      || !DIGEST.test(String(turn.sessionIdSha256 ?? ''))
      || !UUID.test(String(turn.clientMessageId ?? '')) || !UUID.test(String(turn.correlationId ?? ''))
      || !UUID.test(String(turn.requestId ?? '')) || !UUID.test(String(turn.responseRequestId ?? ''))
      || !/^[0-9a-f]{32}$/.test(String(turn.traceId ?? ''))
      || typeof turn.assistantMessageId !== 'string' || turn.assistantMessageId.length < 1
      || turn.assistantMessageId.length > 128 || !DIGEST.test(String(turn.groundingEvidenceSha256 ?? ''))
      || turn.requestStatus !== 202 || turn.responseStatus !== 200
      || turn.acknowledged !== true || turn.processingVisible !== true || turn.delivered !== true
      || !Number.isFinite(turn.ackMs) || turn.ackMs < 0
      || !Number.isFinite(turn.processingVisibleMs) || turn.processingVisibleMs < 0
      || !Number.isFinite(turn.finalAnswerMs) || turn.finalAnswerMs < 0
      || turn.messageLost !== false || turn.duplicateAssistantReplyCount !== 0
      || turn.unsupportedVerifiedClaimCount !== 0 || turn.groundingSatisfied !== true
      || turn.groundingVerified !== (expectedClass === 'grounded')) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    const identifiers = [turn.clientMessageId, turn.correlationId, turn.requestId, turn.responseRequestId];
    if (identifiers.some((value) => uuids.has(value))) throw new Error('Task 8 raw workload receipts are invalid');
    identifiers.forEach((value) => uuids.add(value));
    if (traceIds.has(turn.traceId) || assistantIds.has(turn.assistantMessageId)) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    traceIds.add(turn.traceId);
    assistantIds.add(turn.assistantMessageId);
    if (sessionHashes.has(sessionIndex) && sessionHashes.get(sessionIndex) !== turn.sessionIdSha256) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    sessionHashes.set(sessionIndex, turn.sessionIdSha256);
  }
  if (sessionHashes.size !== 20) throw new Error('Task 8 raw workload receipts are invalid');

  const asrKeys = [
    'bindingId', 'clientUploadId', 'correlationId', 'durationBucketSeconds', 'durationMs',
    'fixtureId', 'fixtureSha256', 'language', 'ready', 'requestId', 'requestStatus',
    'responseRequestId', 'responseStatus', 'sampleIndex', 'sequence', 'sessionIndex', 'wireLanguage',
  ];
  const languageWire = { cantonese: 'yue-Hant-HK', english: 'en', mandarin: 'cmn-Hans-CN' };
  for (const [index, item] of raw.asrRequests.entries()) {
    if (!exactKeys(item, asrKeys) || item.sequence !== index + 1 || item.sampleIndex !== index
      || item.sessionIndex !== index % 20 || item.ready !== true
      || item.bindingId !== item.clientUploadId || !UUID.test(String(item.clientUploadId ?? ''))
      || !UUID.test(String(item.correlationId ?? '')) || !UUID.test(String(item.requestId ?? ''))
      || !UUID.test(String(item.responseRequestId ?? '')) || item.requestStatus !== 202
      || item.responseStatus !== 200 || !DIGEST.test(String(item.fixtureSha256 ?? ''))
      || typeof item.fixtureId !== 'string' || item.fixtureId.length < 1
      || !Object.hasOwn(languageWire, item.language) || item.wireLanguage !== languageWire[item.language]
      || ![10, 30, 55].includes(item.durationBucketSeconds)
      || !Number.isFinite(item.durationMs) || Math.abs(item.durationMs - item.durationBucketSeconds * 1_000) > 1_000) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
  }
  const ttsKeys = [
    'bindingId', 'correlationId', 'durationMs', 'expectedProviderFailure', 'failureCode',
    'mediaValidated', 'messageIdMatches', 'providerFailureObserved', 'ready', 'requestId',
    'requestIndex', 'requestStatus', 'responseRequestId', 'responseStatus', 'sequence',
    'sessionIndex', 'sourceTurnIndex', 'textAvailable',
  ];
  for (const [index, item] of raw.ttsRequests.entries()) {
    const failure = index === 30;
    if (!exactKeys(item, ttsKeys) || item.sequence !== index + 1 || item.requestIndex !== index
      || !Number.isSafeInteger(item.sessionIndex) || item.sessionIndex < 0 || item.sessionIndex > 19
      || !Number.isSafeInteger(item.sourceTurnIndex) || item.sourceTurnIndex < 0 || item.sourceTurnIndex > 9
      || typeof item.bindingId !== 'string' || !assistantIds.has(item.bindingId)
      || !UUID.test(String(item.correlationId ?? '')) || !UUID.test(String(item.requestId ?? ''))
      || !UUID.test(String(item.responseRequestId ?? '')) || item.requestStatus !== 200
      || item.responseStatus !== 200 || item.durationMs !== null || item.expectedProviderFailure !== failure
      || item.ready !== !failure || item.providerFailureObserved !== failure
      || item.failureCode !== (failure ? 'VOICE_SYNTHESIS_REJECTED' : null)
      || item.textAvailable !== true || item.messageIdMatches !== true || item.mediaValidated !== !failure) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
  }

  const samples = [];
  const queryDigests = [];
  for (const [index, query] of raw.timingQueries.entries()) {
    if (!exactKeys(query, ['queryDigest', 'samples', 'sequence', 'sessionIndex'])
      || query.sequence !== index + 1 || query.sessionIndex !== index
      || !DIGEST.test(String(query.queryDigest ?? '')) || !Array.isArray(query.samples)) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    queryDigests.push(query.queryDigest);
    for (const sample of query.samples) {
      if (!exactKeys(sample, [
        'bindingId', 'correlationId', 'durationMs', 'failureCode', 'latencyMs', 'layer',
        'operation', 'outcome',
      ]) || !UUID.test(String(sample.correlationId ?? ''))
        || typeof sample.bindingId !== 'string' || sample.bindingId.length < 1
        || !['text', 'asr', 'tts'].includes(sample.operation)
        || !['provider', 'server'].includes(sample.layer)
        || !['success', 'failure'].includes(sample.outcome)
        || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0
        || (sample.operation === 'asr' ? !Number.isFinite(sample.durationMs) : sample.durationMs !== null)
        || (sample.outcome === 'success' ? sample.failureCode !== null
          : sample.failureCode !== 'VOICE_SYNTHESIS_REJECTED')) {
        throw new Error('Task 8 raw workload receipts are invalid');
      }
      samples.push(sample);
    }
  }
  if (samples.length !== 402 || new Set(queryDigests).size !== 20) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  const sampleKeys = new Set();
  for (const sample of samples) {
    const key = `${sample.operation}\0${sample.layer}\0${sample.correlationId}\0${sample.bindingId}`;
    if (sampleKeys.has(key)) throw new Error('Task 8 raw workload receipts are invalid');
    sampleKeys.add(key);
  }
  const match = (item, operation, layer) => samples.filter((sample) => (
    sample.operation === operation && sample.layer === layer
    && sample.correlationId === item.correlationId && sample.bindingId === item.bindingId
  ));
  const textWithBinding = raw.textTurns.map((item) => ({ ...item, bindingId: item.assistantMessageId }));
  if (textWithBinding.some((item) => match(item, 'text', 'server').length !== 1
      || match(item, 'text', 'provider').length !== (item.promptClass === 'grounded' ? 1 : 0))
    || raw.asrRequests.some((item) => match(item, 'asr', 'server').length !== 1
      || match(item, 'asr', 'provider').length !== 1)
    || raw.ttsRequests.some((item) => match(item, 'tts', 'server').length !== 1
      || match(item, 'tts', 'provider').length !== 1)) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  for (const item of raw.asrRequests) {
    for (const sample of [...match(item, 'asr', 'server'), ...match(item, 'asr', 'provider')]) {
      if (sample.durationMs !== item.durationMs || sample.outcome !== 'success' || sample.failureCode !== null) {
        throw new Error('Task 8 raw workload receipts are invalid');
      }
    }
  }
  for (const item of raw.ttsRequests) {
    const outcome = item.expectedProviderFailure ? 'failure' : 'success';
    for (const sample of [...match(item, 'tts', 'server'), ...match(item, 'tts', 'provider')]) {
      if (sample.outcome !== outcome
        || sample.failureCode !== (item.expectedProviderFailure ? 'VOICE_SYNTHESIS_REJECTED' : null)) {
        throw new Error('Task 8 raw workload receipts are invalid');
      }
    }
  }

  const controlKeys = ['insertId', 'latencyMs', 'sequence', 'status', 'timestamp', 'trace'];
  const controlInsertIds = new Set();
  const controlTraces = new Set();
  for (const [index, entry] of raw.controlPlaneRequests.entries()) {
    if (!exactKeys(entry, controlKeys) || entry.sequence !== index + 1 || entry.status !== 202
      || typeof entry.insertId !== 'string' || entry.insertId.length < 1
      || typeof entry.trace !== 'string'
      || !new RegExp(`^projects/${PROJECT}/traces/[0-9a-f]{32}$`).test(entry.trace)
      || !Number.isFinite(Date.parse(entry.timestamp))
      || !Number.isFinite(entry.latencyMs) || entry.latencyMs < 0 || entry.latencyMs > 60_000
      || controlInsertIds.has(entry.insertId) || controlTraces.has(entry.trace)) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    controlInsertIds.add(entry.insertId);
    controlTraces.add(entry.trace);
  }
  if (![...traceIds].every((traceId) => controlTraces.has(`projects/${PROJECT}/traces/${traceId}`))) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }

  const asrServerLatency = (item) => match(item, 'asr', 'server')[0].latencyMs;
  const successfulTts = raw.ttsRequests.filter(({ expectedProviderFailure }) => !expectedProviderFailure);
  const metrics = {
    sendAck: rawLatencyMetric(raw.textTurns.map(({ ackMs }) => ackMs), 200, { p95: 300 }),
    processingVisible: rawLatencyMetric(raw.textTurns.map(({ processingVisibleMs }) => processingVisibleMs), 200, { p95: 500 }),
    groundedResponse: rawLatencyMetric(raw.textTurns.filter(({ promptClass }) => promptClass === 'grounded')
      .map(({ finalAnswerMs }) => finalAnswerMs), 80, { p50: 2_500, p95: 6_000 }),
    asr10: rawLatencyMetric(raw.asrRequests.filter(({ durationBucketSeconds }) => durationBucketSeconds === 10)
      .map(asrServerLatency), 10, { p50: 2_500, p95: 4_000 }),
    asr30: rawLatencyMetric(raw.asrRequests.filter(({ durationBucketSeconds }) => durationBucketSeconds === 30)
      .map(asrServerLatency), 10, { p95: 6_000 }),
    asr55: rawLatencyMetric(raw.asrRequests.filter(({ durationBucketSeconds }) => durationBucketSeconds === 55)
      .map(asrServerLatency), 10, { p95: 6_000 }),
    ttsReady: rawLatencyMetric(successfulTts.map((item) => match(item, 'tts', 'server')[0].latencyMs), 30,
      { p50: 2_500, p95: 5_000 }),
  };
  const counts = {
    sessionsCreated: sessionHashes.size,
    textTurnsAttempted: raw.textTurns.length,
    textTurnsAcknowledged: raw.textTurns.filter(({ acknowledged }) => acknowledged).length,
    textTurnsDelivered: raw.textTurns.filter(({ delivered }) => delivered).length,
    asrRequestsAttempted: raw.asrRequests.length,
    asrReady: raw.asrRequests.filter(({ ready }) => ready).length,
    ttsRequestsAttempted: raw.ttsRequests.length,
    ttsReady: raw.ttsRequests.filter(({ ready }) => ready).length,
    ttsControlledProviderFailures: raw.ttsRequests.filter((item) => (
      item.expectedProviderFailure && item.providerFailureObserved
      && item.failureCode === 'VOICE_SYNTHESIS_REJECTED'
    )).length,
  };
  const invariants = {
    acknowledgedMessageLossCount: raw.textTurns.filter(({ acknowledged, messageLost }) => acknowledged && messageLost).length,
    duplicateAssistantReplyCount: raw.textTurns.reduce((sum, item) => sum + item.duplicateAssistantReplyCount, 0),
    unsupportedVerifiedClaimCount: raw.textTurns.reduce((sum, item) => sum + item.unsupportedVerifiedClaimCount, 0),
    ttsFailureTextLossCount: raw.ttsRequests.filter(({ textAvailable }) => !textAvailable).length,
    ttsMediaValidationFailureCount: raw.ttsRequests.filter((item) => !item.expectedProviderFailure && !item.mediaValidated).length,
    ttsMessageBindingMismatchCount: raw.ttsRequests.filter(({ messageIdMatches }) => !messageIdMatches).length,
    controlledTtsProviderFailureMismatchCount: raw.ttsRequests.filter((item) => item.expectedProviderFailure && (
      item.ready || !item.providerFailureObserved || item.failureCode !== 'VOICE_SYNTHESIS_REJECTED'
    )).length,
  };
  const observations = {
    releaseCommitSha: plan.releaseSha,
    queryDigests: { sampleCount: 20, values: [...queryDigests].sort(), pass: true },
    provider: {
      text: rawTimingObservation(samples, 'text', 'provider', 80),
      asr: rawTimingObservation(samples, 'asr', 'provider', 30),
      tts: rawTimingObservation(samples, 'tts', 'provider', 30),
    },
    server: {
      text: rawTimingObservation(samples, 'text', 'server', 200),
      asr: rawTimingObservation(samples, 'asr', 'server', 30),
      tts: rawTimingObservation(samples, 'tts', 'server', 30),
    },
    pairs: {
      text: { available: true, expectedServerCount: 200, serverBoundCount: 200, expectedProviderCount: 80, providerPairedCount: 80 },
      asr: { available: true, expectedCount: 30, pairedCount: 30 },
      tts: { available: true, expectedSuccessCount: 30, successPairedCount: 30, expectedFailureCount: 1, failurePairedCount: 1 },
    },
  };
  const result = Object.values(metrics).every(({ pass }) => pass)
    && Object.values(invariants).every((value) => value === 0)
    && Object.values(counts).every((value, index) => value === [20, 200, 200, 200, 30, 30, 31, 30, 1][index])
    && ['provider', 'server'].every((layer) => Object.values(observations[layer]).every(({ available }) => available));
  return { counts, invariants, metrics, observations, result };
}

function validateLatencyAcceptanceRecord(record, plan, now) {
  const expectedMetrics = {
    sendAck: { sampleCount: 200, p95ThresholdMs: 300 },
    processingVisible: { sampleCount: 200, p95ThresholdMs: 500 },
    groundedResponse: { sampleCount: 80, p50ThresholdMs: 2_500, p95ThresholdMs: 6_000 },
    asr10: { sampleCount: 10, p50ThresholdMs: 2_500, p95ThresholdMs: 4_000 },
    asr30: { sampleCount: 10, p95ThresholdMs: 6_000 },
    asr55: { sampleCount: 10, p95ThresholdMs: 6_000 },
    ttsReady: { sampleCount: 30, p50ThresholdMs: 2_500, p95ThresholdMs: 5_000 },
  };
  const expectedCounts = {
    sessionsCreated: 20,
    textTurnsAttempted: 200,
    textTurnsAcknowledged: 200,
    textTurnsDelivered: 200,
    asrRequestsAttempted: 30,
    asrReady: 30,
    ttsRequestsAttempted: 31,
    ttsReady: 30,
    ttsControlledProviderFailures: 1,
  };
  const expectedInvariants = {
    acknowledgedMessageLossCount: 0,
    duplicateAssistantReplyCount: 0,
    unsupportedVerifiedClaimCount: 0,
    ttsFailureTextLossCount: 0,
    ttsMediaValidationFailureCount: 0,
    ttsMessageBindingMismatchCount: 0,
    controlledTtsProviderFailureMismatchCount: 0,
  };
  const expectedPairs = {
    text: {
      available: true,
      expectedServerCount: 200,
      serverBoundCount: 200,
      expectedProviderCount: 80,
      providerPairedCount: 80,
    },
    asr: { available: true, expectedCount: 30, pairedCount: 30 },
    tts: {
      available: true,
      expectedSuccessCount: 30,
      successPairedCount: 30,
      expectedFailureCount: 1,
      failurePairedCount: 1,
    },
  };
  const observations = record?.observations;
  const queryDigests = observations?.queryDigests;
  const digestValues = queryDigests?.values;
  const exactQueryDigests = Array.isArray(digestValues) && digestValues.length === 20
    && digestValues.every((value) => DIGEST.test(String(value ?? '')))
    && new Set(digestValues).size === 20
    && exact(digestValues, [...digestValues].sort());
  const exactObservationLayers = ['provider', 'server'].every((layer) => (
    exactKeys(observations?.[layer], ['asr', 'text', 'tts'])
    && validateLatencyObservation(observations[layer].text, layer === 'provider' ? 80 : 200)
    && validateLatencyObservation(observations[layer].asr, 30)
    && validateLatencyObservation(observations[layer].tts, 30)
  ));
  const expectedRevision = `${CANDIDATE_SERVICE}-${plan.releaseSha.slice(0, 12)}`;
  const expectedOrigin = plan.candidateOrigin;
  const expectedReleaseBinding = {
    project: PROJECT,
    region: REGION,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    releaseSha: plan.releaseSha,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    imageDigest: plan.imageDigest,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    serviceOrigin: plan.serviceOrigin,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    trafficPercent: candidateTrafficPercent(plan),
    trafficState: candidateTrafficState(plan),
    stableTrafficState: plan.expectedStable.initialTrafficState,
  };
  let derived;
  try { derived = validateRawLatencyReceipts(record, plan); } catch {
    throw new Error('Task 8 workload evidence is invalid');
  }
  if (!exactKeys(record, [
    'access', 'artifactSha256', 'candidateOrigin', 'candidateService', 'commitSha', 'counts',
    'fixtureSetSha256', 'invariants', 'metrics', 'observations', 'occurredAt', 'rawReceipts',
    'releaseBinding', 'result', 'schemaVersion', 'stableService', 'stableTrafficState',
    'trafficState', 'workload',
  ]) || record.schemaVersion !== 5 || record.commitSha !== plan.releaseSha
    || record.candidateOrigin !== plan.candidateOrigin || plan.candidateOrigin !== expectedOrigin
    || record.candidateService !== CANDIDATE_SERVICE || record.stableService !== STABLE_SERVICE
    || record.trafficState !== candidateTrafficState(plan)
    || record.stableTrafficState !== plan.expectedStable.initialTrafficState
    || plan.candidateRevision !== expectedRevision || !IMAGE_DIGEST.test(String(plan.imageDigest ?? ''))
    || !exact(record.access, plan.candidateAccess)
    || !exact(record.releaseBinding, expectedReleaseBinding)
    || !DIGEST.test(String(record.fixtureSetSha256 ?? ''))
    || !exact(record.workload, LATENCY_ACCEPTANCE_CONTRACT)
    || !exact(record.counts, expectedCounts) || !exact(record.invariants, expectedInvariants)
    || !exact(record.counts, derived.counts) || !exact(record.invariants, derived.invariants)
    || !exactKeys(record.metrics, Object.keys(expectedMetrics))
    || !Object.entries(expectedMetrics).every(([key, expected]) => (
      validateLatencyMetric(record.metrics[key], expected)
    ))
    || !exactKeys(observations, ['pairs', 'provider', 'queryDigests', 'releaseCommitSha', 'server'])
    || observations.releaseCommitSha !== plan.releaseSha
    || !exactKeys(queryDigests, ['pass', 'sampleCount', 'values'])
    || queryDigests.sampleCount !== 20 || queryDigests.pass !== true || !exactQueryDigests
    || !exactObservationLayers || !exact(observations.pairs, expectedPairs)
    || !exact(record.metrics, derived.metrics) || !exact(record.observations, derived.observations)
    || record.result !== true || record.result !== derived.result || !recentEvidenceTime(record.occurredAt, now)
    || finalizeLatencyAcceptanceRecord(record).artifactSha256 !== record.artifactSha256) {
    throw new Error('Task 8 workload evidence is invalid');
  }
  return Object.freeze({
    acceptanceWindowId: record.rawReceipts.acceptanceWindowId,
    candidateOrigin: plan.candidateOrigin,
    candidateRevision: plan.candidateRevision,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: candidateTrafficState(plan),
    stableTrafficState: plan.expectedStable.initialTrafficState,
    controlPlaneRequests: record.rawReceipts.controlPlaneRequests,
    expectedTraceIds: record.rawReceipts.textTurns.map(({ traceId }) => traceId),
  });
}

async function readExactJsonArtifact(entry, errorMessage) {
  let metadata;
  let bytes;
  try {
    metadata = await lstat(entry.filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 4 * 1024 * 1024) {
      throw new Error('invalid artifact');
    }
    bytes = await readBoundedOrdinaryFile(entry.filePath, {
      expectedByteLength: metadata.size, maximumBytes: 4 * 1024 * 1024,
    });
  } catch { throw new Error(errorMessage); }
  if (createHash('sha256').update(bytes).digest('hex') !== entry.objectSha256) {
    throw new Error(errorMessage);
  }
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@|"(?:accessToken|access_token|private_key)"\s*:/i.test(raw)) {
    throw new Error(errorMessage);
  }
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error(errorMessage); }
  if (containsForbiddenPersistedSecret(record)) throw new Error(errorMessage);
  if (raw !== `${JSON.stringify(record, null, 2)}\n`) throw new Error(errorMessage);
  return { record, bytes };
}

async function validateBoundFile(value, { json = false, png = false } = {}) {
  if (!exactKeys(value, ['byteLength', 'filePath', 'sha256'])
    || !isAbsoluteFile(value.filePath) || !DIGEST.test(String(value.sha256 ?? ''))
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 8 || value.byteLength > 10 * 1024 * 1024) {
    throw new Error('Mobile evidence bound file is invalid');
  }
  const metadata = await lstat(value.filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== value.byteLength) {
    throw new Error('Mobile evidence bound file is invalid');
  }
  const bytes = await readFile(value.filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== value.sha256
    || (png && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) {
    throw new Error('Mobile evidence bound file is invalid');
  }
  if (!json) return null;
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes)) throw new Error('Mobile evidence trace is invalid');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Mobile evidence trace is invalid'); }
  if (containsForbiddenPersistedSecret(parsed)) throw new Error('Mobile evidence trace is invalid');
  if (raw !== `${JSON.stringify(parsed, null, 2)}\n`) throw new Error('Mobile evidence trace is invalid');
  return parsed;
}

function candidatePrivacyBinding(plan) {
  return Object.freeze({
    projectId: PROJECT,
    projectNumber: plan.projectNumber,
    organizationId: GCP_IDENTITY.organizationId,
    region: REGION,
    releaseSha: plan.releaseSha,
    imageDigest: plan.imageDigest,
    image: plan.expectedCandidate.image,
    candidateService: CANDIDATE_SERVICE,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    acceptanceServiceAccount: ACCEPTANCE_SERVICE_ACCOUNT,
    operator: PROMOTION_AUTHORITY,
    expectedCandidate: plan.expectedCandidate,
  });
}

async function validatePrivacyProofArtifact(
  reference,
  plan,
  now,
  errorMessage,
  validatePrivacyProof = validateCandidatePrivacyProof,
) {
  const { record } = await readExactJsonArtifact(reference, errorMessage);
  if (record?.artifactSha256 !== reference.artifactSha256
    || record?.binding?.boundarySha256 !== reference.boundarySha256
    || record?.occurredAt !== reference.observedAt
    || record?.expiresAt !== reference.expiresAt) throw new Error(errorMessage);
  const verificationClock = typeof now === 'function' ? now() : now;
  try {
    validatePrivacyProof(record, { binding: candidatePrivacyBinding(plan), now: verificationClock });
  } catch {
    throw new Error(errorMessage);
  }
  return record;
}

export async function validateTask8EvidenceArtifact(entry, phase, plan, {
  now,
  gateWindow = null,
  historical = false,
  validatePrivacyProof = validateCandidatePrivacyProof,
}) {
  const errorMessage = `Task 8 ${phase} evidence is invalid`;
  const { record } = await readExactJsonArtifact(entry, errorMessage);
  if (record?.artifactSha256 !== entry.artifactSha256) throw new Error(errorMessage);
  const workloadStartClock = phase === 'workload'
    ? new Date(gateWindow?.gateStartedAt) : null;
  const workloadEndClock = phase === 'workload'
    ? new Date(gateWindow?.gateEndedAt) : null;
  const privacyStart = await validatePrivacyProofArtifact(
    entry.privacyProofs.start,
    plan,
    phase === 'workload' ? workloadStartClock
      : (historical ? new Date(entry.privacyProofs.start.observedAt) : now),
    errorMessage,
    validatePrivacyProof,
  );
  const privacyEnd = await validatePrivacyProofArtifact(
    entry.privacyProofs.end,
    plan,
    phase === 'workload' ? workloadEndClock
      : (historical ? new Date(entry.privacyProofs.end.observedAt) : now),
    errorMessage,
    validatePrivacyProof,
  );
  const validationNow = phase === 'workload' ? workloadEndClock
    : (historical ? new Date(record.occurredAt) : now);
  if (privacyStart.binding.boundarySha256 !== privacyEnd.binding.boundarySha256
    || Date.parse(privacyEnd.occurredAt) <= Date.parse(privacyStart.occurredAt)) {
    throw new Error(errorMessage);
  }
  if (phase === 'workload') {
    try {
      if (!exactKeys(gateWindow, ['gateEndedAt', 'gateStartedAt'])
        || !Number.isFinite(Date.parse(gateWindow.gateStartedAt))
        || !Number.isFinite(Date.parse(gateWindow.gateEndedAt))
        || Date.parse(gateWindow.gateEndedAt) < Date.parse(gateWindow.gateStartedAt)
        || Date.parse(privacyStart.occurredAt) > Date.parse(gateWindow.gateStartedAt)
        || Date.parse(privacyEnd.occurredAt) < Date.parse(gateWindow.gateEndedAt)
        || Date.parse(record.occurredAt) < Date.parse(gateWindow.gateStartedAt)
        || Date.parse(record.occurredAt) > Date.parse(gateWindow.gateEndedAt)) throw new Error(errorMessage);
      return validateLatencyAcceptanceRecord(record, plan, validationNow);
    } catch { throw new Error(errorMessage); }
  }
  if (phase === 'readiness') {
    try {
      validateTask8ReadinessRecord(record, {
        binding: candidatePrivacyBinding(plan),
        sourceArchiveSha256: plan.sourceArchiveSha256,
        now: validationNow,
      });
      if (!exact(record.privacyProofs, entry.privacyProofs)) throw new Error(errorMessage);
      return true;
    } catch {
      throw new Error(errorMessage);
    }
  }
  if (phase !== 'mobile') throw new Error(errorMessage);
  try {
    validateTask8MobileRecord(record, {
      binding: candidatePrivacyBinding(plan),
      sourceArchiveSha256: plan.sourceArchiveSha256,
      boundarySha256: entry.privacyProofs.start.boundarySha256,
      candidateAccess: plan.candidateAccess,
      now: validationNow,
    });
    if (!exact(record.privacyProofs, entry.privacyProofs)) throw new Error(errorMessage);
    for (const screenshot of record.screenshots) {
      const metadata = await lstat(screenshot.filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== screenshot.byteLength) {
        throw new Error(errorMessage);
      }
      const bytes = await readFile(screenshot.filePath);
      const inspected = inspectPngEvidence(bytes);
      if (!exact(inspected, {
        width: screenshot.width,
        height: screenshot.height,
        rawSha256: screenshot.rawSha256,
        pixelSha256: screenshot.pixelSha256,
        colorCount: screenshot.colorCount,
        luminanceSpan: screenshot.luminanceSpan,
        luminanceVariance: screenshot.luminanceVariance,
        dominantRatio: screenshot.dominantRatio,
        nonDominantRatio: screenshot.nonDominantRatio,
        byteLength: screenshot.byteLength,
      })) throw new Error(errorMessage);
    }
  } catch {
    throw new Error(errorMessage);
  }
  return true;
}

function expectedReceiptCompleted(plan, phase) {
  return plan.operations.filter((member) => member.phase === phase).map(({ id }) => id);
}

function expectedEvidenceVersions(plan) {
  return Object.freeze(Object.fromEntries(Object.entries(plan.evidence).map(([key, value]) => [
    key, value.secretVersion,
  ])));
}

function expectedCollectedEvidence(plan) {
  return Object.freeze(Object.fromEntries([
    'dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke',
  ].map((key) => [key, Object.freeze({
    artifactSha256: plan.evidence[key].artifactSha256,
    objectSha256: plan.evidence[key].objectSha256,
  })])));
}

function expectedAcceptanceJobs(plan) {
  return Object.freeze(Object.fromEntries(Object.entries(plan.expectedJobs).map(([key, value]) => [
    key, Object.freeze({ image: value.image, serviceAccount: value.serviceAccount }),
  ])));
}

function validateAcceptanceExecutionOutputs(executions, plan) {
  if (!executions || typeof executions !== 'object' || Array.isArray(executions)
    || !exactKeys(executions, Object.keys(plan.expectedJobs))) return false;
  try {
    for (const [key, expected] of Object.entries(plan.expectedJobs)) {
      const value = executions[key];
      if (!exactKeys(value, [
        'name', 'job', 'taskCount', 'parallelism', 'succeededCount', 'completionTime',
      ]) || value.job !== expected.job || value.taskCount !== expected.taskCount
        || value.parallelism !== expected.parallelism
        || value.succeededCount !== expected.taskCount
        || validateCloudRunExecutionIdentity({
          apiVersion: 'run.googleapis.com/v1',
          kind: 'Execution',
          metadata: {
            name: value.name,
            labels: { 'run.googleapis.com/job': value.job },
          },
        }, { job: expected.job }) !== value.name
        || typeof value.completionTime !== 'string'
        || !Number.isFinite(Date.parse(value.completionTime))) return false;
    }
  } catch { return false; }
  return true;
}

function validateReceiptOutputs(phase, outputs, plan, { candidatePrivacyReference = null } = {}) {
  const expectedLabels = {
    'com.simplify.build-config-sha256': plan.buildConfigSha256,
    'com.simplify.source-archive-sha256': plan.sourceArchiveSha256,
    'org.opencontainers.image.revision': plan.releaseSha,
    'org.opencontainers.image.source': OCI_SOURCE,
  };
  if (phase === 'build') {
    if (!exactKeys(outputs, [
      'buildConfigSha256', 'buildId', 'buildReceiptSha256', 'imageDigest',
      'ociLabels', 'sourceArchiveSha256', 'sourceProvenance',
    ])
      || outputs.buildConfigSha256 !== plan.buildConfigSha256
      || !BUILD_ID.test(String(outputs.buildId ?? ''))
      || !DIGEST.test(String(outputs.buildReceiptSha256 ?? ''))
      || !IMAGE_DIGEST.test(String(outputs.imageDigest ?? ''))
      || (plan.imageDigest !== null && outputs.imageDigest !== plan.imageDigest)
      || outputs.sourceArchiveSha256 !== plan.sourceArchiveSha256
      || !exact(outputs.ociLabels, expectedLabels)
      || !exactKeys(outputs.sourceProvenance, ['sha256', 'uri'])
      || outputs.sourceProvenance.sha256 !== plan.sourceArchiveSha256
      || !new RegExp(`^gs://${GCP_IDENTITY.buildSourceBucket}/${BUILD_SOURCE_PREFIX}[^#]+#[1-9]\\d*$`)
        .test(String(outputs.sourceProvenance.uri ?? ''))) {
      throw new Error('Release build receipt outputs are invalid');
    }
  } else if (phase === 'migration') {
    if (!exactKeys(outputs, ['executionName', 'imageDigest', 'job'])
      || outputs.imageDigest !== plan.imageDigest || outputs.job !== MIGRATION_JOB
      || typeof outputs.executionName !== 'string'
      || !new RegExp(`^${MIGRATION_JOB}-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`).test(outputs.executionName)) {
      throw new Error('Release migration receipt outputs are invalid');
    }
  } else if (phase === 'inventory') {
    if (!exact(outputs, { evidenceSecretVersions: { legacyInventory: plan.evidence.legacyInventory.secretVersion } })) {
      throw new Error('Release inventory receipt outputs are invalid');
    }
  } else if (phase === 'acceptance') {
    if (!exactKeys(outputs, ['jobs', 'executions'])
      || !exact(outputs.jobs, expectedAcceptanceJobs(plan))
      || !validateAcceptanceExecutionOutputs(outputs.executions, plan)) {
      throw new Error('Release acceptance receipt outputs are invalid');
    }
  } else if (phase === 'collect') {
    const unresolved = ['dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke']
      .every((key) => plan.evidence[key].artifactSha256 === '0'.repeat(64)
        && plan.evidence[key].objectSha256 === '0'.repeat(64));
    const validUnresolved = unresolved
      && exactKeys(outputs, ['evidence'])
      && exactKeys(outputs.evidence, ['dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke'])
      && Object.values(outputs.evidence).every((entry) => (
        exactKeys(entry, ['artifactSha256', 'objectSha256'])
        && DIGEST.test(String(entry.artifactSha256 ?? ''))
        && DIGEST.test(String(entry.objectSha256 ?? ''))
      ));
    if (!validUnresolved && !exact(outputs, { evidence: expectedCollectedEvidence(plan) })) {
      throw new Error('Release collect receipt outputs are invalid');
    }
  } else if (phase === 'evidence') {
    if (!exact(outputs, { evidenceSecretVersions: expectedEvidenceVersions(plan), outputResidueCount: 0 })) {
      throw new Error('Release evidence receipt outputs are invalid');
    }
  } else if (phase === 'candidate') {
    let privacyProof;
    try { privacyProof = assertPrivacyProofReference(outputs?.privacyProof); } catch {
      throw new Error('Release candidate receipt outputs are invalid');
    }
    let expectedPrivacyProof;
    try { expectedPrivacyProof = assertPrivacyProofReference(candidatePrivacyReference); } catch {
      throw new Error('Release candidate receipt authority is invalid');
    }
    if (!exactKeys(outputs, [
      'access', 'candidateContractSha256', 'candidateService', 'imageDigest', 'origin',
      'privacyProof', 'privacyProofReferenceSha256', 'publicInvoker', 'priorRelease', 'revision', 'stableService', 'stableTrafficState',
      'tag', 'trafficPercent', 'trafficState',
    ])
      || !exact(outputs.access, plan.candidateAccess)
      || outputs.candidateContractSha256 !== canonicalSha256(plan.expectedCandidate)
      || outputs.privacyProofReferenceSha256 !== canonicalSha256(privacyProof)
      || outputs.candidateService !== CANDIDATE_SERVICE || outputs.stableService !== STABLE_SERVICE
      || outputs.stableTrafficState !== plan.expectedStable.initialTrafficState
      || outputs.imageDigest !== plan.imageDigest || outputs.origin !== plan.candidateOrigin
      || outputs.revision !== plan.candidateRevision || outputs.tag !== plan.candidateTag
      || outputs.trafficPercent !== candidateTrafficPercent(plan)
      || outputs.trafficState !== candidateTrafficState(plan)
      || outputs.publicInvoker !== false
      || !exact(privacyProof, expectedPrivacyProof)
      || !exact(outputs.priorRelease, plan.previousRevision === null ? null : {
        image: plan.previousImage,
        imageDigest: plan.previousImageDigest,
        revision: plan.previousRevision,
      })) {
      throw new Error('Release candidate receipt outputs are invalid');
    }
  } else if (['readiness', 'workload', 'mobile'].includes(phase)) {
    const expected = plan.task8Evidence[phase];
    const baseKeys = [
      'artifactSha256', 'candidateOrigin', 'candidateRevision', 'candidateService', 'imageDigest',
      'objectSha256', 'privacyProofs', 'stableService', 'stableTrafficState', 'trafficState',
    ];
    const expectedKeys = phase === 'mobile' ? [...baseKeys, 'access', 'viewport']
      : phase === 'workload' ? [...baseKeys, 'execution'] : baseKeys;
    const unresolvedWorkload = phase === 'workload'
      && expected.artifactSha256 === '0'.repeat(64)
      && expected.objectSha256 === '0'.repeat(64);
    if (!exactKeys(outputs, expectedKeys)
      || (!unresolvedWorkload && outputs.artifactSha256 !== expected.artifactSha256)
      || (!unresolvedWorkload && outputs.objectSha256 !== expected.objectSha256)
      || !DIGEST.test(String(outputs.artifactSha256 ?? ''))
      || !DIGEST.test(String(outputs.objectSha256 ?? ''))
      || (unresolvedWorkload && (outputs.artifactSha256 === '0'.repeat(64)
        || outputs.objectSha256 === '0'.repeat(64)))
      || outputs.candidateOrigin !== plan.candidateOrigin
      || outputs.candidateRevision !== plan.candidateRevision
      || outputs.candidateService !== CANDIDATE_SERVICE || outputs.stableService !== STABLE_SERVICE
      || outputs.trafficState !== candidateTrafficState(plan)
      || outputs.stableTrafficState !== plan.expectedStable.initialTrafficState
      || !exact(outputs.privacyProofs, expected.privacyProofs)
      || outputs.imageDigest !== plan.imageDigest
      || (phase === 'workload' && (!exactKeys(outputs.execution, [
        'acceptanceWindowId', 'attemptId', 'gateEndedAt', 'gateStartedAt',
        'networkWitnessSha256', 'observedRequestCount',
      ])
        || !DIGEST.test(String(outputs.execution.acceptanceWindowId ?? ''))
        || !UUID.test(String(outputs.execution.attemptId ?? ''))
        || !Number.isFinite(Date.parse(outputs.execution.gateStartedAt))
        || !Number.isFinite(Date.parse(outputs.execution.gateEndedAt))
        || Date.parse(outputs.execution.gateEndedAt) < Date.parse(outputs.execution.gateStartedAt)
        || Date.parse(expected.privacyProofs.start.observedAt) > Date.parse(outputs.execution.gateStartedAt)
        || Date.parse(expected.privacyProofs.end.observedAt) < Date.parse(outputs.execution.gateEndedAt)
        || !DIGEST.test(String(outputs.execution.networkWitnessSha256 ?? ''))
        || !Number.isSafeInteger(outputs.execution.observedRequestCount)
        || outputs.execution.observedRequestCount < 500
        || outputs.execution.observedRequestCount > MAX_CONTROLLED_WORKLOAD_REQUESTS))
      || (phase === 'mobile' && !exact(outputs.access, plan.candidateAccess))
      || (phase === 'mobile' && !exact(outputs.viewport, { width: 390, height: 844 }))) {
      throw new Error('Task 8 release receipt outputs are invalid');
    }
  } else throw new Error('Release receipt phase is invalid');
  return true;
}

function candidatePrivacyAuthority(reference, candidateReceiptSha256) {
  return Object.freeze({
    privacyProof: assertPrivacyProofReference(reference),
    candidateReceiptSha256,
  });
}

export function candidatePrivacyAuthorityFromJournal(records, receipt, plan) {
  if (!Array.isArray(records) || !DIGEST.test(String(receipt?.receiptSha256 ?? ''))) {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  const terminals = records.filter((record) => record.phase === 'candidate'
    && record.recordType === 'terminal'
    && record.payload?.receiptSha256 === receipt.receiptSha256);
  if (terminals.length !== 1) throw new Error('Candidate privacy receipt authority is invalid');
  const terminal = terminals[0];
  const attemptRecords = records.filter(({ attemptId }) => attemptId === terminal.attemptId);
  const intents = attemptRecords.filter((record) => record.recordType === 'intent'
    && record.operationId === 'candidate-privacy-publish');
  if (intents.length !== 1) throw new Error('Candidate privacy receipt authority is invalid');
  const intent = intents[0];
  const checkpoints = attemptRecords.filter((record) => record.recordType === 'checkpoint'
    && record.operationId === 'candidate-privacy-publish'
    && record.payload?.intentRecordSha256 === intent.recordSha256);
  const artifacts = intent.payload?.publication?.artifacts;
  if (checkpoints.length !== 1 || !Array.isArray(artifacts) || artifacts.length !== 1
    || artifacts[0]?.role !== 'privacy-proof'
    || artifacts[0]?.filePath !== plan.candidatePrivacyProofPath) {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  const bytes = Buffer.from(String(artifacts[0].contentsBase64 ?? ''), 'base64');
  if (bytes.toString('base64') !== artifacts[0].contentsBase64
    || bytes.length !== artifacts[0].byteLength
    || createHash('sha256').update(bytes).digest('hex') !== artifacts[0].objectSha256) {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  let proof;
  try { proof = JSON.parse(bytes.toString('utf8')); } catch {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  if (proof?.schemaVersion !== CANDIDATE_PRIVACY_SCHEMA_VERSION) {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  const historicalClock = new Date(proof.occurredAt);
  if (!Number.isFinite(historicalClock.getTime())) {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  try {
    validateCandidatePrivacyProof(proof, {
      binding: candidatePrivacyBinding(plan),
      now: historicalClock,
    });
  } catch {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  const reference = {
    schemaVersion: proof.schemaVersion,
    filePath: artifacts[0].filePath,
    artifactSha256: proof.artifactSha256,
    objectSha256: artifacts[0].objectSha256,
    boundarySha256: proof.binding?.boundarySha256,
    observedAt: proof.occurredAt,
    expiresAt: proof.expiresAt,
  };
  if (reference.boundarySha256 !== candidatePrivacyBoundarySha256(candidatePrivacyBinding(plan))) {
    throw new Error('Candidate privacy receipt authority is invalid');
  }
  return candidatePrivacyAuthority(reference, receipt.receiptSha256);
}

export function validateReleaseReceiptChain(value, plan, {
  through = 'mobile',
  candidatePrivacyAnchor = receiptChainAuthorities.get(value)
    ?? value?.candidatePrivacyAnchor ?? null,
} = {}) {
  const lastIndex = RECEIPT_PHASES.indexOf(through);
  if (!plan || lastIndex < 0 || !Array.isArray(value) || value.length !== lastIndex + 1) {
    throw new Error('Release receipt chain is invalid');
  }
  const candidateIndex = RECEIPT_PHASES.indexOf('candidate');
  let authority = null;
  if (lastIndex >= candidateIndex) {
    if (!exactKeys(candidatePrivacyAnchor, ['candidateReceiptSha256', 'privacyProof'])
      || !DIGEST.test(String(candidatePrivacyAnchor.candidateReceiptSha256 ?? ''))) {
      throw new Error('Candidate privacy receipt authority is invalid');
    }
    authority = candidatePrivacyAuthority(
      candidatePrivacyAnchor.privacyProof,
      candidatePrivacyAnchor.candidateReceiptSha256,
    );
  }
  let previousReceiptSha256 = null;
  for (let index = 0; index <= lastIndex; index += 1) {
    const receipt = value[index];
    const phase = RECEIPT_PHASES[index];
    if (!exactKeys(receipt, [
      'candidateService', 'completed', 'outputs', 'phase', 'previousReceiptSha256',
      'phaseIdentitySha256', 'receiptSha256', 'releaseIdentitySha256', 'releaseSha',
      'schemaVersion', 'sequence',
      'stableService', 'stableTrafficState', 'trafficState',
    ])
      || receipt.schemaVersion !== 2 || receipt.phase !== phase || receipt.sequence !== index + 1
      || receipt.releaseSha !== plan.releaseSha
      || receipt.candidateService !== CANDIDATE_SERVICE || receipt.stableService !== STABLE_SERVICE
      || receipt.trafficState !== candidateTrafficState(plan)
      || receipt.stableTrafficState !== plan.expectedStable.initialTrafficState
      || receipt.releaseIdentitySha256 !== plan.releaseIdentitySha256
      || receipt.phaseIdentitySha256 !== releasePhaseIdentitySha256(plan, phase)
      || receipt.previousReceiptSha256 !== previousReceiptSha256
      || !exact(receipt.completed, expectedReceiptCompleted(plan, phase))
      || finalizeReleasePhaseReceipt(receipt).receiptSha256 !== receipt.receiptSha256) {
      throw new Error('Release receipt chain is invalid');
    }
    validateReceiptOutputs(phase, receipt.outputs, plan, {
      candidatePrivacyReference: authority?.privacyProof ?? null,
    });
    if (phase === 'candidate' && receipt.receiptSha256 !== authority.candidateReceiptSha256) {
      throw new Error('Candidate privacy receipt authority is invalid');
    }
    previousReceiptSha256 = receipt.receiptSha256;
  }
  return true;
}

async function loadReleaseReceiptFiles(plan, { through }) {
  const lastIndex = RECEIPT_PHASES.indexOf(through);
  if (lastIndex < 0) throw new Error('Release receipt chain is invalid');
  const receipts = [];
  for (let index = 0; index <= lastIndex; index += 1) {
    const phase = RECEIPT_PHASES[index];
    const filePath = plan.releaseReceiptPaths[phase];
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 1024 * 1024) {
      throw new Error('Release receipt chain is invalid');
    }
    const bytes = await readBoundedOrdinaryFile(filePath, {
      expectedByteLength: metadata.size, maximumBytes: 1024 * 1024,
    });
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) throw new Error('Release receipt chain is invalid');
    const receipt = JSON.parse(raw);
    if (raw !== `${JSON.stringify(receipt, null, 2)}\n`) throw new Error('Release receipt chain is invalid');
    receipts.push(receipt);
  }
  if (lastIndex >= RECEIPT_PHASES.indexOf('candidate')) {
    const candidateReceipt = receipts.find(({ phase }) => phase === 'candidate');
    const records = await readReleaseJournalRecords(plan.releaseReceiptDirectory);
    const authority = candidatePrivacyAuthorityFromJournal(records, candidateReceipt, plan);
    receiptChainAuthorities.set(receipts, authority);
    Object.defineProperty(receipts, 'candidatePrivacyAnchor', {
      value: authority, enumerable: true, configurable: false, writable: false,
    });
  }
  validateReleaseReceiptChain(receipts, plan, { through });
  return receipts;
}

function releaseActionReceiptOutputs(phase, plan) {
  if (phase === 'candidate-cleanup') return Object.freeze({
    candidateRevision: plan.candidateRevision,
    candidateService: CANDIDATE_SERVICE,
    imageDigest: plan.imageDigest,
    state: 'candidate-absent',
  });
  if (phase === 'promote') return Object.freeze({
    finalOperationId: plan.previousRevision === null
      ? 'promote-public-service' : 'promote-traffic',
    imageDigest: plan.imageDigest,
    stableRevision: plan.stableRevision,
    stableService: STABLE_SERVICE,
    state: 'stable-public-100',
  });
  if (phase === 'rollback') return Object.freeze({
    finalOperationId: 'rollback-traffic',
    imageDigest: plan.previousImageDigest,
    stableRevision: plan.previousRevision,
    stableService: STABLE_SERVICE,
    state: 'stable-prior-public-100',
  });
  throw new Error('Release action receipt phase is invalid');
}

export function releaseActionReceiptPath(plan, phase, attemptId) {
  if (!ACTION_RECEIPT_PHASES.has(phase)
    || !UUID.test(String(attemptId ?? ''))
    || !isAbsoluteFile(plan?.releaseReceiptDirectory)) {
    throw new Error('Release action receipt path is invalid');
  }
  return join(plan.releaseReceiptDirectory, `action-${phase}-${attemptId.toLowerCase()}.json`);
}

function actionOperationOutcomes(records, attemptId) {
  if (!Array.isArray(records) || !UUID.test(String(attemptId ?? ''))) {
    throw new Error('Release action journal is invalid');
  }
  const outcomes = records.filter((record) => (
    record.attemptId === attemptId && record.recordType === 'checkpoint'
  )).map((record) => Object.freeze({
    operationId: record.operationId,
    outcome: record.payload.outcome,
    observationSha256: record.payload.observationSha256,
    safeResult: structuredClone(record.payload.safeResult),
  }));
  if (outcomes.length < 1) throw new Error('Release action journal is incomplete');
  return Object.freeze(outcomes);
}

function expectedActionReceiptCompleted(plan, phase, stateStore) {
  const operationOutcomes = actionOperationOutcomes(stateStore.records, stateStore.attemptId);
  const verifiedCleanupNoop = phase === 'candidate-cleanup'
    && operationOutcomes.length === 1
    && operationOutcomes[0].operationId === 'candidate-cleanup-delete'
    && operationOutcomes[0].outcome === 'verified-noop'
    && operationOutcomes[0].safeResult?.kind === 'resource'
    && operationOutcomes[0].safeResult?.state === 'absent';
  return verifiedCleanupNoop
    ? ['candidate-cleanup-service-precheck', 'candidate-cleanup-absence-readback']
    : expectedReceiptCompleted(plan, phase);
}

function createReleaseActionReceipt(phase, plan, completed, priorReceipts, stateStore) {
  const expectedCompleted = stateStore && UUID.test(String(stateStore.attemptId ?? ''))
    ? expectedActionReceiptCompleted(plan, phase, stateStore) : null;
  if (!ACTION_RECEIPT_PHASES.has(phase) || !Array.isArray(priorReceipts)
    || !exact(completed, expectedCompleted)
    || !stateStore || !UUID.test(String(stateStore.attemptId ?? ''))
    || stateStore.records?.at(-1)?.recordType !== 'checkpoint') {
    throw new Error('Release action receipt is invalid');
  }
  const operationOutcomes = actionOperationOutcomes(stateStore.records, stateStore.attemptId);
  return finalizeReleasePhaseReceipt({
    schemaVersion: 1,
    receiptType: 'action-outcome',
    phase,
    attemptId: stateStore.attemptId,
    releaseSha: plan.releaseSha,
    releaseIdentitySha256: plan.releaseIdentitySha256,
    semanticReleaseSpecSha256: plan.semanticReleaseSpecSha256,
    receiptHeadSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
    checkpointRecordSha256: stateStore.records.at(-1).recordSha256,
    mutationCount: operationOutcomes.length,
    completed: [...completed],
    operationOutcomes,
    outputs: releaseActionReceiptOutputs(phase, plan),
  });
}

function validateReleaseActionReceipt(receipt, phase, plan, priorReceipts, stateStore) {
  const expected = createReleaseActionReceipt(
    phase, plan, expectedActionReceiptCompleted(plan, phase, stateStore), priorReceipts, stateStore,
  );
  if (!exact(receipt, expected) || containsForbiddenPersistedSecret(receipt)) {
    throw new Error('Release action receipt is invalid');
  }
  return true;
}

async function loadExistingReleasePhaseReceipt(
  plan, phase, priorReceipts = [], actionContext = null,
) {
  const filePath = ACTION_RECEIPT_PHASES.has(phase)
    ? releaseActionReceiptPath(plan, phase, actionContext?.attemptId)
    : plan?.releaseReceiptPaths?.[phase];
  if (!filePath) return null;
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (ACTION_RECEIPT_PHASES.has(phase)) {
    assertReceiptIdempotencyMetadata(await lstat(filePath));
    const metadata = await lstat(filePath);
    const bytes = await readBoundedOrdinaryFile(filePath, {
      expectedByteLength: metadata.size, maximumBytes: 1024 * 1024,
    });
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) throw new Error('Release action receipt is invalid');
    const receipt = JSON.parse(raw);
    if (raw !== `${JSON.stringify(receipt, null, 2)}\n`) {
      throw new Error('Release action receipt is invalid');
    }
    validateReleaseActionReceipt(receipt, phase, plan, priorReceipts, {
      attemptId: actionContext?.attemptId,
      records: actionContext?.records,
    });
    return receipt;
  }
  const receipts = await loadReleaseReceiptFiles(plan, { through: phase });
  return receipts.at(-1);
}

export function assertReceiptIdempotencyMetadata(metadata, expectedByteLength = null) {
  if (!metadata || typeof metadata.isFile !== 'function'
    || typeof metadata.isSymbolicLink !== 'function'
    || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Existing release receipt must be a regular non-symlink file');
  }
  if (expectedByteLength !== null && metadata.size !== expectedByteLength) {
    throw new Error('Existing release receipt has the wrong intended byte length');
  }
  return true;
}

export async function persistReleaseReceipt(plan, receipt, {
  writeCreateOnly = writeAtomicCreateOnly,
  lstatExisting = lstat,
  readExisting = null,
} = {}) {
  const filePath = receipt?.receiptType === 'action-outcome'
    ? releaseActionReceiptPath(plan, receipt.phase, receipt.attemptId)
    : plan.releaseReceiptPaths[receipt.phase];
  if (!filePath) throw new Error('Release receipt path is invalid');
  if (containsForbiddenPersistedSecret(receipt)) {
    throw new Error('Release receipt contains forbidden persisted secret material');
  }
  try { await mkdir(plan.releaseReceiptDirectory); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await writeCreateOnly(filePath, Buffer.from(contents));
  } catch (error) {
    if (!/exists/i.test(String(error?.message ?? ''))) throw error;
    const intended = Buffer.from(contents);
    assertReceiptIdempotencyMetadata(await lstatExisting(filePath), intended.length);
    const existing = readExisting
      ? await readExisting(filePath)
      : await readBoundedOrdinaryFile(filePath, {
        expectedByteLength: intended.length, maximumBytes: 1024 * 1024,
      });
    if (!existing.equals(intended)) throw new Error('Release receipt already exists with different bytes');
  }
  return true;
}

function releasePhaseReceiptOutputs(phase, plan, context) {
  if (phase === 'build') {
    const value = context.buildReceipt;
    return Object.freeze({
      buildConfigSha256: value.buildConfigSha256,
      buildId: value.buildId,
      buildReceiptSha256: value.buildReceiptSha256,
      imageDigest: value.imageDigest,
      sourceArchiveSha256: value.sourceArchiveSha256,
      sourceProvenance: value.sourceProvenance,
      ociLabels: value.ociLabels,
    });
  }
  if (phase === 'migration') return Object.freeze({
    executionName: context.migrationExecutionReceipt.name,
    job: MIGRATION_JOB,
    imageDigest: plan.imageDigest,
  });
  if (phase === 'inventory') return Object.freeze({
    evidenceSecretVersions: Object.freeze({
      legacyInventory: context.evidenceSecretVersions.legacyInventory,
    }),
  });
  if (phase === 'acceptance') return Object.freeze({
    jobs: expectedAcceptanceJobs(plan),
    executions: Object.freeze({ ...context.acceptanceExecutionReceipts }),
  });
  if (phase === 'collect') return Object.freeze({
    evidence: Object.freeze(Object.fromEntries(Object.entries(context.collectedEvidence).map(([key, value]) => [
      key, Object.freeze({ artifactSha256: value.artifactSha256, objectSha256: value.objectSha256 }),
    ]))),
  });
  if (phase === 'evidence') return Object.freeze({
    evidenceSecretVersions: Object.freeze({
      legacyInventory: plan.evidence.legacyInventory.secretVersion,
      ...context.evidenceSecretVersions,
    }),
    outputResidueCount: 0,
  });
  if (phase === 'candidate') return Object.freeze({
    access: plan.candidateAccess,
    candidateContractSha256: canonicalSha256(plan.expectedCandidate),
    candidateService: CANDIDATE_SERVICE,
    imageDigest: plan.imageDigest,
    origin: plan.candidateOrigin,
    privacyProof: assertPrivacyProofReference(context.candidatePrivacyReference),
    privacyProofReferenceSha256: canonicalSha256(
      assertPrivacyProofReference(context.candidatePrivacyReference),
    ),
    publicInvoker: false,
    priorRelease: plan.previousRevision === null ? null : Object.freeze({
      image: plan.previousImage,
      imageDigest: plan.previousImageDigest,
      revision: plan.previousRevision,
    }),
    revision: plan.candidateRevision,
    stableService: STABLE_SERVICE,
    stableTrafficState: plan.expectedStable.initialTrafficState,
    tag: plan.candidateTag,
    trafficPercent: candidateTrafficPercent(plan),
    trafficState: candidateTrafficState(plan),
  });
  if (['readiness', 'workload', 'mobile'].includes(phase)) {
    const evidence = phase === 'workload' && context.workloadExecution
      ? context.workloadExecution.evidence : plan.task8Evidence[phase];
    return Object.freeze({
      artifactSha256: evidence.artifactSha256,
      objectSha256: evidence.objectSha256,
      candidateOrigin: plan.candidateOrigin,
      candidateRevision: plan.candidateRevision,
      candidateService: CANDIDATE_SERVICE,
      imageDigest: plan.imageDigest,
      privacyProofs: plan.task8Evidence[phase].privacyProofs,
      stableService: STABLE_SERVICE,
      stableTrafficState: plan.expectedStable.initialTrafficState,
      trafficState: candidateTrafficState(plan),
      ...(phase === 'workload' ? { execution: context.workloadExecution?.execution } : {}),
      ...(phase === 'mobile' ? {
        access: plan.candidateAccess,
        viewport: Object.freeze({ width: 390, height: 844 }),
      } : {}),
    });
  }
  throw new Error('Release receipt phase is invalid');
}

function createReleasePhaseReceipt(phase, plan, completed, context, priorReceipts) {
  const sequence = RECEIPT_PHASES.indexOf(phase) + 1;
  if (sequence < 1 || priorReceipts.length !== sequence - 1) {
    throw new Error('Release receipt predecessor chain is invalid');
  }
  const receipt = finalizeReleasePhaseReceipt({
    schemaVersion: 2,
    phase,
    sequence,
    releaseSha: plan.releaseSha,
    releaseIdentitySha256: plan.releaseIdentitySha256,
    phaseIdentitySha256: releasePhaseIdentitySha256(plan, phase),
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: candidateTrafficState(plan),
    stableTrafficState: plan.expectedStable.initialTrafficState,
    previousReceiptSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
    completed: Object.freeze([...completed]),
    outputs: releasePhaseReceiptOutputs(phase, plan, context),
  });
  const candidatePrivacyAnchor = phase === 'candidate'
    ? candidatePrivacyAuthority(context.candidatePrivacyReference, receipt.receiptSha256)
    : receiptChainAuthorities.get(priorReceipts) ?? priorReceipts.candidatePrivacyAnchor;
  validateReleaseReceiptChain([...priorReceipts, receipt], plan, {
    through: phase, candidatePrivacyAnchor,
  });
  return receipt;
}

async function assertCollectionDestinationsAbsent(outputs, { permittedExistingKeys = [] } = {}) {
  const permitted = new Set(permittedExistingKeys);
  for (const [key, { filePath }] of Object.entries(outputs)) {
    try {
      const metadata = await lstat(filePath);
      if (permitted.has(key) && metadata.isFile() && !metadata.isSymbolicLink()) continue;
      throw new Error('destination exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Evidence collection destination is not empty');
    }
  }
  return true;
}

function operationMayMutate(id) {
  return id === 'build-submit' || id === 'migration-deploy' || id === 'migration-execute'
    || id.startsWith('inventory-publish:') || id.startsWith('evidence-publish:')
    || id.endsWith('-deploy') || id.endsWith('-execute')
    || id.startsWith('evidence-collect-copy:') || id.startsWith('evidence-output-delete:')
    || id === 'candidate-deploy' || id === 'candidate-private-iam-grant'
    || id === 'candidate-cleanup-delete' || id === 'promote-stable-deploy'
    || id === 'promote-public-service'
    || id === 'promote-traffic' || id === 'rollback-traffic'
    || id === 'candidate-privacy-publish' || id === 'promote-privacy-publish';
}

function journalReconcileKind(id) {
  if (id === 'build-submit') return 'cloud-build-submit';
  if (id === 'candidate-deploy' || id === 'promote-stable-deploy') {
    return 'cloud-run-service-replace';
  }
  if (id === 'candidate-private-iam-grant' || id === 'promote-public-service') {
    return 'cloud-run-service-iam';
  }
  if (id === 'promote-traffic' || id === 'rollback-traffic') return 'cloud-run-traffic';
  if (id === 'candidate-privacy-publish' || id === 'promote-privacy-publish') {
    return 'local-artifact-create';
  }
  if (id === 'candidate-cleanup-delete') return 'cloud-run-service-delete';
  if (id.endsWith('-deploy')) return 'cloud-run-job-replace';
  if (id.endsWith('-execute')) return 'cloud-run-job-execute';
  if (id.startsWith('inventory-publish:') || id.startsWith('evidence-publish:')) {
    return 'secret-version-add';
  }
  if (id.startsWith('evidence-collect-copy:')) return 'gcs-object-write';
  if (id.startsWith('evidence-output-delete:')) return 'gcs-object-delete';
  throw new Error('Release mutation has no reconciliation contract');
}

function mutationRetryPolicy(reconcileKind) {
  return ['cloud-build-submit', 'cloud-run-job-execute', 'secret-version-add']
    .includes(reconcileKind) ? 'never-repeat-without-correlation' : 'retry-exact-before-once';
}

function evidencePublicationContract(value) {
  if (!value || !DIGEST.test(String(value.artifactSha256 ?? ''))
    || !DIGEST.test(String(value.objectSha256 ?? ''))
    || typeof value.secret !== 'string' || !isAbsoluteFile(value.filePath)) {
    throw new Error('Evidence publication contract is invalid');
  }
  return Object.freeze({
    artifactSha256: value.artifactSha256,
    filePath: value.filePath,
    objectSha256: value.objectSha256,
    secret: value.secret,
  });
}

function mutationSpec(plan, operationId) {
  if (operationId === 'build-submit') return Object.freeze({
    buildConfigSha256: plan.buildConfigSha256,
    image: `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}:${plan.releaseSha}`,
    project: PROJECT,
    region: REGION,
    releaseSha: plan.releaseSha,
    sourceArchiveSha256: plan.sourceArchiveSha256,
  });
  if (operationId === 'migration-deploy') return plan.expectedMigrationJob;
  if (operationId === 'migration-execute') return Object.freeze({
    job: MIGRATION_JOB, releaseSha: plan.releaseSha, terminalStatus: 'SUCCEEDED',
  });
  if (operationId.endsWith('-deploy')
    && !['candidate-deploy', 'promote-stable-deploy'].includes(operationId)) {
    return plan.expectedJobs[operationId.slice(0, -'-deploy'.length)];
  }
  if (operationId.endsWith('-execute')) {
    const key = operationId.slice(0, -'-execute'.length);
    return Object.freeze({
      job: plan.expectedJobs[key]?.job,
      releaseSha: plan.releaseSha,
      terminalStatus: 'SUCCEEDED',
    });
  }
  if (operationId.startsWith('inventory-publish:')
    || operationId.startsWith('evidence-publish:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    return evidencePublicationContract(plan.evidence[key]);
  }
  if (operationId.startsWith('evidence-collect-copy:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    return Object.freeze({ object: plan.acceptanceOutputs[key] });
  }
  if (operationId.startsWith('evidence-output-delete:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    return Object.freeze({
      evidence: plan.evidence[key],
      object: plan.acceptanceOutputs[key],
    });
  }
  if (operationId === 'candidate-deploy') return Object.freeze({
    candidate: plan.expectedCandidate,
    serviceSpecSha256: canonicalSha256(plan.candidateServiceSpec),
  });
  if (operationId === 'candidate-private-iam-grant') return Object.freeze({
    member: `serviceAccount:${ACCEPTANCE_SERVICE_ACCOUNT}`,
    policy: 'candidate-private',
    role: CANDIDATE_INVOKER_ROLE,
    service: CANDIDATE_SERVICE,
  });
  if (operationId === 'candidate-privacy-publish'
    || operationId === 'promote-privacy-publish') return Object.freeze({
    boundarySha256: candidatePrivacyBoundarySha256(candidatePrivacyBinding(plan)),
    filePath: operationId === 'candidate-privacy-publish'
      ? plan.candidatePrivacyProofPath : plan.promotionPrivacyProofPath,
    proofType: operationId === 'candidate-privacy-publish' ? 'candidate' : 'promotion',
  });
  if (operationId === 'candidate-cleanup-delete') return Object.freeze({
    candidateRevision: plan.candidateRevision,
    image: plan.image,
    service: CANDIDATE_SERVICE,
  });
  if (operationId === 'promote-stable-deploy') return Object.freeze({
    service: STABLE_SERVICE,
    serviceSpecSha256: canonicalSha256(plan.stableServiceSpec),
    stableRevision: plan.stableRevision,
  });
  if (operationId === 'promote-public-service') return Object.freeze({
    member: 'allUsers', policy: 'stable-public', role: 'roles/run.invoker',
    service: STABLE_SERVICE,
  });
  if (operationId === 'promote-traffic') return Object.freeze({
    percent: 100, revision: plan.stableRevision, service: STABLE_SERVICE,
  });
  if (operationId === 'rollback-traffic') return Object.freeze({
    percent: 100, revision: plan.previousRevision, service: STABLE_SERVICE,
  });
  throw new Error('Release mutation has no semantic specification');
}

function plannedMutationAfterObservation(plan, operationId) {
  if (operationId === 'build-submit') return Object.freeze({
    buildConfigSha256: plan.buildConfigSha256,
    image: `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}:${plan.releaseSha}`,
    kind: 'cloud-build',
    ociLabels: Object.freeze({
      'com.simplify.build-config-sha256': plan.buildConfigSha256,
      'com.simplify.source-archive-sha256': plan.sourceArchiveSha256,
      'org.opencontainers.image.revision': plan.releaseSha,
      'org.opencontainers.image.source': OCI_SOURCE,
    }),
    provenance: 'VERIFIED',
    releaseSha: plan.releaseSha,
    sourceArchiveSha256: plan.sourceArchiveSha256,
  });
  if (operationId === 'migration-deploy'
    || (operationId.endsWith('-deploy')
      && !['candidate-deploy', 'promote-stable-deploy'].includes(operationId))) {
    const expected = operationId === 'migration-deploy' ? plan.expectedMigrationJob
      : plan.expectedJobs[operationId.slice(0, -'-deploy'.length)];
    return Object.freeze({ job: expected, kind: 'cloud-run-job' });
  }
  if (operationId === 'migration-execute' || operationId.endsWith('-execute')) {
    const expected = operationId === 'migration-execute' ? plan.expectedMigrationJob
      : plan.expectedJobs[operationId.slice(0, -'-execute'.length)];
    return Object.freeze({
      job: expected.job,
      kind: 'cloud-run-job-execution',
      parallelism: expected.parallelism,
      status: 'SUCCEEDED',
      taskCount: expected.taskCount,
    });
  }
  if (operationId.startsWith('inventory-publish:')
    || operationId.startsWith('evidence-publish:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    const expected = evidencePublicationContract(plan.evidence[key]);
    return Object.freeze({
      artifactSha256: expected.artifactSha256,
      kind: 'secret-version-assignment',
      name: `projects/${PROJECT}/secrets/${expected.secret}`,
      objectSha256: expected.objectSha256,
      state: 'ENABLED',
      versionPolicy: 'server-assigned-numeric',
    });
  }
  if (operationId.startsWith('evidence-collect-copy:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    const expected = plan.acceptanceOutputs[key];
    return Object.freeze({
      bucket: expected.bucket,
      destination: expected.filePath,
      generation: expected.generation,
      kind: 'gcs-object-copy',
      object: expected.object,
    });
  }
  if (operationId.startsWith('evidence-output-delete:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    const expected = plan.acceptanceOutputs[key];
    return Object.freeze({
      bucket: expected.bucket,
      generation: expected.generation,
      kind: 'gcs-object-absence',
      object: expected.object,
      state: 'absent',
    });
  }
  if (operationId === 'candidate-deploy') return Object.freeze({
    artifact: plan.image,
    kind: 'cloud-run-service',
    revision: candidateRevisionContract(plan.expectedCandidate),
    service: Object.freeze({
      invokerIamDisabled: false,
      serviceMaxScale: plan.expectedCandidate.maxInstances,
      service: CANDIDATE_SERVICE,
      traffic: plan.expectedCandidate.traffic,
    }),
  });
  if (operationId === 'promote-stable-deploy') return Object.freeze({
    artifact: plan.image,
    kind: 'cloud-run-service',
    revision: candidateRevisionContract(plan.expectedStable),
    service: Object.freeze({
      invokerIamDisabled: false,
      serviceMaxScale: plan.expectedStable.maxInstances,
      service: STABLE_SERVICE,
      traffic: plan.expectedStable.stagedTraffic,
    }),
  });
  if (operationId === 'candidate-private-iam-grant') return Object.freeze({
    bindings: Object.freeze([Object.freeze({
      members: Object.freeze([`serviceAccount:${ACCEPTANCE_SERVICE_ACCOUNT}`]),
      role: CANDIDATE_INVOKER_ROLE,
    })]),
    kind: 'cloud-run-service-iam',
    service: CANDIDATE_SERVICE,
  });
  if (operationId === 'candidate-privacy-publish'
    || operationId === 'promote-privacy-publish') return Object.freeze({
    kind: 'local-privacy-proof',
    ...mutationSpec(plan, operationId),
  });
  if (operationId === 'promote-public-service') return Object.freeze({
    bindings: Object.freeze([Object.freeze({
      members: Object.freeze(['allUsers']), role: 'roles/run.invoker',
    })]),
    kind: 'cloud-run-service-iam',
    service: STABLE_SERVICE,
  });
  if (operationId === 'candidate-cleanup-delete') return Object.freeze({
    kind: 'cloud-run-service-absence', service: CANDIDATE_SERVICE, state: 'absent',
  });
  if (operationId === 'candidate-privacy-publish'
    || operationId === 'promote-privacy-publish') {
    if (!exact(observed, expected)) throw new Error('Local privacy proof observation differs from plan');
    return expected;
  }
  if (operationId === 'promote-traffic' || operationId === 'rollback-traffic') {
    const revision = operationId === 'promote-traffic'
      ? plan.stableRevision : plan.previousRevision;
    return Object.freeze({
      kind: 'cloud-run-service-traffic',
      service: STABLE_SERVICE,
      traffic: Object.freeze([Object.freeze({ revision, tag: null, percent: 100 })]),
    });
  }
  throw new Error('Release mutation has no planned after observation');
}

function canonicalMutationAfterObservation(plan, operationId, observed) {
  const expected = plannedMutationAfterObservation(plan, operationId);
  if (observed === undefined) throw new Error('Authoritative mutation read-after is unavailable');
  if (operationId === 'build-submit') {
    const receipt = validateBuildReceipt(observed, {
      releaseSha: plan.releaseSha,
      sourceArchiveSha256: plan.sourceArchiveSha256,
      buildConfigSha256: plan.buildConfigSha256,
    });
    const actual = Object.freeze({
      buildConfigSha256: receipt.buildConfigSha256,
      image: `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}:${receipt.releaseSha}`,
      kind: 'cloud-build',
      ociLabels: receipt.ociLabels,
      provenance: receipt.provenance,
      releaseSha: receipt.releaseSha,
      sourceArchiveSha256: receipt.sourceArchiveSha256,
    });
    if (!exact(actual, expected)) throw new Error('Cloud Build after observation differs from plan');
    return actual;
  }
  if (operationId === 'migration-deploy'
    || (operationId.endsWith('-deploy')
      && !['candidate-deploy', 'promote-stable-deploy'].includes(operationId))) {
    const job = operationId === 'migration-deploy' ? plan.expectedMigrationJob
      : plan.expectedJobs[operationId.slice(0, -'-deploy'.length)];
    // Safe-result identity intentionally excludes SDK-managed observation-only fields such as
    // metadata.resourceVersion, status.executionCount, and status.latestCreatedExecution. The
    // normalized Job recipe below still binds every image, identity, secret, network, and limit.
    validateReadyReleaseJobReadback(observed, job);
    const actual = Object.freeze({
      job: exact(observed, job) ? observed : normalizeV1JobReadback(observed),
      kind: 'cloud-run-job',
    });
    if (!exact(actual, expected)) throw new Error('Cloud Run Job after observation differs from plan');
    return actual;
  }
  if (operationId === 'migration-execute' || operationId.endsWith('-execute')) {
    const job = operationId === 'migration-execute' ? plan.expectedMigrationJob
      : plan.expectedJobs[operationId.slice(0, -'-execute'.length)];
    const receipt = operationId === 'migration-execute'
      ? validateMigrationExecutionReceipt(observed, { releaseSha: plan.releaseSha })
      : validateReleaseJobExecutionReceipt(observed, job);
    const actual = Object.freeze({
      job: receipt.job,
      kind: 'cloud-run-job-execution',
      parallelism: receipt.parallelism,
      status: 'SUCCEEDED',
      taskCount: receipt.taskCount,
    });
    if (!exact(actual, expected)) throw new Error('Cloud Run execution after observation differs from plan');
    return actual;
  }
  if (operationId.startsWith('inventory-publish:')
    || operationId.startsWith('evidence-publish:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    const version = evidencePublicationContract(plan.evidence[key]);
    const metadata = normalizeEvidenceVersionReceipt(observed?.metadata, {
      secret: version.secret,
    });
    const payload = observed?.payload;
    if (!exactKeys(payload, ['artifactSha256', 'byteLength', 'objectSha256'])
      || payload.artifactSha256 !== version.artifactSha256
      || payload.objectSha256 !== version.objectSha256
      || !Number.isSafeInteger(payload.byteLength) || payload.byteLength < 2
      || payload.byteLength > 1024 * 1024) {
      throw new Error('Secret payload after observation differs from plan');
    }
    const actual = Object.freeze({
      artifactSha256: version.artifactSha256,
      kind: 'secret-version-assignment',
      name: `projects/${PROJECT}/secrets/${version.secret}`,
      objectSha256: version.objectSha256, state: metadata.state,
      versionPolicy: 'server-assigned-numeric',
    });
    if (!exact(actual, expected)) throw new Error('Secret version after observation differs from plan');
    return actual;
  }
  if (operationId.startsWith('evidence-collect-copy:')) {
    const source = observed?.source;
    const collected = observed?.collected;
    const key = operationId.slice(operationId.indexOf(':') + 1);
    const output = plan.acceptanceOutputs[key];
    if (!source || source.bucket !== output.bucket || source.object !== output.object
      || source.generation !== output.generation || !Number.isSafeInteger(source.size)
      || source.size < 2 || !collected || collected.byteLength !== source.size
      || !DIGEST.test(String(collected.artifactSha256 ?? ''))
      || !DIGEST.test(String(collected.objectSha256 ?? ''))) {
      throw new Error('Collected object after observation is invalid');
    }
    return expected;
  }
  if (operationId.startsWith('evidence-output-delete:')) {
    if (!Array.isArray(observed) || observed.length !== 0) {
      throw new Error('Deleted object after observation is invalid');
    }
    return expected;
  }
  if (operationId === 'candidate-deploy' || operationId === 'promote-stable-deploy') {
    const serviceExpected = operationId === 'candidate-deploy'
      ? plan.expectedCandidate : plan.expectedStable;
    const service = normalizeCandidateService(observed?.service);
    // Service metadata.resourceVersion is server-managed; semantic service identity remains the
    // exact invoker-IAM and max-scale annotations plus traffic, paired with revision and image truth.
    if (operationId === 'candidate-deploy') validateCandidateService(observed?.service, serviceExpected);
    else validateStableStagedService(observed?.service, plan);
    const revision = normalizeCandidateRevision(observed?.revision, serviceExpected);
    if (!exact(revision, candidateRevisionContract(serviceExpected))) {
      throw new Error('Cloud Run revision after observation differs from plan');
    }
    validateCandidateArtifact(observed?.artifact, plan.image);
    const actual = Object.freeze({
      artifact: plan.image,
      kind: 'cloud-run-service',
      revision,
      service,
    });
    if (!exact(actual, expected)) throw new Error('Cloud Run Service after observation differs from plan');
    return actual;
  }
  if (operationId === 'candidate-private-iam-grant'
    || operationId === 'promote-public-service') {
    const policy = operationId === 'candidate-private-iam-grant'
      ? 'candidate-private' : 'stable-public';
    validateServiceIamReceipt(observed, { policy, requireEtag: true });
    const normalized = normalizeServiceIamPolicy(observed, { requireEtag: true });
    const actual = Object.freeze({
      bindings: normalized.bindings,
      kind: 'cloud-run-service-iam',
      service: operationId === 'candidate-private-iam-grant'
        ? CANDIDATE_SERVICE : STABLE_SERVICE,
    });
    if (!exact(actual, expected)) throw new Error('Cloud Run IAM after observation differs from plan');
    return actual;
  }
  if (operationId === 'candidate-cleanup-delete') {
    if (!(observed === null || exact(observed, { state: 'absent' }))) {
      throw new Error('Cloud Run deletion after observation is invalid');
    }
    return expected;
  }
  if (operationId === 'promote-traffic' || operationId === 'rollback-traffic') {
    const revision = operationId === 'promote-traffic'
      ? plan.stableRevision : plan.previousRevision;
    validateTrafficReceipt(observed, { revision });
    const normalized = normalizeCandidateService(observed);
    const actual = Object.freeze({
      kind: 'cloud-run-service-traffic', service: normalized.service, traffic: normalized.traffic,
    });
    if (!exact(actual, expected)) throw new Error('Cloud Run traffic after observation differs from plan');
    return actual;
  }
  throw new Error('Release mutation has no authoritative after observation');
}

function receiptPhaseSemanticSpec(plan, phase) {
  if (phase === 'build') return mutationSpec(plan, 'build-submit');
  if (phase === 'migration') return plan.expectedMigrationJob;
  if (phase === 'inventory') return plan.evidence.legacyInventory;
  if (phase === 'acceptance') return plan.expectedJobs;
  if (phase === 'collect') return plan.acceptanceOutputs;
  if (phase === 'evidence') return Object.freeze({
    acceptanceOutputs: plan.acceptanceOutputs,
    evidence: plan.evidence,
  });
  if (phase === 'candidate') return Object.freeze({
    candidate: plan.expectedCandidate,
    serviceSpecSha256: canonicalSha256(plan.candidateServiceSpec),
  });
  if (['readiness', 'workload', 'mobile'].includes(phase)) {
    const evidence = plan.task8Evidence[phase];
    return Object.freeze({
      candidateOrigin: plan.candidateOrigin,
      candidateRevision: plan.candidateRevision,
      candidateService: CANDIDATE_SERVICE,
      evidenceContract: Object.freeze({
        filePath: evidence.filePath,
        privacyProofs: evidence.privacyProofs,
        schemaVersion: evidence.schemaVersion,
        stableService: evidence.stableService,
        stableTrafficState: evidence.stableTrafficState,
        trafficState: evidence.trafficState,
      }),
      imageDigest: plan.imageDigest,
      stableService: STABLE_SERVICE,
    });
  }
  throw new Error('Release receipt phase semantic specification is invalid');
}

export function releasePhaseIdentitySha256(plan, phase) {
  if (!plan || !RECEIPT_PHASES.includes(phase)) {
    throw new Error('Release receipt phase identity is invalid');
  }
  const operations = plan.operations.filter((member) => member.phase === phase);
  return canonicalSha256({
    releaseIdentitySha256: plan.releaseIdentitySha256,
    phase,
    operations: operations.map(({ id, argv }) => ({ id, argv })),
    mutationContracts: operations.filter(({ id }) => operationMayMutate(id))
      .map((member) => releaseMutationPlanIdentity(plan, member)),
    semanticSpec: receiptPhaseSemanticSpec(plan, phase),
  });
}

function mutationStateProjection(plan, operationId, state) {
  const spec = mutationSpec(plan, operationId);
  const specSha256 = canonicalSha256(spec);
  const reconcileKind = journalReconcileKind(operationId);
  const identity = Object.freeze({
    operationId,
    project: PROJECT,
    region: REGION,
    resourceSha256: canonicalSha256({ operationId, spec }),
  });
  if (state === 'before') return Object.freeze({
    identity,
    reconcileKind,
    state: mutationRetryPolicy(reconcileKind) === 'never-repeat-without-correlation'
      ? 'unattempted-without-authoritative-correlation' : 'authoritative-before',
  });
  return Object.freeze({
    identity,
    observation: plannedMutationAfterObservation(plan, operationId),
    reconcileKind,
    specSha256,
    state: operationId === 'candidate-cleanup-delete'
      || operationId.startsWith('evidence-output-delete:') ? 'absent' : 'applied',
  });
}

export function releaseMutationPlanIdentity(plan, member) {
  if (!plan || !member || !operationMayMutate(member.id)) {
    throw new Error('Release mutation plan identity is invalid');
  }
  const reconcileKind = journalReconcileKind(member.id);
  const finalPublicMutation = ['promote-public-service', 'promote-traffic', 'rollback-traffic']
    .includes(member.id);
  return Object.freeze({
    operationId: member.id,
    checkpointOperationId: journalCheckpointBoundary(member.id),
    reconcileKind,
    retryPolicy: mutationRetryPolicy(reconcileKind),
    finalPublicMutation,
    expectedBefore: mutationStateProjection(plan, member.id, 'before'),
    expectedAfter: mutationStateProjection(plan, member.id, 'after'),
    specSha256: canonicalSha256(mutationSpec(plan, member.id)),
  });
}

function mutationSafeResult(plan, operationId, context) {
  if (operationId === 'build-submit') {
    const receipt = context.buildReceipt;
    if (!receipt) throw new Error('Cloud Build safe result is unavailable');
    return Object.freeze({
      kind: 'build', buildId: receipt.buildId, receiptSha256: receipt.buildReceiptSha256,
    });
  }
  if (operationId === 'migration-execute' || operationId.endsWith('-execute')) {
    const receipt = operationId === 'migration-execute'
      ? context.migrationExecutionReceipt
      : context.acceptanceExecutionReceipts[operationId.slice(0, -'-execute'.length)];
    if (!receipt?.name) throw new Error('Cloud Run execution safe result is unavailable');
    return Object.freeze({ kind: 'execution', name: receipt.name, status: 'SUCCEEDED' });
  }
  if (operationId === 'migration-deploy'
    || (operationId.endsWith('-deploy')
      && !['candidate-deploy', 'promote-stable-deploy'].includes(operationId))) {
    const expected = operationId === 'migration-deploy' ? plan.expectedMigrationJob
      : plan.expectedJobs[operationId.slice(0, -'-deploy'.length)];
    const authority = validateReadyReleaseJobReadback(context.observedAfter, expected);
    const observation = canonicalMutationAfterObservation(plan, operationId, context.observedAfter);
    return Object.freeze({
      generation: authority.generation,
      identitySha256: canonicalSha256(mutationSpec(plan, operationId)),
      job: authority.job,
      kind: 'cloud-run-job',
      uid: authority.uid,
      valueSha256: canonicalSha256(observation),
    });
  }
  if (operationId.startsWith('inventory-publish:')
    || operationId.startsWith('evidence-publish:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    const expected = plan.evidence[key];
    const assignedVersion = context.evidenceSecretVersions[key];
    if (!NUMERIC_VERSION.test(String(assignedVersion ?? ''))) {
      throw new Error('Secret version safe result is unavailable');
    }
    return Object.freeze({
      artifactSha256: expected.artifactSha256,
      kind: 'secret-version',
      name: `projects/${PROJECT}/secrets/${expected.secret}`,
      objectSha256: expected.objectSha256,
      version: assignedVersion,
    });
  }
  if (operationId.startsWith('evidence-collect-copy:')) {
    const key = operationId.slice(operationId.indexOf(':') + 1);
    const expected = plan.acceptanceOutputs[key];
    const observed = context.collectedEvidence[key];
    if (!observed) throw new Error('Collected object safe result is unavailable');
    return Object.freeze({
      kind: 'object',
      bucketSha256: canonicalSha256(expected.bucket),
      objectSha256: canonicalSha256(expected.object),
      generation: expected.generation,
      valueSha256: canonicalSha256(observed),
    });
  }
  const absent = operationId === 'candidate-cleanup-delete'
    || operationId.startsWith('evidence-output-delete:');
  const observation = canonicalMutationAfterObservation(
    plan, operationId, context.observedAfter,
  );
  return Object.freeze({
    kind: 'resource',
    state: absent ? 'absent' : 'present',
    identitySha256: canonicalSha256(mutationSpec(plan, operationId)),
    valueSha256: canonicalSha256(observation),
  });
}

function createReleaseMutationAdapter(plan, member, context) {
  const identity = releaseMutationPlanIdentity(plan, member);
  return Object.freeze({
    ...identity,
    readBefore(observed) {
      if (observed === undefined) return identity.expectedBefore;
      return Object.freeze({
        ...identity.expectedBefore,
        observationSha256: canonicalSha256(observed),
      });
    },
    mutate: Object.freeze([...member.argv]),
    readAfter(observed) {
      return Object.freeze({
        ...identity.expectedAfter,
        observation: canonicalMutationAfterObservation(plan, member.id, observed),
      });
    },
    canonicalState(state, observed) {
      return state === 'before' ? this.readBefore(observed) : this.readAfter(observed);
    },
    safeResult(observedAfter) {
      return mutationSafeResult(plan, member.id, { ...context(), observedAfter });
    },
  });
}

function checkpointSafeResult(records, attemptId, operationId) {
  const checkpoints = records.filter((record) => (
    record.attemptId === attemptId
    && record.recordType === 'checkpoint'
    && record.operationId === operationId
  ));
  if (checkpoints.length !== 1 || checkpoints[0].payload?.classification !== 'after'
    || !checkpoints[0].payload.safeResult
    || typeof checkpoints[0].payload.safeResult !== 'object'
    || Array.isArray(checkpoints[0].payload.safeResult)) {
    throw new Error('Checkpointed release operation has no exact safe result');
  }
  return checkpoints[0].payload.safeResult;
}

function validateResourceSafeResult(plan, member, safeResult, observed) {
  const identity = releaseMutationPlanIdentity(plan, member);
  const absent = member.id === 'candidate-cleanup-delete'
    || member.id.startsWith('evidence-output-delete:');
  let canonicalObservation;
  try {
    canonicalObservation = canonicalMutationAfterObservation(plan, member.id, observed);
  } catch {
    throw new Error('Checkpointed resource differs from its authoritative readback');
  }
  if (member.id === 'migration-deploy'
    || (member.id.endsWith('-deploy')
      && !['candidate-deploy', 'promote-stable-deploy'].includes(member.id))) {
    const expected = member.id === 'migration-deploy' ? plan.expectedMigrationJob
      : plan.expectedJobs[member.id.slice(0, -'-deploy'.length)];
    const authority = validateReadyReleaseJobReadback(observed, expected);
    if (!exactKeys(safeResult, [
      'generation', 'identitySha256', 'job', 'kind', 'uid', 'valueSha256',
    ]) || safeResult.kind !== 'cloud-run-job'
      || safeResult.identitySha256 !== identity.specSha256
      || safeResult.valueSha256 !== canonicalSha256(canonicalObservation)
      || safeResult.job !== authority.job || safeResult.uid !== authority.uid
      || safeResult.generation !== authority.generation) {
      throw new Error('Checkpointed Cloud Run Job differs from its authoritative readback');
    }
    return true;
  }
  if (!exactKeys(safeResult, [
    'identitySha256', 'kind', 'state', 'valueSha256',
  ]) || safeResult.kind !== 'resource' || safeResult.state !== (absent ? 'absent' : 'present')
    || safeResult.identitySha256 !== identity.specSha256
    || safeResult.valueSha256 !== canonicalSha256(canonicalObservation)) {
    throw new Error('Checkpointed resource differs from its authoritative readback');
  }
  return true;
}

function validateExecutionSafeResult(safeResult, { job }) {
  if (!exactKeys(safeResult, ['kind', 'name', 'status'])
    || safeResult.kind !== 'execution' || safeResult.status !== 'SUCCEEDED'
    || validateCloudRunExecutionIdentity({
      apiVersion: 'run.googleapis.com/v1',
      kind: 'Execution',
      metadata: {
        name: safeResult.name,
        labels: { 'run.googleapis.com/job': job },
      },
    }, { job }) !== safeResult.name) {
    throw new Error('Checkpointed execution identity is invalid');
  }
  return true;
}

function validateSecretVersionSafeResult(safeResult, expected) {
  if (!exactKeys(safeResult, [
    'artifactSha256', 'kind', 'name', 'objectSha256', 'version',
  ])
    || safeResult.kind !== 'secret-version'
    || safeResult.name !== `projects/${PROJECT}/secrets/${expected.secret}`
    || safeResult.artifactSha256 !== expected.artifactSha256
    || safeResult.objectSha256 !== expected.objectSha256
    || !NUMERIC_VERSION.test(String(safeResult.version ?? ''))) {
    throw new Error('Checkpointed Secret version identity is invalid');
  }
  return safeResult.version;
}

function validateObjectSafeResult(safeResult, output, observed) {
  if (!exactKeys(safeResult, [
    'bucketSha256', 'generation', 'kind', 'objectSha256', 'valueSha256',
  ]) || safeResult.kind !== 'object'
    || safeResult.bucketSha256 !== canonicalSha256(output.bucket)
    || safeResult.objectSha256 !== canonicalSha256(output.object)
    || safeResult.generation !== output.generation
    || safeResult.valueSha256 !== canonicalSha256(observed)) {
    throw new Error('Checkpointed collected object differs from its authoritative evidence');
  }
  return true;
}

async function reconstructCheckpointedEvidenceVersion({
  executor, plan, records, attemptId, key, phase,
}) {
  const operationId = `${phase}-publish:${key}`;
  const expected = plan.evidence[key];
  const readback = plan.operations.find(({ id }) => id === `${phase}-readback:${key}`);
  const payloadReadback = plan.operations.find(
    ({ id }) => id === `${phase}-payload-readback:${key}`,
  );
  if (!expected || !readback || !payloadReadback) {
    throw new Error('Checkpointed Secret version is unavailable');
  }
  const assignedVersion = validateSecretVersionSafeResult(
    checkpointSafeResult(records, attemptId, operationId), expected,
  );
  const receipt = await executor(bindAssignedSecretVersion(readback.argv, assignedVersion));
  validateEvidenceVersionReceipt(receipt, { ...expected, secretVersion: assignedVersion });
  validateEvidencePayloadReceipt(await executor(
    bindAssignedSecretVersion(payloadReadback.argv, assignedVersion), {
    maxBuffer: 2 * 1024 * 1024, text: true,
  }), expected);
  return assignedVersion;
}

function buildPlanWithAssignedEvidenceVersions(input, phase, evidenceSecretVersions) {
  if (phase === 'inventory') {
    return buildReleasePlan({
      ...input,
      legacyInventory: {
        ...input.legacyInventory,
        secretVersion: evidenceSecretVersions.legacyInventory,
      },
    }, { phase: 'inventory' });
  }
  if (phase === 'evidence') {
    return buildReleasePlan({
      ...input,
      evidence: Object.fromEntries(Object.entries(input.evidence).map(([key, value]) => [
        key,
        key === 'legacyInventory' ? value : {
          ...value,
          secretVersion: evidenceSecretVersions[key],
        },
      ])),
    }, { phase: 'candidate' });
  }
  throw new Error('Assigned evidence Secret version phase is invalid');
}

async function revalidateCheckpointedJobDeployment({
  executor, plan, records, attemptId, deployOperationId, expectedJob,
}) {
  const deployMember = plan.operations.find(({ id }) => id === deployOperationId);
  if (!deployMember) throw new Error('Checkpointed Job deployment is unavailable');
  const rawJob = await executor([
    'run', 'jobs', 'describe', expectedJob.job,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  validateReadyReleaseJobReadback(rawJob, expectedJob);
  validateResourceSafeResult(
    plan,
    deployMember,
    checkpointSafeResult(records, attemptId, deployOperationId),
    rawJob,
  );
  return rawJob;
}

async function reconstructCheckpointedJobExecution({
  executor, plan, records, attemptId, deployOperationId, executeOperationId,
  expectedJob, validateExecution,
}) {
  await revalidateCheckpointedJobDeployment({
    executor, plan, records, attemptId, deployOperationId, expectedJob,
  });
  const executionSafeResult = checkpointSafeResult(records, attemptId, executeOperationId);
  validateExecutionSafeResult(executionSafeResult, expectedJob);
  const rawExecution = await executor([
    'run', 'jobs', 'executions', 'describe', executionSafeResult.name,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  const execution = validateExecution(rawExecution);
  if (execution.name !== executionSafeResult.name) {
    throw new Error('Checkpointed execution differs from its authoritative readback');
  }
  return execution;
}

function journalCheckpointBoundary(operationId) {
  if (operationId === 'build-submit') return 'build-readback';
  if (operationId === 'candidate-deploy') return 'candidate-private-iam-baseline-readback';
  if (operationId === 'candidate-private-iam-grant') return 'candidate-private-iam-readback';
  if (operationId === 'candidate-cleanup-delete') return 'candidate-cleanup-absence-readback';
  if (operationId === 'promote-stable-deploy') return 'promote-stable-artifact-readback';
  if (operationId === 'promote-public-service') return 'promote-public-iam-readback';
  if (operationId === 'promote-traffic') return 'promote-readback';
  if (operationId === 'candidate-privacy-publish'
    || operationId === 'promote-privacy-publish') return operationId;
  if (operationId === 'rollback-traffic') return 'rollback-readback';
  if (operationId === 'migration-execute') return 'migration-execution-readback';
  if (operationId.endsWith('-execute')) {
    return operationId.replace(/-execute$/u, '-execution-readback');
  }
  if (operationId.startsWith('inventory-publish:')) {
    return operationId.replace('inventory-publish:', 'inventory-payload-readback:');
  }
  if (operationId.startsWith('evidence-publish:')) {
    return operationId.replace('evidence-publish:', 'evidence-payload-readback:');
  }
  if (operationId.startsWith('evidence-output-delete:')) {
    return operationId.replace('evidence-output-delete:', 'evidence-output-delete-readback:');
  }
  if (operationId.endsWith('-deploy')) return operationId.replace(/-deploy$/u, '-readback');
  return operationId;
}

function journalRestartObservation(member, plan) {
  const { id } = member;
  if (id === 'build-submit' || id.endsWith('-execute')) return { mode: 'blocked' };
  if (id === 'migration-deploy') return {
    mode: 'read',
    argv: [
      'run', 'jobs', 'describe', MIGRATION_JOB,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
  };
  if (id.endsWith('-deploy') && !['candidate-deploy', 'promote-stable-deploy'].includes(id)) {
    const key = id.slice(0, -'-deploy'.length);
    const job = plan.expectedJobs[key]?.job;
    if (!job) return { mode: 'blocked' };
    return {
      mode: 'read',
      argv: [
        'run', 'jobs', 'describe', job,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ],
    };
  }
  if (id.startsWith('inventory-publish:') || id.startsWith('evidence-publish:')) {
    return { mode: 'blocked' };
  }
  if (id.startsWith('evidence-collect-copy:')) return { mode: 'collected-local' };
  if (id.startsWith('evidence-output-delete:')) {
    const key = id.slice(id.indexOf(':') + 1);
    const output = plan.acceptanceOutputs[key];
    if (!output) return { mode: 'blocked' };
    return {
      mode: 'gcs-absence-list',
      argv: [
        'storage', 'objects', 'list', `gs://${output.bucket}/${output.object}`,
        `--project=${PROJECT}`, '--format=json',
      ],
    };
  }
  if (id === 'candidate-deploy') return {
    mode: 'read',
    argv: [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
  };
  if (id === 'candidate-private-iam-grant') return {
    mode: 'read',
    argv: [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
  };
  if (id === 'candidate-cleanup-delete') return { mode: 'deferred-absence' };
  if (id === 'promote-stable-deploy') return {
    mode: 'read',
    argv: [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
  };
  if (id === 'promote-public-service') return {
    mode: 'read',
    argv: [
      'run', 'services', 'get-iam-policy', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
  };
  if (id === 'promote-traffic' || id === 'rollback-traffic') return {
    mode: 'read',
    argv: [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
  };
  return { mode: 'blocked' };
}

async function readCandidateControlPlaneState(executor, plan) {
  const service = await executor([
    'run', 'services', 'describe', CANDIDATE_SERVICE,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  const revision = await executor([
    'run', 'revisions', 'describe', plan.candidateRevision,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  const iam = await executor([
    'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  const artifact = await executor(artifactDescribeArgv(plan.image));
  const readbacks = { service, revision, iam, artifact };
  validateCandidateControlPlaneReadbacks(readbacks, plan);
  return readbacks;
}

async function assertCloudRunServiceAbsent(executor, service) {
  try {
    await executor([
      'run', 'services', 'describe', service,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]);
  } catch (error) {
    if (error?.code === 'CLOUD_RUN_SERVICE_NOT_FOUND') {
      return Object.freeze({ service, state: 'absent' });
    }
    throw error;
  }
  throw new Error('Cloud Run Service remains present');
}

async function readStableStagedControlPlaneState(executor, plan, {
  publicIam = false,
  allowPrivateOrPublicIam = false,
} = {}) {
  const service = await executor([
    'run', 'services', 'describe', STABLE_SERVICE,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  validateStableStagedService(service, plan);
  const revision = await executor([
    'run', 'revisions', 'describe', plan.stableRevision,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  validateStableRevisionReadback(revision, plan);
  const artifact = await executor(artifactDescribeArgv(plan.image));
  validateCandidateArtifact(artifact, plan.image);
  const iam = await executor([
    'run', 'services', 'get-iam-policy', STABLE_SERVICE,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  if (allowPrivateOrPublicIam) {
    let valid = false;
    for (const policy of ['stable-private', 'stable-public']) {
      try {
        validateServiceIamReceipt(iam, { policy, requireEtag: true });
        valid = true;
        break;
      } catch {
        // The open final-IAM intent may authoritatively be either before or after.
      }
    }
    if (!valid) throw new Error('Stable IAM is neither the intended private nor public state');
  } else {
    validateServiceIamReceipt(iam, {
      policy: publicIam ? 'stable-public' : 'stable-private', requireEtag: true,
    });
  }
  return Object.freeze({ service, revision, artifact, iam });
}

async function validatePromotionFinalBarrier({
  executor,
  plan,
  priorReceipts,
  promotionPrivacyReference,
  now,
  verifyTask8Evidence,
  verifyReleasePrivacyArtifact,
  validateReleasePrivacyProof,
}) {
  validateReleaseReceiptChain(priorReceipts, plan, { through: 'mobile' });
  const candidateReceipt = priorReceipts.find(({ phase }) => phase === 'candidate');
  const candidateProof = candidateReceipt?.outputs?.privacyProof;
  if (!candidateProof) throw new Error('Candidate privacy receipt is unavailable');
  await verifyReleasePrivacyArtifact(
    candidateProof,
    plan,
    new Date(candidateProof.observedAt),
    'Candidate privacy proof is invalid',
    validateReleasePrivacyProof,
  );
  for (const phase of ['readiness', 'workload', 'mobile']) {
    const workloadExecution = phase === 'workload'
      ? priorReceipts.find((value) => value.phase === 'workload')?.outputs?.execution
      : null;
    const verified = await verifyTask8Evidence(plan.task8Evidence[phase], phase, plan, {
      now: new Date(promotionPrivacyReference.observedAt),
      historical: true,
      gateWindow: workloadExecution ? {
        gateStartedAt: workloadExecution.gateStartedAt,
        gateEndedAt: workloadExecution.gateEndedAt,
      } : null,
    });
    if (verified !== true && !(phase === 'workload' && verified
      && typeof verified === 'object' && !Array.isArray(verified))) {
      throw new Error('Promotion evidence boundary drifted');
    }
  }
  const authority = await executor([
    'auth', 'list', '--filter=status:ACTIVE', '--format=json',
  ]);
  if (!Array.isArray(authority) || authority.length !== 1
    || authority[0]?.account !== PROMOTION_AUTHORITY || authority[0]?.status !== 'ACTIVE') {
    throw new Error('Public promotion authority is not approved');
  }
  const candidate = plan.previousRevision === null
    ? await assertCloudRunServiceAbsent(executor, CANDIDATE_SERVICE)
    : await readCandidateControlPlaneState(executor, plan);
  const stable = await readStableStagedControlPlaneState(executor, plan, {
    publicIam: plan.previousRevision !== null,
  });
  let current = null;
  try {
    const verificationClock = plan.previousRevision === null
      ? new Date(promotionPrivacyReference.observedAt)
      : () => {
        current = now();
        if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
          throw new Error('Promotion final barrier clock is invalid');
        }
        return current;
      };
    if (plan.previousRevision === null) {
      current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
        throw new Error('Promotion final barrier clock is invalid');
      }
    }
    await verifyReleasePrivacyArtifact(
      promotionPrivacyReference,
      plan,
      verificationClock,
      'Promotion privacy proof is invalid',
      validateReleasePrivacyProof,
    );
  } catch (error) {
    if (plan.previousRevision !== null
      && current !== null && promotionProofExpired(promotionPrivacyReference, current)) {
      error.code = 'PROMOTION_REPROOF_REQUIRED';
    }
    throw error;
  }
  return Object.freeze({
    current: current.toISOString(),
    candidate,
    stable,
    promotionPrivacyReference,
    predecessorReceiptSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
  });
}

function promotionProofExpired(reference, current) {
  const currentMs = current instanceof Date ? current.getTime() : Number.NaN;
  return !Number.isFinite(currentMs) || currentMs >= Date.parse(reference?.expiresAt);
}

async function closePromotionAttemptForReproof(stateStore) {
  if (!stateStore || typeof stateStore.appendTerminal !== 'function') {
    throw new Error('Promotion re-proof journal is unavailable');
  }
  const currentAttempt = stateStore.attemptId;
  const openIntent = stateStore.records.at(-1)?.recordType === 'intent'
    ? stateStore.records.at(-1) : null;
  if (openIntent) {
    if (typeof stateStore.appendAbort !== 'function') {
      throw new Error('Promotion re-proof abort journal is unavailable');
    }
    await stateStore.appendAbort({
      intentRecordSha256: openIntent.recordSha256,
      reason: 'expired-before-final-mutation',
    });
  }
  const checkpoints = stateStore.records.filter((record) => (
    record.attemptId === currentAttempt && record.recordType === 'checkpoint'
  ));
  const checkpoint = checkpoints.at(-1);
  if (!checkpoint) throw new Error('Promotion re-proof checkpoint is unavailable');
  const terminalState = {
    code: 'PROMOTION_REPROOF_REQUIRED',
    phase: 'promote',
    mutationCount: checkpoints.length,
  };
  await stateStore.appendTerminal({
    status: 'phase-blocked',
    checkpointRecordSha256: checkpoint.recordSha256,
    receiptSha256: canonicalSha256(terminalState),
    terminalState,
    mutationCount: checkpoints.length,
    responseLossOperationIds: checkpoints
      .filter(({ payload }) => ['adopted-response-loss', 'adopted-restart'].includes(payload.outcome))
      .map(({ operationId }) => operationId),
  });
}

async function readImmutableRecoveryFile(filePath, { maxBytes, message }) {
  if (!isAbsoluteFile(filePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(message);
  }
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > maxBytes) throw new Error(message);
  const bytes = await readFile(filePath);
  const metadataAfter = await lstat(filePath);
  if (bytes.length !== metadata.size || metadataAfter.size !== metadata.size
    || metadataAfter.dev !== metadata.dev || metadataAfter.ino !== metadata.ino
    || metadataAfter.nlink !== 1 || !metadataAfter.isFile()
    || metadataAfter.isSymbolicLink()) throw new Error(message);
  return bytes;
}

function failedExecutionTerminalState(evidence, mutationCount, operationId) {
  return Object.freeze({
    code: 'CLOUD_RUN_EXECUTION_FAILED',
    evidenceSha256: canonicalSha256(evidence),
    mutationCount,
    operationId,
    phase: 'acceptance',
  });
}

function failedExecutionCheckpointOperationIds(plan, operationId) {
  const contract = failedAcceptanceExecutionContract(operationId);
  if (contract === null || !Array.isArray(plan?.operations)) return null;
  const operationIds = plan.operations
    .filter((member) => member.phase === 'acceptance' && operationMayMutate(member.id))
    .map(({ id }) => id);
  const executeIndex = operationIds.indexOf(operationId);
  if (executeIndex < 1 || operationIds[executeIndex - 1] !== contract.deployOperationId) {
    return null;
  }
  return Object.freeze(operationIds.slice(0, executeIndex));
}

async function appendFailedExecutionTerminal(stateStore, abortRecord, plan) {
  const contract = failedAcceptanceExecutionContract(abortRecord?.operationId);
  const expectedJob = contract === null ? null : plan?.expectedJobs?.[contract.key];
  const expectedCheckpointOperationIds = failedExecutionCheckpointOperationIds(
    plan, abortRecord?.operationId,
  );
  if (!stateStore || typeof stateStore.appendTerminal !== 'function'
    || abortRecord?.recordType !== 'abort'
    || abortRecord?.payload?.reason !== 'authoritative-cloud-run-execution-failed'
    || contract === null || expectedJob?.job !== contract.job
    || abortRecord.payload?.evidence?.job !== contract.job
    || expectedCheckpointOperationIds === null) {
    throw new Error('Cloud Run failed execution terminal is invalid');
  }
  const attemptId = abortRecord.attemptId ?? stateStore.attemptId;
  const checkpoints = stateStore.records.filter((record) => (
    record.recordType === 'checkpoint'
    && (record.attemptId ?? attemptId) === attemptId
  ));
  if (!exact(checkpoints.map(({ operationId }) => operationId), expectedCheckpointOperationIds)) {
    throw new Error('Cloud Run failed execution terminal is invalid');
  }
  const checkpoint = checkpoints.at(-1);
  const terminalState = failedExecutionTerminalState(
    abortRecord.payload.evidence, checkpoints.length, abortRecord.operationId,
  );
  await stateStore.appendTerminal({
    status: 'phase-blocked',
    checkpointRecordSha256: checkpoint.recordSha256,
    receiptSha256: canonicalSha256(terminalState),
    terminalState,
    mutationCount: checkpoints.length,
    responseLossOperationIds: checkpoints
      .filter(({ payload }) => ['adopted-response-loss', 'adopted-restart'].includes(payload.outcome))
      .map((record) => record.operationId),
  });
  return terminalState;
}

function failedExecutionTerminalTombstone(records, plan, phasePlanSha256) {
  if (!Array.isArray(records) || records.length < 5
    || !DIGEST.test(String(phasePlanSha256 ?? ''))) return null;
  const terminal = records.at(-1);
  const abortRecord = records.at(-2);
  const contract = failedAcceptanceExecutionContract(abortRecord?.operationId);
  if (terminal?.recordType !== 'terminal' || terminal.phase !== 'acceptance'
    || terminal.phasePlanSha256 !== phasePlanSha256
    || terminal.operationId !== null
    || abortRecord?.recordType !== 'abort'
    || contract === null
    || abortRecord.payload?.reason !== 'authoritative-cloud-run-execution-failed'
    || abortRecord.phase !== 'acceptance'
    || abortRecord.phasePlanSha256 !== phasePlanSha256
    || abortRecord.attemptId !== terminal.attemptId) return null;
  const attemptRecords = records.filter(({ attemptId }) => attemptId === terminal.attemptId);
  const checkpoints = attemptRecords.filter(({ recordType }) => recordType === 'checkpoint');
  const executeIntent = attemptRecords.find(({ recordType, operationId }) => (
    recordType === 'intent' && operationId === contract.operationId
  ));
  const checkpoint = checkpoints.at(-1);
  const evidence = abortRecord.payload.evidence;
  const expectedJob = plan?.expectedJobs?.[contract.key];
  const executeMember = plan?.operations?.find(
    ({ id }) => id === contract.operationId,
  );
  const expectedCheckpointOperationIds = failedExecutionCheckpointOperationIds(
    plan, contract.operationId,
  );
  const terminalState = terminal.payload?.terminalState;
  const evidenceSha256 = canonicalSha256(evidence);
  const expectedTerminalState = failedExecutionTerminalState(
    evidence, checkpoints.length, contract.operationId,
  );
  const responseLossOperationIds = checkpoints
    .filter(({ payload }) => ['adopted-response-loss', 'adopted-restart'].includes(payload.outcome))
    .map(({ operationId }) => operationId);
  if (expectedCheckpointOperationIds === null
    || !exact(checkpoints.map(({ operationId }) => operationId), expectedCheckpointOperationIds)
    || checkpoint.operationId !== contract.deployOperationId
    || attemptRecords.some((record) => (
      record.phase !== 'acceptance' || record.phasePlanSha256 !== phasePlanSha256
    ))
    || checkpoint.phasePlanSha256 !== phasePlanSha256
    || executeIntent?.phasePlanSha256 !== phasePlanSha256
    || executeIntent?.payload?.reconcileKind !== 'cloud-run-job-execute'
    || executeIntent.payload.commandSha256 !== canonicalSha256(executeMember?.argv)
    || abortRecord.payload?.intentRecordSha256 !== executeIntent.recordSha256
    || evidence?.commandSha256 !== executeIntent.payload.commandSha256
    || evidence?.operationAttemptId !== executeIntent.payload.operationAttemptId
    || expectedJob?.job !== contract.job || evidence?.job !== expectedJob.job
    || evidence?.project !== PROJECT || evidence?.region !== REGION
    || terminal.payload?.status !== 'phase-blocked'
    || terminal.payload?.checkpointRecordSha256 !== checkpoint.recordSha256
    || terminal.payload?.mutationCount !== checkpoints.length
    || terminal.payload?.receiptSha256 !== canonicalSha256(expectedTerminalState)
    || !exact(terminalState, expectedTerminalState)
    || terminalState.evidenceSha256 !== evidenceSha256
    || (terminal.payload.terminalStateSha256 !== undefined
      && terminal.payload.terminalStateSha256 !== canonicalSha256(expectedTerminalState))
    || !exact(terminal.payload?.responseLossOperationIds, responseLossOperationIds)) return null;
  return Object.freeze({
    completed: Object.freeze(checkpoints.map(({ operationId }) => operationId)),
    evidence,
    operationId: abortRecord.operationId,
    terminalState,
  });
}

async function recoverFailedAcceptanceExecute({
  stateStore, plan, intent, executor, logPath, expectedLogSha256,
  auditLogPath, expectedAuditLogSha256,
}) {
  const contract = failedAcceptanceExecutionContract(intent?.operationId);
  if (!stateStore || typeof stateStore.appendAbort !== 'function'
    || typeof stateStore.appendTerminal !== 'function'
    || intent?.recordType !== 'intent'
    || contract === null
    || intent?.payload?.reconcileKind !== 'cloud-run-job-execute') {
    throw new Error('Cloud Run failed execution recovery is invalid');
  }
  const key = contract.key;
  const expectedJob = plan.expectedJobs[key];
  const executeMember = plan.operations.find(({ id }) => id === intent.operationId);
  if (!expectedJob || expectedJob.job !== contract.job || !executeMember
    || intent.payload.commandSha256 !== canonicalSha256(executeMember.argv)) {
    throw new Error('Cloud Run failed execution recovery is invalid');
  }
  const executeLogBytes = await readImmutableRecoveryFile(logPath, {
    maxBytes: 256 * 1024,
    message: 'Cloud Run failed execution recovery is invalid',
  });
  const logEvidence = validateFailedCloudRunExecutionLog(executeLogBytes, {
    expectedLogSha256, intent, job: expectedJob.job, project: PROJECT, region: REGION,
  });
  const rawJob = await revalidateCheckpointedJobDeployment({
    executor,
    plan,
    records: stateStore.records,
    attemptId: stateStore.attemptId,
    deployOperationId: `${key}-deploy`,
    expectedJob,
  });
  const authority = validateReadyReleaseJobReadback(rawJob, expectedJob);
  if (positiveCanonicalInteger(rawJob?.status?.executionCount) === null
    || rawJob?.status?.latestCreatedExecution?.name !== logEvidence.executionName
    || rawJob?.status?.latestCreatedExecution?.completionStatus !== 'EXECUTION_FAILED') {
    throw new Error('Cloud Run failed execution recovery is invalid');
  }
  const describeArgv = [
    'run', 'jobs', 'executions', 'describe', logEvidence.executionName,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ];
  const firstRawExecution = await executor(describeArgv);
  const secondRawExecution = await executor(describeArgv);
  if (!exact(firstRawExecution, secondRawExecution)) {
    throw new Error('Cloud Run failed execution readback drifted');
  }
  const execution = validateFailedReleaseJobExecutionReceipt(firstRawExecution, {
    expectedJob,
    executionName: logEvidence.executionName,
    intentCreatedAt: intent.createdAt,
    jobGeneration: authority.generation,
    jobUid: authority.uid,
  });
  const auditLogBytes = await readImmutableRecoveryFile(auditLogPath, {
    maxBytes: 1024 * 1024,
    message: 'Cloud Run failed execution recovery is invalid',
  });
  validateFailedCloudRunAuditLog(auditLogBytes, {
    expectedAuditLogSha256,
    expectedExecution: {
      ...execution,
      intentCreatedAt: intent.createdAt,
      jobGeneration: authority.generation,
      jobUid: authority.uid,
    },
    expectedJob,
    project: PROJECT,
    region: REGION,
  });
  const evidence = Object.freeze({
    auditLogSha256: expectedAuditLogSha256,
    commandSha256: logEvidence.commandSha256,
    executionCompletionTime: execution.completionTime,
    executionCreatedAt: execution.createdAt,
    executionName: execution.executionName,
    executionReadbackSha256: canonicalSha256(firstRawExecution),
    executionUid: execution.executionUid,
    failedCount: execution.failedCount,
    httpStatus: logEvidence.httpStatus,
    job: expectedJob.job,
    jobGeneration: authority.generation,
    jobReadbackSha256: canonicalSha256(rawJob),
    jobUid: authority.uid,
    logSha256: logEvidence.logSha256,
    operationAttemptId: logEvidence.operationAttemptId,
    platformOperationId: execution.platformOperationId,
    project: PROJECT,
    region: REGION,
    terminalReason: execution.terminalReason,
    terminalStateSha256: execution.terminalStateSha256,
  });
  let abortRecord;
  try {
    abortRecord = await stateStore.appendAbort({
      intentRecordSha256: intent.recordSha256,
      reason: 'authoritative-cloud-run-execution-failed',
      evidence,
    });
  } catch (error) {
    error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
    throw error;
  }
  try {
    await appendFailedExecutionTerminal(stateStore, abortRecord, plan);
  } catch (error) {
    error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
    throw error;
  }
  return evidence;
}

async function recoverRejectedAcceptanceExecute({
  stateStore, plan, intent, executor, logPath, expectedLogSha256,
}) {
  if (!stateStore || typeof stateStore.appendAbort !== 'function'
    || typeof stateStore.appendTerminal !== 'function'
    || intent?.recordType !== 'intent' || intent?.payload?.reconcileKind !== 'cloud-run-job-execute'
    || !intent.operationId.endsWith('-execute') || !isAbsoluteFile(logPath)) {
    throw new Error('Cloud Run rejection recovery is invalid');
  }
  const key = intent.operationId.slice(0, -'-execute'.length);
  const expectedJob = plan.expectedJobs[key];
  if (!expectedJob || expectedJob.job !== DEPENDENCY_ACCEPTANCE_JOB) {
    throw new Error('Cloud Run rejection recovery is invalid');
  }
  const metadata = await lstat(logPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1
    || metadata.size > 128 * 1024) {
    throw new Error('Cloud Run rejection recovery is invalid');
  }
  // Windows Store virtualization can make AppData's canonical parent differ from its visible
  // pathname. The immutable expected digest, bounded size, and before/after file identity still
  // bind this external gcloud log without weakening ordinary release-artifact reads.
  const logBytes = await readFile(logPath);
  const metadataAfter = await lstat(logPath);
  if (logBytes.length !== metadata.size || metadataAfter.size !== metadata.size
    || metadataAfter.dev !== metadata.dev || metadataAfter.ino !== metadata.ino
    || metadataAfter.nlink !== metadata.nlink || !metadataAfter.isFile()
    || metadataAfter.isSymbolicLink()) {
    throw new Error('Cloud Run rejection recovery is invalid');
  }
  const rejection = validateRejectedCloudRunExecutionLog(logBytes, {
    expectedLogSha256, intent, job: expectedJob.job, project: PROJECT, region: REGION,
  });
  const rawJob = await executor([
    'run', 'jobs', 'describe', expectedJob.job,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  const authority = validateFailedReleaseJobAuthority(rawJob, expectedJob);
  const executions = await executor([
    'run', 'jobs', 'executions', 'list', `--job=${expectedJob.job}`,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ]);
  const executionBaseline = canonicalCloudRunExecutionBaseline(executions, {
    expectedJob,
    jobGeneration: authority.generation,
    jobUid: authority.uid,
  });
  if (!exact(executionBaseline, intent.payload.executionBaseline)) {
    throw new Error('Cloud Run rejection recovery execution baseline changed');
  }
  const evidence = Object.freeze({
    ...rejection,
    executionListSha256: executionBaseline.executionSetSha256,
    job: expectedJob.job,
    jobGeneration: authority.generation,
    jobReadbackSha256: canonicalSha256(rawJob),
    jobUid: authority.uid,
    project: PROJECT,
    region: REGION,
  });
  const currentAttempt = stateStore.attemptId;
  const checkpoints = stateStore.records.filter((record) => (
    record.attemptId === currentAttempt && record.recordType === 'checkpoint'
  ));
  const checkpoint = checkpoints.at(-1);
  if (!checkpoint) throw new Error('Cloud Run rejection recovery checkpoint is unavailable');
  await stateStore.appendAbort({
    intentRecordSha256: intent.recordSha256,
    reason: 'authoritative-cloud-run-failed-precondition',
    evidence,
  });
  const terminalState = Object.freeze({
    code: 'CLOUD_RUN_EXECUTION_REJECTED',
    evidence,
    mutationCount: checkpoints.length,
    operationId: intent.operationId,
    phase: 'acceptance',
  });
  await stateStore.appendTerminal({
    status: 'phase-blocked',
    checkpointRecordSha256: checkpoint.recordSha256,
    receiptSha256: canonicalSha256(terminalState),
    terminalState,
    mutationCount: checkpoints.length,
    responseLossOperationIds: checkpoints
      .filter(({ payload }) => ['adopted-response-loss', 'adopted-restart'].includes(payload.outcome))
      .map((record) => record.operationId),
  });
  return evidence;
}

function parseArguments(argv, releaseSha) {
  if (!Array.isArray(argv) || !RELEASE_SHA.test(String(releaseSha ?? ''))) return null;
  let phase = null;
  let confirmed = false;
  for (const member of argv) {
    if (typeof member !== 'string') return null;
    if (member.startsWith('--phase=') && phase === null) {
      phase = member.slice('--phase='.length);
    } else if (member === `--confirm-release=${releaseSha}` && !confirmed) {
      confirmed = true;
    } else return null;
  }
  if (!PHASES.includes(phase)) return null;
  return { phase, confirmed };
}

function workloadLoggingReadArgv(attestation) {
  const userAgent = `hkbuddy-v1-acceptance/${attestation.acceptanceWindowId}`;
  const filter = [
    `logName="projects/${PROJECT}/logs/run.googleapis.com%2Frequests"`,
    'resource.type="cloud_run_revision"',
    `resource.labels.project_id="${PROJECT}"`,
    `resource.labels.location="${REGION}"`,
    `resource.labels.service_name="${CANDIDATE_SERVICE}"`,
    `resource.labels.revision_name="${attestation.candidateRevision}"`,
    'httpRequest.requestMethod="POST"',
    `httpRequest.requestUrl="${attestation.candidateOrigin}/api/v1/messages"`,
    'httpRequest.status=202',
    `httpRequest.userAgent="${userAgent}"`,
  ].join(' AND ');
  return [
    'logging', 'read', filter, `--project=${PROJECT}`, '--order=asc', '--limit=201', '--format=json',
  ];
}

function requestHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (Array.isArray(headers)) {
    const matches = headers.filter(([key]) => String(key).toLowerCase() === name.toLowerCase());
    return matches.length === 1 ? String(matches[0][1]) : null;
  }
  const matches = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? String(matches[0][1]) : null;
}

function createControlledWorkloadFetch(fetchImpl, plan, ledger) {
  if (typeof fetchImpl !== 'function' || !Array.isArray(ledger)) {
    throw new Error('Controlled workload fetch is unavailable');
  }
  return async (input, init = {}) => {
    const rawUrl = input instanceof URL ? input.href
      : typeof input === 'string' ? input : input?.url;
    const url = new URL(rawUrl);
    if (url.origin !== plan.candidateOrigin || url.username || url.password
      || ledger.length >= MAX_CONTROLLED_WORKLOAD_REQUESTS) {
      throw new Error('Controlled workload request is outside the candidate boundary');
    }
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (!/^(?:GET|HEAD|POST)$/.test(method)) throw new Error('Controlled workload method is invalid');
    const response = await fetchImpl(input, init);
    const status = Number(response?.status);
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      throw new Error('Controlled workload response is invalid');
    }
    const path = `${url.pathname}${url.search}`;
    const authorization = requestHeader(init?.headers, 'Authorization');
    const entry = {
      sequence: ledger.length + 1,
      method,
      path,
      status,
      authenticated: typeof authorization === 'string'
        && /^Bearer [^\s]{40,16384}$/.test(authorization),
      acceptanceUserAgent: requestHeader(init?.headers, 'User-Agent'),
      ...(method === 'POST' && url.pathname === '/api/v1/messages' ? {
        correlationId: requestHeader(init?.headers, 'X-Acceptance-Correlation-Id'),
      } : {}),
      ...(method === 'POST' && url.pathname === '/api/v1/voice/transcriptions' ? {
        uploadId: requestHeader(init?.headers, 'X-Client-Upload-Id'),
      } : {}),
      ...(url.pathname.startsWith('/api/v1/media/') ? {
        range: requestHeader(init?.headers, 'Range') === 'bytes=0-3',
      } : {}),
    };
    ledger.push(Object.freeze(entry));
    return response;
  };
}

function exactStringSet(values, expected) {
  return Array.isArray(values) && Array.isArray(expected)
    && values.length === expected.length
    && new Set(values).size === values.length
    && exact([...values].sort(), [...expected].sort());
}

function validateControlledWorkloadNetwork(ledger, record) {
  if (!Array.isArray(ledger) || ledger.length < 500
    || ledger.length > MAX_CONTROLLED_WORKLOAD_REQUESTS
    || ledger.some((entry, index) => entry.sequence !== index + 1)
    || containsForbiddenPersistedSecret(ledger)) {
    throw new Error('Controlled workload network witness is invalid');
  }
  const matches = (method, path) => ledger.filter((entry) => (
    entry.method === method && entry.path === path
  ));
  const sessions = matches('POST', '/api/v1/session');
  const textPosts = matches('POST', '/api/v1/messages');
  const messageReads = matches('GET', '/api/v1/messages?after=0');
  const asrPosts = matches('POST', '/api/v1/voice/transcriptions');
  const timingPath = `/api/v1/acceptance/timings?windowId=${record.rawReceipts.acceptanceWindowId}`;
  const timingReads = matches('GET', timingPath);
  const expectedCorrelations = record.rawReceipts.textTurns.map(({ correlationId }) => correlationId);
  const expectedUploads = record.rawReceipts.asrRequests.map(({ bindingId }) => bindingId);
  const expectedTtsIds = record.rawReceipts.ttsRequests.map(({ bindingId }) => bindingId);
  const expectedUserAgent = `hkbuddy-v1-acceptance/${record.rawReceipts.acceptanceWindowId}`;
  const ttsStatus = ledger.filter(({ method, path }) => (
    method === 'GET' && /^\/api\/v1\/messages\/[^/?]{1,128}\/audio\/status$/.test(path)
  ));
  const observedTtsIds = [...new Set(ttsStatus.map(({ path }) => path.split('/')[4]))];
  const media = ledger.filter(({ path }) => path.startsWith('/api/v1/media/'));
  const mediaPaths = [...new Set(media.map(({ path }) => path))];
  const mediaComplete = mediaPaths.length === 30 && mediaPaths.every((path) => {
    const values = media.filter((entry) => entry.path === path);
    return values.length === 3
      && values.some(({ method, status }) => method === 'HEAD' && status === 200)
      && values.some(({ method, status, range }) => method === 'GET' && status === 206 && range === true)
      && values.some(({ method, status, range }) => method === 'GET' && status === 200 && range === false);
  });
  const checks = [
    ['AUTHENTICATION', ledger.every(({ authenticated, acceptanceUserAgent }) => (
      authenticated === true && acceptanceUserAgent === expectedUserAgent
    ))],
    ['SESSION', sessions.length === 21 && sessions.every(({ status }) => [200, 201].includes(status))],
    ['TEXT', textPosts.length === 200 && textPosts.every(({ status }) => status === 202)
      && exactStringSet(textPosts.map(({ correlationId }) => correlationId), expectedCorrelations)],
    ['DELIVERY', messageReads.length >= 231 && messageReads.every(({ status }) => status === 200)],
    ['ASR', asrPosts.length === 30 && asrPosts.every(({ status }) => [200, 201, 202].includes(status))
      && exactStringSet(asrPosts.map(({ uploadId }) => uploadId), expectedUploads)],
    ['TIMING', timingReads.length === 20 && timingReads.every(({ status }) => status === 200)],
    ['TTS_BINDING', exactStringSet(observedTtsIds, expectedTtsIds)],
    ['TTS_READY', expectedTtsIds.every((id) => ttsStatus.some(({ path, status }) => (
      path === `/api/v1/messages/${id}/audio/status` && status === 200
    )))],
    ['MEDIA', mediaComplete],
  ];
  const failed = checks.find(([, pass]) => !pass);
  if (failed) {
    const error = new Error('Controlled workload network witness is invalid');
    error.code = `WORKLOAD_CONTROLLED_NETWORK_${failed[0]}_INVALID`;
    throw error;
  }
  return Object.freeze({
    observedRequestCount: ledger.length,
    networkWitnessSha256: canonicalSha256(ledger),
  });
}

async function assertControlledWorkloadTargetAbsent(entry) {
  try {
    await lstat(entry.filePath);
    throw new Error('Controlled workload target already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

function unresolvedTask8Contract(entry) {
  return entry.artifactSha256 === '0'.repeat(64)
    && entry.objectSha256 === '0'.repeat(64)
    && ['start', 'end'].every((boundary) => {
      const reference = entry.privacyProofs[boundary];
      return reference.artifactSha256 === '0'.repeat(64)
        && reference.objectSha256 === '0'.repeat(64)
        && reference.boundarySha256 === '0'.repeat(64);
    });
}

async function assertControlledReadinessTargetsAbsent(entry) {
  try {
    for (const filePath of [
      entry.privacyProofs.start.filePath,
      entry.privacyProofs.end.filePath,
      entry.filePath,
    ]) await assertControlledWorkloadTargetAbsent({ filePath });
  } catch (cause) {
    const error = new Error('Pre-existing readiness evidence is forbidden', { cause });
    error.code = 'READINESS_PREBUILT_EVIDENCE_FORBIDDEN';
    throw error;
  }
  return true;
}

async function executeCandidatePrivacyArtifact({
  plan,
  locator,
  executor,
  tokenExecutor,
  fetch,
  now,
  nonce,
  sleep,
  privacyProofRunner,
}) {
  const binding = candidatePrivacyBinding(plan);
  const proof = await privacyProofRunner({
    binding, executor, tokenExecutor, fetch, now, nonce, sleep,
  });
  const observedNow = now();
  if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())) {
    throw new Error('Controlled privacy clock is invalid');
  }
  validateCandidatePrivacyProof(proof, { binding, now: observedNow });
  const contents = `${JSON.stringify(proof, null, 2)}\n`;
  const reference = Object.freeze({
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    filePath: locator.filePath,
    artifactSha256: proof.artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
    boundarySha256: proof.binding.boundarySha256,
    observedAt: proof.occurredAt,
    expiresAt: proof.expiresAt,
  });
  if (reference.boundarySha256 !== candidatePrivacyBoundarySha256(binding)
    || containsForbiddenPersistedSecret(proof)) {
    throw new Error('Controlled privacy output is invalid');
  }
  return Object.freeze({ filePath: locator.filePath, contents, reference });
}

function privacyPublication(artifact) {
  const bytes = Buffer.from(artifact.contents);
  const artifacts = [Object.freeze({
    role: 'privacy-proof',
    filePath: artifact.filePath,
    byteLength: bytes.length,
    objectSha256: createHash('sha256').update(bytes).digest('hex'),
    contentsBase64: bytes.toString('base64'),
  })];
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    bundleSha256: canonicalSha256(artifacts),
  });
}

function privacyArtifactFromPublication(plan, locator, publication, {
  now,
  validatePrivacyProof = validateCandidatePrivacyProof,
} = {}) {
  if (!publication || !Array.isArray(publication.artifacts)
    || publication.artifacts.length !== 1
    || publication.bundleSha256 !== canonicalSha256(publication.artifacts)) {
    throw new Error('Privacy publication intent is invalid');
  }
  const artifact = publication.artifacts[0];
  const bytes = Buffer.from(artifact.contentsBase64, 'base64');
  if (artifact.role !== 'privacy-proof' || artifact.filePath !== locator.filePath
    || bytes.length !== artifact.byteLength || bytes.toString('base64') !== artifact.contentsBase64
    || createHash('sha256').update(bytes).digest('hex') !== artifact.objectSha256) {
    throw new Error('Privacy publication intent is invalid');
  }
  let proof;
  try { proof = JSON.parse(bytes.toString('utf8')); } catch {
    throw new Error('Privacy publication intent is invalid');
  }
  const reference = Object.freeze({
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    filePath: locator.filePath,
    artifactSha256: proof.artifactSha256,
    objectSha256: artifact.objectSha256,
    boundarySha256: proof.binding?.boundarySha256,
    observedAt: proof.occurredAt,
    expiresAt: proof.expiresAt,
  });
  validatePrivacyProof(proof, { binding: candidatePrivacyBinding(plan), now });
  if (reference.boundarySha256 !== candidatePrivacyBoundarySha256(candidatePrivacyBinding(plan))
    || containsForbiddenPersistedSecret(proof)) {
    throw new Error('Privacy publication intent is invalid');
  }
  return Object.freeze({
    filePath: locator.filePath,
    contents: bytes.toString('utf8'),
    reference,
  });
}

async function publishPrivacyArtifact(artifact, {
  stateStore,
  operationId,
  mutationOrdinal,
  releaseJournalAttemptId,
  existingIntent = null,
  writeArtifact = writeAtomicCreateOnly,
}) {
  const expectedPublication = privacyPublication(artifact);
  let publication = expectedPublication;
  let intent = existingIntent;
  if (intent !== null) {
    if (intent.recordType !== 'intent' || intent.operationId !== operationId
      || intent.payload?.reconcileKind !== 'local-artifact-create'
      || !exact(intent.payload.publication, expectedPublication)) {
      throw new Error('Privacy publication intent drifted');
    }
    publication = intent.payload.publication;
  } else {
    intent = await stateStore.appendIntent({
      mutationOrdinal,
      operationAttemptId: createHash('sha256').update([
        releaseJournalAttemptId, operationId, String(mutationOrdinal),
      ].join('\0')).digest('hex').slice(0, 32),
      commandSha256: canonicalSha256({
        operationId, filePath: artifact.filePath,
      }),
      reconcileKind: 'local-artifact-create',
      beforeSha256: canonicalSha256({ state: 'absent' }),
      afterSha256: publication.bundleSha256,
      publication,
    }, { operationId });
  }
  const intended = Buffer.from(publication.artifacts[0].contentsBase64, 'base64');
  let adopted = false;
  try {
    const existing = await readBoundedOrdinaryFile(artifact.filePath, {
      expectedByteLength: intended.length, maximumBytes: 4 * 1024 * 1024,
    });
    if (!existing.equals(intended)) throw new Error('Privacy publication bytes drifted');
    adopted = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeArtifact(artifact.filePath, intended);
  }
  await stateStore.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: adopted ? 'adopted-restart' : 'applied',
    observationSha256: publication.bundleSha256,
    safeResult: {
      kind: 'artifact-bundle', artifactCount: 1, bundleSha256: publication.bundleSha256,
    },
  });
  return artifact.reference;
}

function validateControlledReadinessExecution(value, plan, now) {
  if (!exactKeys(value, ['artifacts', 'evidence', 'record'])
    || !exactKeys(value.artifacts, ['privacyEnd', 'privacyStart', 'readiness'])
    || !exactKeys(value.evidence, [
      'artifactSha256', 'candidateService', 'filePath', 'objectSha256', 'privacyProofs',
      'schemaVersion', 'stableService', 'stableTrafficState', 'trafficState',
    ]) || value.evidence.schemaVersion !== 3
    || value.evidence.filePath !== plan.task8Evidence.readiness.filePath
    || value.evidence.candidateService !== CANDIDATE_SERVICE
    || value.evidence.stableService !== STABLE_SERVICE
    || value.evidence.trafficState !== candidateTrafficState(plan)
    || value.evidence.stableTrafficState !== plan.expectedStable.initialTrafficState
    || value.evidence.artifactSha256 !== value.record?.artifactSha256
    || !DIGEST.test(String(value.evidence.objectSha256 ?? ''))
    || !exact(value.evidence.privacyProofs, value.record?.privacyProofs)
    || containsForbiddenPersistedSecret(value)) {
    throw new Error('Controlled readiness output is invalid');
  }
  validateTask8ReadinessRecord(value.record, {
    binding: candidatePrivacyBinding(plan),
    sourceArchiveSha256: plan.sourceArchiveSha256,
    now,
  });
  const readinessContents = `${JSON.stringify(value.record, null, 2)}\n`;
  const readiness = value.artifacts.readiness;
  if (!exactKeys(readiness, ['artifactSha256', 'contents', 'filePath', 'objectSha256'])
    || readiness.filePath !== value.evidence.filePath
    || readiness.contents !== readinessContents
    || readiness.artifactSha256 !== value.evidence.artifactSha256
    || readiness.objectSha256 !== value.evidence.objectSha256
    || createHash('sha256').update(readiness.contents).digest('hex') !== readiness.objectSha256) {
    throw new Error('Controlled readiness output is invalid');
  }
  for (const [key, boundary] of [['privacyStart', 'start'], ['privacyEnd', 'end']]) {
    const artifact = value.artifacts[key];
    const reference = value.evidence.privacyProofs[boundary];
    if (!exactKeys(artifact, ['contents', 'filePath', 'reference'])
      || artifact.filePath !== reference.filePath || !exact(artifact.reference, reference)
      || typeof artifact.contents !== 'string' || artifact.contents.length < 2
      || artifact.contents.length > 4 * 1024 * 1024 || !artifact.contents.endsWith('\n')
      || createHash('sha256').update(artifact.contents).digest('hex') !== reference.objectSha256) {
      throw new Error('Controlled readiness output is invalid');
    }
    let record;
    try { record = JSON.parse(artifact.contents); } catch { throw new Error('Controlled readiness output is invalid'); }
    if (record?.artifactSha256 !== reference.artifactSha256
      || containsForbiddenPersistedSecret(record)) throw new Error('Controlled readiness output is invalid');
  }
  return Object.freeze(value);
}

async function executeControlledReadiness(plan, {
  environment,
  executor,
  executeReadiness,
  readinessFetch,
  readinessTokenExecutor,
  readinessNonce,
  readinessSleep,
  now,
}) {
  const entry = plan.task8Evidence.readiness;
  if (!unresolvedTask8Contract(entry)) {
    const error = new Error('Pre-existing readiness evidence is forbidden');
    error.code = 'READINESS_PREBUILT_EVIDENCE_FORBIDDEN';
    throw error;
  }
  await assertControlledReadinessTargetsAbsent(entry);
  if (typeof executor !== 'function' || typeof executeReadiness !== 'function'
    || typeof readinessFetch !== 'function' || typeof readinessNonce !== 'function') {
    throw new Error('Controlled readiness execution input is invalid');
  }
  let tokenExecutor = readinessTokenExecutor;
  if (tokenExecutor === undefined) {
    tokenExecutor = createDefaultIdentityTokenExecutor(environment);
  }
  if (typeof tokenExecutor !== 'function') throw new Error('Controlled readiness token transport is invalid');
  let result;
  try {
    result = await executeReadiness({
      plan,
      binding: candidatePrivacyBinding(plan),
      evidenceContract: entry,
      sourceArchiveSha256: plan.sourceArchiveSha256,
      executor,
      tokenExecutor,
      fetch: readinessFetch,
      now,
      nonce: readinessNonce,
      sleep: readinessSleep,
    });
  } catch (error) {
    error.code = 'READINESS_CONTROLLED_PRODUCER_FAILED';
    throw error;
  }
  try {
    const observedNow = now();
    return validateControlledReadinessExecution(result, plan, observedNow);
  } catch (error) {
    error.code = 'READINESS_CONTROLLED_OUTPUT_INVALID';
    throw error;
  }
}

function controlledReadinessPublication(execution) {
  const artifacts = [
    ['privacy-start', execution.artifacts.privacyStart],
    ['privacy-end', execution.artifacts.privacyEnd],
    ['evidence', execution.artifacts.readiness],
  ].map(([role, artifact]) => {
    const bytes = Buffer.from(artifact.contents);
    return Object.freeze({
      role,
      filePath: artifact.filePath,
      byteLength: bytes.length,
      objectSha256: createHash('sha256').update(bytes).digest('hex'),
      contentsBase64: bytes.toString('base64'),
    });
  });
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    bundleSha256: canonicalSha256(artifacts),
  });
}

function controlledReadinessFromPublication(plan, publication) {
  if (!publication || !Array.isArray(publication.artifacts)
    || publication.bundleSha256 !== canonicalSha256(publication.artifacts)) {
    throw new Error('Readiness publication intent is invalid');
  }
  const byRole = Object.fromEntries(publication.artifacts.map((artifact) => {
    const bytes = Buffer.from(artifact.contentsBase64, 'base64');
    if (bytes.length !== artifact.byteLength
      || bytes.toString('base64') !== artifact.contentsBase64
      || createHash('sha256').update(bytes).digest('hex') !== artifact.objectSha256) {
      throw new Error('Readiness publication intent is invalid');
    }
    return [artifact.role, { ...artifact, contents: bytes.toString('utf8') }];
  }));
  if (!exactKeys(byRole, ['evidence', 'privacy-end', 'privacy-start'])) {
    throw new Error('Readiness publication intent is invalid');
  }
  let record;
  try { record = JSON.parse(byRole.evidence.contents); } catch {
    throw new Error('Readiness publication intent is invalid');
  }
  const evidence = Object.freeze({
    ...plan.task8Evidence.readiness,
    artifactSha256: record.artifactSha256,
    objectSha256: byRole.evidence.objectSha256,
    privacyProofs: structuredClone(record.privacyProofs),
  });
  const execution = {
    record,
    evidence,
    artifacts: {
      privacyStart: {
        filePath: byRole['privacy-start'].filePath,
        contents: byRole['privacy-start'].contents,
        reference: record.privacyProofs?.start,
      },
      privacyEnd: {
        filePath: byRole['privacy-end'].filePath,
        contents: byRole['privacy-end'].contents,
        reference: record.privacyProofs?.end,
      },
      readiness: {
        filePath: byRole.evidence.filePath,
        contents: byRole.evidence.contents,
        artifactSha256: record.artifactSha256,
        objectSha256: byRole.evidence.objectSha256,
      },
    },
  };
  return validateControlledReadinessExecution(
    execution, plan, new Date(record.occurredAt),
  );
}

async function publishControlledReadinessArtifacts(execution, {
  stateStore,
  releaseJournalAttemptId,
  existingIntent = null,
  writeArtifact = writeAtomicCreateOnly,
}) {
  if (!stateStore || typeof stateStore.appendIntent !== 'function'
    || typeof stateStore.appendCheckpoint !== 'function') {
    throw new Error('Readiness publication journal is unavailable');
  }
  const operationId = 'readiness-evidence-publish';
  const expectedPublication = controlledReadinessPublication(execution);
  let intent = existingIntent;
  let publication = expectedPublication;
  if (intent !== null) {
    if (intent.recordType !== 'intent' || intent.operationId !== operationId
      || intent.payload?.reconcileKind !== 'local-artifact-create') {
      throw new Error('Readiness publication intent is invalid');
    }
    publication = intent.payload.publication;
    if (!exact(publication, expectedPublication)) {
      throw new Error('Readiness publication intent drifted');
    }
  } else {
    intent = await stateStore.appendIntent({
      mutationOrdinal: 1,
      operationAttemptId: createHash('sha256').update([
        releaseJournalAttemptId, operationId, '1',
      ].join('\0')).digest('hex').slice(0, 32),
      commandSha256: canonicalSha256(publication.artifacts.map(({ role, filePath }) => ({
        role, filePath,
      }))),
      reconcileKind: 'local-artifact-create',
      beforeSha256: canonicalSha256({ state: 'absent' }),
      afterSha256: publication.bundleSha256,
      publication,
    }, { operationId });
  }
  let adopted = false;
  for (const artifact of publication.artifacts) {
    const intended = Buffer.from(artifact.contentsBase64, 'base64');
    try {
      const existing = await readBoundedOrdinaryFile(artifact.filePath, {
        expectedByteLength: intended.length, maximumBytes: 4 * 1024 * 1024,
      });
      if (!existing.equals(intended)) throw new Error('Readiness publication bytes drifted');
      adopted = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await writeArtifact(artifact.filePath, intended);
    }
  }
  await stateStore.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: adopted ? 'adopted-restart' : 'applied',
    observationSha256: publication.bundleSha256,
    safeResult: {
      kind: 'artifact-bundle',
      artifactCount: publication.artifacts.length,
      bundleSha256: publication.bundleSha256,
    },
  });
  return Object.freeze(publication.artifacts.map(({ filePath }) => filePath));
}

function mobileScreenshotPaths(entry) {
  return Object.freeze([
    'first-visit', 'text-source', 'voice-transcript', 'mobile-safe-area',
  ].map((id) => join(dirname(entry.filePath), `mobile-${id}.png`)));
}

async function captureMobileControlPlaneState({ plan, executor }) {
  if (typeof executor !== 'function') throw new Error('Mobile control-plane reader is unavailable');
  const candidate = await readCandidateControlPlaneState(executor, plan);
  let stable;
  if (plan.previousRevision === null) {
    try {
      await executor([
        'run', 'services', 'describe', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]);
      throw new Error('Stable service unexpectedly exists');
    } catch (error) {
      if (error?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
      stable = { state: 'absent' };
    }
  } else {
    const service = await executor([
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]);
    validateStableService(service, plan);
    const revision = await executor([
      'run', 'revisions', 'describe', plan.previousRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]);
    validatePriorRevisionReadback(revision, plan);
    const artifact = await executor(artifactDescribeArgv(plan.previousImage));
    validateCandidateArtifact(artifact, plan.previousImage);
    const iam = await executor([
      'run', 'services', 'get-iam-policy', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]);
    validateServiceIamReceipt(iam, { policy: 'stable-public', requireEtag: true });
    stable = { service, revision, artifact, iam };
  }
  return Object.freeze({ stable: true, sha256: canonicalSha256({ candidate, stable }) });
}

function validateControlledMobileExecution(value, plan, observedNow) {
  if (!exactKeys(value, ['artifacts', 'evidence', 'record'])
    || !exactKeys(value.artifacts, ['mobile', 'privacyEnd', 'privacyStart', 'screenshots'])
    || !exactKeys(value.evidence, [
      'artifactSha256', 'candidateService', 'filePath', 'objectSha256', 'privacyProofs',
      'schemaVersion', 'stableService', 'stableTrafficState', 'trafficState',
    ]) || value.evidence.filePath !== plan.task8Evidence.mobile.filePath
    || value.evidence.candidateService !== CANDIDATE_SERVICE
    || value.evidence.stableService !== STABLE_SERVICE
    || value.evidence.trafficState !== candidateTrafficState(plan)
    || value.evidence.stableTrafficState !== plan.expectedStable.initialTrafficState
    || !exact(value.evidence.privacyProofs, value.record.privacyProofs)) {
    throw new Error('Controlled mobile output is invalid');
  }
  validateTask8MobileRecord(value.record, {
    binding: candidatePrivacyBinding(plan),
    sourceArchiveSha256: plan.sourceArchiveSha256,
    boundarySha256: value.record.privacyProofs?.start?.boundarySha256,
    candidateAccess: plan.candidateAccess,
    now: observedNow,
  });
  const mobileContents = `${JSON.stringify(value.record, null, 2)}\n`;
  if (!exactKeys(value.artifacts.mobile, [
    'artifactSha256', 'contents', 'filePath', 'objectSha256',
  ]) || value.artifacts.mobile.filePath !== value.evidence.filePath
    || value.artifacts.mobile.contents !== mobileContents
    || value.artifacts.mobile.artifactSha256 !== value.evidence.artifactSha256
    || value.artifacts.mobile.objectSha256 !== value.evidence.objectSha256
    || createHash('sha256').update(mobileContents).digest('hex') !== value.evidence.objectSha256
    || !Array.isArray(value.artifacts.screenshots) || value.artifacts.screenshots.length !== 4) {
    throw new Error('Controlled mobile output is invalid');
  }
  for (const [index, artifact] of value.artifacts.screenshots.entries()) {
    const screenshot = value.record.screenshots[index];
    if (!exactKeys(artifact, ['contents', 'filePath', 'id', 'metadata'])
      || artifact.id !== screenshot.id || artifact.filePath !== screenshot.filePath
      || !Buffer.isBuffer(artifact.contents)
      || createHash('sha256').update(artifact.contents).digest('hex') !== screenshot.rawSha256
      || !exact(artifact.metadata, {
        width: screenshot.width,
        height: screenshot.height,
        rawSha256: screenshot.rawSha256,
        pixelSha256: screenshot.pixelSha256,
        colorCount: screenshot.colorCount,
        luminanceSpan: screenshot.luminanceSpan,
        luminanceVariance: screenshot.luminanceVariance,
        dominantRatio: screenshot.dominantRatio,
        nonDominantRatio: screenshot.nonDominantRatio,
        byteLength: screenshot.byteLength,
      })) throw new Error('Controlled mobile output is invalid');
  }
  for (const [key, boundary] of [['privacyStart', 'start'], ['privacyEnd', 'end']]) {
    const artifact = value.artifacts[key];
    let proof;
    try { proof = JSON.parse(artifact?.contents); } catch { throw new Error('Controlled mobile output is invalid'); }
    if (!exactKeys(artifact, ['contents', 'filePath', 'reference'])
      || artifact.filePath !== value.evidence.privacyProofs[boundary].filePath
      || !exact(artifact.reference, value.evidence.privacyProofs[boundary])
      || proof.artifactSha256 !== artifact.reference.artifactSha256
      || createHash('sha256').update(artifact.contents).digest('hex')
        !== artifact.reference.objectSha256) throw new Error('Controlled mobile output is invalid');
  }
  if (containsForbiddenPersistedSecret(value)) throw new Error('Controlled mobile output is invalid');
  return value;
}

async function executeControlledMobile(plan, {
  environment,
  executor,
  executeMobile,
  mobileTokenExecutor,
  now,
  producePrivacyArtifact,
  privacyFetch,
  privacyNonce,
  privacySleep,
  privacyProofRunner,
  captureControlPlane,
}) {
  const entry = plan.task8Evidence.mobile;
  if (!unresolvedTask8Contract(entry)) {
    const error = new Error('Pre-existing mobile evidence is forbidden');
    error.code = 'MOBILE_PREBUILT_EVIDENCE_FORBIDDEN';
    throw error;
  }
  for (const filePath of [
    entry.privacyProofs.start.filePath, entry.privacyProofs.end.filePath,
    ...mobileScreenshotPaths(entry), entry.filePath,
  ]) await assertControlledWorkloadTargetAbsent({ filePath });
  if (typeof executor !== 'function' || typeof executeMobile !== 'function'
    || typeof producePrivacyArtifact !== 'function' || typeof captureControlPlane !== 'function') {
    throw new Error('Controlled mobile execution input is invalid');
  }
  let tokenExecutor = mobileTokenExecutor;
  if (tokenExecutor === undefined) {
    tokenExecutor = createDefaultIdentityTokenExecutor(environment);
  }
  if (typeof tokenExecutor !== 'function') throw new Error('Controlled mobile token transport is invalid');
  const binding = candidatePrivacyBinding(plan);
  const token = await tokenExecutor(createCandidatePrivacyCommandPlan(binding).token);
  if (typeof token !== 'string' || token.length < 1 || token.length > 16_384 || /\s/u.test(token)) {
    throw new Error('Controlled mobile token transport is invalid');
  }
  const privacyArguments = {
    plan, executor, tokenExecutor, fetch: privacyFetch, now,
    nonce: privacyNonce, sleep: privacySleep, privacyProofRunner,
  };
  const result = await executeMobile({
    binding,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    evidenceContract: entry,
    stableService: STABLE_SERVICE,
    stableTrafficState: plan.expectedStable.initialTrafficState,
    candidateAccess: plan.candidateAccess,
    authorization: `Bearer ${token}`,
    producePrivacyArtifact: (boundary) => producePrivacyArtifact({
      ...privacyArguments, locator: entry.privacyProofs[boundary],
    }),
    captureControlPlane: () => captureControlPlane({ plan, executor }),
    now,
  });
  return validateControlledMobileExecution(result, plan, now());
}

function controlledMobilePublication(execution) {
  const values = [
    ['privacy-start', execution.artifacts.privacyStart],
    ...execution.artifacts.screenshots.map((artifact) => ['screenshot', artifact]),
    ['privacy-end', execution.artifacts.privacyEnd],
    ['evidence', execution.artifacts.mobile],
  ];
  const artifacts = values.map(([role, artifact]) => {
    const bytes = Buffer.from(artifact.contents);
    return Object.freeze({
      role,
      filePath: artifact.filePath,
      byteLength: bytes.length,
      objectSha256: createHash('sha256').update(bytes).digest('hex'),
      contentsBase64: bytes.toString('base64'),
    });
  });
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    bundleSha256: canonicalSha256(artifacts),
  });
}

function controlledMobileFromPublication(plan, publication, observedNow) {
  if (!publication || !Array.isArray(publication.artifacts)
    || publication.artifacts.length !== 7
    || publication.bundleSha256 !== canonicalSha256(publication.artifacts)) {
    throw new Error('Mobile publication intent is invalid');
  }
  const expectedPaths = [
    plan.task8Evidence.mobile.privacyProofs.start.filePath,
    ...mobileScreenshotPaths(plan.task8Evidence.mobile),
    plan.task8Evidence.mobile.privacyProofs.end.filePath,
    plan.task8Evidence.mobile.filePath,
  ];
  const expectedRoles = ['privacy-start', 'screenshot', 'screenshot', 'screenshot', 'screenshot', 'privacy-end', 'evidence'];
  const bytes = publication.artifacts.map((artifact, index) => {
    const value = Buffer.from(artifact.contentsBase64, 'base64');
    if (artifact.filePath !== expectedPaths[index] || artifact.role !== expectedRoles[index]
      || value.length !== artifact.byteLength || value.toString('base64') !== artifact.contentsBase64
      || createHash('sha256').update(value).digest('hex') !== artifact.objectSha256) {
      throw new Error('Mobile publication intent is invalid');
    }
    return value;
  });
  let record;
  try { record = JSON.parse(bytes.at(-1).toString('utf8')); } catch {
    throw new Error('Mobile publication intent is invalid');
  }
  const privacyArtifact = (index, boundary) => ({
    filePath: expectedPaths[index],
    contents: bytes[index].toString('utf8'),
    reference: record.privacyProofs?.[boundary],
  });
  const screenshots = bytes.slice(1, 5).map((contents, index) => ({
    id: record.screenshots?.[index]?.id,
    filePath: expectedPaths[index + 1],
    contents,
    metadata: record.screenshots?.[index] && {
      width: record.screenshots[index].width,
      height: record.screenshots[index].height,
      rawSha256: record.screenshots[index].rawSha256,
      pixelSha256: record.screenshots[index].pixelSha256,
      colorCount: record.screenshots[index].colorCount,
      luminanceSpan: record.screenshots[index].luminanceSpan,
      luminanceVariance: record.screenshots[index].luminanceVariance,
      dominantRatio: record.screenshots[index].dominantRatio,
      nonDominantRatio: record.screenshots[index].nonDominantRatio,
      byteLength: record.screenshots[index].byteLength,
    },
  }));
  const evidence = {
    ...plan.task8Evidence.mobile,
    artifactSha256: record.artifactSha256,
    objectSha256: publication.artifacts.at(-1).objectSha256,
    privacyProofs: record.privacyProofs,
  };
  return validateControlledMobileExecution({
    record,
    evidence,
    artifacts: {
      privacyStart: privacyArtifact(0, 'start'),
      screenshots,
      privacyEnd: privacyArtifact(5, 'end'),
      mobile: {
        filePath: expectedPaths[6],
        contents: bytes[6].toString('utf8'),
        artifactSha256: record.artifactSha256,
        objectSha256: publication.artifacts[6].objectSha256,
      },
    },
  }, plan, observedNow);
}

async function publishControlledMobileArtifacts(execution, {
  stateStore,
  releaseJournalAttemptId,
  existingIntent = null,
  writeArtifact = writeAtomicCreateOnly,
}) {
  if (!stateStore || typeof stateStore.appendIntent !== 'function'
    || typeof stateStore.appendCheckpoint !== 'function') {
    throw new Error('Mobile publication journal is unavailable');
  }
  const operationId = 'mobile-evidence-publish';
  const expectedPublication = controlledMobilePublication(execution);
  let intent = existingIntent;
  let publication = expectedPublication;
  if (intent !== null) {
    if (intent.recordType !== 'intent' || intent.operationId !== operationId
      || intent.payload?.reconcileKind !== 'local-artifact-create'
      || !exact(intent.payload.publication, expectedPublication)) {
      throw new Error('Mobile publication intent drifted');
    }
    publication = intent.payload.publication;
  } else {
    intent = await stateStore.appendIntent({
      mutationOrdinal: 1,
      operationAttemptId: createHash('sha256').update([
        releaseJournalAttemptId, operationId, '1',
      ].join('\0')).digest('hex').slice(0, 32),
      commandSha256: canonicalSha256(publication.artifacts.map(({ role, filePath }) => ({ role, filePath }))),
      reconcileKind: 'local-artifact-create',
      beforeSha256: canonicalSha256({ state: 'absent' }),
      afterSha256: publication.bundleSha256,
      publication,
    }, { operationId });
  }
  let adopted = false;
  for (const artifact of publication.artifacts) {
    const intended = Buffer.from(artifact.contentsBase64, 'base64');
    try {
      const existing = await readBoundedOrdinaryFile(artifact.filePath, {
        expectedByteLength: intended.length, maximumBytes: 4 * 1024 * 1024,
      });
      if (!existing.equals(intended)) throw new Error('Mobile publication bytes drifted');
      adopted = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await writeArtifact(artifact.filePath, intended);
    }
  }
  await stateStore.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: adopted ? 'adopted-restart' : 'applied',
    observationSha256: publication.bundleSha256,
    safeResult: {
      kind: 'artifact-bundle', artifactCount: publication.artifacts.length,
      bundleSha256: publication.bundleSha256,
    },
  });
  return Object.freeze(publication.artifacts.map(({ filePath }) => filePath));
}

async function cleanupControlledReadinessArtifacts(paths) {
  for (const filePath of [...paths].reverse()) await rm(filePath);
  for (const filePath of paths) await assertControlledWorkloadTargetAbsent({ filePath });
  return true;
}

function controlledWorkloadPublication(execution) {
  const artifacts = [
    ['privacy-start', execution.artifacts.privacyStart],
    ['privacy-end', execution.artifacts.privacyEnd],
    ['evidence', execution.artifacts.workload],
  ].map(([role, artifact]) => {
    const bytes = Buffer.from(artifact.contents);
    return Object.freeze({
      role,
      filePath: artifact.filePath,
      byteLength: bytes.length,
      objectSha256: createHash('sha256').update(bytes).digest('hex'),
      contentsBase64: bytes.toString('base64'),
    });
  });
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    bundleSha256: canonicalSha256(artifacts),
    receipt: Object.freeze({
      attestation: execution.attestation,
      evidence: execution.evidence,
      execution: execution.execution,
    }),
  });
}

function controlledWorkloadFromPublication(plan, publication, {
  validatePrivacyProof = validateCandidatePrivacyProof,
} = {}) {
  if (!publication || !Array.isArray(publication.artifacts)
    || !exactKeys(publication, ['artifacts', 'bundleSha256', 'receipt'])
    || publication.bundleSha256 !== canonicalSha256(publication.artifacts)
    || !exactKeys(publication.receipt, ['attestation', 'evidence', 'execution'])
    || containsForbiddenPersistedSecret(publication)) {
    throw new Error('Workload publication intent is invalid');
  }
  const byRole = Object.fromEntries(publication.artifacts.map((artifact) => {
    const bytes = Buffer.from(artifact.contentsBase64, 'base64');
    if (bytes.length !== artifact.byteLength
      || bytes.toString('base64') !== artifact.contentsBase64
      || createHash('sha256').update(bytes).digest('hex') !== artifact.objectSha256) {
      throw new Error('Workload publication intent is invalid');
    }
    return [artifact.role, { ...artifact, contents: bytes.toString('utf8') }];
  }));
  if (!exactKeys(byRole, ['evidence', 'privacy-end', 'privacy-start'])) {
    throw new Error('Workload publication intent is invalid');
  }
  const expectedPaths = {
    evidence: plan.task8Evidence.workload.filePath,
    'privacy-start': plan.task8Evidence.workload.privacyProofs.start.filePath,
    'privacy-end': plan.task8Evidence.workload.privacyProofs.end.filePath,
  };
  for (const [role, artifact] of Object.entries(byRole)) {
    if (artifact.filePath !== expectedPaths[role]) {
      throw new Error('Workload publication intent is invalid');
    }
  }
  let record;
  let privacyStart;
  let privacyEnd;
  try {
    record = JSON.parse(byRole.evidence.contents);
    privacyStart = JSON.parse(byRole['privacy-start'].contents);
    privacyEnd = JSON.parse(byRole['privacy-end'].contents);
  } catch { throw new Error('Workload publication intent is invalid'); }
  const { evidence, execution, attestation } = publication.receipt;
  if (!exact(evidence, {
    ...plan.task8Evidence.workload,
    artifactSha256: record.artifactSha256,
    objectSha256: byRole.evidence.objectSha256,
    privacyProofs: evidence?.privacyProofs,
  }) || !exactKeys(execution, [
    'acceptanceWindowId', 'attemptId', 'gateEndedAt', 'gateStartedAt',
    'networkWitnessSha256', 'observedRequestCount',
  ])) throw new Error('Workload publication intent is invalid');
  for (const [boundary, proof, artifact, clock] of [
    ['start', privacyStart, byRole['privacy-start'], execution.gateStartedAt],
    ['end', privacyEnd, byRole['privacy-end'], execution.gateEndedAt],
  ]) {
    const reference = evidence.privacyProofs?.[boundary];
    if (!exact(assertPrivacyProofReference(reference), {
      ...reference, filePath: artifact.filePath, objectSha256: artifact.objectSha256,
    }) || proof.artifactSha256 !== reference.artifactSha256
      || proof.binding?.boundarySha256 !== reference.boundarySha256
      || proof.occurredAt !== reference.observedAt || proof.expiresAt !== reference.expiresAt) {
      throw new Error('Workload publication intent is invalid');
    }
    validatePrivacyProof(proof, { binding: candidatePrivacyBinding(plan), now: new Date(clock) });
  }
  const validatedAttestation = validateLatencyAcceptanceRecord(
    record, plan, new Date(execution.gateEndedAt),
  );
  if (!exact(validatedAttestation, attestation)
    || execution.acceptanceWindowId !== attestation.acceptanceWindowId) {
    throw new Error('Workload publication intent is invalid');
  }
  return Object.freeze({
    attestation,
    evidence,
    execution,
    artifacts: Object.freeze({
      privacyStart: Object.freeze({
        filePath: byRole['privacy-start'].filePath,
        contents: byRole['privacy-start'].contents,
        reference: evidence.privacyProofs.start,
      }),
      privacyEnd: Object.freeze({
        filePath: byRole['privacy-end'].filePath,
        contents: byRole['privacy-end'].contents,
        reference: evidence.privacyProofs.end,
      }),
      workload: Object.freeze({
        filePath: byRole.evidence.filePath,
        contents: Buffer.from(byRole.evidence.contents),
        artifactSha256: record.artifactSha256,
        objectSha256: byRole.evidence.objectSha256,
      }),
    }),
  });
}

async function publishControlledWorkloadArtifacts(execution, {
  stateStore,
  releaseJournalAttemptId,
  existingIntent = null,
  writeArtifact = writeAtomicCreateOnly,
}) {
  if (!stateStore || typeof stateStore.appendIntent !== 'function'
    || typeof stateStore.appendCheckpoint !== 'function') {
    throw new Error('Workload publication journal is unavailable');
  }
  const operationId = 'workload-evidence-publish';
  const expectedPublication = controlledWorkloadPublication(execution);
  let intent = existingIntent;
  let publication = expectedPublication;
  if (intent !== null) {
    if (intent.recordType !== 'intent' || intent.operationId !== operationId
      || intent.payload?.reconcileKind !== 'local-artifact-create'
      || !exact(intent.payload.publication, expectedPublication)) {
      throw new Error('Workload publication intent drifted');
    }
    publication = intent.payload.publication;
  } else {
    intent = await stateStore.appendIntent({
      mutationOrdinal: 1,
      operationAttemptId: createHash('sha256').update([
        releaseJournalAttemptId, operationId, '1',
      ].join('\0')).digest('hex').slice(0, 32),
      commandSha256: canonicalSha256(publication.artifacts.map(({ role, filePath }) => ({
        role, filePath,
      }))),
      reconcileKind: 'local-artifact-create',
      beforeSha256: canonicalSha256({ state: 'absent' }),
      afterSha256: canonicalSha256(publication),
      publication,
    }, { operationId });
  }
  let adopted = false;
  for (const artifact of publication.artifacts) {
    const intended = Buffer.from(artifact.contentsBase64, 'base64');
    try {
      const existing = await readBoundedOrdinaryFile(artifact.filePath, {
        expectedByteLength: intended.length, maximumBytes: 4 * 1024 * 1024,
      });
      if (!existing.equals(intended)) throw new Error('Workload publication bytes drifted');
      adopted = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await writeArtifact(artifact.filePath, intended);
    }
  }
  const observationSha256 = canonicalSha256(publication);
  await stateStore.appendCheckpoint({
    intentRecordSha256: intent.recordSha256,
    classification: 'after',
    outcome: adopted ? 'adopted-restart' : 'applied',
    observationSha256,
    safeResult: {
      kind: 'artifact-bundle', artifactCount: publication.artifacts.length,
      bundleSha256: publication.bundleSha256,
    },
  });
  return Object.freeze(publication.artifacts.map(({ filePath }) => filePath));
}

async function executeControlledWorkload(plan, {
  environment,
  executor,
  executeWorkload,
  workloadFetch,
  randomUUID,
  now,
  tokenExecutor,
  privacyFetch,
  privacyNonce,
  privacySleep,
  privacyProofRunner,
  producePrivacyArtifact,
}) {
  const entry = plan.task8Evidence.workload;
  if (!unresolvedTask8Contract(entry)) {
    const error = new Error('Pre-existing workload evidence is forbidden');
    error.code = 'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN';
    throw error;
  }
  for (const filePath of [
    entry.privacyProofs.start.filePath, entry.privacyProofs.end.filePath, entry.filePath,
  ]) await assertControlledWorkloadTargetAbsent({ filePath });
  const fixtureManifest = environment?.V1_LATENCY_ASR_FIXTURE_MANIFEST;
  const attemptId = typeof randomUUID === 'function' ? randomUUID() : null;
  if (!UUID.test(String(attemptId ?? '')) || !isAbsoluteFile(fixtureManifest)
    || !fixtureManifest.toLowerCase().endsWith('.json')
    || typeof executor !== 'function' || typeof executeWorkload !== 'function'
    || typeof workloadFetch !== 'function' || typeof tokenExecutor !== 'function'
    || typeof privacyFetch !== 'function' || typeof privacyNonce !== 'function'
    || typeof privacyProofRunner !== 'function' || typeof producePrivacyArtifact !== 'function') {
    throw new Error('Controlled workload execution input is invalid');
  }
  const privacyArguments = {
    plan,
    executor,
    tokenExecutor,
    fetch: privacyFetch,
    now,
    nonce: privacyNonce,
    sleep: privacySleep,
    privacyProofRunner,
  };
  const privacyStart = await producePrivacyArtifact({
    ...privacyArguments, locator: entry.privacyProofs.start,
  });
  const gateStarted = now();
  if (!(gateStarted instanceof Date) || !Number.isFinite(gateStarted.getTime())) {
    throw new Error('Controlled workload clock is invalid');
  }
  let capture = null;
  const ledger = [];
  const fetchImpl = createControlledWorkloadFetch(workloadFetch, plan, ledger);
  const result = await executeWorkload({
    argv: [
      '--candidate-origin', plan.candidateOrigin,
      '--asr-manifest', fixtureManifest,
      '--confirm-approved-candidate',
    ],
    environment: {
      ...environment,
      V1_LOAD_TEST_CONFIRM: 'true',
      V1_RELEASE_COMMIT_SHA: plan.releaseSha,
      V1_PUBLIC_ORIGIN: plan.serviceOrigin,
      V1_CANDIDATE_ORIGIN: plan.candidateOrigin,
      V1_SOURCE_ARCHIVE_SHA256: plan.sourceArchiveSha256,
      V1_CANDIDATE_IMAGE_DIGEST: plan.imageDigest,
      V1_CANDIDATE_REVISION: plan.candidateRevision,
      V1_CANDIDATE_TRAFFIC_PERCENT: String(candidateTrafficPercent(plan)),
      V1_CANDIDATE_AUDIENCE: plan.candidateServiceOrigin,
      V1_CANDIDATE_SERVICE: CANDIDATE_SERVICE,
      V1_STABLE_SERVICE: STABLE_SERVICE,
      V1_CANDIDATE_TRAFFIC_STATE: candidateTrafficState(plan),
      V1_STABLE_TRAFFIC_STATE: plan.expectedStable.initialTrafficState,
    },
    cwd: APP_ROOT,
    artifactDirectory: dirname(entry.filePath),
    now,
    fetchImpl,
    writeArtifact: async (value) => {
      if (capture !== null || !value || typeof value.contents !== 'string'
        || !value.record || typeof value.filePath !== 'string') {
        throw new Error('Controlled workload artifact capture is invalid');
      }
      capture = Object.freeze({ ...value });
    },
    writeOutput: () => undefined,
  });
  const gateEnded = now();
  if (!(gateEnded instanceof Date) || !Number.isFinite(gateEnded.getTime())
    || gateEnded.getTime() < gateStarted.getTime()) {
    throw new Error('Controlled workload clock is invalid');
  }
  const privacyEnd = await producePrivacyArtifact({
    ...privacyArguments, locator: entry.privacyProofs.end,
  });
  if (result?.exitCode !== 0 || result?.publicReport?.code !== 'LATENCY_ACCEPTANCE_PASSED'
    || !capture || result.publicReport.artifactSha256 !== capture.record.artifactSha256
    || capture.filePath !== join(dirname(entry.filePath), `${plan.releaseSha}-${capture.record.artifactSha256}.json`)
    || capture.contents !== `${JSON.stringify(capture.record, null, 2)}\n`
    || containsForbiddenPersistedSecret(capture.record)) {
    throw new Error('Controlled workload did not produce exact passing evidence');
  }
  let attestation;
  try { attestation = validateLatencyAcceptanceRecord(capture.record, plan, now()); } catch (error) {
    error.code = 'WORKLOAD_CONTROLLED_ARTIFACT_INVALID';
    throw error;
  }
  let witness;
  try { witness = validateControlledWorkloadNetwork(ledger, capture.record); } catch (error) {
    error.code ??= 'WORKLOAD_CONTROLLED_NETWORK_INVALID';
    throw error;
  }
  const contents = Buffer.from(capture.contents);
  const evidence = Object.freeze({
    ...entry,
    artifactSha256: capture.record.artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
    privacyProofs: Object.freeze({
      start: privacyStart.reference,
      end: privacyEnd.reference,
    }),
  });
  if (Date.parse(privacyStart.reference.observedAt) > gateStarted.getTime()
    || Date.parse(privacyEnd.reference.observedAt) < gateEnded.getTime()
    || Date.parse(privacyEnd.reference.observedAt) <= Date.parse(privacyStart.reference.observedAt)) {
    throw new Error('Controlled workload privacy proofs do not bracket execution');
  }
  return Object.freeze({
    attestation,
    artifacts: Object.freeze({
      privacyStart,
      privacyEnd,
      workload: Object.freeze({
        filePath: evidence.filePath,
        contents,
        artifactSha256: evidence.artifactSha256,
        objectSha256: evidence.objectSha256,
      }),
    }),
    evidence,
    execution: Object.freeze({
      acceptanceWindowId: attestation.acceptanceWindowId,
      attemptId: attemptId.toLowerCase(),
      gateStartedAt: gateStarted.toISOString(),
      gateEndedAt: gateEnded.toISOString(),
      networkWitnessSha256: witness.networkWitnessSha256,
      observedRequestCount: witness.observedRequestCount,
    }),
  });
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

export async function runGcpRelease({
  argv = process.argv.slice(2),
  input,
  execute,
  verifyEvidence = validateEvidenceArtifactSet,
  inspectCollected = inspectCollectedEvidenceArtifact,
  verifySourceArchive = verifyReleaseArchiveBytes,
  verifyBuildConfig = verifyReleaseArchiveBytes,
  verifyTask8Evidence = validateTask8EvidenceArtifact,
  writeCandidateSpec = writeCandidateServiceSpecFile,
  writeStableSpec = writeStableServiceSpecFile,
  writeIamRestorePolicy = writePromotionIamRestorePolicyFile,
  removeIamRestorePolicy = removePromotionIamRestorePolicyFile,
  executeReadiness = runTask8Readiness,
  readinessFetch = globalThis.fetch,
  readinessTokenExecutor,
  readinessNonce = systemRandomUUID,
  readinessSleep,
  executeMobile = runTask8Mobile,
  mobileTokenExecutor,
  mobilePrivacyFetch = globalThis.fetch,
  mobilePrivacyNonce = systemRandomUUID,
  mobilePrivacySleep,
  mobilePrivacyProofRunner = runCandidatePrivacyProof,
  produceMobilePrivacyArtifact = executeCandidatePrivacyArtifact,
  captureMobileControlPlane = captureMobileControlPlaneState,
  executeWorkload = runLatencyAcceptance,
  workloadFetch = globalThis.fetch,
  workloadPrivacyFetch = globalThis.fetch,
  workloadPrivacyTokenExecutor,
  workloadPrivacyNonce = systemRandomUUID,
  workloadPrivacySleep,
  workloadPrivacyProofRunner = runCandidatePrivacyProof,
  validateWorkloadPrivacyProof = validateCandidatePrivacyProof,
  produceWorkloadPrivacyArtifact = executeCandidatePrivacyArtifact,
  produceReleasePrivacyArtifact = executeCandidatePrivacyArtifact,
  releasePrivacyFetch = globalThis.fetch,
  releasePrivacyTokenExecutor,
  releasePrivacyNonce = systemRandomUUID,
  releasePrivacySleep,
  releasePrivacyProofRunner = runCandidatePrivacyProof,
  validateReleasePrivacyProof = validateCandidatePrivacyProof,
  verifyReleasePrivacyArtifact = validatePrivacyProofArtifact,
  writeControlledArtifact = writeAtomicCreateOnly,
  writeReleasePrivacyArtifact = writeAtomicCreateOnly,
  randomUUID = systemRandomUUID,
  loadReceipts = loadReleaseReceiptFiles,
  loadPhaseReceipt = loadExistingReleasePhaseReceipt,
  persistReceipt = persistReleaseReceipt,
  openStateStore = openReleaseStateStore,
  recoverTerminal = recoverTerminalFromReceipt,
  journalAttemptId = systemRandomUUID,
  now = () => new Date(),
  environment = process.env,
  writeOutput = (line) => process.stdout.write(line),
  unsafeTestOnlyAllowSingletonRollingRelease = false,
} = {}) {
  const selection = parseArguments(argv, input?.releaseSha);
  if (!RELEASE_SHA.test(String(input?.releaseSha ?? ''))) {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'RELEASE_CONTRACT_INVALID', mutationPerformed: false,
    });
  }
  if (!selection) {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'EXACT_RELEASE_CONFIRMATION_REQUIRED', mutationPerformed: false,
    });
  }
  let plan;
  try {
    plan = buildReleasePlan(input, { phase: selection.phase });
  } catch {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'RELEASE_CONTRACT_INVALID', mutationPerformed: false,
    });
  }
  let selected = plan.operations.filter(({ phase }) => phase === selection.phase);
  if (selection.phase === 'rollback'
    && (plan.previousRevision === null || plan.previousImageDigest === null)) {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'ROLLBACK_UNAVAILABLE_NO_PRIOR_RELEASE', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
    });
  }
  if (!selection.confirmed) {
    return publish(writeOutput, 0, {
      status: 'dry-run', code: 'GCP_RELEASE_DRY_RUN', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase,
      plannedOperations: selected.map(({ id }) => id),
    });
  }
  const testOnlyRollingRelease = unsafeTestOnlyAllowSingletonRollingRelease === true
    && process.env.NODE_TEST_CONTEXT !== undefined;
  if (plan.previousRevision !== null
    && ['candidate', 'promote'].includes(selection.phase)
    && !testOnlyRollingRelease) {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'ROLLING_RELEASE_UNSUPPORTED_SINGLETON',
      mutationPerformed: false, releaseSha: plan.releaseSha,
      phase: selection.phase, completed: [],
    });
  }
  if (selection.phase === 'build') {
    try {
      if (typeof verifySourceArchive !== 'function'
        || await verifySourceArchive(plan.sourceArchive, plan.sourceArchiveSha256) !== true) {
        throw new Error('release archive drift');
      }
    } catch {
      return publish(writeOutput, 1, {
        status: 'failed', code: 'RELEASE_SOURCE_ARCHIVE_INVALID', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
    try {
      if (typeof verifyBuildConfig !== 'function'
        || await verifyBuildConfig(plan.buildConfig, plan.buildConfigSha256) !== true) {
        throw new Error('frozen build config drift');
      }
    } catch {
      return publish(writeOutput, 1, {
        status: 'failed', code: 'RELEASE_BUILD_CONFIG_INVALID', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  let priorReceipts = [];
  const receiptPhaseIndex = RECEIPT_PHASES.indexOf(selection.phase);
  const receiptBackedPhase = receiptPhaseIndex >= 0 || ACTION_RECEIPT_PHASES.has(selection.phase);
  const task8Attestations = {};
  let readinessExecution = null;
  let readinessExecutor = null;
  let readinessPublishedPaths = [];
  let mobileExecution = null;
  let mobileExecutor = null;
  let mobilePublishedPaths = [];
  let workloadExecution = null;
  let workloadPrivacyExecutor = null;
  let workloadPublishedPaths = [];
  let stateStore = null;
  let journalMutationCount = 0;
  let releaseJournalAttemptId = null;
  let existingJournalIntent = null;
  let resumeOperationId = null;
  let hasOpenJournalAttempt = false;
  let openJournalRecords = [];
  try {
    if (selection.phase === 'promote') {
      if (typeof loadReceipts !== 'function') throw new Error('receipt loader unavailable');
      priorReceipts = await loadReceipts(plan, { through: 'mobile' });
      validateReleaseReceiptChain(priorReceipts, plan, { through: 'mobile' });
    } else if (['candidate-cleanup', 'rollback'].includes(selection.phase)) {
      if (typeof loadReceipts !== 'function') throw new Error('receipt loader unavailable');
      const through = selection.phase === 'rollback' ? 'mobile' : 'candidate';
      priorReceipts = await loadReceipts(plan, { through });
      validateReleaseReceiptChain(priorReceipts, plan, { through });
    } else if (receiptPhaseIndex > 0) {
      if (typeof loadReceipts !== 'function') throw new Error('receipt loader unavailable');
      const through = RECEIPT_PHASES[receiptPhaseIndex - 1];
      priorReceipts = await loadReceipts(plan, { through });
      validateReleaseReceiptChain(priorReceipts, plan, { through });
    }
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'RELEASE_RECEIPT_CHAIN_INVALID', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
    });
  }
  if (selection.phase === 'readiness') {
    let readinessStage = 'journal';
    try {
      if (typeof openStateStore !== 'function' || typeof journalAttemptId !== 'function') {
        throw new Error('Release journal is unavailable');
      }
      releaseJournalAttemptId = journalAttemptId();
      stateStore = await openStateStore({
        receiptDirectory: plan.releaseReceiptDirectory,
        releaseSha: plan.releaseSha,
        releaseIdentitySha256: plan.releaseIdentitySha256,
        phase: selection.phase,
        phasePlanSha256: canonicalSha256({
          releaseIdentitySha256: plan.releaseIdentitySha256,
          phase: 'readiness',
          operationId: 'readiness-evidence-publish',
          paths: [
            plan.task8Evidence.readiness.privacyProofs.start.filePath,
            plan.task8Evidence.readiness.privacyProofs.end.filePath,
            plan.task8Evidence.readiness.filePath,
          ],
        }),
        attemptId: releaseJournalAttemptId,
        receiptHeadSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
        now,
        workspaceRoot: APP_ROOT,
      });
      if (!stateStore || !Array.isArray(stateStore.records)
        || !['appendIntent', 'appendCheckpoint', 'appendTerminal', 'close']
          .every((key) => typeof stateStore[key] === 'function')) {
        throw new Error('Release journal is invalid');
      }
      releaseJournalAttemptId = stateStore.attemptId ?? releaseJournalAttemptId;
      const lastTerminalIndex = stateStore.records.findLastIndex(
        (record) => record.recordType === 'terminal',
      );
      openJournalRecords = stateStore.records.slice(lastTerminalIndex + 1);
      if (openJournalRecords.length > 0) {
        validateReconciliationPrefix({
          operationIds: ['readiness-evidence-publish'], records: openJournalRecords,
        });
        hasOpenJournalAttempt = true;
        existingJournalIntent = openJournalRecords.at(-1)?.recordType === 'intent'
          ? openJournalRecords.at(-1) : null;
        journalMutationCount = openJournalRecords.some(({ recordType }) => (
          recordType === 'checkpoint'
        )) ? 1 : 0;
        const publicationIntent = openJournalRecords.find(({ recordType, operationId }) => (
          recordType === 'intent' && operationId === 'readiness-evidence-publish'
        ));
        if (!publicationIntent) throw new Error('Readiness publication intent is unavailable');
        readinessExecution = controlledReadinessFromPublication(
          plan, publicationIntent.payload.publication,
        );
        resumeOperationId = existingJournalIntent?.operationId ?? null;
      } else {
        readinessStage = 'executor';
        readinessExecutor = execute ?? createDefaultGcloudExecutor({ environment });
        readinessStage = 'producer';
        readinessExecution = await executeControlledReadiness(plan, {
          environment,
          executor: readinessExecutor,
          executeReadiness,
          readinessFetch,
          readinessTokenExecutor,
          readinessNonce,
          readinessSleep,
          now,
        });
      }
      readinessStage = 'plan';
      plan = buildReleasePlan({
        ...input,
        task8Evidence: {
          ...input.task8Evidence,
          readiness: readinessExecution.evidence,
        },
      }, { phase: selection.phase });
      selected = plan.operations.filter(({ phase }) => phase === selection.phase);
      readinessStage = 'predecessor-chain';
      validateReleaseReceiptChain(priorReceipts, plan, { through: 'candidate' });
      readinessStage = 'publish';
      if (journalMutationCount === 0) {
        readinessPublishedPaths = await publishControlledReadinessArtifacts(readinessExecution, {
          stateStore,
          releaseJournalAttemptId,
          existingIntent: existingJournalIntent,
          writeArtifact: writeControlledArtifact,
        });
        journalMutationCount = 1;
        existingJournalIntent = null;
        resumeOperationId = null;
        openJournalRecords = stateStore.records;
      }
      task8Attestations.readiness = true;
    } catch (error) {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed',
        code: error?.code === 'READINESS_PREBUILT_EVIDENCE_FORBIDDEN'
            ? error.code
            : String(error?.code ?? '').startsWith('READINESS_CONTROLLED_')
              ? error.code
              : `READINESS_CONTROLLED_${readinessStage.toUpperCase()}_INVALID`,
        mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  if (selection.phase === 'mobile') {
    let mobileStage = 'journal';
    try {
      if (!unresolvedTask8Contract(plan.task8Evidence.mobile)) {
        const error = new Error('Pre-existing mobile evidence is forbidden');
        error.code = 'MOBILE_PREBUILT_EVIDENCE_FORBIDDEN';
        throw error;
      }
      if (typeof openStateStore !== 'function' || typeof journalAttemptId !== 'function') {
        throw new Error('Release journal is unavailable');
      }
      releaseJournalAttemptId = journalAttemptId();
      stateStore = await openStateStore({
        receiptDirectory: plan.releaseReceiptDirectory,
        releaseSha: plan.releaseSha,
        releaseIdentitySha256: plan.releaseIdentitySha256,
        phase: selection.phase,
        phasePlanSha256: canonicalSha256({
          releaseIdentitySha256: plan.releaseIdentitySha256,
          phase: 'mobile',
          operationId: 'mobile-evidence-publish',
          paths: [
            plan.task8Evidence.mobile.privacyProofs.start.filePath,
            ...mobileScreenshotPaths(plan.task8Evidence.mobile),
            plan.task8Evidence.mobile.privacyProofs.end.filePath,
            plan.task8Evidence.mobile.filePath,
          ],
        }),
        attemptId: releaseJournalAttemptId,
        receiptHeadSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
        now,
        workspaceRoot: APP_ROOT,
      });
      if (!stateStore || !Array.isArray(stateStore.records)
        || !['appendIntent', 'appendCheckpoint', 'appendTerminal', 'close']
          .every((key) => typeof stateStore[key] === 'function')) {
        throw new Error('Release journal is invalid');
      }
      releaseJournalAttemptId = stateStore.attemptId ?? releaseJournalAttemptId;
      const lastTerminalIndex = stateStore.records.findLastIndex(
        (record) => record.recordType === 'terminal',
      );
      openJournalRecords = stateStore.records.slice(lastTerminalIndex + 1);
      if (openJournalRecords.length > 0) {
        validateReconciliationPrefix({
          operationIds: ['mobile-evidence-publish'], records: openJournalRecords,
        });
        hasOpenJournalAttempt = true;
        existingJournalIntent = openJournalRecords.at(-1)?.recordType === 'intent'
          ? openJournalRecords.at(-1) : null;
        journalMutationCount = openJournalRecords.some(({ recordType }) => (
          recordType === 'checkpoint'
        )) ? 1 : 0;
        const publicationIntent = openJournalRecords.find(({ recordType, operationId }) => (
          recordType === 'intent' && operationId === 'mobile-evidence-publish'
        ));
        if (!publicationIntent) throw new Error('Mobile publication intent is unavailable');
        mobileExecution = controlledMobileFromPublication(
          plan, publicationIntent.payload.publication, now(),
        );
        resumeOperationId = existingJournalIntent?.operationId ?? null;
      } else {
        mobileStage = 'executor';
        mobileExecutor = execute ?? createDefaultGcloudExecutor({ environment });
        mobileStage = 'producer';
        mobileExecution = await executeControlledMobile(plan, {
          environment,
          executor: mobileExecutor,
          executeMobile,
          mobileTokenExecutor,
          now,
          producePrivacyArtifact: produceMobilePrivacyArtifact,
          privacyFetch: mobilePrivacyFetch,
          privacyNonce: mobilePrivacyNonce,
          privacySleep: mobilePrivacySleep,
          privacyProofRunner: mobilePrivacyProofRunner,
          captureControlPlane: captureMobileControlPlane,
        });
      }
      mobileStage = 'plan';
      plan = buildReleasePlan({
        ...input,
        task8Evidence: {
          ...input.task8Evidence,
          mobile: mobileExecution.evidence,
        },
      }, { phase: selection.phase });
      selected = plan.operations.filter(({ phase }) => phase === selection.phase);
      mobileStage = 'predecessor-chain';
      validateReleaseReceiptChain(priorReceipts, plan, { through: 'workload' });
      mobileStage = 'publish';
      if (journalMutationCount === 0) {
        mobilePublishedPaths = await publishControlledMobileArtifacts(mobileExecution, {
          stateStore,
          releaseJournalAttemptId,
          existingIntent: existingJournalIntent,
          writeArtifact: writeControlledArtifact,
        });
        journalMutationCount = 1;
        existingJournalIntent = null;
        resumeOperationId = null;
        openJournalRecords = stateStore.records;
      }
      task8Attestations.mobile = true;
    } catch (error) {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed',
        code: error?.code === 'MOBILE_PREBUILT_EVIDENCE_FORBIDDEN'
          ? error.code : `MOBILE_CONTROLLED_${mobileStage.toUpperCase()}_INVALID`,
        mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  if (selection.phase === 'workload') {
    let workloadStage = 'journal';
    try {
      if (!unresolvedTask8Contract(plan.task8Evidence.workload)) {
        const error = new Error('Pre-existing workload evidence is forbidden');
        error.code = 'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN';
        throw error;
      }
      if (typeof openStateStore !== 'function' || typeof journalAttemptId !== 'function') {
        throw new Error('Release journal is unavailable');
      }
      releaseJournalAttemptId = journalAttemptId();
      stateStore = await openStateStore({
        receiptDirectory: plan.releaseReceiptDirectory,
        releaseSha: plan.releaseSha,
        releaseIdentitySha256: plan.releaseIdentitySha256,
        phase: selection.phase,
        phasePlanSha256: canonicalSha256({
          releaseIdentitySha256: plan.releaseIdentitySha256,
          phase: 'workload',
          operationId: 'workload-evidence-publish',
          paths: [
            plan.task8Evidence.workload.privacyProofs.start.filePath,
            plan.task8Evidence.workload.privacyProofs.end.filePath,
            plan.task8Evidence.workload.filePath,
          ],
        }),
        attemptId: releaseJournalAttemptId,
        receiptHeadSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
        now,
        workspaceRoot: APP_ROOT,
      });
      if (!stateStore || !Array.isArray(stateStore.records)
        || !['appendIntent', 'appendCheckpoint', 'appendTerminal', 'close']
          .every((key) => typeof stateStore[key] === 'function')) {
        throw new Error('Release journal is invalid');
      }
      releaseJournalAttemptId = stateStore.attemptId ?? releaseJournalAttemptId;
      const lastTerminalIndex = stateStore.records.findLastIndex(
        (record) => record.recordType === 'terminal',
      );
      openJournalRecords = stateStore.records.slice(lastTerminalIndex + 1);
      if (openJournalRecords.length > 0) {
        validateReconciliationPrefix({
          operationIds: ['workload-evidence-publish'], records: openJournalRecords,
        });
        hasOpenJournalAttempt = true;
        existingJournalIntent = openJournalRecords.at(-1)?.recordType === 'intent'
          ? openJournalRecords.at(-1) : null;
        journalMutationCount = openJournalRecords.some(({ recordType }) => (
          recordType === 'checkpoint'
        )) ? 1 : 0;
        const publicationIntent = openJournalRecords.find(({ recordType, operationId }) => (
          recordType === 'intent' && operationId === 'workload-evidence-publish'
        ));
        if (!publicationIntent) throw new Error('Workload publication intent is unavailable');
        workloadExecution = controlledWorkloadFromPublication(
          plan, publicationIntent.payload.publication,
          { validatePrivacyProof: validateWorkloadPrivacyProof },
        );
        resumeOperationId = existingJournalIntent?.operationId ?? null;
      } else {
        workloadStage = 'executor';
        workloadPrivacyExecutor = execute ?? createDefaultGcloudExecutor({ environment });
        let tokenExecutor = workloadPrivacyTokenExecutor;
        if (tokenExecutor === undefined) {
          tokenExecutor = createDefaultIdentityTokenExecutor(environment);
        }
        workloadStage = 'producer';
        workloadExecution = await executeControlledWorkload(plan, {
          environment,
          executor: workloadPrivacyExecutor,
          executeWorkload,
          workloadFetch,
          randomUUID,
          now,
          tokenExecutor,
          privacyFetch: workloadPrivacyFetch,
          privacyNonce: workloadPrivacyNonce,
          privacySleep: workloadPrivacySleep,
          privacyProofRunner: workloadPrivacyProofRunner,
          producePrivacyArtifact: produceWorkloadPrivacyArtifact,
        });
      }
      workloadStage = 'plan';
      plan = buildReleasePlan({
        ...input,
        task8Evidence: {
          ...input.task8Evidence,
          workload: workloadExecution.evidence,
        },
      }, { phase: selection.phase });
      selected = plan.operations.filter(({ phase }) => phase === selection.phase);
      workloadStage = 'predecessor-chain';
      validateReleaseReceiptChain(priorReceipts, plan, { through: 'readiness' });
      workloadStage = 'publish';
      if (journalMutationCount === 0) {
        workloadPublishedPaths = await publishControlledWorkloadArtifacts(workloadExecution, {
          stateStore,
          releaseJournalAttemptId,
          existingIntent: existingJournalIntent,
          writeArtifact: writeControlledArtifact,
        });
        journalMutationCount = 1;
        existingJournalIntent = null;
        resumeOperationId = null;
        openJournalRecords = stateStore.records;
      }
      workloadStage = 'verify';
      const verified = await verifyTask8Evidence(
        workloadExecution.evidence, 'workload', plan, {
          now: now(),
          gateWindow: {
            gateStartedAt: workloadExecution.execution.gateStartedAt,
            gateEndedAt: workloadExecution.execution.gateEndedAt,
          },
        },
      );
      if (verified !== true && !exact(verified, workloadExecution.attestation)) {
        throw new Error('Published workload evidence differs from controlled execution');
      }
      task8Attestations.workload = workloadExecution.attestation;
    } catch (error) {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed',
        code: [
          'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN',
          'WORKLOAD_CONTROLLED_ARTIFACT_INVALID',
          'WORKLOAD_CONTROLLED_NETWORK_INVALID',
        ].includes(error?.code) || String(error?.code ?? '').startsWith('WORKLOAD_CONTROLLED_NETWORK_')
          ? error.code : `WORKLOAD_CONTROLLED_${workloadStage.toUpperCase()}_INVALID`,
        mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  const mutationMembers = selected.filter(({ id }) => operationMayMutate(id));
  const mutationPlanIdentities = mutationMembers.map((member) => (
    releaseMutationPlanIdentity(plan, member)
  ));
  const finalPublicMutations = mutationPlanIdentities.filter(({ finalPublicMutation }) => (
    finalPublicMutation
  ));
  if (finalPublicMutations.length > 1) {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'RELEASE_STATE_INVALID', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
    });
  }
  const finalMutationGuard = finalPublicMutations.length === 1
    ? createFinalMutationGuard({
      finalOperationId: finalPublicMutations[0].operationId,
      mutationOperationIds: mutationMembers.map(({ id }) => id),
    }) : null;
  const releasePhasePlanSha256 = mutationMembers.length > 0 ? canonicalSha256({
    releaseIdentitySha256: plan.releaseIdentitySha256,
    semanticReleaseSpecSha256: plan.semanticReleaseSpecSha256,
    phase: selection.phase,
    operations: selected.map(({ id, argv: operationArgv }) => ({ id, argv: operationArgv })),
    mutationContracts: mutationPlanIdentities,
  }) : null;
  if (mutationMembers.length > 0 && stateStore === null) {
    try {
      if (typeof openStateStore !== 'function' || typeof journalAttemptId !== 'function') {
        throw new Error('Release journal is unavailable');
      }
      releaseJournalAttemptId = journalAttemptId();
      stateStore = await openStateStore({
        receiptDirectory: plan.releaseReceiptDirectory,
        releaseSha: plan.releaseSha,
        releaseIdentitySha256: plan.releaseIdentitySha256,
        phase: selection.phase,
        phasePlanSha256: releasePhasePlanSha256,
        attemptId: releaseJournalAttemptId,
        receiptHeadSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
        now,
        workspaceRoot: APP_ROOT,
      });
      if (!stateStore || !Array.isArray(stateStore.records)
        || !['appendIntent', 'appendCheckpoint', 'appendTerminal', 'close']
          .every((key) => typeof stateStore[key] === 'function')) {
        throw new Error('Release journal is invalid');
      }
      releaseJournalAttemptId = stateStore.attemptId ?? releaseJournalAttemptId;
      const failedExecutionTombstone = failedExecutionTerminalTombstone(
        stateStore.records, plan, releasePhasePlanSha256,
      );
      if (failedExecutionTombstone !== null) {
        await stateStore.close();
        return publish(writeOutput, 1, {
          status: 'failed', code: failedExecutionTombstone.terminalState.code,
          tombstoned: true,
          mutationPerformed: false, releaseSha: plan.releaseSha,
          phase: selection.phase,
          completed: [...failedExecutionTombstone.completed],
          recoveredOperationId: failedExecutionTombstone.operationId,
          evidence: failedExecutionTombstone.evidence,
        });
      }
      const lastTerminalIndex = stateStore.records.findLastIndex(
        (record) => record.recordType === 'terminal',
      );
      openJournalRecords = stateStore.records.slice(lastTerminalIndex + 1);
      if (openJournalRecords.length > 0) {
        const failedExecutionAbortTail = openJournalRecords.at(-1);
        if (failedExecutionAbortTail?.recordType === 'abort'
          && failedExecutionAbortTail.payload?.reason
            === 'authoritative-cloud-run-execution-failed') {
          try {
            await appendFailedExecutionTerminal(stateStore, failedExecutionAbortTail, plan);
          } catch {
            await stateStore.close().catch(() => undefined);
            return publish(writeOutput, 1, {
              status: 'failed', code: 'RELEASE_JOURNAL_WRITE_FAILED',
              mutationPerformed: false, releaseSha: plan.releaseSha,
              phase: selection.phase, completed: [],
            });
          }
          await stateStore.close();
          return publish(writeOutput, 1, {
            status: 'failed', code: 'CLOUD_RUN_EXECUTION_FAILURE_TERMINAL_RECOVERED',
            mutationPerformed: false, releaseSha: plan.releaseSha,
            phase: selection.phase,
            completed: openJournalRecords
              .filter(({ recordType }) => recordType === 'checkpoint')
              .map(({ operationId }) => operationId),
            recoveredOperationId: failedExecutionAbortTail.operationId,
            evidence: failedExecutionAbortTail.payload.evidence,
          });
        }
        validateReconciliationPrefix({
          operationIds: mutationMembers.map(({ id }) => id),
          records: openJournalRecords,
        });
        hasOpenJournalAttempt = true;
        journalMutationCount = openJournalRecords.filter(
          (record) => record.recordType === 'checkpoint',
        ).length;
        existingJournalIntent = openJournalRecords.at(-1)?.recordType === 'intent'
          ? openJournalRecords.at(-1) : null;
        if (finalMutationGuard && openJournalRecords.some((record) => (
          record.recordType === 'intent'
          && record.operationId === finalPublicMutations[0].operationId
        ))) finalMutationGuard.afterOperation(finalPublicMutations[0].operationId);
        resumeOperationId = existingJournalIntent?.operationId
          ?? mutationMembers[journalMutationCount]?.id
          ?? null;
      }
    } catch {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed', code: 'RELEASE_STATE_INVALID', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  const evidenceSecretVersions = {};
  let executor;
  let receiptValidationPlan = plan;
  if (hasOpenJournalAttempt && resumeOperationId === null
    && ['inventory', 'evidence'].includes(selection.phase)) {
    try {
      executor = execute ?? createReleaseGcloudExecutor({ environment });
      const phaseKeys = selection.phase === 'inventory'
        ? ['legacyInventory']
        : Object.keys(plan.evidence).filter((key) => key !== 'legacyInventory');
      for (const key of phaseKeys) {
        evidenceSecretVersions[key] = await reconstructCheckpointedEvidenceVersion({
          executor,
          plan,
          records: openJournalRecords,
          attemptId: stateStore.attemptId,
          key,
          phase: selection.phase,
        });
      }
      receiptValidationPlan = buildPlanWithAssignedEvidenceVersions(
        input, selection.phase, evidenceSecretVersions,
      );
    } catch {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed', code: 'RELEASE_PHASE_FAILED', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  let reconstructCheckpointedPhase = false;
  if (hasOpenJournalAttempt && resumeOperationId === null && receiptBackedPhase) {
    let phaseReceipt;
    try {
      phaseReceipt = typeof loadPhaseReceipt === 'function'
        ? await loadPhaseReceipt(receiptValidationPlan, selection.phase, priorReceipts, {
          attemptId: stateStore.attemptId,
          records: stateStore.records,
        }) : null;
      if (phaseReceipt !== null) {
        if (ACTION_RECEIPT_PHASES.has(selection.phase)) {
          validateReleaseActionReceipt(
            phaseReceipt, selection.phase, receiptValidationPlan, priorReceipts, stateStore,
          );
        } else {
          validateReleaseReceiptChain([...priorReceipts, phaseReceipt], receiptValidationPlan, {
            through: selection.phase,
            candidatePrivacyAnchor: receiptChainAuthorities.get(priorReceipts)
              ?? priorReceipts.candidatePrivacyAnchor,
          });
        }
      }
    } catch {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed', code: 'RELEASE_RECEIPT_CHAIN_INVALID', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
    if (phaseReceipt !== null) {
      try {
        if (typeof recoverTerminal !== 'function') throw new Error('Terminal recovery unavailable');
        await recoverTerminal({
          records: stateStore.records,
          receipt: phaseReceipt,
          terminalState: {
            completed: [...phaseReceipt.completed],
            mutationCount: journalMutationCount,
            phase: selection.phase,
          },
          appendTerminal: (payload) => stateStore.appendTerminal(payload),
        });
        await stateStore.close();
        return publish(writeOutput, 0, {
          status: 'phase-complete', code: 'GCP_RELEASE_PHASE_COMPLETE',
          mutationPerformed: false, recoveredTerminal: true,
          releaseSha: plan.releaseSha, phase: selection.phase,
          completed: [...phaseReceipt.completed], phaseReceipt,
        });
      } catch {
        await stateStore?.close().catch(() => undefined);
        return publish(writeOutput, 1, {
          status: 'failed', code: 'RELEASE_JOURNAL_WRITE_FAILED', mutationPerformed: false,
          releaseSha: plan.releaseSha, phase: selection.phase,
          completed: [...phaseReceipt.completed],
        });
      }
    }
    reconstructCheckpointedPhase = true;
  }
  try {
    const task8Phases = ['promote', 'rollback'].includes(selection.phase)
      ? ['readiness', 'workload', 'mobile']
      : (['readiness', 'mobile'].includes(selection.phase) ? [selection.phase] : []);
    for (const phase of task8Phases) {
      if (typeof verifyTask8Evidence !== 'function') {
        throw new Error('Task 8 evidence verification failed');
      }
      const workloadReceiptExecution = phase === 'workload'
        ? priorReceipts.find((value) => value.phase === 'workload')?.outputs?.execution
        : null;
      const gateWindow = workloadReceiptExecution === null || workloadReceiptExecution === undefined
        ? null : {
          gateStartedAt: workloadReceiptExecution.gateStartedAt,
          gateEndedAt: workloadReceiptExecution.gateEndedAt,
        };
      const validationClock = reconstructCheckpointedPhase && selection.phase === phase
        ? new Date(openJournalRecords.at(-1)?.createdAt)
        : now();
      const verified = await verifyTask8Evidence(plan.task8Evidence[phase], phase, plan, {
        now: validationClock, gateWindow, historical: selection.phase !== phase,
      });
      if (verified !== true && !(phase === 'workload' && verified
        && typeof verified === 'object' && !Array.isArray(verified))) {
        throw new Error('Task 8 evidence verification failed');
      }
      task8Attestations[phase] = verified;
      if (selection.phase === 'promote' && phase === 'workload' && verified !== true) {
        const receipt = priorReceipts.find((value) => value.phase === 'workload');
        if (receipt?.outputs?.execution?.acceptanceWindowId !== verified.acceptanceWindowId) {
          throw new Error('Workload execution receipt differs from fresh evidence');
        }
      }
    }
  } catch {
    await stateStore?.close().catch(() => undefined);
    return publish(writeOutput, 1, {
      status: 'failed', code: 'TASK8_EVIDENCE_INVALID', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
    });
  }
  try {
    executor ??= readinessExecutor ?? mobileExecutor ?? workloadPrivacyExecutor ?? execute ?? (selected.length > 0 || task8Attestations.workload !== undefined
      ? createReleaseGcloudExecutor({ environment })
      : async () => { throw new Error('No control-plane operation is planned'); });
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'CONTROL_PLANE_UNAVAILABLE', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase,
    });
  }
  const failedExecutionLogPath = environment?.V1_FAILED_EXECUTION_LOG_PATH;
  const failedExecutionLogSha256 = environment?.V1_FAILED_EXECUTION_LOG_SHA256;
  const failedExecutionAuditLogPath = environment?.V1_FAILED_EXECUTION_AUDIT_LOG_PATH;
  const failedExecutionAuditLogSha256 = environment?.V1_FAILED_EXECUTION_AUDIT_LOG_SHA256;
  const failedExecutionRecoveryRequested = [
    failedExecutionLogPath,
    failedExecutionLogSha256,
    failedExecutionAuditLogPath,
    failedExecutionAuditLogSha256,
  ].some((value) => value !== undefined);
  if (failedExecutionRecoveryRequested) {
    try {
      if (selection.phase !== 'acceptance' || !hasOpenJournalAttempt
        || failedAcceptanceExecutionContract(existingJournalIntent?.operationId) === null
        || existingJournalIntent?.payload?.reconcileKind !== 'cloud-run-job-execute'
        || typeof failedExecutionLogPath !== 'string'
        || !DIGEST.test(String(failedExecutionLogSha256 ?? ''))
        || typeof failedExecutionAuditLogPath !== 'string'
        || !DIGEST.test(String(failedExecutionAuditLogSha256 ?? ''))) {
        throw new Error('Cloud Run failed execution recovery request is invalid');
      }
      const recoveredOperationId = existingJournalIntent.operationId;
      const evidence = await recoverFailedAcceptanceExecute({
        stateStore,
        plan,
        intent: existingJournalIntent,
        executor,
        logPath: failedExecutionLogPath,
        expectedLogSha256: failedExecutionLogSha256,
        auditLogPath: failedExecutionAuditLogPath,
        expectedAuditLogSha256: failedExecutionAuditLogSha256,
      });
      await stateStore.close();
      return publish(writeOutput, 1, {
        status: 'failed', code: 'CLOUD_RUN_EXECUTION_FAILURE_RECOVERED',
        mutationPerformed: false, releaseSha: plan.releaseSha, phase: selection.phase,
        completed: openJournalRecords
          .filter(({ recordType }) => recordType === 'checkpoint')
          .map(({ operationId }) => operationId),
        recoveredOperationId,
        evidence,
      });
    } catch (error) {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed',
        code: error?.code === 'RELEASE_JOURNAL_WRITE_FAILED'
          ? error.code : 'CLOUD_RUN_EXECUTION_FAILURE_EVIDENCE_INVALID',
        mutationPerformed: false, releaseSha: plan.releaseSha, phase: selection.phase,
        completed: [],
      });
    }
  }
  const rejectedExecutionLogPath = environment?.V1_REJECTED_EXECUTION_LOG_PATH;
  const rejectedExecutionLogSha256 = environment?.V1_REJECTED_EXECUTION_LOG_SHA256;
  if (rejectedExecutionLogPath !== undefined || rejectedExecutionLogSha256 !== undefined) {
    try {
      if (selection.phase !== 'acceptance' || !hasOpenJournalAttempt
        || existingJournalIntent?.payload?.reconcileKind !== 'cloud-run-job-execute'
        || typeof rejectedExecutionLogPath !== 'string'
        || !DIGEST.test(String(rejectedExecutionLogSha256 ?? ''))) {
        throw new Error('Cloud Run rejection recovery request is invalid');
      }
      const evidence = await recoverRejectedAcceptanceExecute({
        stateStore,
        plan,
        intent: existingJournalIntent,
        executor,
        logPath: rejectedExecutionLogPath,
        expectedLogSha256: rejectedExecutionLogSha256,
      });
      const recoveredOperationId = existingJournalIntent.operationId;
      await stateStore.close();
      return publish(writeOutput, 1, {
        status: 'failed', code: 'CLOUD_RUN_EXECUTION_REJECTION_RECOVERED',
        mutationPerformed: false, releaseSha: plan.releaseSha, phase: selection.phase,
        completed: openJournalRecords
          .filter(({ recordType }) => recordType === 'checkpoint')
          .map(({ operationId }) => operationId),
        recoveredOperationId,
        evidence,
      });
    } catch {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed', code: 'CLOUD_RUN_EXECUTION_REJECTION_EVIDENCE_INVALID',
        mutationPerformed: false, releaseSha: plan.releaseSha, phase: selection.phase,
        completed: [],
      });
    }
  }
  const completed = [];
  let evidencePublicationPayloads = Object.freeze({});
  const evidenceVersionReadbacks = new Map();
  const collectedEvidence = {};
  const collectedObjectReceipts = new Map();
  const candidateReadbacks = {};
  let candidatePrivacyReference = null;
  let promotionPrivacyReference = null;
  let promotionBarrierSha256 = null;
  const promotionReadbacks = {};
  const promotionStableReadbacks = {};
  let buildReceipt = null;
  let migrationExecutionReceipt = null;
  let migrationExecutionName = null;
  const acceptanceExecutionNames = {};
  const acceptanceExecutionReceipts = {};
  const mutationBeforeObservations = new Map();
  let mutationAttempted = false;
  let pendingJournal = null;
  let promotionIamBaseline = null;
  let stablePublicIamBaseline = null;
  let stablePriorRevisionBaseline = null;
  let stablePriorArtifactBaseline = null;
  let candidateDeployMutationAttempted = false;
  let candidateIamMutationAttempted = false;
  let promotionStableMutationAttempted = false;
  let promotionIamMutationAttempted = false;
  let promotionTrafficMutationAttempted = false;
  let candidateCleanupState = null;
  let activeOperationId = null;
  let resumeBoundaryReached = !hasOpenJournalAttempt;
  const restartMutationsToRetry = new Set();
  const responseLossRecoveries = [];
  const restartAdoptions = new Set();
  if (task8Attestations.workload && task8Attestations.workload !== true) {
    try {
      const attestation = task8Attestations.workload;
      const rawLogs = await executor(workloadLoggingReadArgv(attestation));
      const normalized = normalizeControlPlaneTurnReceipts(rawLogs, {
        acceptanceWindowId: attestation.acceptanceWindowId,
        candidateOrigin: attestation.candidateOrigin,
        candidateRevision: attestation.candidateRevision,
        expectedTraceIds: attestation.expectedTraceIds,
      });
      if (!normalized || !exact(normalized, attestation.controlPlaneRequests)) {
        throw new Error('workload request logs differ from the evidence artifact');
      }
    } catch {
      return publish(writeOutput, 1, {
        status: 'failed', code: 'WORKLOAD_CONTROL_PLANE_INVALID', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  try {
    if (hasOpenJournalAttempt && !reconstructCheckpointedPhase
      && ['inventory', 'evidence'].includes(selection.phase)) {
      const phaseKeys = selection.phase === 'inventory'
        ? ['legacyInventory']
        : Object.keys(plan.evidence).filter((key) => key !== 'legacyInventory');
      for (const key of phaseKeys) {
        const operationId = `${selection.phase}-publish:${key}`;
        const checkpointed = openJournalRecords.some((record) => (
          record.recordType === 'checkpoint' && record.operationId === operationId
        ));
        if (!checkpointed) continue;
        evidenceSecretVersions[key] = await reconstructCheckpointedEvidenceVersion({
          executor,
          plan,
          records: openJournalRecords,
          attemptId: stateStore.attemptId,
          key,
          phase: selection.phase,
        });
      }
    }
    if (reconstructCheckpointedPhase) {
      const checkpoint = openJournalRecords.at(-1);
      if (ACTION_RECEIPT_PHASES.has(selection.phase)) {
        if (checkpoint?.recordType !== 'checkpoint') {
          throw new Error('Checkpointed action phase cannot reconstruct its outcome sidecar');
        }
      } else if (selection.phase === 'readiness' && checkpoint?.recordType === 'checkpoint'
        && checkpoint.payload?.safeResult?.kind === 'artifact-bundle') {
        if (checkpoint.payload.safeResult.artifactCount !== 3
          || checkpoint.payload.safeResult.bundleSha256
            !== openJournalRecords.find(({ recordType }) => recordType === 'intent')
              ?.payload?.publication?.bundleSha256) {
          throw new Error('Checkpointed readiness publication differs from its intent');
        }
      } else if (selection.phase === 'workload' && checkpoint?.recordType === 'checkpoint'
        && checkpoint.payload?.safeResult?.kind === 'artifact-bundle') {
        const workloadPublicationIntent = openJournalRecords.find(
          ({ recordType }) => recordType === 'intent',
        )?.payload?.publication;
        if (checkpoint.payload.safeResult.artifactCount !== 3
          || checkpoint.payload.safeResult.bundleSha256 !== workloadPublicationIntent?.bundleSha256
          || checkpoint.payload.observationSha256 !== canonicalSha256(workloadPublicationIntent)) {
          throw new Error('Checkpointed workload publication differs from its intent');
        }
      } else if (selection.phase === 'mobile' && checkpoint?.recordType === 'checkpoint'
        && checkpoint.payload?.safeResult?.kind === 'artifact-bundle') {
        if (checkpoint.payload.safeResult.artifactCount !== 7
          || checkpoint.payload.safeResult.bundleSha256
            !== openJournalRecords.find(({ recordType }) => recordType === 'intent')
              ?.payload?.publication?.bundleSha256) {
          throw new Error('Checkpointed mobile publication differs from its intent');
        }
      } else if (selection.phase === 'build' && checkpoint?.recordType === 'checkpoint'
        && checkpoint.payload?.safeResult?.kind === 'build') {
        const rawBuild = await executor([
          'builds', 'describe', checkpoint.payload.safeResult.buildId,
          `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
        ]);
        buildReceipt = validateBuildReceipt(rawBuild, plan);
        if (buildReceipt.buildId !== checkpoint.payload.safeResult.buildId
          || buildReceipt.buildReceiptSha256 !== checkpoint.payload.safeResult.receiptSha256) {
          throw new Error('Checkpointed build receipt differs from the authoritative build');
        }
      } else if (selection.phase === 'migration' && checkpoint?.recordType === 'checkpoint') {
        migrationExecutionReceipt = await reconstructCheckpointedJobExecution({
          executor,
          plan,
          records: openJournalRecords,
          attemptId: stateStore.attemptId,
          deployOperationId: 'migration-deploy',
          executeOperationId: 'migration-execute',
          expectedJob: plan.expectedMigrationJob,
          validateExecution: (raw) => validateMigrationExecutionReceipt(raw, {
            releaseSha: plan.releaseSha,
          }),
        });
      } else if (selection.phase === 'acceptance' && checkpoint?.recordType === 'checkpoint') {
        for (const [key, expectedJob] of Object.entries(plan.expectedJobs)) {
          acceptanceExecutionReceipts[key] = await reconstructCheckpointedJobExecution({
            executor,
            plan,
            records: openJournalRecords,
            attemptId: stateStore.attemptId,
            deployOperationId: `${key}-deploy`,
            executeOperationId: `${key}-execute`,
            expectedJob,
            validateExecution: (raw) => validateReleaseJobExecutionReceipt(raw, expectedJob),
          });
        }
      } else if (selection.phase === 'inventory' && checkpoint?.recordType === 'checkpoint') {
        if (!NUMERIC_VERSION.test(String(evidenceSecretVersions.legacyInventory ?? ''))) {
          evidenceSecretVersions.legacyInventory = await reconstructCheckpointedEvidenceVersion({
            executor,
            plan,
            records: openJournalRecords,
            attemptId: stateStore.attemptId,
            key: 'legacyInventory',
            phase: 'inventory',
          });
        }
      } else if (selection.phase === 'evidence' && checkpoint?.recordType === 'checkpoint') {
        for (const key of Object.keys(plan.evidence)) {
          if (key === 'legacyInventory') continue;
          if (!NUMERIC_VERSION.test(String(evidenceSecretVersions[key] ?? ''))) {
            evidenceSecretVersions[key] = await reconstructCheckpointedEvidenceVersion({
              executor,
              plan,
              records: openJournalRecords,
              attemptId: stateStore.attemptId,
              key,
              phase: 'evidence',
            });
          }
        }
        for (const key of Object.keys(plan.acceptanceOutputs)) {
          const operationId = `evidence-output-delete:${key}`;
          const member = plan.operations.find(({ id }) => id === operationId);
          const readback = plan.operations.find(
            ({ id }) => id === `evidence-output-delete-readback:${key}`,
          );
          if (!member || !readback) {
            throw new Error('Checkpointed evidence deletion is unavailable');
          }
          const residue = await executor([...readback.argv]);
          if (!Array.isArray(residue) || residue.length !== 0) {
            throw new Error('Checkpointed evidence output is no longer absent');
          }
          validateResourceSafeResult(
            plan,
            member,
            checkpointSafeResult(openJournalRecords, stateStore.attemptId, operationId),
            residue,
          );
        }
        const zeroReadback = plan.operations.find(
          ({ id }) => id === 'evidence-output-zero-readback',
        );
        if (!zeroReadback) throw new Error('Evidence residue readback is unavailable');
        const residue = await executor([...zeroReadback.argv]);
        if (!Array.isArray(residue) || residue.length !== 0) {
          throw new Error('Checkpointed evidence output residue remains');
        }
      } else if (selection.phase === 'collect' && checkpoint?.recordType === 'checkpoint') {
        if (typeof inspectCollected !== 'function') {
          throw new Error('Collected evidence inspector is unavailable');
        }
        for (const [key, output] of Object.entries(plan.acceptanceOutputs)) {
          const operationId = `evidence-collect-copy:${key}`;
          const readback = plan.operations.find(
            ({ id }) => id === `evidence-collect-describe:${key}`,
          );
          if (!readback) throw new Error('Collected object readback is unavailable');
          const objectReceipt = validateAcceptanceObjectReceipt(
            await executor([...readback.argv]), output,
          );
          const inspected = await inspectCollected(
            output.filePath, { releaseSha: plan.releaseSha, kind: key },
          );
          if (inspected.byteLength !== objectReceipt.size) {
            throw new Error('Checkpointed collected evidence bytes differ from the object');
          }
          validateObjectSafeResult(
            checkpointSafeResult(openJournalRecords, stateStore.attemptId, operationId),
            output,
            inspected,
          );
          collectedEvidence[key] = Object.freeze({
            artifactSha256: inspected.artifactSha256,
            objectSha256: inspected.objectSha256,
            byteLength: inspected.byteLength,
          });
        }
      } else if (selection.phase === 'candidate' && checkpoint?.recordType === 'checkpoint') {
        Object.assign(candidateReadbacks, await readCandidateControlPlaneState(executor, plan));
        for (const [operationId, observed] of [
          ['candidate-deploy', {
            artifact: candidateReadbacks.artifact,
            revision: candidateReadbacks.revision,
            service: candidateReadbacks.service,
          }],
          ['candidate-private-iam-grant', candidateReadbacks.iam],
        ]) {
          const member = plan.operations.find(({ id }) => id === operationId);
          if (!member) throw new Error('Checkpointed candidate mutation is unavailable');
          validateResourceSafeResult(
            plan,
            member,
            checkpointSafeResult(openJournalRecords, stateStore.attemptId, operationId),
            observed,
          );
        }
        const privacyIntent = openJournalRecords.find(({ recordType, operationId }) => (
          recordType === 'intent' && operationId === 'candidate-privacy-publish'
        ));
        if (!privacyIntent) throw new Error('Checkpointed candidate privacy proof is unavailable');
        const proofRecord = JSON.parse(Buffer.from(
          privacyIntent.payload.publication.artifacts[0].contentsBase64, 'base64',
        ).toString('utf8'));
        candidatePrivacyReference = privacyArtifactFromPublication(
          plan,
          { filePath: plan.candidatePrivacyProofPath },
          privacyIntent.payload.publication,
          { now: new Date(proofRecord.occurredAt), validatePrivacyProof: validateReleasePrivacyProof },
        ).reference;
      } else if (selection.phase === 'promote' && checkpoint?.recordType === 'checkpoint') {
        const privacyIntent = openJournalRecords.find(({ recordType, operationId }) => (
          recordType === 'intent' && operationId === 'promote-privacy-publish'
        ));
        if (!privacyIntent) throw new Error('Checkpointed promotion privacy proof is unavailable');
        const proofRecord = JSON.parse(Buffer.from(
          privacyIntent.payload.publication.artifacts[0].contentsBase64, 'base64',
        ).toString('utf8'));
        promotionPrivacyReference = privacyArtifactFromPublication(
          plan,
          { filePath: promotionAttemptPrivacyProofPath(plan, releaseJournalAttemptId) },
          privacyIntent.payload.publication,
          { now: new Date(proofRecord.occurredAt), validatePrivacyProof: validateReleasePrivacyProof },
        ).reference;
      } else {
        throw new Error('Checkpointed release phase cannot reconstruct its receipt');
      }
    }
    if (selection.phase === 'candidate'
      && resumeOperationId === 'candidate-private-iam-grant') {
      Object.assign(candidateReadbacks, await readCandidateControlPlaneState(executor, plan));
    }
    if (selection.phase === 'candidate'
      && resumeOperationId === 'candidate-privacy-publish') {
      Object.assign(candidateReadbacks, await readCandidateControlPlaneState(executor, plan));
    }
    if (selection.phase === 'promote' && plan.previousRevision === null
      && ['candidate-cleanup-delete', 'promote-stable-deploy', 'promote-public-service']
        .includes(resumeOperationId)) {
      const authority = await executor([
        'auth', 'list', '--filter=status:ACTIVE', '--format=json',
      ]);
      if (!Array.isArray(authority) || authority.length !== 1
        || authority[0]?.account !== PROMOTION_AUTHORITY
        || authority[0]?.status !== 'ACTIVE') {
        throw new Error('Public promotion authority is not approved');
      }
      promotionPrivacyReference = promotionPrivacyReferenceFromJournal(
        plan, openJournalRecords, releaseJournalAttemptId, {
          validatePrivacyProof: validateReleasePrivacyProof,
        },
      );
      if (resumeOperationId === 'candidate-cleanup-delete') {
        await assertCloudRunServiceAbsent(executor, STABLE_SERVICE);
        if (existingJournalIntent?.operationId === 'candidate-cleanup-delete') {
          try {
            const candidate = await readCandidateControlPlaneState(executor, plan);
            const proofNow = now();
            if (promotionProofExpired(promotionPrivacyReference, proofNow)) {
              await closePromotionAttemptForReproof(stateStore);
              const error = new Error('Promotion privacy proof expired before candidate handoff');
              error.code = 'PROMOTION_REPROOF_REQUIRED';
              throw error;
            }
            await verifyReleasePrivacyArtifact(
              promotionPrivacyReference,
              plan,
              proofNow,
              'Promotion privacy proof is invalid',
              validateReleasePrivacyProof,
            );
            mutationBeforeObservations.set('candidate-cleanup-delete', candidate.service);
            restartMutationsToRetry.add('candidate-cleanup-delete');
          } catch (error) {
            if (error?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
          }
        } else {
          const proofNow = now();
          if (promotionProofExpired(promotionPrivacyReference, proofNow)) {
            await closePromotionAttemptForReproof(stateStore);
            const error = new Error('Promotion privacy proof expired before candidate handoff');
            error.code = 'PROMOTION_REPROOF_REQUIRED';
            throw error;
          }
          await verifyReleasePrivacyArtifact(
            promotionPrivacyReference,
            plan,
            proofNow,
            'Promotion privacy proof is invalid',
            validateReleasePrivacyProof,
          );
          const candidate = await readCandidateControlPlaneState(executor, plan);
          mutationBeforeObservations.set('candidate-cleanup-delete', candidate.service);
        }
      } else if (resumeOperationId === 'promote-stable-deploy') {
        await assertCloudRunServiceAbsent(executor, CANDIDATE_SERVICE);
        if (existingJournalIntent?.operationId === 'promote-stable-deploy') {
          try {
            await readStableStagedControlPlaneState(executor, plan);
          } catch (error) {
            if (error?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
            await assertCloudRunServiceAbsent(executor, STABLE_SERVICE);
            if (typeof writeStableSpec !== 'function' || await writeStableSpec(plan) !== true) {
              throw new Error('Stable Service YAML is unavailable');
            }
            mutationBeforeObservations.set('promote-stable-deploy', { state: 'absent' });
            restartMutationsToRetry.add('promote-stable-deploy');
          }
        } else {
          await assertCloudRunServiceAbsent(executor, STABLE_SERVICE);
          if (typeof writeStableSpec !== 'function' || await writeStableSpec(plan) !== true) {
            throw new Error('Stable Service YAML is unavailable');
          }
          mutationBeforeObservations.set('promote-stable-deploy', { state: 'absent' });
        }
      } else {
        await assertCloudRunServiceAbsent(executor, CANDIDATE_SERVICE);
        const stable = await readStableStagedControlPlaneState(executor, plan, {
          allowPrivateOrPublicIam:
            existingJournalIntent?.operationId === 'promote-public-service',
        });
        if (existingJournalIntent?.operationId === 'promote-public-service') {
          let stableRemainsPrivate = false;
          try {
            validateServiceIamReceipt(
              stable.iam, { policy: 'stable-private', requireEtag: true },
            );
            stableRemainsPrivate = true;
          } catch {
            // Exact public IAM is the already-landed state and is adopted read-only below.
          }
          if (stableRemainsPrivate) {
            // Candidate deletion is already durable, so a fresh proof cannot be produced.
            // Retry only the exact journaled idempotent grant from its hash-bound before state.
            mutationBeforeObservations.set('promote-public-service', stable.iam);
            restartMutationsToRetry.add('promote-public-service');
          }
        }
      }
    }
    if (selection.phase === 'promote' && plan.previousRevision !== null
      && resumeOperationId === 'promote-public-service') {
      await readCandidateControlPlaneState(executor, plan);
      await readStableStagedControlPlaneState(executor, plan, { publicIam: true });
    }
    if (selection.phase === 'promote'
      && resumeOperationId === 'promote-stable-deploy'
      && plan.previousRevision !== null) {
      const authority = await executor([
        'auth', 'list', '--filter=status:ACTIVE', '--format=json',
      ]);
      if (!Array.isArray(authority) || authority.length !== 1
        || authority[0]?.account !== PROMOTION_AUTHORITY
        || authority[0]?.status !== 'ACTIVE') {
        throw new Error('Public promotion authority is not approved');
      }
      await readCandidateControlPlaneState(executor, plan);
      const stableIam = await executor([
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]);
      validateServiceIamReceipt(stableIam, { policy: 'stable-public', requireEtag: true });
      stablePublicIamBaseline = normalizeServiceIamPolicy(stableIam, { requireEtag: true });
      const priorRevision = await executor([
        'run', 'revisions', 'describe', plan.previousRevision,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]);
      validatePriorRevisionReadback(priorRevision, plan);
      const priorArtifact = await executor(artifactDescribeArgv(plan.previousImage));
      validateCandidateArtifact(priorArtifact, plan.previousImage);
    }
    if (selection.phase === 'collect') {
      const resumedCollectionKeys = openJournalRecords
        .map(({ operationId }) => operationId)
        .filter((operationId) => operationId?.startsWith('evidence-collect-copy:'))
        .map((operationId) => operationId.slice(operationId.indexOf(':') + 1));
      await assertCollectionDestinationsAbsent(plan.acceptanceOutputs, {
        permittedExistingKeys: resumedCollectionKeys,
      });
    } else if (selection.phase === 'inventory') {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      const validation = await verifyEvidence({ legacyInventory: plan.evidence.legacyInventory }, {
        releaseSha: plan.releaseSha, iosVoiceMode: 'historical',
      });
      evidencePublicationPayloads = freezeEvidencePublicationPayloads(
        validation, plan.evidence, selected,
      );
    } else if (selection.phase === 'evidence') {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      const validation = await verifyEvidence(plan.evidence, {
        releaseSha: plan.releaseSha, iosVoiceMode: 'current', iosVoiceNow: now(),
      });
      evidencePublicationPayloads = freezeEvidencePublicationPayloads(
        validation, plan.evidence, selected,
      );
    } else if (['candidate-cleanup', 'rollback'].includes(selection.phase)) {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      await verifyEvidence(plan.evidence, {
        releaseSha: plan.releaseSha, iosVoiceMode: 'historical',
      });
    }
    for (const member of selected) {
      const mandatoryFirstReleaseStableAbsenceRead = selection.phase === 'candidate'
        && plan.previousRevision === null
        && member.id === 'candidate-stable-service-precheck';
      if (hasOpenJournalAttempt && !resumeBoundaryReached
        && !mandatoryFirstReleaseStableAbsenceRead) {
        if (resumeOperationId !== null && member.id === resumeOperationId) {
          resumeBoundaryReached = true;
        } else {
          completed.push(member.id);
          continue;
        }
      }
      if (hasOpenJournalAttempt && resumeOperationId === null
        && !mandatoryFirstReleaseStableAbsenceRead) {
        completed.push(member.id);
        continue;
      }
      if (candidateCleanupState === 'already-absent'
        && member.id !== 'candidate-cleanup-absence-readback') continue;
      activeOperationId = member.id;
      let journalIntent = null;
      let journalAfterSha256 = null;
      let mutationAdapter = null;
      let mutationOrdinal = null;
      let executionBaseline = null;
      let finalPublicMutation = false;
      const restartingMutation = existingJournalIntent?.operationId === member.id;
      const retryingRestartMutation = restartingMutation
        && restartMutationsToRetry.has(member.id);
      const resumingCheckpointedJobExecution = hasOpenJournalAttempt
        && !restartingMutation && resumeOperationId === member.id
        && member.id.endsWith('-execute');
      if (resumingCheckpointedJobExecution) {
        const deployOperationId = member.id.replace(/-execute$/u, '-deploy');
        const expectedJob = member.id === 'migration-execute' ? plan.expectedMigrationJob
          : plan.expectedJobs[member.id.slice(0, -'-execute'.length)];
        if (!expectedJob) throw new Error('Checkpointed Job execution has no deployment authority');
        const rawJob = await revalidateCheckpointedJobDeployment({
          executor,
          plan,
          records: openJournalRecords,
          attemptId: stateStore.attemptId,
          deployOperationId,
          expectedJob,
        });
        mutationBeforeObservations.set(member.id, rawJob);
      }
      if (member.id === 'candidate-privacy-publish'
        || member.id === 'promote-privacy-publish') {
        const mutationOrdinal = restartingMutation
          ? existingJournalIntent.payload.mutationOrdinal : journalMutationCount + 1;
        const locator = Object.freeze({
          filePath: member.id === 'candidate-privacy-publish'
            ? plan.candidatePrivacyProofPath
            : promotionAttemptPrivacyProofPath(plan, releaseJournalAttemptId),
        });
        try {
          if (member.id === 'promote-privacy-publish') {
            const candidateReceipt = priorReceipts.find(({ phase }) => phase === 'candidate');
            const candidateProof = candidateReceipt?.outputs?.privacyProof;
            if (!candidateProof) throw new Error('Candidate privacy receipt is unavailable');
            await verifyReleasePrivacyArtifact(
              candidateProof,
              plan,
              new Date(candidateProof.observedAt),
              'Candidate privacy proof is invalid',
              validateReleasePrivacyProof,
            );
            for (const phase of ['readiness', 'workload', 'mobile']) {
              const workloadReceiptExecution = phase === 'workload'
                ? priorReceipts.find((value) => value.phase === 'workload')?.outputs?.execution
                : null;
              const verified = await verifyTask8Evidence(
                plan.task8Evidence[phase], phase, plan, {
                  now: now(),
                  historical: true,
                  gateWindow: workloadReceiptExecution ? {
                    gateStartedAt: workloadReceiptExecution.gateStartedAt,
                    gateEndedAt: workloadReceiptExecution.gateEndedAt,
                  } : null,
                },
              );
              if (verified !== true && !(phase === 'workload' && verified)) {
                throw new Error('Promotion evidence boundary drifted');
              }
            }
            await readCandidateControlPlaneState(executor, plan);
            if (plan.previousRevision === null) {
              await assertCloudRunServiceAbsent(executor, STABLE_SERVICE);
            } else {
              await readStableStagedControlPlaneState(executor, plan, { publicIam: true });
            }
          }
          let artifact;
          if (restartingMutation) {
            const proofRecord = JSON.parse(Buffer.from(
              existingJournalIntent.payload.publication.artifacts[0].contentsBase64, 'base64',
            ).toString('utf8'));
            const current = now();
            const expired = promotionProofExpired({ expiresAt: proofRecord.expiresAt }, current);
            artifact = privacyArtifactFromPublication(
              plan,
              locator,
              existingJournalIntent.payload.publication,
              {
                now: expired && member.id === 'promote-privacy-publish'
                  ? new Date(proofRecord.occurredAt) : current,
                validatePrivacyProof: validateReleasePrivacyProof,
              },
            );
            if (expired && member.id !== 'promote-privacy-publish') {
              throw new Error('Candidate privacy proof expired before publication recovery');
            }
          } else {
            let tokenExecutor = releasePrivacyTokenExecutor;
            if (tokenExecutor === undefined) {
              tokenExecutor = createDefaultIdentityTokenExecutor(environment);
            }
            artifact = await produceReleasePrivacyArtifact({
              plan,
              locator,
              executor,
              tokenExecutor,
              fetch: releasePrivacyFetch,
              now,
              nonce: releasePrivacyNonce,
              sleep: releasePrivacySleep,
              privacyProofRunner: releasePrivacyProofRunner,
            });
            artifact = privacyArtifactFromPublication(
              plan,
              locator,
              privacyPublication(artifact),
              { now: now(), validatePrivacyProof: validateReleasePrivacyProof },
            );
            finalMutationGuard?.beforeOperation(member.id);
          }
          const reference = await publishPrivacyArtifact(artifact, {
            stateStore,
            operationId: member.id,
            mutationOrdinal,
            releaseJournalAttemptId,
            existingIntent: restartingMutation ? existingJournalIntent : null,
            writeArtifact: writeReleasePrivacyArtifact,
          });
          if (member.id === 'candidate-privacy-publish') candidatePrivacyReference = reference;
          else promotionPrivacyReference = reference;
          journalMutationCount = mutationOrdinal;
          existingJournalIntent = null;
          completed.push(member.id);
          activeOperationId = null;
          if (member.id === 'promote-privacy-publish'
            && promotionProofExpired(reference, now())) {
            await closePromotionAttemptForReproof(stateStore);
            const error = new Error('Promotion privacy proof expired before final mutation');
            error.code = 'PROMOTION_REPROOF_REQUIRED';
            throw error;
          }
          continue;
        } catch (error) {
          if (String(error?.message ?? '').includes('journal')
            || String(error?.message ?? '').includes('intent')) {
            error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
          }
          throw error;
        }
      }
      if (operationMayMutate(member.id)) {
        if (pendingJournal !== null) {
          throw new Error('Prior release mutation lacks an authoritative checkpoint');
        }
        mutationOrdinal = restartingMutation
          ? existingJournalIntent.payload.mutationOrdinal : journalMutationCount + 1;
        finalPublicMutation = finalPublicMutations.some(({ operationId }) => (
          operationId === member.id
        ));
        if (selection.phase === 'promote' && plan.previousRevision === null
          && member.id === 'candidate-cleanup-delete'
          && (!restartingMutation || retryingRestartMutation)
          && promotionProofExpired(promotionPrivacyReference, now())) {
          await closePromotionAttemptForReproof(stateStore);
          const error = new Error('Promotion privacy proof expired before candidate handoff');
          error.code = 'PROMOTION_REPROOF_REQUIRED';
          throw error;
        }
        if (selection.phase === 'promote' && finalPublicMutation && !restartingMutation) {
          if (promotionPrivacyReference === null) {
            const proofIntent = openJournalRecords.find(({ recordType, operationId }) => (
              recordType === 'intent' && operationId === 'promote-privacy-publish'
            ));
            if (!proofIntent) throw new Error('Promotion privacy publication is unavailable');
            const locator = Object.freeze({
              filePath: promotionAttemptPrivacyProofPath(plan, releaseJournalAttemptId),
            });
            promotionPrivacyReference = privacyArtifactFromPublication(
              plan,
              locator,
              proofIntent.payload.publication,
              {
                now: new Date(JSON.parse(Buffer.from(
                  proofIntent.payload.publication.artifacts[0].contentsBase64, 'base64',
                ).toString('utf8')).occurredAt),
                validatePrivacyProof: validateReleasePrivacyProof,
              },
            ).reference;
          }
          const preBarrierNow = now();
          if (plan.previousRevision !== null
            && promotionProofExpired(promotionPrivacyReference, preBarrierNow)) {
            await closePromotionAttemptForReproof(stateStore);
            const error = new Error('Promotion privacy proof expired before final mutation');
            error.code = 'PROMOTION_REPROOF_REQUIRED';
            throw error;
          }
          let barrier;
          try {
            barrier = await validatePromotionFinalBarrier({
              executor,
              plan,
              priorReceipts,
              promotionPrivacyReference,
              now,
              verifyTask8Evidence,
              verifyReleasePrivacyArtifact,
              validateReleasePrivacyProof,
            });
          } catch (error) {
            if (error?.code === 'PROMOTION_REPROOF_REQUIRED') {
              await closePromotionAttemptForReproof(stateStore);
            }
            throw error;
          }
          promotionBarrierSha256 = canonicalSha256(barrier);
          Object.assign(promotionStableReadbacks, {
            artifact: barrier.stable.artifact,
            revision: barrier.stable.revision,
            service: barrier.stable.service,
          });
          mutationBeforeObservations.set(member.id,
            member.id === 'promote-public-service' ? barrier.stable.iam : barrier.stable.service);
          if (member.id === 'promote-public-service') {
            promotionIamBaseline = normalizeServiceIamPolicy(
              barrier.stable.iam, { requireEtag: true },
            );
          }
        }
        mutationAdapter = createReleaseMutationAdapter(plan, member, () => ({
          acceptanceExecutionReceipts,
          buildReceipt,
          collectedEvidence,
          collectedObjectReceipts,
          candidateReadbacks,
          evidenceSecretVersions,
          migrationExecutionReceipt,
          promotionStableReadbacks,
        }));
        if (!restartingMutation && member.id.endsWith('-execute')) {
          const expectedJob = member.id === 'migration-execute' ? plan.expectedMigrationJob
            : plan.expectedJobs[member.id.slice(0, -'-execute'.length)];
          if (!expectedJob) throw new Error('Cloud Run execution baseline Job is unavailable');
          executionBaseline = await readCloudRunExecutionBaseline(
            executor, expectedJob, mutationBeforeObservations.get(member.id),
          );
        }
        const beforeState = mutationAdapter.canonicalState(
          'before', mutationBeforeObservations.get(member.id),
        );
        const afterState = mutationAdapter.expectedAfter;
        if (retryingRestartMutation
          && canonicalSha256(beforeState) !== existingJournalIntent.payload.beforeSha256) {
          throw new Error('Release restart before-state differs from the durable intent');
        }
        journalAfterSha256 = restartingMutation
          ? existingJournalIntent.payload.afterSha256 : canonicalSha256(afterState);
        if (restartingMutation) {
          journalIntent = existingJournalIntent;
          existingJournalIntent = null;
          restartAdoptions.add(member.id);
        } else {
          try {
            finalMutationGuard?.beforeOperation(member.id);
            journalIntent = await stateStore.appendIntent({
              mutationOrdinal,
              operationAttemptId: createHash('sha256').update([
                releaseJournalAttemptId, member.id, String(mutationOrdinal),
              ].join('\0')).digest('hex').slice(0, 32),
              commandSha256: selection.phase === 'promote' && finalPublicMutation
                ? canonicalSha256({ argv: member.argv, promotionBarrierSha256 })
                : canonicalSha256(member.argv),
              reconcileKind: journalReconcileKind(member.id),
              beforeSha256: canonicalSha256(beforeState),
              afterSha256: journalAfterSha256,
              ...(executionBaseline === null ? {} : { executionBaseline }),
            }, { operationId: member.id });
            if (mutationAdapter.finalPublicMutation) {
              finalMutationGuard?.afterOperation(member.id);
            }
          } catch (error) {
            error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
            throw error;
          }
        }
        journalMutationCount = mutationOrdinal;
        pendingJournal = {
          adapter: mutationAdapter,
          afterSha256: journalAfterSha256,
          intent: journalIntent,
          operationId: member.id,
          restarting: restartingMutation,
          retried: retryingRestartMutation,
        };
      }
      let receipt;
      let canonicalServiceAbsence = false;
      const restartObservation = restartingMutation
        ? journalRestartObservation(member, plan) : null;
      const assignedVersionKey = assignedSecretVersionOperationKey(member.id);
      const operationArgv = member.id === 'build-readback'
        ? [
          'builds', 'describe', buildReceipt?.buildId,
          `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
        ]
        : (member.id === 'migration-execution-readback'
          ? [
            'run', 'jobs', 'executions', 'describe', migrationExecutionName,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]
          : (selection.phase === 'acceptance' && member.id.endsWith('-execution-readback')
            ? [
              'run', 'jobs', 'executions', 'describe',
              acceptanceExecutionNames[member.id.slice(0, -'-execution-readback'.length)],
              `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
            ]
            : (assignedVersionKey === null
              ? member.argv
              : bindAssignedSecretVersion(
                member.argv, evidenceSecretVersions[assignedVersionKey],
              ))));
      const publicationKey = member.id.startsWith('inventory-publish:')
        || member.id.startsWith('evidence-publish:')
        ? member.id.slice(member.id.indexOf(':') + 1) : null;
      const payloadReadbackKey = member.id.startsWith('inventory-payload-readback:')
        || member.id.startsWith('evidence-payload-readback:')
        ? member.id.slice(member.id.indexOf(':') + 1) : null;
      const operationOptions = member.id === 'build-submit' ? Object.freeze({
        timeout: 600_000,
      }) : publicationKey !== null ? Object.freeze({
        stdin: evidencePublicationBytes(
          evidencePublicationPayloads, publicationKey, plan.evidence[publicationKey],
        ),
      }) : payloadReadbackKey !== null ? Object.freeze({
        maxBuffer: 2 * 1024 * 1024, text: true,
      }) : undefined;
      if (mutationAdapter !== null && !restartingMutation
        && selection.phase === 'promote' && finalPublicMutation) {
        const postIntentNow = now();
        if (plan.previousRevision !== null
          && promotionProofExpired(promotionPrivacyReference, postIntentNow)) {
          journalMutationCount = mutationOrdinal;
          await closePromotionAttemptForReproof(stateStore);
          const error = new Error('Promotion privacy proof expired while publishing final intent');
          error.code = 'PROMOTION_REPROOF_REQUIRED';
          throw error;
        }
      }
      if (mutationAdapter !== null
        && selection.phase === 'promote' && plan.previousRevision === null
        && member.id === 'candidate-cleanup-delete'
        && (!restartingMutation || retryingRestartMutation)
        && promotionProofExpired(promotionPrivacyReference, now())) {
        journalMutationCount = mutationOrdinal;
        await closePromotionAttemptForReproof(stateStore);
        const error = new Error('Promotion privacy proof expired while publishing delete intent');
        error.code = 'PROMOTION_REPROOF_REQUIRED';
        throw error;
      }
      try {
        try {
          if (!restartingMutation || retryingRestartMutation) {
            if (mutationAdapter === null) {
              receipt = await executor(operationArgv, operationOptions);
            } else {
              let execution;
              try {
                execution = executor(operationArgv, operationOptions);
              } finally {
                mutationAttempted = true;
                if (member.id === 'candidate-deploy') candidateDeployMutationAttempted = true;
                if (member.id === 'candidate-private-iam-grant') candidateIamMutationAttempted = true;
                if (member.id === 'promote-stable-deploy') promotionStableMutationAttempted = true;
                if (member.id === 'promote-public-service') promotionIamMutationAttempted = true;
                if (member.id === 'promote-traffic') promotionTrafficMutationAttempted = true;
              }
              receipt = await execution;
            }
          } else if (restartObservation.mode === 'blocked') {
            throw new Error('Release restart lacks an authoritative correlation identity');
          } else if (restartObservation.mode === 'deferred-absence') {
            receipt = null;
          } else if (restartObservation.mode === 'gcs-absence-list') {
            const rows = await executor(restartObservation.argv);
            if (!Array.isArray(rows) || rows.length !== 0) {
              throw new Error('Release restart observed the GCS object before-state');
            }
            receipt = null;
          } else if (restartObservation.mode === 'collected-local') {
            const key = member.id.slice(member.id.indexOf(':') + 1);
            const describe = plan.operations.find(
              ({ id }) => id === `evidence-collect-describe:${key}`,
            );
            if (!describe) throw new Error('Release restart collection source is unavailable');
            const source = await executor(describe.argv);
            collectedObjectReceipts.set(
              key,
              validateAcceptanceObjectReceipt(source, plan.acceptanceOutputs[key]),
            );
            receipt = null;
          } else {
            receipt = await executor(restartObservation.argv);
          }
        } finally {
          if (member.id === 'build-submit'
            && (typeof verifyBuildConfig !== 'function'
              || await verifyBuildConfig(plan.buildConfig, plan.buildConfigSha256) !== true)) {
            throw new Error('Frozen build config drifted after submit');
          }
        }
      } catch (error) {
        if (member.id === 'candidate-deploy') {
          const current = await executor([
            'run', 'services', 'describe', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateCandidateService(current, plan.expectedCandidate);
          const revision = await executor([
            'run', 'revisions', 'describe', plan.candidateRevision,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateCandidateRevisionReadback(revision, plan);
          const artifact = await executor(artifactDescribeArgv(plan.image));
          validateCandidateArtifact(artifact, plan.image);
          const iam = await executor([
            'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(iam, { policy: 'stable-private', requireEtag: true });
          receipt = current;
          responseLossRecoveries.push('candidate-deploy');
        } else if (member.id === 'candidate-private-iam-grant') {
          receipt = await executor([
            'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
          responseLossRecoveries.push('candidate-private-iam-grant');
        } else if (member.id === 'promote-stable-deploy') {
          receipt = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateStableStagedService(receipt, plan);
          responseLossRecoveries.push('promote-stable-deploy');
        } else if (member.id === 'promote-public-service') {
          receipt = await executor([
            'run', 'services', 'get-iam-policy', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
          responseLossRecoveries.push('promote-public-service');
        } else if (member.id === 'promote-traffic') {
          receipt = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validatePromotedService(receipt, plan);
          responseLossRecoveries.push('promote-traffic');
        } else if (member.id === 'rollback-traffic') {
          receipt = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateCandidateCleanupService(receipt, plan);
          responseLossRecoveries.push('rollback-traffic');
        } else if (member.id === 'candidate-cleanup-delete') {
          try {
            await executor([
              'run', 'services', 'describe', CANDIDATE_SERVICE,
              `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
            ]);
            throw error;
          } catch (readbackError) {
            if (readbackError?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
          }
          receipt = { responseLossRecovered: true };
          responseLossRecoveries.push('candidate-cleanup-delete');
        } else {
          canonicalServiceAbsence = error?.code === 'CLOUD_RUN_SERVICE_NOT_FOUND';
          const absenceRead = member.id === 'candidate-service-precheck'
            || member.id === 'candidate-stable-service-precheck'
            || member.id === 'candidate-cleanup-service-precheck'
            || member.id === 'candidate-cleanup-absence-readback'
            || (member.id === 'promote-stable-service-precheck' && plan.previousRevision === null);
          if (!canonicalServiceAbsence || !absenceRead) throw error;
          receipt = null;
        }
      }
      if (selection.phase === 'promote' && restartingMutation
        && finalPublicMutations.some(({ operationId: finalOperationId }) => (
          finalOperationId === member.id
        ))) {
        let restartAfterSha256 = null;
        try {
          restartAfterSha256 = canonicalSha256(
            pendingJournal.adapter.canonicalState('after', receipt),
          );
        } catch {
          restartAfterSha256 = null;
        }
        if (restartAfterSha256 !== pendingJournal.afterSha256) {
          const restartBeforeSha256 = canonicalSha256(
            pendingJournal.adapter.canonicalState('before', receipt),
          );
          if (restartBeforeSha256 === pendingJournal.intent.payload.beforeSha256) {
            await closePromotionAttemptForReproof(stateStore);
            const error = new Error('Unperformed promotion intent requires a fresh proof');
            error.code = 'PROMOTION_REPROOF_REQUIRED';
            throw error;
          }
          throw new Error('Promotion restart state is neither the intended before nor after state');
        }
      }
      if (member.id === 'build-submit') {
        buildReceipt = validateBuildReceipt(receipt, {
          releaseSha: plan.releaseSha,
          sourceArchiveSha256: plan.sourceArchiveSha256,
          buildConfigSha256: plan.buildConfigSha256,
        });
        if (plan.imageDigest && buildReceipt.imageDigest !== plan.imageDigest) {
          throw new Error('Build digest does not match the release manifest');
        }
      } else if (member.id === 'build-readback') {
        const readback = validateBuildReceipt(receipt, {
          releaseSha: plan.releaseSha,
          sourceArchiveSha256: plan.sourceArchiveSha256,
          buildConfigSha256: plan.buildConfigSha256,
        });
        if (!buildReceipt || !exact(readback, buildReceipt)) {
          throw new Error('Build readback differs from submission');
        }
      } else if (restartingMutation && member.id === 'migration-deploy') {
        validateReadyReleaseJobReadback(receipt, plan.expectedMigrationJob);
      } else if (restartingMutation && selection.phase === 'acceptance'
        && member.id.endsWith('-deploy')) {
        const key = member.id.slice(0, -'-deploy'.length);
        validateReadyReleaseJobReadback(receipt, plan.expectedJobs[key]);
      } else if (member.id === 'migration-readback') {
        validateReadyReleaseJobReadback(receipt, plan.expectedMigrationJob);
        mutationBeforeObservations.set('migration-execute', receipt);
      } else if (member.id === 'migration-execute') {
        migrationExecutionName = validateCloudRunExecutionIdentity(receipt, {
          job: MIGRATION_JOB,
        });
      } else if (member.id === 'migration-execution-readback') {
        migrationExecutionReceipt = validateMigrationExecutionReceipt(receipt, {
          releaseSha: plan.releaseSha,
        });
        if (migrationExecutionReceipt.name !== migrationExecutionName) {
          throw new Error('Cloud Run migration execution identity changed during readback');
        }
      } else if (selection.phase === 'acceptance' && member.id.endsWith('-execute')) {
        const key = member.id.slice(0, -'-execute'.length);
        acceptanceExecutionNames[key] = validateCloudRunExecutionIdentity(receipt, {
          job: plan.expectedJobs[key]?.job,
        });
      } else if (selection.phase === 'acceptance'
        && member.id.endsWith('-execution-readback')) {
        const key = member.id.slice(0, -'-execution-readback'.length);
        const execution = validateReleaseJobExecutionReceipt(receipt, plan.expectedJobs[key]);
        if (execution.name !== acceptanceExecutionNames[key]) {
          throw new Error('Cloud Run release Job execution identity changed during readback');
        }
        acceptanceExecutionReceipts[key] = execution;
      } else if (member.id === 'promote-authority-readback') {
        if (!Array.isArray(receipt) || receipt.length !== 1
          || receipt[0]?.account !== PROMOTION_AUTHORITY
          || receipt[0]?.status !== 'ACTIVE') {
          throw new Error('Public promotion authority is not approved');
        }
      } else if (member.id === 'promote-candidate-service-readback') {
        promotionReadbacks.service = receipt;
        validateCandidateService(receipt, plan.expectedCandidate);
      } else if (member.id === 'promote-candidate-revision-readback') {
        promotionReadbacks.revision = receipt;
      } else if (member.id === 'promote-candidate-iam-readback') {
        promotionReadbacks.iam = receipt;
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'promote-candidate-artifact-readback') {
        promotionReadbacks.artifact = receipt;
        validateCandidateControlPlaneReadbacks(promotionReadbacks, plan);
        if (plan.previousRevision === null) {
          mutationBeforeObservations.set('candidate-cleanup-delete', promotionReadbacks.service);
        }
      } else if (member.id === 'promote-stable-service-precheck') {
        if (plan.previousRevision === null) {
          if (receipt !== null || !canonicalServiceAbsence) {
            throw new Error('First stable service already exists or absence is unproven');
          }
        } else {
          if (receipt === null) throw new Error('Prior stable service is absent');
          validateStableService(receipt, plan);
        }
        if (typeof writeStableSpec !== 'function' || await writeStableSpec(plan) !== true) {
          throw new Error('Stable Service YAML is unavailable');
        }
        mutationBeforeObservations.set('promote-stable-deploy', receipt ?? { state: 'absent' });
      } else if (member.id === 'promote-stable-public-iam-precheck') {
        validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
        stablePublicIamBaseline = normalizeServiceIamPolicy(receipt, { requireEtag: true });
      } else if (member.id === 'promote-prior-revision-readback') {
        validatePriorRevisionReadback(receipt, plan);
        stablePriorRevisionBaseline = structuredClone(receipt);
      } else if (member.id === 'promote-prior-artifact-readback') {
        validateCandidateArtifact(receipt, plan.previousImage);
        stablePriorArtifactBaseline = structuredClone(receipt);
      } else if (member.id === 'promote-stable-spec-dry-run') {
        validateStableServiceSpecDryRun(receipt, plan);
      } else if (member.id === 'promote-stable-deploy'
        || member.id === 'promote-stable-staged-readback') {
        validateStableStagedService(receipt, plan);
        if (member.id === 'promote-stable-staged-readback') {
          promotionStableReadbacks.service = receipt;
          mutationBeforeObservations.set('promote-traffic', receipt);
        }
      } else if (member.id === 'promote-stable-revision-readback') {
        validateStableRevisionReadback(receipt, plan);
        promotionStableReadbacks.revision = receipt;
      } else if (member.id === 'promote-stable-artifact-readback') {
        validateCandidateArtifact(receipt, plan.image);
        promotionStableReadbacks.artifact = receipt;
      } else if (member.id === 'promote-stable-private-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-private', requireEtag: true });
        promotionIamBaseline = normalizeServiceIamPolicy(receipt, { requireEtag: true });
        mutationBeforeObservations.set('promote-public-service', receipt);
      } else if (member.id === 'promote-public-service') {
        if (restartingMutation) {
          validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
        } else {
          if (!promotionIamBaseline) throw new Error('Promotion IAM baseline is unavailable');
          const normalized = validateIamPolicyState(
            receipt, publicIamPolicyState(promotionIamBaseline), { requireEtag: true },
          );
          if (normalized.etag === promotionIamBaseline.etag) {
            throw new Error('Promotion IAM mutation has no new etag');
          }
          validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
        }
      } else if (member.id === 'promote-public-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
        if (plan.previousRevision === null) {
          if (!restartAdoptions.has('promote-public-service')) {
            if (!promotionIamBaseline) throw new Error('Promotion IAM baseline is unavailable');
            validateIamPolicyState(
              receipt, publicIamPolicyState(promotionIamBaseline), { requireEtag: true },
            );
          }
        } else if (!restartAdoptions.has('promote-traffic')
          && (!stablePublicIamBaseline
            || !exact(iamPolicyState(normalizeServiceIamPolicy(receipt, { requireEtag: true })),
              iamPolicyState(stablePublicIamBaseline)))) {
          throw new Error('Stable public IAM changed during promotion');
        }
      } else if (member.id === 'candidate-stable-service-precheck') {
        if (receipt !== null || !canonicalServiceAbsence) {
          throw new Error('First release requires authoritative stable service absence');
        }
      } else if (member.id === 'candidate-service-precheck') {
        if (receipt !== null || !canonicalServiceAbsence) {
          throw new Error('Candidate service already exists or absence is unproven; cleanup is required');
        }
        if (typeof writeCandidateSpec !== 'function'
          || await writeCandidateSpec(plan) !== true) {
          throw new Error('Candidate Service YAML is unavailable');
        }
        mutationBeforeObservations.set('candidate-deploy', receipt ?? { state: 'absent' });
      } else if (member.id === 'candidate-spec-dry-run') {
        validateCandidateServiceSpecDryRun(receipt, plan);
      } else if (member.id === 'candidate-deploy') {
        validateCandidateService(receipt, plan.expectedCandidate);
      } else if (member.id === 'candidate-private-iam-baseline-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-private', requireEtag: true });
        mutationBeforeObservations.set('candidate-private-iam-grant', receipt);
      } else if (member.id === 'candidate-private-iam-grant') {
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'candidate-private-iam-readback') {
        candidateReadbacks.iam = receipt;
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'candidate-service-readback') {
        candidateReadbacks.service = receipt;
        validateCandidateService(receipt, plan.expectedCandidate);
      } else if (member.id === 'candidate-revision-readback') {
        candidateReadbacks.revision = receipt;
      } else if (member.id === 'candidate-artifact-readback') {
        candidateReadbacks.artifact = receipt;
        validateCandidateArtifact(receipt, plan.image);
      } else if (member.id === 'candidate-cleanup-service-precheck') {
        if (receipt === null && canonicalServiceAbsence) candidateCleanupState = 'already-absent';
        else if (receipt === null) throw new Error('Candidate service absence is unproven');
        else validateRecoveryPrecheck(receipt, plan, 'candidate-cleanup');
        mutationBeforeObservations.set(
          'candidate-cleanup-delete', receipt ?? { state: 'absent' },
        );
      } else if (member.id === 'candidate-cleanup-revision-readback') {
        validateCandidateRevisionReadback(receipt, plan);
      } else if (member.id === 'candidate-cleanup-artifact-readback') {
        validateCandidateArtifact(receipt, plan.image);
      } else if (member.id === 'candidate-cleanup-private-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'candidate-cleanup-delete') {
        // gcloud 553 synchronous service deletion returns empty stdout/null.
        // The following exact service-specific absence readback is the receipt.
      } else if (member.id === 'candidate-cleanup-absence-readback') {
        if (receipt !== null || !canonicalServiceAbsence) {
          throw new Error('Candidate service remains or absence is unproven after cleanup');
        }
        if (candidateCleanupState === 'already-absent') {
          const cleanupMutation = mutationMembers.find(
            ({ id }) => id === 'candidate-cleanup-delete',
          );
          if (!cleanupMutation || stateStore === null || journalMutationCount !== 0) {
            throw new Error('Verified cleanup no-op journal is unavailable');
          }
          try {
            const adapter = createReleaseMutationAdapter(plan, cleanupMutation, () => ({
              acceptanceExecutionReceipts,
              buildReceipt,
              collectedEvidence,
              collectedObjectReceipts,
              candidateReadbacks,
              evidenceSecretVersions,
              migrationExecutionReceipt,
              promotionStableReadbacks,
            }));
            const mutationOrdinal = 1;
            const beforeState = adapter.canonicalState(
              'before', mutationBeforeObservations.get(cleanupMutation.id),
            );
            const afterState = adapter.canonicalState('after', { state: 'absent' });
            const afterSha256 = canonicalSha256(afterState);
            const intent = await stateStore.appendIntent({
              mutationOrdinal,
              operationAttemptId: createHash('sha256').update([
                releaseJournalAttemptId, cleanupMutation.id, String(mutationOrdinal),
              ].join('\0')).digest('hex').slice(0, 32),
              commandSha256: canonicalSha256(cleanupMutation.argv),
              reconcileKind: journalReconcileKind(cleanupMutation.id),
              beforeSha256: canonicalSha256(beforeState),
              afterSha256,
            }, { operationId: cleanupMutation.id });
            await stateStore.appendCheckpoint({
              intentRecordSha256: intent.recordSha256,
              classification: 'after',
              outcome: 'verified-noop',
              observationSha256: afterSha256,
              safeResult: adapter.safeResult({ state: 'absent' }),
            });
            journalMutationCount = mutationOrdinal;
          } catch (error) {
            error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
            throw error;
          }
        }
        if (candidateCleanupState === null) candidateCleanupState = 'deleted';
      } else if (member.id === 'promote-traffic') {
        if (restartingMutation || responseLossRecoveries.includes(member.id)) {
          validatePromotedService(receipt, plan);
        }
        else validateTrafficTargetAcknowledgement(receipt, {
          revision: plan.stableRevision, serviceUrl: plan.serviceOrigin,
        });
      } else if (member.id === 'promote-readback') {
        validatePromotedService(receipt, plan);
      } else if (member.id === 'rollback-service-precheck') {
        validateRecoveryPrecheck(receipt, plan, 'rollback');
        mutationBeforeObservations.set('rollback-traffic', receipt);
      } else if (member.id === 'rollback-current-revision-readback') {
        validateStableRevisionReadback(receipt, plan);
      } else if (member.id === 'rollback-current-artifact-readback') {
        validateCandidateArtifact(receipt, plan.image);
      } else if (member.id === 'rollback-prior-revision-readback') {
        validatePriorRevisionReadback(receipt, plan);
      } else if (member.id === 'rollback-prior-artifact-readback') {
        validateCandidateArtifact(receipt, plan.previousImage);
      } else if (member.id === 'rollback-public-iam-precheck'
        || member.id === 'rollback-public-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
      } else if (member.id === 'rollback-traffic') {
        if (restartingMutation || responseLossRecoveries.includes(member.id)) {
          validateCandidateCleanupService(receipt, plan);
        }
        else validateTrafficTargetAcknowledgement(receipt, {
          revision: plan.previousRevision, serviceUrl: plan.serviceOrigin,
        });
      } else if (member.id === 'rollback-readback') {
        validateCandidateCleanupService(receipt, plan);
      } else if (selection.phase === 'acceptance' && member.id.endsWith('-readback')) {
        const key = member.id.slice(0, -'-readback'.length);
        validateReadyReleaseJobReadback(receipt, plan.expectedJobs[key]);
        mutationBeforeObservations.set(`${key}-execute`, receipt);
      } else if (member.id.startsWith('evidence-collect-describe:')) {
        const key = member.id.slice(member.id.indexOf(':') + 1);
        collectedObjectReceipts.set(
          key,
          validateAcceptanceObjectReceipt(receipt, plan.acceptanceOutputs[key]),
        );
      } else if (member.id.startsWith('evidence-collect-copy:')) {
        const key = member.id.slice(member.id.indexOf(':') + 1);
        if (!collectedObjectReceipts.has(key) || typeof inspectCollected !== 'function') {
          throw new Error('Evidence collection is not generation-bound');
        }
        const inspected = await inspectCollected(
          plan.acceptanceOutputs[key].filePath,
          { releaseSha: plan.releaseSha, kind: key },
        );
        if (inspected.byteLength !== collectedObjectReceipts.get(key).size) {
          throw new Error('Collected evidence bytes differ from object receipt');
        }
        collectedEvidence[key] = Object.freeze({
          artifactSha256: inspected.artifactSha256,
          objectSha256: inspected.objectSha256,
          byteLength: inspected.byteLength,
        });
      } else if (member.id.startsWith('evidence-output-delete-readback:')) {
        if (!Array.isArray(receipt) || receipt.length !== 0) {
          throw new Error('Acceptance evidence output remains after deletion');
        }
      } else if (member.id === 'evidence-output-zero-readback') {
        if (!Array.isArray(receipt) || receipt.length !== 0) {
          throw new Error('Acceptance evidence output residue remains');
        }
      }
      if (/^(?:inventory|evidence)-(?:publish|readback):/.test(member.id)) {
        const key = member.id.slice(member.id.indexOf(':') + 1);
        const expected = plan.evidence[key];
        if (member.id.includes('-publish:')) {
          receipt = normalizeEvidenceVersionReceipt(receipt, { secret: expected.secret });
          evidenceSecretVersions[key] = receipt.version;
        } else {
          const assignedVersion = evidenceSecretVersions[key];
          receipt = normalizeEvidenceVersionReceipt(receipt, {
            secret: expected.secret, secretVersion: assignedVersion,
          });
          if (receipt.version !== assignedVersion) throw new Error('Evidence version readback is not publication-bound');
          evidenceVersionReadbacks.set(key, receipt);
        }
      }
      if (/^(?:inventory|evidence)-payload-readback:/.test(member.id)) {
        const key = member.id.slice(member.id.indexOf(':') + 1);
        const expected = plan.evidence[key];
        const metadata = evidenceVersionReadbacks.get(key);
        if (!metadata) throw new Error('Evidence payload readback is not version-bound');
        const payload = validateEvidencePayloadReceipt(receipt, expected);
        receipt = Object.freeze({ metadata, payload });
      }
      if (pendingJournal !== null
        && journalCheckpointBoundary(pendingJournal.operationId) === member.id) {
        try {
          const operationId = pendingJournal.operationId;
          const observedAfter = operationId === 'candidate-deploy'
            ? {
              artifact: candidateReadbacks.artifact,
              revision: candidateReadbacks.revision,
              service: candidateReadbacks.service,
            }
            : (operationId === 'promote-stable-deploy'
              ? {
                artifact: promotionStableReadbacks.artifact,
                revision: promotionStableReadbacks.revision,
                service: promotionStableReadbacks.service,
              }
              : (operationId.startsWith('evidence-collect-copy:')
                ? {
                  collected: collectedEvidence[operationId.slice(operationId.indexOf(':') + 1)],
                  source: collectedObjectReceipts.get(
                    operationId.slice(operationId.indexOf(':') + 1),
                  ),
                }
                : receipt));
          const canonicalAfter = pendingJournal.adapter.canonicalState('after', observedAfter);
          const observationSha256 = canonicalSha256(canonicalAfter);
          if (observationSha256 !== pendingJournal.afterSha256) {
            const canonicalBefore = pendingJournal.adapter.canonicalState('before', observedAfter);
            if (selection.phase === 'promote' && pendingJournal.restarting
              && finalPublicMutations.some(({ operationId: finalOperationId }) => (
                finalOperationId === pendingJournal.operationId
              ))
              && canonicalSha256(canonicalBefore) === pendingJournal.intent.payload.beforeSha256) {
              await closePromotionAttemptForReproof(stateStore);
              const error = new Error('Unperformed promotion intent requires a fresh proof');
              error.code = 'PROMOTION_REPROOF_REQUIRED';
              throw error;
            }
            throw new Error('Authoritative mutation state differs from the durable intent');
          }
          await stateStore.appendCheckpoint({
            intentRecordSha256: pendingJournal.intent.recordSha256,
            classification: 'after',
            outcome: responseLossRecoveries.includes(pendingJournal.operationId)
              ? 'adopted-response-loss'
              : (pendingJournal.restarting && !pendingJournal.retried
                ? 'adopted-restart' : 'applied'),
            observationSha256,
            safeResult: pendingJournal.adapter.safeResult(observedAfter),
          });
          pendingJournal = null;
        } catch (error) {
          if (error?.code === 'PROMOTION_REPROOF_REQUIRED') throw error;
          error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
          throw error;
        }
      }
      completed.push(member.id);
      activeOperationId = null;
    }
    if (pendingJournal !== null) {
      throw new Error('Release mutation lacks an authoritative checkpoint');
    }
    if (selection.phase === 'candidate') {
      validateCandidateControlPlaneReadbacks(candidateReadbacks, plan);
    }
  } catch (phaseError) {
    if (phaseError?.code === 'PROMOTION_REPROOF_REQUIRED') {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed', code: 'PROMOTION_REPROOF_REQUIRED', mutationPerformed: mutationAttempted,
        releaseSha: plan.releaseSha, phase: selection.phase, completed,
        resumeBoundary: activeOperationId,
      });
    }
    if (phaseError?.code === 'RELEASE_JOURNAL_WRITE_FAILED') {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed', code: 'RELEASE_JOURNAL_WRITE_FAILED',
        mutationPerformed: mutationAttempted,
        releaseSha: plan.releaseSha, phase: selection.phase, completed,
        resumeBoundary: activeOperationId,
      });
    }
    await stateStore?.close().catch(() => undefined);
    return publish(writeOutput, 1, {
      status: 'failed', code: 'RELEASE_PHASE_FAILED',
      mutationPerformed: mutationAttempted,
      releaseSha: plan.releaseSha, phase: selection.phase, completed,
      resumeBoundary: activeOperationId
        ?? selected.find(({ id }) => !completed.includes(id))?.id
        ?? null,
      ...(responseLossRecoveries.length === 0 ? {} : { responseLossRecoveries }),
    });

  }
  if (selection.phase === 'inventory') {
    plan = buildPlanWithAssignedEvidenceVersions(input, selection.phase, evidenceSecretVersions);
  } else if (selection.phase === 'evidence') {
    plan = buildPlanWithAssignedEvidenceVersions(input, selection.phase, evidenceSecretVersions);
  }
  const publicReport = {
    status: 'phase-complete', code: 'GCP_RELEASE_PHASE_COMPLETE', mutationPerformed: mutationAttempted,
    releaseSha: plan.releaseSha, phase: selection.phase, completed,
  };
  if (selection.phase === 'inventory' || selection.phase === 'evidence') {
    publicReport.evidenceSecretVersions = evidenceSecretVersions;
  }
  if (selection.phase === 'collect') publicReport.collectedEvidence = collectedEvidence;
  if (selection.phase === 'build') publicReport.buildReceipt = buildReceipt;
  if (selection.phase === 'migration') publicReport.migrationExecutionReceipt = migrationExecutionReceipt;
  if (selection.phase === 'acceptance') {
    publicReport.acceptanceExecutionReceipts = acceptanceExecutionReceipts;
  }
  if (responseLossRecoveries.length > 0) {
    publicReport.responseLossRecoveries = responseLossRecoveries;
  }
  if (candidateCleanupState !== null) {
    publicReport.candidateCleanupState = candidateCleanupState;
  }
  if (receiptBackedPhase) {
    try {
      const phaseReceipt = ACTION_RECEIPT_PHASES.has(selection.phase)
        ? createReleaseActionReceipt(
          selection.phase, plan, completed, priorReceipts, stateStore,
        )
        : createReleasePhaseReceipt(
          selection.phase,
          plan,
          completed,
          {
            buildReceipt,
            migrationExecutionReceipt,
             acceptanceExecutionReceipts,
             collectedEvidence,
             candidatePrivacyReference,
             evidenceSecretVersions,
             workloadExecution,
          },
          priorReceipts,
        );
      if (typeof persistReceipt !== 'function' || await persistReceipt(plan, phaseReceipt) !== true) {
        throw new Error('Release receipt persistence failed');
      }
      if (stateStore !== null) {
        const lastCheckpoint = stateStore.records.at(-1);
        if (lastCheckpoint?.recordType !== 'checkpoint') {
          const error = new Error('Release journal checkpoint is unavailable');
          error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
          throw error;
        }
        try {
          await stateStore.appendTerminal({
            status: 'phase-complete',
            checkpointRecordSha256: lastCheckpoint.recordSha256,
            receiptSha256: phaseReceipt.receiptSha256,
            terminalState: {
              completed: [...completed],
              mutationCount: journalMutationCount,
              phase: selection.phase,
            },
            mutationCount: journalMutationCount,
            responseLossOperationIds: stateStore.records
              .filter((record) => record.attemptId === stateStore.attemptId
                && record.recordType === 'checkpoint'
                && ['adopted-response-loss', 'adopted-restart'].includes(record.payload.outcome))
              .map((record) => record.operationId),
          });
        } catch (error) {
          error.code = 'RELEASE_JOURNAL_WRITE_FAILED';
          throw error;
        }
      }
      publicReport.phaseReceipt = phaseReceipt;
    } catch (error) {
      await stateStore?.close().catch(() => undefined);
      return publish(writeOutput, 1, {
        status: 'failed', code: error?.code === 'RELEASE_JOURNAL_WRITE_FAILED'
          ? 'RELEASE_JOURNAL_WRITE_FAILED' : 'RELEASE_RECEIPT_WRITE_FAILED',
        mutationPerformed: mutationAttempted,
        releaseSha: plan.releaseSha, phase: selection.phase, completed,
      });
    }
  }
  publicReport.mutationPerformed = mutationAttempted;
  await stateStore?.close().catch(() => undefined);
  return publish(writeOutput, 0, publicReport);
}

async function readManifest(filePath) {
  if (!isAbsoluteFile(filePath)) throw releaseContractError();
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024) {
    throw releaseContractError();
  }
  const raw = (await readBoundedOrdinaryFile(filePath, {
    expectedByteLength: metadata.size, maximumBytes: 128 * 1024,
  })).toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) throw releaseContractError();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:accessToken|access_token|client_secret|private_key)"\s*:|postgres(?:ql)?:\/\/[^/@:]+:[^/@]+@/i.test(raw)) {
    throw releaseContractError();
  }
  return parsed;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const raw = process.argv.slice(2);
  let result;
  if (raw.includes('--prepare-archive')) {
    result = await runPrepareReleaseArchive({ argv: raw });
  } else {
    const manifestArgs = raw.filter((value) => value.startsWith('--manifest='));
    if (manifestArgs.length !== 1) {
      result = { exitCode: 2, publicReport: { status: 'not-run', code: 'RELEASE_MANIFEST_REQUIRED', mutationPerformed: false } };
      process.stdout.write(`${JSON.stringify(result.publicReport)}\n`);
    } else {
      try {
        const input = await readManifest(manifestArgs[0].slice('--manifest='.length));
        result = await runGcpRelease({ argv: raw.filter((value) => !value.startsWith('--manifest=')), input });
      } catch {
        result = { exitCode: 2, publicReport: { status: 'not-run', code: 'RELEASE_MANIFEST_INVALID', mutationPerformed: false } };
        process.stdout.write(`${JSON.stringify(result.publicReport)}\n`);
      }
    }
  }
  process.exitCode = result.exitCode;
}
