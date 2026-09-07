import { createHash } from 'node:crypto';

import { GCP_IDENTITY } from '../src/gcp-identity.js';
import { cloudRunTaggedUrl, normalizeCloudRunV1ServiceUrls } from '../src/cloud-run-urls.js';
import { containsForbiddenPersistedSecret } from './persisted-secret-contract.js';

const SCHEMA_VERSION = 4;
const MAXIMUM_AGE_MS = 5 * 60_000;
const QUOTA_PROJECT = 'tech-demo-433408';
const OPERATOR = 'admin@motionexp.com';
const INVOKE_PERMISSION = 'run.routes.invoke';
const INVOKER_ROLE = 'roles/run.servicesInvoker';
const TOKEN_CREATOR_ROLE = 'roles/iam.serviceAccountOpenIdTokenCreator';
const RELEASE_SHA = /^[0-9a-f]{40}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ETAG = /^(?:(?:[A-Za-z0-9+/]{4}){1,255}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?|(?:[A-Za-z0-9_-]{4}){1,255}(?:[A-Za-z0-9_-]{2}==|[A-Za-z0-9_-]{3}=)?)$/u;
const SAFE_ROLE = /^(?:roles\/[A-Za-z0-9_.-]{1,128}|(?:projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]|organizations\/[1-9]\d*)\/roles\/[A-Za-z0-9_.-]{1,128})$/u;
const PUBLIC_PRINCIPALS = new Set(['allUsers', 'allAuthenticatedUsers']);
const PUBLIC_DENIAL_METHOD = 'effective-policy-role-definition-exclusion-v1';
const MAX_PUBLIC_DENIAL_BYTES = 1024 * 1024;
const LOG_POLL_INTERVAL_MS = 5_000;
const LOG_POLL_ATTEMPTS = Math.ceil(MAXIMUM_AGE_MS / LOG_POLL_INTERVAL_MS) + 1;
const READINESS_COMPONENTS = Object.freeze([
  'configuration', 'release-evidence', 'llm-smoke', 'database', 'media',
  'corpus', 'retention', 'dispatcher', 'runtime',
]);
const SAFE_READINESS_TOKEN = /^[a-z0-9][a-z0-9._-]{0,79}$/iu;

function fail() {
  throw new Error('Candidate privacy proof failed');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function exact(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function safeObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && !containsForbiddenPersistedSecret(value));
}

function candidateResource(binding) {
  return `//run.googleapis.com/projects/${binding.projectId}/locations/${binding.region}/services/${binding.candidateService}`;
}

function normalizedProbe(value) {
  if (!exactKeys(value, [
    'failureThreshold', 'initialDelaySeconds', 'path', 'periodSeconds', 'port', 'timeoutSeconds',
  ]) || typeof value.path !== 'string' || !value.path.startsWith('/')
    || ![value.failureThreshold, value.initialDelaySeconds, value.periodSeconds, value.port,
      value.timeoutSeconds].every(Number.isSafeInteger)
    || value.failureThreshold < 1 || value.initialDelaySeconds < 0 || value.periodSeconds < 1
    || value.port < 1 || value.port > 65_535 || value.timeoutSeconds < 1) fail();
  return canonical(value);
}

function normalizedStringMap(value) {
  if (!safeObject(value)) fail();
  const output = {};
  for (const [name, member] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) || typeof member !== 'string'
      || member.length > 4096 || /[\u0000\r\n]/u.test(member)) fail();
    output[name] = member;
  }
  return canonical(output);
}

function normalizedExpectedCandidate(value, binding) {
  const expectedKeys = [
    ...(value?.access === undefined ? [] : ['access']),
    'concurrency', 'cpu', 'cpuThrottling', 'environment', 'executionEnvironment', 'image',
    'invokerIamDisabled', 'maxInstances', 'memory', 'minInstances', 'network', 'probes',
    'project', 'region', 'revision', 'secretEnvironment', 'secretMounts', 'service',
    'serviceAccount', 'startupCpuBoost', 'subnet', 'tag', 'timeoutSeconds', 'traffic',
    'trafficState', 'vpcEgress',
    ...(value?.iam === undefined ? [] : ['iam']),
  ];
  if (!exactKeys(value, expectedKeys) || value.project !== binding.projectId || value.region !== binding.region
    || value.service !== binding.candidateService || value.revision !== binding.candidateRevision
    || value.tag !== binding.candidateTag || value.image !== binding.image
    || value.invokerIamDisabled !== false || value.trafficState !== 'candidate-service-private-100'
    || !exact(value.traffic, [{
      revision: binding.candidateRevision, tag: binding.candidateTag, percent: 100,
    }]) || value.serviceAccount !== GCP_IDENTITY.serviceAccounts.runtime
    || value.executionEnvironment !== 'gen2'
    || !Number.isSafeInteger(value.cpu) || value.cpu < 1
    || typeof value.memory !== 'string' || !/^\d+(?:Mi|Gi)$/u.test(value.memory)
    || !Number.isSafeInteger(value.concurrency) || value.concurrency < 1
    || !Number.isSafeInteger(value.minInstances) || value.minInstances < 0
    || !Number.isSafeInteger(value.maxInstances) || value.maxInstances < value.minInstances
    || typeof value.cpuThrottling !== 'boolean' || typeof value.startupCpuBoost !== 'boolean'
    || !Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1
    || value.network !== GCP_IDENTITY.network || value.subnet !== GCP_IDENTITY.subnet
    || value.vpcEgress !== 'private-ranges-only'
    || !exactKeys(value.probes, ['liveness', 'readiness', 'startup'])
    || !safeObject(value.secretEnvironment) || !safeObject(value.secretMounts)
    || (value.access !== undefined && !exact(value.access, {
      authenticated: true,
      audience: binding.candidateAudience,
      issuer: 'https://accounts.google.com',
      subjectSha256: createHash('sha256').update(binding.acceptanceServiceAccount).digest('hex'),
      taggedUrl: binding.candidateOrigin,
    }))
    || (value.iam !== undefined && !exact(value.iam, { policy: 'candidate-private' }))) fail();
  const environment = normalizedStringMap(value.environment);
  const secretEnvironment = {};
  for (const [name, member] of Object.entries(value.secretEnvironment)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name)
      || !exactKeys(member, ['secret', 'version'])
      || typeof member.secret !== 'string' || !/^[a-z][a-z0-9-]{0,254}$/u.test(member.secret)
      || !/^[1-9]\d*$/u.test(String(member.version ?? ''))) fail();
    secretEnvironment[name] = canonical(member);
  }
  const secretMounts = {};
  for (const [name, member] of Object.entries(value.secretMounts)) {
    if (!/^[a-z][A-Za-z0-9]{0,62}$/u.test(name)
      || !exactKeys(member, ['path', 'readOnly', 'secret', 'version'])
      || typeof member.path !== 'string' || !member.path.startsWith('/')
      || member.readOnly !== true || typeof member.secret !== 'string'
      || !/^[a-z][a-z0-9-]{0,254}$/u.test(member.secret)
      || !/^[1-9]\d*$/u.test(String(member.version ?? ''))) fail();
    secretMounts[name] = canonical(member);
  }
  return deepFreeze({
    ...canonical(value),
    environment,
    secretEnvironment: canonical(secretEnvironment),
    secretMounts: canonical(secretMounts),
    probes: {
      startup: normalizedProbe(value.probes.startup),
      liveness: normalizedProbe(value.probes.liveness),
      readiness: normalizedProbe(value.probes.readiness),
    },
  });
}

function normalizedBinding(value) {
  if (!exactKeys(value, [
    'acceptanceServiceAccount', 'candidateAudience', 'candidateOrigin', 'candidateRevision',
    'candidateService', 'candidateTag', 'expectedCandidate', 'image', 'imageDigest', 'operator',
    'organizationId', 'projectId', 'projectNumber', 'region', 'releaseSha',
  ])
    || value.projectId !== GCP_IDENTITY.projectId
    || value.projectNumber !== GCP_IDENTITY.projectNumber
    || value.organizationId !== GCP_IDENTITY.organizationId
    || value.region !== GCP_IDENTITY.region
    || value.candidateService !== GCP_IDENTITY.candidateService
    || value.acceptanceServiceAccount !== GCP_IDENTITY.serviceAccounts.acceptance
    || value.operator !== OPERATOR
    || !RELEASE_SHA.test(String(value.releaseSha ?? ''))
    || !IMAGE_DIGEST.test(String(value.imageDigest ?? ''))
    || value.image !== `${value.region}-docker.pkg.dev/${value.projectId}/${GCP_IDENTITY.repository}/hkbuddy-v1-api@${value.imageDigest}`) fail();
  const suffix = value.releaseSha.slice(0, 12);
  const expectedRevision = `${GCP_IDENTITY.candidateService}-${suffix}`;
  const expectedTag = `candidate-${suffix}`;
  const expectedAudience = `https://${GCP_IDENTITY.candidateService}-${GCP_IDENTITY.projectNumber}.${GCP_IDENTITY.region}.run.app`;
  const expectedOrigin = `https://${expectedTag}---${GCP_IDENTITY.candidateService}-${GCP_IDENTITY.projectNumber}.${GCP_IDENTITY.region}.run.app`;
  if (value.candidateRevision !== expectedRevision || value.candidateTag !== expectedTag
    || value.candidateAudience !== expectedAudience || value.candidateOrigin !== expectedOrigin) fail();
  return deepFreeze({ ...value, expectedCandidate: normalizedExpectedCandidate(value.expectedCandidate, value) });
}

function frozenArgv(...values) {
  if (values.some((value) => typeof value !== 'string' || /[\u0000\r\n]/u.test(value))) fail();
  return Object.freeze(values);
}

