import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig, loadLlmSmokeConfiguration } from '../src/config.js';
import { createApp } from '../src/app.js';
import {
  finalizeReleaseEvidenceRecord,
  gcsIdentitySha256,
  llmProviderConfigDigest,
  postgresIdentitySha256,
} from '../src/services/release-evidence.js';
import { createLogger } from '../src/telemetry/logger.js';

const TEST_RELEASE_COMMIT = 'a'.repeat(40);
const TEST_DATABASE_URL = 'postgres://localhost/v1';
const TEST_GCS_PROJECT = 'motion-expert-hk-ltd-webpage';
const TEST_GCS_BUCKET = 'hkbuddy-v1-582852715831-media';
const TEST_POSTGRES_RESOURCE_ID = '//sqladmin.googleapis.com/projects/motion-expert-hk-ltd-webpage/instances/hkbuddy-v1-pg/databases/hkbuddy_v1';
const TEST_GCS_RESOURCE_ID = '//storage.googleapis.com/projects/_/buckets/hkbuddy-v1-582852715831-media';
const TEST_LLM_CREDENTIAL_VERSION = 'llm-credential-v1';
const TEST_PROJECT_NUMBER = '582852715831';
const TEST_STABLE_ORIGIN = `https://hkbuddy-v1-api-${TEST_PROJECT_NUMBER}.asia-east2.run.app`;
const TEST_CANDIDATE_ORIGIN = `https://candidate-${TEST_RELEASE_COMMIT.slice(0, 12)}---hkbuddy-v1-api-candidate-${TEST_PROJECT_NUMBER}.asia-east2.run.app`;
const TEST_RUNTIME_SERVICE_ACCOUNT = 'hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com';
const TEST_LLM_CONFIG = {
  provider: 'vertex-ai',
  credentialVersion: 'runtime-sa-rotation-v1',
  timeoutMs: 12_000,
  settings: {
    projectId: TEST_GCS_PROJECT,
    location: 'global',
    model: 'gemini-2.5-flash',
  },
};
const evidenceDirectory = mkdtempSync(join(tmpdir(), 'hk-buddy-config-shell-'));
test.after(() => rmSync(evidenceDirectory, { recursive: true, force: true }));

const inventory = finalizeReleaseEvidenceRecord({
  schemaVersion: 1,
  commitSha: TEST_RELEASE_COMMIT,
  legacyApplicationIds: ['hkbuddy-pilot-0630'],
  legacyOrigins: ['https://hkbuddy-pilot-0630.azurewebsites.net'],
  postgresResources: [],
  blobResources: [],
  declaresNoLegacyPostgres: true,
  declaresNoLegacyBlob: true,
  reviewedAt: new Date().toISOString(),
  result: true,
});
const dependency = finalizeReleaseEvidenceRecord({
  schemaVersion: 1,
  commitSha: TEST_RELEASE_COMMIT,
  legacyInventoryDigest: inventory.artifactSha256,
  postgresResourceId: TEST_POSTGRES_RESOURCE_ID,
  postgresIdentitySha256: postgresIdentitySha256(TEST_DATABASE_URL),
  gcsResourceId: TEST_GCS_RESOURCE_ID,
  gcsIdentitySha256: gcsIdentitySha256({ projectId: TEST_GCS_PROJECT, bucket: TEST_GCS_BUCKET }),
  schema: 'v1_accept_12345678123441238123123456789abc',
  gcsPrefix: 'v1-accept/12345678-1234-4123-8123-123456789abc/',
  checks: [
    { name: 'postgres-migration-health', status: 'pass', latencyMs: 1 },
    { name: 'postgres-concurrency-recovery', status: 'pass', latencyMs: 2 },
    { name: 'postgres-integrity-events', status: 'pass', latencyMs: 3 },
    { name: 'postgres-rate-window-fencing', status: 'pass', latencyMs: 4 },
    { name: 'gcs-private-full-range-head', status: 'pass', latencyMs: 5 },
    { name: 'postgres-media-fencing', status: 'pass', latencyMs: 6 },
  ],
  schemaAbsent: true,
  gcsPrefixObjectCount: 0,
  result: true,
  occurredAt: new Date().toISOString(),
});
const llmSmoke = finalizeReleaseEvidenceRecord({
  schemaVersion: 1,
  commitSha: TEST_RELEASE_COMMIT,
  capability: 'llm',
  provider: TEST_LLM_CONFIG.provider,
  contractVersion: 'llm-connectivity-json-v1',
  providerConfigDigest: llmProviderConfigDigest(TEST_LLM_CONFIG),
  occurredAt: new Date().toISOString(),
  result: 'pass',
  httpClass: '2xx',
  normalizedSuccess: true,
  requestCount: 1,
  latencyMs: 1,
  usage: { inputTokens: null, outputTokens: null, totalTokens: null },
});
const inventoryFile = join(evidenceDirectory, 'inventory.json');
const dependencyFile = join(evidenceDirectory, 'dependency.json');
const llmSmokeFile = join(evidenceDirectory, 'llm-smoke.json');
writeFileSync(inventoryFile, JSON.stringify(inventory));
writeFileSync(dependencyFile, JSON.stringify(dependency));
writeFileSync(llmSmokeFile, JSON.stringify(llmSmoke));

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    V1_PUBLIC_ORIGIN: TEST_STABLE_ORIGIN,
    V1_CANDIDATE_ORIGIN: TEST_CANDIDATE_ORIGIN,
    V1_RUNTIME_SERVICE_ACCOUNT: TEST_RUNTIME_SERVICE_ACCOUNT,
    V1_SESSION_SECRET: '12345678901234567890123456789012',
    V1_TRUST_PROXY_HOPS: '1',
    V1_STORE_DRIVER: 'postgres',
    V1_DATABASE_URL: TEST_DATABASE_URL,
    V1_POSTGRES_RESOURCE_ID: TEST_POSTGRES_RESOURCE_ID,
    V1_MEDIA_DRIVER: 'gcs',
    V1_GOOGLE_CLOUD_PROJECT: TEST_GCS_PROJECT,
    V1_GCS_BUCKET: TEST_GCS_BUCKET,
    V1_GCS_RESOURCE_ID: TEST_GCS_RESOURCE_ID,
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_LLM_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
    V1_LLM_SMOKE_EVIDENCE_FILE: llmSmokeFile,
    V1_LLM_SMOKE_EVIDENCE_VERSION: llmSmoke.artifactSha256,
    V1_INSTANCE_POLICY: 'single',
    V1_PRIVACY_NOTICE_VERSION: '2026-08-25',
    V1_PRIVACY_NOTICE_APPROVED: 'true',
    V1_RETENTION_WORKER_ENABLED: 'true',
    V1_RELEASE_COMMIT_SHA: TEST_RELEASE_COMMIT,
    V1_LEGACY_RESOURCE_INVENTORY_FILE: inventoryFile,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: inventory.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
    V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE: dependencyFile,
    V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION: dependency.artifactSha256,
    ...overrides,
  };
}

