import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXPECTED_PROVISION_STEPS,
  GcpControlPlane,
  assertExactCustomRoleDefinitions,
  assertExactManagedIamPolicies,
  assertManagedIamPoliciesSubset,
  assertNoUserManagedServiceAccountKeys,
  assertCidrAvailable,
  assertResourceContract,
  createAuthenticatedRequest,
  createDefaultGcloudTextExecutor,
  createGcloudExecutor,
  createGcloudAuthenticatedRequest,
  ensureExactResource,
  loadResourceContract,
  monitoringGroupByField,
  runGcpProvision,
  validateComputeAddressInventory,
} from '../scripts/gcp-provision.js';
import { runGcpPreflight } from '../scripts/gcp-preflight.js';
import {
  GCP_IDENTITY,
  GCP_OBSOLETE_EXECUTABLE_IDENTITIES,
} from '../src/gcp-identity.js';

const CONTRACT_URL = new URL('../infra/gcp/resource-contract.json', import.meta.url);
const OPERATOR_README_URL = new URL('../infra/gcp/README.md', import.meta.url);
const SHARED_PROJECT_PLAN_URL = new URL(
  '../../docs/superpowers/plans/2026-08-26-production-v1-shared-project-isolation.md',
  import.meta.url,
);
const PROJECT = GCP_IDENTITY.projectId;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const CHANNEL = `projects/${PROJECT}/notificationChannels/123456789`;
const PROJECT_ID_CHANNEL = CHANNEL;
const NUMERIC_CHANNEL = `projects/${PROJECT_NUMBER}/notificationChannels/123456789`;
const ASSET_PROJECT = `projects/${PROJECT_NUMBER}`;
const ASSET_PROJECT_PARENT = `//cloudresourcemanager.googleapis.com/projects/${PROJECT}`;
const ASSET_PROJECT_TYPE = 'cloudresourcemanager.googleapis.com/Project';
const ASSET_READ_MASK = 'name,assetType,project,displayName,description,location,labels,parentFullResourceName,parentAssetType,state';
const ACCEPTANCE_BUCKET_METADATA_ROLE = Object.freeze({
  id: 'hkbuddyV1AcceptanceBucketMetadataReader',
  name: `projects/${PROJECT}/roles/hkbuddyV1AcceptanceBucketMetadataReader`,
  title: 'HK Buddy acceptance bucket metadata reader',
  description: 'Read fixed media bucket metadata for dependency acceptance',
  includedPermissions: ['storage.buckets.get'],
  stage: 'GA',
});
const BUCKET_IAM_OPERATOR_ROLE = Object.freeze({
  id: 'hkbuddyV1BucketIamPolicyOperator',
  name: `projects/${PROJECT}/roles/hkbuddyV1BucketIamPolicyOperator`,
  title: 'HK Buddy V1 bucket IAM policy operator',
  description: 'Manage IAM policies for the two Hong Kong Buddy V1 buckets',
  includedPermissions: [
    'storage.buckets.get',
    'storage.buckets.getIamPolicy',
    'storage.buckets.setIamPolicy',
  ],
  stage: 'GA',
});
const BUCKET_IAM_OPERATOR_CONDITION = Object.freeze({
  title: 'HK Buddy V1 bucket IAM boundary',
  description: 'Limit operator bucket IAM access to the two Hong Kong Buddy V1 buckets',
  expression: `resource.service == "storage.googleapis.com" && resource.type == "storage.googleapis.com/Bucket" && (resource.name == "projects/_/buckets/${GCP_IDENTITY.bucket}" || resource.name == "projects/_/buckets/${GCP_IDENTITY.buildSourceBucket}")`,
});
const BUCKET_IAM_OPERATOR_BINDING = Object.freeze({
  scope: 'project',
  member: 'user:admin@motionexp.com',
  role: BUCKET_IAM_OPERATOR_ROLE.name,
  condition: BUCKET_IAM_OPERATOR_CONDITION,
});
const RELEASE_EVIDENCE_OPERATOR_ROLE = Object.freeze({
  id: 'hkbuddyV1ReleaseEvidenceObjectOperator',
  name: `projects/${PROJECT}/roles/hkbuddyV1ReleaseEvidenceObjectOperator`,
  title: 'HK Buddy V1 release evidence object operator',
  description: 'Collect and clean release evidence in the fixed media bucket',
  includedPermissions: [
    'storage.objects.delete',
    'storage.objects.get',
    'storage.objects.list',
  ],
  stage: 'GA',
});
const RELEASE_EVIDENCE_OPERATOR_CONDITION = Object.freeze({
  title: 'HK Buddy V1 release evidence object boundary',
  description: 'List the media bucket and collect or clean only release-evidence objects',
  expression: `resource.service == "storage.googleapis.com" && ((resource.type == "storage.googleapis.com/Bucket" && resource.name == "projects/_/buckets/${GCP_IDENTITY.bucket}") || (resource.type == "storage.googleapis.com/Object" && resource.name.startsWith("projects/_/buckets/${GCP_IDENTITY.bucket}/objects/release-evidence/")))`,
});
const RELEASE_EVIDENCE_OPERATOR_BINDING = Object.freeze({
  scope: 'project',
  member: 'user:admin@motionexp.com',
  role: RELEASE_EVIDENCE_OPERATOR_ROLE.name,
  condition: RELEASE_EVIDENCE_OPERATOR_CONDITION,
});

const AUTOMATIC_PROJECT_BINDINGS = Object.freeze([
  { member: 'user:admin@motionexp.com', role: 'roles/owner', required: true },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-cloudbuild.iam.gserviceaccount.com', role: 'roles/cloudbuild.serviceAgent', required: true },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@container-analysis.iam.gserviceaccount.com', role: 'roles/containeranalysis.ServiceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@containerregistry.iam.gserviceaccount.com', role: 'roles/containerregistry.ServiceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-pubsub.iam.gserviceaccount.com', role: 'roles/pubsub.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-artifactregistry.iam.gserviceaccount.com', role: 'roles/artifactregistry.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@compute-system.iam.gserviceaccount.com', role: 'roles/compute.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@service-networking.iam.gserviceaccount.com', role: 'roles/servicenetworking.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-cloud-sql.iam.gserviceaccount.com', role: 'roles/cloudsql.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@serverless-robot-prod.iam.gserviceaccount.com', role: 'roles/run.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-aiplatform.iam.gserviceaccount.com', role: 'roles/aiplatform.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-speech.iam.gserviceaccount.com', role: 'roles/speech.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-monitoring-notification.iam.gserviceaccount.com', role: 'roles/monitoring.notificationServiceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-logging.iam.gserviceaccount.com', role: 'roles/logging.serviceAgent', required: false },
  { member: 'serviceAccount:__PROJECT_NUMBER__@cloudbuild.gserviceaccount.com', role: 'roles/cloudbuild.builds.builder', required: false },
  { member: 'serviceAccount:__PROJECT_NUMBER__@cloudservices.gserviceaccount.com', role: 'roles/compute.instanceGroupManagerServiceAgent', required: false },
]);
const AUTOMATIC_BINDING_APIS = Object.freeze([
  'cloudbuild.googleapis.com', 'containeranalysis.googleapis.com',
  'containerregistry.googleapis.com', 'pubsub.googleapis.com',
  'artifactregistry.googleapis.com', 'compute.googleapis.com', 'servicenetworking.googleapis.com',
  'sqladmin.googleapis.com', 'run.googleapis.com', 'aiplatform.googleapis.com',
  'speech.googleapis.com', 'monitoring.googleapis.com', 'logging.googleapis.com',
]);

const OFFICIAL_LOG_FILTERS = Object.freeze({
  'sql-backup-failure': `logName="projects/${PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event" AND protoPayload.methodName="cloudsql.instances.automatedBackup" AND resource.type="cloudsql_database" AND protoPayload.metadata.windowStatus=("STATUS_FAILED" OR "STATUS_ATTEMPT_FAILED")`,
  'sql-failover': 'resource.type="cloudsql_database" AND ((log_id("cloudaudit.googleapis.com/activity") AND protoPayload.methodName="cloudsql.instances.failover" AND operation.last=true) OR (log_id("cloudaudit.googleapis.com/system_event") AND protoPayload.methodName="cloudsql.instances.autoFailover"))',
  'sql-restart': 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="cloudsql_database" AND protoPayload.methodName="cloudsql.instances.restart" AND operation.last=true',
  'cloud-build-failure': 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="build" AND protoPayload.methodName="google.devtools.cloudbuild.v1.CloudBuild.CreateBuild" AND operation.last=true AND protoPayload.response.status=("FAILURE" OR "INTERNAL_ERROR" OR "TIMEOUT" OR "EXPIRED")',
  'run-deployment-failure': 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="cloud_run_revision" AND protoPayload.methodName=("google.cloud.run.v2.Services.CreateService" OR "google.cloud.run.v2.Services.UpdateService") AND protoPayload.status.code!=0',
});

function clone(value) {
  return structuredClone(value);
}

async function contractFixture() {
  return JSON.parse(await readFile(CONTRACT_URL, 'utf8'));
}

function cloudAsset(overrides = {}) {
  return {
    name: `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}`,
    assetType: 'run.googleapis.com/Service',
    project: ASSET_PROJECT,
    displayName: GCP_IDENTITY.service,
    description: '',
    location: 'asia-east2',
    labels: {},
    parentFullResourceName: ASSET_PROJECT_PARENT,
    parentAssetType: ASSET_PROJECT_TYPE,
    state: 'ACTIVE',
    ...overrides,
  };
}

function protectedProjectPolicy(contract) {
  return {
    bindings: contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
  };
}

function recoveredPreflightProjectPolicy({ includeReleaseEvidence = true } = {}) {
  return {
    version: 3,
    etag: 'BwYAAAAAAAQ=',
    bindings: [
      { role: 'roles/owner', members: ['user:admin@motionexp.com'] },
      { role: 'roles/compute.serviceAgent', members: [`serviceAccount:service-${PROJECT_NUMBER}@compute-system.iam.gserviceaccount.com`] },
      { role: 'roles/editor', members: [`serviceAccount:${PROJECT_NUMBER}@cloudservices.gserviceaccount.com`] },
      {
        role: BUCKET_IAM_OPERATOR_BINDING.role,
        members: [BUCKET_IAM_OPERATOR_BINDING.member],
        condition: clone(BUCKET_IAM_OPERATOR_BINDING.condition),
      },
      ...(includeReleaseEvidence ? [{
        role: RELEASE_EVIDENCE_OPERATOR_BINDING.role,
        members: [RELEASE_EVIDENCE_OPERATOR_BINDING.member],
        condition: clone(RELEASE_EVIDENCE_OPERATOR_BINDING.condition),
      }] : []),
    ],
  };
}

function preflightReadRequest(channelHandler = null, { includeReleaseEvidence = true } = {}) {
  return async (input) => {
    if (input.url === `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`) {
      return recoveredPreflightProjectPolicy({ includeReleaseEvidence });
    }
    if (channelHandler) return channelHandler(input);
    throw new Error(`unexpected preflight REST read ${input.url}`);
  };
}

function notFound() {
  return Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
}

function enabledServiceRows(names) {
  return names.map((service) => ({
    config: { name: service },
    name: `projects/${PROJECT_NUMBER}/services/${service}`,
    state: 'ENABLED',
  }));
}

function exactCloudSqlInstance() {
  return {
    name: GCP_IDENTITY.cloudSqlInstance,
    project: PROJECT,
    region: GCP_IDENTITY.region,
    databaseVersion: 'POSTGRES_16',
    state: 'RUNNABLE',
    ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.25.0.3' }],
    settings: {
      edition: 'ENTERPRISE',
      availabilityType: 'REGIONAL',
      tier: 'db-custom-1-3840',
      dataDiskType: 'PD_SSD',
      dataDiskSizeGb: '20',
      storageAutoResize: true,
      ipConfiguration: {
        ipv4Enabled: false,
        privateNetwork: `projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
        allocatedIpRange: GCP_IDENTITY.psaRange,
        sslMode: 'ENCRYPTED_ONLY',
      },
      backupConfiguration: {
        enabled: true,
        startTime: '18:00',
        pointInTimeRecoveryEnabled: true,
        transactionLogRetentionDays: 7,
        backupRetentionSettings: { retentionUnit: 'COUNT', retainedBackups: 7 },
      },
      deletionProtectionEnabled: true,
      retainBackupsOnDelete: true,
      finalBackupConfig: { enabled: true, retentionDays: 30 },
    },
  };
}

function assetAuditControlPlane({
  contract, assets, enabledApis = ['iam.googleapis.com', 'serviceusage.googleapis.com'],
  gcloudRows = {}, restRows = {}, organizationResponse, billingAccountResponse,
  projectResponse, billingLinkResponse,
  projectIamPolicy = operatorProjectPolicy(contract, { includeOperator: true }),
}) {
  const gcloudCalls = [];
  const restCalls = [];
  const plane = new GcpControlPlane({
    contract,
    notificationChannel: NUMERIC_CHANNEL,
    gcloud: async (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'projects' && args[1] === 'describe') return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER,
        parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
        name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
        ...projectResponse,
      };
      if (args[0] === 'organizations' && args[1] === 'describe') {
        if (organizationResponse === null || Array.isArray(organizationResponse)) {
          return organizationResponse;
        }
        return {
          name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
          ...organizationResponse,
        };
      }
      if (args[0] === 'billing' && args[1] === 'accounts') {
        if (billingAccountResponse === null || Array.isArray(billingAccountResponse)) {
          return billingAccountResponse;
        }
        return {
          name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
          ...billingAccountResponse,
        };
      }
      if (args[0] === 'billing' && args[1] === 'projects') return {
        billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
        ...billingLinkResponse,
      };
      if (args[0] === 'projects' && args[1] === 'get-iam-policy') return clone(projectIamPolicy);
      if (args[0] === 'asset') {
        if (assets instanceof Error) throw assets;
        return assets;
      }
      if (args[0] === 'services' && args[1] === 'list') return enabledServiceRows(enabledApis);
      const key = args.slice(0, 3).join(' ');
      if (Object.hasOwn(gcloudRows, key)) return gcloudRows[key];
      if (args[0] === 'iam' && args.includes('list')) return [];
      throw notFound();
    },
    request: async (input) => {
      for (const [needle, value] of Object.entries(restRows)) {
        if (input.url.includes(needle)) {
          restCalls.push(input);
          return typeof value === 'function' ? value(input) : value;
        }
      }
      if (input.url === `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`) {
        // Generic inventory fixtures model the already-recovered baseline. The
        // version-3 POST shape itself is asserted by operatorBindingPlane tests.
        return clone(projectIamPolicy);
      }
      restCalls.push(input);
      throw notFound();
    },
  });
  return { plane, gcloudCalls, restCalls };
}

function dependencyAuditControlPlane({
  contract,
  enabledApis,
  cloudSqlState = 'absent',
  secretStates = {},
  databaseForbidden = false,
}) {
  const fixture = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis,
    gcloudRows: {
      'sql instances list': [],
      [`secrets list --project=${PROJECT}`]: [],
      'compute networks list': [],
      'compute networks subnets': [],
      'compute routes list': [],
      'compute addresses list': [],
      'services vpc-peerings list': [],
      'sql databases list': [],
    },
    restRows: {
      '/versions': { versions: [] },
      '/users': { items: [] },
    },
  });
  const baseGcloud = fixture.plane.gcloud;
  fixture.plane.gcloud = async (args, options) => {
    if (args[0] === 'compute' && args[1] === 'networks' && args[2] === 'subnets'
      && args[3] === 'describe') {
      fixture.gcloudCalls.push(args);
      throw notFound();
    }
    if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
      fixture.gcloudCalls.push(args);
      if (cloudSqlState === 'present') return exactCloudSqlInstance();
      throw notFound();
    }
    if (args[0] === 'sql' && args[1] === 'databases' && args[2] === 'list'
      && databaseForbidden) {
      fixture.gcloudCalls.push(args);
      throw Object.assign(new Error('database forbidden'), { code: 'FORBIDDEN' });
    }
    if (args[0] === 'secrets' && args[1] === 'describe') {
      fixture.gcloudCalls.push(args);
      const secretId = args[2];
      if (secretStates[secretId] === 'present') {
        return {
          name: `projects/${PROJECT_NUMBER}/secrets/${secretId}`,
          replication: { automatic: {} },
          labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
        };
      }
      throw notFound();
    }
    return baseGcloud(args, options);
  };
  return fixture;
}

test('central identity fixes the shared billed project resource island without legacy cloud identities', async () => {
  const contract = await contractFixture();

  assert.equal(Object.isFrozen(GCP_IDENTITY), true);
  assert.equal(GCP_IDENTITY.projectId, 'motion-expert-hk-ltd-webpage');
  assert.equal(GCP_IDENTITY.projectNumber, '582852715831');
  assert.equal(GCP_IDENTITY.assetInventoryConsumerProjectId, 'tech-demo-433408');
  assert.equal(GCP_IDENTITY.service, 'hkbuddy-v1-api');
  assert.equal(GCP_IDENTITY.bucket, 'hkbuddy-v1-582852715831-media');
  assert.equal(GCP_IDENTITY.buildSourceBucket, 'hkbuddy-v1-582852715831-build-source');
  assert.equal(GCP_IDENTITY.network, 'hkbuddy-v1-vpc');
  assert.equal(contract.project.mode, 'existing-billed-shared');
  assert.deepEqual(contract.project.protectedBindings, [
    { member: 'user:admin@motionexp.com', role: 'roles/owner' },
    { member: 'serviceAccount:service-582852715831@compute-system.iam.gserviceaccount.com', role: 'roles/compute.serviceAgent' },
    { member: 'serviceAccount:582852715831@cloudservices.gserviceaccount.com', role: 'roles/editor' },
  ]);
  assert.deepEqual(contract.project.assetInventory, {
    consumerProjectId: 'tech-demo-433408',
    mode: 'read-only-cloud-asset-quota-consumer',
    scope: 'projects/motion-expert-hk-ltd-webpage',
    pageSize: 500,
    readMask: ASSET_READ_MASK,
    orderBy: 'assetType,name',
  });
  assert.equal(contract.project.projectNumber, PROJECT_NUMBER);
  assert.deepEqual(GCP_OBSOLETE_EXECUTABLE_IDENTITIES, [
    'hkbuddy-prod-v1-20260826', '93662314720', 'hkbuddy', 'hkbuddy-api',
    'hkbuddy-pg', 'hkbuddy-prod-vpc', 'hkbuddy-ae2-run',
    'hkbuddy-google-managed-services', 'hkbuddy-runtime', 'hkbuddy-build',
    'hkbuddy-migrator', 'hkbuddy-deployer', 'hkbuddy-acceptance',
    'hkbuddy-migrate', 'hkbuddy-db-app-url', 'hkbuddy-db-migrator-url',
    'hkbuddy-session-secret', 'hkbuddy-db-bootstrap-state',
    'hkbuddy-legacy-inventory', 'hkbuddy-dependency-acceptance',
    'hkbuddy-llm-smoke', 'hkbuddy-asr-smoke', 'hkbuddy-tts-smoke',
    'hkbuddy-ios-voice-acceptance', 'hkbuddy-prod-v1-20260826-media',
  ]);

  const serialized = JSON.stringify({ identity: GCP_IDENTITY, contract });
  for (const legacyIdentity of [
    'hkbuddy-prod-v1-20260826', '123456789012', 'hkbuddy-api', '"repository":"hkbuddy"',
    'hkbuddy-prod-v1-20260826-media', 'hkbuddy-pg', 'hkbuddy-prod-vpc',
    'hkbuddy-ae2-run', 'hkbuddy-google-managed-services', 'hkbuddy-runtime',
    'hkbuddy-build', 'hkbuddy-migrator', 'hkbuddy-deployer', 'hkbuddy-acceptance',
    'hkbuddy-db-app-url', 'hkbuddy-db-migrator-url', 'hkbuddy-session-secret',
    'hkbuddy-db-bootstrap-state', 'hkbuddy-legacy-inventory',
    'hkbuddy-dependency-acceptance', 'hkbuddy-llm-smoke', 'hkbuddy-asr-smoke',
    'hkbuddy-tts-smoke', 'hkbuddy-ios-voice-acceptance', 'hkbuddy-migrate',
  ]) assert.equal(serialized.includes(legacyIdentity), false, legacyIdentity);
});

test('executable provisioner contains no legacy Artifact Registry or secret discriminator', async () => {
  const source = await readFile(new URL('../scripts/gcp-provision.js', import.meta.url), 'utf8');
  for (const legacy of [
    "'hkbuddy'", 'hkbuddy-session-secret', 'hkbuddy-db-app-url',
    'hkbuddy-db-migrator-url', 'hkbuddy-db-bootstrap-state',
  ]) assert.equal(source.includes(legacy), false, legacy);
});

test('Tasks 1-2 operator documentation uses every executable V1 identity and no obsolete unversioned identity', async () => {
  const readme = await readFile(OPERATOR_README_URL, 'utf8');
  const requiredIdentities = [
    GCP_IDENTITY.service, GCP_IDENTITY.repository, GCP_IDENTITY.bucket,
    GCP_IDENTITY.buildSourceBucket,
    GCP_IDENTITY.cloudSqlInstance, GCP_IDENTITY.database, GCP_IDENTITY.network,
    GCP_IDENTITY.subnet, GCP_IDENTITY.psaRange,
    ...Object.values(GCP_IDENTITY.serviceAccounts),
    ...Object.values(GCP_IDENTITY.secrets),
    ...Object.values(GCP_IDENTITY.jobs),
  ];
  for (const identity of requiredIdentities) {
    assert.equal(readme.includes(identity), true, `missing operator identity: ${identity}`);
  }

  const obsoleteIdentities = [
    'hkbuddy', 'hkbuddy-api', 'hkbuddy-pg', 'hkbuddy-prod-vpc', 'hkbuddy-ae2-run',
    'hkbuddy-google-managed-services', 'hkbuddy-runtime', 'hkbuddy-build',
    'hkbuddy-migrator', 'hkbuddy-deployer', 'hkbuddy-acceptance', 'hkbuddy-migrate',
    'hkbuddy-db-app-url', 'hkbuddy-db-migrator-url', 'hkbuddy-session-secret',
    'hkbuddy-db-bootstrap-state',
    'hkbuddy-legacy-inventory', 'hkbuddy-dependency-acceptance', 'hkbuddy-llm-smoke',
    'hkbuddy-asr-smoke', 'hkbuddy-tts-smoke', 'hkbuddy-ios-voice-acceptance',
  ];
  for (const identity of obsoleteIdentities) {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(readme, new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, 'i'), identity);
  }
  assert.match(readme, /earlier `USD 300` draft/, 'the explicit historical budget context remains allowed');
});

test('the executable shared-project release plan accepts the canonical Monitoring channel name', async () => {
  const plan = await readFile(SHARED_PROJECT_PLAN_URL, 'utf8');
  const plannedPattern = plan.match(/V1_NOTIFICATION_CHANNEL -match '([^']+)'/)?.[1];
  assert.equal(typeof plannedPattern, 'string');
  const gate = new RegExp(plannedPattern);
  assert.equal(gate.test(CHANNEL), true);
  assert.equal(gate.test('projects/foreign-project/notificationChannels/123456789'), false);
});

test('operator IAM prose protects the observed Google APIs Service Agent Editor baseline and forbids additions', async () => {
  const readme = await readFile(OPERATOR_README_URL, 'utf8');
  assert.match(readme, /serviceAccount:582852715831@cloudservices\.gserviceaccount\.com/);
  assert.match(readme, /`roles\/editor`/);
  assert.match(readme, /protected and immutable/i);
  assert.match(readme, /additional[^.]*Editor grants?[^.]*forbidden/i);
  assert.doesNotMatch(readme, /legacy project-level `roles\/editor` is not allowed/i);
  assert.match(readme, /optional[^.]*service-agent bindings?/i);
});

test('shared-project control plane forbids project and billing mutations', async () => {
  const controlPlane = new GcpControlPlane({
    contract: await contractFixture(),
    notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('must not reach gcloud'); },
    request: async () => { throw new Error('must not reach HTTPS'); },
  });

  await assert.rejects(
    () => controlPlane.create('project'),
    (error) => error.code === 'SHARED_PROJECT_MUTATION_FORBIDDEN',
  );
  await assert.rejects(
    () => controlPlane.create('billing'),
    (error) => error.code === 'SHARED_PROJECT_MUTATION_FORBIDDEN',
  );
});

test('the executable contract fixes the isolated GCP topology and least-privilege boundary', async () => {
  const contract = await contractFixture();

  assert.doesNotThrow(() => assertResourceContract(contract));
  assert.deepEqual(contract.project, {
    id: PROJECT,
    displayName: 'Motion Expert HK LTD Webpage',
    organizationId: GCP_IDENTITY.organizationId,
    billingAccountId: GCP_IDENTITY.billingAccountId,
    projectNumber: PROJECT_NUMBER,
    mode: 'existing-billed-shared',
    assetInventory: {
      consumerProjectId: GCP_IDENTITY.assetInventoryConsumerProjectId,
      mode: 'read-only-cloud-asset-quota-consumer',
      scope: `projects/${PROJECT}`,
      pageSize: 500,
      readMask: ASSET_READ_MASK,
      orderBy: 'assetType,name',
    },
    protectedBindings: [
      { member: 'user:admin@motionexp.com', role: 'roles/owner' },
      { member: `serviceAccount:service-${PROJECT_NUMBER}@compute-system.iam.gserviceaccount.com`, role: 'roles/compute.serviceAgent' },
      { member: `serviceAccount:${PROJECT_NUMBER}@cloudservices.gserviceaccount.com`, role: 'roles/editor' },
    ],
    labels: {},
  });
  assert.deepEqual(contract.locations, {
    runtime: 'asia-east2', storage: 'asia-east2', database: 'asia-east2',
    speech: 'asia-southeast1', vertex: 'global',
  });
  assert.deepEqual(contract.resources.artifactRegistry, {
    repository: GCP_IDENTITY.repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
    location: 'asia-east2', description: 'Hong Kong Buddy production containers',
  });
  assert.deepEqual(contract.resources.monitoring.notificationChannel, {
    required: true,
    displayName: 'HK Buddy V1 operations',
    ownershipLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
    mustBeEnabled: true,
    requiredType: 'email',
    requiredEmailAddress: 'admin@motionexp.com',
    requiredVerificationStatus: 'VERIFIED',
  });
  assert.equal(contract.resources.budget.projectFilter, `projects/${PROJECT_NUMBER}`);
  assert.deepEqual(contract.resources.customRoles, [
    ACCEPTANCE_BUCKET_METADATA_ROLE,
    BUCKET_IAM_OPERATOR_ROLE,
    RELEASE_EVIDENCE_OPERATOR_ROLE,
  ]);
  assert.deepEqual(contract.iam.operatorBucketIamBinding, BUCKET_IAM_OPERATOR_BINDING);
  assert.deepEqual(
    contract.iam.operatorReleaseEvidenceIamBinding,
    RELEASE_EVIDENCE_OPERATOR_BINDING,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.includes('custom-role:hkbuddyV1AcceptanceBucketMetadataReader'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('custom-role:hkbuddyV1AcceptanceBucketMetadataReader')
      < EXPECTED_PROVISION_STEPS.indexOf('vpc'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('custom-role:hkbuddyV1BucketIamPolicyOperator')
      < EXPECTED_PROVISION_STEPS.indexOf('operator-bucket-iam-binding'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('custom-role:hkbuddyV1ReleaseEvidenceObjectOperator')
      < EXPECTED_PROVISION_STEPS.indexOf('operator-release-evidence-iam-binding'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('operator-release-evidence-iam-binding')
      < EXPECTED_PROVISION_STEPS.indexOf('bucket-iam-baseline'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('build-source-bucket')
      < EXPECTED_PROVISION_STEPS.indexOf('operator-bucket-iam-binding'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('operator-bucket-iam-binding')
      < EXPECTED_PROVISION_STEPS.indexOf('bucket-iam-baseline'),
    true,
  );
  assert.deepEqual(contract.apis, [
    'cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com',
    'cloudbilling.googleapis.com', 'billingbudgets.googleapis.com',
    'iam.googleapis.com', 'iamcredentials.googleapis.com',
    'policytroubleshooter.googleapis.com', 'artifactregistry.googleapis.com',
    'cloudbuild.googleapis.com', 'containeranalysis.googleapis.com',
    'run.googleapis.com', 'compute.googleapis.com',
    'servicenetworking.googleapis.com', 'sqladmin.googleapis.com',
    'storage.googleapis.com', 'secretmanager.googleapis.com',
    'aiplatform.googleapis.com', 'speech.googleapis.com',
    'texttospeech.googleapis.com', 'monitoring.googleapis.com',
    'logging.googleapis.com',
  ]);

  assert.deepEqual(contract.resources.network, {
    vpc: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, subnetCidr: '10.24.0.0/26',
    privateGoogleAccess: true, psaRange: GCP_IDENTITY.psaRange,
    psaCidr: '10.25.0.0/16', egress: 'private-ranges-only',
  });
  assert.deepEqual(contract.resources.cloudSql, {
    instance: GCP_IDENTITY.cloudSqlInstance, database: GCP_IDENTITY.database, databaseVersion: 'POSTGRES_16',
    edition: 'ENTERPRISE', availabilityType: 'REGIONAL', tier: 'db-custom-1-3840', diskType: 'PD_SSD',
    diskSizeGb: 20, storageAutoIncrease: true, privateIpOnly: true,
    sslMode: 'ENCRYPTED_ONLY', backupEnabled: true, backupStartTime: '18:00',
    pointInTimeRecovery: true, transactionLogRetentionDays: 7,
    retainedBackups: 7, retainBackupsOnDelete: true, finalBackup: true,
    finalBackupRetentionDays: 30, deletionProtection: true,
    users: [
      { name: 'hkbuddy_app', databaseRoles: ['pg_read_all_data', 'pg_write_all_data'], secret: GCP_IDENTITY.secrets.dbAppUrl },
      { name: 'hkbuddy_migrator', databaseRoles: ['cloudsqlsuperuser'], secret: GCP_IDENTITY.secrets.dbMigratorUrl },
    ],
  });
  assert.deepEqual(contract.resources.bucket, {
    name: GCP_IDENTITY.bucket, location: 'asia-east2',
    uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced',
    versioning: false, softDeleteSeconds: 0, lifecycleDeleteAfterDays: 7,
    retentionPolicy: null,
  });
  assert.deepEqual(contract.resources.cloudRun, {
    stableService: GCP_IDENTITY.service, candidateService: GCP_IDENTITY.candidateService,
    executionEnvironment: 'gen2', cpu: 2, memory: '1Gi',
    concurrency: 40, minInstances: 1, maxInstances: 1, cpuThrottling: false,
    startupCpuBoost: true, timeoutSeconds: 60,
    candidateTrafficState: 'candidate-service-private-100', candidateTrafficPercent: 100,
    firstPromotionInitialStableState: 'stable-absent',
    firstPromotionPrivateTrafficState: 'accepted-stable-private-100',
    laterPromotionInitialStableState: 'stable-prior-100',
    laterPromotionStagedTrafficState: 'stable-prior-100/accepted-stable-0',
    directVpc: true, egress: 'private-ranges-only',
    startupProbe: { path: '/api/health/ready', port: 8080, initialDelaySeconds: 0, timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 12 },
    livenessProbe: { path: '/api/health/live', port: 8080, initialDelaySeconds: 30, timeoutSeconds: 5, periodSeconds: 30, failureThreshold: 3 },
    readinessProbe: { path: '/api/health/ready', port: 8080, initialDelaySeconds: 0, timeoutSeconds: 5, periodSeconds: 5, failureThreshold: 3 },
    secretVersionPolicy: 'numeric-only',
  });
  assert.deepEqual(contract.resources.budget, {
    displayName: 'Hong Kong Buddy Production V1 monthly guard', currency: 'HKD',
    amount: 2300, calendarPeriod: 'MONTH', projectFilter: `projects/${PROJECT_NUMBER}`,
    thresholds: [
      { percent: 0.5, basis: 'CURRENT_SPEND' },
      { percent: 0.8, basis: 'CURRENT_SPEND' },
      { percent: 1, basis: 'CURRENT_SPEND' },
      { percent: 1, basis: 'FORECASTED_SPEND' },
    ],
  });
  assert.deepEqual(
    contract.resources.monitoring.policies.filter(({ kind }) => kind === 'log-match')
      .map(({ id, filter }) => [id, filter]),
    Object.entries(OFFICIAL_LOG_FILTERS),
  );
  assert.equal(contract.safety.unresolvedProjectIdPolicy, 'existing-project-required');
  assert.equal(contract.safety.noUserManagedServiceAccountKeys, true);
  assert.equal(contract.iam.forbiddenWorkloadRoles.includes('roles/iam.serviceAccountTokenCreator'), true);
  assert.deepEqual(contract.iam.automaticProjectBindings, AUTOMATIC_PROJECT_BINDINGS);

  const evidenceSecretIds = [
    GCP_IDENTITY.secrets.legacy, GCP_IDENTITY.secrets.dependencies, GCP_IDENTITY.secrets.llm,
    GCP_IDENTITY.secrets.asr, GCP_IDENTITY.secrets.tts, GCP_IDENTITY.secrets.ios,
  ];
  assert.deepEqual(
    contract.resources.secrets.filter(({ baseProvisioningVersion }) => baseProvisioningVersion === false)
      .map(({ id }) => id),
    evidenceSecretIds,
  );
  for (const id of evidenceSecretIds) {
    assert.equal(EXPECTED_PROVISION_STEPS.includes(`secret-container:${id}`), true);
    assert.equal(EXPECTED_PROVISION_STEPS.includes(`secret-version:${id}`), false);
    assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
      scope === `secret:${id}` && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`
        && role === 'roles/secretmanager.secretAccessor'
    )), true);
  }

  const runtime = `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`;
  const runtimeProjectRoles = contract.iam.bindings
    .filter(({ scope, member }) => scope === 'project' && member === runtime)
    .map(({ role }) => role).sort();
  assert.deepEqual(runtimeProjectRoles, [
    'roles/aiplatform.user', 'roles/serviceusage.serviceUsageConsumer', 'roles/speech.client',
  ]);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.bucket}` && member === runtime
      && role === 'roles/storage.objectUser'
  )), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.bucket}` && member === runtime
      && role === ACCEPTANCE_BUCKET_METADATA_ROLE.name
  )), true, 'the serving runtime must read fixed media-bucket metadata during startup and readiness');
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.bucket}`
      && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`
      && role === ACCEPTANCE_BUCKET_METADATA_ROLE.name
  )), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `secret:${GCP_IDENTITY.secrets.legacy}`
      && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`
      && role === 'roles/secretmanager.secretAccessor'
  )), true, 'the dependency acceptance Job must read the exact release-bound legacy inventory');
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}` && member === runtime
      && role === 'roles/secretmanager.secretAccessor'
  )), false);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'service-account:hkbuddy-v1-build'
      && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`
      && role === 'roles/iam.serviceAccountUser'
  )), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'service-account:hkbuddy-v1-acceptance'
      && member === 'user:admin@motionexp.com'
      && role === 'roles/iam.serviceAccountOpenIdTokenCreator'
  )), true, 'the fixed operator needs only OpenID token creation on the acceptance identity');
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'service-account:hkbuddy-v1-acceptance'
      && member === 'user:admin@motionexp.com'
      && role === 'roles/iam.serviceAccountTokenCreator'
  )), false, 'the operator must not receive broad service-account token authority');
  assert.equal(contract.iam.bindings.some(({ scope, role }) => (
    scope === 'project' && contract.iam.forbiddenWorkloadRoles.includes(role)
  )), false);
});

test('contract validation rejects identity drift, public access, broad workload roles, or mutable secret pins', async (t) => {
  const base = await contractFixture();
  const cases = [
    ['legacy project', (value) => { value.project.id = 'hkbuddy-pilot-0630'; }],
    ['wrong organization', (value) => { value.project.organizationId = '1'; }],
    ['public bucket', (value) => { value.resources.bucket.publicAccessPrevention = 'inherited'; }],
    ['broad runtime role', (value) => { value.iam.bindings.push({ scope: 'project', member: `serviceAccount:hkbuddy-runtime@${PROJECT}.iam.gserviceaccount.com`, role: 'roles/editor' }); }],
    ['connector drift', (value) => { value.resources.cloudRun.directVpc = false; }],
    ['extra public Cloud Run control', (value) => { value.resources.cloudRun.allowUnauthenticated = true; }],
    ['extra resource surface', (value) => { value.resources.unreviewed = {}; }],
    ['extra top-level surface', (value) => { value.unreviewed = true; }],
    ['public SQL', (value) => { value.resources.cloudSql.privateIpOnly = false; }],
    ['unencrypted SQL', (value) => { value.resources.cloudSql.sslMode = 'ALLOW_UNENCRYPTED_AND_ENCRYPTED'; }],
    ['Cloud SQL edition drift', (value) => { value.resources.cloudSql.edition = 'ENTERPRISE_PLUS'; }],
    ['latest secret', (value) => { value.resources.cloudRun.secretVersionPolicy = 'latest'; }],
    ['missing readback', (value) => { value.safety.completePostCreateReadback = false; }],
    ['budget currency drift', (value) => { value.resources.budget.currency = 'USD'; }],
    ['alert threshold replacement', (value) => { value.resources.monitoring.policies[0].threshold = 0.5; }],
    ['alert filter replacement', (value) => { value.resources.monitoring.policies[6].filter = 'severity>=ERROR'; }],
    ['IAM same-length external replacement', (value) => { value.iam.bindings[0].member = 'user:external@example.test'; }],
    ['automatic binding replacement', (value) => { value.iam.automaticProjectBindings[1].role = 'roles/editor'; }],
    ['forbidden-role list replacement', (value) => { value.iam.forbiddenWorkloadRoles[0] = 'roles/viewer'; }],
    ['custom role extra permission', (value) => { value.resources.customRoles[0].includedPermissions.push('storage.buckets.list'); }],
    ['custom role stage drift', (value) => { value.resources.customRoles[0].stage = 'BETA'; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const candidate = clone(base);
      mutate(candidate);
      assert.throws(() => assertResourceContract(candidate), /GCP resource contract is invalid/);
    });
  }
});

test('custom roles are definition-exact and reject permission, stage, deletion, or inventory drift', async (t) => {
  const contract = await contractFixture();
  const exactRole = { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false };
  const operatorRole = { ...BUCKET_IAM_OPERATOR_ROLE, deleted: false };
  const releaseEvidenceRole = { ...RELEASE_EVIDENCE_OPERATOR_ROLE, deleted: false };
  assert.doesNotThrow(() => assertExactCustomRoleDefinitions({
    contract, roles: [exactRole, operatorRole, releaseEvidenceRole],
  }));

  for (const [name, mutate] of [
    ['extra permission', (role) => { role.includedPermissions.push('storage.buckets.list'); }],
    ['stage drift', (role) => { role.stage = 'BETA'; }],
    ['deleted role', (role) => { role.deleted = true; }],
    ['unexpected role', (_role, roles) => { roles.push({ ...exactRole, name: `projects/${PROJECT}/roles/unexpected` }); }],
  ]) {
    await t.test(name, () => {
      const role = clone(exactRole);
      const roles = [role, clone(operatorRole), clone(releaseEvidenceRole)];
      mutate(role, roles);
      assert.throws(
        () => assertExactCustomRoleDefinitions({ contract, roles }),
        (error) => error.code === 'CUSTOM_ROLE_ALLOWLIST_MISMATCH',
      );
    });
  }
});

test('gcloud execution is argv-only and rejects values that could disclose a secret', async () => {
  const calls = [];
  const executor = createGcloudExecutor({
    executable: 'python.exe',
    prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: '{"ok":true}\n', stderr: '' };
    },
  });

  const result = await executor(['projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json']);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    executable: 'python.exe',
    args: [
      'C:/gcloud/lib/gcloud.py', 'projects', 'describe', PROJECT,
      `--project=${PROJECT}`, '--format=json', '--quiet',
    ],
    options: { encoding: 'utf8', maxBuffer: 1048576, windowsHide: true, timeout: 120_000 },
  }]);
  assert.equal(calls[0].args.filter((value) => value === '--quiet').length, 1);
  await executor(
    ['builds', 'submit', '--format=json'],
    { timeout: 600_000 },
  );
  assert.equal(calls[1].options.timeout, 600_000);
  await assert.rejects(
    () => executor(['builds', 'submit', '--format=json'], { timeout: 600_001 }),
    /deadline/i,
  );
  await executor(['projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json', '--quiet']);
  assert.equal(calls[2].args.filter((value) => value === '--quiet').length, 1);
  await assert.rejects(
    () => executor(['projects', 'describe', PROJECT, '--quiet', '--quiet']),
    /non-interactive|quiet|argv/i,
  );
  await assert.rejects(() => executor(`projects describe ${PROJECT}`), /argv array/);
  await assert.rejects(() => executor(['sql', 'users', 'create', '--password=hunter2']), /secret-bearing argv/);
  await assert.rejects(() => executor(['run', 'deploy', 'postgres://user:pass@example.test/db']), /secret-bearing argv/);
  await assert.rejects(() => executor(['projects', 'describe', `${PROJECT}\nwhoami`]), /unsafe argv/);

  const permissionExecutor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('command failed');
      error.stderr = 'The caller does not have permission.';
      throw error;
    },
  });
  await assert.rejects(
    () => permissionExecutor(['projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json']),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('gcloud text execution is explicitly non-interactive exactly once', async () => {
  const calls = [];
  const executor = createDefaultGcloudTextExecutor({
    environment: {
      V1_GCP_PYTHON_EXECUTABLE: 'C:\\runtime\\python.exe',
      V1_GCLOUD_PY_PATH: 'C:\\sdk\\gcloud.py',
    },
    execFile: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: 'admin@motionexp.com\n', stderr: '' };
    },
  });

  assert.equal(await executor(['config', 'get-value', 'account', `--project=${PROJECT}`]),
    'admin@motionexp.com\n');
  await executor([
    'auth', 'print-identity-token', '--audiences=https://candidate.example.test', '--quiet',
  ]);
  assert.deepEqual(calls.map((call) => call.args.filter((value) => value === '--quiet').length), [1, 1]);
  await assert.rejects(
    () => executor(['config', 'get-value', 'account', '--quiet', '--quiet']),
    /non-interactive|quiet|argv/i,
  );
});

test('gcloud classifies absence only for the exact canonical Cloud Run service describe operation', async (t) => {
  const serviceDescribe = [
    'run', 'services', 'describe', GCP_IDENTITY.service,
    `--project=${PROJECT}`, `--region=${GCP_IDENTITY.region}`, '--format=json',
  ];
  const executorFor = (stderr) => createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      throw error;
    },
  });

  await assert.rejects(
    () => executorFor(
      `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`,
    )(serviceDescribe),
    (error) => error.code === 'CLOUD_RUN_SERVICE_NOT_FOUND',
  );

  for (const [name, argv, stderr] of [
    ['proxy 404', serviceDescribe, 'proxy returned 404 while discovering the endpoint'],
    ['auth NOT_FOUND', serviceDescribe, 'NOT_FOUND: credential discovery document was not found'],
    ['API path was not found', serviceDescribe, 'The requested API path was not found'],
    ['wrong service', serviceDescribe.with(3, 'hkbuddy-v1-foreign'), `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`],
    ['wrong project', serviceDescribe.with(4, '--project=foreign-project'), `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`],
    ['wrong region', serviceDescribe.with(5, '--region=us-central1'), `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => executorFor(stderr)(argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }
});

test('gcloud classifies canonical absence only when describe argv and resource identity both match', async (t) => {
  const role = 'hkbuddyV1AcceptanceBucketMetadataReader';
  const cases = [
    {
      name: 'Artifact Registry repository',
      argv: ['artifacts', 'repositories', 'describe', GCP_IDENTITY.repository, '--location=asia-east2', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Repository [projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}] was not found.`,
    },
    {
      name: 'service account',
      argv: ['iam', 'service-accounts', 'describe', GCP_IDENTITY.serviceAccounts.runtime, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Service account [${GCP_IDENTITY.serviceAccounts.runtime}] was not found in project [${PROJECT}].`,
    },
    {
      name: 'custom role',
      argv: ['iam', 'roles', 'describe', role, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role [projects/${PROJECT}/roles/${role}] was not found.`,
    },
    {
      name: 'operator custom role with authenticated SDK detail',
      argv: ['iam', 'roles', 'describe', BUCKET_IAM_OPERATOR_ROLE.id, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: The role named projects/${PROJECT}/roles/${BUCKET_IAM_OPERATOR_ROLE.id} was not found. This command is authenticated as admin@motionexp.com which is the active account specified by the [core/account] property.`,
    },
    {
      name: 'Compute network',
      argv: ['compute', 'networks', 'describe', GCP_IDENTITY.network, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.networks.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}' was not found`,
    },
    {
      name: 'Compute subnet',
      argv: ['compute', 'networks', 'subnets', 'describe', GCP_IDENTITY.subnet, '--region=asia-east2', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.networks.subnets.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}' was not found`,
    },
    {
      name: 'Compute global address',
      argv: ['compute', 'addresses', 'describe', GCP_IDENTITY.psaRange, '--global', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}' was not found`,
    },
    {
      name: 'Cloud SQL instance',
      argv: ['sql', 'instances', 'describe', GCP_IDENTITY.cloudSqlInstance, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.sql.instances.describe) HTTPError 404: The resource [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}] was not found.`,
    },
    {
      name: 'Cloud SQL database',
      argv: ['sql', 'databases', 'describe', GCP_IDENTITY.database, `--instance=${GCP_IDENTITY.cloudSqlInstance}`, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.sql.databases.describe) HTTPError 404: Database [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}] was not found.`,
    },
    {
      name: 'Storage bucket',
      argv: ['storage', 'buckets', 'describe', `gs://${GCP_IDENTITY.bucket}`, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket [gs://${GCP_IDENTITY.bucket}] does not exist.`,
    },
    {
      name: 'Storage bucket current CLI',
      argv: ['storage', 'buckets', 'describe', `gs://${GCP_IDENTITY.bucket}`, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.storage.buckets.describe) gs://${GCP_IDENTITY.bucket} not found: 404.`,
    },
    {
      name: 'Secret Manager secret',
      argv: ['secrets', 'describe', GCP_IDENTITY.secrets.session, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}] not found.`,
    },
    {
      name: 'Cloud Run job',
      argv: ['run', 'jobs', 'describe', GCP_IDENTITY.jobs.migration, `--project=${PROJECT}`, '--region=asia-east2', '--format=json'],
      stderr: `ERROR: (gcloud.run.jobs.describe) Cannot find job [${GCP_IDENTITY.jobs.migration}].`,
    },
  ];

  const executorFor = (stderr) => createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => { const error = new Error('gcloud failed'); error.stderr = stderr; throw error; },
  });
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => executorFor(fixture.stderr)(fixture.argv),
        (error) => error.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () => executorFor(`${fixture.stderr}\r\n\r\n`)(fixture.argv),
        (error) => error.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () => executorFor(`${fixture.stderr}\r\n\r\n\r\n`)(fixture.argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
      for (const argv of [
        fixture.argv.with(fixture.argv.indexOf(`--project=${PROJECT}`), '--project=foreign-project'),
        fixture.argv.with(fixture.argv.length - 1, '--format=yaml'),
      ]) {
        await assert.rejects(
          () => executorFor(fixture.stderr)(argv),
          (error) => error.code === 'TRANSPORT_AMBIGUOUS',
        );
      }
      const roleToken = [role, BUCKET_IAM_OPERATOR_ROLE.id]
        .find((candidate) => fixture.stderr.includes(candidate));
      const wrongResourceStderr = roleToken
        ? fixture.stderr.replaceAll(roleToken, `${roleToken}Foreign`)
        : fixture.stderr.replaceAll('hkbuddy-v1', 'hkbuddy-v1-foreign');
      await assert.rejects(
        () => executorFor(wrongResourceStderr)(fixture.argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }
});

test('current Artifact Registry generic 404 is absence only for the exact repository describe argv', async () => {
  const stderr = 'ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Requested entity was not found. This command is authenticated as admin@motionexp.com which is the active account specified by the [core/account] property.\n';
  const exactArgv = [
    'artifacts', 'repositories', 'describe', GCP_IDENTITY.repository,
    '--location=asia-east2', `--project=${PROJECT}`, '--format=json',
  ];
  const executor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => { const error = new Error('gcloud failed'); error.stderr = stderr; throw error; },
  });

  await assert.rejects(() => executor(exactArgv), (error) => error.code === 'NOT_FOUND');
  for (const argv of [
    exactArgv.with(3, 'hkbuddy-v1-foreign'),
    exactArgv.with(4, '--location=us-central1'),
    exactArgv.with(5, '--project=foreign-project'),
    exactArgv.with(6, '--format=yaml'),
  ]) {
    await assert.rejects(() => executor(argv), (error) => error.code === 'TRANSPORT_AMBIGUOUS');
  }
});

test('gcloud 553 observed managed-resource absences require the exact describe argv and stderr', async (t) => {
  const authTail = 'This command is authenticated as admin@motionexp.com which is the active account specified by the [core/account] property';
  const role = ACCEPTANCE_BUCKET_METADATA_ROLE.id;
  const cases = [
    ...Object.values(GCP_IDENTITY.serviceAccounts).map((account) => ({
      name: `service account ${account}`,
      argv: ['iam', 'service-accounts', 'describe', account, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account. ${authTail}`,
      resourceIndex: 3,
      wrongResource: 'foreign@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com',
    })),
    {
      name: 'custom role',
      argv: ['iam', 'roles', 'describe', role, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: The role named projects/${PROJECT}/roles/${role} was not found. ${authTail}.`,
      resourceIndex: 3,
      wrongResource: 'hkbuddyV1ForeignRole',
    },
    {
      name: 'Cloud SQL instance',
      argv: ['sql', 'instances', 'describe', GCP_IDENTITY.cloudSqlInstance, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.sql.instances.describe) HTTPError 404: The Cloud SQL instance does not exist. ${authTail}.`,
      resourceIndex: 3,
      wrongResource: 'hkbuddy-v1-foreign-pg',
    },
    ...Object.values(GCP_IDENTITY.secrets).map((secret) => ({
      name: `secret ${secret}`,
      argv: ['secrets', 'describe', secret, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT_NUMBER}/secrets/${secret}] not found. ${authTail}.`,
      resourceIndex: 2,
      wrongResource: 'hkbuddy-v1-foreign-secret',
    })),
  ];
  const executorFor = (stderr) => createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = `${stderr}\n`;
      throw error;
    },
  });

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => executorFor(fixture.stderr)(fixture.argv),
        (error) => error.code === 'NOT_FOUND',
      );
      for (const argv of [
        fixture.argv.with(fixture.resourceIndex, fixture.wrongResource),
        fixture.argv.with(fixture.argv.length - 2, '--project=foreign-project'),
        fixture.argv.with(fixture.argv.length - 1, '--format=yaml'),
        [...fixture.argv, '--location=us-central1'],
      ]) {
        await assert.rejects(
          () => executorFor(fixture.stderr)(argv),
          (error) => error.code === 'TRANSPORT_AMBIGUOUS',
        );
      }
      await assert.rejects(
        () => executorFor(fixture.stderr.replace('admin@motionexp.com', 'foreign@example.com'))(fixture.argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
      await assert.rejects(
        () => executorFor(fixture.stderr.slice(0, fixture.stderr.indexOf(' This command is authenticated as')))(fixture.argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }

  const secret = GCP_IDENTITY.secrets.session;
  const secretArgv = ['secrets', 'describe', secret, `--project=${PROJECT}`, '--format=json'];
  const secretStderr = `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT_NUMBER}/secrets/${secret}] not found. ${authTail}.`;
  await assert.rejects(
    () => executorFor(secretStderr.replace(PROJECT_NUMBER, '999999999999'))(secretArgv),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS',
  );
});

test('gcloud 553 database authorization failure remains forbidden rather than absence', async () => {
  const stderr = 'ERROR: (gcloud.sql.databases.describe) HTTPError 403: The client is not authorized to make this request. This command is authenticated as admin@motionexp.com which is the active account specified by the [core/account] property.\n';
  const executor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      throw error;
    },
  });

  await assert.rejects(
    () => executor([
      'sql', 'databases', 'describe', GCP_IDENTITY.database,
      `--instance=${GCP_IDENTITY.cloudSqlInstance}`, `--project=${PROJECT}`, '--format=json',
    ]),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('Cloud SQL database discovery uses a successful scoped list instead of generic describe 404s', async (t) => {
  const contract = await contractFixture();
  const databaseRow = (name) => ({
    charset: 'UTF8',
    collation: 'en_US.UTF8',
    etag: `${name}-etag`,
    instance: GCP_IDENTITY.cloudSqlInstance,
    kind: 'sql#database',
    name,
    project: PROJECT,
    selfLink: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${name}`,
  });
  const postgres = databaseRow('postgres');
  const target = databaseRow(GCP_IDENTITY.database);
  const listArgv = [
    'sql', 'databases', 'list', `--instance=${GCP_IDENTITY.cloudSqlInstance}`,
    `--project=${PROJECT}`, '--format=json',
  ];

  const planeFor = (listing) => {
    const calls = [];
    const plane = new GcpControlPlane({
      contract,
      notificationChannel: CHANNEL,
      gcloud: async (args) => {
        calls.push(args);
        if (args[0] === 'sql' && args[1] === 'databases' && args[2] === 'list') return listing;
        throw new Error(`unexpected gcloud ${args.join(' ')}`);
      },
      request: async () => { throw new Error('REST must not run'); },
    });
    return { plane, calls };
  };

  await t.test('the live built-in postgres row proves the managed database is absent', async () => {
    const { plane, calls } = planeFor([postgres]);
    assert.deepEqual(await plane.read('database'), { status: 'absent' });
    assert.deepEqual(calls, [listArgv]);
    assert.equal(calls.some((args) => args.includes('describe') || args.includes('create')), false);
  });

  await t.test('one exact managed row is present and remains contract-comparable', async () => {
    const { plane, calls } = planeFor([postgres, target]);
    const result = await plane.read('database');
    assert.equal(result.status, 'present');
    assert.deepEqual(result.value, target);
    assert.equal(plane.compare('database', result.value), true);
    assert.equal(plane.compare('database', {
      ...result.value,
      selfLink: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/foreign/databases/${GCP_IDENTITY.database}`,
    }), false);
    assert.deepEqual(calls, [listArgv]);
  });

  for (const [name, listing] of [
    ['empty list', []],
    ['missing postgres witness', [target]],
    ['non-array response', { items: [postgres] }],
    ['non-object row', [postgres, null]],
    ['missing name', [{ ...postgres, name: undefined }]],
    ['wrong kind', [{ ...postgres, kind: 'sql#operation' }]],
    ['foreign instance', [{ ...postgres, instance: 'foreign-instance' }]],
    ['foreign project', [{ ...postgres, project: 'foreign-project' }]],
    ['drifted postgres self link', [{
      ...postgres,
      selfLink: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/foreign/databases/postgres`,
    }]],
    ['drifted managed self link', [postgres, {
      ...target,
      selfLink: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/foreign/databases/${GCP_IDENTITY.database}`,
    }]],
    ['duplicate system name', [postgres, { ...postgres }]],
    ['duplicate managed name', [postgres, target, { ...target }]],
  ]) {
    await t.test(name, async () => {
      const { plane, calls } = planeFor(listing);
      let creates = 0;
      await assert.rejects(
        () => ensureExactResource({
          id: 'database', mutate: true,
          read: () => plane.read('database'),
          create: async () => { creates += 1; },
          compare: (value) => plane.compare('database', value),
        }),
        (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
      );
      assert.deepEqual(calls, [listArgv]);
      assert.equal(creates, 0);
      assert.equal(calls.some((args) => args.includes('create')), false);
    });
  }
});

test('the current generic database describe 404 remains ambiguous even for the managed argv', async () => {
  const stderr = 'ERROR: (gcloud.sql.databases.describe) HTTPError 404: Not Found. This command is authenticated as admin@motionexp.com which is the active account specified by the [core/account] property\n';
  const executor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      throw error;
    },
  });
  await assert.rejects(
    () => executor([
      'sql', 'databases', 'describe', GCP_IDENTITY.database,
      `--instance=${GCP_IDENTITY.cloudSqlInstance}`, `--project=${PROJECT}`, '--format=json',
    ]),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS',
  );
});

test('real control-plane create-or-readback families receive canonical absence and perform zero mutation', async (t) => {
  const contract = await contractFixture();
  const fixtures = [
    ['artifact-registry', `ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Repository [projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}] was not found.`],
    ['service-account:hkbuddy-v1-runtime', `ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Service account [${GCP_IDENTITY.serviceAccounts.runtime}] was not found in project [${PROJECT}].`],
    ['custom-role:hkbuddyV1AcceptanceBucketMetadataReader', `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role [projects/${PROJECT}/roles/hkbuddyV1AcceptanceBucketMetadataReader] was not found.`],
    ['vpc', `ERROR: (gcloud.compute.networks.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}' was not found`],
    ['subnet', `ERROR: (gcloud.compute.networks.subnets.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}' was not found`],
    ['psa-range', `ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}' was not found`],
    ['cloud-sql-instance', `ERROR: (gcloud.sql.instances.describe) HTTPError 404: The resource [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}] was not found.`],
    ['bucket', `ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket [gs://${GCP_IDENTITY.bucket}] does not exist.`],
    ['build-source-bucket', `ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket [gs://${GCP_IDENTITY.buildSourceBucket}] does not exist.`],
    [`secret-container:${GCP_IDENTITY.secrets.session}`, `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}] not found.`],
    [`job:${GCP_IDENTITY.jobs.migration}`, `ERROR: (gcloud.run.jobs.describe) Cannot find job [${GCP_IDENTITY.jobs.migration}].`],
  ];
  for (const [id, stderr] of fixtures) {
    await t.test(id, async () => {
      const calls = [];
      const executor = createGcloudExecutor({
        executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
        execFile: async (_executable, args) => {
          calls.push(args.slice(1));
          const error = new Error('gcloud failed'); error.stderr = stderr; throw error;
        },
      });
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL, gcloud: executor,
        request: async () => { throw new Error('HTTPS must not be used for gcloud describe families'); },
      });
      assert.deepEqual(await plane.read(id), { status: 'absent' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].some((value) => ['create', 'enable', 'add-iam-policy-binding'].includes(value)), false);

      const ambiguousCalls = [];
      const ambiguousPlane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: createGcloudExecutor({
          executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
          execFile: async (_executable, args) => {
            ambiguousCalls.push(args.slice(1));
            const error = new Error('gcloud failed');
            error.stderr = `${stderr} foreign-resource`;
            throw error;
          },
        }),
        request: async () => { throw new Error('HTTPS must remain inert'); },
      });
      await assert.rejects(
        () => ambiguousPlane.read(id),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
      assert.equal(ambiguousCalls.length, 1);
      assert.equal(ambiguousCalls[0].some((value) => (
        ['create', 'enable', 'add-iam-policy-binding'].includes(value)
      )), false);
    });
  }
});

test('exhaustive inventory gets a bounded invocation-specific output capacity and overflow fails closed', async () => {
  const calls = [];
  const executor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async (_executable, _args, options) => {
      calls.push(options);
      const error = new Error('stdout maxBuffer length exceeded');
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      throw error;
    },
  });
  await assert.rejects(
    () => executor(['asset', 'search-all-resources', `--project=${PROJECT}`], { maxBuffer: 16 * 1024 * 1024 }),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS',
  );
  assert.deepEqual(calls, [{
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 120_000,
  }]);
  await assert.rejects(
    () => executor(['asset', 'search-all-resources', `--project=${PROJECT}`], { maxBuffer: 64 * 1024 * 1024 }),
    /output limit is invalid/,
  );
});

test('authenticated HTTPS control-plane identity is resolved without exposing its token', async () => {
  const seen = [];
  const request = createAuthenticatedRequest({
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: 'sensitive-access-token' }),
        getTokenInfo: async (token) => {
          seen.push(['token-info', token]);
          return { email: 'admin@motionexp.com' };
        },
        request: async (input) => { seen.push(['request', input]); return { data: { ok: true } }; },
      }),
    },
  });
  assert.equal(await request.getPrincipal(), 'admin@motionexp.com');
  assert.deepEqual(await request({ method: 'GET', url: 'https://example.googleapis.com/v1/read' }), { ok: true });
  assert.equal(JSON.stringify(seen.filter(([kind]) => kind !== 'token-info')).includes('sensitive-access-token'), false);
});

test('Google Auth REST rejects every 404 provenance and enforces the exact quota project', async (t) => {
  await t.test('quota project overrides client state and ignores caller authentication headers', async () => {
    const captured = [];
    const client = {
      quotaProjectId: 'foreign-project',
      request: async (input) => { captured.push(input); return { data: { ok: true } }; },
    };
    const request = createAuthenticatedRequest({ auth: { getClient: async () => client } });

    assert.deepEqual(await request({
      method: 'GET', url: 'https://example.googleapis.com/v1/read',
      headers: {
        authorization: 'Bearer caller-supplied-secret',
        'x-goog-user-project': 'foreign-project',
      },
      authorization: 'Bearer alternate-caller-secret',
    }), { ok: true });
    assert.equal(client.quotaProjectId, 'motion-expert-hk-ltd-webpage');
    assert.equal(captured.length, 1);
    const [{ signal, ...capturedRequest }] = captured;
    assert.equal(signal instanceof AbortSignal, true);
    assert.deepEqual(capturedRequest, {
      method: 'GET', url: 'https://example.googleapis.com/v1/read', data: undefined,
      timeout: 120_000,
      headers: { 'x-goog-user-project': 'motion-expert-hk-ltd-webpage' },
    });
    assert.equal(JSON.stringify(captured).includes('caller-supplied-secret'), false);
    assert.equal(JSON.stringify(captured).includes('alternate-caller-secret'), false);
    assert.equal(JSON.stringify(captured).includes('foreign-project'), false);
  });

  for (const [name, dependencyError] of [
    ['bare NOT_FOUND', Object.assign(new Error('sensitive-bearer-token'), { code: 'NOT_FOUND' })],
    ['HTTP status 404', Object.assign(new Error('private-request-secret'), { response: { status: 404 } })],
  ]) {
    await t.test(name, async () => {
      const request = createAuthenticatedRequest({
        auth: {
          getClient: async () => ({
            quotaProjectId: 'foreign-project',
            request: async () => { throw dependencyError; },
          }),
        },
      });
      await assert.rejects(
        () => request({ method: 'GET', url: 'https://example.googleapis.com/v1/read' }),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS'
          && !String(error).includes('sensitive-bearer-token')
          && !String(error).includes('private-request-secret')
          && !JSON.stringify(error).includes('sensitive-bearer-token')
          && !JSON.stringify(error).includes('private-request-secret'),
      );
    });
  }
});

test('Google Auth REST propagates the caller deadline signal to the SDK transport', async () => {
  const captured = [];
  const controller = new AbortController();
  const timeoutController = new AbortController();
  const timeoutCalls = [];
  const request = createAuthenticatedRequest({
    createTimeoutSignal: (milliseconds) => {
      timeoutCalls.push(milliseconds);
      return timeoutController.signal;
    },
    auth: {
      getClient: async () => ({
        request: async (input) => {
          captured.push(input);
          return { data: { ok: true } };
        },
      }),
    },
  });

  assert.deepEqual(await request({
    method: 'GET', url: 'https://example.googleapis.com/v1/read', signal: controller.signal,
  }), { ok: true });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].signal instanceof AbortSignal, true);
  assert.notEqual(captured[0].signal, controller.signal);
  assert.notEqual(captured[0].signal, timeoutController.signal);
  assert.deepEqual(timeoutCalls, [120_000]);
  controller.abort();
  assert.equal(captured[0].signal.aborted, true);
  await assert.rejects(
    () => request({ method: 'GET', url: 'https://example.googleapis.com/v1/read', signal: {} }),
    /Authenticated request is invalid/,
  );
});

test('standalone Google Auth principal lookup bounds every SDK credential wait', async (t) => {
  for (const hangingStage of ['getClient', 'getAccessToken', 'getTokenInfo']) {
    await t.test(hangingStage, async () => {
      const timeoutController = new AbortController();
      const { signal } = timeoutController;
      const originalAddEventListener = signal.addEventListener.bind(signal);
      const originalRemoveEventListener = signal.removeEventListener.bind(signal);
      let activeAbortListeners = 0;
      let addedAbortListeners = 0;
      signal.addEventListener = (type, listener, options) => {
        if (type === 'abort') {
          activeAbortListeners += 1;
          addedAbortListeners += 1;
        }
        return originalAddEventListener(type, listener, options);
      };
      signal.removeEventListener = (type, listener, options) => {
        if (type === 'abort') activeAbortListeners -= 1;
        return originalRemoveEventListener(type, listener, options);
      };

      const timeoutCalls = [];
      let stageStarted;
      const stageStartedPromise = new Promise((resolve) => { stageStarted = resolve; });
      const hang = () => {
        stageStarted();
        return new Promise(() => {});
      };
      const client = {
        getAccessToken: () => hangingStage === 'getAccessToken'
          ? hang() : Promise.resolve({ token: 'sensitive-sdk-principal-token' }),
        getTokenInfo: () => hangingStage === 'getTokenInfo'
          ? hang() : Promise.resolve({ email: 'admin@motionexp.com' }),
      };
      const request = createAuthenticatedRequest({
        createTimeoutSignal: (milliseconds) => {
          timeoutCalls.push(milliseconds);
          return signal;
        },
        auth: {
          getClient: () => hangingStage === 'getClient' ? hang() : Promise.resolve(client),
        },
      });

      const pending = request.getPrincipal().then(
        () => ({ code: 'unexpected-success', serialized: '' }),
        (error) => ({ code: error.code, serialized: `${String(error)}${JSON.stringify(error)}` }),
      );
      await stageStartedPromise;
      timeoutController.abort();
      let watchdog;
      const outcome = await Promise.race([
        pending,
        new Promise((resolve) => {
          watchdog = setTimeout(() => resolve({ code: 'watchdog-expired', serialized: '' }), 100);
        }),
      ]);
      clearTimeout(watchdog);

      assert.equal(outcome.code, 'TRANSPORT_AMBIGUOUS');
      assert.equal(outcome.serialized.includes('sensitive-sdk-principal-token'), false);
      assert.deepEqual(timeoutCalls, [120_000]);
      assert.equal(addedAbortListeners >= 1, true);
      assert.equal(activeAbortListeners, 0);
    });
  }
});

test('Google Auth REST aborts initial and cached waits for a hanging SDK client', async () => {
  let getClientCalls = 0;
  let getClientStarted;
  const getClientStartedPromise = new Promise((resolve) => { getClientStarted = resolve; });
  const request = createAuthenticatedRequest({
    auth: {
      getClient: () => {
        getClientCalls += 1;
        getClientStarted();
        return new Promise(() => {});
      },
    },
  });

  const runAbortAttempt = async () => {
    const controller = new AbortController();
    const { signal } = controller;
    const originalAddEventListener = signal.addEventListener.bind(signal);
    const originalRemoveEventListener = signal.removeEventListener.bind(signal);
    let activeAbortListeners = 0;
    let addedAbortListeners = 0;
    signal.addEventListener = (type, listener, options) => {
      if (type === 'abort') {
        activeAbortListeners += 1;
        addedAbortListeners += 1;
      }
      return originalAddEventListener(type, listener, options);
    };
    signal.removeEventListener = (type, listener, options) => {
      if (type === 'abort') activeAbortListeners -= 1;
      return originalRemoveEventListener(type, listener, options);
    };

    const pending = request({
      method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/example/operations', signal,
    }).then(
      () => ({ code: 'unexpected-success', serialized: '' }),
      (error) => ({ code: error.code, serialized: `${String(error)}${JSON.stringify(error)}` }),
    );
    controller.abort();
    let watchdog;
    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve({ code: 'watchdog-expired', serialized: '' }), 100);
      }),
    ]);
    clearTimeout(watchdog);
    return { outcome, activeAbortListeners, addedAbortListeners };
  };

  const initial = await runAbortAttempt();
  await getClientStartedPromise;
  const cached = await runAbortAttempt();
  for (const attempt of [initial, cached]) {
    assert.equal(attempt.outcome.code, 'TRANSPORT_AMBIGUOUS');
    assert.equal(attempt.outcome.serialized.includes('credential'), false);
    assert.equal(attempt.addedAbortListeners, 1);
    assert.equal(attempt.activeAbortListeners, 0);
  }
  assert.equal(getClientCalls, 1);
});

test('Google Auth REST abort race bounds an SDK request that ignores its signal', async () => {
  const callerController = new AbortController();
  const timeoutController = new AbortController();
  const { signal } = callerController;
  const originalAddEventListener = signal.addEventListener.bind(signal);
  const originalRemoveEventListener = signal.removeEventListener.bind(signal);
  let activeAbortListeners = 0;
  let addedAbortListeners = 0;
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') {
      activeAbortListeners += 1;
      addedAbortListeners += 1;
    }
    return originalAddEventListener(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') activeAbortListeners -= 1;
    return originalRemoveEventListener(type, listener, options);
  };
  let requestStarted;
  const requestStartedPromise = new Promise((resolve) => { requestStarted = resolve; });
  let capturedSignal;
  const request = createAuthenticatedRequest({
    createTimeoutSignal: () => timeoutController.signal,
    auth: {
      getClient: async () => ({
        request: (input) => {
          capturedSignal = input.signal;
          requestStarted();
          return new Promise(() => {});
        },
      }),
    },
  });

  const pending = request({
    method: 'POST', url: 'https://sqladmin.googleapis.com/v1/projects/example/operations',
    body: { value: 'sensitive-sdk-body' }, signal,
  }).then(
    () => ({ code: 'unexpected-success', serialized: '' }),
    (error) => ({ code: error.code, serialized: `${String(error)}${JSON.stringify(error)}` }),
  );
  await requestStartedPromise;
  assert.equal(capturedSignal instanceof AbortSignal, true);
  assert.notEqual(capturedSignal, signal);
  assert.notEqual(capturedSignal, timeoutController.signal);
  callerController.abort();
  let watchdog;
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({ code: 'watchdog-expired', serialized: '' }), 100);
    }),
  ]);
  clearTimeout(watchdog);

  assert.equal(outcome.code, 'TRANSPORT_AMBIGUOUS');
  assert.equal(outcome.serialized.includes('sensitive-sdk-body'), false);
  assert.equal(addedAbortListeners, 2);
  assert.equal(activeAbortListeners, 0);
});

test('standalone Google Auth principal lookup composes its caller and default deadlines', async () => {
  const callerController = new AbortController();
  const timeoutController = new AbortController();
  const { signal } = callerController;
  const originalAddEventListener = signal.addEventListener.bind(signal);
  const originalRemoveEventListener = signal.removeEventListener.bind(signal);
  let activeAbortListeners = 0;
  let addedAbortListeners = 0;
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') {
      activeAbortListeners += 1;
      addedAbortListeners += 1;
    }
    return originalAddEventListener(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') activeAbortListeners -= 1;
    return originalRemoveEventListener(type, listener, options);
  };
  const timeoutCalls = [];
  let tokenInfoStarted;
  const tokenInfoStartedPromise = new Promise((resolve) => { tokenInfoStarted = resolve; });
  const request = createAuthenticatedRequest({
    createTimeoutSignal: (milliseconds) => {
      timeoutCalls.push(milliseconds);
      return timeoutController.signal;
    },
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: 'sensitive-sdk-caller-token' }),
        getTokenInfo: () => {
          tokenInfoStarted();
          return new Promise(() => {});
        },
      }),
    },
  });

  const pending = request.getPrincipal(signal).then(
    () => ({ code: 'unexpected-success', serialized: '' }),
    (error) => ({ code: error.code, serialized: `${String(error)}${JSON.stringify(error)}` }),
  );
  await tokenInfoStartedPromise;
  callerController.abort();
  let watchdog;
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({ code: 'watchdog-expired', serialized: '' }), 100);
    }),
  ]);
  clearTimeout(watchdog);

  assert.equal(outcome.code, 'TRANSPORT_AMBIGUOUS');
  assert.equal(outcome.serialized.includes('sensitive-sdk-caller-token'), false);
  assert.deepEqual(timeoutCalls, [120_000]);
  assert.equal(addedAbortListeners, 3);
  assert.equal(activeAbortListeners, 0);
});

test('Google Auth Cloud SQL REST classifies structured 409 reasons exactly', async (t) => {
  const target = `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases`;
  for (const [reason, code] of [
    ['operationInProgress', 'SQL_OPERATION_IN_PROGRESS'],
    ['invalidState', 'SQL_INVALID_STATE'],
    ['alreadyExists', 'ALREADY_EXISTS'],
    ['unknownConflict', 'HTTP_CONFLICT_AMBIGUOUS'],
  ]) {
    await t.test(reason, async () => {
      const request = createAuthenticatedRequest({
        auth: {
          getClient: async () => ({
            request: async () => {
              const error = new Error('redacted-conflict-secret');
              error.response = {
                status: 409,
                data: {
                  error: {
                    code: 409,
                    message: 'redacted-conflict-secret',
                    errors: [{ domain: 'global', reason, message: 'redacted-conflict-secret' }],
                  },
                },
              };
              throw error;
            },
          }),
        },
      });
      await assert.rejects(
        () => request({ method: 'POST', url: target, body: { name: GCP_IDENTITY.database } }),
        (error) => error.code === code
          && !String(error).includes('redacted-conflict-secret')
          && !JSON.stringify(error).includes('redacted-conflict-secret'),
      );
    });
  }

  await t.test('hostile response payload getter', async () => {
    const request = createAuthenticatedRequest({
      auth: {
        getClient: async () => ({
          request: async () => {
            const error = new Error('outer-secret');
            error.response = { status: 409 };
            Object.defineProperty(error.response, 'data', {
              get() { throw new Error('payload-getter-secret'); },
            });
            throw error;
          },
        }),
      },
    });
    await assert.rejects(
      () => request({ method: 'POST', url: target, body: { name: GCP_IDENTITY.database } }),
      (error) => error.code === 'HTTP_CONFLICT_AMBIGUOUS'
        && !String(error).includes('secret') && !JSON.stringify(error).includes('secret'),
    );
  });

  await t.test('malformed 409 payload', async () => {
    const request = createAuthenticatedRequest({
      auth: {
        getClient: async () => ({
          request: async () => {
            const error = new Error('redacted-conflict-secret');
            error.response = { status: 409, data: '{not-json' };
            throw error;
          },
        }),
      },
    });
    await assert.rejects(
      () => request({ method: 'POST', url: target, body: { name: GCP_IDENTITY.database } }),
      (error) => error.code === 'HTTP_CONFLICT_AMBIGUOUS'
        && !String(error).includes('redacted-conflict-secret')
        && !JSON.stringify(error).includes('redacted-conflict-secret'),
    );
  });
});

test('Google Auth Storage IAM treats a structured ABORTED etag conflict as deterministic only for a managed bucket policy', async (t) => {
  const managed = `https://storage.googleapis.com/storage/v1/b/${GCP_IDENTITY.bucket}/iam`;
  const foreign = 'https://storage.googleapis.com/storage/v1/b/foreign-bucket/iam';
  for (const [name, target, expected] of [
    ['managed bucket policy', managed, 'IAM_POLICY_ETAG_MISMATCH'],
    ['foreign bucket policy', foreign, 'HTTP_CONFLICT_AMBIGUOUS'],
  ]) {
    await t.test(name, async () => {
      const request = createAuthenticatedRequest({
        auth: {
          getClient: async () => ({
            request: async () => {
              const error = new Error('redacted-concurrent-policy');
              error.response = {
                status: 409,
                data: {
                  error: {
                    code: 409,
                    message: 'redacted-concurrent-policy',
                    status: 'ABORTED',
                  },
                },
              };
              throw error;
            },
          }),
        },
      });
      await assert.rejects(
        () => request({ method: 'PUT', url: target, body: { etag: 'CAE=', bindings: [] } }),
        (error) => error.code === expected
          && !String(error).includes('redacted-concurrent-policy')
          && !JSON.stringify(error).includes('redacted-concurrent-policy'),
      );
    });
  }
});

test('default-style HTTPS authentication reuses the exact gcloud account without putting bearer data in argv', async () => {
  const execCalls = [];
  const fetchCalls = [];
  const tokenInfoCalls = [];
  const request = createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com',
    execFile: async (executable, args, options) => {
      execCalls.push({ executable, args, options });
      if (args.includes('config')) return {
        stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '',
      };
      return { stdout: 'sensitive-bearer-token\n', stderr: '' };
    },
    getTokenInfo: async (token) => {
      tokenInfoCalls.push(token);
      return { email: 'admin@motionexp.com' };
    },
    environment: {},
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      const body = Buffer.from('{"ok":true}');
      return {
        ok: true, status: 200, redirected: false, url,
        headers: { get: (name) => name === 'content-length' ? String(body.length) : null },
        body: new ReadableStream({
          start(controller) { controller.enqueue(body); controller.close(); },
        }),
        text: async () => '{"ok":true}',
      };
    },
    now: () => 1_000,
  });
  assert.equal(await request.getPrincipal(), 'admin@motionexp.com');
  assert.deepEqual(await request({
    method: 'POST', url: 'https://example.googleapis.com/v1/write', body: { secret: 'body-only' },
  }), { ok: true });
  assert.equal(execCalls.length, 2);
  assert.deepEqual(execCalls[0].args, [
    'C:/gcloud/lib/gcloud.py', 'config', 'list',
    '--format=json', `--project=${PROJECT}`, '--quiet',
  ]);
  assert.deepEqual(execCalls[1].args, [
    'C:/gcloud/lib/gcloud.py', 'auth', 'print-access-token',
    '--account=admin@motionexp.com', `--project=${PROJECT}`, '--quiet',
  ]);
  assert.deepEqual(
    execCalls.map((call) => call.args.filter((value) => value === '--quiet').length),
    [1, 1],
  );
  assert.deepEqual(tokenInfoCalls, ['sensitive-bearer-token']);
  assert.equal(JSON.stringify(execCalls).includes('sensitive-bearer-token'), false);
  assert.equal(JSON.stringify(execCalls).includes('body-only'), false);
  assert.equal(fetchCalls[0].options.headers.authorization, 'Bearer sensitive-bearer-token');
  assert.equal(fetchCalls[0].options.body, '{"secret":"body-only"}');
  assert.equal(fetchCalls[0].options.redirect, 'error');
});

test('default-style HTTPS requests share one bounded signal across authentication and fetch', async () => {
  const timeoutController = new AbortController();
  const timeoutCalls = [];
  const execSignals = [];
  let fetchSignal;
  const request = createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com', environment: {}, now: () => 1_000,
    createTimeoutSignal: (milliseconds) => {
      timeoutCalls.push(milliseconds);
      return timeoutController.signal;
    },
    execFile: async (_executable, args, options) => {
      execSignals.push(options.signal);
      return args.includes('config')
        ? { stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '' }
        : { stdout: 'sensitive-bearer-token\n', stderr: '' };
    },
    getTokenInfo: async () => ({ email: 'admin@motionexp.com' }),
    fetchImpl: async (url, options) => {
      fetchSignal = options.signal;
      const body = Buffer.from('{"ok":true}');
      return {
        ok: true, status: 200, redirected: false, url,
        headers: { get: (name) => name === 'content-length' ? String(body.length) : null },
        body: new ReadableStream({
          start(controller) { controller.enqueue(body); controller.close(); },
        }),
      };
    },
  });

  assert.deepEqual(await request({
    method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/example/operations',
  }), { ok: true });
  assert.deepEqual(timeoutCalls, [120_000]);
  assert.deepEqual(execSignals, [timeoutController.signal, timeoutController.signal]);
  assert.equal(fetchSignal, timeoutController.signal);
});

test('standalone gcloud principal lookup has a default bounded token-inspection wait', async () => {
  const timeoutController = new AbortController();
  const timeoutCalls = [];
  let tokenInfoStarted;
  const tokenInfoStartedPromise = new Promise((resolve) => { tokenInfoStarted = resolve; });
  const request = createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com', environment: {},
    createTimeoutSignal: (milliseconds) => {
      timeoutCalls.push(milliseconds);
      return timeoutController.signal;
    },
    execFile: async (_executable, args) => args.includes('config')
      ? { stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '' }
      : { stdout: 'sensitive-principal-bearer-token\n', stderr: '' },
    getTokenInfo: async () => {
      tokenInfoStarted();
      return new Promise(() => {});
    },
    fetchImpl: async () => { throw new Error('fetch must not run'); },
  });

  const pending = request.getPrincipal().then(
    () => ({ code: 'unexpected-success', serialized: '' }),
    (error) => ({ code: error.code, serialized: `${String(error)}${JSON.stringify(error)}` }),
  );
  await tokenInfoStartedPromise;
  timeoutController.abort();
  let watchdog;
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({ code: 'watchdog-expired', serialized: '' }), 100);
    }),
  ]);
  clearTimeout(watchdog);

  assert.equal(outcome.code, 'TRANSPORT_AMBIGUOUS');
  assert.equal(outcome.serialized.includes('sensitive-principal-bearer-token'), false);
  assert.deepEqual(timeoutCalls, [120_000]);
});

test('cached standalone gcloud principal lookup still honors an aborted caller deadline', async () => {
  let tokenInfoCalls = 0;
  const request = createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com', environment: {}, now: () => 1_000,
    execFile: async (_executable, args) => args.includes('config')
      ? { stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '' }
      : { stdout: 'sensitive-cached-principal-token\n', stderr: '' },
    getTokenInfo: async () => {
      tokenInfoCalls += 1;
      return { email: 'admin@motionexp.com' };
    },
    fetchImpl: async () => { throw new Error('fetch must not run'); },
  });
  assert.equal(await request.getPrincipal(), 'admin@motionexp.com');
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => request.getPrincipal(controller.signal),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS'
      && !String(error).includes('sensitive-cached-principal-token')
      && !JSON.stringify(error).includes('sensitive-cached-principal-token'),
  );
  assert.equal(tokenInfoCalls, 1);
});

test('expired gcloud principal refresh aborts hanging token inspection and removes its listener', async () => {
  let now = 0;
  let tokenInfoCalls = 0;
  let refreshStarted;
  const refreshStartedPromise = new Promise((resolve) => { refreshStarted = resolve; });
  let fetchCalls = 0;
  let activeAbortListeners = 0;
  let addedAbortListeners = 0;
  let refreshSignal = null;
  const request = createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com', environment: {}, now: () => now,
    execFile: async (_executable, args, options) => {
      if (now === 240_001 && refreshSignal === null) {
        refreshSignal = options.signal;
        const originalAddEventListener = refreshSignal.addEventListener.bind(refreshSignal);
        const originalRemoveEventListener = refreshSignal.removeEventListener.bind(refreshSignal);
        refreshSignal.addEventListener = (type, listener, listenerOptions) => {
          if (type === 'abort') {
            activeAbortListeners += 1;
            addedAbortListeners += 1;
          }
          return originalAddEventListener(type, listener, listenerOptions);
        };
        refreshSignal.removeEventListener = (type, listener, listenerOptions) => {
          if (type === 'abort') activeAbortListeners -= 1;
          return originalRemoveEventListener(type, listener, listenerOptions);
        };
      }
      return args.includes('config')
        ? { stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '' }
        : { stdout: 'sensitive-refresh-bearer-token\n', stderr: '' };
    },
    getTokenInfo: async () => {
      tokenInfoCalls += 1;
      if (tokenInfoCalls === 1) return { email: 'admin@motionexp.com' };
      refreshStarted();
      return new Promise(() => {});
    },
    fetchImpl: async () => { fetchCalls += 1; throw new Error('fetch must not run'); },
  });
  assert.equal(await request.getPrincipal(), 'admin@motionexp.com');
  now = 240_001;

  const controller = new AbortController();
  const { signal } = controller;

  const pending = request({
    method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/example/operations', signal,
  }).then(
    () => ({ code: 'unexpected-success', serialized: '' }),
    (error) => ({ code: error.code, serialized: `${String(error)}${JSON.stringify(error)}` }),
  );
  await refreshStartedPromise;
  controller.abort();
  let watchdog;
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({ code: 'watchdog-expired', serialized: '' }), 100);
    }),
  ]);
  clearTimeout(watchdog);

  assert.equal(outcome.code, 'TRANSPORT_AMBIGUOUS');
  assert.equal(outcome.serialized.includes('sensitive-refresh-bearer-token'), false);
  assert.equal(tokenInfoCalls, 2);
  assert.equal(fetchCalls, 0);
  assert.equal(addedAbortListeners, 1);
  assert.equal(activeAbortListeners, 0);
});

function authenticatedResponse(url, {
  chunks = [Buffer.from('{"ok":true}')],
  contentLength,
  redirected = false,
  finalUrl = url,
  status = 200,
} = {}) {
  let index = 0;
  const observations = { cancelled: false, reads: 0, textCalls: 0 };
  const body = chunks === null ? null : new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      observations.reads += 1;
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() { observations.cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    observations,
    response: {
      ok: status >= 200 && status < 300,
      status,
      redirected,
      url: finalUrl,
      headers: {
        get(name) {
          if (name !== 'content-length') return null;
          return contentLength === undefined ? null : String(contentLength);
        },
      },
      body,
      async text() {
        observations.textCalls += 1;
        return chunks === null ? '' : Buffer.concat(chunks).toString('utf8');
      },
    },
  };
}

function authenticatedRequestFixture(fetchImpl) {
  return createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com', environment: {},
    execFile: async (_executable, args) => args.includes('config')
      ? { stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '' }
      : { stdout: 'sensitive-bearer-token\n', stderr: '' },
    getTokenInfo: async () => ({ email: 'admin@motionexp.com' }),
    fetchImpl,
    now: () => 1_000,
  });
}

test('authenticated Cloud SQL REST classifies structured 409 reasons without treating every conflict as existence', async (t) => {
  const target = `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases`;
  for (const [reason, code] of [
    ['operationInProgress', 'SQL_OPERATION_IN_PROGRESS'],
    ['invalidState', 'SQL_INVALID_STATE'],
    ['alreadyExists', 'ALREADY_EXISTS'],
    ['unknownConflict', 'HTTP_CONFLICT_AMBIGUOUS'],
  ]) {
    await t.test(reason, async () => {
      const payload = Buffer.from(JSON.stringify({
        error: {
          code: 409,
          message: 'redacted conflict',
          errors: [{ domain: 'global', reason, message: 'redacted conflict' }],
        },
      }));
      const fixture = authenticatedResponse(target, { chunks: [payload], status: 409 });
      const request = authenticatedRequestFixture(async () => fixture.response);
      await assert.rejects(
        () => request({ method: 'POST', url: target, body: { name: GCP_IDENTITY.database } }),
        (error) => error.code === code && !String(error).includes('redacted conflict'),
      );
    });
  }

  await t.test('malformed 409 payload', async () => {
    const payload = Buffer.from('{not-json');
    const fixture = authenticatedResponse(target, {
      chunks: [payload], status: 409, contentLength: payload.length,
    });
    const request = authenticatedRequestFixture(async () => fixture.response);
    await assert.rejects(
      () => request({ method: 'POST', url: target, body: { name: GCP_IDENTITY.database } }),
      (error) => error.code === 'HTTP_CONFLICT_AMBIGUOUS',
    );
  });

  for (const [name, fixture] of [
    ['truncated 409 payload', authenticatedResponse(target, {
      chunks: [Buffer.from('{"error":')], status: 409, contentLength: 10,
    })],
    ['invalid UTF-8 409 payload', authenticatedResponse(target, {
      chunks: [Buffer.from([0xc3, 0x28])], status: 409, contentLength: 2,
    })],
  ]) {
    await t.test(name, async () => {
      const request = authenticatedRequestFixture(async () => fixture.response);
      await assert.rejects(
        () => request({ method: 'POST', url: target, body: { name: GCP_IDENTITY.database } }),
        (error) => error.code === 'HTTP_CONFLICT_AMBIGUOUS',
      );
    });
  }

  await t.test('hanging 409 payload aborted by the caller', async () => {
    let responseStarted;
    const responseStartedPromise = new Promise((resolve) => { responseStarted = resolve; });
    const request = authenticatedRequestFixture(async (url, options) => {
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => controller.error(new Error('aborted-secret')), {
            once: true,
          });
          responseStarted();
        },
      });
      return {
        ok: false, status: 409, redirected: false, url,
        headers: { get: () => null }, body,
      };
    });
    const controller = new AbortController();
    const pending = request({
      method: 'POST', url: target, body: { name: GCP_IDENTITY.database }, signal: controller.signal,
    }).then(
      () => ({ code: 'unexpected-success', serialized: '' }),
      (error) => ({ code: error.code, serialized: `${String(error)}${JSON.stringify(error)}` }),
    );
    await responseStartedPromise;
    controller.abort();
    let watchdog;
    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve({ code: 'watchdog-expired', serialized: '' }), 100);
      }),
    ]);
    clearTimeout(watchdog);
    assert.equal(outcome.code, 'HTTP_CONFLICT_AMBIGUOUS');
    assert.equal(outcome.serialized.includes('secret'), false);
  });
});

test('authenticated Storage IAM direct REST preserves deterministic managed-bucket etag conflicts', async () => {
  const target = `https://storage.googleapis.com/storage/v1/b/${GCP_IDENTITY.buildSourceBucket}/iam`;
  const payload = Buffer.from(JSON.stringify({
    error: {
      code: 409,
      message: 'redacted-concurrent-policy',
      status: 'ABORTED',
    },
  }));
  const fixture = authenticatedResponse(target, {
    chunks: [payload], status: 409, contentLength: payload.length,
  });
  const request = authenticatedRequestFixture(async () => fixture.response);
  await assert.rejects(
    () => request({ method: 'PUT', url: target, body: { etag: 'CAE=', bindings: [] } }),
    (error) => error.code === 'IAM_POLICY_ETAG_MISMATCH'
      && !String(error).includes('redacted-concurrent-policy')
      && !JSON.stringify(error).includes('redacted-concurrent-policy'),
  );
});

test('authenticated REST bills every Google API request to the exact target quota project', async () => {
  const target = 'https://billingbudgets.googleapis.com/v1/billingAccounts/example/budgets';
  const fixture = authenticatedResponse(target);
  let capturedHeaders;
  const request = authenticatedRequestFixture(async (_url, options) => {
    capturedHeaders = options.headers;
    return fixture.response;
  });

  assert.deepEqual(await request({ method: 'GET', url: target }), { ok: true });
  assert.equal(capturedHeaders['x-goog-user-project'], 'motion-expert-hk-ltd-webpage');
});

test('direct-fetch authenticated REST treats a bounded Google 404 as ambiguous', async () => {
  const target = 'https://example.googleapis.com/v1/read';
  const privateDetail = 'private-response-detail';
  const bytes = Buffer.from(JSON.stringify({
    error: { code: 404, message: privateDetail, status: 'NOT_FOUND' },
  }));
  const fixture = authenticatedResponse(target, {
    status: 404, chunks: [bytes], contentLength: bytes.length,
  });
  const request = authenticatedRequestFixture(async () => fixture.response);

  await assert.rejects(
    () => request({ method: 'GET', url: target }),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS'
      && !String(error).includes('sensitive-bearer-token')
      && !String(error).includes(privateDetail)
      && !JSON.stringify(error).includes('sensitive-bearer-token')
      && !JSON.stringify(error).includes(privateDetail),
  );
});

test('authenticated REST rejects redirected or drifted final URLs before consuming response bytes', async (t) => {
  const target = 'https://example.googleapis.com/v1/write';
  for (const [name, responseOverrides] of [
    ['redirected response', { redirected: true }],
    ['missing final URL', { finalUrl: null }],
    ['drifted final URL', { finalUrl: 'https://other.googleapis.com/v1/write' }],
  ]) {
    await t.test(name, async () => {
      const fixture = authenticatedResponse(target, responseOverrides);
      const request = authenticatedRequestFixture(async () => fixture.response);
      await assert.rejects(
        () => request({ method: 'POST', url: target, body: { value: 'private-body' } }),
        (error) => !String(error).includes('private-body'),
      );
      assert.equal(fixture.observations.textCalls, 0);
      assert.equal(fixture.observations.reads, 0);
      assert.equal(fixture.observations.cancelled, true);
    });
  }
});

test('authenticated REST redirect policy prevents 307/308 replay of secret and SQL password bodies', async (t) => {
  const target = 'https://example.googleapis.com/v1/write';
  for (const [status, body, privateValue] of [
    [307, { payload: { data: 'secret-version-private-value' } }, 'secret-version-private-value'],
    [308, { name: 'hkbuddy_app', password: 'cloud-sql-private-password' }, 'cloud-sql-private-password'],
  ]) {
    await t.test(String(status), async () => {
      const replayedBodies = [];
      const request = authenticatedRequestFixture(async (url, options) => {
        if (options.redirect === 'error') throw new TypeError(`redirect ${status} refused`);
        replayedBodies.push(options.body);
        return authenticatedResponse(url).response;
      });
      await assert.rejects(
        () => request({ method: 'POST', url: target, body }),
        (error) => !String(error).includes(privateValue),
      );
      assert.deepEqual(replayedBodies, []);
    });
  }
});

test('authenticated REST incrementally bounds chunked responses and never calls whole-body text', async () => {
  const target = 'https://example.googleapis.com/v1/read';
  const fixture = authenticatedResponse(target, {
    chunks: [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024), Buffer.from('x')],
  });
  const request = authenticatedRequestFixture(async () => fixture.response);
  await assert.rejects(
    () => request({ method: 'GET', url: target }),
    (error) => error.code === 'CONTROL_PLANE_RESPONSE_TOO_LARGE',
  );
  assert.equal(fixture.observations.cancelled, true);
  assert.equal(fixture.observations.textCalls, 0);
});

test('authenticated REST accepts exact-URL JSON and coherently empty null bodies through the bounded reader', async () => {
  const jsonUrl = 'https://example.googleapis.com/v1/read';
  const jsonBytes = Buffer.from('{"ok":true}');
  const jsonFixture = authenticatedResponse(jsonUrl, {
    chunks: [jsonBytes], contentLength: jsonBytes.length,
  });
  const jsonRequest = authenticatedRequestFixture(async () => jsonFixture.response);
  assert.deepEqual(await jsonRequest({ method: 'GET', url: jsonUrl }), { ok: true });
  assert.equal(jsonFixture.observations.textCalls, 0);

  const emptyUrl = 'https://example.googleapis.com/v1/empty';
  const emptyFixture = authenticatedResponse(emptyUrl, { chunks: null, contentLength: 0 });
  const emptyRequest = authenticatedRequestFixture(async () => emptyFixture.response);
  assert.equal(await emptyRequest({ method: 'GET', url: emptyUrl }), null);
  assert.equal(emptyFixture.observations.textCalls, 0);
});

test('authenticated REST validates declared length, stream chunks, UTF-8, and empty-body coherence', async (t) => {
  const target = 'https://example.googleapis.com/v1/read';
  const cases = [
    ['oversized declared length', {
      fixture: authenticatedResponse(target, { contentLength: 2 * 1024 * 1024 + 1 }),
      code: 'CONTROL_PLANE_RESPONSE_TOO_LARGE', cancelled: true,
    }],
    ['noncanonical declared length', {
      fixture: authenticatedResponse(target, { contentLength: '01' }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: true,
    }],
    ['declared length mismatch', {
      fixture: authenticatedResponse(target, {
        chunks: [Buffer.from('{"ok":true}')], contentLength: 12,
      }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: false,
    }],
    ['invalid stream chunk', {
      fixture: authenticatedResponse(target, { chunks: ['not-bytes'] }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: true,
    }],
    ['invalid UTF-8', {
      fixture: authenticatedResponse(target, { chunks: [Buffer.from([0xc3, 0x28])] }),
      code: 'CONTROL_PLANE_OUTPUT_INVALID', cancelled: false,
    }],
    ['unexplained null body', {
      fixture: authenticatedResponse(target, { chunks: null }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: false,
    }],
  ];
  for (const [name, { fixture, code, cancelled }] of cases) {
    await t.test(name, async () => {
      const request = authenticatedRequestFixture(async () => fixture.response);
      await assert.rejects(
        () => request({ method: 'GET', url: target }),
        (error) => error.code === code && !String(error).includes('sensitive-bearer-token'),
      );
      assert.equal(fixture.observations.cancelled, cancelled);
      assert.equal(fixture.observations.textCalls, 0);
    });
  }

  const forbidden = authenticatedResponse(target, {
    status: 403, chunks: [Buffer.from('{"error":"redacted"}')],
  });
  const request = authenticatedRequestFixture(async () => forbidden.response);
  await assert.rejects(() => request({ method: 'GET', url: target }), { code: 'FORBIDDEN' });
});

test('gcloud HTTPS authentication rejects every effective credential override before token use', async (t) => {
  for (const [name, environment] of [
    ['impersonation env', { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'foreign@example.test' }],
    ['access-token env', { CLOUDSDK_AUTH_ACCESS_TOKEN: 'do-not-use' }],
    ['access-token-file env', { CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: 'C:/foreign-token' }],
    ['credential-file env', { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: 'C:/foreign-credential' }],
  ]) {
    await t.test(name, async () => {
      let execCalls = 0;
      const request = createGcloudAuthenticatedRequest({
        executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
        account: 'admin@motionexp.com', environment,
        execFile: async () => { execCalls += 1; return { stdout: 'must-not-run' }; },
        getTokenInfo: async () => ({ email: 'admin@motionexp.com' }),
      });
      await assert.rejects(() => request.getPrincipal(), (error) => error.code === 'GCLOUD_AUTH_OVERRIDE');
      assert.equal(execCalls, 0);
    });
  }

  for (const [name, auth] of [
    ['impersonation property', { impersonate_service_account: 'foreign@example.test' }],
    ['access-token-file property', { access_token_file: 'C:/foreign-token' }],
    ['credential-file property', { credential_file_override: 'C:/foreign-credential' }],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const request = createGcloudAuthenticatedRequest({
        executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
        account: 'admin@motionexp.com', environment: {},
        execFile: async (_executable, args) => {
          calls.push(args);
          return { stdout: `${JSON.stringify({ auth })}\n`, stderr: '' };
        },
        getTokenInfo: async () => ({ email: 'admin@motionexp.com' }),
      });
      await assert.rejects(() => request.getPrincipal(), (error) => error.code === 'GCLOUD_AUTH_OVERRIDE');
      assert.equal(calls.length, 1);
      assert.equal(calls.some((args) => args.includes('print-access-token')), false);
    });
  }
});

test('CIDR audit ignores only the target VPC system default route and blocks real overlap', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/hkbuddy-prod-vpc`;
  assert.doesNotThrow(() => assertCidrAvailable({
    desired: '10.24.0.0/26', network,
    subnets: [], addresses: [],
    routes: [{
      network, destRange: '0.0.0.0/0',
      nextHopGateway: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/gateways/default-internet-gateway`,
    }],
  }));
  assert.throws(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, subnets: [], addresses: [],
    kind: 'psa',
    routes: [{ network, destRange: '10.0.0.0/8', nextHopVpnTunnel: 'vpn-1' }],
  }), (error) => error.code === 'CIDR_OVERLAP');
  assert.throws(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, subnets: [], addresses: [],
    kind: 'psa',
    routes: [{ network, destRange: '10.25.8.0/24', nextHopVpnTunnel: 'vpn-1' }],
  }), (error) => error.code === 'CIDR_OVERLAP');
  assert.throws(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, routes: [], addresses: [],
    subnets: [{ network, ipCidrRange: '10.25.1.0/24' }],
  }), (error) => error.code === 'CIDR_OVERLAP');
  assert.doesNotThrow(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, routes: [], subnets: [],
    kind: 'psa',
    addresses: [{ purpose: 'VPC_PEERING', network: `${network}-other`, address: '10.25.0.0', prefixLength: 16 }],
  }));
});

test('CIDR audit validates complete Compute rows before filtering and requires project network authority', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
  const networks = [{ name: GCP_IDENTITY.network, selfLink: network }];
  const exact = {
    desired: '10.25.0.0/16', kind: 'psa', network, networks,
    subnets: [], routes: [], addresses: [],
  };
  const malformed = [
    { ...exact, networks: [{ name: GCP_IDENTITY.network }] },
    { ...exact, subnets: [{ name: 'foreign-subnet', network: null, ipCidrRange: '10.25.1.0/24', region: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2` }] },
    { ...exact, routes: [{ name: 'foreign-route', network: null, destRange: '10.25.1.0/24', nextHopVpnTunnel: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2/vpnTunnels/foreign` }] },
    { ...exact, addresses: [{ name: 'foreign-psa', purpose: 'VPC_PEERING', address: '10.25.0.0', prefixLength: 16 }] },
    { ...exact, addresses: [{ name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '10.25.0.1', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }] },
    { ...exact, subnets: [{ name: 'foreign-subnet', network: `${network}-missing`, ipCidrRange: '10.25.1.0/24', region: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2` }] },
  ];
  for (const input of malformed) {
    assert.throws(() => assertCidrAvailable(input), (error) => error.code === 'CIDR_AUDIT_INVALID');
  }
  assert.throws(() => assertCidrAvailable({
    ...exact,
    routes: [{
      name: 'foreign-default', network, destRange: '0.0.0.0/0',
      nextHopGateway: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/gateways/custom-gateway`,
    }],
  }), (error) => error.code === 'CIDR_OVERLAP');
});

test('CIDR audit accepts regional subnet name reuse and still rejects duplicate regional identities', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const asiaEast1 = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east1`;
  const asiaEast2 = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const first = {
    name: 'default', network, region: asiaEast1,
    selfLink: `${asiaEast1}/subnetworks/default`, ipCidrRange: '10.128.0.0/20',
  };
  const second = {
    name: 'default', network, region: asiaEast2,
    selfLink: `${asiaEast2}/subnetworks/default`, ipCidrRange: '10.170.0.0/20',
  };
  const exact = {
    desired: '10.24.0.0/26', network,
    networks: [{ name: 'default', selfLink: network }],
    subnets: [first, second], routes: [], addresses: [],
  };

  assert.doesNotThrow(() => assertCidrAvailable(exact));
  assert.throws(() => assertCidrAvailable({
    ...exact,
    subnets: [first, { ...first, ipCidrRange: '10.129.0.0/20' }],
  }), (error) => error.code === 'CIDR_AUDIT_INVALID');
});

test('CIDR audit accepts regional address name reuse and still rejects duplicate regional identities', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const address = (regionName, value) => {
    const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/${regionName}`;
    return {
      name: 'shared-static', address: value,
      addressType: 'EXTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
      status: 'RESERVED', region, selfLink: `${region}/addresses/shared-static`,
    };
  };
  const first = address('asia-east1', '203.0.113.1');
  const second = address('asia-east2', '203.0.113.2');
  const exact = {
    desired: '10.24.0.0/26', network,
    networks: [{ name: 'default', selfLink: network }],
    subnets: [], routes: [], addresses: [first, second],
  };

  assert.doesNotThrow(() => assertCidrAvailable(exact));
  assert.throws(() => assertCidrAvailable({
    ...exact,
    addresses: [first, { ...first, address: '203.0.113.3' }],
  }), (error) => error.code === 'CIDR_AUDIT_INVALID');
});

test('monitoring aggregation groups Cloud Run and Cloud SQL metrics by their real resource label', () => {
  assert.equal(monitoringGroupByField('run.googleapis.com/request_count'), 'resource.label.service_name');
  assert.equal(monitoringGroupByField('cloudsql.googleapis.com/database/cpu/utilization'), 'resource.label.database_id');
  assert.throws(() => monitoringGroupByField('unknown.googleapis.com/metric'), /unsupported monitoring metric/);
});

test('log alert policies use official event contracts and validate each filter read-only before policy creation', async (t) => {
  const contract = await contractFixture();
  for (const [policyId, filter] of Object.entries(OFFICIAL_LOG_FILTERS)) {
    await t.test(policyId, async () => {
      const requests = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => {
          requests.push(input);
          if (input.url === 'https://logging.googleapis.com/v2/entries:list') return {};
          if (input.url === `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`) {
            return { name: `projects/${PROJECT}/alertPolicies/1` };
          }
          throw new Error('unexpected request');
        },
      });
      await plane.create(`monitoring-policy:${policyId}`, { notificationChannel: CHANNEL });
      assert.deepEqual(requests, [
        {
          method: 'POST', url: 'https://logging.googleapis.com/v2/entries:list',
          body: {
            resourceNames: [`projects/${PROJECT}`], filter, pageSize: 1,
            orderBy: 'timestamp desc',
          },
        },
        {
          method: 'POST', url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`,
          body: requests[1].body,
        },
      ]);
      assert.equal(requests[1].body.conditions[0].conditionMatchedLog.filter, filter);
    });
  }

  await t.test('unverifiable Logging filter stops before Monitoring mutation', async () => {
    const requests = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        const error = new Error('invalid logging filter');
        error.code = 'BAD_REQUEST';
        throw error;
      },
    });
    await assert.rejects(
      () => plane.create('monitoring-policy:sql-backup-failure', { notificationChannel: CHANNEL }),
      (error) => error.code === 'MONITORING_LOG_FILTER_UNVERIFIED',
    );
    assert.deepEqual(requests.map(({ url }) => url), ['https://logging.googleapis.com/v2/entries:list']);
  });

  await t.test('metric descriptor lookup preserves the canonical metric path before policy creation', async () => {
    for (const policy of contract.resources.monitoring.policies.filter(({ metricType }) => metricType)) {
      const requests = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => {
          requests.push(input);
          if (input.url === `https://monitoring.googleapis.com/v3/projects/${PROJECT}/metricDescriptors/${policy.metricType}`) {
            return { type: policy.metricType };
          }
          if (input.url === `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`) {
            return { name: `projects/${PROJECT}/alertPolicies/1` };
          }
          throw new Error('unexpected request');
        },
      });

      await plane.create(`monitoring-policy:${policy.id}`, { notificationChannel: CHANNEL });
      assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
        {
          method: 'GET',
          url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/metricDescriptors/${policy.metricType}`,
        },
        {
          method: 'POST',
          url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`,
        },
      ]);
    }
  });

  await t.test('metric descriptor identity mismatch stops before Monitoring mutation', async () => {
    const requests = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        return { type: 'run.googleapis.com/not-the-requested-metric' };
      },
    });
    await assert.rejects(
      () => plane.create('monitoring-policy:run-5xx-ratio', { notificationChannel: CHANNEL }),
      (error) => error.code === 'MONITORING_METRIC_DESCRIPTOR_UNVERIFIED',
    );
    assert.equal(requests.some(({ url }) => url.endsWith('/alertPolicies')), false);
  });
});

test('monitoring policy identity matches the marker-or-display-name union before create', async (t) => {
  const contract = await contractFixture();
  const definition = contract.resources.monitoring.policies.find(({ id }) => id === 'sql-backup-failure');

  await t.test('an unlabelled fixed-name policy is drift, never absence', async () => {
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async () => ({ alertPolicies: [{ displayName: definition.displayName }] }),
    });
    assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
      status: 'present', value: { exact: false },
    });
  });

  await t.test('one exact labelled policy plus an unlabelled fixed-name duplicate is drift', async () => {
    const exactPolicy = {
      displayName: definition.displayName,
      combiner: 'OR', enabled: true, notificationChannels: [CHANNEL],
      userLabels: {
        application: 'hong_kong_buddy', environment: 'production_v1',
        hkbuddy_contract: 'sql_backup_failure',
      },
      conditions: [{
        displayName: definition.displayName,
        conditionMatchedLog: { filter: definition.filter },
      }],
      alertStrategy: {
        notificationRateLimit: { period: '300s' }, autoClose: '604800s',
      },
    };
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async () => ({ alertPolicies: [
        exactPolicy, { displayName: definition.displayName },
      ] }),
    });
    assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
      status: 'present', value: { exact: false },
    });
  });
});

test('Monitoring REST readbacks bind generated IDs to canonical project-ID parents and ownership markers', async (t) => {
  const contract = await contractFixture();
  const definition = contract.resources.monitoring.policies.find(({ id }) => id === 'sql-backup-failure');
  const exactPolicy = {
    name: `projects/${PROJECT}/alertPolicies/123456789`,
    displayName: definition.displayName,
    combiner: 'OR', enabled: true, notificationChannels: [CHANNEL],
    userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'sql_backup_failure' },
    conditions: [{ displayName: definition.displayName, conditionMatchedLog: { filter: definition.filter } }],
    alertStrategy: { notificationRateLimit: { period: '300s' }, autoClose: '604800s' },
  };
  const channel = {
    name: CHANNEL, displayName: 'HK Buddy V1 operations', type: 'email', enabled: true,
    verificationStatus: 'VERIFIED', labels: { email_address: 'admin@motionexp.com' },
    userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
  };
  const exactBudget = {
    name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/123456789`,
    displayName: 'Hong Kong Buddy Production V1 monthly guard',
    budgetFilter: {
      projects: [ASSET_PROJECT], calendarPeriod: 'MONTH',
      creditTypesTreatment: 'INCLUDE_ALL_CREDITS',
    },
    amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
    thresholdRules: [
      { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
    ],
    notificationsRule: { monitoringNotificationChannels: [CHANNEL] },
  };

  await t.test('alert policy', async () => {
    for (const [name, expected] of [
      [exactPolicy.name, true],
      [`projects/999999999999/alertPolicies/123456789`, false],
    ]) {
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async () => ({ alertPolicies: [{ ...exactPolicy, name }] }),
      });
      assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
        status: 'present', value: { exact: expected },
      });
    }
  });

  await t.test('alert policy accepts the project-ID parent returned by Monitoring REST', async () => {
    const plane = new GcpControlPlane({
      contract,
      notificationChannel: PROJECT_ID_CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async () => ({
        alertPolicies: [{
          ...exactPolicy,
          name: `projects/${PROJECT}/alertPolicies/123456789`,
          notificationChannels: [PROJECT_ID_CHANNEL],
        }],
      }),
    });
    assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
      status: 'present', value: { exact: true },
    });
  });

  await t.test('notification channel', async () => {
    for (const [value, expected] of [
      [channel, true],
      [{ ...channel, displayName: 'HK Buddy V1 foreign operations' }, false],
      [{ ...channel, userLabels: { ...channel.userLabels, hkbuddy_contract: 'foreign' } }, false],
      [{ ...channel, labels: { email_address: 'attacker@example.test' } }, false],
    ]) {
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async () => value,
      });
      const readback = await plane.read('notification-channel', { notificationChannel: CHANNEL });
      assert.equal(readback.status, 'present');
      assert.equal(plane.compare('notification-channel', readback.value, { notificationChannel: CHANNEL }), expected);
    }
  });

  await t.test('budget', async () => {
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async (args) => {
        if (args[0] === 'projects') return { projectId: PROJECT, projectNumber: PROJECT_NUMBER };
        throw new Error('unexpected gcloud');
      },
      request: async () => ({ budgets: [{ ...exactBudget, name: `billingAccounts/FOREIGN/budgets/123456789` }] }),
    });
    await plane.read('project');
    assert.deepEqual(await plane.read('budget'), { status: 'present', value: { exact: false } });
  });
});

test('ensureExactResource is dry-run safe, reads after create, and fails closed on collision, drift, 403, or ambiguity', async (t) => {
  await t.test('dry run never creates', async () => {
    let creates = 0;
    const result = await ensureExactResource({
      id: 'vpc', mutate: false,
      read: async () => ({ status: 'absent' }),
      create: async () => { creates += 1; },
      compare: () => true,
    });
    assert.deepEqual(result, { id: 'vpc', status: 'planned' });
    assert.equal(creates, 0);
  });

  await t.test('confirmed create is followed by exact readback', async () => {
    let reads = 0;
    let creates = 0;
    const result = await ensureExactResource({
      id: 'vpc', mutate: true,
      read: async () => (++reads === 1 ? { status: 'absent' } : { status: 'present', value: { name: 'vpc' } }),
      create: async () => { creates += 1; },
      compare: (value) => value.name === 'vpc',
    });
    assert.deepEqual(result, { id: 'vpc', status: 'created' });
    assert.equal(reads, 2);
    assert.equal(creates, 1);
  });

  const failures = [
    ['403 is unknown', async () => ({ status: 'unknown', code: 'FORBIDDEN' }), async () => undefined, 'RESOURCE_STATE_UNKNOWN'],
    ['present drift', async () => ({ status: 'present', value: { name: 'other' } }), async () => undefined, 'RESOURCE_DRIFT'],
    ['collision', async () => ({ status: 'absent' }), async () => { const error = new Error('collision'); error.code = 'ALREADY_EXISTS'; throw error; }, 'RESOURCE_COLLISION'],
    ['ambiguous missing', (() => { let reads = 0; return async () => (++reads === 1 ? { status: 'absent' } : { status: 'absent' }); })(), async () => { throw Object.assign(new Error('transport lost'), { code: 'TRANSPORT_AMBIGUOUS' }); }, 'CREATE_RESULT_AMBIGUOUS'],
  ];
  for (const [name, read, create, code] of failures) {
    await t.test(name, async () => {
      await assert.rejects(
        () => ensureExactResource({ id: 'resource', mutate: true, read, create, compare: () => false }),
        (error) => error.code === code,
      );
    });
  }

  await t.test('ambiguous transport result is accepted only after exact readback', async () => {
    let reads = 0;
    const result = await ensureExactResource({
      id: 'resource', mutate: true,
      read: async () => (++reads === 1
        ? { status: 'absent' }
        : { status: 'present', value: { exact: true } }),
      create: async () => { throw Object.assign(new Error('response lost'), { code: 'TRANSPORT_AMBIGUOUS' }); },
      compare: (value) => value.exact === true,
    });
    assert.deepEqual(result, { id: 'resource', status: 'created-readback-recovered' });
  });

  await t.test('unknown HTTP conflict is never adopted through a concurrent exact readback', async () => {
    const target = `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases`;
    const payload = Buffer.from(JSON.stringify({
      error: {
        code: 409,
        message: 'redacted conflict',
        errors: [{ domain: 'global', reason: 'unknownConflict', message: 'redacted conflict' }],
      },
    }));
    const fixture = authenticatedResponse(target, {
      chunks: [payload], status: 409, contentLength: payload.length,
    });
    const request = authenticatedRequestFixture(async () => fixture.response);
    let reads = 0;

    await assert.rejects(
      () => ensureExactResource({
        id: 'database', mutate: true,
        read: async () => (++reads === 1
          ? { status: 'absent' }
          : { status: 'present', value: { exact: true } }),
        create: () => request({
          method: 'POST', url: target, body: { name: GCP_IDENTITY.database },
        }),
        compare: (value) => value.exact === true,
      }),
      (error) => error.code === 'HTTP_CONFLICT_AMBIGUOUS',
    );
    assert.equal(reads, 1);
  });

  await t.test('deterministic create failure is never hidden by a later exact readback', async () => {
    let reads = 0;
    await assert.rejects(
      () => ensureExactResource({
        id: 'resource', mutate: true,
        read: async () => (++reads === 1
          ? { status: 'absent' }
          : { status: 'present', value: { exact: true } }),
        create: async () => {
          throw Object.assign(new Error('terminal SQL operation failed'), { code: 'SQL_OPERATION_FAILED' });
        },
        compare: (value) => value.exact === true,
      }),
      (error) => error.code === 'SQL_OPERATION_FAILED',
    );
    assert.equal(reads, 1);
  });
});

test('final key audit uses project-explicit argv and rejects every user-managed service-account key', async () => {
  const contract = await contractFixture();
  const calls = [];
  await assertNoUserManagedServiceAccountKeys({
    contract,
    gcloud: async (args) => { calls.push(args); return []; },
  });
  assert.equal(calls.length, 5);
  assert.equal(calls.every((args) => args.includes('--managed-by=user')
    && args.includes(`--project=${PROJECT}`)), true);

  await assert.rejects(() => assertNoUserManagedServiceAccountKeys({
    contract,
    gcloud: async () => [{ name: 'projects/example/serviceAccounts/example/keys/1' }],
  }), (error) => error.code === 'USER_MANAGED_SERVICE_ACCOUNT_KEY');
});

test('custom role provisioning reads, creates, and compares the one-permission GA definition exactly', async () => {
  const calls = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
        return { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false };
      }
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'create') {
        return { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false };
      }
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });

  const id = 'custom-role:hkbuddyV1AcceptanceBucketMetadataReader';
  const readback = await plane.read(id);
  assert.deepEqual(readback, {
    status: 'present', value: { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false },
  });
  assert.equal(plane.compare(id, readback.value), true);
  assert.equal(plane.compare(id, {
    ...readback.value, includedPermissions: ['storage.buckets.get', 'storage.buckets.list'],
  }), false);
  assert.equal(plane.compare(id, { ...readback.value, stage: 'BETA' }), false);

  await plane.create(id);
  assert.deepEqual(calls[0], [
    'iam', 'roles', 'describe', ACCEPTANCE_BUCKET_METADATA_ROLE.id,
    `--project=${PROJECT}`, '--format=json',
  ]);
  assert.deepEqual(calls[1], [
    'iam', 'roles', 'create', ACCEPTANCE_BUCKET_METADATA_ROLE.id,
    `--project=${PROJECT}`,
    `--title=${ACCEPTANCE_BUCKET_METADATA_ROLE.title}`,
    `--description=${ACCEPTANCE_BUCKET_METADATA_ROLE.description}`,
    '--permissions=storage.buckets.get', '--stage=GA', '--format=json',
  ]);
});

function exactManagedIamPolicies(contract) {
  const scopes = [
    'project', `bucket:${GCP_IDENTITY.bucket}`, `bucket:${GCP_IDENTITY.buildSourceBucket}`,
    `repository:${GCP_IDENTITY.repository}`,
    ...contract.resources.secrets.map(({ id }) => `secret:${id}`),
    ...contract.resources.serviceAccounts.map(({ id }) => `service-account:${id}`),
  ];
  const policies = Object.fromEntries(scopes.map((scope) => [scope, { bindings: [] }]));
  for (const binding of contract.iam.bindings) {
    policies[binding.scope].bindings.push({
      role: binding.role,
      members: [binding.member.replace('__PROJECT_NUMBER__', PROJECT_NUMBER)],
    });
  }
  for (const binding of contract.project.protectedBindings) {
    policies.project.bindings.push({ role: binding.role, members: [binding.member] });
  }
  policies.project.bindings.push({
    role: contract.iam.operatorBucketIamBinding.role,
    members: [contract.iam.operatorBucketIamBinding.member],
    condition: clone(contract.iam.operatorBucketIamBinding.condition),
  });
  policies.project.bindings.push({
    role: contract.iam.operatorReleaseEvidenceIamBinding.role,
    members: [contract.iam.operatorReleaseEvidenceIamBinding.member],
    condition: clone(contract.iam.operatorReleaseEvidenceIamBinding.condition),
  });
  for (const binding of contract.iam.automaticProjectBindings) {
    policies.project.bindings.push({
      role: binding.role,
      members: [binding.member.replace('__PROJECT_NUMBER__', PROJECT_NUMBER)],
    });
  }
  for (const policy of Object.values(policies)) {
    policy.bindings = policy.bindings.filter((binding, index, bindings) => (
      bindings.findIndex((candidate) => candidate.role === binding.role
        && JSON.stringify(candidate.members) === JSON.stringify(binding.members)) === index
    ));
  }
  return policies;
}

test('managed IAM final readback is an exact per-scope allowlist and forbids workload token creation', async (t) => {
  const contract = await contractFixture();
  const exactPolicies = exactManagedIamPolicies(contract);
  const allEnabledApis = new Set(AUTOMATIC_BINDING_APIS);
  assert.doesNotThrow(() => assertExactManagedIamPolicies({
    contract, projectNumber: PROJECT_NUMBER, policiesByScope: exactPolicies,
    enabledApis: allEnabledApis,
  }));

  await t.test('pure IAM assertions require an explicit enabled API set', () => {
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: exactPolicies,
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });
  const realEmptyPolicyShape = clone(exactPolicies);
  delete realEmptyPolicyShape[`secret:${GCP_IDENTITY.secrets.bootstrap}`].bindings;
  assert.doesNotThrow(() => assertExactManagedIamPolicies({
    contract, projectNumber: PROJECT_NUMBER, policiesByScope: realEmptyPolicyShape,
    enabledApis: allEnabledApis,
  }));

  const runtime = `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`;
  const deployer = `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`;
  const cases = [
    ['project TokenCreator', 'project', { role: 'roles/iam.serviceAccountTokenCreator', members: [runtime] }],
    ['project Cloud SQL client', 'project', { role: 'roles/cloudsql.client', members: [runtime] }],
    ['bucket storage admin', `bucket:${GCP_IDENTITY.bucket}`, { role: 'roles/storage.admin', members: [runtime] }],
    ['wrong secret access', `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}`, { role: 'roles/secretmanager.secretAccessor', members: [runtime] }],
    ['repository writer', `repository:${GCP_IDENTITY.repository}`, { role: 'roles/artifactregistry.writer', members: [runtime] }],
    ['SA TokenCreator', 'service-account:hkbuddy-v1-runtime', { role: 'roles/iam.serviceAccountTokenCreator', members: [deployer] }],
    ['public secret access', `secret:${GCP_IDENTITY.secrets.session}`, { role: 'roles/secretmanager.secretAccessor', members: ['allUsers'] }],
    ['external secret access', `secret:${GCP_IDENTITY.secrets.session}`, { role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:foreign@example.test'] }],
    ['external bucket access', `bucket:${GCP_IDENTITY.bucket}`, { role: 'roles/storage.objectViewer', members: ['user:foreign@example.test'] }],
    ['external repository access', `repository:${GCP_IDENTITY.repository}`, { role: 'roles/artifactregistry.reader', members: ['serviceAccount:foreign@example.test'] }],
    ['external SA impersonation', 'service-account:hkbuddy-v1-runtime', { role: 'roles/iam.serviceAccountUser', members: ['user:foreign@example.test'] }],
    ['external project access', 'project', { role: 'roles/viewer', members: ['user:foreign@example.test'] }],
    ['unexpected Google agent role', 'project', { role: 'roles/editor', members: [`serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com`] }],
    ['legacy Google APIs agent Editor', 'project', { role: 'roles/editor', members: [`serviceAccount:${PROJECT_NUMBER}@cloudservices.gserviceaccount.com`] }],
  ];
  for (const [name, scope, unexpected] of cases) {
    await t.test(name, () => {
      const policies = clone(exactPolicies);
      policies[scope].bindings.push(unexpected);
      assert.throws(
        () => assertExactManagedIamPolicies({
          contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies, enabledApis: allEnabledApis,
        }),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
    });
  }

  await t.test('missing service-agent impersonation binding is rejected', () => {
    const policies = clone(exactPolicies);
    policies['service-account:hkbuddy-v1-build'].bindings = [];
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies, enabledApis: allEnabledApis,
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('missing automatic Cloud Build project grant is rejected', () => {
    const policies = clone(exactPolicies);
    policies.project.bindings = policies.project.bindings.filter(({ role }) => (
      role !== 'roles/cloudbuild.serviceAgent'
    ));
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies, enabledApis: allEnabledApis,
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('required creator owner binding is exact', () => {
    const policies = clone(exactPolicies);
    policies.project.bindings = policies.project.bindings.filter(({ role }) => role !== 'roles/owner');
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies, enabledApis: allEnabledApis,
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  for (const [name, mutate] of [
    ['missing resource service guard', (binding) => {
      binding.condition.expression = binding.condition.expression.replace(
        'resource.service == "storage.googleapis.com" && ', '',
      );
    }],
    ['wider bucket prefix', (binding) => {
      binding.condition.expression = 'resource.name.startsWith("projects/_/buckets/hkbuddy-v1-")';
    }],
    ['equivalent alternate expression', (binding) => {
      binding.condition.expression = `resource.service == "storage.googleapis.com" && resource.type == "storage.googleapis.com/Bucket" && resource.name in ["projects/_/buckets/${GCP_IDENTITY.bucket}", "projects/_/buckets/${GCP_IDENTITY.buildSourceBucket}"]`;
    }],
    ['title drift', (binding) => { binding.condition.title = 'Equivalent title'; }],
    ['description drift', (binding) => { binding.condition.description = 'Equivalent description'; }],
    ['extra member', (binding) => { binding.members.push('user:foreign@example.test'); }],
    ['unconditional grant', (binding) => { delete binding.condition; }],
  ]) {
    await t.test(`operator bucket IAM condition rejects ${name}`, () => {
      const policies = clone(exactPolicies);
      const binding = policies.project.bindings.find(({ role }) => (
        role === BUCKET_IAM_OPERATOR_ROLE.name
      ));
      mutate(binding);
      assert.throws(
        () => assertExactManagedIamPolicies({
          contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies,
          enabledApis: allEnabledApis,
        }),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
    });
  }

  await t.test('operator bucket IAM condition rejects a duplicate grant', () => {
    const policies = clone(exactPolicies);
    const binding = policies.project.bindings.find(({ role }) => (
      role === BUCKET_IAM_OPERATOR_ROLE.name
    ));
    policies.project.bindings.push(clone(binding));
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies,
        enabledApis: allEnabledApis,
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('all immutable shared-project baseline bindings are exact and allowed', () => {
    for (const { member, role } of contract.project.protectedBindings) {
      const policies = clone(exactPolicies);
      policies.project.bindings = policies.project.bindings.filter((binding) => (
        binding.role !== role || !binding.members.includes(member)
      ));
      assert.throws(
        () => assertExactManagedIamPolicies({
          contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies, enabledApis: allEnabledApis,
        }),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
    }
  });

  await t.test('optional service-agent bindings are rejected before their owning API is enabled', () => {
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: exactPolicies,
        enabledApis: new Set(['cloudbuild.googleapis.com']),
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('Cloud Build dependency agents are allowed only with their exact enabled APIs', () => {
    const policy = { bindings: [
      ...contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
      {
        role: 'roles/containerregistry.ServiceAgent',
        members: [`serviceAccount:service-${PROJECT_NUMBER}@containerregistry.iam.gserviceaccount.com`],
      },
      {
        role: 'roles/pubsub.serviceAgent',
        members: [`serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com`],
      },
    ] };
    const input = {
      contract,
      projectNumber: PROJECT_NUMBER,
      policiesByScope: { project: policy },
      scopes: ['project'],
      requireProtectedBaseline: true,
    };
    assert.doesNotThrow(() => assertManagedIamPoliciesSubset({
      ...input,
      enabledApis: new Set(['containerregistry.googleapis.com', 'pubsub.googleapis.com']),
    }));
    assert.throws(
      () => assertManagedIamPoliciesSubset({
        ...input,
        enabledApis: new Set(['cloudbuild.googleapis.com']),
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('Container Analysis service agent is allowed only while its exact API is enabled', () => {
    const policy = { bindings: [
      ...contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
      {
        role: 'roles/containeranalysis.ServiceAgent',
        members: [`serviceAccount:service-${PROJECT_NUMBER}@container-analysis.iam.gserviceaccount.com`],
      },
    ] };
    const input = {
      contract,
      projectNumber: PROJECT_NUMBER,
      policiesByScope: { project: policy },
      scopes: ['project'],
      requireProtectedBaseline: true,
    };
    assert.doesNotThrow(() => assertManagedIamPoliciesSubset({
      ...input,
      enabledApis: new Set(['containeranalysis.googleapis.com']),
    }));
    assert.throws(
      () => assertManagedIamPoliciesSubset({
        ...input,
        enabledApis: new Set(['cloudbuild.googleapis.com']),
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('conditional managed binding is not exact', () => {
    const policies = clone(exactPolicies);
    policies.project.bindings[0].condition = { title: 'temporary', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' };
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies, enabledApis: allEnabledApis,
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });
});

test('pre-sensitive IAM subset audits reject foreign project owners and secret accessors', async (t) => {
  const contract = await contractFixture();
  for (const [name, projectOnly, policyFor] of [
    ['foreign project owner', true, (scope) => (scope === 'project' ? {
      bindings: [{ role: 'roles/owner', members: ['user:foreign@example.test'] }],
    } : { bindings: [] })],
    ['foreign secret accessor', false, (scope) => (scope === `secret:${GCP_IDENTITY.secrets.dbAppUrl}` ? {
      bindings: [{ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:foreign@example.test'] }],
    } : { bindings: [] })],
  ]) {
    await t.test(name, async () => {
      const gcloudCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => {
          gcloudCalls.push(args);
          if (args[0] === 'services' && args[1] === 'list') return enabledServiceRows([]);
          if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list') {
            return contract.resources.customRoles.map(liveCustomRoleListRow);
          }
          if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
            const role = contract.resources.customRoles.find(({ id }) => id === args[3]);
            if (!role) throw new Error('unexpected custom role describe');
            return { ...role, deleted: false };
          }
          let scope;
          if (args[0] === 'projects') scope = 'project';
          else if (args[0] === 'storage') scope = `bucket:${GCP_IDENTITY.bucket}`;
          else if (args[0] === 'artifacts') scope = `repository:${GCP_IDENTITY.repository}`;
          else if (args[0] === 'secrets') scope = `secret:${args[2]}`;
          else if (args[0] === 'iam') scope = `service-account:${args[3].split('@')[0]}`;
          else throw new Error('unexpected gcloud operation');
          return policyFor(scope);
        },
        request: async () => { throw new Error('REST must not run'); },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
      await assert.rejects(
        () => plane.auditManagedIamPolicies({ projectOnly }),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
      assert.equal(gcloudCalls.some((args) => args.some((arg) => /add-iam-policy-binding/.test(arg))), false);
    });
  }
});

test('post-baseline project IAM audits re-read enabled APIs before allowing dependency agents', async () => {
  const contract = await contractFixture();
  const dependencyPolicy = {
    bindings: [
      ...contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
      {
        role: 'roles/containerregistry.ServiceAgent',
        members: [`serviceAccount:service-${PROJECT_NUMBER}@containerregistry.iam.gserviceaccount.com`],
      },
      {
        role: 'roles/pubsub.serviceAgent',
        members: [`serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com`],
      },
    ],
  };
  let enabledApis = ['containerregistry.googleapis.com', 'pubsub.googleapis.com'];
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'services' && args[1] === 'list') {
        return enabledServiceRows(enabledApis);
      }
      if (args[0] === 'projects' && args[1] === 'get-iam-policy') return dependencyPolicy;
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

  await plane.auditManagedIamPolicies({ projectOnly: true });
  enabledApis = ['cloudbuild.googleapis.com'];
  await assert.rejects(
    () => plane.auditManagedIamPolicies({ projectOnly: true }),
    (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
  );
});

test('live IAM audits reject caller-supplied API snapshots instead of trusting stale authority', async () => {
  const contract = await contractFixture();
  const dependencyPolicy = {
    bindings: [
      ...contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
      {
        role: 'roles/containerregistry.ServiceAgent',
        members: [`serviceAccount:service-${PROJECT_NUMBER}@containerregistry.iam.gserviceaccount.com`],
      },
    ],
  };
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects' && args[1] === 'get-iam-policy') return dependencyPolicy;
      if (args[0] === 'services' && args[1] === 'list') throw new Error('Service Usage unavailable');
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

  await assert.rejects(
    () => plane.auditManagedIamPolicies({
      projectOnly: true,
      enabledApis: new Set(['containerregistry.googleapis.com']),
    }),
    (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
  );
});

test('enabled API inventory rejects malformed disabled contradictory or duplicate Service Usage rows', async (t) => {
  const contract = await contractFixture();
  const baselinePolicy = {
    bindings: contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
  };
  const exactName = 'containerregistry.googleapis.com';
  const exactResource = `projects/${PROJECT_NUMBER}/services/${exactName}`;
  const cases = [
    ['disabled', [{ config: { name: exactName }, name: exactResource, state: 'DISABLED' }]],
    ['missing state', [{ config: { name: exactName }, name: exactResource }]],
    ['wrong project', [{ config: { name: exactName }, name: `projects/999999999999/services/${exactName}`, state: 'ENABLED' }]],
    ['contradictory name', [{ config: { name: exactName }, name: `projects/${PROJECT_NUMBER}/services/pubsub.googleapis.com`, state: 'ENABLED' }]],
    ['non-string config name', [{ config: { name: null }, name: exactResource, state: 'ENABLED' }]],
    ['duplicate service', enabledServiceRows([exactName, exactName])],
  ];
  for (const [name, rows] of cases) {
    await t.test(name, async () => {
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => {
          if (args[0] === 'services' && args[1] === 'list') return rows;
          if (args[0] === 'projects' && args[1] === 'get-iam-policy') return baselinePolicy;
          throw new Error('unexpected gcloud operation');
        },
        request: async () => { throw new Error('REST must not run'); },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
      await assert.rejects(
        () => plane.auditManagedIamPolicies({ projectOnly: true }),
        (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
      );
    });
  }
});

test('IAM audit rejects an owning API state transition across the policy snapshot', async () => {
  const contract = await contractFixture();
  const dependencyPolicy = {
    bindings: [
      ...contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
      {
        role: 'roles/containerregistry.ServiceAgent',
        members: [`serviceAccount:service-${PROJECT_NUMBER}@containerregistry.iam.gserviceaccount.com`],
      },
    ],
  };
  let serviceRead = 0;
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'services' && args[1] === 'list') {
        serviceRead += 1;
        return enabledServiceRows(serviceRead === 1
          ? ['containerregistry.googleapis.com']
          : ['cloudbuild.googleapis.com']);
      }
      if (args[0] === 'projects' && args[1] === 'get-iam-policy') return dependencyPolicy;
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

  await assert.rejects(
    () => plane.auditManagedIamPolicies({ projectOnly: true }),
    (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
  );
});

test('pre-mutation audit rejects an older API snapshot even when the IAM bracket is stable', async () => {
  const contract = await contractFixture();
  const fixture = assetAuditControlPlane({ contract, assets: [] });
  const originalGcloud = fixture.plane.gcloud;
  let serviceRead = 0;
  fixture.plane.gcloud = async (args, options) => {
    if (args[0] === 'services' && args[1] === 'list') {
      serviceRead += 1;
      return enabledServiceRows(serviceRead === 1
        ? ['iam.googleapis.com']
        : ['iam.googleapis.com', 'compute.googleapis.com']);
    }
    return originalGcloud(args, options);
  };

  await assert.rejects(
    () => fixture.plane.auditPreMutationState(),
    (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
  );
  assert.equal(serviceRead, 3);
  assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable')
    || args.includes('create') || args.includes('add-iam-policy-binding')), false);
});

test('pre-mutation audit skips database and users only when the SQL parent is proven absent', async (t) => {
  const contract = await contractFixture();

  await t.test('absent SQL instance skips every strict SQL descendant and performs zero mutation', async () => {
    const fixture = dependencyAuditControlPlane({
      contract,
      enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'sqladmin.googleapis.com'],
      cloudSqlState: 'absent',
    });

    assert.equal(await fixture.plane.auditPreMutationState(), true);
    assert.equal(fixture.gcloudCalls.some((args) => (
      args[0] === 'sql' && args[1] === 'databases' && args[2] === 'list'
    )), false);
    assert.equal(fixture.restCalls.some(({ url }) => url.includes('/users')), false);
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
    assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
  });

  await t.test('present SQL instance still reads the database and its 403 fails closed', async () => {
    const fixture = dependencyAuditControlPlane({
      contract,
      enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'sqladmin.googleapis.com'],
      cloudSqlState: 'present',
      databaseForbidden: true,
    });

    await assert.rejects(
      () => fixture.plane.auditPreMutationState(),
      (error) => error.code === 'RESOURCE_STATE_UNKNOWN',
    );
    assert.equal(fixture.gcloudCalls.filter((args) => (
      args[0] === 'sql' && args[1] === 'databases' && args[2] === 'list'
    )).length, 1);
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  });
});

test('pre-mutation audit reads a secret version only when its exact container is present', async (t) => {
  const contract = await contractFixture();
  const target = GCP_IDENTITY.secrets.session;

  await t.test('absent container skips its strict version descendant', async () => {
    const fixture = dependencyAuditControlPlane({
      contract,
      enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'secretmanager.googleapis.com'],
    });

    assert.equal(await fixture.plane.auditPreMutationState(), true);
    assert.equal(fixture.restCalls.some(({ url }) => url.includes(`/secrets/${target}/versions`)), false);
  });

  await t.test('present container still reads its version', async () => {
    const fixture = dependencyAuditControlPlane({
      contract,
      enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'secretmanager.googleapis.com'],
      secretStates: { [target]: 'present' },
    });

    assert.equal(await fixture.plane.auditPreMutationState(), true);
    assert.equal(fixture.restCalls.filter(({ url }) => url.includes(`/secrets/${target}/versions`)).length, 1);
  });
});

test('pre-mutation audit carries exact database secret versions into the bootstrap receipt comparison', async () => {
  const contract = await contractFixture();
  const secretIds = [
    GCP_IDENTITY.secrets.dbAppUrl,
    GCP_IDENTITY.secrets.dbMigratorUrl,
    GCP_IDENTITY.secrets.session,
    GCP_IDENTITY.secrets.bootstrap,
  ];
  const fixture = dependencyAuditControlPlane({
    contract,
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'secretmanager.googleapis.com'],
    secretStates: Object.fromEntries(secretIds.map((id) => [id, 'present'])),
  });
  const originalRead = fixture.plane.read.bind(fixture.plane);
  const originalCompare = fixture.plane.compare.bind(fixture.plane);
  fixture.plane.read = async (id, context) => {
    if (id.startsWith('secret-version:') && secretIds.includes(id.slice('secret-version:'.length))) {
      return { status: 'present', value: { version: '1', secretValue: 'fixture', exact: true } };
    }
    return originalRead(id, context);
  };
  fixture.plane.compare = (id, value, context) => {
    if (id === `secret-version:${GCP_IDENTITY.secrets.bootstrap}`) {
      return context.secretVersions?.[GCP_IDENTITY.secrets.dbAppUrl] === '1'
        && context.secretVersions?.[GCP_IDENTITY.secrets.dbMigratorUrl] === '1';
    }
    if (id.startsWith('secret-version:') && secretIds.includes(id.slice('secret-version:'.length))) {
      return true;
    }
    return originalCompare(id, value, context);
  };

  assert.equal(await fixture.plane.auditPreMutationState(), true);
  assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
  assert.equal(fixture.gcloudCalls.some((args) => (
    args.includes('create') || args.includes('enable') || args.includes('add-iam-policy-binding')
  )), false);
});

test('pre-mutation audit rejects a bootstrap receipt when either database secret version is absent', async (t) => {
  const contract = await contractFixture();
  const appSecret = GCP_IDENTITY.secrets.dbAppUrl;
  const migratorSecret = GCP_IDENTITY.secrets.dbMigratorUrl;
  const bootstrapSecret = GCP_IDENTITY.secrets.bootstrap;
  for (const missingSecret of [appSecret, migratorSecret]) {
    await t.test(missingSecret, async () => {
      const secretIds = [appSecret, migratorSecret, bootstrapSecret];
      const fixture = dependencyAuditControlPlane({
        contract,
        enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'secretmanager.googleapis.com'],
        secretStates: Object.fromEntries(secretIds.map((id) => [id, 'present'])),
      });
      const bootstrapReceipt = {
        schemaVersion: 1,
        projectId: PROJECT,
        instance: GCP_IDENTITY.cloudSqlInstance,
        database: GCP_IDENTITY.database,
        appUser: 'hkbuddy_app',
        ...(missingSecret === appSecret ? {} : { appSecretVersion: '1' }),
        migratorUser: 'hkbuddy_migrator',
        ...(missingSecret === migratorSecret ? {} : { migratorSecretVersion: '1' }),
        appDatabaseRoles: ['pg_read_all_data', 'pg_write_all_data'],
        migratorDatabaseRoles: ['cloudsqlsuperuser'],
      };
      const originalRead = fixture.plane.read.bind(fixture.plane);
      const originalCompare = fixture.plane.compare.bind(fixture.plane);
      fixture.plane.read = async (id, context) => {
        if (id === `secret-version:${missingSecret}`) return { status: 'absent' };
        if (id === `secret-version:${appSecret}` || id === `secret-version:${migratorSecret}`) {
          return { status: 'present', value: { version: '1', secretValue: 'fixture', exact: true } };
        }
        if (id === `secret-version:${bootstrapSecret}`) {
          return {
            status: 'present',
            value: { version: '1', secretValue: JSON.stringify(bootstrapReceipt), exact: true },
          };
        }
        return originalRead(id, context);
      };
      fixture.plane.compare = (id, value, context) => {
        if (id === `secret-version:${appSecret}` || id === `secret-version:${migratorSecret}`) {
          return true;
        }
        return originalCompare(id, value, context);
      };

      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_COLLISION',
      );
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
      assert.equal(fixture.gcloudCalls.some((args) => (
        args.includes('create') || args.includes('enable') || args.includes('add-iam-policy-binding')
      )), false);
    });
  }
});

test('pre-mutation secret inventory accepts the live numeric project resource name without mutation', async () => {
  const contract = await contractFixture();
  const target = GCP_IDENTITY.secrets.dbAppUrl;
  const fixture = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'secretmanager.googleapis.com'],
    gcloudRows: {
      [`secrets list --project=${PROJECT}`]: [{
        name: `projects/${PROJECT_NUMBER}/secrets/${target}`,
        replication: { automatic: {} },
        labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
      }],
    },
  });

  assert.equal(await fixture.plane.auditPreMutationState(), true);
  assert.equal(fixture.gcloudCalls.some((args) => (
    args.includes('create') || args.includes('enable') || args.includes('add-iam-policy-binding')
  )), false);
  assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('pre-mutation secret inventory rejects noncanonical parents and duplicate rows before mutation', async (t) => {
  const contract = await contractFixture();
  const target = GCP_IDENTITY.secrets.dbAppUrl;
  const exactSecret = {
    name: `projects/${PROJECT_NUMBER}/secrets/${target}`,
    replication: { automatic: {} },
    labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
  };
  for (const [name, secrets] of [
    ['project ID parent', [{ ...exactSecret, name: `projects/${PROJECT}/secrets/${target}` }]],
    ['foreign numeric parent', [{ ...exactSecret, name: `projects/999999999999/secrets/${target}` }]],
    ['malformed descendant', [{ ...exactSecret, name: `${exactSecret.name}/versions/1` }]],
    ['duplicate exact row', [exactSecret, { ...exactSecret }]],
  ]) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract,
        assets: [],
        enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'secretmanager.googleapis.com'],
        gcloudRows: { [`secrets list --project=${PROJECT}`]: secrets },
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
      );
      assert.equal(fixture.gcloudCalls.some((args) => (
        args.includes('create') || args.includes('enable') || args.includes('add-iam-policy-binding')
      )), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('pre-mutation audit skips VPC descendants but still reads the independent PSA range', async () => {
  const contract = await contractFixture();
  const fixture = dependencyAuditControlPlane({
    contract,
    enabledApis: [
      'iam.googleapis.com', 'serviceusage.googleapis.com',
      'compute.googleapis.com', 'servicenetworking.googleapis.com',
    ],
  });

  assert.equal(await fixture.plane.auditPreMutationState(), true);
  assert.equal(fixture.gcloudCalls.some((args) => (
    args[0] === 'compute' && args[1] === 'networks' && args[2] === 'subnets'
      && args[3] === 'describe'
  )), false);
  assert.equal(fixture.gcloudCalls.some((args) => (
    args[0] === 'services' && args[1] === 'vpc-peerings' && args[2] === 'list'
  )), false);
  assert.equal(fixture.gcloudCalls.filter((args) => (
    args[0] === 'compute' && args[1] === 'addresses' && args[2] === 'describe'
  )).length, 1);
  assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
});

test('final readback rejects dependency agents after their owning APIs become disabled', async () => {
  const contract = await contractFixture();
  const exactPolicies = exactManagedIamPolicies(contract);
  const enabledApis = [
    'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'compute.googleapis.com',
    'servicenetworking.googleapis.com', 'sqladmin.googleapis.com', 'run.googleapis.com',
    'aiplatform.googleapis.com', 'speech.googleapis.com', 'monitoring.googleapis.com',
    'logging.googleapis.com',
  ];
  const policyFor = (args) => {
    if (args[0] === 'projects') return exactPolicies.project;
    if (args[0] === 'storage') return exactPolicies[`bucket:${args[3].slice('gs://'.length)}`];
    if (args[0] === 'artifacts') return exactPolicies[`repository:${args[3]}`];
    if (args[0] === 'secrets') return exactPolicies[`secret:${args[2]}`];
    if (args[0] === 'iam' && args[1] === 'service-accounts') {
      const account = contract.resources.serviceAccounts.find(({ email }) => email === args[3]);
      return exactPolicies[`service-account:${account?.id}`];
    }
    throw new Error('unexpected IAM policy operation');
  };
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'services' && args[1] === 'list') {
        return enabledServiceRows(enabledApis);
      }
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list') {
        return contract.resources.customRoles.map(liveCustomRoleListRow);
      }
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
        const role = contract.resources.customRoles.find(({ id }) => id === args[3]);
        if (!role) throw new Error('unexpected custom role describe');
        return { ...role, deleted: false };
      }
      if (args.includes('get-iam-policy')) return policyFor(args);
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  plane.auditUserManagedServiceAccountKeys = async () => undefined;
  plane.read = async () => ({ status: 'present', value: { exact: true } });
  plane.compare = () => true;

  await assert.rejects(
    () => plane.finalReadback({
      notificationChannel: CHANNEL,
      secretVersions: {
        [GCP_IDENTITY.secrets.dbAppUrl]: '1',
        [GCP_IDENTITY.secrets.dbMigratorUrl]: '1',
        [GCP_IDENTITY.secrets.session]: '1',
        [GCP_IDENTITY.secrets.bootstrap]: '1',
      },
    }),
    (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
  );
});

test('final readback ends with a stable API-bracketed exact IAM decision', async () => {
  const contract = await contractFixture();
  const exactPolicies = exactManagedIamPolicies(contract);
  let serviceRead = 0;
  const policyFor = (args) => {
    if (args[0] === 'projects') return exactPolicies.project;
    if (args[0] === 'storage') return exactPolicies[`bucket:${args[3].slice('gs://'.length)}`];
    if (args[0] === 'artifacts') return exactPolicies[`repository:${args[3]}`];
    if (args[0] === 'secrets') return exactPolicies[`secret:${args[2]}`];
    if (args[0] === 'iam' && args[1] === 'service-accounts') {
      const account = contract.resources.serviceAccounts.find(({ email }) => email === args[3]);
      return exactPolicies[`service-account:${account?.id}`];
    }
    throw new Error('unexpected IAM policy operation');
  };
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'services' && args[1] === 'list') {
        serviceRead += 1;
        return enabledServiceRows(serviceRead === 1
          ? AUTOMATIC_BINDING_APIS
          : AUTOMATIC_BINDING_APIS.filter((name) => ![
            'containerregistry.googleapis.com', 'pubsub.googleapis.com',
          ].includes(name)));
      }
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list') {
        return contract.resources.customRoles.map(liveCustomRoleListRow);
      }
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
        const role = contract.resources.customRoles.find(({ id }) => id === args[3]);
        if (!role) throw new Error('unexpected custom role describe');
        return { ...role, deleted: false };
      }
      if (args.includes('get-iam-policy')) return policyFor(args);
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  plane.auditUserManagedServiceAccountKeys = async () => undefined;
  plane.read = async () => ({ status: 'present', value: { exact: true } });
  plane.compare = () => true;

  await assert.rejects(
    () => plane.finalReadback({
      notificationChannel: CHANNEL,
      secretVersions: {
        [GCP_IDENTITY.secrets.dbAppUrl]: '1',
        [GCP_IDENTITY.secrets.dbMigratorUrl]: '1',
        [GCP_IDENTITY.secrets.session]: '1',
        [GCP_IDENTITY.secrets.bootstrap]: '1',
      },
    }),
    (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
  );
});

function liveCustomRoleListRow(role = ACCEPTANCE_BUCKET_METADATA_ROLE) {
  return {
    name: role.name,
    title: role.title,
    description: role.description,
    stage: role.stage,
    etag: 'BwYF9example',
  };
}

function customRoleAuditFixture({
  contract,
  listedRoles = contract.resources.customRoles.map(liveCustomRoleListRow),
  describedRole = { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false },
  describeError = null,
}) {
  const gcloudCalls = [];
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'services' && args[1] === 'list') return enabledServiceRows([]);
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list') return clone(listedRoles);
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
        if (describeError) throw describeError;
        if (args[3] === ACCEPTANCE_BUCKET_METADATA_ROLE.id) return clone(describedRole);
        const role = contract.resources.customRoles.find(({ id }) => id === args[3]);
        if (!role) throw new Error(`unexpected custom role describe ${args[3]}`);
        return { ...clone(role), deleted: false };
      }
      if (args.includes('get-iam-policy')) return { bindings: [] };
      throw new Error(`unexpected gcloud operation ${args.join(' ')}`);
    },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  return { plane, gcloudCalls };
}

function assertNoSensitiveGcloudMutation(calls) {
  assert.equal(calls.some((args) => args.some((arg) => [
    'create', 'update', 'delete', 'undelete', 'enable',
    'add-iam-policy-binding', 'remove-iam-policy-binding', 'set-iam-policy',
  ].includes(arg))), false);
}

test('pre-sensitive managed IAM audit accepts the live list projection and describes the exact role on every run', async () => {
  const contract = await contractFixture();
  const fixture = customRoleAuditFixture({ contract });

  await fixture.plane.auditManagedIamPolicies({ projectOnly: false });
  await fixture.plane.auditManagedIamPolicies({ projectOnly: false });

  const listCalls = fixture.gcloudCalls.filter((args) => (
    args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list'
  ));
  const describeCalls = fixture.gcloudCalls.filter((args) => (
    args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe'
  ));
  assert.deepEqual(listCalls, Array(2).fill([
    'iam', 'roles', 'list', '--show-deleted', `--project=${PROJECT}`, '--format=json',
  ]));
  assert.deepEqual(describeCalls, Array(2).fill(null).flatMap(() => ([
    [
      'iam', 'roles', 'describe', ACCEPTANCE_BUCKET_METADATA_ROLE.id,
      `--project=${PROJECT}`, '--format=json',
    ],
    [
      'iam', 'roles', 'describe', BUCKET_IAM_OPERATOR_ROLE.id,
      `--project=${PROJECT}`, '--format=json',
    ],
    [
      'iam', 'roles', 'describe', RELEASE_EVIDENCE_OPERATOR_ROLE.id,
      `--project=${PROJECT}`, '--format=json',
    ],
  ])));
  assertNoSensitiveGcloudMutation(fixture.gcloudCalls);
});

test('pre-sensitive managed IAM audit rejects non-exact role inventories before describe or mutation', async (t) => {
  const contract = await contractFixture();
  const exact = liveCustomRoleListRow();
  const operator = liveCustomRoleListRow(BUCKET_IAM_OPERATOR_ROLE);
  const releaseEvidence = liveCustomRoleListRow(RELEASE_EVIDENCE_OPERATOR_ROLE);
  const invalidInventories = [
    ['missing expected role', [operator, releaseEvidence]],
    ['duplicate expected role', [exact, { ...exact }, operator, releaseEvidence]],
    ['extra project role', [exact, operator, releaseEvidence, { ...exact, name: `projects/${PROJECT}/roles/unexpected` }]],
    ['foreign-project role', [{ ...exact, name: 'projects/foreign-project/roles/hkbuddyV1AcceptanceBucketMetadataReader' }, operator, releaseEvidence]],
    ['hidden deleted extra role', [exact, operator, releaseEvidence, {
      ...exact, name: `projects/${PROJECT}/roles/deletedUnexpected`, deleted: true,
    }]],
    ['deleted expected role', [{ ...exact, deleted: true }, operator, releaseEvidence]],
    ['ambiguous expected deleted state', [{ ...exact, deleted: 'false' }, operator, releaseEvidence]],
  ];

  for (const [name, listedRoles] of invalidInventories) {
    await t.test(name, async () => {
      const fixture = customRoleAuditFixture({ contract, listedRoles });
      await assert.rejects(
        () => fixture.plane.auditManagedIamPolicies({ projectOnly: false }),
        (error) => error.code === 'CUSTOM_ROLE_ALLOWLIST_MISMATCH',
      );
      assert.equal(fixture.gcloudCalls.some((args) => (
        args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe'
      )), false);
      assertNoSensitiveGcloudMutation(fixture.gcloudCalls);
    });
  }
});

test('pre-sensitive managed IAM audit fails closed on described definition drift or unreadable state', async (t) => {
  const contract = await contractFixture();
  const cases = [
    ['permission drift', {
      describedRole: {
        ...ACCEPTANCE_BUCKET_METADATA_ROLE,
        includedPermissions: ['storage.buckets.get', 'storage.buckets.list'],
        deleted: false,
      },
      code: 'CUSTOM_ROLE_ALLOWLIST_MISMATCH',
    }],
    ['forbidden describe', {
      describeError: Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }),
      code: 'FORBIDDEN',
    }],
    ['ambiguous describe', {
      describeError: Object.assign(new Error('ambiguous'), { code: 'TRANSPORT_AMBIGUOUS' }),
      code: 'TRANSPORT_AMBIGUOUS',
    }],
  ];

  for (const [name, { describedRole, describeError, code }] of cases) {
    await t.test(name, async () => {
      const fixture = customRoleAuditFixture({ contract, describedRole, describeError });
      await assert.rejects(
        () => fixture.plane.auditManagedIamPolicies({ projectOnly: false }),
        (error) => error.code === code,
      );
      assertNoSensitiveGcloudMutation(fixture.gcloudCalls);
    });
  }
});

function exactBucket({
  name = GCP_IDENTITY.bucket, projectNumber = GCP_IDENTITY.projectNumber,
  lifecycleDeleteAfterDays = 7,
} = {}) {
  return {
    name, projectNumber, location: 'ASIA-EAST2',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced',
    },
    versioning: { enabled: false },
    softDeletePolicy: { retentionDurationSeconds: '0' },
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: lifecycleDeleteAfterDays } }] },
  };
}

function exactBuildSourceBucket(overrides = {}) {
  return exactBucket({
    name: GCP_IDENTITY.buildSourceBucket,
    lifecycleDeleteAfterDays: 1,
    ...overrides,
  });
}

function storagePolicy({ bucket, bindings = [], etag = 'CAE=', includeBindings = true } = {}) {
  return {
    version: 1,
    kind: 'storage#policy',
    resourceId: `projects/_/buckets/${bucket}`,
    ...(includeBindings ? { bindings } : {}),
    etag,
  };
}

const DEFAULT_UNIFORM_BUCKET_TUPLES = Object.freeze([
  { role: 'roles/storage.legacyBucketOwner', member: `projectEditor:${PROJECT}` },
  { role: 'roles/storage.legacyBucketOwner', member: `projectOwner:${PROJECT}` },
  { role: 'roles/storage.legacyBucketReader', member: `projectViewer:${PROJECT}` },
  { role: 'roles/storage.legacyObjectOwner', member: `projectEditor:${PROJECT}` },
  { role: 'roles/storage.legacyObjectOwner', member: `projectOwner:${PROJECT}` },
  { role: 'roles/storage.legacyObjectReader', member: `projectViewer:${PROJECT}` },
]);

const EXPECTED_MEDIA_BUCKET_BINDINGS = Object.freeze([
  {
    role: `projects/${PROJECT}/roles/hkbuddyV1AcceptanceBucketMetadataReader`,
    members: [
      `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`,
      `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`,
    ],
  },
  {
    role: 'roles/storage.objectUser',
    members: [
      `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`,
      `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`,
    ],
  },
]);

const EXPECTED_BUILD_SOURCE_BUCKET_BINDINGS = Object.freeze([
  {
    role: 'roles/storage.objectCreator',
    members: ['user:admin@motionexp.com'],
  },
  {
    role: 'roles/storage.objectViewer',
    members: [`serviceAccount:${GCP_IDENTITY.serviceAccounts.build}`],
  },
]);

function groupBucketIamTuples(tuples) {
  const byRole = new Map();
  for (const { role, member } of tuples) {
    const members = byRole.get(role) ?? [];
    members.push(member);
    byRole.set(role, members);
  }
  return [...byRole.entries()]
    .map(([role, members]) => ({ role, members: [...members].sort() }))
    .sort((left, right) => left.role.localeCompare(right.role));
}

function defaultUniformBucketBindings() {
  return groupBucketIamTuples(DEFAULT_UNIFORM_BUCKET_TUPLES);
}

function operatorProjectPolicy(contract, {
  includeOperator = false, includeReleaseEvidence = false,
  etag = 'BwYAAAAAAAQ=', extraBindings = [], auditConfigs,
} = {}) {
  return {
    version: includeOperator || includeReleaseEvidence ? 3 : 1,
    etag,
    bindings: [
      ...contract.project.protectedBindings.map(({ role, member }) => ({
        role, members: [member],
      })),
      ...(includeOperator ? [{
        role: contract.iam.operatorBucketIamBinding.role,
        members: [contract.iam.operatorBucketIamBinding.member],
        condition: clone(contract.iam.operatorBucketIamBinding.condition),
      }] : []),
      ...(includeReleaseEvidence ? [{
        role: contract.iam.operatorReleaseEvidenceIamBinding.role,
        members: [contract.iam.operatorReleaseEvidenceIamBinding.member],
        condition: clone(contract.iam.operatorReleaseEvidenceIamBinding.condition),
      }] : []),
      ...extraBindings,
    ],
    ...(auditConfigs === undefined ? {} : { auditConfigs: clone(auditConfigs) }),
  };
}

function operatorBindingPlane({
  contract, policies, setResponse, permissionResponses = {}, bucketPolicies = {},
  enabledServices = [
    'cloudresourcemanager.googleapis.com', 'iam.googleapis.com', 'storage.googleapis.com',
  ],
  now = Date.now, sleep = async () => undefined,
}) {
  const gcloudCalls = [];
  const restCalls = [];
  const policyQueue = [...policies];
  const permissionQueues = Object.fromEntries(Object.entries(permissionResponses).map(
    ([bucket, responses]) => [bucket, [...responses]],
  ));
  let currentPolicy = policyQueue.at(-1);
  const plane = new GcpControlPlane({
    contract, now, sleep,
    gcloud: async (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'services' && args[1] === 'list') {
        return enabledServiceRows(enabledServices);
      }
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      restCalls.push(clone(input));
      if (input.url === `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`) {
        currentPolicy = policyQueue.length > 0 ? policyQueue.shift() : currentPolicy;
        return clone(currentPolicy);
      }
      if (input.url === `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:setIamPolicy`) {
        currentPolicy = setResponse instanceof Error ? currentPolicy : clone(setResponse);
        if (setResponse instanceof Error) throw setResponse;
        return clone(setResponse);
      }
      for (const bucket of [GCP_IDENTITY.bucket, GCP_IDENTITY.buildSourceBucket]) {
        const encoded = encodeURIComponent(bucket);
        if (input.url.startsWith(`https://storage.googleapis.com/storage/v1/b/${encoded}/iam/testPermissions?`)) {
          const queue = permissionQueues[bucket] ?? [];
          if (queue.length === 0) throw new Error(`missing permission response for ${bucket}`);
          const response = queue.shift();
          if (response instanceof Error) throw response;
          return clone(response);
        }
        if (input.url === `https://storage.googleapis.com/storage/v1/b/${encoded}/iam?optionsRequestedPolicyVersion=3`) {
          const response = bucketPolicies[bucket];
          if (response instanceof Error) throw response;
          return clone(response);
        }
      }
      throw new Error(`unexpected request ${input.method} ${input.url}`);
    },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  return { plane, gcloudCalls, restCalls };
}

test('operator bucket IAM project binding uses a version-3 etag transaction and exact condition', async () => {
  const contract = await contractFixture();
  const observed = operatorProjectPolicy(contract, { etag: 'BwYAAAAAAAQ=' });
  const final = operatorProjectPolicy(contract, {
    includeOperator: true, etag: 'BwYAAAAAAAg=',
  });
  const fixture = operatorBindingPlane({
    contract, policies: [observed, final], setResponse: final,
  });

  assert.deepEqual(await fixture.plane.read('operator-bucket-iam-binding'), { status: 'absent' });
  await fixture.plane.create('operator-bucket-iam-binding');
  const setCall = fixture.restCalls.find(({ url }) => url.endsWith(':setIamPolicy'));
  assert.deepEqual(setCall, {
    method: 'POST',
    url: `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:setIamPolicy`,
    body: {
      policy: {
        ...observed,
        version: 3,
        bindings: [
          ...observed.bindings,
          {
            role: BUCKET_IAM_OPERATOR_BINDING.role,
            members: [BUCKET_IAM_OPERATOR_BINDING.member],
            condition: clone(BUCKET_IAM_OPERATOR_BINDING.condition),
          },
        ],
      },
      updateMask: 'bindings,etag,version',
    },
  });
  assert.deepEqual(await fixture.plane.read('operator-bucket-iam-binding'), {
    status: 'present', value: { exact: true },
  });
  assert.equal(fixture.plane.compare('operator-bucket-iam-binding', { exact: true }), true);
  assert.equal(fixture.restCalls.filter(({ url }) => url.endsWith(':setIamPolicy')).length, 1);
  assert.deepEqual(
    fixture.restCalls.filter(({ url }) => url.endsWith(':getIamPolicy')).map(({ body }) => body),
    [
      { options: { requestedPolicyVersion: 3 } },
      { options: { requestedPolicyVersion: 3 } },
    ],
  );
});

test('operator bucket IAM project binding fails closed on condition drift or etag conflict', async (t) => {
  const contract = await contractFixture();
  const final = operatorProjectPolicy(contract, { includeOperator: true });
  for (const [name, mutate] of [
    ['alternate equivalent expression', (policy) => {
      policy.bindings.at(-1).condition.expression = `resource.service == "storage.googleapis.com" && resource.type == "storage.googleapis.com/Bucket" && resource.name in ["projects/_/buckets/${GCP_IDENTITY.bucket}", "projects/_/buckets/${GCP_IDENTITY.buildSourceBucket}"]`;
    }],
    ['extra member', (policy) => { policy.bindings.at(-1).members.push('user:foreign@example.test'); }],
    ['unconditional binding', (policy) => { delete policy.bindings.at(-1).condition; }],
    ['duplicate binding', (policy) => { policy.bindings.push(clone(policy.bindings.at(-1))); }],
  ]) {
    await t.test(name, async () => {
      const drifted = clone(final);
      mutate(drifted);
      const fixture = operatorBindingPlane({
        contract, policies: [drifted], setResponse: drifted,
      });
      await assert.rejects(
        () => fixture.plane.read('operator-bucket-iam-binding'),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
      assert.equal(fixture.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
    });
  }

  await t.test('etag conflict is never blind-retried', async () => {
    const observed = operatorProjectPolicy(contract);
    const etagConflict = Object.assign(new Error('etag changed'), {
      code: 'IAM_POLICY_ETAG_MISMATCH',
    });
    const fixture = operatorBindingPlane({
      contract, policies: [observed], setResponse: etagConflict,
    });
    assert.deepEqual(await fixture.plane.read('operator-bucket-iam-binding'), { status: 'absent' });
    await assert.rejects(
      () => fixture.plane.create('operator-bucket-iam-binding'),
      (error) => error.code === 'IAM_POLICY_ETAG_MISMATCH',
    );
    assert.equal(fixture.restCalls.filter(({ url }) => url.endsWith(':setIamPolicy')).length, 1);
  });
});

test('operator bucket IAM propagation polls exact permissions plus readable local policies with a deadline', async (t) => {
  const contract = await contractFixture();
  const permissions = [
    'storage.buckets.get', 'storage.buckets.getIamPolicy', 'storage.buckets.setIamPolicy',
  ];
  const permissionResponse = { kind: 'storage#testIamPermissionsResponse', permissions };
  let clock = 0;
  const fixture = operatorBindingPlane({
    contract,
    policies: [operatorProjectPolicy(contract, { includeOperator: true })],
    setResponse: operatorProjectPolicy(contract, { includeOperator: true }),
    permissionResponses: {
      [GCP_IDENTITY.bucket]: [
        { kind: 'storage#testIamPermissionsResponse', permissions: [] },
        permissionResponse,
      ],
      [GCP_IDENTITY.buildSourceBucket]: [permissionResponse, permissionResponse],
    },
    bucketPolicies: {
      [GCP_IDENTITY.bucket]: storagePolicy({ bucket: GCP_IDENTITY.bucket, bindings: [] }),
      [GCP_IDENTITY.buildSourceBucket]: storagePolicy({
        bucket: GCP_IDENTITY.buildSourceBucket,
        bindings: defaultUniformBucketBindings(), etag: 'CAI=',
      }),
    },
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  await fixture.plane.waitForOperatorBucketIamAccess({
    buckets: [GCP_IDENTITY.bucket, GCP_IDENTITY.buildSourceBucket],
  });
  assert.equal(clock > 0, true);
  assert.equal(fixture.restCalls.filter(({ url }) => url.includes('/iam/testPermissions?')).length, 3);
  assert.equal(fixture.restCalls.filter(({ url }) => url.includes('optionsRequestedPolicyVersion=3')).length, 2);

  await t.test('partial or extra permissions are never treated as propagation', async () => {
    const invalid = operatorBindingPlane({
      contract,
      policies: [operatorProjectPolicy(contract, { includeOperator: true })],
      setResponse: operatorProjectPolicy(contract, { includeOperator: true }),
      permissionResponses: {
        [GCP_IDENTITY.bucket]: [{
          kind: 'storage#testIamPermissionsResponse',
          permissions: ['storage.buckets.get', 'storage.buckets.getIamPolicy'],
        }],
      },
      now: () => 120_000,
      sleep: async () => undefined,
    });
    await assert.rejects(
      () => invalid.plane.waitForOperatorBucketIamAccess({ buckets: [GCP_IDENTITY.bucket] }),
      (error) => error.code === 'OPERATOR_BUCKET_IAM_PERMISSION_INVALID',
    );
  });
});

test('lost project IAM set response recovers only from exact readback and supports crash resume', async () => {
  const contract = await contractFixture();
  const observed = operatorProjectPolicy(contract, { etag: 'BwYAAAAAAAQ=' });
  const final = operatorProjectPolicy(contract, {
    includeOperator: true, etag: 'BwYAAAAAAAg=',
  });
  const responseLost = Object.assign(new Error('response lost'), { code: 'TRANSPORT_AMBIGUOUS' });
  const fixture = operatorBindingPlane({
    contract, policies: [observed, final], setResponse: responseLost,
  });
  let setApplied = false;
  const baseRequest = fixture.plane.request;
  fixture.plane.request = async (input) => {
    if (input.url.endsWith(':setIamPolicy')) {
      fixture.restCalls.push(clone(input));
      setApplied = true;
      throw responseLost;
    }
    if (input.url.endsWith(':getIamPolicy') && setApplied) return clone(final);
    return baseRequest(input);
  };
  const result = await ensureExactResource({
    id: 'operator-bucket-iam-binding', mutate: true,
    read: () => fixture.plane.read('operator-bucket-iam-binding'),
    create: () => fixture.plane.create('operator-bucket-iam-binding'),
    compare: (value) => fixture.plane.compare('operator-bucket-iam-binding', value),
  });
  assert.deepEqual(result, {
    id: 'operator-bucket-iam-binding', status: 'created-readback-recovered',
  });

  const resumed = operatorBindingPlane({
    contract, policies: [final], setResponse: final,
  });
  const resumedResult = await ensureExactResource({
    id: 'operator-bucket-iam-binding', mutate: true,
    read: () => resumed.plane.read('operator-bucket-iam-binding'),
    create: () => resumed.plane.create('operator-bucket-iam-binding'),
    compare: (value) => resumed.plane.compare('operator-bucket-iam-binding', value),
  });
  assert.deepEqual(resumedResult, {
    id: 'operator-bucket-iam-binding', status: 'unchanged',
  });
  assert.equal(resumed.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
});

test('release-evidence operator binding preserves the existing condition in one version-3 etag transaction', async () => {
  const contract = await contractFixture();
  const observed = operatorProjectPolicy(contract, {
    includeOperator: true, etag: 'BwYAAAAAAAQ=',
  });
  const final = operatorProjectPolicy(contract, {
    includeOperator: true, includeReleaseEvidence: true, etag: 'BwYAAAAAAAg=',
  });
  const fixture = operatorBindingPlane({
    contract, policies: [observed, final], setResponse: final,
  });

  assert.deepEqual(await fixture.plane.read('operator-release-evidence-iam-binding'), {
    status: 'absent',
  });
  await fixture.plane.create('operator-release-evidence-iam-binding');
  const setCall = fixture.restCalls.find(({ url }) => url.endsWith(':setIamPolicy'));
  assert.deepEqual(setCall.body, {
    policy: {
      ...observed,
      version: 3,
      bindings: [
        ...observed.bindings,
        {
          role: RELEASE_EVIDENCE_OPERATOR_BINDING.role,
          members: [RELEASE_EVIDENCE_OPERATOR_BINDING.member],
          condition: clone(RELEASE_EVIDENCE_OPERATOR_BINDING.condition),
        },
      ],
    },
    updateMask: 'bindings,etag,version',
  });
  const readback = await fixture.plane.read('operator-release-evidence-iam-binding');
  assert.equal(readback.status, 'present');
  assert.equal(fixture.plane.compare('operator-release-evidence-iam-binding', readback.value), true);
});

test('operator conditional IAM allowlist accepts either known binding as the only repair gap', async (t) => {
  const contract = await contractFixture();
  for (const [name, policy, step, expectedStatus] of [
    ['both absent', operatorProjectPolicy(contract), 'operator-release-evidence-iam-binding', 'absent'],
    ['release absent', operatorProjectPolicy(contract, { includeOperator: true }), 'operator-release-evidence-iam-binding', 'absent'],
    ['bucket absent', operatorProjectPolicy(contract, { includeReleaseEvidence: true }), 'operator-bucket-iam-binding', 'absent'],
    ['both present', operatorProjectPolicy(contract, {
      includeOperator: true, includeReleaseEvidence: true,
    }), 'operator-release-evidence-iam-binding', 'present'],
  ]) {
    await t.test(name, async () => {
      const fixture = operatorBindingPlane({ contract, policies: [policy], setResponse: policy });
      const state = await fixture.plane.read(step);
      assert.equal(state.status, expectedStatus);
      assert.equal(fixture.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
    });
  }
});

test('release-evidence conditional IAM rejects widened or malformed grants before policy write', async (t) => {
  const contract = await contractFixture();
  const exactPolicy = operatorProjectPolicy(contract, {
    includeOperator: true, includeReleaseEvidence: true,
  });
  const cases = [
    ['wrong member', (binding) => { binding.members = ['user:foreign@example.test']; }],
    ['wrong role', (binding) => { binding.role = 'roles/storage.objectAdmin'; }],
    ['wrong service', (binding) => { binding.condition.expression = binding.condition.expression.replace('storage.googleapis.com', 'run.googleapis.com'); }],
    ['wrong bucket type', (binding) => { binding.condition.expression = binding.condition.expression.replace('storage.googleapis.com/Bucket', 'storage.googleapis.com/Object'); }],
    ['wrong object type', (binding) => { binding.condition.expression = binding.condition.expression.replace('storage.googleapis.com/Object', 'storage.googleapis.com/Bucket'); }],
    ['foreign bucket', (binding) => { binding.condition.expression = binding.condition.expression.replaceAll(GCP_IDENTITY.bucket, 'foreign-bucket'); }],
    ['sibling prefix', (binding) => { binding.condition.expression = binding.condition.expression.replace('/objects/release-evidence/', '/objects/release-evidence-evil/'); }],
    ['missing trailing slash', (binding) => { binding.condition.expression = binding.condition.expression.replace('/objects/release-evidence/', '/objects/release-evidence'); }],
    ['duplicate binding', (_binding, policy) => { policy.bindings.push(clone(policy.bindings.at(-1))); }],
    ['unknown condition', (_binding, policy) => { policy.bindings.push({ role: 'roles/viewer', members: ['user:admin@motionexp.com'], condition: { title: 'unknown', description: 'unknown', expression: 'true' } }); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const policy = clone(exactPolicy);
      const binding = policy.bindings.find(({ role }) => role === RELEASE_EVIDENCE_OPERATOR_ROLE.name);
      mutate(binding, policy);
      const fixture = operatorBindingPlane({ contract, policies: [policy], setResponse: policy });
      await assert.rejects(
        () => fixture.plane.read('operator-release-evidence-iam-binding'),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
      assert.equal(fixture.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
    });
  }
});

test('lost release-evidence IAM write response requires full-policy readback preserving prior bindings', async (t) => {
  const contract = await contractFixture();
  const enabledServices = [
    'cloudresourcemanager.googleapis.com', 'containerregistry.googleapis.com',
    'iam.googleapis.com', 'storage.googleapis.com',
  ];
  const configuredBinding = clone(contract.iam.bindings.find(({ scope }) => scope === 'project'));
  delete configuredBinding.scope;
  const automaticDefinition = contract.iam.automaticProjectBindings.find(
    ({ role }) => role === 'roles/containerregistry.ServiceAgent',
  );
  const automaticBinding = {
    role: automaticDefinition.role,
    members: [automaticDefinition.member.replace('__PROJECT_NUMBER__', PROJECT_NUMBER)],
  };
  const auditConfigs = [{
    service: 'allServices',
    auditLogConfigs: [{ logType: 'DATA_READ', exemptedMembers: ['user:auditor@motionexp.com'] }],
  }];
  const preservedBindings = [
    { role: configuredBinding.role, members: [configuredBinding.member] },
    automaticBinding,
  ];
  const observed = operatorProjectPolicy(contract, {
    includeOperator: true, extraBindings: preservedBindings, auditConfigs,
  });
  const final = operatorProjectPolicy(contract, {
    includeOperator: true, includeReleaseEvidence: true, etag: 'BwYAAAAAAAg=',
    extraBindings: preservedBindings, auditConfigs,
  });
  const responseLost = Object.assign(new Error('response lost'), { code: 'TRANSPORT_AMBIGUOUS' });

  await t.test('exact full-policy recovery', async () => {
    const fixture = operatorBindingPlane({
      contract, policies: [observed], setResponse: responseLost, enabledServices,
    });
    let setApplied = false;
    const baseRequest = fixture.plane.request;
    fixture.plane.request = async (input) => {
      if (input.url.endsWith(':setIamPolicy')) {
        fixture.restCalls.push(clone(input));
        setApplied = true;
        throw responseLost;
      }
      if (input.url.endsWith(':getIamPolicy') && setApplied) return clone(final);
      return baseRequest(input);
    };
    const result = await ensureExactResource({
      id: 'operator-release-evidence-iam-binding', mutate: true,
      read: () => fixture.plane.read('operator-release-evidence-iam-binding'),
      create: () => fixture.plane.create('operator-release-evidence-iam-binding'),
      compare: (value) => fixture.plane.compare('operator-release-evidence-iam-binding', value),
    });
    assert.equal(result.status, 'created-readback-recovered');
  });

  await t.test('dropped prior condition is ambiguous', async () => {
    const droppedPrior = operatorProjectPolicy(contract, {
      includeReleaseEvidence: true, etag: 'BwYAAAAAAAg=',
      extraBindings: preservedBindings, auditConfigs,
    });
    const fixture = operatorBindingPlane({
      contract, policies: [observed], setResponse: responseLost, enabledServices,
    });
    let setApplied = false;
    const baseRequest = fixture.plane.request;
    fixture.plane.request = async (input) => {
      if (input.url.endsWith(':setIamPolicy')) {
        fixture.restCalls.push(clone(input));
        setApplied = true;
        throw responseLost;
      }
      if (input.url.endsWith(':getIamPolicy') && setApplied) return clone(droppedPrior);
      return baseRequest(input);
    };
    await assert.rejects(() => ensureExactResource({
      id: 'operator-release-evidence-iam-binding', mutate: true,
      read: () => fixture.plane.read('operator-release-evidence-iam-binding'),
      create: () => fixture.plane.create('operator-release-evidence-iam-binding'),
      compare: (value) => fixture.plane.compare('operator-release-evidence-iam-binding', value),
    }), (error) => error.code === 'CREATE_RESULT_AMBIGUOUS');
  });

  for (const [name, mutate] of [
    ['dropped configured binding', (policy) => {
      policy.bindings = policy.bindings.filter(({ role }) => role !== configuredBinding.role);
    }],
    ['dropped allowed automatic binding', (policy) => {
      policy.bindings = policy.bindings.filter(({ role }) => role !== automaticBinding.role);
    }],
    ['dropped audit config', (policy) => { delete policy.auditConfigs; }],
  ]) {
    await t.test(`${name} is ambiguous after a lost response`, async () => {
      const incomplete = clone(final);
      mutate(incomplete);
      const fixture = operatorBindingPlane({
        contract, policies: [observed], setResponse: responseLost, enabledServices,
      });
      let setApplied = false;
      const baseRequest = fixture.plane.request;
      fixture.plane.request = async (input) => {
        if (input.url.endsWith(':setIamPolicy')) {
          fixture.restCalls.push(clone(input));
          setApplied = true;
          throw responseLost;
        }
        if (input.url.endsWith(':getIamPolicy') && setApplied) return clone(incomplete);
        return baseRequest(input);
      };
      await assert.rejects(() => ensureExactResource({
        id: 'operator-release-evidence-iam-binding', mutate: true,
        read: () => fixture.plane.read('operator-release-evidence-iam-binding'),
        create: () => fixture.plane.create('operator-release-evidence-iam-binding'),
        compare: (value) => fixture.plane.compare('operator-release-evidence-iam-binding', value),
      }), (error) => error.code === 'CREATE_RESULT_AMBIGUOUS');
    });
  }

  await t.test('incomplete successful response is transport-ambiguous', async () => {
    const incomplete = clone(final);
    incomplete.bindings = incomplete.bindings.filter(({ role }) => role !== configuredBinding.role);
    const fixture = operatorBindingPlane({
      contract, policies: [observed], setResponse: incomplete, enabledServices,
    });
    assert.deepEqual(await fixture.plane.read('operator-release-evidence-iam-binding'), {
      status: 'absent',
    });
    await assert.rejects(
      () => fixture.plane.create('operator-release-evidence-iam-binding'),
      (error) => error.code === 'TRANSPORT_AMBIGUOUS',
    );
  });
});

test('release-evidence propagation proves exact media-bucket list authority', async () => {
  const contract = await contractFixture();
  let clock = 0;
  const fixture = operatorBindingPlane({
    contract,
    policies: [operatorProjectPolicy(contract, {
      includeOperator: true, includeReleaseEvidence: true,
    })],
    setResponse: operatorProjectPolicy(contract, {
      includeOperator: true, includeReleaseEvidence: true,
    }),
    permissionResponses: {
      [GCP_IDENTITY.bucket]: [
        { kind: 'storage#testIamPermissionsResponse' },
        { kind: 'storage#testIamPermissionsResponse', permissions: ['storage.objects.list'] },
      ],
    },
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });
  await fixture.plane.waitForOperatorReleaseEvidenceAccess();
  const calls = fixture.restCalls.filter(({ url }) => url.includes('/iam/testPermissions?'));
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ url }) => new URL(url).searchParams.toString() === 'permissions=storage.objects.list'), true);
  assert.equal(clock > 0, true);
});

function operatorRecoveryAuditFixture({
  contract, mediaPermissions = [], buildPermissions = [
    'storage.buckets.get', 'storage.buckets.getIamPolicy', 'storage.buckets.setIamPolicy',
  ], mediaPermissionResponse,
}) {
  const assets = [GCP_IDENTITY.bucket, GCP_IDENTITY.buildSourceBucket].map((bucket) => cloudAsset({
    name: `//storage.googleapis.com/${bucket}`,
    assetType: 'storage.googleapis.com/Bucket',
    displayName: bucket, location: 'asia-east2',
  }));
  const fixture = assetAuditControlPlane({
    contract, assets,
    projectIamPolicy: operatorProjectPolicy(contract),
    enabledApis: ['cloudresourcemanager.googleapis.com', 'iam.googleapis.com', 'storage.googleapis.com'],
    gcloudRows: {
      'storage buckets list': [
        { name: GCP_IDENTITY.bucket }, { name: GCP_IDENTITY.buildSourceBucket },
      ],
    },
    restRows: {
      ':getIamPolicy': operatorProjectPolicy(contract),
      [`/${GCP_IDENTITY.bucket}/iam/testPermissions`]: mediaPermissionResponse ?? {
        kind: 'storage#testIamPermissionsResponse',
        ...(mediaPermissions.length === 0 ? {} : { permissions: mediaPermissions }),
      },
      [`/${GCP_IDENTITY.buildSourceBucket}/iam/testPermissions`]: {
        kind: 'storage#testIamPermissionsResponse', permissions: buildPermissions,
      },
      [`/${GCP_IDENTITY.buildSourceBucket}/iam?optionsRequestedPolicyVersion=3`]: storagePolicy({
        bucket: GCP_IDENTITY.buildSourceBucket,
        bindings: defaultUniformBucketBindings(), etag: 'CAI=',
      }),
    },
  });
  const baseGcloud = fixture.plane.gcloud;
  fixture.plane.gcloud = async (args, options) => {
    if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe'
      && args[3] === BUCKET_IAM_OPERATOR_ROLE.id) {
      fixture.gcloudCalls.push(args);
      throw Object.assign(new Error(
        `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role [projects/${PROJECT}/roles/${BUCKET_IAM_OPERATOR_ROLE.id}] was not found.`,
      ), {
        code: 'NOT_FOUND',
        stderr: `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role [projects/${PROJECT}/roles/${BUCKET_IAM_OPERATOR_ROLE.id}] was not found.`,
      });
    }
    return baseGcloud(args, options);
  };
  return fixture;
}

test('operator recovery audit accepts only the exact locked-media and default-build bootstrap state', async (t) => {
  const contract = await contractFixture();
  const exact = operatorRecoveryAuditFixture({ contract });
  assert.deepEqual(await exact.plane.auditOperatorBucketIamRecovery(), {
    existingBuckets: [GCP_IDENTITY.bucket, GCP_IDENTITY.buildSourceBucket],
  });
  assert.equal(exact.restCalls.some(({ method }) => method !== 'GET' && method !== 'POST'), false);
  assert.equal(exact.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
  assert.equal(exact.gcloudCalls.some((args) => (
    args.includes('create') || args.includes('add-iam-policy-binding') || args.includes('set-iam-policy')
  )), false);

  await t.test('partial permission state is ambiguous and stops before recovery mutation', async () => {
    const partial = operatorRecoveryAuditFixture({
      contract,
      mediaPermissions: ['storage.buckets.get', 'storage.buckets.getIamPolicy'],
    });
    await assert.rejects(
      () => partial.plane.auditOperatorBucketIamRecovery(),
      (error) => error.code === 'OPERATOR_BUCKET_IAM_PERMISSION_INVALID',
    );
    assert.equal(partial.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
  });

  await t.test('a present null permissions field is malformed rather than canonical empty', async () => {
    const malformed = operatorRecoveryAuditFixture({
      contract,
      mediaPermissionResponse: {
        kind: 'storage#testIamPermissionsResponse', permissions: null,
      },
    });
    await assert.rejects(
      () => malformed.plane.auditOperatorBucketIamRecovery(),
      (error) => error.code === 'OPERATOR_BUCKET_IAM_PERMISSION_INVALID',
    );
    assert.equal(malformed.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
  });

  await t.test('a present undefined permissions field is malformed rather than absent', async () => {
    const malformed = operatorRecoveryAuditFixture({
      contract,
      mediaPermissionResponse: {
        kind: 'storage#testIamPermissionsResponse', permissions: undefined,
      },
    });
    await assert.rejects(
      () => malformed.plane.auditOperatorBucketIamRecovery(),
      (error) => error.code === 'OPERATOR_BUCKET_IAM_PERMISSION_INVALID',
    );
    assert.equal(malformed.restCalls.some(({ url }) => url.endsWith(':setIamPolicy')), false);
  });
});

function configuredBucketBindings(contract, bucket) {
  const byRole = new Map();
  for (const binding of contract.iam.bindings.filter(({ scope }) => scope === `bucket:${bucket}`)) {
    const members = byRole.get(binding.role) ?? [];
    members.push(binding.member.replace('__PROJECT_NUMBER__', PROJECT_NUMBER));
    byRole.set(binding.role, members);
  }
  return [...byRole.entries()]
    .map(([role, members]) => ({ role, members: [...members].sort() }))
    .sort((left, right) => left.role.localeCompare(right.role));
}

test('bucket IAM baseline preserves every configured bucket binding and sends the full policy with the observed dynamic etag', async (t) => {
  const contract = await contractFixture();
  assert.deepEqual(
    EXPECTED_PROVISION_STEPS.filter((id) => id.includes('bucket-iam-baseline')),
    ['bucket-iam-baseline', 'build-source-bucket-iam-baseline'],
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('build-source-bucket')
      < EXPECTED_PROVISION_STEPS.indexOf('bucket-iam-baseline'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('build-source-bucket-iam-baseline')
      < EXPECTED_PROVISION_STEPS.findIndex((id) => id.startsWith('secret-container:')),
    true,
  );

  const cases = [
    {
      id: 'bucket-iam-baseline',
      bucket: GCP_IDENTITY.bucket,
      observedEtag: 'AQIDBAUG',
      responseEtag: 'BwgJCgsM',
      configured: EXPECTED_MEDIA_BUCKET_BINDINGS,
    },
    {
      id: 'build-source-bucket-iam-baseline',
      bucket: GCP_IDENTITY.buildSourceBucket,
      observedEtag: 'DQ4PEBES',
      responseEtag: 'ExQVFhcY',
      configured: EXPECTED_BUILD_SOURCE_BUCKET_BINDINGS,
    },
  ];

  for (const {
    id, bucket, observedEtag, responseEtag, configured,
  } of cases) {
    await t.test(`${id} preserves ${configured.length} configured role groups`, async () => {
      assert.notEqual(observedEtag, 'CAE=');
      assert.deepEqual(configuredBucketBindings(contract, bucket), configured);
      const initial = storagePolicy({
        bucket,
        bindings: [...defaultUniformBucketBindings(), ...clone(configured)],
        etag: observedEtag,
      });
      const finalPolicy = storagePolicy({
        bucket, bindings: clone(configured), etag: responseEtag,
      });
      const calls = [];
      let gets = 0;
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => {
          calls.push(clone(input));
          if (input.method === 'GET') return gets++ === 0 ? clone(initial) : clone(finalPolicy);
          if (input.method === 'PUT') return clone(finalPolicy);
          throw new Error('unexpected request');
        },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

      const result = await ensureExactResource({
        id, mutate: true,
        read: () => plane.read(id),
        create: () => plane.create(id),
        compare: (value) => plane.compare(id, value),
      });

      assert.deepEqual(result, { id, status: 'created' });
      assert.deepEqual(calls, [
        {
          method: 'GET',
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam?optionsRequestedPolicyVersion=3`,
        },
        {
          method: 'PUT',
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`,
          body: {
            version: 1,
            kind: 'storage#policy',
            resourceId: `projects/_/buckets/${bucket}`,
            bindings: clone(configured),
            etag: observedEtag,
          },
        },
        {
          method: 'GET',
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam?optionsRequestedPolicyVersion=3`,
        },
      ]);
    });
  }
});

test('bucket IAM baseline removes every non-empty proper subset of the six official default tuples', async (t) => {
  const contract = await contractFixture();
  const id = 'bucket-iam-baseline';
  const bucket = GCP_IDENTITY.bucket;
  const observedEtag = 'ESIzRFVm';
  const responseEtag = 'd4iZqrvM';
  const fullMask = (1 << DEFAULT_UNIFORM_BUCKET_TUPLES.length) - 1;

  assert.equal(DEFAULT_UNIFORM_BUCKET_TUPLES.length, 6);
  assert.deepEqual(
    configuredBucketBindings(contract, bucket),
    EXPECTED_MEDIA_BUCKET_BINDINGS,
  );

  for (let mask = 1; mask < fullMask; mask += 1) {
    await t.test(`default tuple mask ${mask.toString(2).padStart(6, '0')}`, async () => {
      const partialDefaults = groupBucketIamTuples(
        DEFAULT_UNIFORM_BUCKET_TUPLES.filter((ignored, index) => (mask & (1 << index)) !== 0),
      );
      const initial = storagePolicy({
        bucket,
        bindings: [...partialDefaults, ...clone(EXPECTED_MEDIA_BUCKET_BINDINGS)],
        etag: observedEtag,
      });
      const finalPolicy = storagePolicy({
        bucket,
        bindings: clone(EXPECTED_MEDIA_BUCKET_BINDINGS),
        etag: responseEtag,
      });
      const calls = [];
      let gets = 0;
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => {
          calls.push(clone(input));
          if (input.method === 'GET') return clone(gets++ === 0 ? initial : finalPolicy);
          if (input.method === 'PUT') return clone(finalPolicy);
          throw new Error('unexpected request');
        },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

      assert.deepEqual(await ensureExactResource({
        id, mutate: true,
        read: () => plane.read(id),
        create: () => plane.create(id),
        compare: (value) => plane.compare(id, value),
      }), { id, status: 'created' });
      assert.deepEqual(calls, [
        {
          method: 'GET',
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam?optionsRequestedPolicyVersion=3`,
        },
        {
          method: 'PUT',
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam`,
          body: {
            version: 1,
            kind: 'storage#policy',
            resourceId: `projects/_/buckets/${bucket}`,
            bindings: clone(EXPECTED_MEDIA_BUCKET_BINDINGS),
            etag: observedEtag,
          },
        },
        {
          method: 'GET',
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}/iam?optionsRequestedPolicyVersion=3`,
        },
      ], `partial default mask ${mask} must produce one exact authoritative PUT`);
    });
  }
});

test('bucket IAM baseline is idempotent for empty or configured-only policies', async (t) => {
  const contract = await contractFixture();
  for (const [name, id, bucket, policy] of [
    [
      'empty response with omitted bindings',
      'bucket-iam-baseline', GCP_IDENTITY.bucket,
      storagePolicy({ bucket: GCP_IDENTITY.bucket, includeBindings: false }),
    ],
    [
      'complete configured policy',
      'build-source-bucket-iam-baseline', GCP_IDENTITY.buildSourceBucket,
      storagePolicy({
        bucket: GCP_IDENTITY.buildSourceBucket,
        bindings: configuredBucketBindings(contract, GCP_IDENTITY.buildSourceBucket),
      }),
    ],
    [
      'complete media policy with both configured role groups',
      'bucket-iam-baseline', GCP_IDENTITY.bucket,
      storagePolicy({
        bucket: GCP_IDENTITY.bucket,
        bindings: clone(EXPECTED_MEDIA_BUCKET_BINDINGS),
        etag: '3q2+7w==',
      }),
    ],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => { calls.push(clone(input)); return clone(policy); },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
      const result = await ensureExactResource({
        id, mutate: true,
        read: () => plane.read(id),
        create: () => plane.create(id),
        compare: (value) => plane.compare(id, value),
      });
      assert.deepEqual(result, { id, status: 'unchanged' });
      assert.deepEqual(calls.map(({ method }) => method), ['GET']);
    });
  }
});

test('bucket IAM baseline rejects unknown conditional duplicate foreign or malformed policy before PUT', async (t) => {
  const contract = await contractFixture();
  const bucket = GCP_IDENTITY.bucket;
  const defaults = defaultUniformBucketBindings();
  const configured = configuredBucketBindings(contract, bucket);
  const cases = [
    ['unknown role', [...defaults, { role: 'roles/storage.admin', members: [configured[0].members[0]] }]],
    ['foreign member', defaults.map((binding, index) => index === 0
      ? { ...binding, members: [...binding.members, 'projectOwner:999999999999'] } : binding)],
    ['conditional', defaults.map((binding, index) => index === 0
      ? { ...binding, condition: { title: 'temporary', expression: 'true' } } : binding)],
    ['duplicate role', [...defaults, clone(defaults[0])]],
    ['duplicate member', defaults.map((binding, index) => index === 0
      ? { ...binding, members: [...binding.members, binding.members[0]] } : binding)],
    ...DEFAULT_UNIFORM_BUCKET_TUPLES.map(({ role, member }) => [
      `project-number convenience alias ${role} ${member.split(':')[0]}`,
      groupBucketIamTuples([{
        role,
        member: `${member.split(':')[0]}:${PROJECT_NUMBER}`,
      }]),
    ]),
  ];
  for (const [name, bindings] of cases) {
    await t.test(name, async () => {
      const calls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => {
          calls.push(clone(input));
          return storagePolicy({ bucket, bindings });
        },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
      await assert.rejects(
        () => plane.read('bucket-iam-baseline'),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
      assert.deepEqual(calls.map(({ method }) => method), ['GET']);
    });
  }

  for (const [name, policy] of [
    ['missing etag', { ...storagePolicy({ bucket, bindings: defaults }), etag: undefined }],
    ['noncanonical etag', storagePolicy({ bucket, bindings: defaults, etag: 'not base64!' })],
    ['wrong kind', { ...storagePolicy({ bucket, bindings: defaults }), kind: 'storage#bucket' }],
    ['foreign resource', { ...storagePolicy({ bucket, bindings: defaults }), resourceId: 'projects/_/buckets/foreign' }],
    ['condition-capable version', { ...storagePolicy({ bucket, bindings: defaults }), version: 3 }],
  ]) {
    await t.test(name, async () => {
      let puts = 0;
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => {
          if (input.method === 'PUT') puts += 1;
          return clone(policy);
        },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
      await assert.rejects(
        () => plane.read('bucket-iam-baseline'),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
      assert.equal(puts, 0);
    });
  }
});

test('a failed bucket IAM reread invalidates every older cached write snapshot', async () => {
  const contract = await contractFixture();
  const bucket = GCP_IDENTITY.bucket;
  const valid = storagePolicy({ bucket, bindings: defaultUniformBucketBindings() });
  const invalid = {
    ...storagePolicy({ bucket, bindings: defaultUniformBucketBindings() }),
    bindings: [{ role: 'roles/storage.admin', members: ['user:foreign@example.test'] }],
  };
  let reads = 0;
  let puts = 0;
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async (input) => {
      if (input.method === 'PUT') {
        puts += 1;
        return storagePolicy({ bucket, bindings: [], etag: 'CAI=' });
      }
      return clone(reads++ === 0 ? valid : invalid);
    },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

  assert.deepEqual(await plane.read('bucket-iam-baseline'), { status: 'absent' });
  await assert.rejects(
    () => plane.read('bucket-iam-baseline'),
    (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
  );
  await assert.rejects(
    () => plane.create('bucket-iam-baseline'),
    (error) => error.code === 'BUCKET_IAM_BASELINE_STATE_INVALID',
  );
  assert.equal(puts, 0);
});

test('bucket IAM baseline recovers only a lost response with exact readback and rejects etag drift or bad post-readback', async (t) => {
  const contract = await contractFixture();
  const bucket = GCP_IDENTITY.bucket;
  const initial = storagePolicy({ bucket, bindings: defaultUniformBucketBindings() });
  const finalPolicy = storagePolicy({ bucket, bindings: [], etag: 'CAI=' });
  const execute = async ({ putError, postPolicy }) => {
    let gets = 0;
    const calls = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        calls.push(clone(input));
        if (input.method === 'GET') return clone(gets++ === 0 ? initial : postPolicy);
        if (putError) throw putError;
        return clone(finalPolicy);
      },
    });
    plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
    const operation = () => ensureExactResource({
      id: 'bucket-iam-baseline', mutate: true,
      read: () => plane.read('bucket-iam-baseline'),
      create: () => plane.create('bucket-iam-baseline'),
      compare: (value) => plane.compare('bucket-iam-baseline', value),
    });
    return { operation, calls };
  };

  await t.test('lost response recovers after one exact authoritative readback', async () => {
    const fixture = await execute({
      putError: Object.assign(new Error('response lost'), { code: 'TRANSPORT_AMBIGUOUS' }),
      postPolicy: finalPolicy,
    });
    assert.deepEqual(await fixture.operation(), {
      id: 'bucket-iam-baseline', status: 'created-readback-recovered',
    });
    assert.deepEqual(fixture.calls.map(({ method }) => method), ['GET', 'PUT', 'GET']);
  });

  await t.test('etag conflict is deterministic and never adopted through readback', async () => {
    const fixture = await execute({
      putError: Object.assign(new Error('concurrent policy write'), { code: 'IAM_POLICY_ETAG_MISMATCH' }),
      postPolicy: finalPolicy,
    });
    await assert.rejects(fixture.operation, (error) => error.code === 'IAM_POLICY_ETAG_MISMATCH');
    assert.deepEqual(fixture.calls.map(({ method }) => method), ['GET', 'PUT']);
  });

  await t.test('successful PUT still requires a separate exact policy readback', async () => {
    const fixture = await execute({ putError: null, postPolicy: initial });
    await assert.rejects(fixture.operation, (error) => error.code === 'POST_CREATE_READBACK_FAILED');
    assert.deepEqual(fixture.calls.map(({ method }) => method), ['GET', 'PUT', 'GET']);
  });

  await t.test('lost response with a non-exact readback remains ambiguous', async () => {
    const fixture = await execute({
      putError: Object.assign(new Error('response lost'), { code: 'TRANSPORT_AMBIGUOUS' }),
      postPolicy: initial,
    });
    await assert.rejects(fixture.operation, (error) => error.code === 'CREATE_RESULT_AMBIGUOUS');
    assert.deepEqual(fixture.calls.map(({ method }) => method), ['GET', 'PUT', 'GET']);
  });
});

function gcloudBucketMetadata(value) {
  const metadata = clone(value);
  delete metadata.projectNumber;
  return metadata;
}

test('readback compares project display name and labels, repository description, and unconditional bucket lifecycle exactly', async () => {
  const contract = await contractFixture();
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  const project = {
    projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
    parent: { type: 'organization', id: GCP_IDENTITY.organizationId }, name: 'Motion Expert HK LTD Webpage',
    labels: {},
  };
  assert.equal(plane.compare('project', project), true);
  assert.equal(plane.compare('project', { ...project, name: 'Wrong name' }), false);
  assert.equal(plane.compare('project', {
    ...project, labels: { ...project.labels, unexpected: 'extra' },
  }), false);

  const repository = {
    name: `projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`,
    location: 'asia-east2', format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
    description: 'Hong Kong Buddy production containers',
  };
  assert.equal(plane.compare('artifact-registry', repository), true);
  assert.equal(plane.compare('artifact-registry', { ...repository, description: 'drifted' }), false);
  assert.equal(plane.compare('artifact-registry', { ...repository, mode: 'REMOTE_REPOSITORY' }), false);
  assert.equal(plane.compare('artifact-registry', { ...repository, mode: 'VIRTUAL_REPOSITORY' }), false);

  plane.cache.set('project', project);
  const bucket = exactBucket();
  assert.equal(plane.compare('bucket', bucket), true);
  const conditionalLifecycle = clone(bucket);
  conditionalLifecycle.lifecycle.rule[0].condition.matchesPrefix = ['temporary/'];
  assert.equal(plane.compare('bucket', conditionalLifecycle), false);
});

test('Artifact Registry creation and readback require an exact writable standard repository', async () => {
  const calls = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => { calls.push(args); return {}; },
    request: async () => { throw new Error('REST must not run'); },
  });
  await plane.create('artifact-registry');
  assert.deepEqual(calls, [[
    'artifacts', 'repositories', 'create', GCP_IDENTITY.repository, '--repository-format=docker',
    '--mode=standard-repository', '--location=asia-east2',
    '--description=Hong Kong Buddy production containers', `--project=${PROJECT}`, '--format=json',
  ]]);
});

test('secret container readback binds the cached numeric project and rejects identity or policy drift', async () => {
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  const secret = {
    name: `projects/${PROJECT_NUMBER}/secrets/${GCP_IDENTITY.secrets.session}`,
    replication: { automatic: {} },
    labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
  };
  assert.equal(plane.compare(`secret-container:${GCP_IDENTITY.secrets.session}`, secret), true);
  for (const drifted of [
    { ...secret, name: `projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}` },
    { ...secret, name: `projects/999999999999/secrets/${GCP_IDENTITY.secrets.session}` },
    { ...secret, name: `${secret.name}/foreign` },
    { ...secret, expireTime: '2026-09-01T00:00:00Z' },
    { ...secret, ttl: '86400s' },
    { ...secret, rotation: { nextRotationTime: '2026-09-01T00:00:00Z', rotationPeriod: '86400s' } },
    { ...secret, topics: [{ name: `projects/${PROJECT}/topics/rotation` }] },
    { ...secret, replication: { automatic: { customerManagedEncryption: { kmsKeyName: 'projects/foreign/locations/global/keyRings/x/cryptoKeys/y' } } } },
    { ...secret, labels: { ...secret.labels, unexpected: 'extra' } },
  ]) {
    assert.equal(plane.compare(`secret-container:${GCP_IDENTITY.secrets.session}`, drifted), false);
  }

  const unbound = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  assert.equal(unbound.compare(`secret-container:${GCP_IDENTITY.secrets.session}`, secret), false);

  const poisoned = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  poisoned.cache.set('project', { projectNumber: '999999999999' });
  assert.equal(poisoned.compare(`secret-container:${GCP_IDENTITY.secrets.session}`, {
    ...secret, name: `projects/999999999999/secrets/${GCP_IDENTITY.secrets.session}`,
  }), false);
});

test('secret container create readback and rerun accept the live numeric identity with one POST total', async () => {
  const contract = await contractFixture();
  const secretId = GCP_IDENTITY.secrets.dbAppUrl;
  const resourceId = `secret-container:${secretId}`;
  const liveSecret = {
    name: `projects/${PROJECT_NUMBER}/secrets/${secretId}`,
    replication: { automatic: {} },
    labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
  };
  const gcloudCalls = [];
  const requests = [];
  let created = false;
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'secrets' && args[1] === 'describe') {
        if (!created) throw notFound();
        return liveSecret;
      }
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      requests.push(input);
      if (input.method !== 'POST') throw new Error(`unexpected REST method ${input.method}`);
      created = true;
      return liveSecret;
    },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  const operation = {
    id: resourceId,
    mutate: true,
    read: () => plane.read(resourceId),
    create: () => plane.create(resourceId),
    compare: (value) => plane.compare(resourceId, value),
  };

  assert.deepEqual(await ensureExactResource(operation), { id: resourceId, status: 'created' });
  assert.deepEqual(await ensureExactResource(operation), { id: resourceId, status: 'unchanged' });
  assert.deepEqual(requests, [{
    method: 'POST',
    url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${secretId}`,
    body: {
      replication: { automatic: {} },
      labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
    },
  }]);
  assert.equal(gcloudCalls.filter((args) => args[0] === 'secrets' && args[1] === 'describe').length, 3);
});

test('existing generated secret values must be canonical base64url encodings of exactly 32 bytes', async () => {
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('cloud-sql-instance', { privateIp: '10.25.0.3' });
  const canonical = Buffer.alloc(32, 0x41).toString('base64url');
  const url = (user, password) => `postgresql://${user}:${encodeURIComponent(password)}@10.25.0.3:5432/hkbuddy_v1?sslmode=require`;

  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.session}`, {
    version: '1', secretValue: canonical,
  }), true);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.session}`, {
    version: '1', secretValue: 'A'.repeat(32),
  }), false);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.dbAppUrl}`, {
    version: '1', secretValue: url('hkbuddy_app', canonical),
  }), true);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.dbAppUrl}`, {
    version: '1', secretValue: url('hkbuddy_app', 'x'),
  }), false);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.dbMigratorUrl}`, {
    version: '1', secretValue: url('hkbuddy_migrator', `${canonical}=`),
  }), false);
});

test('Cloud SQL creation uses the supported v1 REST insert with the named PSA range and exact retention controls', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('Cloud SQL create must not use gcloud argv'); },
    request: async (input) => {
      requests.push(input);
      return {
        kind: 'sql#operation', name: 'operation-1', operationType: 'CREATE', status: 'DONE',
        targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
      };
    },
  });
  await plane.create('cloud-sql-instance');
  assert.deepEqual(requests, [{
    method: 'POST', url: `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances`,
    body: {
      name: GCP_IDENTITY.cloudSqlInstance, region: 'asia-east2', databaseVersion: 'POSTGRES_16',
      settings: {
        edition: 'ENTERPRISE', tier: 'db-custom-1-3840', availabilityType: 'REGIONAL',
        dataDiskType: 'PD_SSD', dataDiskSizeGb: '20', storageAutoResize: true,
        ipConfiguration: {
          ipv4Enabled: false,
          privateNetwork: `projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
          allocatedIpRange: GCP_IDENTITY.psaRange, sslMode: 'ENCRYPTED_ONLY',
        },
        backupConfiguration: {
          enabled: true, startTime: '18:00', pointInTimeRecoveryEnabled: true,
          transactionLogRetentionDays: 7,
          backupRetentionSettings: { retentionUnit: 'COUNT', retainedBackups: 7 },
        },
        deletionProtectionEnabled: true, retainBackupsOnDelete: true,
        finalBackupConfig: { enabled: true, retentionDays: 30 },
      },
    },
  }]);
});

test('Cloud SQL exact readback requires the Enterprise edition selected by the resource contract', async () => {
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  const exact = { ...exactCloudSqlInstance(), privateIp: '10.25.0.3' };
  assert.equal(plane.compare('cloud-sql-instance', exact), true);

  const missing = structuredClone(exact);
  delete missing.settings.edition;
  assert.equal(plane.compare('cloud-sql-instance', missing), false);

  const plus = structuredClone(exact);
  plus.settings.edition = 'ENTERPRISE_PLUS';
  assert.equal(plane.compare('cloud-sql-instance', plus), false);

  for (const ipAddresses of [
    [
      { type: 'PRIVATE', ipAddress: '10.25.0.3' },
      { type: 'PRIVATE', ipAddress: '10.25.0.3' },
    ],
    [
      { type: 'PRIVATE', ipAddress: '10.25.0.3' },
      { type: 'PRIVATE', ipAddress: '10.25.0.4' },
    ],
  ]) {
    assert.equal(plane.compare('cloud-sql-instance', { ...exact, ipAddresses }), false);
  }
});

test('final readback never accepts duplicate or split Cloud SQL private-IP identities', async (t) => {
  const secretVersions = {
    [GCP_IDENTITY.secrets.dbAppUrl]: '1',
    [GCP_IDENTITY.secrets.dbMigratorUrl]: '1',
    [GCP_IDENTITY.secrets.session]: '1',
    [GCP_IDENTITY.secrets.bootstrap]: '1',
  };
  for (const [name, ipAddresses] of [
    ['duplicate', [
      { type: 'PRIVATE', ipAddress: '10.25.0.3' },
      { type: 'PRIVATE', ipAddress: '10.25.0.3' },
    ]],
    ['split', [
      { type: 'PRIVATE', ipAddress: '10.25.0.3' },
      { type: 'PRIVATE', ipAddress: '10.25.0.4' },
    ]],
  ]) {
    await t.test(name, async () => {
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async () => { throw new Error('REST must not run'); },
      });
      const compare = plane.compare.bind(plane);
      plane.auditUserManagedServiceAccountKeys = async () => undefined;
      plane.read = async (id) => ({
        status: 'present',
        value: id === 'cloud-sql-instance'
          ? { ...exactCloudSqlInstance(), privateIp: '10.25.0.3', ipAddresses }
          : {},
      });
      plane.compare = (id, value, context) => (
        id === 'cloud-sql-instance' ? compare(id, value, context) : true
      );

      await assert.rejects(
        () => plane.finalReadback({ notificationChannel: CHANNEL, secretVersions }),
        (error) => error.code === 'FINAL_READBACK_FAILED',
      );
    });
  }
});

test('Cloud SQL v1 creation polls the canonical v1 operation endpoint', async () => {
  const requests = [];
  const operation = (status) => ({
    kind: 'sql#operation', name: 'operation-1', operationType: 'CREATE', status,
    targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  });
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('Cloud SQL create must not use gcloud argv'); },
    request: async (input) => {
      requests.push(input);
      if (input.method === 'POST') return operation('PENDING');
      return operation('DONE');
    },
  });

  await plane.create('cloud-sql-instance');
  assert.equal(requests[1]?.method, 'GET');
  assert.equal(
    requests[1]?.url,
    `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/operations/operation-1`,
  );
});

test('Cloud SQL mutation operation identity and terminal errors fail closed', async (t) => {
  const contract = await contractFixture();
  const exactOperation = {
    kind: 'sql#operation', name: 'operation-1', operationType: 'CREATE', status: 'DONE',
    targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  };
  for (const [name, operation, code] of [
    ['wrong kind', { ...exactOperation, kind: 'sql#database' }, 'SQL_OPERATION_AMBIGUOUS'],
    ['wrong type', { ...exactOperation, operationType: 'UPDATE' }, 'SQL_OPERATION_AMBIGUOUS'],
    ['wrong target', { ...exactOperation, targetId: 'foreign-instance' }, 'SQL_OPERATION_AMBIGUOUS'],
    ['wrong project', { ...exactOperation, targetProject: 'foreign-project' }, 'SQL_OPERATION_AMBIGUOUS'],
    ['unknown status', { ...exactOperation, status: 'UNKNOWN' }, 'SQL_OPERATION_AMBIGUOUS'],
    ['terminal error', {
      ...exactOperation,
      error: { kind: 'sql#operationErrors', errors: [{ code: 'FAILED', message: 'failed' }] },
    }, 'SQL_OPERATION_FAILED'],
    ['empty terminal error wrapper', {
      ...exactOperation, error: { kind: 'sql#operationErrors', errors: [] },
    }, 'SQL_OPERATION_AMBIGUOUS'],
  ]) {
    await t.test(name, async () => {
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async () => operation,
      });
      await assert.rejects(
        () => plane.create('cloud-sql-instance'),
        (error) => error.code === code,
      );
    });
  }
});

test('Cloud SQL operation deadlines include an in-flight poll response', async () => {
  let now = 0;
  const timeoutMs = 30 * 60 * 1_000;
  const operation = (status) => ({
    kind: 'sql#operation', name: 'slow-operation', operationType: 'CREATE', status,
    targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  });
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async (input) => {
      if (input.method === 'POST') return operation('PENDING');
      now = timeoutMs + 1;
      return operation('DONE');
    },
  });

  await assert.rejects(
    () => plane.create('cloud-sql-instance'),
    (error) => error.code === 'SQL_OPERATION_TIMEOUT',
  );
});

test('Cloud SQL operation deadline aborts a poll that never resolves by itself', async () => {
  const timeoutMs = 30 * 60 * 1_000;
  let nowCalls = 0;
  let expired = false;
  const clock = () => {
    nowCalls += 1;
    if (nowCalls === 1) return 0;
    return expired ? timeoutMs : timeoutMs - 1;
  };
  const operation = {
    kind: 'sql#operation', name: 'hanging-operation', operationType: 'CREATE', status: 'PENDING',
    targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  };
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    now: clock,
    sleep: async () => { expired = true; },
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async (input) => {
      if (input.method === 'POST') {
        return operation;
      }
      assert.equal(input.signal instanceof AbortSignal, true);
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          expired = true;
          reject(Object.assign(new Error('aborted'), { code: 'TRANSPORT_AMBIGUOUS' }));
        }, { once: true });
      });
    },
  });

  let watchdog;
  const outcome = await Promise.race([
    plane.create('cloud-sql-instance').then(
      () => 'unexpected-success',
      (error) => error.code,
    ),
    new Promise((resolve) => { watchdog = setTimeout(() => resolve('watchdog-expired'), 100); }),
  ]);
  clearTimeout(watchdog);
  assert.equal(outcome, 'SQL_OPERATION_TIMEOUT');
});

test('database insert waits for a quiet exact Cloud SQL instance and polls its v1 operation', async () => {
  const requests = [];
  const gcloudCalls = [];
  const sleeps = [];
  let now = 0;
  let operationLists = 0;
  const sql = { ...exactCloudSqlInstance(), ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.25.0.2' }] };
  const operation = (name, operationType, status) => ({
    kind: 'sql#operation', name, operationType, status,
    targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  });
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    gcloud: async (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') return sql;
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      requests.push(input);
      if (input.method === 'GET' && input.url.includes('/operations?')) {
        operationLists += 1;
        return operationLists === 1
          ? { kind: 'sql#operationsList', items: [operation('backup-op', 'BACKUP_VOLUME', 'RUNNING')] }
          : { kind: 'sql#operationsList', items: [operation('backup-op', 'BACKUP_VOLUME', 'DONE')] };
      }
      if (input.method === 'POST' && input.url.endsWith('/databases')) {
        return operation('database-op', 'CREATE_DATABASE', 'PENDING');
      }
      if (input.method === 'GET' && input.url.endsWith('/operations/database-op')) {
        return operation('database-op', 'CREATE_DATABASE', 'DONE');
      }
      throw new Error(`unexpected REST ${input.method} ${input.url}`);
    },
  });

  await plane.create('database');
  const databasePost = requests.find(({ method, url }) => method === 'POST' && url.endsWith('/databases'));
  assert.deepEqual({
    method: databasePost.method,
    url: databasePost.url,
    body: databasePost.body,
  }, {
    method: 'POST',
    url: `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases`,
    body: { project: PROJECT, instance: GCP_IDENTITY.cloudSqlInstance, name: GCP_IDENTITY.database },
  });
  assert.equal(operationLists, 2);
  assert.equal(gcloudCalls.filter((args) => args[2] === 'instances' || args[2] === 'describe').length >= 3, true);
  assert.equal(sleeps.length >= 1, true);
  assert.equal(
    requests.at(-1).url,
    `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/operations/database-op`,
  );
});

test('database insert re-proves readiness after official transient Cloud SQL 409 states', async (t) => {
  const contract = await contractFixture();
  for (const transientCode of ['SQL_OPERATION_IN_PROGRESS', 'SQL_INVALID_STATE']) {
    await t.test(transientCode, async () => {
      const requests = [];
      let posts = 0;
      let now = 0;
      const operation = {
        kind: 'sql#operation', name: 'database-operation', operationType: 'CREATE_DATABASE',
        status: 'DONE', targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
      };
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
        gcloud: async (args) => {
          if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
            return exactCloudSqlInstance();
          }
          throw new Error(`unexpected gcloud ${args.join(' ')}`);
        },
        request: async (input) => {
          requests.push(input);
          if (input.method === 'GET' && input.url.includes('/operations?')) {
            return { kind: 'sql#operationsList' };
          }
          if (input.method === 'POST' && input.url.endsWith('/databases')) {
            posts += 1;
            if (posts === 1) throw Object.assign(new Error('transient conflict'), { code: transientCode });
            return operation;
          }
          throw new Error(`unexpected REST ${input.method} ${input.url}`);
        },
      });

      assert.deepEqual(await plane.create('database'), operation);
      assert.equal(posts, 2);
      assert.equal(requests.filter(({ url }) => url.includes('/operations?')).length, 2);
    });
  }
});

test('database insert reads every operations page and never posts while a later page is active', async () => {
  const requests = [];
  let now = 0;
  const sql = exactCloudSqlInstance();
  const operation = (name, status) => ({
    kind: 'sql#operation', name, operationType: 'BACKUP_VOLUME', status,
    targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  });
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    now: () => now,
    sleep: async () => { now += 600_001; },
    gcloud: async (args) => {
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') return sql;
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      requests.push(input);
      if (input.method !== 'GET') throw new Error('database POST must remain blocked');
      const pageToken = new URL(input.url).searchParams.get('pageToken');
      return pageToken === null
        ? { kind: 'sql#operationsList', items: [operation('done-op', 'DONE')], nextPageToken: 'page-2' }
        : { kind: 'sql#operationsList', items: [operation('active-op', 'RUNNING')] };
    },
  });

  await assert.rejects(
    () => plane.create('database'),
    (error) => error.code === 'SQL_INSTANCE_NOT_QUIET',
  );
  assert.equal(requests.some(({ method }) => method === 'POST'), false);
  assert.equal(requests.some(({ url }) => new URL(url).searchParams.get('pageToken') === 'page-2'), true);
});

test('database quiet gate rejects a non-Operation row before database mutation', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
        return exactCloudSqlInstance();
      }
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      requests.push(input);
      if (input.method === 'GET' && input.url.includes('/operations?')) {
        return {
          kind: 'sql#operationsList',
          items: [{
            kind: 'sql#database', name: 'forged-operation', operationType: 'BACKUP_VOLUME',
            status: 'DONE', targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
          }],
        };
      }
      throw new Error('database mutation must remain blocked');
    },
  });

  await assert.rejects(
    () => plane.create('database'),
    (error) => error.code === 'SQL_OPERATION_AMBIGUOUS',
  );
  assert.equal(requests.some(({ method }) => method === 'POST'), false);
});

test('database quiet deadline includes in-flight instance and paginated operation reads', async (t) => {
  const contract = await contractFixture();
  const timeoutMs = 10 * 60 * 1_000;
  for (const slowStage of ['instance', 'operations']) {
    await t.test(slowStage, async () => {
      let now = 0;
      const requests = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
        gcloud: async (args) => {
          if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
            if (slowStage === 'instance') now = timeoutMs + 1;
            return exactCloudSqlInstance();
          }
          throw new Error(`unexpected gcloud ${args.join(' ')}`);
        },
        request: async (input) => {
          requests.push(input);
          if (input.method === 'GET' && input.url.includes('/operations?')) {
            if (slowStage === 'operations') now = timeoutMs + 1;
            return { kind: 'sql#operationsList' };
          }
          throw new Error('database mutation must remain blocked');
        },
      });

      await assert.rejects(
        () => plane.create('database'),
        (error) => error.code === 'SQL_INSTANCE_NOT_QUIET',
      );
      assert.equal(requests.some(({ method }) => method === 'POST'), false);
      if (slowStage === 'instance') assert.equal(requests.length, 0);
    });
  }
});

test('database quiet deadline aborts hanging gcloud and REST reads', async (t) => {
  const contract = await contractFixture();
  const timeoutMs = 10 * 60 * 1_000;
  for (const slowStage of ['instance', 'operations']) {
    await t.test(slowStage, async () => {
      let nowCalls = 0;
      let now = 0;
      const clock = () => {
        nowCalls += 1;
        if (nowCalls === 1) return 0;
        if (now < timeoutMs - 1) now = timeoutMs - 1;
        return now;
      };
      const hang = (signal) => new Promise((_resolve, reject) => {
        assert.equal(signal instanceof AbortSignal, true);
        signal.addEventListener('abort', () => {
          now = timeoutMs;
          reject(Object.assign(new Error('aborted'), { code: 'TRANSPORT_AMBIGUOUS' }));
        }, { once: true });
      });
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        now: clock,
        sleep: async (milliseconds) => { now += milliseconds; },
        gcloud: async (args, options) => {
          if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
            return slowStage === 'instance' ? hang(options?.signal) : exactCloudSqlInstance();
          }
          throw new Error(`unexpected gcloud ${args.join(' ')}`);
        },
        request: async (input) => {
          if (input.method === 'GET' && input.url.includes('/operations?')) {
            return slowStage === 'operations' ? hang(input.signal) : { kind: 'sql#operationsList' };
          }
          throw new Error('database mutation must remain blocked');
        },
      });

      let watchdog;
      const outcome = await Promise.race([
        plane.create('database').then(
          () => 'unexpected-success',
          (error) => error.code,
        ),
        new Promise((resolve) => { watchdog = setTimeout(() => resolve('watchdog-expired'), 100); }),
      ]);
      clearTimeout(watchdog);
      assert.equal(outcome, 'SQL_INSTANCE_NOT_QUIET');
    });
  }
});

test('database quiet deadline rejects a successful insert response that arrives after the deadline', async () => {
  const timeoutMs = 10 * 60 * 1_000;
  let now = 0;
  const operation = {
    kind: 'sql#operation', name: 'late-database-operation', operationType: 'CREATE_DATABASE',
    status: 'DONE', targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  };
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    gcloud: async (args) => {
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
        return exactCloudSqlInstance();
      }
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      if (input.method === 'GET' && input.url.includes('/operations?')) {
        return { kind: 'sql#operationsList' };
      }
      if (input.method === 'POST' && input.url.endsWith('/databases')) {
        now = timeoutMs + 1;
        return operation;
      }
      throw new Error(`unexpected REST ${input.method} ${input.url}`);
    },
  });

  await assert.rejects(
    () => plane.create('database'),
    (error) => error.code === 'SQL_INSTANCE_NOT_QUIET',
  );
});

test('database quiet deadline aborts an insert request that never resolves by itself', async () => {
  const timeoutMs = 10 * 60 * 1_000;
  let now = 0;
  let instanceReads = 0;
  let databasePostSeen = false;
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    gcloud: async (args) => {
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
        instanceReads += 1;
        if (instanceReads === 2) now = timeoutMs - 1;
        return exactCloudSqlInstance();
      }
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      if (input.method === 'GET' && input.url.includes('/operations?')) {
        return { kind: 'sql#operationsList' };
      }
      if (input.method === 'POST' && input.url.endsWith('/databases')) {
        databasePostSeen = true;
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            now = timeoutMs;
            reject(Object.assign(new Error('aborted'), { code: 'TRANSPORT_AMBIGUOUS' }));
          }, { once: true });
        });
      }
      throw new Error(`unexpected REST ${input.method} ${input.url}`);
    },
  });

  let watchdog;
  const outcome = await Promise.race([
    plane.create('database').then(
      () => 'unexpected-success',
      (error) => error.code,
    ),
    new Promise((resolve) => { watchdog = setTimeout(() => resolve('watchdog-expired'), 100); }),
  ]);
  clearTimeout(watchdog);
  assert.equal(databasePostSeen, true);
  assert.equal(outcome, 'SQL_INSTANCE_NOT_QUIET');
});

test('Cloud SQL operation pagination treats page tokens and operation names as bounded opaque strings', async () => {
  const requests = [];
  const operationName = 'opaque operation/name';
  const pageToken = 'opaque token:%/+';
  let operationPages = 0;
  const operation = (name, operationType, status) => ({
    kind: 'sql#operation', name, operationType, status,
    targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  });
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
        return exactCloudSqlInstance();
      }
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async (input) => {
      requests.push(input);
      if (input.method === 'GET' && input.url.includes('/operations?')) {
        operationPages += 1;
        return operationPages === 1
          ? { kind: 'sql#operationsList', nextPageToken: pageToken }
          : { kind: 'sql#operationsList', nextPageToken: '' };
      }
      if (input.method === 'POST' && input.url.endsWith('/databases')) {
        return operation(operationName, 'CREATE_DATABASE', 'PENDING');
      }
      if (input.method === 'GET' && input.url.includes('/operations/')) {
        return operation(operationName, 'CREATE_DATABASE', 'DONE');
      }
      throw new Error(`unexpected REST ${input.method} ${input.url}`);
    },
  });

  await plane.create('database');
  assert.equal(operationPages, 2);
  assert.equal(
    new URL(requests.find(({ url }) => url.includes('pageToken='))?.url).searchParams.get('pageToken'),
    pageToken,
  );
  assert.equal(
    requests.at(-1).url.endsWith(`/operations/${encodeURIComponent(operationName)}`),
    true,
  );
});

test('database user creation requires an exact CREATE_USER operation identity', async (t) => {
  const contract = await contractFixture();
  const password = Buffer.alloc(32, 7).toString('base64url');
  const context = {
    sensitive: {
      databaseUrl: `postgresql://hkbuddy_app:${password}@10.25.0.3:5432/hkbuddy_v1?sslmode=require`,
    },
  };
  const exactOperation = {
    kind: 'sql#operation', name: 'create-user-operation', operationType: 'CREATE_USER',
    status: 'DONE', targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  };
  const accepted = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => exactOperation,
  });
  assert.deepEqual(await accepted.create('db-user:hkbuddy_app', context), exactOperation);

  for (const [name, operation] of [
    ['wrong kind', { ...exactOperation, kind: 'sql#database' }],
    ['wrong type', { ...exactOperation, operationType: 'UPDATE_USER' }],
    ['wrong target', { ...exactOperation, targetId: 'foreign-instance' }],
    ['wrong project', { ...exactOperation, targetProject: 'foreign-project' }],
  ]) {
    await t.test(name, async () => {
      const requests = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => { requests.push(input); return operation; },
      });
      await assert.rejects(
        () => plane.create('db-user:hkbuddy_app', context),
        (error) => error.code === 'SQL_OPERATION_AMBIGUOUS',
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'POST');
    });
  }
});

test('database user readback resolves the live list summary through users.get', async () => {
  const contract = await contractFixture();
  const password = Buffer.alloc(32, 7).toString('base64url');
  const context = {
    sensitive: {
      databaseUrl: `postgresql://hkbuddy_app:${password}@10.25.0.3:5432/hkbuddy_v1?sslmode=require`,
    },
  };
  const exactOperation = {
    kind: 'sql#operation', name: 'create-user-operation', operationType: 'CREATE_USER',
    status: 'DONE', targetId: GCP_IDENTITY.cloudSqlInstance, targetProject: PROJECT,
  };
  const listSummary = {
    kind: 'sql#usersList',
    items: [{
      kind: 'sql#user', etag: 'summary-etag', name: 'hkbuddy_app', host: '',
      instance: GCP_IDENTITY.cloudSqlInstance, project: PROJECT,
    }],
  };
  const detail = {
    ...listSummary.items[0], etag: 'detail-etag',
    databaseRoles: ['pg_read_all_data', 'pg_write_all_data'],
  };
  const requests = [];
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async (input) => {
      requests.push(input);
      if (input.method === 'POST') return exactOperation;
      if (input.url.endsWith('/users/hkbuddy_app')) return detail;
      if (input.url.endsWith('/users')) return listSummary;
      throw new Error(`unexpected request ${input.method} ${input.url}`);
    },
  });

  await plane.create('db-user:hkbuddy_app', context);
  const readback = await plane.read('db-user:hkbuddy_app');

  assert.equal(readback.status, 'present');
  assert.equal(plane.compare('db-user:hkbuddy_app', readback.value), true);
  assert.deepEqual(requests.slice(1), [
    {
      method: 'GET',
      url: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/users`,
    },
    {
      method: 'GET',
      url: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/users/hkbuddy_app`,
    },
  ]);

  for (const property of ['type', 'iamStatus']) {
    const malformed = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        if (input.method === 'POST') return exactOperation;
        if (input.url.endsWith('/users/hkbuddy_app')) {
          return { ...detail, [property]: undefined };
        }
        if (input.url.endsWith('/users')) return listSummary;
        throw new Error(`unexpected request ${input.method} ${input.url}`);
      },
    });
    await malformed.create('db-user:hkbuddy_app', context);
    const malformedReadback = await malformed.read('db-user:hkbuddy_app');
    assert.equal(malformed.compare('db-user:hkbuddy_app', malformedReadback.value), false, property);
  }
});

test('live gcloud bucket metadata binds to exact Storage JSON project ownership for both bucket classes', async (t) => {
  for (const [id, bucket, restValue] of [
    ['bucket', GCP_IDENTITY.bucket, exactBucket()],
    ['build-source-bucket', GCP_IDENTITY.buildSourceBucket, exactBuildSourceBucket()],
  ]) {
    await t.test(id, async () => {
      const gcloudCalls = [];
      const requests = [];
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async (args) => {
          gcloudCalls.push(args);
          return gcloudBucketMetadata(restValue);
        },
        request: async (input) => {
          requests.push(input);
          return restValue;
        },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

      assert.deepEqual(await plane.read(id), { status: 'present', value: restValue });
      assert.equal(plane.compare(id, restValue), true);
      assert.deepEqual(gcloudCalls, [[
        'storage', 'buckets', 'describe', `gs://${bucket}`, `--project=${PROJECT}`, '--format=json',
      ]]);
      assert.deepEqual(requests, [{
        method: 'GET',
        url: `https://storage.googleapis.com/storage/v1/b/${bucket}?projection=full`,
      }]);
    });
  }
});

test('Storage JSON bucket ownership read fails closed for foreign missing malformed forbidden and ambiguous results', async (t) => {
  const failures = [
    ['foreign owner', (exactValue) => ({ ...exactValue, projectNumber: '999999999999' }), 'reject', 'BUCKET_ID_COLLISION'],
    ['missing owner', (exactValue) => {
      const value = clone(exactValue);
      delete value.projectNumber;
      return value;
    }, 'reject', 'BUCKET_ID_COLLISION'],
    ['malformed identity', () => ({ projectNumber: PROJECT_NUMBER }), 'reject', 'BUCKET_ID_COLLISION'],
    ['forbidden', () => { throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }); }, 'unknown', 'FORBIDDEN'],
    ['ambiguous', () => { throw Object.assign(new Error('ambiguous'), { code: 'TRANSPORT_AMBIGUOUS' }); }, 'reject', 'TRANSPORT_AMBIGUOUS'],
    ['missing after existence proof', () => { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); }, 'reject', 'TRANSPORT_AMBIGUOUS'],
  ];
  for (const [id, bucket, exactValue] of [
    ['bucket', GCP_IDENTITY.bucket, exactBucket()],
    ['build-source-bucket', GCP_IDENTITY.buildSourceBucket, exactBuildSourceBucket()],
  ]) {
    for (const [failure, response, outcome, code] of failures) {
      await t.test(`${id}: ${failure}`, async () => {
        const gcloudCalls = [];
        const requests = [];
        const plane = new GcpControlPlane({
          contract: await contractFixture(), notificationChannel: CHANNEL,
          gcloud: async (args) => {
            gcloudCalls.push(args);
            return gcloudBucketMetadata(exactValue);
          },
          request: async (input) => {
            requests.push(input);
            return response(exactValue);
          },
        });
        plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

        if (outcome === 'unknown') {
          assert.deepEqual(await plane.read(id), { status: 'unknown', code });
        } else {
          await assert.rejects(() => plane.read(id), (error) => error.code === code);
        }
        assert.equal(gcloudCalls.length, 1);
        assert.deepEqual(requests, [{
          method: 'GET',
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}?projection=full`,
        }]);
        assert.equal(gcloudCalls.some((args) => args.includes('add-iam-policy-binding')), false);
        assert.equal(requests.some(({ method }) => method !== 'GET'), false);
      });
    }
  }
});

test('bucket insert request contains only writable exact controls and readback includes target projectNumber', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects' && args[1] === 'describe') {
        return {
          projectId: PROJECT, projectNumber: '123456789012', lifecycleState: 'ACTIVE',
          parent: { type: 'organization', id: '797368190621' },
          labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
        };
      }
      throw new Error('unexpected gcloud operation');
    },
    request: async (input) => { requests.push(input); return exactBucket(); },
  });
  await plane.read('project');
  plane.cache.set('project', { projectNumber: GCP_IDENTITY.projectNumber });
  assert.equal(plane.compare('bucket', exactBucket()), true);
  assert.equal(plane.compare('bucket', exactBucket({ projectNumber: '999999999999' })), false);
  await plane.create('bucket');
  const insert = requests.find(({ method }) => method === 'POST');
  assert.equal(insert.body.locationType, undefined);
  assert.deepEqual(insert.body, {
    name: GCP_IDENTITY.bucket, location: 'asia-east2',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced',
    },
    versioning: { enabled: false },
    softDeletePolicy: { retentionDurationSeconds: '0' },
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] },
  });
});

test('build source bucket is regional private lifecycle-bounded non-adopted and idempotent', async () => {
  const contract = await contractFixture();
  assert.deepEqual(contract.resources.buildSourceBucket, {
    name: 'hkbuddy-v1-582852715831-build-source', location: 'asia-east2',
    uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced',
    versioning: false, softDeleteSeconds: 0, lifecycleDeleteAfterDays: 1,
    retentionPolicy: null,
  });
  assert.equal(EXPECTED_PROVISION_STEPS.includes('build-source-bucket'), true);
  assert.equal(EXPECTED_PROVISION_STEPS.includes('iam:36'), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.buildSourceBucket}`
      && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.build}`
      && role === 'roles/storage.objectViewer'
  )), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.buildSourceBucket}`
      && member === 'user:admin@motionexp.com'
      && role === 'roles/storage.objectCreator'
  )), true, 'the fixed operator must be able to upload the frozen source archive');
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.buildSourceBucket}`
      && member === 'user:admin@motionexp.com'
      && ['roles/storage.objectAdmin', 'roles/storage.objectUser'].includes(role)
  )), false, 'source upload must not grant read, list, overwrite, or delete authority');

  const requests = [];
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('source bucket must use Storage JSON API'); },
    request: async (input) => { requests.push(input); return exactBuildSourceBucket(); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  assert.equal(plane.compare('build-source-bucket', exactBuildSourceBucket()), true);
  assert.equal(plane.compare('build-source-bucket', exactBuildSourceBucket({ projectNumber: '999999999999' })), false);
  assert.equal(plane.compare('build-source-bucket', exactBucket({
    name: GCP_IDENTITY.buildSourceBucket, lifecycleDeleteAfterDays: 7,
  })), false);
  await plane.create('build-source-bucket');
  assert.deepEqual(requests.find(({ method }) => method === 'POST')?.body, {
    name: GCP_IDENTITY.buildSourceBucket, location: 'asia-east2',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced',
    },
    versioning: { enabled: false }, softDeletePolicy: { retentionDurationSeconds: '0' },
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }] },
  });
});

test('budget readback normalizes an omitted default-false notification field', async () => {
  const budget = {
    name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/123`,
    displayName: 'Hong Kong Buddy Production V1 monthly guard',
    budgetFilter: {
      projects: [`projects/${PROJECT_NUMBER}`], calendarPeriod: 'MONTH',
      creditTypesTreatment: 'INCLUDE_ALL_CREDITS',
    },
    amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
    thresholdRules: [
      { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
    ],
    notificationsRule: { monitoringNotificationChannels: [CHANNEL] },
  };
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
        parent: { type: 'organization', id: '797368190621' },
        labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
      };
      throw new Error('unexpected gcloud operation');
    },
    request: async ({ method, url }) => {
      assert.equal(method, 'GET');
      assert.match(url, /billingbudgets\.googleapis\.com/);
      return { budgets: [budget] };
    },
  });
  await plane.read('project');
  const readback = await plane.read('budget');
  assert.deepEqual(readback, { status: 'present', value: { exact: true } });
});

test('budget readback accepts the observed INCLUDE_ALL_CREDITS filter exactly', async () => {
  const budget = {
    name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/123456789`,
    displayName: 'Hong Kong Buddy Production V1 monthly guard',
    budgetFilter: {
      projects: [`projects/${PROJECT_NUMBER}`],
      calendarPeriod: 'MONTH',
      creditTypesTreatment: 'INCLUDE_ALL_CREDITS',
    },
    amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
    thresholdRules: [
      { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
    ],
    notificationsRule: { monitoringNotificationChannels: [CHANNEL] },
  };
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return { projectId: PROJECT, projectNumber: PROJECT_NUMBER };
      throw new Error('unexpected gcloud operation');
    },
    request: async () => ({ budgets: [budget] }),
  });
  await plane.read('project');

  assert.deepEqual(await plane.read('budget'), { status: 'present', value: { exact: true } });
});

test('budget lifecycle adopts the observed filter, creates once, and rejects credit drift', async (t) => {
  const contract = await contractFixture();
  const exactBudget = {
    name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/123456789`,
    displayName: 'Hong Kong Buddy Production V1 monthly guard',
    budgetFilter: {
      projects: [`projects/${PROJECT_NUMBER}`],
      calendarPeriod: 'MONTH',
      creditTypesTreatment: 'INCLUDE_ALL_CREDITS',
    },
    amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
    thresholdRules: [
      { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
    ],
    notificationsRule: { monitoringNotificationChannels: [CHANNEL] },
  };
  const planeFor = (request) => new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return { projectId: PROJECT, projectNumber: PROJECT_NUMBER };
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request,
  });

  await t.test('existing exact budget is adopted with no POST', async () => {
    const requests = [];
    const plane = planeFor(async (input) => {
      requests.push(input);
      if (input.method === 'GET') return { budgets: [exactBudget] };
      throw new Error('POST must not run');
    });
    await plane.read('project');
    assert.deepEqual(await ensureExactResource({
      id: 'budget', mutate: true,
      read: () => plane.read('budget'),
      create: () => plane.create('budget', { notificationChannel: CHANNEL }),
      compare: (value) => plane.compare('budget', value),
    }), { id: 'budget', status: 'unchanged' });
    assert.deepEqual(requests.map(({ method }) => method), ['GET']);
  });

  await t.test('preflight inventory accepts the observed managed budget', async () => {
    const fixture = assetAuditControlPlane({
      contract, assets: [],
      enabledApis: [
        'iam.googleapis.com', 'serviceusage.googleapis.com', 'billingbudgets.googleapis.com',
      ],
      restRows: { '/budgets': { budgets: [exactBudget] } },
    });
    assert.equal(await fixture.plane.auditPreMutationState(), true);
    assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  });

  await t.test('first create sends the canonical filter and rerun never duplicates POST', async () => {
    const requests = [];
    let created = false;
    const plane = planeFor(async (input) => {
      requests.push(input);
      if (input.method === 'GET') return { budgets: created ? [exactBudget] : [] };
      if (input.method === 'POST') { created = true; return exactBudget; }
      throw new Error(`unexpected REST method ${input.method}`);
    });
    await plane.read('project');
    const operation = {
      id: 'budget', mutate: true,
      read: () => plane.read('budget'),
      create: () => plane.create('budget', { notificationChannel: CHANNEL }),
      compare: (value) => plane.compare('budget', value),
    };
    assert.deepEqual(await ensureExactResource(operation), { id: 'budget', status: 'created' });
    assert.deepEqual(await ensureExactResource(operation), { id: 'budget', status: 'unchanged' });
    const posts = requests.filter(({ method }) => method === 'POST');
    assert.deepEqual(posts, [{
      method: 'POST',
      url: `https://billingbudgets.googleapis.com/v1/billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets`,
      body: {
        displayName: 'Hong Kong Buddy Production V1 monthly guard',
        budgetFilter: {
          projects: [`projects/${PROJECT_NUMBER}`],
          calendarPeriod: 'MONTH',
          creditTypesTreatment: 'INCLUDE_ALL_CREDITS',
        },
        amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
        thresholdRules: [
          { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
          { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
          { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
          { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
        ],
        notificationsRule: {
          monitoringNotificationChannels: [CHANNEL], disableDefaultIamRecipients: false,
        },
      },
    }]);
  });

  for (const [name, creditTypesTreatment] of [
    ['missing', undefined],
    ['wrong', 'EXCLUDE_SPECIFIED_CREDITS'],
    ['malformed', 1],
  ]) {
    await t.test(`${name} credit type is drift before POST`, async () => {
      const budget = structuredClone(exactBudget);
      if (creditTypesTreatment === undefined) delete budget.budgetFilter.creditTypesTreatment;
      else budget.budgetFilter.creditTypesTreatment = creditTypesTreatment;
      const requests = [];
      const plane = planeFor(async (input) => {
        requests.push(input);
        if (input.method === 'GET') return { budgets: [budget] };
        throw new Error('POST must not run');
      });
      await plane.read('project');
      await assert.rejects(
        () => ensureExactResource({
          id: 'budget', mutate: true,
          read: () => plane.read('budget'),
          create: () => plane.create('budget', { notificationChannel: CHANNEL }),
          compare: (value) => plane.compare('budget', value),
        }),
        (error) => error.code === 'RESOURCE_DRIFT',
      );
      assert.equal(requests.some(({ method }) => method === 'POST'), false);

      const fixture = assetAuditControlPlane({
        contract, assets: [],
        enabledApis: [
          'iam.googleapis.com', 'serviceusage.googleapis.com', 'billingbudgets.googleapis.com',
        ],
        restRows: { '/budgets': { budgets: [budget] } },
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_COLLISION',
      );
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  await t.test('duplicate exact budgets are drift and never POST', async () => {
    const requests = [];
    const plane = planeFor(async (input) => {
      requests.push(input);
      if (input.method === 'GET') return { budgets: [exactBudget, { ...exactBudget }] };
      throw new Error('POST must not run');
    });
    await plane.read('project');
    await assert.rejects(
      () => ensureExactResource({
        id: 'budget', mutate: true,
        read: () => plane.read('budget'),
        create: () => plane.create('budget', { notificationChannel: CHANNEL }),
        compare: (value) => plane.compare('budget', value),
      }),
      (error) => error.code === 'RESOURCE_DRIFT',
    );
    assert.equal(requests.some(({ method }) => method === 'POST'), false);
  });
});

test('budget authority never infers a project number from project name fields', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: NUMERIC_CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return { projectId: PROJECT, name: `projects/${PROJECT_NUMBER}` };
      throw new Error('unexpected gcloud');
    },
    request: async (input) => { requests.push(input); return {}; },
  });
  await plane.read('project');
  await assert.rejects(
    () => plane.create('budget', { notificationChannel: NUMERIC_CHANNEL }),
    (error) => error.code === 'PROJECT_NUMBER_UNAVAILABLE',
  );
  assert.deepEqual(requests, []);
});

test('budget pagination respects the Billing Budgets API maximum page size', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
        parent: { type: 'organization', id: '797368190621' }, name: 'Hong Kong Buddy Production V1',
        labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
      };
      throw new Error('unexpected gcloud operation');
    },
    request: async (input) => {
      requests.push(input);
      return { budgets: [] };
    },
  });
  await plane.read('project');
  await plane.read('budget');
  assert.match(requests[0].url, /[?&]pageSize=100(?:&|$)/);
  assert.doesNotMatch(requests[0].url, /pageSize=1000/);
});

test('paginated secret-version, alert-policy, and budget readbacks cannot hide duplicate matches', async (t) => {
  const contract = await contractFixture();

  await t.test('enabled secret versions', async () => {
    const requests = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        if (input.url.includes(':access')) throw new Error('ambiguous versions must stop before access');
        if (input.url.includes('pageToken=second')) return {
          versions: [{ name: `projects/${PROJECT_NUMBER}/secrets/${GCP_IDENTITY.secrets.session}/versions/2`, state: 'ENABLED' }],
        };
        return {
          versions: [{ name: `projects/${PROJECT_NUMBER}/secrets/${GCP_IDENTITY.secrets.session}/versions/1`, state: 'ENABLED' }],
          nextPageToken: 'second',
        };
      },
    });
    plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
    assert.deepEqual(await plane.read(`secret-version:${GCP_IDENTITY.secrets.session}`), {
      status: 'present', value: { exact: false },
    });
    assert.equal(requests.length, 2);
  });

  await t.test('alert policies', async () => {
    const requests = [];
    const duplicate = { userLabels: { hkbuddy_contract: 'sql_backup_failure' } };
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        return input.url.includes('pageToken=second')
          ? { alertPolicies: [duplicate] }
          : { alertPolicies: [duplicate], nextPageToken: 'second' };
      },
    });
    assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
      status: 'present', value: { exact: false },
    });
    assert.equal(requests.length, 2);
  });

  await t.test('budgets', async () => {
    const requests = [];
    const duplicate = { displayName: 'Hong Kong Buddy Production V1 monthly guard' };
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async (args) => {
        if (args[0] === 'projects') return {
          projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
          parent: { type: 'organization', id: '797368190621' }, name: 'Hong Kong Buddy Production V1',
          labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
        };
        throw new Error('unexpected gcloud operation');
      },
      request: async (input) => {
        requests.push(input);
        return input.url.includes('pageToken=second')
          ? { budgets: [duplicate] }
          : { budgets: [duplicate], nextPageToken: 'second' };
      },
    });
    await plane.read('project');
    assert.deepEqual(await plane.read('budget'), {
      status: 'present', value: { exact: false },
    });
    assert.equal(requests.length, 2);
  });
});

test('secret-version list and access responses bind the exact cached numeric parent', async (t) => {
  const contract = await contractFixture();
  const secretId = GCP_IDENTITY.secrets.session;
  const versionName = `projects/${PROJECT_NUMBER}/secrets/${secretId}/versions/1`;
  const secretValue = Buffer.alloc(32, 0x41).toString('base64url');
  const readWith = async (options = {}) => {
    const listedName = options.listedName ?? versionName;
    const accessName = Object.hasOwn(options, 'accessName') ? options.accessName : versionName;
    const duplicate = options.duplicate ?? false;
    const requests = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        if (input.url.includes(':access')) {
          return { name: accessName, payload: { data: Buffer.from(secretValue).toString('base64') } };
        }
        const row = { name: listedName, state: 'ENABLED' };
        return { versions: duplicate ? [row, { ...row }] : [row] };
      },
    });
    plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
    return {
      requests,
      result: () => plane.read(`secret-version:${secretId}`),
    };
  };

  await t.test('live numeric list and access names pass', async () => {
    const fixture = await readWith();
    assert.deepEqual(await fixture.result(), {
      status: 'present', value: { version: '1', secretValue, exact: true },
    });
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.requests.every(({ method }) => method === 'GET'), true);
  });

  for (const [name, options] of [
    ['project ID list parent', { listedName: `projects/${PROJECT}/secrets/${secretId}/versions/1` }],
    ['foreign numeric list parent', { listedName: `projects/999999999999/secrets/${secretId}/versions/1` }],
    ['wrong secret list parent', { listedName: `projects/${PROJECT_NUMBER}/secrets/foreign/versions/1` }],
    ['malformed list descendant', { listedName: `${versionName}/extra` }],
    ['duplicate exact list row', { duplicate: true }],
  ]) {
    await t.test(name, async () => {
      const fixture = await readWith(options);
      await assert.rejects(fixture.result, (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS');
      assert.equal(fixture.requests.some(({ method }) => method !== 'GET'), false);
    });
  }

  for (const [name, accessName] of [
    ['project ID access parent', `projects/${PROJECT}/secrets/${secretId}/versions/1`],
    ['foreign numeric access parent', `projects/999999999999/secrets/${secretId}/versions/1`],
    ['wrong secret access parent', `projects/${PROJECT_NUMBER}/secrets/foreign/versions/1`],
    ['malformed access descendant', `${versionName}/extra`],
    ['missing access name', undefined],
  ]) {
    await t.test(name, async () => {
      const fixture = await readWith({ accessName });
      await assert.rejects(fixture.result, (error) => error.code === 'SECRET_VERSION_INVALID');
      assert.equal(fixture.requests.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('malformed successful list responses are ambiguous and can never trigger duplicate creation', async (t) => {
  for (const body of [null, 'not-an-object', []]) {
    await t.test(JSON.stringify(body), async () => {
      const requests = [];
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => { requests.push(input); return body; },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
      await assert.rejects(
        () => plane.read(`secret-version:${GCP_IDENTITY.secrets.session}`),
        (error) => error.code === 'PAGINATION_AMBIGUOUS',
      );
      assert.equal(requests.every(({ method }) => method === 'GET'), true);
    });
  }
});

test('REST NOT_FOUND injection cannot prove absence for any REST-backed resource', async (t) => {
  const contract = await contractFixture();
  for (const id of [
    'notification-channel',
    'monitoring-policy:sql-backup-failure',
    'budget',
    `secret-version:${GCP_IDENTITY.secrets.session}`,
    'db-user:hkbuddy_app',
  ]) {
    await t.test(id, async () => {
      const restCalls = [];
      const gcloudCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => { gcloudCalls.push(args); throw new Error('gcloud must not run'); },
        request: async (input) => {
          restCalls.push(input);
          throw Object.assign(new Error('private-request-secret'), { code: 'NOT_FOUND' });
        },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

      await assert.rejects(
        () => plane.read(id, { notificationChannel: CHANNEL }),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS'
          && !String(error).includes('private-request-secret')
          && !JSON.stringify(error).includes('private-request-secret'),
      );
      assert.equal(restCalls.length, 1);
      assert.equal(restCalls.every(({ method }) => method === 'GET'), true);
      assert.deepEqual(gcloudCalls, []);
    });
  }
});

test('canonical gcloud describe absence remains authoritative for control-plane reads', async () => {
  const executor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = `ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Repository [projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}] was not found.\n`;
      throw error;
    },
  });
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: executor,
    request: async () => { throw new Error('REST must not run'); },
  });

  assert.deepEqual(await plane.read('artifact-registry'), { status: 'absent' });
});

test('successful omitted REST collections remain authoritative absence evidence', async (t) => {
  const contract = await contractFixture();
  for (const id of [
    'monitoring-policy:sql-backup-failure',
    'budget',
    `secret-version:${GCP_IDENTITY.secrets.session}`,
    'db-user:hkbuddy_app',
  ]) {
    await t.test(id, async () => {
      const restCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => { restCalls.push(input); return {}; },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

      assert.deepEqual(await plane.read(id), { status: 'absent' });
      assert.equal(restCalls.length, 1);
      assert.equal(restCalls.every(({ method }) => method === 'GET'), true);
    });
  }
});

test('every non-paginated list readback rejects malformed shapes before any create', async (t) => {
  for (const body of [null, 'not-an-array', {}]) {
    await t.test(`gcloud arrays ${JSON.stringify(body)}`, async () => {
      for (const id of ['apis', 'psa-connection']) {
        const calls = [];
        const plane = new GcpControlPlane({
          contract: await contractFixture(), notificationChannel: CHANNEL,
          gcloud: async (args) => { calls.push(args); return body; },
          request: async () => { throw new Error('REST must not run'); },
        });
        await assert.rejects(() => plane.read(id), (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS');
        assert.equal(calls.some((args) => args.includes('enable') || args.includes('connect')), false);
      }
    });
  }

  for (const body of [null, 'not-an-object', [], { items: null }]) {
    await t.test(`SQL users ${JSON.stringify(body)}`, async () => {
      const requests = [];
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => { requests.push(input); return body; },
      });
      await assert.rejects(
        () => plane.read('db-user:hkbuddy_app'),
        (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
      );
      assert.equal(requests.every(({ method }) => method === 'GET'), true);
    });
  }

  await t.test('SQL users may omit items to express an exact empty list', async () => {
    const plane = new GcpControlPlane({
      contract: await contractFixture(), notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async () => ({}),
    });
    assert.deepEqual(await plane.read('db-user:hkbuddy_app'), { status: 'absent' });
  });

  for (const body of [null, 'not-an-array', {}]) {
    await t.test(`CIDR sources ${JSON.stringify(body)}`, async () => {
      const calls = [];
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async (args) => { calls.push(args); return body; },
        request: async () => { throw new Error('REST must not run'); },
      });
      await assert.rejects(() => plane.create('subnet'), (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS');
      assert.equal(calls.some((args) => args[0] === 'compute' && args[3] === 'create'), false);
    });
  }
});

test('PSA connection readback accepts only the installed gcloud identity and fails closed on drift', async (t) => {
  const contract = await contractFixture();
  const targetNetwork = `projects/${PROJECT_NUMBER}/global/networks/${GCP_IDENTITY.network}`;
  const exactConnection = {
    service: 'services/servicenetworking.googleapis.com', network: targetNetwork,
    peering: 'servicenetworking-googleapis-com',
    reservedPeeringRanges: [GCP_IDENTITY.psaRange],
  };
  const planeFor = (listing) => new GcpControlPlane({
    contract, notificationChannel: NUMERIC_CHANNEL,
    gcloud: async () => listing,
    request: async () => { throw new Error('REST must not run'); },
  });

  await t.test('real gcloud 553/API representation is exact', async () => {
    const plane = planeFor([exactConnection]);
    const readback = await plane.read('psa-connection');
    assert.deepEqual(readback, { status: 'present', value: exactConnection });
    assert.equal(plane.compare('psa-connection', readback.value), true);
  });

  await t.test('an exact empty list is absence', async () => {
    assert.deepEqual(await planeFor([]).read('psa-connection'), { status: 'absent' });
  });

  await t.test('first create reads empty, connects once, and accepts exact post-readback', async () => {
    const calls = [];
    let listing = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: NUMERIC_CHANNEL,
      gcloud: async (args) => {
        calls.push(args);
        if (args[0] === 'services' && args[1] === 'vpc-peerings' && args[2] === 'list') {
          return listing;
        }
        if (args[0] === 'services' && args[1] === 'vpc-peerings' && args[2] === 'connect') {
          listing = [exactConnection];
          return {};
        }
        throw new Error(`unexpected gcloud ${args.join(' ')}`);
      },
      request: async () => { throw new Error('REST must not run'); },
    });
    assert.deepEqual(await ensureExactResource({
      id: 'psa-connection', mutate: true,
      read: () => plane.read('psa-connection'),
      create: () => plane.create('psa-connection'),
      compare: (value) => plane.compare('psa-connection', value),
    }), { id: 'psa-connection', status: 'created' });
    assert.deepEqual(calls.filter((args) => args[2] === 'connect'), [[
      'services', 'vpc-peerings', 'connect', `--network=${GCP_IDENTITY.network}`,
      `--ranges=${GCP_IDENTITY.psaRange}`, '--service=servicenetworking.googleapis.com',
      `--project=${PROJECT}`, '--format=json',
    ]]);
  });

  await t.test('exact rerun reads once and never connects', async () => {
    const calls = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: NUMERIC_CHANNEL,
      gcloud: async (args) => { calls.push(args); return [exactConnection]; },
      request: async () => { throw new Error('REST must not run'); },
    });
    assert.deepEqual(await ensureExactResource({
      id: 'psa-connection', mutate: true,
      read: () => plane.read('psa-connection'),
      create: () => plane.create('psa-connection'),
      compare: (value) => plane.compare('psa-connection', value),
    }), { id: 'psa-connection', status: 'unchanged' });
    assert.equal(calls.length, 1);
    assert.equal(calls.some((args) => args[2] === 'connect'), false);
  });

  for (const [name, connection] of [
    ['project-ID network', {
      ...exactConnection,
      network: `projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
    }],
    ['foreign project number', {
      ...exactConnection,
      network: `projects/999999999999/global/networks/${GCP_IDENTITY.network}`,
    }],
    ['foreign project ID', {
      ...exactConnection,
      network: `projects/foreign-project/global/networks/${GCP_IDENTITY.network}`,
    }],
    ['unprefixed service', { ...exactConnection, service: 'servicenetworking.googleapis.com' }],
    ['malformed service', {
      ...exactConnection,
      service: 'services/servicenetworking.googleapis.com/connections/extra',
    }],
    ['missing peering', { ...exactConnection, peering: undefined }],
    ['wrong peering', { ...exactConnection, peering: 'foreign-peering' }],
    ['non-string peering', { ...exactConnection, peering: 1 }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => planeFor([connection]).read('psa-connection'),
        (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
      );
    });
  }

  await t.test('duplicate exact rows are ambiguous', async () => {
    await assert.rejects(
      () => planeFor([exactConnection, { ...exactConnection }]).read('psa-connection'),
      (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
    );
  });

  await t.test('a wrong range is present drift and cannot authorize creation', async () => {
    let creates = 0;
    const plane = planeFor([{
      ...exactConnection, reservedPeeringRanges: ['foreign-range'],
    }]);
    await assert.rejects(
      () => ensureExactResource({
        id: 'psa-connection', mutate: true,
        read: () => plane.read('psa-connection'),
        create: async () => { creates += 1; },
        compare: (value) => plane.compare('psa-connection', value),
      }),
      (error) => error.code === 'RESOURCE_DRIFT',
    );
    assert.equal(creates, 0);
  });

  await t.test('a singular range field is never an exact API representation', async () => {
    const plane = new GcpControlPlane({
      contract, notificationChannel: NUMERIC_CHANNEL,
      gcloud: async () => [{
        service: exactConnection.service, network: exactConnection.network,
        reservedPeeringRange: GCP_IDENTITY.psaRange,
      }],
      request: async () => { throw new Error('REST must not run'); },
    });
    await assert.rejects(
      () => plane.read('psa-connection'),
      (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
    );
  });
});

test('pre-mutation PSA audit accepts only exact scoped installed-gcloud connection rows', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
  const exactConnection = {
    service: 'services/servicenetworking.googleapis.com',
    network: `projects/${PROJECT_NUMBER}/global/networks/${GCP_IDENTITY.network}`,
    peering: 'servicenetworking-googleapis-com',
    reservedPeeringRanges: [GCP_IDENTITY.psaRange],
  };
  const fixtureFor = (connections) => assetAuditControlPlane({
    contract, assets: [],
    enabledApis: [
      'iam.googleapis.com', 'serviceusage.googleapis.com',
      'compute.googleapis.com', 'servicenetworking.googleapis.com',
    ],
    gcloudRows: {
      'compute networks list': [{
        name: GCP_IDENTITY.network, selfLink: network, autoCreateSubnetworks: false,
      }],
      'compute networks subnets': [],
      'compute routes list': [],
      'compute addresses list': [],
      'services vpc-peerings list': connections,
    },
  });

  await t.test('exact row', async () => {
    const fixture = fixtureFor([exactConnection]);
    assert.equal(await fixture.plane.auditPreMutationState(), true);
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
    assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
  });

  for (const [name, connections] of [
    ['malformed service', [{ ...exactConnection, service: 'servicenetworking.googleapis.com' }]],
    ['foreign project number', [{
      ...exactConnection,
      network: `projects/999999999999/global/networks/${GCP_IDENTITY.network}`,
    }]],
    ['duplicate rows', [exactConnection, { ...exactConnection }]],
  ]) {
    await t.test(name, async () => {
      const fixture = fixtureFor(connections);
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

function preflightGcloud({
  projectPresent = true, forbidden = false, billingCurrency = 'HKD',
  activeAccount = 'admin@motionexp.com', organizationResponse, billingAccountResponse,
  projectResponse, billingLinkResponse, releaseEvidenceRolePresent = true,
} = {}) {
  const calls = [];
  const gcloud = async (args) => {
    calls.push(args);
    if (forbidden && args[0] === 'projects') {
      const error = new Error('forbidden');
      error.code = 'FORBIDDEN';
      throw error;
    }
    if (args[0] === 'auth') return [{ account: activeAccount, status: 'ACTIVE' }];
    if (args[0] === 'organizations') return organizationResponse ?? {
      name: 'organizations/797368190621', displayName: 'motionexp.com', lifecycleState: 'ACTIVE',
    };
    if (args[0] === 'billing' && args[1] === 'accounts') return {
      name: 'billingAccounts/01F9FD-24EA9B-A9232C', open: true, currencyCode: billingCurrency,
      ...billingAccountResponse,
    };
    if (args[0] === 'billing' && args[1] === 'projects') return {
      billingEnabled: true, billingAccountName: 'billingAccounts/01F9FD-24EA9B-A9232C',
      ...billingLinkResponse,
    };
    if (args[0] === 'services' && args[1] === 'list') {
      return enabledServiceRows(['iam.googleapis.com', 'serviceusage.googleapis.com']);
    }
    if (args[0] === 'asset' && args[1] === 'search-all-resources') return [];
    if (args[0] === 'compute' && args[1] === 'networks' && args.includes('list')) return [{
      name: 'default', selfLink: `projects/${PROJECT}/global/networks/default`,
    }];
    if (args[0] === 'compute' && args[1] === 'networks' && args[2] === 'subnets') return [];
    if (args[0] === 'compute' && ['routes', 'addresses'].includes(args[1])) return [];
    if (args[0] === 'services' && args[1] === 'vpc-peerings') return [];
    if (args[0] === 'iam' && args[1] === 'service-accounts' && args.includes('list')) return [];
    if (args[0] === 'iam' && args[1] === 'roles' && args.includes('list')) {
      return releaseEvidenceRolePresent ? [{ name: RELEASE_EVIDENCE_OPERATOR_ROLE.name }] : [];
    }
    if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe'
      && args[3] === RELEASE_EVIDENCE_OPERATOR_ROLE.id) {
      if (releaseEvidenceRolePresent) return { ...RELEASE_EVIDENCE_OPERATOR_ROLE, deleted: false };
      throw notFound();
    }
    if (args[0] === 'compute' && args[1] === 'networks') return {
      name: 'default', autoCreateSubnetworks: true,
    };
    if (args[0] === 'projects') {
      if (args[1] === 'get-iam-policy') {
        return recoveredPreflightProjectPolicy();
      }
      if (projectPresent) return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER,
        parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
        name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
        ...projectResponse,
      };
      const error = new Error('not found');
      error.code = 'NOT_FOUND';
      throw error;
    }
    const error = new Error(`not found ${args.join(' ')}`);
    error.code = 'NOT_FOUND';
    throw error;
  };
  return { calls, gcloud };
}

test('preflight is read-only, project-explicit, and requires the existing shared project', async () => {
  const fixture = preflightGcloud();
  const output = [];
  const result = await runGcpPreflight({
    contract: await contractFixture(),
    gcloud: fixture.gcloud,
    request: preflightReadRequest(),
    getRestPrincipal: async () => 'admin@motionexp.com',
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.publicReport, {
    status: 'dry-run', code: 'GCP_PREFLIGHT_COMPLETE', projectId: PROJECT,
    projectNumber: PROJECT_NUMBER, projectState: 'present',
    alertChannel: 'not-supplied', mutationPerformed: false,
  });
  assert.equal(fixture.calls.some((args) => args[0] === 'services' && args[1] === 'list'), true);
  assert.equal(fixture.calls.every((args) => args.includes(`--project=${PROJECT}`)), true);
  assert.equal(fixture.calls.some((args) => args.includes('create') || args.includes('enable') || args.includes('link')), false);
  assert.deepEqual(output, [`${JSON.stringify(result.publicReport)}\n`]);
});

test('preflight distinguishes a known release-evidence IAM repair from reconciled or drifted state', async (t) => {
  const contract = await contractFixture();
  await t.test('missing exact role and binding is a named non-mutating repair requirement', async () => {
    const fixture = preflightGcloud({ releaseEvidenceRolePresent: false });
    const result = await runGcpPreflight({
      contract,
      gcloud: fixture.gcloud,
      request: preflightReadRequest(null, { includeReleaseEvidence: false }),
      getRestPrincipal: async () => 'admin@motionexp.com',
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.publicReport, {
      status: 'failed',
      code: 'RELEASE_EVIDENCE_IAM_REPAIR_REQUIRED',
      projectId: PROJECT,
      mutationPerformed: false,
      projectState: 'present',
      missingResources: [
        'custom-role:hkbuddyV1ReleaseEvidenceObjectOperator',
        'operator-release-evidence-iam-binding',
      ],
    });
    assert.equal(fixture.calls.some((args) => args.includes('create')), false);
  });

  for (const [name, releaseEvidenceRolePresent, includeReleaseEvidence, missingResource] of [
    [
      'missing exact role only reports that role',
      false,
      true,
      'custom-role:hkbuddyV1ReleaseEvidenceObjectOperator',
    ],
    [
      'missing exact binding only reports that binding',
      true,
      false,
      'operator-release-evidence-iam-binding',
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = preflightGcloud({ releaseEvidenceRolePresent });
      const result = await runGcpPreflight({
        contract,
        gcloud: fixture.gcloud,
        request: preflightReadRequest(null, { includeReleaseEvidence }),
        getRestPrincipal: async () => 'admin@motionexp.com',
        writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.publicReport, {
        status: 'failed',
        code: 'RELEASE_EVIDENCE_IAM_REPAIR_REQUIRED',
        projectId: PROJECT,
        mutationPerformed: false,
        projectState: 'present',
        missingResources: [missingResource],
      });
      assert.equal(fixture.calls.some((args) => args.includes('create')), false);
    });
  }

  await t.test('unknown conditional drift stays fatal', async () => {
    const fixture = preflightGcloud();
    const drifted = recoveredPreflightProjectPolicy();
    drifted.bindings.at(-1).condition.expression = 'true';
    const result = await runGcpPreflight({
      contract,
      gcloud: fixture.gcloud,
      request: async (input) => {
        if (input.url === `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`) {
          return drifted;
        }
        throw new Error(`unexpected request ${input.url}`);
      },
      getRestPrincipal: async () => 'admin@motionexp.com',
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
    assert.equal(result.publicReport.mutationPerformed, false);
  });
});

test('preflight and real control plane reject every noncanonical authority shape before inventory or mutation', async (t) => {
  const cases = [
    ['organization suffix', { organizationResponse: { name: `organizations/${GCP_IDENTITY.organizationId}/extra` } }],
    ['organization case', { organizationResponse: { name: `Organizations/${GCP_IDENTITY.organizationId}` } }],
    ['billing suffix', { billingAccountResponse: { name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/extra` } }],
    ['billing delimiter', { billingAccountResponse: { name: `billingAccounts:${GCP_IDENTITY.billingAccountId}` } }],
    ['project parent missing type', { projectResponse: { parent: { id: GCP_IDENTITY.organizationId } } }],
    ['project parent extra segment', { projectResponse: { parent: `organizations/${GCP_IDENTITY.organizationId}/extra` } }],
    ['billing link suffix', { billingLinkResponse: { billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}/extra` } }],
    ['billing link missing field', { billingLinkResponse: { billingAccountName: undefined } }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const fixture = preflightGcloud(overrides);
      const result = await runGcpPreflight({
        contract: await contractFixture(), gcloud: fixture.gcloud,
        getRestPrincipal: async () => 'admin@motionexp.com', writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(fixture.calls.some((args) => args[0] === 'asset'
        || args.includes('enable') || args.includes('create')), false);
    });
  }

  for (const [name, overrides] of cases.filter(([label]) => label.startsWith('project parent')
    || label.startsWith('billing link'))) {
    await t.test(`GcpControlPlane ${name}`, async () => {
      const contract = await contractFixture();
      const fixture = assetAuditControlPlane({
        contract, assets: [], projectResponse: overrides.projectResponse,
        billingLinkResponse: overrides.billingLinkResponse,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'SHARED_PROJECT_BASELINE_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args[0] === 'asset'
        || args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('real control plane independently validates canonical organization and billing account before Cloud Asset', async (t) => {
  const contract = await contractFixture();
  const unavailable = Object.assign(new Error('authority unavailable'), { code: 'TRANSPORT_AMBIGUOUS' });
  const cases = [
    ['organization malformed', { organizationResponse: { name: 'organizations/not-canonical' } }],
    ['organization inactive', { organizationResponse: { lifecycleState: 'DELETE_REQUESTED' } }],
    ['organization ambiguous', { organizationResponse: [] }],
    ['organization unavailable', { organizationResponse: unavailable }],
    ['billing malformed', { billingAccountResponse: { name: 'billingAccounts/not-canonical' } }],
    ['billing closed', { billingAccountResponse: { open: false } }],
    ['billing wrong currency', { billingAccountResponse: { currencyCode: 'USD' } }],
    ['billing ambiguous', { billingAccountResponse: [] }],
    ['billing unavailable', { billingAccountResponse: unavailable }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [], ...overrides });
      const originalGcloud = fixture.plane.gcloud;
      fixture.plane.gcloud = async (args, options) => {
        if (args[0] === 'organizations' && overrides.organizationResponse instanceof Error) {
          throw overrides.organizationResponse;
        }
        if (args[0] === 'billing' && args[1] === 'accounts'
          && overrides.billingAccountResponse instanceof Error) {
          throw overrides.billingAccountResponse;
        }
        return originalGcloud(args, options);
      };
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'SHARED_PROJECT_BASELINE_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args[0] === 'asset'
        || args.includes('enable') || args.includes('create')
        || args.includes('add-iam-policy-binding')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  const exact = assetAuditControlPlane({ contract, assets: [] });
  await exact.plane.auditPreMutationState();
  assert.deepEqual(exact.gcloudCalls.slice(0, 4).map((args) => args.slice(0, 3)), [
    ['projects', 'describe', PROJECT],
    ['billing', 'projects', 'describe'],
    ['organizations', 'describe', GCP_IDENTITY.organizationId],
    ['billing', 'accounts', 'describe'],
  ]);
  const assetIndex = exact.gcloudCalls.findIndex((args) => args[0] === 'asset');
  assert.equal(assetIndex > 3, true);
});

test('real control plane rejects each missing protected baseline binding before any mutation', async (t) => {
  const contract = await contractFixture();
  for (const missing of contract.project.protectedBindings) {
    await t.test(`${missing.role} ${missing.member}`, async () => {
      const gcloudCalls = [];
      const restCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => {
          gcloudCalls.push(args);
          if (args[0] === 'projects' && args[1] === 'describe') return {
            projectId: PROJECT, projectNumber: PROJECT_NUMBER,
            parent: { type: 'organization', id: GCP_IDENTITY.organizationId }, name: 'Motion Expert HK LTD Webpage',
            labels: {}, lifecycleState: 'ACTIVE',
          };
          if (args[0] === 'organizations' && args[1] === 'describe') return {
            name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
          };
          if (args[0] === 'billing' && args[1] === 'accounts') return {
            name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
          };
          if (args[0] === 'billing' && args[1] === 'projects') return {
            billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
          };
          if (args[0] === 'services' && args[1] === 'list') {
            return enabledServiceRows(['iam.googleapis.com', 'serviceusage.googleapis.com']);
          }
          if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'keys') return [];
          if (args[0] === 'asset' && args[1] === 'search-all-resources') return [];
          if (args[0] === 'projects' && args[1] === 'get-iam-policy') return {
            bindings: contract.project.protectedBindings.filter((binding) => binding !== missing).map(({ role, member }) => ({ role, members: [member] })),
          };
          throw new Error(`unexpected gcloud ${args.join(' ')}`);
        },
        request: async (input) => { restCalls.push(input); throw new Error('REST must not run'); },
      });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract, controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(gcloudCalls.some((args) => args.includes('enable') || args.includes('create')
        || args.includes('add-iam-policy-binding') || args.includes('set-iam-policy')
        || args.includes('remove-iam-policy-binding')), false);
      assert.deepEqual(restCalls, []);
    });
  }
});

test('real control plane completes narrow IAM recovery before no-channel API discovery', async () => {
  const contract = await contractFixture();
  const calls = [];
  const enabledBefore = ['iam.googleapis.com', 'serviceusage.googleapis.com'];
  const allApis = [
    'cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com', 'cloudbilling.googleapis.com',
    'billingbudgets.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com',
    'policytroubleshooter.googleapis.com', 'artifactregistry.googleapis.com',
    'cloudbuild.googleapis.com', 'containeranalysis.googleapis.com',
    'run.googleapis.com', 'compute.googleapis.com', 'servicenetworking.googleapis.com',
    'sqladmin.googleapis.com', 'storage.googleapis.com', 'secretmanager.googleapis.com', 'aiplatform.googleapis.com',
    'speech.googleapis.com', 'texttospeech.googleapis.com', 'monitoring.googleapis.com', 'logging.googleapis.com',
  ];
  let apisEnabled = false;
  let operatorRoleCreated = false;
  let operatorBindingCreated = false;
  let releaseEvidenceRoleCreated = false;
  let releaseEvidenceBindingCreated = false;
  const notFound = () => Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  const plane = new GcpControlPlane({
    contract, notificationChannel: null,
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'projects' && args[1] === 'describe') return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER,
        parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
        name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
      };
      if (args[0] === 'organizations' && args[1] === 'describe') return {
        name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
      };
      if (args[0] === 'billing' && args[1] === 'accounts') return {
        name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
      };
      if (args[0] === 'billing' && args[1] === 'projects') return {
        billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
      };
      if (args[0] === 'projects' && args[1] === 'get-iam-policy') {
        return operatorProjectPolicy(contract, {
          includeOperator: operatorBindingCreated,
          includeReleaseEvidence: releaseEvidenceBindingCreated,
        });
      }
      if (args[0] === 'asset' && args[1] === 'search-all-resources') return [];
      if (args[0] === 'iam' && args.includes('list')) return [];
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
        if (args[3] === BUCKET_IAM_OPERATOR_ROLE.id && operatorRoleCreated) {
          return { ...BUCKET_IAM_OPERATOR_ROLE, deleted: false };
        }
        if (args[3] === RELEASE_EVIDENCE_OPERATOR_ROLE.id && releaseEvidenceRoleCreated) {
          return { ...RELEASE_EVIDENCE_OPERATOR_ROLE, deleted: false };
        }
        throw notFound();
      }
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'create') {
        if (args[3] === BUCKET_IAM_OPERATOR_ROLE.id) {
          operatorRoleCreated = true;
          return { ...BUCKET_IAM_OPERATOR_ROLE, deleted: false };
        }
        assert.equal(args[3], RELEASE_EVIDENCE_OPERATOR_ROLE.id);
        releaseEvidenceRoleCreated = true;
        return { ...RELEASE_EVIDENCE_OPERATOR_ROLE, deleted: false };
      }
      if (args[0] === 'services' && args[1] === 'list') {
        return enabledServiceRows(apisEnabled ? allApis : enabledBefore);
      }
      if (args[0] === 'services' && args[1] === 'enable') { apisEnabled = true; return {}; }
      throw notFound();
    },
    request: async (input) => {
      if (input.url.endsWith(':getIamPolicy')) {
        return operatorProjectPolicy(contract, {
          includeOperator: operatorBindingCreated,
          includeReleaseEvidence: releaseEvidenceBindingCreated,
        });
      }
      if (input.url.endsWith(':setIamPolicy')) {
        operatorBindingCreated = input.body.policy.bindings.some(({ role }) => (
          role === BUCKET_IAM_OPERATOR_BINDING.role
        ));
        releaseEvidenceBindingCreated = input.body.policy.bindings.some(({ role }) => (
          role === RELEASE_EVIDENCE_OPERATOR_BINDING.role
        ));
        return operatorProjectPolicy(contract, {
          includeOperator: operatorBindingCreated,
          includeReleaseEvidence: releaseEvidenceBindingCreated,
          etag: 'BwYAAAAAAAg=',
        });
      }
      throw new Error('unexpected REST before channel');
    },
  });
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`], contract, controlPlane: plane, writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'ALERT_CHANNEL_REQUIRED');
  assert.deepEqual(calls.find((args) => args[0] === 'asset' && args[1] === 'search-all-resources'), [
    'asset', 'search-all-resources', `--scope=projects/${PROJECT}`,
    `--billing-project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`,
    `--project=${PROJECT}`, '--page-size=500', `--read-mask=${ASSET_READ_MASK}`,
    '--order-by=assetType,name', '--format=json',
  ]);
  assert.equal(calls.some((args) => args.includes(`--project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`)), false);
  assert.deepEqual(calls.filter((args) => args.includes('enable')).map((args) => args.slice(0, 2)), [['services', 'enable']]);
  assert.deepEqual(
    calls.filter((args) => args.includes('create')).map((args) => args.slice(0, 4)),
    [
      ['iam', 'roles', 'create', BUCKET_IAM_OPERATOR_ROLE.id],
      ['iam', 'roles', 'create', RELEASE_EVIDENCE_OPERATOR_ROLE.id],
    ],
  );
  assert.equal(calls.some((args) => args.includes('add-iam-policy-binding')), false);
});

test('real Cloud Asset audit fails closed before host mutation for disabled-service inventory ambiguity and foreign aliases', async (t) => {
  const contract = await contractFixture();
  const baseline = async (args, assets) => {
    if (args[0] === 'projects' && args[1] === 'describe') return {
      projectId: PROJECT, projectNumber: PROJECT_NUMBER,
      parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
      name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
    };
    if (args[0] === 'organizations' && args[1] === 'describe') return {
      name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
    };
    if (args[0] === 'billing' && args[1] === 'accounts') return {
      name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
    };
    if (args[0] === 'billing' && args[1] === 'projects') return {
      billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
    };
    if (args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'keys') return [];
    if (args[0] === 'asset' && args[1] === 'search-all-resources') {
      if (assets instanceof Error) throw assets;
      return assets;
    }
    throw new Error(`unexpected gcloud ${args.join(' ')}`);
  };
  const targetProject = `projects/${PROJECT}`;
  const unavailable = Object.assign(new Error('Cloud Asset API is disabled'), { code: 'FORBIDDEN' });
  const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  });
  const cases = [
    ...[
      ['Cloud Run service', 'run.googleapis.com/Service', `//run.googleapis.com/${targetProject}/locations/asia-east2/services/hkbuddy-v1-foreign`],
      ['VPC', 'compute.googleapis.com/Network', `//compute.googleapis.com/${targetProject}/global/networks/hkbuddy-v1-foreign`],
      ['Artifact Registry repository', 'artifactregistry.googleapis.com/Repository', `//artifactregistry.googleapis.com/${targetProject}/locations/asia-east2/repositories/hkbuddy-v1-foreign`],
      ['Cloud SQL instance', 'sqladmin.googleapis.com/Instance', `//cloudsql.googleapis.com/${targetProject}/instances/hkbuddy-v1-foreign`],
      ['bucket', 'storage.googleapis.com/Bucket', '//storage.googleapis.com/hkbuddy-v1-foreign'],
      ['secret', 'secretmanager.googleapis.com/Secret', `//secretmanager.googleapis.com/${targetProject}/secrets/hkbuddy-v1-foreign`],
      ['custom role', 'iam.googleapis.com/Role', `//iam.googleapis.com/${targetProject}/roles/hkbuddyV1Foreign`],
    ].map(([family, assetType, name]) => [`disabled-service foreign ${family} alias`, [cloudAsset({
      name, assetType, project: ASSET_PROJECT,
      displayName: family === 'custom role' ? 'hkbuddyV1Foreign' : 'hkbuddy-v1-foreign',
      location: family === 'custom role' ? 'global' : 'asia-east2',
    })], 'RESOURCE_COLLISION']),
    ['ambiguous asset payload', [{ name: 'missing-asset-type', project: targetProject }], 'CLOUD_ASSET_INVENTORY_AMBIGUOUS'],
    ['wrong project asset', [{
      name: '//run.googleapis.com/projects/foreign/locations/asia-east2/services/hkbuddy-v1-foreign',
      assetType: 'run.googleapis.com/Service', project: 'projects/999999999999', displayName: 'hkbuddy-v1-foreign',
      parentFullResourceName: '//cloudresourcemanager.googleapis.com/projects/999999999999',
      parentAssetType: ASSET_PROJECT_TYPE, location: 'asia-east2', labels: {}, state: 'ACTIVE',
    }], 'CLOUD_ASSET_INVENTORY_WRONG_PROJECT'],
    ['Cloud Asset unavailable', unavailable, 'CLOUD_ASSET_INVENTORY_UNAVAILABLE'],
    ['Cloud Asset output overflow', overflow, 'CLOUD_ASSET_INVENTORY_UNAVAILABLE'],
  ];
  for (const [name, assets, code] of cases) {
    await t.test(name, async () => {
      const calls = [];
      const restCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => { calls.push(args); return baseline(args, assets); },
        request: async (input) => { restCalls.push(input); throw new Error('REST must not run'); },
      });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract, controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, code);
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.deepEqual(calls.find((args) => args[0] === 'asset'), [
        'asset', 'search-all-resources', `--scope=projects/${PROJECT}`,
        `--billing-project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`,
        `--project=${PROJECT}`, '--page-size=500', `--read-mask=${ASSET_READ_MASK}`,
        '--order-by=assetType,name', '--format=json',
      ]);
      assert.equal(calls.some((args) => args.includes('enable') || args.includes('create')
        || args.includes('add-iam-policy-binding') || args.includes('set-iam-policy')
        || args.includes('remove-iam-policy-binding')), false);
      assert.deepEqual(restCalls, []);
    });
  }
});

test('Cloud Asset retrieval is exhaustive and exactly 1000 valid rows cannot imply truncation', async () => {
  const contract = await contractFixture();
  const assets = Array.from({ length: 1_000 }, (_unused, index) => cloudAsset({
    name: `//compute.googleapis.com/projects/${PROJECT}/zones/asia-east2-a/disks/unrelated-${index}`,
    assetType: 'compute.googleapis.com/Disk',
    displayName: `unrelated-${index}`,
    location: 'asia-east2-a',
  }));
  const fixture = assetAuditControlPlane({ contract, assets });
  await fixture.plane.auditPreMutationState();
  const argv = fixture.gcloudCalls.find((args) => args[0] === 'asset');
  assert.equal(argv.includes('--limit=1000'), false);
  assert.deepEqual(argv, [
    'asset', 'search-all-resources', `--scope=projects/${PROJECT}`,
    `--billing-project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`,
    `--project=${PROJECT}`, '--page-size=500', `--read-mask=${ASSET_READ_MASK}`,
    '--order-by=assetType,name', '--format=json',
  ]);
  assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
  assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('Cloud Asset accepts the live Artifact Registry resource display name exactly', async () => {
  const contract = await contractFixture();
  const repositoryPath = `projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`;
  const repository = cloudAsset({
    name: `//artifactregistry.googleapis.com/${repositoryPath}`,
    assetType: 'artifactregistry.googleapis.com/Repository',
    displayName: repositoryPath,
    description: 'Hong Kong Buddy production containers',
  });
  const accepted = assetAuditControlPlane({ contract, assets: [repository] });

  assert.equal(await accepted.plane.auditPreMutationState(), true);
  assert.equal(accepted.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  assert.equal(accepted.restCalls.some(({ method }) => method !== 'GET'), false);

  const foreignDisplayName = assetAuditControlPlane({
    contract,
    assets: [{ ...repository, displayName: repositoryPath.replace(`projects/${PROJECT}/`, 'projects/foreign/') }],
  });
  await assert.rejects(
    () => foreignDisplayName.plane.auditPreMutationState(),
    (error) => error.code === 'RESOURCE_COLLISION',
  );
  assert.equal(foreignDisplayName.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  assert.equal(foreignDisplayName.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('Cloud Asset accepts the live numeric Secret resource and display names exactly', async () => {
  const contract = await contractFixture();
  const secretId = GCP_IDENTITY.secrets.dbAppUrl;
  const secretPath = `projects/${PROJECT_NUMBER}/secrets/${secretId}`;
  const fixture = assetAuditControlPlane({
    contract,
    assets: [cloudAsset({
      name: `//secretmanager.googleapis.com/${secretPath}`,
      assetType: 'secretmanager.googleapis.com/Secret',
      displayName: secretPath,
      location: 'global',
    })],
  });

  assert.equal(await fixture.plane.auditPreMutationState(), true);
  assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('Cloud Asset accepts only exact enabled numeric versions beneath managed Secrets', async (t) => {
  const contract = await contractFixture();
  const secretId = GCP_IDENTITY.secrets.dbAppUrl;
  const secretPath = `projects/${PROJECT_NUMBER}/secrets/${secretId}`;
  const versionPath = `${secretPath}/versions/1`;
  const exactVersion = cloudAsset({
    name: `//secretmanager.googleapis.com/${versionPath}`,
    assetType: 'secretmanager.googleapis.com/SecretVersion',
    displayName: versionPath,
    location: 'global',
    parentFullResourceName: `//secretmanager.googleapis.com/${secretPath}`,
    parentAssetType: 'secretmanager.googleapis.com/Secret',
    state: 'ENABLED',
  });
  const accepted = assetAuditControlPlane({ contract, assets: [exactVersion] });
  assert.equal(await accepted.plane.auditPreMutationState(), true);
  assert.equal(accepted.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  assert.equal(accepted.restCalls.some(({ method }) => method !== 'GET'), false);

  for (const [name, version] of [
    ['non-numeric version', { ...exactVersion, name: exactVersion.name.replace('/versions/1', '/versions/latest') }],
    ['foreign managed secret', {
      ...exactVersion,
      name: exactVersion.name.replace(secretId, 'hkbuddy-v1-foreign'),
      displayName: exactVersion.displayName.replace(secretId, 'hkbuddy-v1-foreign'),
      parentFullResourceName: exactVersion.parentFullResourceName.replace(secretId, 'hkbuddy-v1-foreign'),
    }],
    ['wrong display', { ...exactVersion, displayName: `${versionPath}/extra` }],
    ['wrong parent', { ...exactVersion, parentFullResourceName: `${exactVersion.parentFullResourceName}/extra` }],
    ['wrong parent type', { ...exactVersion, parentAssetType: 'cloudresourcemanager.googleapis.com/Project' }],
    ['disabled state', { ...exactVersion, state: 'DISABLED' }],
    ['destroyed state', { ...exactVersion, state: 'DESTROYED' }],
  ]) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [version] });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_COLLISION',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Cloud Asset rejects Secret project aliases malformed identities displays and duplicate rows', async (t) => {
  const contract = await contractFixture();
  const secretId = GCP_IDENTITY.secrets.dbAppUrl;
  const secretPath = `projects/${PROJECT_NUMBER}/secrets/${secretId}`;
  const exactSecret = cloudAsset({
    name: `//secretmanager.googleapis.com/${secretPath}`,
    assetType: 'secretmanager.googleapis.com/Secret',
    displayName: secretPath,
    location: 'global',
  });
  for (const [name, assets, code] of [
    ['project ID resource name', [{
      ...exactSecret, name: `//secretmanager.googleapis.com/projects/${PROJECT}/secrets/${secretId}`,
    }], 'RESOURCE_COLLISION'],
    ['foreign numeric resource name', [{
      ...exactSecret, name: `//secretmanager.googleapis.com/projects/999999999999/secrets/${secretId}`,
    }], 'RESOURCE_COLLISION'],
    ['project ID display name', [{
      ...exactSecret, displayName: `projects/${PROJECT}/secrets/${secretId}`,
    }], 'RESOURCE_COLLISION'],
    ['foreign numeric display name', [{
      ...exactSecret, displayName: `projects/999999999999/secrets/${secretId}`,
    }], 'RESOURCE_COLLISION'],
    ['malformed resource descendant', [{ ...exactSecret, name: `${exactSecret.name}/versions/1` }], 'RESOURCE_COLLISION'],
    ['missing display name', [{ ...exactSecret, displayName: undefined }], 'CLOUD_ASSET_INVENTORY_AMBIGUOUS'],
    ['duplicate exact row', [exactSecret, { ...exactSecret }], 'CLOUD_ASSET_INVENTORY_AMBIGUOUS'],
  ]) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === code,
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Cloud Asset accepts exact managed service-account key descendants only after the user-key audit', async () => {
  const contract = await contractFixture();
  const email = GCP_IDENTITY.serviceAccounts.runtime;
  const keyId = 'a'.repeat(40);
  const keyAsset = {
    name: `//iam.googleapis.com/projects/${PROJECT}/serviceAccounts/101929703898041757987/keys/${keyId}`,
    assetType: 'iam.googleapis.com/ServiceAccountKey',
    project: ASSET_PROJECT,
    displayName: `projects/${PROJECT}/serviceAccounts/${email}/keys/${keyId}`,
    location: 'global',
    parentFullResourceName: `//iam.googleapis.com/projects/${PROJECT}/serviceAccounts/${email}`,
    parentAssetType: 'iam.googleapis.com/ServiceAccount',
  };
  const accepted = assetAuditControlPlane({ contract, assets: [keyAsset] });
  assert.equal(await accepted.plane.auditPreMutationState(), true);
  assert.equal(accepted.gcloudCalls.filter((args) => (
    args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'keys'
      && args.includes('--managed-by=user')
  )).length, contract.resources.serviceAccounts.length);

  const userManaged = assetAuditControlPlane({
    contract,
    assets: [keyAsset],
    gcloudRows: { 'iam service-accounts keys': [{ name: 'user-managed-key' }] },
  });
  await assert.rejects(
    () => userManaged.plane.auditPreMutationState(),
    (error) => error.code === 'USER_MANAGED_SERVICE_ACCOUNT_KEY',
  );
  assert.equal(userManaged.gcloudCalls.some((args) => args[0] === 'asset'), false);

  const foreignParent = assetAuditControlPlane({
    contract,
    assets: [{
      ...keyAsset,
      parentFullResourceName: `//iam.googleapis.com/projects/${PROJECT}/serviceAccounts/foreign@${PROJECT}.iam.gserviceaccount.com`,
    }],
  });
  await assert.rejects(
    () => foreignParent.plane.auditPreMutationState(),
    (error) => error.code === 'RESOURCE_COLLISION',
  );
});

test('Cloud Asset managed identities require exact type name numeric project field canonical parent and metadata shapes', async (t) => {
  const contract = await contractFixture();
  const exactService = cloudAsset();
  const cases = [
    ['expected service token on Secret type', cloudAsset({
      name: `//secretmanager.googleapis.com/projects/${PROJECT}/secrets/${GCP_IDENTITY.service}`,
      assetType: 'secretmanager.googleapis.com/Secret',
    })],
    ['malformed full name', cloudAsset({ name: `projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}` })],
    ['wrong service prefix', cloudAsset({ name: `//evil.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}` })],
    ['wrong project segment', cloudAsset({ name: `//run.googleapis.com/projects/foreign/locations/asia-east2/services/${GCP_IDENTITY.service}` })],
    ['missing parent', { ...exactService, parentFullResourceName: undefined }],
    ['wrong parent', cloudAsset({ parentFullResourceName: '//cloudresourcemanager.googleapis.com/projects/999999999999' })],
    ['wrong parent type', cloudAsset({ parentAssetType: 'run.googleapis.com/Service' })],
    ['wrong location', cloudAsset({ location: 'us-central1' })],
    ['case variant custom role', cloudAsset({
      name: `//iam.googleapis.com/projects/${PROJECT}/roles/HkbuddyV1AcceptanceBucketMetadataReader`,
      assetType: 'iam.googleapis.com/Role', displayName: 'HkbuddyV1AcceptanceBucketMetadataReader',
      location: 'global',
    })],
  ];
  for (const [name, asset] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [asset] });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => ['RESOURCE_COLLISION', 'CLOUD_ASSET_INVENTORY_AMBIGUOUS'].includes(error.code),
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  for (const [field, value] of [
    ['displayName', 1], ['description', []], ['location', {}], ['labels', []], ['state', false],
  ]) {
    await t.test(`malformed optional ${field}`, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [cloudAsset({ [field]: value })] });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CLOUD_ASSET_INVENTORY_AMBIGUOUS',
      );
    });
  }
});

test('live Monitoring channel identity composes project-ID REST names with numeric Cloud Asset names', async () => {
  const contract = await contractFixture();
  const channel = {
    name: PROJECT_ID_CHANNEL,
    displayName: 'HK Buddy V1 operations',
    type: 'email',
    enabled: true,
    verificationStatus: 'VERIFIED',
    labels: { email_address: 'admin@motionexp.com' },
    userLabels: {
      application: 'hong_kong_buddy',
      environment: 'production_v1',
      hkbuddy_contract: 'operations',
    },
  };
  const fixture = assetAuditControlPlane({
    contract,
    assets: [cloudAsset({
      name: `//monitoring.googleapis.com/projects/${PROJECT_NUMBER}/notificationChannels/123456789`,
      assetType: 'monitoring.googleapis.com/NotificationChannel',
      project: `projects/${PROJECT_NUMBER}`,
      displayName: 'HK Buddy V1 operations',
      labels: { email_address: 'admin@motionexp.com', resolve_delivery_enabled: 'true' },
      location: 'global',
      parentFullResourceName: `//cloudresourcemanager.googleapis.com/projects/${PROJECT}`,
      parentAssetType: 'cloudresourcemanager.googleapis.com/Project',
      state: 'VERIFICATION_STATUS_VERIFIED',
    })],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'monitoring.googleapis.com'],
    restRows: {
      '/alertPolicies': { alertPolicies: [] },
      '/notificationChannels': ({ url }) => (
        url.includes('pageSize=1000') ? { notificationChannels: [channel] } : channel
      ),
    },
  });

  await fixture.plane.auditPreMutationState({ notificationChannel: PROJECT_ID_CHANNEL });
  assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);

  const rejected = assetAuditControlPlane({
    contract,
    assets: [cloudAsset({
      name: `//monitoring.googleapis.com/projects/${PROJECT_NUMBER}/notificationChannels/123456789`,
      assetType: 'monitoring.googleapis.com/NotificationChannel',
      project: `projects/${PROJECT_NUMBER}`,
      displayName: 'HK Buddy V1 operations',
      labels: { email_address: 'admin@motionexp.com', resolve_delivery_enabled: 'false' },
      location: 'global',
      parentFullResourceName: `//cloudresourcemanager.googleapis.com/projects/${PROJECT}`,
      parentAssetType: 'cloudresourcemanager.googleapis.com/Project',
      state: 'VERIFICATION_STATUS_VERIFIED',
    })],
  });
  await assert.rejects(
    () => rejected.plane.auditPreMutationState(),
    (error) => error.code === 'RESOURCE_COLLISION',
  );
});

test('an omitted default verification enum is classified as an unverified managed channel', async () => {
  const contract = await contractFixture();
  const fixture = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'monitoring.googleapis.com'],
    restRows: {
      '/alertPolicies': { alertPolicies: [] },
      '/notificationChannels': { notificationChannels: [{
        name: PROJECT_ID_CHANNEL,
        displayName: 'HK Buddy V1 operations',
        type: 'email',
        enabled: true,
        labels: { email_address: 'admin@motionexp.com' },
        userLabels: {
          application: 'hong_kong_buddy',
          environment: 'production_v1',
          hkbuddy_contract: 'operations',
        },
      }] },
    },
  });

  await assert.rejects(
    () => fixture.plane.auditPreMutationState(),
    (error) => error.code === 'RESOURCE_COLLISION',
  );
});

test('Monitoring inventory rejects a managed channel for a different email address', async () => {
  const contract = await contractFixture();
  const fixture = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'monitoring.googleapis.com'],
    restRows: {
      '/alertPolicies': { alertPolicies: [] },
      '/notificationChannels': { notificationChannels: [{
        name: PROJECT_ID_CHANNEL,
        displayName: 'HK Buddy V1 operations',
        type: 'email',
        enabled: true,
        verificationStatus: 'VERIFIED',
        labels: { email_address: 'attacker@example.test' },
        userLabels: {
          application: 'hong_kong_buddy',
          environment: 'production_v1',
          hkbuddy_contract: 'operations',
        },
      }] },
    },
  });

  await assert.rejects(
    () => fixture.plane.auditPreMutationState(),
    (error) => error.code === 'RESOURCE_COLLISION',
  );
});

test('Cloud Asset PSA connection identity requires the numeric project in name and parent', async () => {
  const contract = await contractFixture();
  const exactConnection = cloudAsset({
    name: `//servicenetworking.googleapis.com/projects/${PROJECT_NUMBER}/global/networks/${GCP_IDENTITY.network}`,
    assetType: 'servicenetworking.googleapis.com/Connection',
    displayName: GCP_IDENTITY.network,
    location: 'global',
    parentFullResourceName: `//cloudresourcemanager.googleapis.com/projects/${PROJECT_NUMBER}`,
    parentAssetType: 'cloudresourcemanager.googleapis.com/Project',
  });
  const accepted = assetAuditControlPlane({ contract, assets: [exactConnection] });
  assert.equal(await accepted.plane.auditPreMutationState(), true);

  const projectIdConnection = {
    ...exactConnection,
    name: `//servicenetworking.googleapis.com/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
    parentFullResourceName: `//cloudresourcemanager.googleapis.com/projects/${PROJECT}`,
  };
  const rejected = assetAuditControlPlane({ contract, assets: [projectIdConnection] });
  await assert.rejects(
    () => rejected.plane.auditPreMutationState(),
    (error) => error.code === 'RESOURCE_COLLISION',
  );
  assert.equal(rejected.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  assert.equal(rejected.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('Cloud Asset accepts the exact live Cloud SQL name and only canonical BackupRun descendants', async (t) => {
  const contract = await contractFixture();
  const instanceName = `//cloudsql.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}`;
  const instance = cloudAsset({
    name: instanceName,
    assetType: 'sqladmin.googleapis.com/Instance',
    displayName: GCP_IDENTITY.cloudSqlInstance,
    location: 'asia-east2',
    state: 'RUNNABLE',
  });
  const backupRun = {
    name: `${instanceName}/backupRuns/1787973381153`,
    assetType: 'sqladmin.googleapis.com/BackupRun',
    project: ASSET_PROJECT,
    location: 'asia-east1',
    parentFullResourceName: instanceName,
    parentAssetType: 'sqladmin.googleapis.com/Instance',
    state: 'RUNNING',
  };
  const projectBackup = {
    name: `//cloudsql.googleapis.com/projects/${PROJECT}/backups/18378fa3-1e80-4ae9-8b7a-bc87f6e45095`,
    assetType: 'sqladmin.googleapis.com/Backup',
    project: ASSET_PROJECT,
    location: 'asia-east1',
    parentFullResourceName: ASSET_PROJECT_PARENT,
    parentAssetType: ASSET_PROJECT_TYPE,
    state: 'ENQUEUED',
  };
  const accepted = assetAuditControlPlane({ contract, assets: [instance, backupRun, projectBackup] });
  assert.equal(await accepted.plane.auditPreMutationState(), true);
  const liveBackupRun = { ...backupRun };
  delete liveBackupRun.parentAssetType;
  const acceptedLiveShape = assetAuditControlPlane({
    contract, assets: [instance, liveBackupRun, projectBackup],
  });
  assert.equal(await acceptedLiveShape.plane.auditPreMutationState(), true);
  for (const [location, state] of [
    ['asia', 'SUCCESSFUL'],
    ['europe-west12', 'FAILED'],
  ]) {
    const lifecycle = assetAuditControlPlane({
      contract, assets: [instance, { ...backupRun, location, state }],
    });
    assert.equal(await lifecycle.plane.auditPreMutationState(), true);
  }

  const invalid = [
    ['legacy instance authority', {
      ...instance,
      name: `//sqladmin.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}`,
    }],
    ['instance foreign display name', { ...instance, displayName: `${GCP_IDENTITY.cloudSqlInstance}-foreign` }],
    ['backup wrong type', { ...backupRun, assetType: 'sqladmin.googleapis.com/Backup' }],
    ['backup foreign project in name', { ...backupRun, name: backupRun.name.replace(`/projects/${PROJECT}/`, '/projects/foreign/') }],
    ['backup foreign parent', { ...backupRun, parentFullResourceName: `${instanceName}-foreign` }],
    ['backup wrong parent type', { ...backupRun, parentAssetType: 'cloudresourcemanager.googleapis.com/Project' }],
    ['backup zero id', { ...backupRun, name: `${instanceName}/backupRuns/0` }],
    ['backup negative id', { ...backupRun, name: `${instanceName}/backupRuns/-1` }],
    ['backup nonnumeric id', { ...backupRun, name: `${instanceName}/backupRuns/not-a-number` }],
    ['backup noncanonical id', { ...backupRun, name: `${instanceName}/backupRuns/01787973381153` }],
    ['backup id outside signed int64', { ...backupRun, name: `${instanceName}/backupRuns/9223372036854775808` }],
    ['backup noncanonical location', { ...backupRun, location: 'somewhere' }],
    ['backup unknown lifecycle state', { ...backupRun, state: 'READY' }],
    ['foreign child under exact instance', {
      ...backupRun,
      name: `${instanceName}/foreignChildren/1787973381153`,
      assetType: 'foreign.googleapis.com/Child',
    }],
  ];
  for (const [name, asset] of invalid) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [asset] });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_COLLISION',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  const wrongNumericProject = assetAuditControlPlane({
    contract, assets: [{ ...backupRun, project: 'projects/999999999999' }],
  });
  await assert.rejects(
    () => wrongNumericProject.plane.auditPreMutationState(),
    (error) => error.code === 'CLOUD_ASSET_INVENTORY_WRONG_PROJECT',
  );
});

test('every exact managed top-level Cloud Asset identity is rejected on every wrong asset type', async (t) => {
  const contract = await contractFixture();
  const identities = [
    ['service', `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}`, GCP_IDENTITY.service, 'asia-east2'],
    ['repository', `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`, GCP_IDENTITY.repository, 'asia-east2'],
    ['bucket', `//storage.googleapis.com/${GCP_IDENTITY.bucket}`, GCP_IDENTITY.bucket, 'asia-east2'],
    ['build source bucket', `//storage.googleapis.com/${GCP_IDENTITY.buildSourceBucket}`, GCP_IDENTITY.buildSourceBucket, 'asia-east2'],
    ['sql', `//cloudsql.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}`, GCP_IDENTITY.cloudSqlInstance, 'asia-east2'],
    ['network', `//compute.googleapis.com/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`, GCP_IDENTITY.network, 'global'],
    ['subnet', `//compute.googleapis.com/projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}`, GCP_IDENTITY.subnet, 'asia-east2'],
    ['psa range', `//compute.googleapis.com/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`, GCP_IDENTITY.psaRange, 'global'],
    [
      'psa connection',
      `//servicenetworking.googleapis.com/projects/${PROJECT_NUMBER}/global/networks/${GCP_IDENTITY.network}`,
      GCP_IDENTITY.network, 'global',
      `//cloudresourcemanager.googleapis.com/projects/${PROJECT_NUMBER}`,
    ],
    ...Object.values(GCP_IDENTITY.serviceAccounts).map((email) => [
      `service account ${email}`, `//iam.googleapis.com/projects/${PROJECT}/serviceAccounts/${email}`,
      email.split('@')[0], 'global',
    ]),
    ...Object.values(GCP_IDENTITY.secrets).map((id) => [
      `secret ${id}`, `//secretmanager.googleapis.com/projects/${PROJECT}/secrets/${id}`, id, 'global',
    ]),
    ...Object.values(GCP_IDENTITY.jobs).map((id) => [
      `job ${id}`, `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/jobs/${id}`, id, 'asia-east2',
    ]),
    ...contract.resources.customRoles.map(({ id }) => [
      `role ${id}`, `//iam.googleapis.com/projects/${PROJECT}/roles/${id}`, id, 'global',
    ]),
  ];
  for (const [label, name, displayName, location, parentFullResourceName] of identities) {
    await t.test(label, async () => {
      const fixture = assetAuditControlPlane({
        contract,
        assets: [cloudAsset({
          name, displayName, location, assetType: 'pubsub.googleapis.com/Topic',
          ...(parentFullResourceName === undefined ? {} : { parentFullResourceName }),
        })],
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_COLLISION',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Cloud Asset rejects the complete obsolete executable identity set in every metadata surface before mutation', async (t) => {
  const contract = await contractFixture();
  const obsolete = ['hkbuddy', 'hkbuddy-api', 'hkbuddy-pg', 'hkbuddy-prod-vpc'];
  const surfaces = [
    ['name', (value) => ({ name: `//pubsub.googleapis.com/projects/${PROJECT}/topics/${value}` })],
    ['displayName', (value) => ({ displayName: value })],
    ['description', (value) => ({ description: `obsolete ${value} resource` })],
    ['parent name', (value) => ({ parentFullResourceName: `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${value}` })],
    ['parent type', (value) => ({ parentAssetType: `legacy.googleapis.com/${value}` })],
    ['label key', (value) => ({ labels: { [value]: 'legacy' } })],
    ['label value', (value) => ({ labels: { owner: value } })],
  ];
  for (const identity of obsolete) {
    for (const [surface, overrides] of surfaces) {
      await t.test(`${identity} in ${surface}`, async () => {
        const fixture = assetAuditControlPlane({
          contract,
          assets: [cloudAsset({
            name: `//pubsub.googleapis.com/projects/${PROJECT}/topics/unrelated`,
            assetType: 'pubsub.googleapis.com/Topic', displayName: 'unrelated',
            ...overrides(identity),
          })],
        });
        await assert.rejects(
          () => fixture.plane.auditPreMutationState(),
          (error) => error.code === 'RESOURCE_COLLISION',
        );
        assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
        assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
      });
    }
  }
});

test('Cloud Asset accepts exact managed Cloud Run Execution descendants for every fixed job', async () => {
  const contract = await contractFixture();
  const releaseSha = '7c32f6d6bc0fbc41c5a2a6381c520cfd033f10f3';
  const executions = Object.values(GCP_IDENTITY.jobs).map((job, index) => {
    const executionName = `${job}-8l9jc`;
    const labels = {
      'client.knative.dev/nonce': 'dox_suj_jac',
      'cloud.googleapis.com/location': 'asia-east2',
      'run.googleapis.com/job': job,
      'run.googleapis.com/jobGeneration': String(index + 1),
      'run.googleapis.com/jobResourceVersion': String(1788253773770562 + index),
      'run.googleapis.com/jobUid': '991d9b4e-cd40-4367-8f05-26d6daaf3ddc',
      'run.googleapis.com/satisfiesPzs': 'true',
      'simplify-release-sha': releaseSha,
    };
    if (index === 1) delete labels['run.googleapis.com/satisfiesPzs'];
    if (index === 2) delete labels['simplify-release-sha'];
    const asset = {
      name: `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/executions/${executionName}`,
      assetType: 'run.googleapis.com/Execution',
      project: ASSET_PROJECT,
      displayName: executionName,
      location: 'asia-east2',
      labels,
      parentFullResourceName: `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/jobs/${job}`,
      parentAssetType: 'run.googleapis.com/Job',
    };
    if (index === 3) delete asset.displayName;
    return asset;
  });
  const fixture = assetAuditControlPlane({ contract, assets: executions });

  assert.equal(await fixture.plane.auditPreMutationState(), true);
  assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
  assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('Cloud Asset rejects malformed or contradictory managed Cloud Run Execution descendants', async (t) => {
  const contract = await contractFixture();
  const job = GCP_IDENTITY.jobs.llm;
  const executionName = `${job}-8l9jc`;
  const parent = `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/jobs/${job}`;
  const exactExecution = {
    name: `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/executions/${executionName}`,
    assetType: 'run.googleapis.com/Execution',
    project: ASSET_PROJECT,
    displayName: executionName,
    location: 'asia-east2',
    labels: {
      'client.knative.dev/nonce': 'dox_suj_jac',
      'cloud.googleapis.com/location': 'asia-east2',
      'run.googleapis.com/job': job,
      'run.googleapis.com/jobGeneration': '3',
      'run.googleapis.com/jobResourceVersion': '1788253726355256',
      'run.googleapis.com/jobUid': '30cb8fae-099b-4ef6-89ba-bbdfea6496c3',
      'run.googleapis.com/satisfiesPzs': 'true',
      'simplify-release-sha': '7c32f6d6bc0fbc41c5a2a6381c520cfd033f10f3',
    },
    parentFullResourceName: parent,
    parentAssetType: 'run.googleapis.com/Job',
  };
  const withLabels = (overrides) => ({
    ...exactExecution,
    labels: { ...exactExecution.labels, ...overrides },
  });
  const withoutDisplayName = { ...exactExecution };
  delete withoutDisplayName.displayName;
  const invalid = [
    ['wrong asset type', { ...exactExecution, assetType: 'run.googleapis.com/Job' }],
    ['wrong parent job', { ...exactExecution, parentFullResourceName: parent.replace(job, GCP_IDENTITY.jobs.asr) }],
    ['foreign job name', {
      ...withoutDisplayName,
      name: exactExecution.name.replace(job, 'hkbuddy-v1-foreign'),
    }],
    ['foreign project in name', {
      ...withoutDisplayName,
      name: exactExecution.name.replace(`/projects/${PROJECT}/`, '/projects/foreign/'),
    }],
    ['foreign project in parent', {
      ...exactExecution,
      parentFullResourceName: parent.replace(`/projects/${PROJECT}/`, '/projects/foreign/'),
    }],
    ['foreign region in name', {
      ...withoutDisplayName,
      name: exactExecution.name.replace('asia-east2', 'us-central1'),
    }],
    ['foreign region in parent', {
      ...exactExecution,
      parentFullResourceName: parent.replace('asia-east2', 'us-central1'),
    }],
    ['wrong location', { ...exactExecution, location: 'us-central1' }],
    ['four-character suffix', {
      ...exactExecution,
      name: exactExecution.name.replace('8l9jc', '8l9j'), displayName: `${job}-8l9j`,
    }],
    ['six-character suffix', {
      ...exactExecution,
      name: exactExecution.name.replace('8l9jc', '8l9jca'), displayName: `${job}-8l9jca`,
    }],
    ['uppercase suffix', {
      ...exactExecution,
      name: exactExecution.name.replace('8l9jc', '8L9JC'), displayName: `${job}-8L9JC`,
    }],
    ['hyphenated suffix', {
      ...exactExecution,
      name: exactExecution.name.replace('8l9jc', '8l-9j'), displayName: `${job}-8l-9j`,
    }],
    ['wrong display name', { ...exactExecution, displayName: `${executionName}-foreign` }],
    ['wrong parent asset type', { ...exactExecution, parentAssetType: 'run.googleapis.com/Service' }],
    ['missing labels', { ...exactExecution, labels: {} }],
    ['contradictory job label', withLabels({ 'run.googleapis.com/job': GCP_IDENTITY.jobs.asr })],
    ['contradictory location label', withLabels({ 'cloud.googleapis.com/location': 'us-central1' })],
    ['noncanonical job generation', withLabels({ 'run.googleapis.com/jobGeneration': '03' })],
    ['noncanonical job resource version', withLabels({ 'run.googleapis.com/jobResourceVersion': '0' })],
    ['malformed job uid', withLabels({ 'run.googleapis.com/jobUid': 'not-a-uuid' })],
    ['malformed client nonce', withLabels({ 'client.knative.dev/nonce': 'not canonical' })],
    ['contradictory PZS label', withLabels({ 'run.googleapis.com/satisfiesPzs': 'false' })],
    ['uppercase release SHA', withLabels({ 'simplify-release-sha': '7C32F6D6BC0FBC41C5A2A6381C520CFD033F10F3' })],
    ['short release SHA', withLabels({ 'simplify-release-sha': '7c32f6d6' })],
    ['foreign project marker label', withLabels({ 'example.googleapis.com/project': 'foreign' })],
  ];

  for (const [name, asset] of invalid) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [asset] });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_COLLISION',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('post-deployment Cloud Run revision and Docker image descendants remain preflight-idempotent only under exact ancestors', async (t) => {
  const contract = await contractFixture();
  const serviceName = `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}`;
  const repositoryName = `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`;
  const revision = cloudAsset({
    name: `${serviceName}/revisions/${GCP_IDENTITY.service}-abcdef123456`,
    assetType: 'run.googleapis.com/Revision',
    displayName: `${GCP_IDENTITY.service}-abcdef123456`,
    parentFullResourceName: serviceName,
    parentAssetType: 'run.googleapis.com/Service',
  });
  const image = cloudAsset({
    name: `${repositoryName}/dockerImages/${GCP_IDENTITY.service}@sha256:${'a'.repeat(64)}`,
    assetType: 'artifactregistry.googleapis.com/DockerImage',
    displayName: `${GCP_IDENTITY.service}@sha256:${'a'.repeat(64)}`,
    parentFullResourceName: repositoryName,
    parentAssetType: 'artifactregistry.googleapis.com/Repository',
  });
  const exact = [
    cloudAsset(),
    cloudAsset({
      name: repositoryName, assetType: 'artifactregistry.googleapis.com/Repository',
      displayName: GCP_IDENTITY.repository,
    }),
    cloudAsset({
      name: `//storage.googleapis.com/${GCP_IDENTITY.buildSourceBucket}`,
      assetType: 'storage.googleapis.com/Bucket',
      displayName: GCP_IDENTITY.buildSourceBucket,
    }),
    revision, image,
  ];
  const accepted = assetAuditControlPlane({ contract, assets: exact });
  await accepted.plane.auditPreMutationState();

  for (const [name, asset] of [
    ['revision foreign parent', { ...revision, parentFullResourceName: `${serviceName}-foreign` }],
    ['revision wrong type', { ...revision, assetType: 'run.googleapis.com/Job' }],
    ['revision wrong region', { ...revision, name: revision.name.replace('asia-east2', 'us-central1'), location: 'us-central1' }],
    ['revision wrong project', { ...revision, name: revision.name.replace(`/projects/${PROJECT}/`, '/projects/foreign/') }],
    ['revision incompatible name', { ...revision, name: `${serviceName}/revisions/${GCP_IDENTITY.service}-latest`, displayName: `${GCP_IDENTITY.service}-latest` }],
    ['image foreign parent', { ...image, parentFullResourceName: `${repositoryName}-foreign` }],
    ['image wrong type', { ...image, assetType: 'artifactregistry.googleapis.com/Repository' }],
    ['image wrong region', { ...image, name: image.name.replace('asia-east2', 'us-central1'), location: 'us-central1' }],
    ['image wrong project', { ...image, name: image.name.replace(`/projects/${PROJECT}/`, '/projects/foreign/') }],
    ['image incompatible package', { ...image, name: image.name.replace(GCP_IDENTITY.service, 'foreign-image'), displayName: 'foreign-image' }],
  ]) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [asset] });
      await assert.rejects(() => fixture.plane.auditPreMutationState(), (error) => error.code === 'RESOURCE_COLLISION');
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('enabled inventory rejects foreign managed display markers and malformed KRM identities before mutation', async (t) => {
  const contract = await contractFixture();
  const cases = [
    {
      name: 'alert policy foreign display with generated ID', enabledApis: ['iam.googleapis.com', 'monitoring.googleapis.com'],
      restRows: { '/alertPolicies': { alertPolicies: [{ name: `projects/${PROJECT}/alertPolicies/1`, displayName: 'HK Buddy V1 foreign policy', userLabels: {} }] }, '/notificationChannels': { notificationChannels: [] } },
    },
    {
      name: 'notification channel foreign display with generated ID', enabledApis: ['iam.googleapis.com', 'monitoring.googleapis.com'],
      restRows: { '/alertPolicies': { alertPolicies: [] }, '/notificationChannels': { notificationChannels: [{ name: `projects/${PROJECT}/notificationChannels/1`, displayName: 'HK Buddy V1 foreign operations', type: 'email', enabled: true, verificationStatus: 'VERIFIED', userLabels: {} }] } },
    },
    {
      name: 'budget foreign display with generated ID', enabledApis: ['iam.googleapis.com', 'billingbudgets.googleapis.com'],
      restRows: { '/budgets': { budgets: [{ name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/1`, displayName: 'Hong Kong Buddy Production V1 foreign guard', budgetFilter: { projects: [ASSET_PROJECT] } }] } },
    },
    {
      name: 'malformed KRM Cloud Run identity', enabledApis: ['iam.googleapis.com', 'run.googleapis.com'],
      gcloudRows: { 'run services list': [{ metadata: {} }], 'run jobs list': [] },
    },
    {
      name: 'foreign KRM Cloud Run identity', enabledApis: ['iam.googleapis.com', 'run.googleapis.com'],
      gcloudRows: { 'run services list': [{ metadata: { name: 'hkbuddy-v1-foreign' } }], 'run jobs list': [] },
    },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: fixtureCase.enabledApis,
        gcloudRows: fixtureCase.gcloudRows, restRows: fixtureCase.restRows,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => ['RESOURCE_COLLISION', 'LIST_RESPONSE_AMBIGUOUS'].includes(error.code),
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.every(({ method }) => method === 'GET'), true);
    });
  }
});

test('Monitoring policies channels and budgets reject the complete managed-name union before mutation', async (t) => {
  const contract = await contractFixture();
  const managedNames = [
    'hkbuddy-v1-foreign',
    'HK Buddy V1 foreign',
    'Hong Kong Buddy Production V1 foreign',
  ];
  for (const resource of ['policy', 'channel', 'budget']) {
    for (const displayName of managedNames) {
      await t.test(`${resource}: ${displayName}`, async () => {
        const monitoring = resource !== 'budget';
        const restRows = resource === 'policy' ? {
          '/alertPolicies': { alertPolicies: [{ name: `projects/${PROJECT}/alertPolicies/1`, displayName, userLabels: {} }] },
          '/notificationChannels': { notificationChannels: [] },
        } : resource === 'channel' ? {
          '/alertPolicies': { alertPolicies: [] },
          '/notificationChannels': { notificationChannels: [{
            name: `projects/${PROJECT}/notificationChannels/1`, displayName,
            type: 'email', enabled: true, verificationStatus: 'VERIFIED', userLabels: {},
          }] },
        } : {
          '/budgets': { budgets: [{
            name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/1`, displayName,
            budgetFilter: { projects: [ASSET_PROJECT] },
          }] },
        };
        const fixture = assetAuditControlPlane({
          contract, assets: [],
          enabledApis: ['iam.googleapis.com', monitoring ? 'monitoring.googleapis.com' : 'billingbudgets.googleapis.com'],
          restRows,
        });
        await assert.rejects(
          () => fixture.plane.auditPreMutationState(),
          (error) => error.code === 'RESOURCE_COLLISION',
        );
        assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
        assert.equal(fixture.restCalls.every(({ method }) => method === 'GET'), true);
      });
    }
  }
});

test('real Compute inventory validates malformed rows and includes regional addresses before every mutation', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const networkRow = { name: 'default', selfLink: network, autoCreateSubnetworks: true };
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const cases = [
    ['subnet missing network', {
      'compute networks list': [networkRow],
      'compute networks subnets': [{ name: 'foreign-subnet', ipCidrRange: '10.25.1.0/24', region }],
      'compute routes list': [], 'compute addresses list': [],
    }, 'CIDR_AUDIT_INVALID'],
    ['route missing network', {
      'compute networks list': [networkRow], 'compute networks subnets': [],
      'compute routes list': [{ name: 'foreign-route', destRange: '10.25.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }],
      'compute addresses list': [],
    }, 'CIDR_AUDIT_INVALID'],
    ['PSA address missing network', {
      'compute networks list': [networkRow], 'compute networks subnets': [], 'compute routes list': [],
      'compute addresses list': [{ name: 'foreign-psa', purpose: 'VPC_PEERING', address: '10.25.0.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }],
    }, 'CIDR_AUDIT_INVALID'],
    ['regional PSA overlap remains visible', {
      'compute networks list': [networkRow], 'compute networks subnets': [], 'compute routes list': [],
      'compute addresses list': [{
        name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '10.25.0.0', prefixLength: 16,
        addressType: 'INTERNAL', status: 'RESERVED', region,
      }],
    }, 'CIDR_AUDIT_INVALID'],
  ];
  for (const [name, gcloudRows, code] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'], gcloudRows,
      });
      await assert.rejects(() => fixture.plane.auditPreMutationState(), (error) => error.code === code);
      const addressCalls = fixture.gcloudCalls.filter((args) => args[0] === 'compute' && args[1] === 'addresses' && args.includes('list'));
      assert.equal(addressCalls.length > 0, true);
      assert.equal(addressCalls.some((args) => args.includes('--global')), false);
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('live default-IPv4 PSA readback and exact managed CIDRs remain preflight-idempotent', async () => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const livePsa = {
    address: '10.25.0.0',
    addressType: 'INTERNAL',
    kind: 'compute#address',
    name: GCP_IDENTITY.psaRange,
    network,
    networkTier: 'PREMIUM',
    prefixLength: 16,
    purpose: 'VPC_PEERING',
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`,
    status: 'RESERVED',
  };
  const readPlane = new GcpControlPlane({
    contract,
    notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'compute' && args[1] === 'addresses' && args[2] === 'describe') return livePsa;
      throw new Error(`unexpected gcloud ${args.join(' ')}`);
    },
    request: async () => { throw new Error('REST must not run'); },
  });

  const readback = await readPlane.read('psa-range');
  assert.equal(readback.value.ipVersion, 'IPV4');
  assert.equal(readPlane.compare('psa-range', readback.value), true);
  assert.equal(readPlane.compare('psa-range', { ...livePsa, ipVersion: 'IPV6' }), false);
  assert.equal(readPlane.compare('psa-range', { ...livePsa, address: '2001:db8::' }), false);
  assert.equal(readPlane.compare('psa-range', { ...livePsa, address: '10.25.000.0' }), false);

  const liveSubnet = {
    allowSubnetCidrRoutesOverlap: false,
    gatewayAddress: '10.24.0.1',
    ipCidrRange: '10.24.0.0/26',
    kind: 'compute#subnetwork',
    name: GCP_IDENTITY.subnet,
    network,
    privateIpGoogleAccess: true,
    privateIpv6GoogleAccess: 'DISABLE_GOOGLE_ACCESS',
    purpose: 'PRIVATE',
    region,
    selfLink: `${region}/subnetworks/${GCP_IDENTITY.subnet}`,
    stackType: 'IPV4_ONLY',
  };
  assert.equal(readPlane.compare('subnet', liveSubnet), true);
  assert.equal(readPlane.compare('subnet', { ...liveSubnet, purpose: 'REGIONAL_MANAGED_PROXY' }), false);
  assert.equal(readPlane.compare('subnet', { ...liveSubnet, stackType: 'IPV4_IPV6' }), false);
  assert.equal(readPlane.compare('subnet', {
    ...liveSubnet, secondaryIpRanges: [{ rangeName: 'foreign', ipCidrRange: '10.25.0.0/24' }],
  }), false);
  for (const [field, value] of [
    ['reservedInternalRange', 'https://networkconnectivity.googleapis.com/v1/projects/foreign/locations/global/internalRanges/foreign'],
    ['resolveSubnetMask', 'ALL_IP_RANGES'],
    ['ipv6CidrRange', '2001:db8::/64'],
    ['ipv6GceEndpoint', 'VM_AND_FR'],
    ['ipCollection', `${region}/publicDelegatedPrefixes/foreign`],
    ['systemReservedInternalIpv6Ranges', ['fd20::/64']],
    ['systemReservedExternalIpv6Ranges', ['2001:db8::/64']],
  ]) assert.equal(readPlane.compare('subnet', { ...liveSubnet, [field]: value }), false);

  const exactInventory = {
    'compute networks list': [{
      name: GCP_IDENTITY.network, selfLink: network, autoCreateSubnetworks: false,
    }],
    'compute networks subnets': [liveSubnet],
    'compute routes list': [{
      name: 'default-route-r-41fc9f2f5f7a6a3d',
      description: 'Default local route to the subnetwork 10.24.0.0/26.',
      destRange: '10.24.0.0/26',
      kind: 'compute#route',
      network,
      nextHopNetwork: network,
      priority: 0,
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/default-route-r-41fc9f2f5f7a6a3d`,
    }],
    'compute addresses list': [livePsa],
  };
  const accepted = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
    gcloudRows: exactInventory,
  });
  assert.equal(await accepted.plane.auditPreMutationState(), true);
  assert.equal(accepted.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  assert.equal(accepted.restCalls.some(({ method }) => method !== 'GET'), false);

  const missingManagedRoute = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
    gcloudRows: { ...exactInventory, 'compute routes list': [] },
  });
  await assert.rejects(
    () => missingManagedRoute.plane.auditPreMutationState(),
    (error) => error.code === 'CIDR_OVERLAP',
  );

  for (const routeDrift of [
    { routeType: 'STATIC' },
    { tags: ['foreign'] },
  ]) {
    const driftedManagedRoute = assetAuditControlPlane({
      contract,
      assets: [],
      enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
      gcloudRows: {
        ...exactInventory,
        'compute routes list': [{ ...exactInventory['compute routes list'][0], ...routeDrift }],
      },
    });
    await assert.rejects(
      () => driftedManagedRoute.plane.auditPreMutationState(),
      (error) => error.code === 'CIDR_OVERLAP',
    );
  }

  const explicitSubnetRouteType = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
    gcloudRows: {
      ...exactInventory,
      'compute routes list': [{ ...exactInventory['compute routes list'][0], routeType: 'SUBNET' }],
    },
  });
  assert.equal(await explicitSubnetRouteType.plane.auditPreMutationState(), true);

  const duplicateManagedRoute = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
    gcloudRows: {
      ...exactInventory,
      'compute routes list': [
        ...exactInventory['compute routes list'],
        {
          ...exactInventory['compute routes list'][0],
          name: 'default-route-r-aaaaaaaaaaaaaaaa',
          selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/default-route-r-aaaaaaaaaaaaaaaa`,
        },
      ],
    },
  });
  await assert.rejects(
    () => duplicateManagedRoute.plane.auditPreMutationState(),
    (error) => error.code === 'CIDR_OVERLAP',
  );

  const foreignRouteOverlap = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
    gcloudRows: {
      ...exactInventory,
      'compute routes list': [
        ...exactInventory['compute routes list'],
        {
          name: 'foreign-overlap-route', network,
          destRange: '10.25.0.0/24',
          nextHopVpnTunnel: `${region}/vpnTunnels/foreign-overlap`,
        },
      ],
    },
  });
  await assert.rejects(
    () => foreignRouteOverlap.plane.auditPreMutationState(),
    (error) => error.code === 'CIDR_OVERLAP',
  );

  const foreignOverlap = assetAuditControlPlane({
    contract,
    assets: [],
    enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
    gcloudRows: {
      ...exactInventory,
      'compute networks subnets': [
        ...exactInventory['compute networks subnets'],
        {
          name: 'foreign-overlap', network, region,
          selfLink: `${region}/subnetworks/foreign-overlap`, ipCidrRange: '10.24.0.0/27',
        },
      ],
    },
  });
  await assert.rejects(
    () => foreignOverlap.plane.auditPreMutationState(),
    (error) => error.code === 'CIDR_OVERLAP',
  );
  assert.equal(foreignOverlap.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  assert.equal(foreignOverlap.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('Cloud Run Direct VPC SERVERLESS reservations require an exact contained subnet topology', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const subnetwork = `${region}/subnetworks/${GCP_IDENTITY.subnet}`;
  const liveSubnet = {
    allowSubnetCidrRoutesOverlap: false,
    gatewayAddress: '10.24.0.1',
    ipCidrRange: '10.24.0.0/26',
    kind: 'compute#subnetwork',
    name: GCP_IDENTITY.subnet,
    network,
    privateIpGoogleAccess: true,
    privateIpv6GoogleAccess: 'DISABLE_GOOGLE_ACCESS',
    purpose: 'PRIVATE',
    region,
    selfLink: subnetwork,
    stackType: 'IPV4_ONLY',
  };
  const localRoute = {
    name: 'default-route-r-41fc9f2f5f7a6a3d',
    description: 'Default local route to the subnetwork 10.24.0.0/26.',
    destRange: '10.24.0.0/26',
    kind: 'compute#route',
    network,
    nextHopNetwork: network,
    priority: 0,
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/default-route-r-41fc9f2f5f7a6a3d`,
  };
  const liveAddress = {
    name: 'serverless-ipv4-1788403662596331761',
    address: '10.24.0.16',
    addressType: 'INTERNAL',
    ipVersion: 'IPV4',
    networkTier: 'PREMIUM',
    prefixLength: 28,
    purpose: 'SERVERLESS',
    region,
    selfLink: `${region}/addresses/serverless-ipv4-1788403662596331761`,
    status: 'RESERVED',
    subnetwork,
  };
  const networks = [{
    name: GCP_IDENTITY.network,
    selfLink: network,
    autoCreateSubnetworks: false,
  }];
  const exactInventory = {
    'compute networks list': networks,
    'compute networks subnets': [liveSubnet],
    'compute routes list': [localRoute],
    'compute addresses list': [liveAddress],
  };

  await t.test('the exact safe live reservation is preflight-idempotent', async () => {
    const fixture = assetAuditControlPlane({
      contract,
      assets: [],
      enabledApis: ['iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com'],
      gcloudRows: exactInventory,
    });
    assert.equal(await fixture.plane.auditPreMutationState(), true);
    const mutatingVerbs = new Set([
      'add-iam-policy-binding', 'create', 'delete', 'deploy', 'enable', 'execute',
      'patch', 'remove-iam-policy-binding', 'replace', 'set-iam-policy', 'update',
    ]);
    assert.equal(
      fixture.gcloudCalls.some((args) => args.some((arg) => mutatingVerbs.has(arg))),
      false,
    );
    assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
  });

  const without = (value, key) => {
    const result = { ...value };
    delete result[key];
    return result;
  };
  const otherRegion = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east1`;
  const invalidCases = [
    ['foreign subnet project', {
      address: { ...liveAddress, subnetwork: subnetwork.replace(PROJECT, 'foreign-project') },
    }],
    ['missing enumerated subnet', {
      address: { ...liveAddress, subnetwork: `${region}/subnetworks/missing-subnet` },
    }],
    ['subnet and address region mismatch', {
      address: {
        ...liveAddress,
        region: otherRegion,
        selfLink: `${otherRegion}/addresses/${liveAddress.name}`,
      },
    }],
    ['network selector instead of subnetwork', {
      address: { ...without(liveAddress, 'subnetwork'), network },
    }],
    ['both network and subnetwork selectors', {
      address: { ...liveAddress, network },
    }],
    ['range outside subnet', {
      address: { ...liveAddress, address: '10.24.0.64' },
    }],
    ['range starts inside but extends beyond subnet', {
      address: { ...liveAddress, address: '10.24.0.0', prefixLength: 25 },
    }],
    ['host-bit address', {
      address: { ...liveAddress, address: '10.24.0.17' },
    }],
    ['wrong network tier', {
      address: { ...liveAddress, networkTier: 'STANDARD' },
    }],
    ['wrong address type', {
      address: { ...liveAddress, addressType: 'EXTERNAL' },
    }],
    ['wrong IP version', {
      address: { ...liveAddress, ipVersion: 'IPV6' },
    }],
    ['wrong purpose', {
      address: { ...liveAddress, purpose: 'PRIVATE_NAT' },
    }],
    ['transient status', {
      address: { ...liveAddress, status: 'RESERVING' },
    }],
    ['string prefix length', {
      address: { ...liveAddress, prefixLength: '28' },
    }],
    ['malformed self link', {
      address: { ...liveAddress, selfLink: `${region}/addresses/${liveAddress.name}/extra` },
    }],
    ['subnet belongs to an unenumerated network', {
      address: liveAddress,
      subnets: [{ ...liveSubnet, network: `${network}-missing` }],
    }],
  ];
  for (const [name, candidate] of invalidCases) {
    await t.test(name, () => assert.throws(
      () => validateComputeAddressInventory({
        addresses: [candidate.address],
        networks,
        subnets: candidate.subnets ?? [liveSubnet],
      }),
      (error) => error.code === 'CIDR_AUDIT_INVALID',
    ));
  }

  await t.test('canonical selector-free SERVERLESS remains a supported inventory form', () => {
    assert.equal(validateComputeAddressInventory({
      addresses: [without(liveAddress, 'subnetwork')],
      networks,
      subnets: [liveSubnet],
    }), true);
  });

  await t.test('non-plain address inventory remains invalid', () => {
    const inheritedAddress = Object.assign(Object.create({ inherited: true }), liveAddress);
    assert.throws(
      () => validateComputeAddressInventory({
        addresses: [inheritedAddress], networks, subnets: [liveSubnet],
      }),
      (error) => error.code === 'CIDR_AUDIT_INVALID',
    );
  });

  await t.test('the managed range still participates in unrelated-network overlap checks', () => {
    const otherNetwork = `${network}-other`;
    assert.throws(
      () => assertCidrAvailable({
        desired: '10.24.0.16/28',
        network: otherNetwork,
        networks: [
          ...networks,
          { name: `${GCP_IDENTITY.network}-other`, selfLink: otherNetwork },
        ],
        subnets: [liveSubnet],
        routes: [],
        addresses: [liveAddress],
      }),
      (error) => error.code === 'CIDR_OVERLAP',
    );
  });
});

test('post-Cloud-SQL PSA route is exempt only by exact address, connection, instance, and route provenance', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const exactConnection = {
    service: 'services/servicenetworking.googleapis.com',
    network: `projects/${PROJECT_NUMBER}/global/networks/${GCP_IDENTITY.network}`,
    peering: 'servicenetworking-googleapis-com',
    reservedPeeringRanges: [GCP_IDENTITY.psaRange],
  };
  const exactSql = {
    ...exactCloudSqlInstance(),
    ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.25.0.2' }],
  };
  const postgres = {
    kind: 'sql#database', name: 'postgres', instance: GCP_IDENTITY.cloudSqlInstance, project: PROJECT,
    selfLink: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/postgres`,
  };
  const livePsa = {
    address: '10.25.0.0', addressType: 'INTERNAL', ipVersion: 'IPV4', kind: 'compute#address',
    name: GCP_IDENTITY.psaRange, network, networkTier: 'PREMIUM', prefixLength: 16,
    purpose: 'VPC_PEERING',
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`,
    status: 'RESERVED',
  };
  const liveSubnet = {
    allowSubnetCidrRoutesOverlap: false, gatewayAddress: '10.24.0.1', ipCidrRange: '10.24.0.0/26',
    kind: 'compute#subnetwork', name: GCP_IDENTITY.subnet, network,
    privateIpGoogleAccess: true, privateIpv6GoogleAccess: 'DISABLE_GOOGLE_ACCESS',
    purpose: 'PRIVATE', region, selfLink: `${region}/subnetworks/${GCP_IDENTITY.subnet}`, stackType: 'IPV4_ONLY',
  };
  const localRoute = {
    name: 'default-route-r-41fc9f2f5f7a6a3d',
    description: 'Default local route to the subnetwork 10.24.0.0/26.',
    destRange: '10.24.0.0/26', kind: 'compute#route', network, nextHopNetwork: network, priority: 0,
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/default-route-r-41fc9f2f5f7a6a3d`,
  };
  const peeringRoute = {
    creationTimestamp: '2026-08-28T20:12:14.625-07:00',
    description: 'Auto generated route via peering [servicenetworking-googleapis-com].',
    destRange: '10.25.0.0/24', id: '2991965253249528033', kind: 'compute#route',
    name: 'peering-route-887ca332c8354df3', network,
    nextHopPeering: 'servicenetworking-googleapis-com', priority: 0,
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/peering-route-887ca332c8354df3`,
  };
  const inventory = {
    'compute networks list': [{ name: GCP_IDENTITY.network, selfLink: network, autoCreateSubnetworks: false }],
    'compute networks subnets': [liveSubnet],
    'compute routes list': [localRoute, peeringRoute],
    'compute addresses list': [livePsa],
    'services vpc-peerings list': [exactConnection],
    'sql instances list': [{ name: GCP_IDENTITY.cloudSqlInstance, project: PROJECT }],
    'sql instances describe': exactSql,
    'sql databases list': [postgres],
  };
  const enabledApis = [
    'iam.googleapis.com', 'serviceusage.googleapis.com', 'compute.googleapis.com',
    'servicenetworking.googleapis.com', 'sqladmin.googleapis.com',
  ];
  const fixtureFor = (gcloudRows = inventory) => assetAuditControlPlane({
    contract, assets: [], enabledApis, gcloudRows, restRows: { '/users': { items: [] } },
  });

  await t.test('the exact live four-party proof is preflight-idempotent', async () => {
    const fixture = fixtureFor();
    assert.equal(await fixture.plane.auditPreMutationState(), true);
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
    assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
  });

  for (const [name, rows] of [
    ['missing imported route', { ...inventory, 'compute routes list': [localRoute] }],
    ['duplicate imported route', {
      ...inventory,
      'compute routes list': [localRoute, peeringRoute, {
        ...peeringRoute,
        name: 'peering-route-aaaaaaaaaaaaaaaa',
        selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/peering-route-aaaaaaaaaaaaaaaa`,
      }],
    }],
    ['missing connection', { ...inventory, 'services vpc-peerings list': [] }],
    ['absent Cloud SQL instance', {
      ...inventory, 'sql instances list': [], 'sql instances describe': undefined,
    }],
    ['route outside the private IP /24', {
      ...inventory,
      'compute routes list': [localRoute, { ...peeringRoute, destRange: '10.25.1.0/24' }],
    }],
    ['Cloud SQL private IP outside the route', {
      ...inventory,
      'sql instances describe': { ...exactSql, ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.25.1.2' }] },
    }],
    ['multiple Cloud SQL private IPs', {
      ...inventory,
      'sql instances describe': {
        ...exactSql,
        ipAddresses: [
          { type: 'PRIVATE', ipAddress: '10.25.0.2' },
          { type: 'PRIVATE', ipAddress: '10.25.0.3' },
        ],
      },
    }],
    ...[
      ['wrong kind', { kind: 'compute#forwardingRule' }],
      ['wrong self link', { selfLink: `${network}/routes/foreign` }],
      ['wrong description', { description: 'Imported route' }],
      ['wrong network', { network: `${network}-foreign` }],
      ['wrong peering', { nextHopPeering: 'foreign-peering' }],
      ['wrong priority', { priority: 1000 }],
      ['static route type', { routeType: 'STATIC' }],
      ['tagged route', { tags: ['foreign'] }],
      ['route status selector', { routeStatus: 'ACTIVE' }],
      ['AS path selector', { asPaths: [{ pathSegmentType: 'AS_SEQUENCE', asLists: [64512] }] }],
    ].map(([name, drift]) => [name, {
      ...inventory,
      'compute routes list': [localRoute, { ...peeringRoute, ...drift }],
    }]),
  ]) {
    await t.test(name, async () => {
      const fixture = fixtureFor(rows);
      if (Object.hasOwn(rows, 'sql instances describe') && rows['sql instances describe'] === undefined) {
        delete rows['sql instances describe'];
      }
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => ['CIDR_OVERLAP', 'CIDR_AUDIT_INVALID', 'RESOURCE_COLLISION'].includes(error.code),
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  await t.test('a second Cloud SQL read changing the private IP fails closed', async () => {
    const fixture = fixtureFor();
    const baseGcloud = fixture.plane.gcloud;
    let describeReads = 0;
    fixture.plane.gcloud = async (args, options) => {
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
        fixture.gcloudCalls.push(args);
        describeReads += 1;
        return describeReads === 1 ? exactSql : {
          ...exactSql, ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.25.0.3' }],
        };
      }
      return baseGcloud(args, options);
    };
    await assert.rejects(
      () => fixture.plane.auditPreMutationState(),
      (error) => error.code === 'RESOURCE_STATE_UNKNOWN',
    );
    assert.equal(describeReads, 2);
  });

  await t.test('a second Cloud SQL read adding a duplicate private IP fails closed', async () => {
    const fixture = fixtureFor();
    const baseGcloud = fixture.plane.gcloud;
    let describeReads = 0;
    fixture.plane.gcloud = async (args, options) => {
      if (args[0] === 'sql' && args[1] === 'instances' && args[2] === 'describe') {
        fixture.gcloudCalls.push(args);
        describeReads += 1;
        return describeReads === 1 ? exactSql : {
          ...exactSql,
          ipAddresses: [
            { type: 'PRIVATE', ipAddress: '10.25.0.2' },
            { type: 'PRIVATE', ipAddress: '10.25.0.2' },
          ],
        };
      }
      return baseGcloud(args, options);
    };
    await assert.rejects(
      () => fixture.plane.auditPreMutationState(),
      (error) => error.code === 'RESOURCE_STATE_UNKNOWN',
    );
    assert.equal(describeReads, 2);
  });

  await t.test('a second route inventory adding an overlap fails closed when Cloud SQL and the managed route were absent', async () => {
    const noSqlInventory = {
      ...inventory,
      'compute routes list': [localRoute],
      'sql instances list': [],
    };
    delete noSqlInventory['sql instances describe'];
    const fixture = fixtureFor(noSqlInventory);
    const baseGcloud = fixture.plane.gcloud;
    let routeReads = 0;
    fixture.plane.gcloud = async (args, options) => {
      if (args[0] === 'compute' && args[1] === 'routes' && args[2] === 'list') {
        fixture.gcloudCalls.push(args);
        routeReads += 1;
        return routeReads === 1 ? [localRoute] : [localRoute, {
          name: 'foreign-overlap-route', network, destRange: '10.25.8.0/24',
          nextHopVpnTunnel: `${region}/vpnTunnels/foreign-overlap`,
        }];
      }
      return baseGcloud(args, options);
    };
    await assert.rejects(
      () => fixture.plane.auditPreMutationState(),
      (error) => error.code === 'RESOURCE_STATE_UNKNOWN',
    );
    assert.equal(routeReads, 2);
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
    assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
  });

  for (const [name, commandKey, secondInventory] of [
    ['subnet overlap', 'compute networks subnets', [liveSubnet, {
      ...liveSubnet,
      gatewayAddress: '10.25.4.1', ipCidrRange: '10.25.4.0/24', name: 'foreign-subnet',
      selfLink: `${region}/subnetworks/foreign-subnet`,
    }]],
    ['address overlap', 'compute addresses list', [livePsa, {
      ...livePsa,
      name: 'foreign-psa',
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/foreign-psa`,
    }]],
  ]) {
    await t.test(`a second full CIDR audit rejects a new ${name}`, async () => {
      const fixture = fixtureFor();
      const baseGcloud = fixture.plane.gcloud;
      let inventoryReads = 0;
      fixture.plane.gcloud = async (args, options) => {
        const inventoryList = commandKey === 'compute networks subnets'
          ? args.slice(0, 4).join(' ') === 'compute networks subnets list'
          : args.slice(0, 3).join(' ') === commandKey;
        if (inventoryList) {
          fixture.gcloudCalls.push(args);
          inventoryReads += 1;
          return inventoryReads <= 2 ? inventory[commandKey] : secondInventory;
        }
        return baseGcloud(args, options);
      };
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_STATE_UNKNOWN',
      );
      assert.equal(inventoryReads, 3);
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  await t.test('a second full CIDR audit rejects a foreign peering claiming the managed range', async () => {
    const foreignNetworkName = 'foreign-vpc';
    const foreignNetwork = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${foreignNetworkName}`;
    const fixture = fixtureFor({
      ...inventory,
      'compute networks list': [
        ...inventory['compute networks list'],
        { name: foreignNetworkName, selfLink: foreignNetwork, autoCreateSubnetworks: false },
      ],
    });
    const baseGcloud = fixture.plane.gcloud;
    let foreignPeeringReads = 0;
    fixture.plane.gcloud = async (args, options) => {
      if (args[0] === 'services' && args[1] === 'vpc-peerings' && args[2] === 'list') {
        fixture.gcloudCalls.push(args);
        if (args.includes(`--network=${GCP_IDENTITY.network}`)) return [exactConnection];
        if (args.includes(`--network=${foreignNetworkName}`)) {
          foreignPeeringReads += 1;
          return foreignPeeringReads === 1 ? [] : [{
            service: 'services/servicenetworking.googleapis.com',
            network: `projects/${PROJECT_NUMBER}/global/networks/${foreignNetworkName}`,
            peering: 'servicenetworking-googleapis-com',
            reservedPeeringRanges: [GCP_IDENTITY.psaRange],
          }];
        }
      }
      return baseGcloud(args, options);
    };
    await assert.rejects(
      () => fixture.plane.auditPreMutationState(),
      (error) => error.code === 'RESOURCE_STATE_UNKNOWN',
    );
    assert.equal(foreignPeeringReads, 2);
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
    assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
  });

  for (const [name, secondRoutes] of [
    ['missing imported route', [localRoute]],
    ['changed imported route identity', [localRoute, {
      ...peeringRoute,
      creationTimestamp: '2026-08-28T20:13:14.625-07:00',
      id: '2991965253249528034',
      name: 'peering-route-aaaaaaaaaaaaaaaa',
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/peering-route-aaaaaaaaaaaaaaaa`,
    }]],
    ['duplicate imported route', [localRoute, peeringRoute, {
      ...peeringRoute,
      id: '2991965253249528034',
      name: 'peering-route-aaaaaaaaaaaaaaaa',
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/peering-route-aaaaaaaaaaaaaaaa`,
    }]],
  ]) {
    await t.test(`a second route read with a ${name} fails closed`, async () => {
      const fixture = fixtureFor();
      const baseGcloud = fixture.plane.gcloud;
      let routeReads = 0;
      fixture.plane.gcloud = async (args, options) => {
        if (args[0] === 'compute' && args[1] === 'routes' && args[2] === 'list') {
          fixture.gcloudCalls.push(args);
          routeReads += 1;
          return routeReads === 1 ? inventory['compute routes list'] : secondRoutes;
        }
        return baseGcloud(args, options);
      };
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_STATE_UNKNOWN',
      );
      assert.equal(routeReads, 2);
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  const exactPolicies = exactManagedIamPolicies(contract);
  const finalSecretVersions = {
    [GCP_IDENTITY.secrets.dbAppUrl]: '1',
    [GCP_IDENTITY.secrets.dbMigratorUrl]: '1',
    [GCP_IDENTITY.secrets.session]: '1',
    [GCP_IDENTITY.secrets.bootstrap]: '1',
  };
  const finalReadbackFixtureFor = (routes) => {
    const gcloudCalls = [];
    const policyFor = (args) => {
      if (args[0] === 'projects') return exactPolicies.project;
      if (args[0] === 'storage') return exactPolicies[`bucket:${args[3].slice('gs://'.length)}`];
      if (args[0] === 'artifacts') return exactPolicies[`repository:${args[3]}`];
      if (args[0] === 'secrets') return exactPolicies[`secret:${args[2]}`];
      if (args[0] === 'iam' && args[1] === 'service-accounts') {
        const account = contract.resources.serviceAccounts.find(({ email }) => email === args[3]);
        return exactPolicies[`service-account:${account?.id}`];
      }
      throw new Error(`unexpected IAM policy operation ${args.join(' ')}`);
    };
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async (args) => {
        gcloudCalls.push(args);
        if (args[0] === 'services' && args[1] === 'list') {
          return enabledServiceRows(AUTOMATIC_BINDING_APIS);
        }
        if (args[0] === 'compute' && args[1] === 'networks' && args[2] === 'list') {
          return inventory['compute networks list'];
        }
        if (args[0] === 'compute' && args[1] === 'networks' && args[2] === 'subnets') {
          return inventory['compute networks subnets'];
        }
        if (args[0] === 'compute' && args[1] === 'routes' && args[2] === 'list') return routes;
        if (args[0] === 'compute' && args[1] === 'addresses' && args[2] === 'list') {
          return inventory['compute addresses list'];
        }
        if (args[0] === 'services' && args[1] === 'vpc-peerings' && args[2] === 'list') {
          return inventory['services vpc-peerings list'];
        }
        if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list') {
          return contract.resources.customRoles.map(liveCustomRoleListRow);
        }
        if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
          const role = contract.resources.customRoles.find(({ id }) => id === args[3]);
          if (!role) throw new Error('unexpected custom role describe');
          return { ...role, deleted: false };
        }
        if (args.includes('get-iam-policy')) return policyFor(args);
        throw new Error(`unexpected gcloud ${args.join(' ')}`);
      },
      request: async () => { throw new Error('REST must not run'); },
    });
    const compare = plane.compare.bind(plane);
    const liveSql = { ...exactSql, privateIp: '10.25.0.2' };
    plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
    plane.auditUserManagedServiceAccountKeys = async () => undefined;
    plane.read = async (id) => ({
      status: 'present', value: id === 'cloud-sql-instance' ? liveSql : {},
    });
    plane.compare = (id, value, context) => (
      id === 'cloud-sql-instance' ? compare(id, value, context) : true
    );
    return { plane, gcloudCalls };
  };

  await t.test('final readback accepts one exact live four-party route proof', async () => {
    const fixture = finalReadbackFixtureFor([localRoute, peeringRoute]);
    await fixture.plane.finalReadback({
      notificationChannel: CHANNEL, secretVersions: finalSecretVersions,
    });
    assert.equal(fixture.gcloudCalls.some((args) => args.includes('create') || args.includes('enable')), false);
  });

  for (const [name, routes] of [
    ['missing', [localRoute]],
    ['duplicate', [localRoute, peeringRoute, {
      ...peeringRoute,
      id: '2991965253249528034',
      name: 'peering-route-bbbbbbbbbbbbbbbb',
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/routes/peering-route-bbbbbbbbbbbbbbbb`,
    }]],
    ['foreign', [localRoute, { ...peeringRoute, nextHopPeering: 'foreign-peering' }]],
  ]) {
    await t.test(`final readback rejects a ${name} post-create PSA route before COMPLETE`, async () => {
      const fixture = finalReadbackFixtureFor(routes);
      await assert.rejects(
        () => fixture.plane.finalReadback({
          notificationChannel: CHANNEL, secretVersions: finalSecretVersions,
        }),
        (error) => error.code === 'FINAL_READBACK_FAILED',
      );
      assert.equal(fixture.gcloudCalls.some((args) => (
        args.includes('create') || args.includes('enable') || args.includes('add-iam-policy-binding')
      )), false);
    });
  }
});

test('every internal RESERVED address family is canonical and participates in project-wide overlap checks', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const subnet = `${region}/subnetworks/default`;
  const base = {
    'compute networks list': [{ name: 'default', selfLink: network, autoCreateSubnetworks: true }],
    'compute networks subnets': [{
      name: 'default', selfLink: subnet, network, region, ipCidrRange: '10.24.0.0/26',
    }],
    'compute routes list': [],
  };
  const cases = [
    ['GCE_ENDPOINT single address overlap', {
      name: 'foreign-endpoint', purpose: 'GCE_ENDPOINT', address: '10.24.0.1',
      addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
      status: 'RESERVED', region, subnetwork: subnet,
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2/addresses/foreign-endpoint`,
    }, 'CIDR_OVERLAP'],
    ['PRIVATE_SERVICE_CONNECT global single address overlap', {
      name: 'foreign-psc', purpose: 'PRIVATE_SERVICE_CONNECT', address: '10.25.0.1',
      addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
      status: 'RESERVED', network,
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/foreign-psc`,
    }, 'CIDR_OVERLAP'],
    ['unsupported internal purpose', {
      name: 'foreign-unknown', purpose: 'UNSUPPORTED_FAMILY', address: '192.168.0.1',
      addressType: 'INTERNAL', status: 'RESERVED', region, network,
    }, 'CIDR_AUDIT_INVALID'],
    ['ambiguous single address without purpose', {
      name: 'foreign-incomplete', address: '192.168.0.1',
      addressType: 'INTERNAL', status: 'RESERVED', region, network,
    }, 'CIDR_AUDIT_INVALID'],
    ['noncanonical internal prefix', {
      name: 'foreign-prefix', purpose: 'PRIVATE_NAT', address: '192.168.001.0',
      prefixLength: 24, addressType: 'INTERNAL', status: 'RESERVED', region, network,
    }, 'CIDR_AUDIT_INVALID'],
  ];
  for (const [name, address, code] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'],
        gcloudRows: { ...base, 'compute addresses list': [address] },
      });
      await assert.rejects(() => fixture.plane.auditPreMutationState(), (error) => error.code === code);
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Compute validates malformed referenced rows even when the project network inventory is empty', async (t) => {
  const contract = await contractFixture();
  const missingNetwork = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/missing`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const cases = [
    ['subnet', {
      'compute networks list': [],
      'compute networks subnets': [{ name: 'foreign-subnet', network: missingNetwork, ipCidrRange: '192.168.1.0/24', region }],
      'compute routes list': [], 'compute addresses list': [],
    }],
    ['route', {
      'compute networks list': [], 'compute networks subnets': [],
      'compute routes list': [{ name: 'foreign-route', network: missingNetwork, destRange: '192.168.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }],
      'compute addresses list': [],
    }],
    ['PSA address', {
      'compute networks list': [], 'compute networks subnets': [], 'compute routes list': [],
      'compute addresses list': [{
        name: 'foreign-psa', purpose: 'VPC_PEERING', network: missingNetwork,
        address: '192.168.0.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED',
      }],
    }],
  ];
  for (const [name, gcloudRows] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'], gcloudRows,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CIDR_AUDIT_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Compute rejects noncanonical resource names URIs regions IPv4 and prefix serialization', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const base = {
    'compute networks list': [{ name: 'default', selfLink: network, autoCreateSubnetworks: true }],
    'compute networks subnets': [], 'compute routes list': [], 'compute addresses list': [],
  };
  const cases = [
    ['network name', { ...base, 'compute networks list': [{ name: 'Default', selfLink: `${network.slice(0, -7)}Default` }] }],
    ['network URI', { ...base, 'compute networks list': [{ name: 'default', selfLink: `${network}/extra` }] }],
    ['subnet name', { ...base, 'compute networks subnets': [{ name: 'foreign_subnet', network, ipCidrRange: '192.168.1.0/24', region }] }],
    ['subnet region prefix', { ...base, 'compute networks subnets': [{ name: 'foreign-subnet', network, ipCidrRange: '192.168.1.0/24', region: `${region}/extra` }] }],
    ['subnet leading-zero IPv4', { ...base, 'compute networks subnets': [{ name: 'foreign-subnet', network, ipCidrRange: '192.168.001.0/24', region }] }],
    ['subnet leading-zero prefix', { ...base, 'compute networks subnets': [{ name: 'foreign-subnet', network, ipCidrRange: '192.168.1.0/024', region }] }],
    ['route name', { ...base, 'compute routes list': [{ name: 'foreign_route', network, destRange: '192.168.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }] }],
    ['route next-hop URI', { ...base, 'compute routes list': [{ name: 'foreign-route', network, destRange: '192.168.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign/extra` }] }],
    ['route leading-zero prefix', { ...base, 'compute routes list': [{ name: 'foreign-route', network, destRange: '192.168.1.0/024', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }] }],
    ['address name', { ...base, 'compute addresses list': [{ name: 'foreign_psa', purpose: 'VPC_PEERING', network, address: '192.168.0.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }] }],
    ['address leading-zero IPv4', { ...base, 'compute addresses list': [{ name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '192.168.000.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }] }],
    ['address string prefix', { ...base, 'compute addresses list': [{ name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '192.168.0.0', prefixLength: '016', addressType: 'INTERNAL', status: 'RESERVED' }] }],
  ];
  for (const [name, gcloudRows] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'], gcloudRows,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CIDR_AUDIT_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('project-qualified Compute route next hops reject every foreign project before mutation', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const foreign = 'https://www.googleapis.com/compute/v1/projects/foreign-project';
  const cases = [
    ['gateway', { nextHopGateway: `${foreign}/global/gateways/default-internet-gateway` }],
    ['instance', { nextHopInstance: `${foreign}/zones/asia-east2-a/instances/foreign-instance` }],
    ['VPN tunnel', { nextHopVpnTunnel: `${foreign}/regions/asia-east2/vpnTunnels/foreign-tunnel` }],
    ['ILB forwarding rule', { nextHopIlb: `${foreign}/regions/asia-east2/forwardingRules/foreign-ilb` }],
    ['network', { nextHopNetwork: `${foreign}/global/networks/foreign-network` }],
  ];
  for (const [name, nextHop] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'],
        gcloudRows: {
          'compute networks list': [{ name: 'default', selfLink: network, autoCreateSubnetworks: true }],
          'compute networks subnets': [],
          'compute routes list': [{
            name: `foreign-${name.toLowerCase().replaceAll(' ', '-')}`, network,
            destRange: '192.168.1.0/24', ...nextHop,
          }],
          'compute addresses list': [],
        },
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CIDR_AUDIT_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('every exact-host Compute route next-hop family remains valid', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const host = `https://www.googleapis.com/compute/v1/projects/${PROJECT}`;
  const cases = [
    { nextHopGateway: `${host}/global/gateways/default-internet-gateway` },
    { nextHopInstance: `${host}/zones/asia-east2-a/instances/host-instance` },
    { nextHopVpnTunnel: `${host}/regions/asia-east2/vpnTunnels/host-tunnel` },
    { nextHopIlb: `${host}/regions/asia-east2/forwardingRules/host-ilb` },
    { nextHopNetwork: network },
    { nextHopIp: '192.168.100.1' },
    { nextHopPeering: 'host-peering' },
  ];
  for (const [index, nextHop] of cases.entries()) {
    assert.doesNotThrow(() => assertCidrAvailable({
      desired: '10.24.0.0/26', network,
      networks: [{ name: 'default', selfLink: network }], subnets: [], addresses: [],
      routes: [{ name: `host-route-${index}`, network, destRange: `192.168.${index}.0/24`, ...nextHop }],
    }));
  }
});

test('preflight verifies an enabled target-project Monitoring channel and fails closed on 403 or unverified status', async (t) => {
  await t.test('billing-account currency must match the exact HKD 2300 budget contract', async () => {
    const fixture = preflightGcloud({ billingCurrency: 'USD' });
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com', writeOutput: () => undefined,
      request: preflightReadRequest(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'BUDGET_CURRENCY_MISMATCH');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(fixture.calls.some((args) => args.includes('create')), false);
  });

  await t.test('verified channel', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const requests = [];
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${CHANNEL}`],
      contract: await contractFixture(),
      gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com',
      request: preflightReadRequest(async (input) => {
        requests.push(input);
        return {
          name: CHANNEL, displayName: 'HK Buddy V1 operations',
          userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
          labels: { email_address: 'admin@motionexp.com' },
          type: 'email', enabled: true, verificationStatus: 'VERIFIED',
        };
      }),
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.publicReport.alertChannel, 'verified');
    assert.deepEqual(requests, [{ method: 'GET', url: `https://monitoring.googleapis.com/v3/${CHANNEL}` }]);
  });

  await t.test('numeric channel alias is normalized to the project-ID name returned by Monitoring', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const requests = [];
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${NUMERIC_CHANNEL}`],
      contract: await contractFixture(),
      gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com',
      request: preflightReadRequest(async (input) => {
        requests.push(input);
        return {
          name: PROJECT_ID_CHANNEL,
          displayName: 'HK Buddy V1 operations',
          userLabels: {
            application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations',
          },
          labels: { email_address: 'admin@motionexp.com' },
          type: 'email', enabled: true, verificationStatus: 'VERIFIED',
        };
      }),
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.publicReport.alertChannel, 'verified');
    assert.deepEqual(requests, [{
      method: 'GET', url: `https://monitoring.googleapis.com/v3/${PROJECT_ID_CHANNEL}`,
    }]);
  });

  await t.test('verified channel for a different email address is rejected', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${CHANNEL}`],
      contract: await contractFixture(),
      gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com',
      request: preflightReadRequest(async () => ({
        name: CHANNEL,
        displayName: 'HK Buddy V1 operations',
        userLabels: {
          application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations',
        },
        labels: { email_address: 'attacker@example.test' },
        type: 'email', enabled: true, verificationStatus: 'VERIFIED',
      })),
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'ALERT_CHANNEL_UNVERIFIED');
  });

  await t.test('unverified channel', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${CHANNEL}`],
      contract: await contractFixture(),
      gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com',
      request: preflightReadRequest(async () => ({
        name: CHANNEL, displayName: 'HK Buddy V1 operations',
        userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
        type: 'email', enabled: true, verificationStatus: 'UNVERIFIED',
      })),
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'ALERT_CHANNEL_UNVERIFIED');
  });

  await t.test('verified non-email channel is rejected before alert or budget work', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${CHANNEL}`], contract: await contractFixture(),
      gcloud: fixture.gcloud, getRestPrincipal: async () => 'admin@motionexp.com',
      request: preflightReadRequest(async () => ({
        name: CHANNEL, displayName: 'HK Buddy V1 operations',
        userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
        type: 'sms', enabled: true, verificationStatus: 'VERIFIED',
      })),
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'ALERT_CHANNEL_UNVERIFIED');
  });

  await t.test('403 project lookup is a shared-project baseline failure', async () => {
    const fixture = preflightGcloud({ forbidden: true });
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com', writeOutput: () => undefined,
      request: preflightReadRequest(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'SHARED_PROJECT_BASELINE_INVALID');
    assert.equal(result.publicReport.projectState, 'unresolved');
    assert.equal(fixture.calls.some((args) => args.includes('create')), false);
  });

  await t.test('gcloud and HTTPS identities must be the same approved principal', async () => {
    const fixture = preflightGcloud();
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'different@example.test', writeOutput: () => undefined,
      request: preflightReadRequest(),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'CONTROL_PLANE_IDENTITY_MISMATCH');
    assert.equal(result.publicReport.mutationPerformed, false);
  });

  await t.test('a matching but non-contract operator is rejected before organization checks', async () => {
    const fixture = preflightGcloud({ activeAccount: 'foreign@example.test' });
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'foreign@example.test', writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'GCP_AUTH_INVALID');
    assert.equal(fixture.calls.length, 1);
    assert.equal(result.publicReport.mutationPerformed, false);
  });
});

test('confirmed provisioning requires the existing shared baseline while other 403s remain fatal', async (t) => {
  await t.test('unresolved project stops before every resource mutation', async () => {
    const plane = new MemoryControlPlane();
    let projectReads = 0;
    const baseRead = plane.read.bind(plane);
    plane.read = async (id, context) => {
      if (id === 'project' && projectReads++ === 0) {
        plane.calls.push(['read', id]);
        return { status: 'unknown', code: 'FORBIDDEN' };
      }
      return baseRead(id, context);
    };
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'SHARED_PROJECT_BASELINE_INVALID');
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
  });

  await t.test('a non-project 403 remains a hard stop', async () => {
    const plane = new MemoryControlPlane({ existing: ['project'] });
    const baseRead = plane.read.bind(plane);
    plane.read = async (id, context) => (
      id === 'billing' ? { status: 'unknown', code: 'FORBIDDEN' } : baseRead(id, context)
    );
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'SHARED_PROJECT_BASELINE_INVALID');
    assert.equal(result.publicReport.resumeBoundary, 'operator-bucket-iam-recovery-audit');
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'billing'), false);
  });
});

class MemoryControlPlane {
  constructor({
    existing = [], unverifiedChannel = false, userManagedKey = false,
    finalReadbackFailure = null, iamSubsetFailure = null,
    preMutationFailure = null, operatorRecoveryFailure = null,
    operatorPropagationFailure = null, releaseEvidencePropagationFailure = null,
  } = {}) {
    this.resources = new Map([...new Set(['project', 'billing', ...existing])].map((id) => {
      const value = { id, exact: true };
      if (id === 'project') value.projectNumber = PROJECT_NUMBER;
      if (id === 'cloud-sql-instance') value.privateIp = '10.25.0.3';
      if (id.startsWith('secret-version:')) value.version = '1';
      return [id, value];
    }));
    this.calls = [];
    this.unverifiedChannel = unverifiedChannel;
    this.userManagedKey = userManagedKey;
    this.finalReadbackFailure = finalReadbackFailure;
    this.iamSubsetFailure = iamSubsetFailure;
    this.preMutationFailure = preMutationFailure;
    this.operatorRecoveryFailure = operatorRecoveryFailure;
    this.operatorPropagationFailure = operatorPropagationFailure;
    this.releaseEvidencePropagationFailure = releaseEvidencePropagationFailure;
    this.secrets = [];
  }

  async auditOperatorBucketIamRecovery() {
    this.calls.push(['audit', 'operator-bucket-iam-recovery']);
    if (this.operatorRecoveryFailure) {
      const error = new Error(this.operatorRecoveryFailure);
      error.code = this.operatorRecoveryFailure;
      throw error;
    }
    const project = await this.read('project');
    const billing = await this.read('billing');
    if (project?.status !== 'present' || !this.compare('project', project.value)
      || billing?.status !== 'present' || !this.compare('billing', billing.value)) {
      const error = new Error('shared project baseline invalid');
      error.code = 'SHARED_PROJECT_BASELINE_INVALID';
      throw error;
    }
    return {
      existingBuckets: [GCP_IDENTITY.bucket, GCP_IDENTITY.buildSourceBucket],
    };
  }

  async waitForOperatorBucketIamAccess({ buckets }) {
    this.calls.push(['wait', 'operator-bucket-iam-propagation', [...buckets]]);
    if (this.operatorPropagationFailure) {
      const error = new Error(this.operatorPropagationFailure);
      error.code = this.operatorPropagationFailure;
      throw error;
    }
  }

  async waitForOperatorReleaseEvidenceAccess() {
    this.calls.push([
      'wait', 'operator-release-evidence-propagation', GCP_IDENTITY.bucket,
    ]);
    if (this.releaseEvidencePropagationFailure) {
      const error = new Error(this.releaseEvidencePropagationFailure);
      error.code = this.releaseEvidencePropagationFailure;
      throw error;
    }
  }

  async read(id) {
    this.calls.push(['read', id]);
    if (id === 'notification-channel') {
      return { status: 'present', value: { id, exact: !this.unverifiedChannel } };
    }
    return this.resources.has(id)
      ? { status: 'present', value: this.resources.get(id) }
      : { status: 'absent' };
  }

  async create(id, context) {
    this.calls.push(['create', id]);
    if (context?.sensitive) this.secrets.push(context.sensitive);
    const value = { id, exact: true };
    if (id === 'project') value.projectNumber = PROJECT_NUMBER;
    if (id === 'cloud-sql-instance') value.privateIp = '10.25.0.3';
    if (id.startsWith('secret-version:')) value.version = '1';
    this.resources.set(id, value);
    return value;
  }

  compare(_id, value) {
    return value?.exact === true;
  }

  value(id) {
    return this.resources.get(id);
  }

  async auditUserManagedServiceAccountKeys() {
    this.calls.push(['audit', 'service-account-keys']);
    if (this.userManagedKey) {
      const error = new Error('user-managed key');
      error.code = 'USER_MANAGED_SERVICE_ACCOUNT_KEY';
      throw error;
    }
  }

  async auditManagedIamPolicies({ projectOnly }) {
    const stage = projectOnly ? 'project' : 'managed';
    this.calls.push(['iam-subset-audit', stage]);
    if (this.iamSubsetFailure === stage) {
      const error = new Error('unexpected IAM entitlement');
      error.code = 'IAM_ALLOWLIST_MISMATCH';
      throw error;
    }
  }

  async auditPreMutationState() {
    this.calls.push(['audit', 'pre-mutation-state']);
    if (this.preMutationFailure) {
      const error = new Error(this.preMutationFailure);
      error.code = this.preMutationFailure;
      throw error;
    }
  }

  async finalReadback() {
    this.calls.push(['final-readback', 'all']);
    if (this.finalReadbackFailure) {
      const error = new Error(this.finalReadbackFailure);
      error.code = this.finalReadbackFailure;
      throw error;
    }
  }
}

test('provisioning is inert by default and requires the one exact confirmation flag', async (t) => {
  for (const argv of [
    [], ['--confirm-project=other-project'],
    [`--confirm-project=${PROJECT}`, '--extra'],
  ]) {
    await t.test(argv.join(' ') || 'no args', async () => {
      const plane = new MemoryControlPlane();
      const result = await runGcpProvision({
        argv, contract: await contractFixture(), controlPlane: plane,
        writeOutput: () => undefined,
      });
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
      if (argv.length > 0) assert.equal(result.publicReport.code, 'EXACT_PROJECT_CONFIRMATION_REQUIRED');
    });
  }
});

test('live provisioning rejects a gcloud/HTTPS identity mismatch before its first mutation', async () => {
  const calls = [];
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(),
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      throw new Error('unexpected control-plane call');
    },
    request: async () => { throw new Error('request must not run'); },
    getRestPrincipal: async () => 'different@example.test',
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'CONTROL_PLANE_IDENTITY_MISMATCH');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((args) => args.includes('create')), false);
});

test('live provisioning rejects a non-contract operator even when its CLI and HTTPS identities match', async () => {
  const calls = [];
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(),
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return [{ account: 'foreign@example.test', status: 'ACTIVE' }];
      throw new Error('unexpected control-plane call');
    },
    request: async () => { throw new Error('request must not run'); },
    getRestPrincipal: async () => 'foreign@example.test',
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'CONTROL_PLANE_IDENTITY_MISMATCH');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((args) => args.includes('create')), false);
});

test('confirmed provisioning creates every fixed step, performs post-create readback, keeps secrets out of logs, and returns numeric versions', async () => {
  const plane = new MemoryControlPlane();
  const output = [];
  const secretValues = [Buffer.alloc(32, 0x41), Buffer.alloc(32, 0x42), Buffer.alloc(32, 0x43)];
  let randomIndex = 0;
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(), controlPlane: plane,
    randomBytes: () => secretValues[randomIndex++],
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.status, 'provisioned');
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.deepEqual(result.publicReport.secretVersions, {
    [GCP_IDENTITY.secrets.dbAppUrl]: '1', [GCP_IDENTITY.secrets.dbMigratorUrl]: '1',
    [GCP_IDENTITY.secrets.session]: '1', [GCP_IDENTITY.secrets.bootstrap]: '1',
  });
  assert.equal(Object.values(result.publicReport.secretVersions).every((value) => /^\d+$/.test(value)), true);
  assert.equal(JSON.stringify(result).includes('latest'), false);

  const created = plane.calls.filter(([kind]) => kind === 'create').map(([, id]) => id);
  const recoverySteps = [
    'custom-role:hkbuddyV1BucketIamPolicyOperator', 'operator-bucket-iam-binding',
    'custom-role:hkbuddyV1ReleaseEvidenceObjectOperator',
    'operator-release-evidence-iam-binding',
  ];
  assert.deepEqual(created, [
    ...recoverySteps,
    ...EXPECTED_PROVISION_STEPS.filter((id) => (
      !['project', 'billing', 'notification-channel', ...recoverySteps].includes(id)
    )),
  ]);
  for (const id of created) {
    const sequence = plane.calls.filter(([kind, candidate]) => (
      ['read', 'create'].includes(kind) && candidate === id
    )).map(([kind]) => kind);
    assert.deepEqual(
      sequence,
      recoverySteps.includes(id)
        ? ['read', 'create', 'read', 'read']
        : ['read', 'create', 'read'],
      id,
    );
  }
  assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'notification-channel'), false);

  const serializedCommands = JSON.stringify(plane.calls);
  const serializedOutput = output.join('');
  for (const secret of secretValues.map((value) => value.toString('base64url'))) {
    assert.equal(serializedCommands.includes(secret), false);
    assert.equal(serializedOutput.includes(secret), false);
  }
  assert.equal(plane.secrets.length >= 4, true);
  assert.equal(plane.calls.some(([kind]) => kind === 'final-readback'), true);
});

test('confirmed provisioning repairs both operator IAM contracts before the full audit and every ordinary mutation', async () => {
  const plane = new MemoryControlPlane();
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(), controlPlane: plane,
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 0);
  const operatorRole = 'custom-role:hkbuddyV1BucketIamPolicyOperator';
  const operatorBinding = 'operator-bucket-iam-binding';
  const releaseEvidenceRole = 'custom-role:hkbuddyV1ReleaseEvidenceObjectOperator';
  const releaseEvidenceBinding = 'operator-release-evidence-iam-binding';
  const recoveryAuditIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'audit' && id === 'operator-bucket-iam-recovery'
  ));
  const roleCreateIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'create' && id === operatorRole
  ));
  const bindingCreateIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'create' && id === operatorBinding
  ));
  const releaseEvidenceRoleCreateIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'create' && id === releaseEvidenceRole
  ));
  const releaseEvidenceBindingCreateIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'create' && id === releaseEvidenceBinding
  ));
  const propagationIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'wait' && id === 'operator-bucket-iam-propagation'
  ));
  const releaseEvidencePropagationIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'wait' && id === 'operator-release-evidence-propagation'
  ));
  const fullAuditIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'audit' && id === 'pre-mutation-state'
  ));
  const firstOtherCreateIndex = plane.calls.findIndex(([kind, id]) => (
    kind === 'create' && ![
      operatorRole, operatorBinding, releaseEvidenceRole, releaseEvidenceBinding,
    ].includes(id)
  ));
  assert.equal(recoveryAuditIndex < roleCreateIndex, true);
  assert.equal(roleCreateIndex < bindingCreateIndex, true);
  assert.equal(bindingCreateIndex < propagationIndex, true);
  assert.equal(propagationIndex < releaseEvidenceRoleCreateIndex, true);
  assert.equal(releaseEvidenceRoleCreateIndex < releaseEvidenceBindingCreateIndex, true);
  assert.equal(releaseEvidenceBindingCreateIndex < releaseEvidencePropagationIndex, true);
  assert.equal(releaseEvidencePropagationIndex < fullAuditIndex, true);
  assert.equal(fullAuditIndex < firstOtherCreateIndex, true);
  assert.equal(plane.calls.filter(([kind, id]) => (
    kind === 'create' && [
      operatorRole, operatorBinding, releaseEvidenceRole, releaseEvidenceBinding,
    ].includes(id)
  )).length, 4);
  assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
    id.startsWith('secret-version:') || id.startsWith('db-user:')
  )), true);
});

test('operator IAM recovery failures are resumable and precede secrets, database users, and bucket baselines', async (t) => {
  await t.test('strict recovery audit failure is non-mutating', async () => {
    const plane = new MemoryControlPlane({ operatorRecoveryFailure: 'IAM_ALLOWLIST_MISMATCH' });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.resumeBoundary, 'operator-bucket-iam-recovery-audit');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
    assert.equal(plane.calls.some(([kind, id]) => kind === 'audit' && id === 'pre-mutation-state'), false);
  });

  await t.test('propagation timeout preserves the durable binding and stops before the full audit', async () => {
    const plane = new MemoryControlPlane({
      operatorPropagationFailure: 'OPERATOR_BUCKET_IAM_PROPAGATION_TIMEOUT',
    });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.resumeBoundary, 'operator-bucket-iam-propagation');
    assert.equal(result.publicReport.mutationPerformed, true);
    assert.equal(plane.resources.has('operator-bucket-iam-binding'), true);
    assert.equal(plane.calls.some(([kind, id]) => kind === 'audit' && id === 'pre-mutation-state'), false);
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
      id.includes('bucket-iam-baseline') || id.startsWith('secret-version:') || id.startsWith('db-user:')
    )), false);
  });

  await t.test('release-evidence list propagation timeout preserves both exact bindings', async () => {
    const plane = new MemoryControlPlane({
      releaseEvidencePropagationFailure: 'OPERATOR_RELEASE_EVIDENCE_IAM_PROPAGATION_TIMEOUT',
    });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.resumeBoundary, 'operator-release-evidence-iam-propagation');
    assert.equal(result.publicReport.mutationPerformed, true);
    assert.equal(plane.resources.has('operator-bucket-iam-binding'), true);
    assert.equal(plane.resources.has('operator-release-evidence-iam-binding'), true);
    assert.equal(plane.calls.some(([kind, id]) => (
      kind === 'audit' && id === 'pre-mutation-state'
    )), false);
  });

  await t.test('crash resume adopts the exact role and binding without another IAM write', async () => {
    const existing = [
      'custom-role:hkbuddyV1BucketIamPolicyOperator',
      'operator-bucket-iam-binding',
      'custom-role:hkbuddyV1ReleaseEvidenceObjectOperator',
      'operator-release-evidence-iam-binding',
    ];
    const plane = new MemoryControlPlane({ existing });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(plane.calls.some(([kind, id]) => (
      kind === 'create' && existing.includes(id)
    )), false);
    assert.equal(plane.calls.some(([kind]) => kind === 'wait'), true);
  });
});

test('both bucket IAM baselines must be sanitized before any secret version or database-user write', async () => {
  const plane = new MemoryControlPlane();
  const baseCreate = plane.create.bind(plane);
  plane.create = async (id, context) => {
    if (id === 'build-source-bucket-iam-baseline') {
      plane.calls.push(['create', id]);
      throw Object.assign(new Error('baseline policy is not safe'), {
        code: 'IAM_ALLOWLIST_MISMATCH',
      });
    }
    return baseCreate(id, context);
  };

  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(), controlPlane: plane,
    writeOutput: () => undefined,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
  assert.equal(result.publicReport.resumeBoundary, 'build-source-bucket-iam-baseline');
  assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
    id.startsWith('secret-version:') || id.startsWith('db-user:')
  )), false);
  assert.deepEqual(
    plane.calls.filter(([kind, id]) => kind === 'create' && id.includes('bucket-iam-baseline'))
      .map(([, id]) => id),
    ['bucket-iam-baseline', 'build-source-bucket-iam-baseline'],
  );
});

test('exhaustive pre-mutation audit rejects managed collisions and network overlap before every write', async (t) => {
  for (const code of ['RESOURCE_COLLISION', 'CIDR_OVERLAP', 'IAM_ALLOWLIST_MISMATCH']) {
    await t.test(code, async () => {
      const plane = new MemoryControlPlane({ preMutationFailure: code });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, code);
      assert.equal(result.publicReport.mutationPerformed, true);
      assert.deepEqual(
        plane.calls.filter(([kind]) => kind === 'create').map(([, id]) => id),
        [
          'custom-role:hkbuddyV1BucketIamPolicyOperator', 'operator-bucket-iam-binding',
          'custom-role:hkbuddyV1ReleaseEvidenceObjectOperator',
          'operator-release-evidence-iam-binding',
        ],
      );
      assert.deepEqual(plane.calls.filter(([kind]) => kind === 'audit'), [
        ['audit', 'operator-bucket-iam-recovery'], ['audit', 'pre-mutation-state'],
      ]);
    });
  }
});

test('service-account key and mandatory final-readback gates prevent a false provisioning success', async (t) => {
  await t.test('channel verification and budget precede every costly topology, secret, or IAM mutation', async () => {
    for (const { argv, plane, expectedCode } of [
      {
        argv: [`--confirm-project=${PROJECT}`],
        plane: new MemoryControlPlane(), expectedCode: 'ALERT_CHANNEL_REQUIRED',
      },
      {
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        plane: new MemoryControlPlane({ unverifiedChannel: true }), expectedCode: 'ALERT_CHANNEL_UNVERIFIED',
      },
    ]) {
      const result = await runGcpProvision({
        argv, contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, expectedCode);
      assert.deepEqual(
        plane.calls.filter(([kind]) => kind === 'create').map(([, id]) => id),
        [
          'custom-role:hkbuddyV1BucketIamPolicyOperator',
          'operator-bucket-iam-binding',
          'custom-role:hkbuddyV1ReleaseEvidenceObjectOperator',
          'operator-release-evidence-iam-binding',
          'apis',
        ],
      );
      assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
        ['vpc', 'subnet', 'psa-range', 'psa-connection', 'cloud-sql-instance', 'database', 'bucket'].includes(id)
          || id.startsWith('secret-') || id.startsWith('iam:')
      )), false);
    }
    assert.equal(EXPECTED_PROVISION_STEPS.indexOf('notification-channel') < EXPECTED_PROVISION_STEPS.indexOf('budget'), true);
    assert.equal(EXPECTED_PROVISION_STEPS.indexOf('budget') < EXPECTED_PROVISION_STEPS.indexOf('vpc'), true);
  });

  await t.test('foreign project or managed-resource IAM stops before every sensitive write', async () => {
    for (const iamSubsetFailure of ['project', 'managed']) {
      const plane = new MemoryControlPlane({ iamSubsetFailure });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
      assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
        id.startsWith('secret-version:') || id.startsWith('db-user:')
      )), false);
    }
  });

  await t.test('user-managed key stops immediately after service accounts and before resource or secret grants', async () => {
    const plane = new MemoryControlPlane({ userManagedKey: true });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'USER_MANAGED_SERVICE_ACCOUNT_KEY');
    assert.equal(result.publicReport.resumeBoundary, 'service-account-key-audit');
    const auditIndex = plane.calls.findIndex(([, id]) => id === 'service-account-keys');
    assert.equal(auditIndex > 0, true);
    assert.equal(plane.calls.slice(auditIndex + 1).some(([kind]) => kind === 'create'), false);
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
      id.startsWith('secret-') || id.startsWith('iam:') || id === 'vpc'
    )), false);
  });

  await t.test('control plane without finalReadback is invalid before mutation', async () => {
    let creates = 0;
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(),
      controlPlane: {
        read: async () => ({ status: 'absent' }),
        create: async () => { creates += 1; },
        compare: () => true,
        auditUserManagedServiceAccountKeys: async () => undefined,
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'CONTROL_PLANE_INVALID');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(creates, 0);
  });

  await t.test('final readback failure prevents GCP_PROVISION_COMPLETE', async () => {
    const plane = new MemoryControlPlane({ finalReadbackFailure: 'IAM_ALLOWLIST_MISMATCH' });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
    assert.equal(result.publicReport.resumeBoundary, 'final-readback');
    assert.equal(result.publicReport.status, 'failed');
  });
});

test('safe partial rerun skips exact resources, stops on drift, and preserves a precise resume boundary', async (t) => {
  await t.test('exact rerun does not recreate resources', async () => {
    const plane = new MemoryControlPlane({ existing: EXPECTED_PROVISION_STEPS });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
    assert.equal(result.publicReport.mutationPerformed, false);
  });

  await t.test('post-audit failure before an idempotent run attempts any create remains non-mutating', async () => {
    const plane = new MemoryControlPlane({
      existing: EXPECTED_PROVISION_STEPS,
      iamSubsetFailure: 'project',
    });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
    assert.equal(result.publicReport.mutationPerformed, false);
  });

  await t.test('ambiguous create failure remains conservatively mutation-performed', async () => {
    const plane = new MemoryControlPlane();
    plane.create = async (id) => {
      plane.calls.push(['create', id]);
      throw Object.assign(new Error('response lost'), { code: 'CREATE_RESULT_AMBIGUOUS' });
    };
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), true);
    assert.equal(result.publicReport.mutationPerformed, true);
  });

  await t.test('drift stops before later mutation', async () => {
    const plane = new MemoryControlPlane();
    plane.resources.set('vpc', { id: 'vpc', exact: false });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'RESOURCE_DRIFT');
    assert.equal(result.publicReport.resumeBoundary, 'vpc');
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'subnet'), false);
  });

  await t.test('unverified alert channel blocks policies and budget', async () => {
    const plane = new MemoryControlPlane({ unverifiedChannel: true });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'ALERT_CHANNEL_UNVERIFIED');
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id.startsWith('monitoring-policy:')), false);
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'budget'), false);
  });
});

test('package scripts expose guarded preflight/provision commands and syntax-check both entrypoints', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['gcp:preflight'], 'node scripts/gcp-preflight.js');
  assert.equal(packageJson.scripts['gcp:provision'], 'node scripts/gcp-provision.js');
  assert.match(packageJson.scripts.check, /node --check scripts\/gcp-preflight\.js/);
  assert.match(packageJson.scripts.check, /node --check scripts\/gcp-provision\.js/);
});