export function createCandidatePrivacyCommandPlan(rawBinding) {
  const binding = normalizedBinding(rawBinding);
  const resource = candidateResource(binding);
  return deepFreeze({
    candidateResource: resource,
    hierarchy: {
      projectDescribe: frozenArgv(
        'projects', 'describe', binding.projectId, `--project=${binding.projectId}`, '--format=json',
      ),
      serviceIam: frozenArgv(
        'run', 'services', 'get-iam-policy', binding.candidateService,
        `--project=${binding.projectId}`, `--region=${binding.region}`, '--format=json',
      ),
      projectIam: frozenArgv(
        'projects', 'get-iam-policy', binding.projectId,
        `--project=${binding.projectId}`, '--format=json',
      ),
      organizationIam: frozenArgv(
        'organizations', 'get-iam-policy', binding.organizationId,
        `--project=${binding.projectId}`, '--format=json',
      ),
      organizationDescribe: frozenArgv(
        'organizations', 'describe', binding.organizationId, '--format=json',
      ),
    },
    controlPlane: {
      service: frozenArgv(
        'run', 'services', 'describe', binding.candidateService,
        `--project=${binding.projectId}`, `--region=${binding.region}`, '--format=json',
      ),
      revision: frozenArgv(
        'run', 'revisions', 'describe', binding.candidateRevision,
        `--project=${binding.projectId}`, `--region=${binding.region}`, '--format=json',
      ),
      artifact: frozenArgv(
        'artifacts', 'docker', 'images', 'describe', binding.image,
        `--project=${binding.projectId}`,
        '--format=json(image_summary.digest,image_summary.fully_qualified_digest)',
      ),
    },
    tokenPrerequisite: frozenArgv(
      'iam', 'service-accounts', 'get-iam-policy', binding.acceptanceServiceAccount,
      `--project=${binding.projectId}`, '--format=json',
    ),
    assetEffectiveIam: frozenArgv(
      'asset', 'get-effective-iam-policy',
      `--scope=organizations/${binding.organizationId}`,
      `--names=${resource}`,
      `--billing-project=${QUOTA_PROJECT}`, '--format=json',
    ),
    troubleshooter: frozenArgv(
      'policy-troubleshoot', 'iam', resource,
      `--principal-email=${binding.acceptanceServiceAccount}`, `--permission=${INVOKE_PERMISSION}`,
      `--project=${binding.projectId}`, '--format=json',
    ),
    token: {
      generateIdToken: {
        endpoint: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(binding.acceptanceServiceAccount)}:generateIdToken`,
        body: { audience: binding.candidateAudience, includeEmail: true },
      },
    },
  });
}

function folderDescribeArgv(folderId, binding) {
  return frozenArgv(
    'resource-manager', 'folders', 'describe', folderId,
    `--project=${binding.projectId}`, '--format=json',
  );
}

function folderIamArgv(folderId, binding) {
  return frozenArgv(
    'resource-manager', 'folders', 'get-iam-policy', folderId,
    `--project=${binding.projectId}`, '--format=json',
  );
}

function roleDescribeArgv(role, binding) {
  if (!SAFE_ROLE.test(String(role ?? ''))) fail();
  if (role.startsWith('projects/')) {
    const prefix = `projects/${binding.projectId}/roles/`;
    if (!role.startsWith(prefix)) fail();
    return frozenArgv('iam', 'roles', 'describe', role.slice(prefix.length), `--project=${binding.projectId}`, '--format=json');
  }
  if (role.startsWith('organizations/')) {
    const prefix = `organizations/${binding.organizationId}/roles/`;
    if (!role.startsWith(prefix)) fail();
    return frozenArgv('iam', 'roles', 'describe', role.slice(prefix.length), `--organization=${binding.organizationId}`, '--format=json');
  }
  return frozenArgv('iam', 'roles', 'describe', role, '--format=json');
}

async function execute(executor, argv) {
  if (typeof executor !== 'function') fail();
  const value = await executor([...argv]);
  if (value === undefined || value === null) fail();
  return value;
}

function validatePolicy(value) {
  const allowedTopLevel = new Set(['auditConfigs', 'bindings', 'etag', 'version']);
  const rawBindings = value?.bindings === undefined ? [] : value.bindings;
  const rawAuditConfigs = value?.auditConfigs === undefined ? [] : value.auditConfigs;
  if (!safeObject(value) || Object.keys(value).some((key) => !allowedTopLevel.has(key))
    || !Array.isArray(rawBindings) || !Array.isArray(rawAuditConfigs)
    || !SAFE_ETAG.test(String(value.etag ?? '')) || ![1, 3].includes(value.version)) fail();
  const bindings = [];
  for (const binding of rawBindings) {
    const bindingKeys = binding?.condition === undefined
      ? ['members', 'role'] : ['condition', 'members', 'role'];
    if (!exactKeys(binding, bindingKeys) || !SAFE_ROLE.test(String(binding.role ?? ''))
      || !Array.isArray(binding.members) || binding.members.length < 1
      || binding.members.some((member) => typeof member !== 'string' || member.length < 1
        || member.length > 512 || /[\u0000\r\n]/u.test(member))
      || new Set(binding.members).size !== binding.members.length) fail();
    let condition;
    if (binding.condition !== undefined) {
      const conditionKeys = [
        ...(Object.hasOwn(binding.condition, 'description') ? ['description'] : []),
        'expression',
        ...(Object.hasOwn(binding.condition, 'location') ? ['location'] : []),
        'title',
      ];
      if (value.version !== 3 || !exactKeys(binding.condition, conditionKeys)
        || Object.values(binding.condition).some((member) => (
          typeof member !== 'string' || member.length < 1 || member.length > 4096
            || /[\u0000\r\n]/u.test(member)
        ))) fail();
      condition = canonical(binding.condition);
    }
    bindings.push({
      role: binding.role,
      members: [...binding.members].sort(),
      ...(condition === undefined ? {} : { condition }),
    });
  }
  bindings.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (new Set(bindings.map((binding) => JSON.stringify(binding))).size !== bindings.length) fail();
  const auditConfigs = rawAuditConfigs.map((config) => {
    if (!exactKeys(config, ['auditLogConfigs', 'service']) || typeof config.service !== 'string'
      || config.service.length < 1 || config.service.length > 256
      || !Array.isArray(config.auditLogConfigs)) fail();
    const auditLogConfigs = config.auditLogConfigs.map((member) => {
      const keys = member?.exemptedMembers === undefined
        ? ['logType'] : ['exemptedMembers', 'logType'];
      const exemptedMembers = member?.exemptedMembers ?? [];
      if (!exactKeys(member, keys) || !['ADMIN_READ', 'DATA_READ', 'DATA_WRITE'].includes(member.logType)
        || !Array.isArray(exemptedMembers)
        || exemptedMembers.some((entry) => typeof entry !== 'string' || entry.length < 1
          || entry.length > 512 || /[\u0000\r\n]/u.test(entry))
        || new Set(exemptedMembers).size !== exemptedMembers.length) fail();
      return { logType: member.logType, exemptedMembers: [...exemptedMembers].sort() };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (new Set(auditLogConfigs.map((member) => member.logType)).size !== auditLogConfigs.length) fail();
    return { service: config.service, auditLogConfigs };
  }).sort((left, right) => left.service.localeCompare(right.service));
  if (new Set(auditConfigs.map(({ service }) => service)).size !== auditConfigs.length) fail();
  return deepFreeze({
    version: value.version, etag: value.etag, bindings, auditConfigs,
  });
}

function validateCandidateServicePolicy(policy, binding) {
  if (policy.auditConfigs.length !== 0 || policy.bindings.length !== 1 || !exact(policy.bindings[0], {
    role: INVOKER_ROLE,
    members: [`serviceAccount:${binding.acceptanceServiceAccount}`],
  })) fail();
}

function validateProject(value, binding) {
  if (!safeObject(value) || value.projectId !== binding.projectId
    || String(value.projectNumber) !== binding.projectNumber
    || value.lifecycleState !== 'ACTIVE' || !safeObject(value.parent)
    || !['folder', 'organization'].includes(value.parent.type)
    || !/^[1-9]\d*$/u.test(String(value.parent.id ?? ''))) fail();
  return deepFreeze({
    projectId: value.projectId,
    projectNumber: String(value.projectNumber),
    lifecycleState: value.lifecycleState,
    parent: { type: value.parent.type, id: String(value.parent.id) },
  });
}

function normalizedFolder(value, folderId) {
  const allowedKeys = new Set([
    'createTime', 'displayName', 'lifecycleState', 'name', 'parent', 'tags', 'updateTime',
  ]);
  const tags = value?.tags ?? {};
  if (!safeObject(value) || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.name !== `folders/${folderId}`
    || !/^(?:folders|organizations)\/[1-9]\d*$/u.test(String(value.parent ?? ''))
    || value.lifecycleState !== 'ACTIVE' || !safeObject(tags)
    || Object.entries(tags).some(([key, member]) => (
      typeof key !== 'string' || key.length < 1 || key.length > 512 || /[\u0000\r\n]/u.test(key)
        || typeof member !== 'string' || member.length < 1 || member.length > 512
        || /[\u0000\r\n]/u.test(member)
    ))) fail();
  return deepFreeze({
    name: value.name, parent: value.parent, lifecycleState: value.lifecycleState,
    ...(value.tags === undefined ? {} : { tags: canonical(tags) }),
  });
}

function validGoogleTimestamp(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(String(value ?? ''));
  if (!match) return false;
  const milliseconds = (match[2] ?? '').padEnd(3, '0').slice(0, 3);
  const canonicalMilliseconds = `${match[1]}.${milliseconds}Z`;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonicalMilliseconds;
}

function normalizedOrganization(value, binding) {
  const allowedKeys = new Set([
    'createTime', 'creationTime', 'directoryCustomerId', 'displayName', 'lifecycleState', 'name',
    'owner', 'updateTime',
  ]);
  const timestamp = value?.creationTime ?? value?.createTime;
  if (!safeObject(value) || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.name !== `organizations/${binding.organizationId}`
    || value.lifecycleState !== 'ACTIVE'
    || (value.creationTime !== undefined && value.createTime !== undefined)
    || (timestamp !== undefined && !validGoogleTimestamp(timestamp))) fail();
  return deepFreeze({
    name: value.name,
    lifecycleState: value.lifecycleState,
    ...(timestamp === undefined ? {} : { creationTime: timestamp }),
  });
}

async function readHierarchySnapshot(binding, plan, executor) {
  const project = validateProject(await execute(executor, plan.hierarchy.projectDescribe), binding);
  const servicePolicy = validatePolicy(await execute(executor, plan.hierarchy.serviceIam));
  validateCandidateServicePolicy(servicePolicy, binding);
  const projectPolicy = validatePolicy(await execute(executor, plan.hierarchy.projectIam));
  const folders = [];
  let parent = `${project.parent.type}s/${project.parent.id}`;
  const seen = new Set();
  while (parent.startsWith('folders/')) {
    const folderId = parent.slice('folders/'.length);
    if (seen.has(folderId) || seen.size >= 16) fail();
    seen.add(folderId);
    const folder = normalizedFolder(await execute(executor, folderDescribeArgv(folderId, binding)), folderId);
    const policy = validatePolicy(await execute(executor, folderIamArgv(folderId, binding)));
    folders.push({ folder, policy });
    parent = folder.parent;
  }
  if (parent !== `organizations/${binding.organizationId}`) fail();
  const organization = normalizedOrganization(
    await execute(executor, plan.hierarchy.organizationDescribe), binding,
  );
  const organizationPolicy = validatePolicy(await execute(executor, plan.hierarchy.organizationIam));
  return deepFreeze({
    project, organization,
    chain: [candidateResource(binding), `projects/${binding.projectNumber}`,
      ...folders.map(({ folder }) => folder.name), `organizations/${binding.organizationId}`],
    policies: {
      service: servicePolicy,
      project: projectPolicy,
      folders: folders.map(({ folder, policy }) => ({ name: folder.name, policy })),
      organization: organizationPolicy,
    },
  });
}

function publicRoleBindings(value, result = []) {
  if (Array.isArray(value)) {
    for (const member of value) publicRoleBindings(member, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (typeof value.role === 'string' && Array.isArray(value.members)
    && value.members.some((member) => PUBLIC_PRINCIPALS.has(member))) result.push(value);
  for (const member of Object.values(value)) publicRoleBindings(member, result);
  return result;
}

function normalizeEmbeddedPolicy(value) {
  if (!safeObject(value) || Object.keys(value).some((key) => (
    !['auditConfigs', 'bindings'].includes(key)
  ))) fail();
  const rawBindings = value.bindings ?? [];
  if (!Array.isArray(rawBindings)) fail();
  const normalized = validatePolicy({
    ...value,
    etag: 'AAAA',
    version: rawBindings.some((binding) => binding?.condition !== undefined) ? 3 : 1,
  });
  return { bindings: normalized.bindings, auditConfigs: normalized.auditConfigs };
}

function validateEffectivePolicy(value, binding, snapshot) {
  if (!exactKeys(value, ['policyResults']) || !Array.isArray(value.policyResults)
    || value.policyResults.length !== 1 || containsForbiddenPersistedSecret(value)) fail();
  const result = value.policyResults[0];
  if (!exactKeys(result, ['fullResourceName', 'policies'])
    || result.fullResourceName !== candidateResource(binding)
    || !Array.isArray(result.policies)) fail();
  const allExpected = [
    { attachedResource: candidateResource(binding), policy: snapshot.policies.service },
    {
      attachedResource: `//cloudresourcemanager.googleapis.com/projects/${binding.projectId}`,
      policy: snapshot.policies.project,
    },
    ...snapshot.policies.folders.map(({ name, policy }) => ({
      attachedResource: `//cloudresourcemanager.googleapis.com/${name}`,
      policy,
    })),
    {
      attachedResource: `//cloudresourcemanager.googleapis.com/organizations/${binding.organizationId}`,
      policy: snapshot.policies.organization,
    },
  ];
  const expected = allExpected.filter(({ attachedResource, policy }) => (
    attachedResource === candidateResource(binding)
      || policy.bindings.length > 0 || policy.auditConfigs.length > 0
  ));
  const policies = result.policies.map((member) => {
    if (!exactKeys(member, ['attachedResource', 'policy'])
      || typeof member.attachedResource !== 'string') fail();
    return { attachedResource: member.attachedResource, policy: normalizeEmbeddedPolicy(member.policy) };
  });
  const expectedEmbedded = expected.map(({ attachedResource, policy }) => ({
    attachedResource,
    policy: { bindings: policy.bindings, auditConfigs: policy.auditConfigs },
  }));
  if (!exact(policies, expectedEmbedded)) fail();
  return deepFreeze({
    policyResults: [{ fullResourceName: result.fullResourceName, policies }],
  });
}

async function resolvePublicRoles({ snapshot, effectivePolicy, binding, executor }) {
  const roles = [...new Set([
    ...publicRoleBindings(snapshot), ...publicRoleBindings(effectivePolicy),
  ].map(({ role }) => role))].sort();
  const definitions = [];
  for (const role of roles) {
    const value = await execute(executor, roleDescribeArgv(role, binding));
    const allowedKeys = new Set([
      'deleted', 'description', 'etag', 'includedPermissions', 'name', 'stage', 'title',
    ]);
    if (!safeObject(value) || Object.keys(value).some((key) => !allowedKeys.has(key))
      || value.deleted === true || value.stage === 'DISABLED'
      || !Array.isArray(value.includedPermissions)
      || value.includedPermissions.some((permission) => typeof permission !== 'string'
        || permission.length < 1 || permission.length > 256)
      || new Set(value.includedPermissions).size !== value.includedPermissions.length
      || value.name !== role) fail();
    const definition = {
      role,
      includedPermissions: [...new Set(value.includedPermissions)].sort(),
      stage: value.stage,
      deleted: value.deleted === true,
    };
    if (definition.includedPermissions.includes(INVOKE_PERMISSION)) fail();
    definitions.push(definition);
  }
  return deepFreeze(definitions);
}

function validateTokenPrerequisite(value, binding) {
  const policy = validatePolicy(value);
  if (!policy.bindings.some((member) => exact(member, {
    role: TOKEN_CREATOR_ROLE,
    members: [`user:${binding.operator}`],
  }))) fail();
  return policy;
}

function publicRoleDefinitionProjection(definitions) {
  return definitions.map(({ role, includedPermissions }) => ({ role, includedPermissions }));
}

function normalizedAttestedHierarchyChain(value, binding) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 19
    || value[0] !== candidateResource(binding)
    || value[1] !== `projects/${binding.projectNumber}`
    || value.at(-1) !== `organizations/${binding.organizationId}`
    || value.slice(2, -1).some((member) => !/^folders\/[1-9]\d*$/u.test(String(member ?? '')))
    || new Set(value).size !== value.length) fail();
  return [...value];
}