function llmSmokeEvidenceFor(config, label) {
  const record = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: TEST_RELEASE_COMMIT,
    capability: 'llm',
    provider: config.provider,
    contractVersion: 'llm-connectivity-json-v1',
    providerConfigDigest: llmProviderConfigDigest(config),
    occurredAt: new Date().toISOString(),
    result: 'pass',
    httpClass: '2xx',
    normalizedSuccess: true,
    requestCount: 1,
    latencyMs: 1,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  });
  const file = join(evidenceDirectory, `llm-smoke-${label}.json`);
  writeFileSync(file, JSON.stringify(record));
  return { file, version: record.artifactSha256 };
}

function googleProductionEnvironment(overrides = {}) {
  return productionEnvironment(overrides);
}

test('config defaults to a local atomic-file runtime outside production', () => {
  const config = loadConfig({ NODE_ENV: 'test' });

  assert.equal(config.storeDriver, 'atomic-file');
  assert.equal(config.publicOrigin, 'http://localhost:3000');
  assert.equal(config.productionReady, false);
  assert.deepEqual(config.rateLimits, {
    bootstrapClient10m: 4,
    bootstrapCoarseIp10m: 100,
    message5m: 30,
    messageDaily: 300,
    asr10m: 10,
    asrDaily: 60,
    tts10m: 5,
    ttsDaily: 20,
    practiceMessage5m: 30,
    practiceMessageDaily: 300,
    practiceCorrect5m: 20,
    visitTranslate5m: 30,
    visitTranslateDaily: 200,
    report5m: 20,
  });
});

test('NODE_ENV accepts only the exact development, test, or production values', () => {
  assert.equal(loadConfig({}).nodeEnv, 'development');
  assert.equal(loadConfig({ NODE_ENV: 'development' }).nodeEnv, 'development');
  assert.equal(loadConfig({ NODE_ENV: 'test' }).nodeEnv, 'test');
  for (const nodeEnv of ['', 'Production', ' staging ', 'staging', 'prod']) {
    assert.throws(() => loadConfig({ NODE_ENV: nodeEnv }), /NODE_ENV/i, nodeEnv);
  }
});

test('config exposes bounded runtime and PostgreSQL deadlines from explicit V1 settings', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_DEPENDENCY_INIT_TIMEOUT_MS: '2400',
    V1_READINESS_CHECK_TIMEOUT_MS: '1800',
    V1_READINESS_WATCHDOG_INTERVAL_MS: '24000',
    V1_STARTUP_STEP_TIMEOUT_MS: '7200',
    V1_POSTGRES_CONNECTION_TIMEOUT_MS: '1600',
    V1_POSTGRES_QUERY_TIMEOUT_MS: '2600',
    V1_POSTGRES_STATEMENT_TIMEOUT_MS: '2200',
  });

  assert.deepEqual({
    dependencyInitTimeoutMs: config.dependencyInitTimeoutMs,
    readinessCheckTimeoutMs: config.readinessCheckTimeoutMs,
    readinessWatchdogIntervalMs: config.readinessWatchdogIntervalMs,
    startupStepTimeoutMs: config.startupStepTimeoutMs,
    postgresConnectionTimeoutMs: config.postgresConnectionTimeoutMs,
    postgresQueryTimeoutMs: config.postgresQueryTimeoutMs,
    postgresStatementTimeoutMs: config.postgresStatementTimeoutMs,
  }, {
    dependencyInitTimeoutMs: 2400,
    readinessCheckTimeoutMs: 1800,
    readinessWatchdogIntervalMs: 24000,
    startupStepTimeoutMs: 7200,
    postgresConnectionTimeoutMs: 1600,
    postgresQueryTimeoutMs: 2600,
    postgresStatementTimeoutMs: 2200,
  });

  for (const [name, value] of [
    ['V1_DEPENDENCY_INIT_TIMEOUT_MS', '99'],
    ['V1_READINESS_CHECK_TIMEOUT_MS', '10001'],
    ['V1_READINESS_WATCHDOG_INTERVAL_MS', '999'],
    ['V1_STARTUP_STEP_TIMEOUT_MS', '60001'],
    ['V1_POSTGRES_CONNECTION_TIMEOUT_MS', '0'],
    ['V1_POSTGRES_QUERY_TIMEOUT_MS', '30001'],
    ['V1_POSTGRES_STATEMENT_TIMEOUT_MS', 'private'],
  ]) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', [name]: value }), /Numeric configuration/i, name);
  }
});

test('LLM smoke bootstrap uses strict production V1 semantics without requiring its future evidence file', () => {
  const environment = {
    NODE_ENV: 'test',
    V1_RELEASE_COMMIT_SHA: TEST_RELEASE_COMMIT,
    V1_RUNTIME_SERVICE_ACCOUNT: TEST_RUNTIME_SERVICE_ACCOUNT,
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_LLM_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
    V1_GOOGLE_CLOUD_PROJECT: TEST_GCS_PROJECT,
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
  };
  const smokeConfig = loadLlmSmokeConfiguration(environment, { now: () => new Date() });
  assert.equal(smokeConfig.releaseCommitSha, TEST_RELEASE_COMMIT);
  assert.equal(smokeConfig.llm.available, true);
  assert.equal(smokeConfig.llm.provider, 'vertex-ai');
  assert.equal(smokeConfig.llm.credentialVersion, 'runtime-sa-rotation-v1');
  assert.equal(Object.hasOwn(smokeConfig, 'llmEvidence'), false);

  for (const [name, invalid] of [
    ['uppercase SHA', { ...environment, V1_RELEASE_COMMIT_SHA: TEST_RELEASE_COMMIT.toUpperCase() }],
    ['wrong provider', {
      ...environment,
      V1_LLM_PROVIDER: 'hkbu',
      V1_HKBU_API_KEY: 'private-key',
      V1_HKBU_BASE_URL: 'https://hkbu.example.test',
      V1_HKBU_MODEL: 'hkbu-model',
      V1_HKBU_API_VERSION: 'v1',
    }],
    ['missing credential version', { ...environment, V1_LLM_CREDENTIAL_VERSION: undefined }],
    ['missing runtime identity', { ...environment, V1_RUNTIME_SERVICE_ACCOUNT: undefined }],
    ['provider key residue', { ...environment, V1_MINIMAX_API_KEY: 'must-not-be-accepted' }],
    ['legacy-only provider settings', {
      V1_RELEASE_COMMIT_SHA: TEST_RELEASE_COMMIT,
      V1_LLM_CREDENTIAL_VERSION: TEST_LLM_CREDENTIAL_VERSION,
      LLM_PROVIDER: 'hkbu', HKBU_API_KEY: 'private-key',
      HKBU_BASE_URL: 'https://hkbu.example.test', HKBU_MODEL: 'hkbu-model', HKBU_API_VERSION: 'v1',
    }],
  ]) {
    assert.throws(() => loadLlmSmokeConfiguration(invalid), /LLM|release|provider|configuration|runtime/i, name);
  }
});