function normalizedAttestedEffectivePolicy(value, binding, hierarchyChain) {
  if (!exactKeys(value, ['policyResults']) || !Array.isArray(value.policyResults)
    || value.policyResults.length !== 1
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PUBLIC_DENIAL_BYTES
    || containsForbiddenPersistedSecret(value)) fail();
  const result = value.policyResults[0];
  if (!exactKeys(result, ['fullResourceName', 'policies'])
    || result.fullResourceName !== candidateResource(binding)
    || !Array.isArray(result.policies) || result.policies.length < 1
    || result.policies.length > hierarchyChain.length) fail();
  const allowedResources = [
    candidateResource(binding),
    `//cloudresourcemanager.googleapis.com/projects/${binding.projectId}`,
    ...hierarchyChain.slice(2, -1).map((name) => (
      `//cloudresourcemanager.googleapis.com/${name}`
    )),
    `//cloudresourcemanager.googleapis.com/organizations/${binding.organizationId}`,
  ];
  let previousIndex = -1;
  const policies = result.policies.map((member, index) => {
    if (!exactKeys(member, ['attachedResource', 'policy'])) fail();
    const resourceIndex = allowedResources.indexOf(member.attachedResource);
    if (resourceIndex <= previousIndex || (index === 0 && resourceIndex !== 0)) fail();
    previousIndex = resourceIndex;
    const policy = normalizeEmbeddedPolicy(member.policy);
    if (!exact(member.policy, policy)
      || (index > 0 && policy.bindings.length === 0 && policy.auditConfigs.length === 0)) fail();
    return { attachedResource: member.attachedResource, policy };
  });
  const servicePolicy = policies[0].policy;
  if (servicePolicy.auditConfigs.length !== 0 || servicePolicy.bindings.length !== 1
    || !exact(servicePolicy.bindings[0], {
      role: INVOKER_ROLE,
      members: [`serviceAccount:${binding.acceptanceServiceAccount}`],
    })) fail();
  return deepFreeze({
    policyResults: [{ fullResourceName: result.fullResourceName, policies }],
  });
}

function derivePublicPrincipalResults(effectivePolicy, definitionsByRole) {
  const effectivePolicies = effectivePolicy.policyResults[0].policies;
  const principals = {};
  const referencedRoles = new Set();
  for (const principal of PUBLIC_PRINCIPALS) {
    const bindings = [];
    for (const { attachedResource, policy } of effectivePolicies) {
      for (const iamBinding of policy.bindings) {
        if (!iamBinding.members.includes(principal)) continue;
        if (!definitionsByRole.has(iamBinding.role)) fail();
        referencedRoles.add(iamBinding.role);
        bindings.push({
          attachedResource,
          role: iamBinding.role,
          bindingSha256: canonicalSha256(iamBinding),
        });
      }
    }
    bindings.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    principals[principal] = {
      decision: 'DENIED', bindingCount: bindings.length, bindings,
    };
  }
  return { principals, referencedRoles: [...referencedRoles].sort() };
}

function createPublicPrincipalDenial({ snapshot, effectivePolicy, roleDefinitions }) {
  const projectedDefinitions = publicRoleDefinitionProjection(roleDefinitions);
  const definitionsByRole = new Map(projectedDefinitions.map((definition) => (
    [definition.role, definition]
  )));
  const hierarchyChain = [...snapshot.chain];
  const effectivePolicyProjection = canonical(effectivePolicy);
  const { principals, referencedRoles } = derivePublicPrincipalResults(
    effectivePolicyProjection, definitionsByRole,
  );
  if (!exact(referencedRoles, projectedDefinitions.map(({ role }) => role))) fail();
  const payload = {
    method: PUBLIC_DENIAL_METHOD,
    permission: INVOKE_PERMISSION,
    hierarchyChain,
    effectivePolicyProjection,
    sources: {
      effectiveIamSha256: canonicalSha256(effectivePolicyProjection),
      hierarchyChainSha256: canonicalSha256(hierarchyChain),
      roleDefinitionsSha256: canonicalSha256(projectedDefinitions),
    },
    roleDefinitions: projectedDefinitions,
    principals,
  };
  return deepFreeze({ ...payload, attestationSha256: canonicalSha256(payload) });
}