test('production accepts only exact Google ADC providers and rejects coherent non-Google evidence', () => {
  const exactGoogle = loadConfig(googleProductionEnvironment());
  assert.equal(exactGoogle.llm.provider, 'vertex-ai');
  assert.equal(exactGoogle.asr.provider, 'google-stt-v2');
  assert.equal(exactGoogle.tts.provider, 'google-tts');

  const providerCases = [
    ['hkbu', {
      provider: 'hkbu', credentialVersion: 'legacy-key-v1', timeoutMs: 12_000,
      settings: { apiKey: 'key', baseUrl: 'https://hkbu.example.test', model: 'model', apiVersion: 'v1' },
    }, {
      V1_LLM_PROVIDER: 'hkbu', V1_LLM_CREDENTIAL_VERSION: 'legacy-key-v1',
      V1_HKBU_API_KEY: 'key', V1_HKBU_BASE_URL: 'https://hkbu.example.test',
      V1_HKBU_MODEL: 'model', V1_HKBU_API_VERSION: 'v1',
    }],
    ['azure-openai', {
      provider: 'azure-openai', credentialVersion: 'legacy-key-v1', timeoutMs: 12_000,
      settings: {
        apiKey: 'key', endpoint: 'https://azure.example.test', deployment: 'chat',
        apiVersion: '2024-10-21', requestProfile: 'standard', minCompletionTokens: 1600,
      },
    }, {
      V1_LLM_PROVIDER: 'azure-openai', V1_LLM_CREDENTIAL_VERSION: 'legacy-key-v1',
      V1_AZURE_OPENAI_KEY: 'key', V1_AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
      V1_AZURE_OPENAI_DEPLOYMENT: 'chat', V1_AZURE_OPENAI_API_VERSION: '2024-10-21',
      V1_AZURE_OPENAI_REQUEST_PROFILE: 'standard',
    }],
    ['minimax', {
      provider: 'minimax', credentialVersion: 'legacy-key-v1', timeoutMs: 12_000,
      settings: {
        apiKey: 'key', baseUrl: 'https://minimax.example.test',
        anthropicBaseUrl: 'https://anthropic.example.test', model: 'model',
      },
    }, {
      V1_LLM_PROVIDER: 'minimax', V1_LLM_CREDENTIAL_VERSION: 'legacy-key-v1',
      V1_MINIMAX_API_KEY: 'key', V1_MINIMAX_BASE_URL: 'https://minimax.example.test',
      V1_MINIMAX_ANTHROPIC_BASE_URL: 'https://anthropic.example.test', V1_MINIMAX_LLM_MODEL: 'model',
    }],
  ];
  for (const [name, config, providerEnvironment] of providerCases) {
    const evidence = llmSmokeEvidenceFor(config, `coherent-${name}`);
    assert.throws(() => loadConfig(productionEnvironment({
      ...providerEnvironment,
      V1_LLM_SMOKE_EVIDENCE_FILE: evidence.file,
      V1_LLM_SMOKE_EVIDENCE_VERSION: evidence.version,
    })), /Google|Vertex|provider|ADC/i, name);
  }

  for (const [name, overrides] of [
    ['Azure ASR', {
      V1_ASR_PROVIDER: 'azure', V1_AZURE_SPEECH_KEY: 'key',
      V1_AZURE_SPEECH_REGION: 'eastasia', V1_AZURE_SPEECH_CREDENTIAL_VERSION: 'key-v1',
    }],
    ['MiniMax TTS', {
      V1_TTS_PROVIDER: 'minimax', V1_MINIMAX_API_KEY: 'key',
      V1_MINIMAX_BASE_URL: 'https://minimax.example.test', V1_MINIMAX_TTS_MODEL: 'speech-01',
      V1_MINIMAX_TTS_VOICE: 'voice', V1_MINIMAX_CREDENTIAL_VERSION: 'key-v1',
    }],
  ]) assert.throws(() => loadConfig(googleProductionEnvironment(overrides)), /Google|speech|provider|ADC/i, name);
});

test('production rejects inactive provider API-key residue while local compatibility remains', () => {
  for (const name of [
    'V1_HKBU_API_KEY', 'HKBU_API_KEY',
    'V1_AZURE_OPENAI_KEY', 'AZURE_OPENAI_KEY',
    'V1_MINIMAX_API_KEY', 'MINIMAX_API_KEY',
    'V1_AZURE_SPEECH_KEY', 'AZURE_SPEECH_KEY',
  ]) {
    assert.throws(
      () => loadConfig(googleProductionEnvironment({ [name]: 'must-not-be-accepted' })),
      /ADC|API.key|provider|secret/i,
      name,
    );
  }
  assert.equal(loadConfig({
    NODE_ENV: 'test', V1_LLM_PROVIDER: 'hkbu', HKBU_API_KEY: 'local-key',
    HKBU_BASE_URL: 'https://hkbu.example.test', HKBU_MODEL: 'model', HKBU_API_VERSION: 'v1',
  }).llm.available, true);
});

test('normal production config requires current file-bound LLM smoke evidence before startup', () => {
  for (const [name, overrides] of [
    ['missing evidence file', { V1_LLM_SMOKE_EVIDENCE_FILE: undefined }],
    ['missing evidence version', { V1_LLM_SMOKE_EVIDENCE_VERSION: undefined }],
    ['missing credential version', { V1_LLM_CREDENTIAL_VERSION: undefined }],
    ['provider config drift', { V1_VERTEX_MODEL: 'drifted-model' }],
    ['version mismatch', { V1_LLM_SMOKE_EVIDENCE_VERSION: 'f'.repeat(64) }],
  ]) {
    assert.throws(
      () => loadConfig(productionEnvironment(overrides)),
      /LLM|smoke evidence|credential|Vertex/i,
      name,
    );
  }
});

test('config rejects production without a public origin', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /V1_PUBLIC_ORIGIN/);
});

test('config requires a canonical HTTPS production origin and derives only a local preview default', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test', PORT: '4173' }).publicOrigin, 'http://localhost:4173');
  for (const publicOrigin of [
    'http://v1.example.test',
    'https://v1.example.test/path',
    'https://user:password@v1.example.test',
    'https://v1.example.test?private=true',
  ]) {
    assert.throws(
      () => loadConfig(productionEnvironment({ V1_PUBLIC_ORIGIN: publicOrigin })),
      /V1_PUBLIC_ORIGIN|HTTPS origin/i,
    );
  }
  const legacyOriginOnly = productionEnvironment({ PUBLIC_ORIGIN: 'https://legacy.example.test' });
  delete legacyOriginOnly.V1_PUBLIC_ORIGIN;
  assert.throws(() => loadConfig(legacyOriginOnly), /V1_PUBLIC_ORIGIN/);

  const legacySecretOnly = productionEnvironment({ SESSION_SECRET: 'l'.repeat(64) });
  delete legacySecretOnly.V1_SESSION_SECRET;
  assert.throws(() => loadConfig(legacySecretOnly), /V1_SESSION_SECRET/);
});

test('production origin allowlist is exactly stable plus the SHA-bound candidate and proxy depth is one', () => {
  const config = loadConfig(productionEnvironment());
  assert.deepEqual(config.allowedOrigins, [TEST_STABLE_ORIGIN, TEST_CANDIDATE_ORIGIN]);
  assert.equal(config.trustedProxyHops, 1);
  assert.equal(config.runtimeServiceAccount, TEST_RUNTIME_SERVICE_ACCOUNT);
  for (const overrides of [
    { V1_CANDIDATE_ORIGIN: `https://other---hkbuddy-v1-api-${TEST_PROJECT_NUMBER}.asia-east2.run.app` },
    { V1_CANDIDATE_ORIGIN: `https://candidate-${'b'.repeat(12)}---hkbuddy-v1-api-candidate-${TEST_PROJECT_NUMBER}.asia-east2.run.app` },
    { V1_CANDIDATE_ORIGIN: `https://candidate-${TEST_RELEASE_COMMIT.slice(0, 12)}---hkbuddy-v1-api-candidate-999999999999.asia-east2.run.app` },
    { V1_PUBLIC_ORIGIN: `https://hkbuddy-api-${TEST_PROJECT_NUMBER}.asia-east2.run.app` },
    { V1_PUBLIC_ORIGIN: 'https://hkbuddy-pilot-0630.azurewebsites.net' },
    { V1_TRUST_PROXY_HOPS: '2' },
    { V1_RUNTIME_SERVICE_ACCOUNT: 'hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com' },
  ]) {
    assert.throws(() => loadConfig(productionEnvironment(overrides)), /origin|candidate|proxy|runtime service account/i);
  }
});

test('production requires exact V1-only postgres plus private GCS identity while Azure aliases stay local-only', () => {
  const configured = loadConfig(productionEnvironment());
  assert.deepEqual({
    storeDriver: configured.storeDriver,
    mediaDriver: configured.mediaDriver,
    projectId: configured.gcsProjectId,
    bucket: configured.gcsBucket,
    resourceId: configured.gcsResourceId,
    authMode: configured.mediaAuthMode,
  }, {
    storeDriver: 'postgres',
    mediaDriver: 'gcs',
    projectId: TEST_GCS_PROJECT,
    bucket: TEST_GCS_BUCKET,
    resourceId: TEST_GCS_RESOURCE_ID,
    authMode: 'adc',
  });

  for (const [name, overrides] of [
    ['Azure production driver', { V1_MEDIA_DRIVER: 'azure-blob' }],
    ['old project', { V1_GOOGLE_CLOUD_PROJECT: 'hkbuddy-prod-v1-20260826' }],
    ['old bucket', { V1_GCS_BUCKET: 'hkbuddy-prod-v1-20260826-media' }],
    ['wrong resource', { V1_GCS_RESOURCE_ID: `gs://${TEST_GCS_BUCKET}` }],
    ['missing bucket with unprefixed fallback', { V1_GCS_BUCKET: undefined, GCS_BUCKET: TEST_GCS_BUCKET }],
    ['missing driver with unprefixed fallback', { V1_MEDIA_DRIVER: undefined, MEDIA_DRIVER: 'gcs' }],
  ]) assert.throws(() => loadConfig(productionEnvironment(overrides)), /GCS|V1_MEDIA_DRIVER|project|bucket|resource/i, name);

  const localAzure = loadConfig({
    NODE_ENV: 'test',
    MEDIA_DRIVER: 'azure-blob',
    AZURE_BLOB_CONTAINER: 'local-private-media',
    AZURE_BLOB_ACCOUNT_URL: 'https://localfixture.blob.core.windows.net/',
  });
  assert.equal(localAzure.mediaDriver, 'azure-blob');
  assert.equal(localAzure.mediaAuthMode, 'managed-identity');
});