function validatePublicPrincipalDenial(value, { binding, effectiveIamSha256, hierarchyChainSha256,
  roleDefinitionsSha256 }) {
  if (!exactKeys(value, [
    'attestationSha256', 'effectivePolicyProjection', 'hierarchyChain', 'method', 'permission',
    'principals', 'roleDefinitions', 'sources',
  ])
    || value.method !== PUBLIC_DENIAL_METHOD || value.permission !== INVOKE_PERMISSION
    || !DIGEST.test(String(value.attestationSha256 ?? ''))
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PUBLIC_DENIAL_BYTES
    || !exactKeys(value.sources, [
      'effectiveIamSha256', 'hierarchyChainSha256', 'roleDefinitionsSha256',
    ])
    || value.sources.effectiveIamSha256 !== effectiveIamSha256
    || value.sources.hierarchyChainSha256 !== hierarchyChainSha256
    || value.sources.roleDefinitionsSha256 !== roleDefinitionsSha256
    || !Array.isArray(value.roleDefinitions)
    || !exactKeys(value.principals, ['allAuthenticatedUsers', 'allUsers'])
    || containsForbiddenPersistedSecret(value)) fail();

  const hierarchyChain = normalizedAttestedHierarchyChain(value.hierarchyChain, binding);
  if (canonicalSha256(hierarchyChain) !== hierarchyChainSha256) fail();
  const effectivePolicy = normalizedAttestedEffectivePolicy(
    value.effectivePolicyProjection, binding, hierarchyChain,
  );
  if (!exact(value.effectivePolicyProjection, effectivePolicy)
    || canonicalSha256(effectivePolicy) !== effectiveIamSha256) fail();

  const definitions = [];
  for (const definition of value.roleDefinitions) {
    if (!exactKeys(definition, ['includedPermissions', 'role'])
      || !SAFE_ROLE.test(String(definition.role ?? ''))
      || !Array.isArray(definition.includedPermissions)
      || definition.includedPermissions.some((permission) => (
        typeof permission !== 'string' || permission.length < 1 || permission.length > 256
      ))
      || !exact(definition.includedPermissions, [...new Set(definition.includedPermissions)].sort())
      || definition.includedPermissions.includes(INVOKE_PERMISSION)) fail();
    definitions.push(canonical(definition));
  }
  if (!exact(definitions, [...definitions].sort((left, right) => left.role.localeCompare(right.role)))
    || new Set(definitions.map(({ role }) => role)).size !== definitions.length
    || canonicalSha256(definitions) !== roleDefinitionsSha256) fail();
  const definitionsByRole = new Map(definitions.map((definition) => [definition.role, definition]));
  const derived = derivePublicPrincipalResults(effectivePolicy, definitionsByRole);
  if (!exact(value.principals, derived.principals)
    || !exact(derived.referencedRoles, definitions.map(({ role }) => role))) fail();
  const { attestationSha256, ...payload } = value;
  if (canonicalSha256(payload) !== attestationSha256) fail();
  return deepFreeze(canonical(value));
}

function containsForbiddenTroubleshooterState(value) {
  if (typeof value === 'string') {
    return [
      'ACCESS_STATE_UNSPECIFIED', 'CONDITIONAL', 'INFO_DENIED', 'UNKNOWN', 'UNSPECIFIED',
    ].includes(value) || value.endsWith('_UNKNOWN') || value.endsWith('_UNSPECIFIED');
  }
  if (Array.isArray(value)) return value.some(containsForbiddenTroubleshooterState);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsForbiddenTroubleshooterState);
}

function validateTroubleshooter(value, binding) {
  const topLevelKeys = Object.keys(value ?? {}).sort().join('\0');
  const partialErrors = value?.errors === undefined ? [] : value.errors;
  const knownDenyExplanationGap = Array.isArray(partialErrors) && partialErrors.length === 1
    && exactKeys(partialErrors[0], ['code', 'details', 'message'])
    && partialErrors[0].code === 13
    && partialErrors[0].message === 'Failed to generate IAM deny explanation'
    && Array.isArray(partialErrors[0].details) && partialErrors[0].details.length === 1
    && exactKeys(partialErrors[0].details[0], ['@type', 'domain', 'reason'])
    && partialErrors[0].details[0]['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo'
    && partialErrors[0].details[0].domain === 'policytroubleshooter.googleapis.com'
    && partialErrors[0].details[0].reason === 'ERROR_IAM_DENY';
  if (!['access\0explainedPolicies', 'access\0errors\0explainedPolicies'].includes(topLevelKeys)
    || !Array.isArray(partialErrors)
    || (partialErrors.length !== 0 && !knownDenyExplanationGap)
    || value.access !== 'GRANTED'
    || !Array.isArray(value.explainedPolicies)
    || containsForbiddenTroubleshooterState(value)) fail();
  let witness = false;
  for (const policy of value.explainedPolicies) {
    const policyKeys = new Set([
      'access', 'bindingExplanations', 'fullResourceName', 'policy', 'relevance',
    ]);
    if (!safeObject(policy) || Object.keys(policy).some((key) => !policyKeys.has(key))
      || !['GRANTED', 'NOT_GRANTED'].includes(policy.access)
      || typeof policy.fullResourceName !== 'string'
      || !['HIGH', 'HEURISTIC_RELEVANCE', 'NORMAL'].includes(policy.relevance)
      || !Array.isArray(policy.bindingExplanations)) fail();
    if (policy.policy !== undefined) validatePolicy(policy.policy);
    for (const explanation of policy.bindingExplanations) {
      const hasCondition = Object.hasOwn(explanation ?? {}, 'condition')
        || Object.hasOwn(explanation ?? {}, 'conditionExplanation');
      const allowedKeys = new Set([
        'access', 'memberships', 'relevance', 'role', 'rolePermission', 'rolePermissionRelevance',
        ...(hasCondition ? ['condition', 'conditionExplanation'] : []),
      ]);
      if (!safeObject(explanation) || Object.keys(explanation).some((key) => !allowedKeys.has(key))
        || !['GRANTED', 'NOT_GRANTED'].includes(explanation.access)
        || !SAFE_ROLE.test(String(explanation.role ?? ''))
        || !['ROLE_PERMISSION_INCLUDED', 'ROLE_PERMISSION_NOT_INCLUDED'].includes(explanation.rolePermission)
        || !['HIGH', 'HEURISTIC_RELEVANCE', 'NORMAL'].includes(explanation.relevance)
        || (explanation.rolePermissionRelevance !== undefined
          && !['HIGH', 'HEURISTIC_RELEVANCE', 'NORMAL'].includes(explanation.rolePermissionRelevance))
        || !safeObject(explanation.memberships)) fail();
      if (hasCondition) {
        const condition = explanation.condition;
        if (explanation.access !== 'NOT_GRANTED'
          || explanation.rolePermission !== 'ROLE_PERMISSION_NOT_INCLUDED'
          || !safeObject(condition)
          || !exactKeys(condition, ['description', 'expression', 'title'])
          || ![condition.description, condition.expression, condition.title].every((member) => (
            typeof member === 'string' && member.length >= 1 && member.length <= 4096
              && !/[\u0000\r\n]/u.test(member)
          ))
          || !safeObject(explanation.conditionExplanation)
          || Object.keys(explanation.conditionExplanation).length !== 0) fail();
      }
      for (const [member, membership] of Object.entries(explanation.memberships)) {
        if (typeof member !== 'string' || member.length < 1 || member.length > 512
          || !exactKeys(membership, ['membership', 'relevance'])
          || !['MEMBERSHIP_INCLUDED', 'MEMBERSHIP_NOT_INCLUDED'].includes(membership.membership)
          || !['HIGH', 'HEURISTIC_RELEVANCE', 'NORMAL'].includes(membership.relevance)) fail();
      }
      const acceptance = explanation.memberships[`serviceAccount:${binding.acceptanceServiceAccount}`];
      if (policy.fullResourceName === candidateResource(binding) && policy.access === 'GRANTED'
        && policy.relevance === 'HIGH' && explanation.access === 'GRANTED'
        && explanation.relevance === 'HIGH' && explanation.role === INVOKER_ROLE
        && explanation.rolePermission === 'ROLE_PERMISSION_INCLUDED'
        && acceptance?.membership === 'MEMBERSHIP_INCLUDED'
        && acceptance?.relevance === 'HIGH') witness = true;
    }
  }
  if (!witness) fail();
  return deepFreeze({
    decision: 'GRANTED',
    responseSha256: canonicalSha256(value),
  });
}

function decodeTokenClaims(token, binding, now) {
  if (typeof token !== 'string' || token.length < 64 || token.length > 16_384
    || /\s/u.test(token) || token.split('.').length !== 3) fail();
  const [encodedHeader, encodedClaims, signature] = token.split('.');
  if (![encodedHeader, encodedClaims, signature].every((member) => (
    /^[A-Za-z0-9_-]+$/u.test(member)
      && Buffer.from(member, 'base64url').toString('base64url') === member
      && Buffer.from(member, 'base64url').length > 0
  ))) fail();
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch { fail(); }
  const seconds = Math.floor(now.getTime() / 1_000);
  const claimKeys = claims?.azp === undefined
    ? ['aud', 'email', 'email_verified', 'exp', 'iat', 'iss', 'sub']
    : ['aud', 'azp', 'email', 'email_verified', 'exp', 'iat', 'iss', 'sub'];
  if (!exactKeys(header, ['alg', 'kid', 'typ']) || header.alg !== 'RS256' || header.typ !== 'JWT'
    || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(header.kid)
    || !exactKeys(claims, claimKeys)
    || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)
    || claims.aud !== binding.candidateAudience || claims.email !== binding.acceptanceServiceAccount
    || claims.email_verified !== true || typeof claims.sub !== 'string'
    || claims.sub.length < 1 || claims.sub.length > 256
    || (claims.azp !== undefined && (typeof claims.azp !== 'string'
      || claims.azp.length < 1 || claims.azp.length > 512 || /\s/u.test(claims.azp)))
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || claims.iat > seconds + 30 || claims.iat < seconds - 600
    || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 3_700) fail();
  return deepFreeze({ subjectSha256: canonicalSha256(claims.sub) });
}

export function createIdentityTokenExecutor({ request: authenticatedRequest } = {}) {
  if (typeof authenticatedRequest !== 'function'
    || typeof authenticatedRequest.getPrincipal !== 'function') fail();
  return async (tokenRequest) => {
    try {
      const expectedEndpoint = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(GCP_IDENTITY.serviceAccounts.acceptance)}:generateIdToken`;
      const expectedAudience = `https://${GCP_IDENTITY.candidateService}-${GCP_IDENTITY.projectNumber}.${GCP_IDENTITY.region}.run.app`;
      if (!exactKeys(tokenRequest, ['generateIdToken'])
        || !exactKeys(tokenRequest.generateIdToken, ['body', 'endpoint'])
        || tokenRequest.generateIdToken.endpoint !== expectedEndpoint
        || !exact(tokenRequest.generateIdToken.body, {
          audience: expectedAudience, includeEmail: true,
        })) fail();
      if (await authenticatedRequest.getPrincipal() !== OPERATOR) fail();
      const body = await authenticatedRequest({
        method: 'POST',
        url: tokenRequest.generateIdToken.endpoint,
        body: tokenRequest.generateIdToken.body,
      });
      if (!exactKeys(body, ['token'])) fail();
      const token = body.token;
      if (typeof token !== 'string' || token.length < 64 || token.length > 16_384
        || /\s/u.test(token) || token.split('.').length !== 3) fail();
      return token;
    } catch { fail(); }
  };
}

function probeIdentity(nonce, kind) {
  const value = nonce();
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000\r\n]/u.test(value)) fail();
  const digest = createHash('sha256').update(`${kind}\0${value}`).digest('hex');
  return {
    traceId: digest.slice(0, 32),
    userAgent: `hkbuddy-v1-privacy/${digest.slice(32, 56)}`,
  };
}

function commonFetchOptions(probe) {
  return {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      'User-Agent': probe.userAgent,
      'X-Cloud-Trace-Context': `${probe.traceId}/0;o=1`,
    },
  };
}

async function anonymousProbe(fetch, url, probe) {
  const response = await fetch(url, commonFetchOptions(probe));
  if (![401, 403].includes(response?.status)
    || response.headers?.get?.('location') !== null
    || response.headers?.get?.('set-cookie') !== null) fail();
  return response.status;
}

function normalizedHealthBody(body, path) {
  if (!exactKeys(body, ['data', 'error', 'requestId'])
    || body.error !== null || !UUID.test(String(body.requestId ?? ''))) fail();
  if (path === '/api/health/live') {
    if (!exact(body.data, { status: 'ok', version: '0.1.0' })) fail();
    return deepFreeze({ status: 'ok', version: '0.1.0' });
  }
  if (path !== '/api/health/ready' || !exactKeys(body.data, [
    'boundary', 'checks', 'productionReady', 'status',
  ]) || body.data.status !== 'ready' || body.data.productionReady !== true
    || body.data.boundary !== 'production-v1' || !Array.isArray(body.data.checks)
    || body.data.checks.length !== READINESS_COMPONENTS.length) fail();
  const checks = body.data.checks.map((check, index) => {
    const keys = check?.version === undefined ? ['name', 'status'] : ['name', 'status', 'version'];
    if (!exactKeys(check, keys) || check.name !== READINESS_COMPONENTS[index]
      || check.status !== 'ready' || (check.version !== undefined
        && (!SAFE_READINESS_TOKEN.test(check.version) || DIGEST.test(check.version)))) fail();
    return deepFreeze({ name: check.name, status: 'ready', ...(check.version === undefined
      ? {} : { version: check.version }) });
  });
  return deepFreeze({
    status: 'ready', productionReady: true, boundary: 'production-v1', checks,
  });
}

async function authenticatedProbe(fetch, url, probe, token, path) {
  const options = commonFetchOptions(probe);
  options.headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, options);
  if (response?.status !== 200
    || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(String(response.headers?.get?.('content-type') ?? ''))) fail();
  let body;
  try { body = await response.json(); } catch { fail(); }
  const data = normalizedHealthBody(body, path);
  return deepFreeze({
    status: response.status,
    responseSha256: canonicalSha256(body),
    ...(path === '/api/health/ready' ? { readiness: data } : {}),
  });
}

function logWindow(observedAt) {
  return {
    start: new Date(observedAt.getTime() - 30_000).toISOString(),
    end: new Date(observedAt.getTime() + MAXIMUM_AGE_MS).toISOString(),
  };
}

function logFilter(binding, probe, status, observedAt, path) {
  const url = `${binding.candidateOrigin}${path}`;
  const window = logWindow(observedAt);
  return [
    `logName="projects/${binding.projectId}/logs/run.googleapis.com%2Frequests"`,
    'resource.type="cloud_run_revision"',
    `resource.labels.project_id="${binding.projectId}"`,
    `resource.labels.location="${binding.region}"`,
    `resource.labels.service_name="${binding.candidateService}"`,
    `resource.labels.revision_name="${binding.candidateRevision}"`,
    `trace="projects/${binding.projectId}/traces/${probe.traceId}"`,
    'httpRequest.requestMethod="GET"',
    `httpRequest.requestUrl="${url}"`,
    `httpRequest.status=${status}`,
    `httpRequest.userAgent="${probe.userAgent}"`,
    `timestamp>="${window.start}"`,
    `timestamp<="${window.end}"`,
  ].join(' AND ');
}

function logArgv(binding, probe, status, observedAt, path) {
  return frozenArgv(
    'logging', 'read', logFilter(binding, probe, status, observedAt, path),
    `--project=${binding.projectId}`, '--limit=2', '--order=asc', '--format=json',
  );
}

function validByteCount(value) {
  return (Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value));
}

function validateRequestLog(value, binding, probe, status, now, path) {
  if (!Array.isArray(value) || value.length !== 1) fail();
  const entry = value[0];
  const allowedEntryKeys = new Set([
    'httpRequest', 'insertId', 'labels', 'logName', 'receiveTimestamp', 'resource',
    'severity', 'spanId', 'textPayload', 'timestamp', 'trace', 'traceSampled',
  ]);
  const expectedLabels = {
    configuration_name: binding.candidateService,
    project_id: binding.projectId,
    location: binding.region,
    service_name: binding.candidateService,
    revision_name: binding.candidateRevision,
  };
  const allowedHttpKeys = new Set([
    'cacheFillBytes', 'cacheHit', 'cacheLookup', 'cacheValidatedWithOriginServer',
    'latency', 'protocol', 'referer', 'remoteIp', 'requestMethod', 'requestSize',
    'requestUrl', 'responseSize', 'serverIp', 'status', 'userAgent',
  ]);
  const http = entry?.httpRequest;
  const observed = Date.parse(entry?.timestamp);
  const received = entry?.receiveTimestamp === undefined ? null : Date.parse(entry.receiveTimestamp);
  const window = logWindow(now);
  if (!safeObject(entry) || Object.keys(entry).some((key) => !allowedEntryKeys.has(key))
    || typeof entry.insertId !== 'string' || entry.insertId.length < 1
    || entry.insertId.length > 512 || /[\u0000\r\n]/u.test(entry.insertId)
    || entry.logName !== `projects/${binding.projectId}/logs/run.googleapis.com%2Frequests`
    || entry.trace !== `projects/${binding.projectId}/traces/${probe.traceId}`
    || !exact(entry.resource, { type: 'cloud_run_revision', labels: expectedLabels })
    || !safeObject(http) || Object.keys(http).some((key) => !allowedHttpKeys.has(key))
    || http.requestMethod !== 'GET'
    || http.requestUrl !== `${binding.candidateOrigin}${path}`
    || http.status !== status || http.userAgent !== probe.userAgent
    || (entry.textPayload !== undefined && (
      ![401, 403].includes(status) || typeof entry.textPayload !== 'string'
        || entry.textPayload.length < 1 || entry.textPayload.length > 4096
        || /[\u0000\r\n]/u.test(entry.textPayload)
    ))
    || !Number.isFinite(observed) || observed < Date.parse(window.start) || observed > Date.parse(window.end)
    || (received !== null && (!Number.isFinite(received) || received < observed
      || received > Date.parse(window.end)))
    || (entry.severity !== undefined && ![
      'ALERT', 'CRITICAL', 'DEBUG', 'DEFAULT', 'EMERGENCY', 'ERROR', 'INFO', 'NOTICE', 'WARNING',
    ].includes(entry.severity))
    || (entry.spanId !== undefined && !/^[0-9a-f]{16}$/u.test(entry.spanId))
    || (entry.traceSampled !== undefined && typeof entry.traceSampled !== 'boolean')
    || (http.latency !== undefined && !/^\d+(?:\.\d{1,9})?s$/u.test(String(http.latency)))
    || (http.protocol !== undefined && !/^[A-Za-z0-9./_-]{1,32}$/u.test(String(http.protocol)))
    || ['remoteIp', 'serverIp', 'referer'].some((key) => (
      http[key] !== undefined && (typeof http[key] !== 'string' || http[key].length > 2048
        || /[\u0000\r\n]/u.test(http[key]))
    ))
    || ['requestSize', 'responseSize', 'cacheFillBytes'].some((key) => (
      http[key] !== undefined && !validByteCount(http[key])
    ))
    || ['cacheLookup', 'cacheHit', 'cacheValidatedWithOriginServer'].some((key) => (
      http[key] !== undefined && typeof http[key] !== 'boolean'
    ))) fail();
  return deepFreeze({
    logSha256: canonicalSha256(entry),
    traceSha256: canonicalSha256(probe.traceId),
    userAgentSha256: canonicalSha256(probe.userAgent),
  });
}

async function readRequestLog({ executor, binding, probe, status, observedAt, sleep, path, clock }) {
  const deadline = observedAt.getTime() + MAXIMUM_AGE_MS;
  for (let attempt = 0; attempt < LOG_POLL_ATTEMPTS; attempt += 1) {
    const current = clock();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())
      || current.getTime() > deadline) fail();
    const value = await execute(executor, logArgv(binding, probe, status, observedAt, path));
    if (!Array.isArray(value)) fail();
    if (value.length > 0) {
      return validateRequestLog(value, binding, probe, status, observedAt, path);
    }
    if (attempt + 1 < LOG_POLL_ATTEMPTS) {
      const remaining = deadline - current.getTime();
      if (remaining <= 0) fail();
      await sleep(Math.min(LOG_POLL_INTERVAL_MS, remaining));
    }
  }
  fail();
}

function normalizedInteger(value, { minimum = 0 } = {}) {
  const normalized = typeof value === 'string' && /^\d+$/u.test(value)
    ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < minimum) fail();
  return normalized;
}

function normalizedDurationSeconds(value) {
  if (typeof value === 'string' && /^\d+s$/u.test(value)) return normalizedInteger(value.slice(0, -1));
  return normalizedInteger(value);
}

function normalizeRawProbe(value) {
  const allowedKeys = new Set([
    'failureThreshold', 'httpGet', 'initialDelaySeconds', 'periodSeconds', 'successThreshold',
    'tcpSocket', 'timeoutSeconds',
  ]);
  if (!safeObject(value) || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.tcpSocket !== undefined || !exactKeys(value.httpGet, ['path', 'port'])) fail();
  return {
    path: value.httpGet.path,
    port: normalizedInteger(value.httpGet.port, { minimum: 1 }),
    initialDelaySeconds: normalizedInteger(value.initialDelaySeconds ?? 0),
    timeoutSeconds: normalizedInteger(value.timeoutSeconds, { minimum: 1 }),
    periodSeconds: normalizedInteger(value.periodSeconds, { minimum: 1 }),
    failureThreshold: normalizedInteger(value.failureThreshold, { minimum: 1 }),
  };
}