test('production rejects coherent foreign project, instance, or database PostgreSQL tuples', async (t) => {
  const cases = [
    ['project', '//sqladmin.googleapis.com/projects/foreign-project/instances/hkbuddy-v1-pg/databases/hkbuddy_v1'],
    ['instance', '//sqladmin.googleapis.com/projects/motion-expert-hk-ltd-webpage/instances/foreign-pg/databases/hkbuddy_v1'],
    ['database', '//sqladmin.googleapis.com/projects/motion-expert-hk-ltd-webpage/instances/hkbuddy-v1-pg/databases/foreign_db'],
  ];
  for (const [name, foreignPostgresResourceId] of cases) {
    await t.test(name, () => {
      const foreignDatabaseUrl = `postgresql://foreign-app:private@test.internal:5432/foreign_${name}?sslmode=require`;
      const foreignDependency = finalizeReleaseEvidenceRecord({
        schemaVersion: 1,
        commitSha: TEST_RELEASE_COMMIT,
        legacyInventoryDigest: inventory.artifactSha256,
        postgresResourceId: foreignPostgresResourceId,
        postgresIdentitySha256: postgresIdentitySha256(foreignDatabaseUrl),
        gcsResourceId: TEST_GCS_RESOURCE_ID,
        gcsIdentitySha256: gcsIdentitySha256({ projectId: TEST_GCS_PROJECT, bucket: TEST_GCS_BUCKET }),
        schema: 'v1_accept_12345678123441238123123456789abc',
        gcsPrefix: 'v1-accept/12345678-1234-4123-8123-123456789abc/',
        checks: dependency.checks,
        schemaAbsent: true,
        gcsPrefixObjectCount: 0,
        result: true,
        occurredAt: new Date().toISOString(),
      });
      const foreignDependencyFile = join(evidenceDirectory, `dependency-foreign-postgres-${name}.json`);
      writeFileSync(foreignDependencyFile, JSON.stringify(foreignDependency));

      assert.throws(() => loadConfig(productionEnvironment({
        V1_DATABASE_URL: foreignDatabaseUrl,
        V1_POSTGRES_RESOURCE_ID: foreignPostgresResourceId,
        V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE: foreignDependencyFile,
        V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION: foreignDependency.artifactSha256,
      })), /PostgreSQL|POSTGRES_RESOURCE_ID|exact/i);
    });
  }
});

test('config gives V1 provider selectors precedence over legacy selectors', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'hkbu',
    LLM_PROVIDER: 'minimax',
    HKBU_API_KEY: 'test-key',
    HKBU_BASE_URL: 'https://hkbu.example.test',
    HKBU_MODEL: 'hkbu-model',
    HKBU_API_VERSION: 'v1',
  });

  assert.equal(config.llm.provider, 'hkbu');
  assert.equal(config.llm.available, true);
});

test('config requires every explicit selected LLM provider member', () => {
  const providers = [
    {
      name: 'HKBU',
      selector: 'hkbu',
      values: {
        HKBU_API_KEY: 'key', HKBU_BASE_URL: 'https://hkbu.example.test',
        HKBU_MODEL: 'hkbu-model', HKBU_API_VERSION: 'v1',
      },
    },
    {
      name: 'Azure OpenAI',
      selector: 'azure-openai',
      values: {
        AZURE_OPENAI_KEY: 'key', AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
        AZURE_OPENAI_DEPLOYMENT: 'chat', AZURE_OPENAI_API_VERSION: '2024-10-21',
        AZURE_OPENAI_REQUEST_PROFILE: 'standard',
      },
    },
    {
      name: 'MiniMax',
      selector: 'minimax',
      values: {
        MINIMAX_API_KEY: 'key', MINIMAX_BASE_URL: 'https://minimax.example.test',
        MINIMAX_ANTHROPIC_BASE_URL: 'https://anthropic.example.test', MINIMAX_LLM_MODEL: 'model',
      },
    },
  ];

  for (const provider of providers) {
    const complete = { NODE_ENV: 'test', V1_LLM_PROVIDER: provider.selector, ...provider.values };
    assert.equal(loadConfig(complete).llm.available, true, `${provider.name} complete pair is available`);

    for (const missingMember of Object.keys(provider.values)) {
      const incompleteValues = { ...provider.values };
      delete incompleteValues[missingMember];
      const incomplete = { NODE_ENV: 'test', V1_LLM_PROVIDER: provider.selector, ...incompleteValues };
      assert.equal(loadConfig(incomplete).llm.available, false, `${provider.name} requires ${missingMember} locally`);
    }
  }

  const azureVoice = loadConfig({
    NODE_ENV: 'test', V1_ASR_PROVIDER: 'azure', V1_TTS_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'key', AZURE_SPEECH_REGION: 'eastasia',
  });
  const minimaxVoice = loadConfig({
    NODE_ENV: 'test', V1_ASR_PROVIDER: 'minimax', V1_TTS_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'key', MINIMAX_ASR_ENABLED: 'true', MINIMAX_ASR_ENDPOINT: 'https://asr.example.test',
    MINIMAX_ASR_MODEL: 'asr-model', MINIMAX_BASE_URL: 'https://minimax.example.test',
    MINIMAX_TTS_MODEL: 'tts-model', MINIMAX_TTS_VOICE: 'voice',
  });

  assert.equal(azureVoice.asr.available, true);
  assert.equal(azureVoice.tts.available, true);
  assert.equal(minimaxVoice.asr.available, false);
  assert.equal(minimaxVoice.tts.available, true);
});

test('config gives V1 voice selectors precedence over legacy selectors', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_ASR_PROVIDER: 'none', ASR_PROVIDER: 'azure',
    V1_TTS_PROVIDER: 'none', TTS_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'key', AZURE_SPEECH_REGION: 'eastasia',
  });

  assert.equal(config.asr.provider, 'none');
  assert.equal(config.tts.provider, 'none');
  assert.equal(config.asr.available, false);
  assert.equal(config.tts.available, false);
});