function normalizeRuntime(metadata, spec, expected, { allowOwnerReferences = false } = {}) {
  const metadataKeys = new Set([
    'annotations', 'creationTimestamp', 'generation', 'labels', 'name', 'namespace',
    ...(allowOwnerReferences ? ['ownerReferences'] : []),
    'resourceVersion', 'selfLink', 'uid',
  ]);
  const specKeys = new Set([
    'containerConcurrency', 'containers', 'serviceAccountName', 'timeoutSeconds', 'volumes',
  ]);
  if (!safeObject(metadata) || Object.keys(metadata).some((key) => !metadataKeys.has(key))
    || !safeObject(spec) || Object.keys(spec).some((key) => !specKeys.has(key))
    || !Array.isArray(spec.containers) || spec.containers.length !== 1) fail();
  const annotations = metadata.annotations ?? {};
  const annotationKeys = new Set([
    'autoscaling.knative.dev/maxScale', 'autoscaling.knative.dev/minScale',
    'run.googleapis.com/client-name', 'run.googleapis.com/client-version',
    'run.googleapis.com/cpu-throttling', 'run.googleapis.com/execution-environment',
    'run.googleapis.com/network-interfaces', 'run.googleapis.com/operation-id',
    'run.googleapis.com/startup-cpu-boost', 'run.googleapis.com/vpc-access-egress',
    'serving.knative.dev/creator',
  ]);
  if (!safeObject(annotations) || Object.keys(annotations).some((key) => !annotationKeys.has(key))) fail();
  let networkInterfaces;
  try { networkInterfaces = JSON.parse(annotations['run.googleapis.com/network-interfaces']); } catch { fail(); }
  if (!Array.isArray(networkInterfaces) || networkInterfaces.length !== 1
    || !exactKeys(networkInterfaces[0], ['network', 'subnetwork'])) fail();
  const container = spec.containers[0];
  const containerKeys = new Set([
    'args', 'command', 'env', 'image', 'livenessProbe', 'name', 'ports', 'readinessProbe',
    'resources', 'startupProbe', 'volumeMounts', 'workingDir',
  ]);
  if (!safeObject(container) || Object.keys(container).some((key) => !containerKeys.has(key))
    || (container.command !== undefined && (!Array.isArray(container.command) || container.command.length !== 0))
    || (container.args !== undefined && (!Array.isArray(container.args) || container.args.length !== 0))) fail();
  const ports = container.ports ?? [];
  if ((container.name !== undefined && (typeof container.name !== 'string'
      || !/^[a-z][a-z0-9-]{0,62}$/u.test(container.name)))
    || (container.workingDir !== undefined && (typeof container.workingDir !== 'string'
      || !container.workingDir.startsWith('/') || container.workingDir.length > 4096
      || /[\u0000\r\n]/u.test(container.workingDir)))
    || !Array.isArray(ports) || ports.length > 1
    || ports.some((port) => !exactKeys(port, ['containerPort', 'name'])
      || port.name !== 'http1' || normalizedInteger(port.containerPort, { minimum: 1 }) !== 8080)) fail();
  const environment = {};
  const secretEnvironment = {};
  for (const member of container.env ?? []) {
    if (!safeObject(member) || typeof member.name !== 'string'
      || Object.hasOwn(environment, member.name) || Object.hasOwn(secretEnvironment, member.name)) fail();
    if (exactKeys(member, ['name', 'value']) && typeof member.value === 'string') {
      environment[member.name] = member.value;
    } else if (exactKeys(member, ['name', 'valueFrom'])
      && exactKeys(member.valueFrom, ['secretKeyRef'])
      && exactKeys(member.valueFrom.secretKeyRef, ['key', 'name'])) {
      secretEnvironment[member.name] = {
        secret: member.valueFrom.secretKeyRef.name,
        version: String(member.valueFrom.secretKeyRef.key),
      };
    } else fail();
  }
  const secretMounts = {};
  const seenMountNames = new Set();
  const volumes = spec.volumes ?? [];
  const mounts = container.volumeMounts ?? [];
  if (!Array.isArray(volumes) || !Array.isArray(mounts)) fail();
  for (const mount of mounts) {
    const mountKeys = mount?.readOnly === undefined
      ? ['mountPath', 'name'] : ['mountPath', 'name', 'readOnly'];
    if (!exactKeys(mount, mountKeys) || typeof mount.name !== 'string'
      || typeof mount.mountPath !== 'string' || mount.readOnly === false
      || seenMountNames.has(mount.name)) fail();
    seenMountNames.add(mount.name);
    const volume = volumes.find(({ name } = {}) => name === mount.name);
    if (!exactKeys(volume, ['name', 'secret'])
      || !exactKeys(volume.secret, ['items', 'secretName'])
      || !Array.isArray(volume.secret.items) || volume.secret.items.length !== 1
      || !exactKeys(volume.secret.items[0], ['key', 'path'])) fail();
    const normalizedMount = {
      path: `${mount.mountPath.replace(/\/$/u, '')}/${volume.secret.items[0].path}`,
      secret: volume.secret.secretName,
      version: String(volume.secret.items[0].key),
      readOnly: true,
    };
    const matches = Object.entries(expected.secretMounts).filter(([, member]) => (
      exact(member, normalizedMount)
    ));
    if (matches.length !== 1 || Object.hasOwn(secretMounts, matches[0][0])) fail();
    secretMounts[matches[0][0]] = normalizedMount;
  }
  if (volumes.length !== mounts.length) fail();
  const limits = container.resources?.limits;
  if (!exactKeys(container.resources, ['limits']) || !exactKeys(limits, ['cpu', 'memory'])) fail();
  const runtime = {
    image: container.image,
    serviceAccount: spec.serviceAccountName,
    executionEnvironment: annotations['run.googleapis.com/execution-environment'],
    cpu: normalizedInteger(limits.cpu, { minimum: 1 }),
    memory: limits.memory,
    concurrency: normalizedInteger(spec.containerConcurrency, { minimum: 1 }),
    minInstances: normalizedInteger(annotations['autoscaling.knative.dev/minScale']),
    maxInstances: normalizedInteger(annotations['autoscaling.knative.dev/maxScale']),
    cpuThrottling: annotations['run.googleapis.com/cpu-throttling'] === 'true',
    startupCpuBoost: annotations['run.googleapis.com/startup-cpu-boost'] === 'true',
    timeoutSeconds: normalizedDurationSeconds(spec.timeoutSeconds),
    network: networkInterfaces[0].network,
    subnet: networkInterfaces[0].subnetwork,
    vpcEgress: annotations['run.googleapis.com/vpc-access-egress'],
    environment: canonical(environment),
    secretEnvironment: canonical(secretEnvironment),
    secretMounts: canonical(secretMounts),
    probes: {
      startup: normalizeRawProbe(container.startupProbe),
      liveness: normalizeRawProbe(container.livenessProbe),
      readiness: normalizeRawProbe(container.readinessProbe),
    },
  };
  const expectedRuntime = Object.fromEntries([
    'image', 'serviceAccount', 'executionEnvironment', 'cpu', 'memory', 'concurrency',
    'minInstances', 'maxInstances', 'cpuThrottling', 'startupCpuBoost', 'timeoutSeconds',
    'network', 'subnet', 'vpcEgress', 'environment', 'secretEnvironment', 'secretMounts', 'probes',
  ].map((key) => [key, expected[key]]));
  if (!exact(runtime, expectedRuntime)) fail();
  return deepFreeze({
    ...runtime,
    container: {
      ...(container.name === undefined ? {} : { name: container.name }),
      ...(container.workingDir === undefined ? {} : { workingDir: container.workingDir }),
      ...(container.ports === undefined ? {} : {
        ports: ports.map((port) => ({
          name: port.name,
          containerPort: normalizedInteger(port.containerPort, { minimum: 1 }),
        })),
      }),
    },
  });
}

function validateReadyConditions(value) {
  if (!Array.isArray(value) || value.length < 1) fail();
  const allowedKeys = new Set([
    'lastTransitionTime', 'message', 'reason', 'severity', 'status', 'type',
  ]);
  let ready = false;
  for (const condition of value) {
    if (!safeObject(condition) || Object.keys(condition).some((key) => !allowedKeys.has(key))
      || typeof condition.type !== 'string' || condition.status !== 'True') fail();
    if (condition.type === 'Ready') ready = true;
  }
  if (!ready) fail();
}