test('Google AI config is ADC-only, V1-prefixed, and binds one exact voice per locale', () => {
  const google = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_LLM_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
    V1_GOOGLE_CLOUD_PROJECT: TEST_GCS_PROJECT,
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
  });

  assert.equal(google.llm.available, true);
  assert.deepEqual(google.llm.settings, {
    projectId: TEST_GCS_PROJECT,
    location: 'global',
    model: 'gemini-2.5-flash',
  });
  assert.equal(google.asr.available, true);
  assert.deepEqual(google.asr.settings.languageCodes, ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN']);
  assert.equal(google.tts.available, true);
  assert.deepEqual(google.tts.settings.voices, {
    en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
    yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
    zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
  });
  assert.equal(JSON.stringify(google).includes('apiKey'), false);

  const invalid = [
    ['legacy project', { GOOGLE_CLOUD_PROJECT: 'legacy-project', V1_GOOGLE_CLOUD_PROJECT: undefined }],
    ['wrong model', { V1_VERTEX_MODEL: 'gemini-latest' }],
    ['wrong STT region', { V1_GOOGLE_STT_LOCATION: 'global' }],
    ['wrong recognizer', { V1_GOOGLE_STT_RECOGNIZER: 'default' }],
    ['voice locale mismatch', { V1_GOOGLE_TTS_VOICE_YUE: 'en-US-Chirp3-HD-Achernar' }],
    ['API key', { V1_GOOGLE_API_KEY: 'must-not-be-accepted' }],
    ['credential JSON', { GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"private_key":"must-not-be-accepted"}' }],
  ];
  const base = {
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'vertex-ai', V1_LLM_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
    V1_GOOGLE_CLOUD_PROJECT: TEST_GCS_PROJECT, V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash', V1_ASR_PROVIDER: 'google-stt-v2',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1', V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_', V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
  };
  for (const [name, override] of invalid) {
    assert.throws(() => loadConfig({ ...base, ...override }), /Google|Vertex|ADC|voice|recognizer|project/i, name);
  }
});

test('production ignores unprefixed voice selectors while local provider compatibility remains', () => {
  const legacyOnly = loadConfig(productionEnvironment({
    ASR_PROVIDER: 'azure', TTS_PROVIDER: 'azure',
  }));
  assert.equal(legacyOnly.asr.provider, 'google-stt-v2');
  assert.equal(legacyOnly.tts.provider, 'google-tts');
  assert.equal(legacyOnly.asr.available, true);
  assert.equal(legacyOnly.tts.available, true);

  const local = loadConfig({
    NODE_ENV: 'test', ASR_PROVIDER: 'azure', TTS_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'legacy-secret', AZURE_SPEECH_REGION: 'eastasia',
  });
  assert.equal(local.asr.available, true);
  assert.equal(local.tts.available, true);
});

test('config requires the Azure deployment setting rather than a model alias', () => {
  const azureModelOnly = {
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'azure-openai',
    AZURE_OPENAI_KEY: 'key',
    AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
    AZURE_OPENAI_MODEL: 'not-a-deployment',
    AZURE_OPENAI_API_VERSION: '2024-10-21',
    AZURE_OPENAI_REQUEST_PROFILE: 'standard',
  };

  assert.equal(loadConfig(azureModelOnly).llm.available, false);
});

test('config fails closed when selected Azure lacks an explicit allowed request profile', () => {
  const base = {
    NODE_ENV: 'test', V1_LLM_PROVIDER: 'azure-openai',
    V1_AZURE_OPENAI_KEY: 'key', V1_AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
    V1_AZURE_OPENAI_DEPLOYMENT: 'neutral-slot', V1_AZURE_OPENAI_API_VERSION: '2024-10-21',
  };
  assert.equal(loadConfig(base).llm.available, false);
  assert.equal(loadConfig({ ...base, V1_AZURE_OPENAI_REQUEST_PROFILE: 'standard' }).llm.available, true);
  assert.equal(loadConfig({ ...base, V1_AZURE_OPENAI_REQUEST_PROFILE: 'reasoning' }).llm.available, true);
  assert.throws(() => loadConfig({ ...base, V1_AZURE_OPENAI_REQUEST_PROFILE: 'auto' }), /REQUEST_PROFILE/);
});

test('config disables incomplete voice providers without disabling text', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'hkbu',
    HKBU_API_KEY: 'test-key',
    HKBU_BASE_URL: 'https://hkbu.example.test',
    HKBU_MODEL: 'hkbu-model',
    HKBU_API_VERSION: 'v1',
    V1_ASR_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'speech-key',
    V1_TTS_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'minimax-key',
    MINIMAX_BASE_URL: 'https://api.example.test',
    MINIMAX_TTS_MODEL: 'speech-model',
  });

  assert.equal(config.llm.available, true);
  assert.equal(config.asr.available, false);
  assert.equal(config.tts.available, false);
});

test('config rejects an incomplete selected production LLM after earlier gates pass', () => {
  assert.throws(
    () => loadConfig(productionEnvironment({ V1_VERTEX_MODEL: undefined })),
    /Vertex|configured.*LLM provider/i,
  );
});

test('config rejects legacy-only trusted proxy hops in production', () => {
  assert.throws(
    () => loadConfig(productionEnvironment({ V1_TRUST_PROXY_HOPS: undefined, TRUST_PROXY_HOPS: '1' })),
    /V1_TRUST_PROXY_HOPS/,
  );
});

test('config marks a fully configured production environment configuration-ready but runtime-gated', () => {
  const config = loadConfig(productionEnvironment());

  assert.equal(config.productionConfigurationReady, true);
  assert.equal(config.productionReady, false);
  assert.equal(config.publicStatus.productionReady, false);
});

test('config public status contains capability booleans rather than secret values', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'hkbu',
    HKBU_API_KEY: 'very-secret-value',
    HKBU_BASE_URL: 'https://hkbu.example.test',
    HKBU_MODEL: 'hkbu-model',
    HKBU_API_VERSION: 'v1',
  });

  assert.deepEqual(config.publicStatus, {
    productionReady: false,
    llmAvailable: true,
    asrConfigured: false,
    ttsConfigured: false,
    voiceInputPreview: false,
    voiceOutputPreview: false,
    voiceInput: false,
    voiceOutput: false,
    iosVoiceCertified: false,
    iosTestflightVoiceCertified: false,
    iosAppStoreVoiceInput: false,
    requireAiConsent: false,
    asrEvidenceVersion: null,
    ttsEvidenceVersion: null,
    iosVoiceAcceptanceVersion: null,
    iosTestflightVoiceAcceptanceVersion: null,
    privacyNoticeVersion: null,
    releaseCommitSha: null,
    normalizerContractVersion: 'canonical-wav-v1',
  });
  assert.equal(JSON.stringify(config.publicStatus).includes('very-secret-value'), false);
});

test('config logger retains operational fields and drops user content and secrets', () => {
  const entries = [];
  const logger = createLogger((entry) => entries.push(entry));

  logger.info({
    requestId: 'req-1',
    conversationHash: 'hashed-conversation',
    stage: 'generating',
    provider: 'hkbu',
    statusClass: 200,
    latencyMs: 18,
    tokenCount: 42,
    message: 'private message',
    transcript: 'private transcript',
    prompt: 'private prompt',
    cookie: 'private cookie',
    authorization: 'Bearer private',
    providerBody: 'private body',
    apiKey: 'private key',
  });

  assert.deepEqual(entries, [{
    requestId: 'req-1',
    conversationHash: 'hashed-conversation',
    stage: 'generating',
    provider: 'hkbu',
    statusClass: 200,
    latencyMs: 18,
  }]);
});

test('shell presents one AI assistant conversation without legacy modes', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(html, /Hong Kong Buddy/);
  assert.match(html, /Your HKBU AI senior/);
  assert.match(html, /AI assistant/);
  assert.doesNotMatch(html, />\s*(?:MODE|SCENARIO|START MISSION)\s*</i);
});

test('shell app serves a safe liveness envelope with a request ID', async (t) => {
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }) });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health/live`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  assert.deepEqual(body.error, null);
  assert.equal(body.data.status, 'ok');
  assert.equal(typeof body.data.version, 'string');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
});

test('liveness never calls dependencies while readiness publishes only the injected public boundary', async (t) => {
  let readinessCalls = 0;
  const app = createApp({
    config: loadConfig({ NODE_ENV: 'test' }),
    readiness: async () => {
      readinessCalls += 1;
      return {
        exitCode: 2,
        publicReport: {
          status: 'preview',
          productionReady: false,
          boundary: 'local-preview-only',
          privateUrl: 'https://private.example.test',
          checks: [{
            name: 'configuration', status: 'preview', version: 'local-preview-v1', privateDigest: 'f'.repeat(64),
          }],
        },
      };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${baseUrl}/api/health/live`)).status, 200);
  assert.equal(readinessCalls, 0);
  const response = await fetch(`${baseUrl}/api/health/ready`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(readinessCalls, 1);
  assert.deepEqual(body.data, {
    status: 'preview',
    productionReady: false,
    boundary: 'local-preview-only',
    checks: [{ name: 'configuration', status: 'preview', version: 'local-preview-v1' }],
  });
  assert.deepEqual(body.error, null);
});

test('readiness failures remain redacted and fail closed', async (t) => {
  const app = createApp({
    config: loadConfig({ NODE_ENV: 'test' }),
    readiness: async () => { throw new Error('private database endpoint and credentials'); },
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health/ready`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.data.productionReady, false);
  assert.equal(body.data.status, 'not-ready');
  assert.equal(JSON.stringify(body).includes('private database'), false);
});

test('a production-configured app without server runtime state fails closed for writes', async (t) => {
  const config = loadConfig({ NODE_ENV: 'test' });
  config.nodeEnv = 'production';
  config.productionConfigurationReady = true;
  const app = createApp({ config });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/session`, { method: 'POST' });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error?.code, 'PRODUCTION_NOT_READY');
});

test('shell app rejects cross-origin state-changing requests with a safe error', async (t) => {
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: 'https://v1.example.test' }) });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/session`, {
    method: 'POST',
    headers: { Origin: 'https://other.example.test' },
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(body.data, null);
  assert.equal(body.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(typeof body.requestId, 'string');
});