function validateServiceReadback(value, binding) {
  const topKeys = new Set(['apiVersion', 'kind', 'metadata', 'spec', 'status']);
  const metadataKeys = new Set([
    'annotations', 'creationTimestamp', 'generation', 'labels', 'name', 'namespace',
    'resourceVersion', 'selfLink', 'uid',
  ]);
  if (!safeObject(value) || Object.keys(value).some((key) => !topKeys.has(key))
    || value.apiVersion !== 'serving.knative.dev/v1' || value.kind !== 'Service'
    || !safeObject(value.metadata)
    || Object.keys(value.metadata).some((key) => !metadataKeys.has(key))
    || value.metadata.name !== binding.candidateService
    || String(value.metadata.namespace) !== binding.projectNumber) fail();
  const generation = normalizedInteger(value.metadata.generation, { minimum: 1 });
  const labels = value.metadata.labels ?? {};
  const annotations = value.metadata.annotations ?? {};
  const allowedServiceAnnotations = new Set([
    'run.googleapis.com/client-name', 'run.googleapis.com/client-version',
    'run.googleapis.com/ingress', 'run.googleapis.com/ingress-status',
    'run.googleapis.com/invoker-iam-disabled', 'run.googleapis.com/operation-id',
    'run.googleapis.com/maxScale', 'run.googleapis.com/urls',
    'serving.knative.dev/creator', 'serving.knative.dev/lastModifier',
  ]);
  if (!safeObject(labels) || labels['cloud.googleapis.com/location'] !== binding.region
    || !safeObject(annotations)
    || Object.keys(annotations).some((key) => !allowedServiceAnnotations.has(key))
    || annotations['run.googleapis.com/ingress'] !== 'all'
    || (annotations['run.googleapis.com/ingress-status'] !== undefined
      && annotations['run.googleapis.com/ingress-status'] !== 'all')) fail();
  const invoker = annotations['run.googleapis.com/invoker-iam-disabled'];
  if (invoker !== undefined && (typeof invoker !== 'string'
    || invoker !== invoker.trim() || invoker.toLowerCase() !== 'false')) fail();
  const serviceMaxScale = annotations['run.googleapis.com/maxScale'] === undefined
    ? null : normalizedInteger(annotations['run.googleapis.com/maxScale'], { minimum: 1 });
  if (serviceMaxScale !== binding.expectedCandidate.maxInstances) fail();
  if (!exactKeys(value.spec, ['template', 'traffic']) || !safeObject(value.spec.template)
    || !exactKeys(value.spec.template, ['metadata', 'spec'])
    || value.spec.template.metadata?.name !== binding.candidateRevision) fail();
  const runtime = normalizeRuntime(
    value.spec.template.metadata, value.spec.template.spec, binding.expectedCandidate,
  );
  if (!Array.isArray(value.spec.traffic) || value.spec.traffic.length !== 1
    || !exact(value.spec.traffic[0], {
      revisionName: binding.candidateRevision, percent: 100, tag: binding.candidateTag,
    })) fail();
  const statusKeys = new Set([
    'address', 'conditions', 'latestCreatedRevisionName', 'latestReadyRevisionName',
    'observedGeneration', 'traffic', 'url',
  ]);
  if (!safeObject(value.status) || Object.keys(value.status).some((key) => !statusKeys.has(key))) fail();
  let serviceUrls;
  try {
    serviceUrls = normalizeCloudRunV1ServiceUrls(value, {
      service: binding.candidateService,
      projectNumber: binding.projectNumber,
      region: binding.region,
    });
  } catch { fail(); }
  validateReadyConditions(value.status.conditions);
  const observedGeneration = normalizedInteger(value.status.observedGeneration, { minimum: 1 });
  if (observedGeneration !== generation
    || value.status.latestCreatedRevisionName !== binding.candidateRevision
    || value.status.latestReadyRevisionName !== binding.candidateRevision
    || !Array.isArray(value.status.traffic) || value.status.traffic.length !== 1
    || !exactKeys(value.status.traffic[0], ['percent', 'revisionName', 'tag', 'url'])
    || value.status.traffic[0].revisionName !== binding.candidateRevision
    || value.status.traffic[0].percent !== 100
    || value.status.traffic[0].tag !== binding.candidateTag
    || !serviceUrls.aliases.map((url) => cloudRunTaggedUrl(binding.candidateTag, url))
      .includes(value.status.traffic[0].url)) fail();
  return deepFreeze({
    project: binding.projectId,
    region: binding.region,
    service: binding.candidateService,
    generation,
    address: serviceUrls.primary,
    urls: serviceUrls.aliases,
    invokerIamDisabled: false,
    ingress: 'all',
    serviceMaxScale,
    revision: binding.candidateRevision,
    tag: binding.candidateTag,
    taggedUrl: value.status.traffic[0].url,
    traffic: binding.expectedCandidate.traffic,
    ready: true,
    runtime,
  });
}

function validateRevisionReadback(value, binding) {
  const topKeys = new Set(['apiVersion', 'kind', 'metadata', 'spec', 'status']);
  const metadataKeys = new Set([
    'annotations', 'creationTimestamp', 'generation', 'labels', 'name', 'namespace',
    'ownerReferences', 'resourceVersion', 'selfLink', 'uid',
  ]);
  if (!safeObject(value) || Object.keys(value).some((key) => !topKeys.has(key))
    || value.apiVersion !== 'serving.knative.dev/v1' || value.kind !== 'Revision'
    || !safeObject(value.metadata)
    || Object.keys(value.metadata).some((key) => !metadataKeys.has(key))
    || value.metadata.name !== binding.candidateRevision
    || String(value.metadata.namespace) !== binding.projectNumber) fail();
  const generation = normalizedInteger(value.metadata.generation, { minimum: 1 });
  const ownerReferences = value.metadata.ownerReferences;
  let ownerReference = null;
  if (ownerReferences !== undefined) {
    if (!Array.isArray(ownerReferences) || ownerReferences.length !== 1
      || !exactKeys(ownerReferences[0], [
        'apiVersion', 'blockOwnerDeletion', 'controller', 'kind', 'name', 'uid',
      ])
      || ownerReferences[0].apiVersion !== 'serving.knative.dev/v1'
      || ownerReferences[0].kind !== 'Configuration'
      || ownerReferences[0].name !== binding.candidateService
      || ownerReferences[0].blockOwnerDeletion !== true
      || ownerReferences[0].controller !== true
      || !UUID.test(String(ownerReferences[0].uid ?? ''))) fail();
    ownerReference = canonical(ownerReferences[0]);
  }
  const labels = value.metadata.labels;
  if (!safeObject(labels) || labels['cloud.googleapis.com/location'] !== binding.region
    || labels['serving.knative.dev/configuration'] !== binding.candidateService
    || labels['serving.knative.dev/service'] !== binding.candidateService) fail();
  const runtime = normalizeRuntime(
    value.metadata, value.spec, binding.expectedCandidate, { allowOwnerReferences: true },
  );
  const statusKeys = new Set([
    'conditions', 'desiredReplicas', 'imageDigest', 'logUrl', 'observedGeneration', 'serviceName',
  ]);
  if (!safeObject(value.status) || Object.keys(value.status).some((key) => !statusKeys.has(key))) fail();
  validateReadyConditions(value.status.conditions);
  const observedGeneration = normalizedInteger(value.status.observedGeneration, { minimum: 1 });
  const desiredReplicas = normalizedInteger(value.status.desiredReplicas, { minimum: 1 });
  if (observedGeneration !== generation || desiredReplicas !== 1
    || value.status.imageDigest !== binding.image
    || (value.status.serviceName !== undefined
      && value.status.serviceName !== binding.candidateService)
    || (value.status.logUrl !== undefined && (typeof value.status.logUrl !== 'string'
      || !value.status.logUrl.startsWith('https://') || value.status.logUrl.length > 4096
      || /[\u0000\r\n]/u.test(value.status.logUrl)))) fail();
  return deepFreeze({
    project: binding.projectId,
    region: binding.region,
    service: binding.candidateService,
    revision: binding.candidateRevision,
    generation,
    desiredReplicas,
    ownerReference,
    image: binding.image,
    ready: true,
    runtime,
  });
}

function validateArtifactReadback(value, binding) {
  if (!exactKeys(value, ['image_summary'])
    || !exactKeys(value.image_summary, ['digest', 'fully_qualified_digest'])) fail();
  const image = value.image_summary.fully_qualified_digest;
  const digest = value.image_summary.digest;
  if (image !== binding.image || digest !== binding.imageDigest) fail();
  return deepFreeze({ image: binding.image, imageDigest: binding.imageDigest });
}

async function readCandidateControlPlane(binding, plan, executor) {
  const service = validateServiceReadback(await execute(executor, plan.controlPlane.service), binding);
  const revision = validateRevisionReadback(await execute(executor, plan.controlPlane.revision), binding);
  const artifact = validateArtifactReadback(await execute(executor, plan.controlPlane.artifact), binding);
  const iam = validatePolicy(await execute(executor, plan.hierarchy.serviceIam));
  validateCandidateServicePolicy(iam, binding);
  return deepFreeze({ service, revision, artifact, iam });
}

export async function readCandidateControlPlaneSnapshot({ binding: rawBinding, executor } = {}) {
  try {
    const binding = normalizedBinding(rawBinding);
    const state = await readCandidateControlPlane(
      binding, createCandidatePrivacyCommandPlan(binding), executor,
    );
    return deepFreeze({ state, stateSha256: canonicalSha256(state) });
  } catch {
    fail();
  }
}

export async function runCandidateAuthenticatedHealthProbe({
  binding: rawBinding,
  path,
  executor,
  tokenExecutor,
  fetch,
  now = () => new Date(),
  nonce,
  sleep = defaultSleep,
} = {}) {
  try {
    const binding = normalizedBinding(rawBinding);
    if (!['/api/health/live', '/api/health/ready'].includes(path)
      || typeof tokenExecutor !== 'function' || typeof fetch !== 'function'
      || typeof now !== 'function' || typeof nonce !== 'function' || typeof sleep !== 'function') fail();
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) fail();
    const plan = createCandidatePrivacyCommandPlan(binding);
    const token = await tokenExecutor(plan.token);
    if (typeof token !== 'string') fail();
    const tokenObservedAt = now();
    if (!(tokenObservedAt instanceof Date) || !Number.isFinite(tokenObservedAt.getTime())
      || tokenObservedAt.getTime() < observedAt.getTime()
      || tokenObservedAt.getTime() >= observedAt.getTime() + MAXIMUM_AGE_MS) fail();
    decodeTokenClaims(token, binding, tokenObservedAt);
    const probe = probeIdentity(nonce, path === '/api/health/live' ? 'readiness-live' : 'readiness-ready');
    const response = await authenticatedProbe(
      fetch, `${binding.candidateOrigin}${path}`, probe, token, path,
    );
    const log = await readRequestLog({
      executor, binding, probe, status: response.status, observedAt, sleep, path, clock: now,
    });
    return deepFreeze({ ...response, ...log });
  } catch {
    fail();
  }
}

function proofBinding(binding) {
  const value = {
    projectId: binding.projectId,
    projectNumber: binding.projectNumber,
    organizationId: binding.organizationId,
    region: binding.region,
    releaseSha: binding.releaseSha,
    imageDigest: binding.imageDigest,
    image: binding.image,
    candidateContractSha256: canonicalSha256(binding.expectedCandidate),
    candidateService: binding.candidateService,
    candidateRevision: binding.candidateRevision,
    candidateTag: binding.candidateTag,
    candidateOrigin: binding.candidateOrigin,
    candidateAudience: binding.candidateAudience,
    candidateResource: candidateResource(binding),
  };
  return deepFreeze({ ...value, boundarySha256: canonicalSha256(value) });
}

export function candidatePrivacyBoundarySha256(rawBinding) {
  try {
    return proofBinding(normalizedBinding(rawBinding)).boundarySha256;
  } catch {
    fail();
  }
}

export function finalizeCandidatePrivacyProof(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail();
  const { artifactSha256: ignored, ...payload } = record;
  void ignored;
  return deepFreeze({ ...payload, artifactSha256: canonicalSha256(payload) });
}

export function validateCandidatePrivacyProof(record, { binding: rawBinding, now = new Date() } = {}) {
  try {
    const binding = normalizedBinding(rawBinding);
    const observed = Date.parse(record?.occurredAt);
    const expires = Date.parse(record?.expiresAt);
    const current = new Date(now).getTime();
    if (!exactKeys(record, [
      'artifactSha256', 'binding', 'cloudAsset', 'controlPlane', 'edge', 'expiresAt',
      'hierarchy', 'identity', 'occurredAt', 'proofType', 'result', 'schemaVersion', 'troubleshooter',
    ])
      || record.schemaVersion !== SCHEMA_VERSION || record.proofType !== 'candidate-effective-privacy'
      || record.result !== 'pass' || !DIGEST.test(String(record.artifactSha256 ?? ''))
      || !Number.isFinite(observed) || !Number.isFinite(expires)
      || expires - observed !== MAXIMUM_AGE_MS || current < observed - 30_000 || current >= expires
      || !exact(record.binding, proofBinding(binding))) fail();
    if (!exactKeys(record.controlPlane, ['afterSha256', 'beforeSha256', 'stable'])
      || record.controlPlane.stable !== true
      || !DIGEST.test(String(record.controlPlane.beforeSha256 ?? ''))
      || record.controlPlane.beforeSha256 !== record.controlPlane.afterSha256) fail();
    if (!exactKeys(record.identity, [
        'acceptanceServiceAccount', 'invokerMember', 'invokerPermission', 'invokerRole',
        'subjectSha256', 'tokenCreatorPrincipal', 'tokenCreatorPrerequisite',
        'tokenPrerequisitePolicySha256',
      ])
      || record.identity.acceptanceServiceAccount !== binding.acceptanceServiceAccount
      || record.identity.invokerMember !== `serviceAccount:${binding.acceptanceServiceAccount}`
      || record.identity.invokerPermission !== INVOKE_PERMISSION
      || record.identity.invokerRole !== INVOKER_ROLE
      || record.identity.tokenCreatorPrincipal !== `user:${binding.operator}`
      || record.identity.tokenCreatorPrerequisite !== TOKEN_CREATOR_ROLE
      || !DIGEST.test(String(record.identity.subjectSha256 ?? ''))
      || !DIGEST.test(String(record.identity.tokenPrerequisitePolicySha256 ?? ''))) fail();
    if (!exactKeys(record.hierarchy, [
        'chainSha256', 'firstReadSha256', 'policyRoleDefinitionsSecondReadSha256',
        'policyRoleDefinitionsSha256', 'secondReadSha256', 'stable',
      ])
      || record.hierarchy.stable !== true
      || ![
        'chainSha256', 'firstReadSha256', 'policyRoleDefinitionsSecondReadSha256',
        'policyRoleDefinitionsSha256', 'secondReadSha256',
      ]
        .every((key) => DIGEST.test(String(record.hierarchy[key] ?? '')))
      || record.hierarchy.firstReadSha256 !== record.hierarchy.secondReadSha256
      || record.hierarchy.policyRoleDefinitionsSha256
        !== record.hierarchy.policyRoleDefinitionsSecondReadSha256) fail();
    if (!exactKeys(record.cloudAsset, [
      'effectiveIamSha256', 'publicPrincipalDenial', 'quotaProject',
    ])
      || record.cloudAsset.quotaProject !== QUOTA_PROJECT
      || !DIGEST.test(String(record.cloudAsset.effectiveIamSha256 ?? ''))) fail();
    validatePublicPrincipalDenial(record.cloudAsset.publicPrincipalDenial, {
      binding,
      effectiveIamSha256: record.cloudAsset.effectiveIamSha256,
      hierarchyChainSha256: record.hierarchy.chainSha256,
      roleDefinitionsSha256: record.hierarchy.policyRoleDefinitionsSha256,
    });
    if (!exactKeys(record.troubleshooter, ['decision', 'responseSha256'])
      || record.troubleshooter.decision !== 'GRANTED'
      || !DIGEST.test(String(record.troubleshooter.responseSha256 ?? ''))) fail();
    if (!exactKeys(record.edge, ['anonymous', 'authenticated'])
      || ![record.edge.anonymous, record.edge.authenticated].every((edge) => (
        exactKeys(edge, ['logSha256', 'status', 'traceSha256', 'userAgentSha256'])
        && DIGEST.test(String(edge.logSha256 ?? '')) && DIGEST.test(String(edge.traceSha256 ?? ''))
        && DIGEST.test(String(edge.userAgentSha256 ?? ''))
      ))
      || ![401, 403].includes(record.edge.anonymous.status)
      || record.edge.authenticated.status !== 200
      || record.edge.anonymous.traceSha256 === record.edge.authenticated.traceSha256) fail();
    if (containsForbiddenPersistedSecret(record)
      || !exact(finalizeCandidatePrivacyProof(record), record)) fail();
    return true;
  } catch {
    fail();
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runCandidatePrivacyProof({
  binding: rawBinding,
  executor,
  tokenExecutor,
  fetch,
  now = () => new Date(),
  nonce,
  sleep = defaultSleep,
} = {}) {
  try {
    const binding = normalizedBinding(rawBinding);
    if (typeof tokenExecutor !== 'function' || typeof fetch !== 'function'
      || typeof now !== 'function' || typeof nonce !== 'function' || typeof sleep !== 'function') fail();
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) fail();
    const plan = createCandidatePrivacyCommandPlan(binding);

    const firstSnapshot = await readHierarchySnapshot(binding, plan, executor);
    const beforeControlPlane = await readCandidateControlPlane(binding, plan, executor);

    const tokenPrerequisite = validateTokenPrerequisite(
      await execute(executor, plan.tokenPrerequisite), binding,
    );
    const effectivePolicy = validateEffectivePolicy(
      await execute(executor, plan.assetEffectiveIam), binding, firstSnapshot,
    );
    const publicRoleDefinitions = await resolvePublicRoles({
      snapshot: firstSnapshot, effectivePolicy, binding, executor,
    });
    const publicPrincipalDenial = createPublicPrincipalDenial({
      snapshot: firstSnapshot,
      effectivePolicy,
      roleDefinitions: publicRoleDefinitions,
    });
    const troubleshooter = validateTroubleshooter(
      await execute(executor, plan.troubleshooter), binding,
    );

    const endpoint = `${binding.candidateOrigin}/api/health/live`;
    const anonymousIdentity = probeIdentity(nonce, 'anonymous');
    const anonymousStatus = await anonymousProbe(fetch, endpoint, anonymousIdentity);
    const token = await tokenExecutor(plan.token);
    if (typeof token !== 'string') fail();
    const tokenObservedAt = now();
    if (!(tokenObservedAt instanceof Date) || !Number.isFinite(tokenObservedAt.getTime())
      || tokenObservedAt.getTime() < observedAt.getTime()
      || tokenObservedAt.getTime() >= observedAt.getTime() + MAXIMUM_AGE_MS) fail();
    const tokenIdentity = decodeTokenClaims(token, binding, tokenObservedAt);
    const authenticatedIdentity = probeIdentity(nonce, 'authenticated');
    const authenticatedResponse = await authenticatedProbe(
      fetch, endpoint, authenticatedIdentity, token, '/api/health/live',
    );
    const authenticatedStatus = authenticatedResponse.status;
    const anonymousLog = await readRequestLog({
      executor, binding, probe: anonymousIdentity, status: anonymousStatus, observedAt, sleep,
      path: '/api/health/live', clock: now,
    });
    const authenticatedLog = await readRequestLog({
      executor, binding, probe: authenticatedIdentity, status: authenticatedStatus,
      observedAt, sleep, path: '/api/health/live', clock: now,
    });
    const afterControlPlane = await readCandidateControlPlane(binding, plan, executor);
    if (!exact(beforeControlPlane, afterControlPlane)) fail();
    const secondSnapshot = await readHierarchySnapshot(binding, plan, executor);
    if (!exact(firstSnapshot, secondSnapshot)) fail();
    const secondPublicRoleDefinitions = await resolvePublicRoles({
      snapshot: secondSnapshot, effectivePolicy, binding, executor,
    });
    if (!exact(publicRoleDefinitions, secondPublicRoleDefinitions)) fail();
    const completedAt = now();
    if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())
      || completedAt.getTime() >= observedAt.getTime() + MAXIMUM_AGE_MS) fail();

    const occurredAt = completedAt.toISOString();
    const proof = finalizeCandidatePrivacyProof({
      schemaVersion: SCHEMA_VERSION,
      proofType: 'candidate-effective-privacy',
      occurredAt,
      expiresAt: new Date(completedAt.getTime() + MAXIMUM_AGE_MS).toISOString(),
      result: 'pass',
      binding: proofBinding(binding),
      controlPlane: {
        stable: true,
        beforeSha256: canonicalSha256(beforeControlPlane),
        afterSha256: canonicalSha256(afterControlPlane),
      },
      identity: {
        acceptanceServiceAccount: binding.acceptanceServiceAccount,
        invokerMember: `serviceAccount:${binding.acceptanceServiceAccount}`,
        invokerRole: INVOKER_ROLE,
        invokerPermission: INVOKE_PERMISSION,
        tokenCreatorPrincipal: `user:${binding.operator}`,
        tokenCreatorPrerequisite: TOKEN_CREATOR_ROLE,
        tokenPrerequisitePolicySha256: canonicalSha256(tokenPrerequisite),
        subjectSha256: tokenIdentity.subjectSha256,
      },
      hierarchy: {
        stable: true,
        chainSha256: canonicalSha256(firstSnapshot.chain),
        firstReadSha256: canonicalSha256(firstSnapshot),
        secondReadSha256: canonicalSha256(secondSnapshot),
        policyRoleDefinitionsSha256: canonicalSha256(
          publicRoleDefinitionProjection(publicRoleDefinitions),
        ),
        policyRoleDefinitionsSecondReadSha256: canonicalSha256(
          publicRoleDefinitionProjection(secondPublicRoleDefinitions),
        ),
      },
      cloudAsset: {
        quotaProject: QUOTA_PROJECT,
        effectiveIamSha256: canonicalSha256(effectivePolicy),
        publicPrincipalDenial,
      },
      troubleshooter,
      edge: {
        anonymous: { status: anonymousStatus, ...anonymousLog },
        authenticated: { status: authenticatedStatus, ...authenticatedLog },
      },
    });
    validateCandidatePrivacyProof(proof, { binding, now: completedAt });
    return proof;
  } catch {
    fail();
  }
}

export const CANDIDATE_PRIVACY_SCHEMA_VERSION = SCHEMA_VERSION;
export const CANDIDATE_PRIVACY_MAXIMUM_AGE_MS = MAXIMUM_AGE_MS;
