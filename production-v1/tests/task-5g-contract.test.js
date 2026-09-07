import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { createGcloudExecutor } from '../scripts/gcp-provision.js';
import * as provisionContract from '../scripts/gcp-provision.js';
import * as releaseContract from '../scripts/gcp-release.js';
import { CANDIDATE_PRIVACY_SCHEMA_VERSION } from '../scripts/candidate-privacy-proof.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';

const PROJECT = GCP_IDENTITY.projectId;
const REGION = GCP_IDENTITY.region;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const STABLE_REVISION = `${GCP_IDENTITY.service}-${'a'.repeat(12)}`;
const PRIOR_REVISION = `${GCP_IDENTITY.service}-${'b'.repeat(12)}`;
const CANDIDATE_REVISION = `${GCP_IDENTITY.candidateService}-${'c'.repeat(12)}`;
const CANDIDATE_TAG = `candidate-${'c'.repeat(12)}`;
const CANDIDATE_TAG_URL = `https://${CANDIDATE_TAG}---${GCP_IDENTITY.candidateService}-${PROJECT_NUMBER}.${REGION}.run.app`;
const CANDIDATE_CANONICAL_URL = `https://${GCP_IDENTITY.candidateService}-c7dkesvlda-df.a.run.app`;
const CANDIDATE_CANONICAL_TAG_URL = `https://${CANDIDATE_TAG}---${GCP_IDENTITY.candidateService}-c7dkesvlda-df.a.run.app`;
const STABLE_URL = `https://${GCP_IDENTITY.service}-${PROJECT_NUMBER}.${REGION}.run.app`;
const RELEASE_SHA = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const PRIVACY_NOW = '2026-08-27T08:00:00.000Z';
const ACCEPTANCE_SERVICE_ACCOUNT = GCP_IDENTITY.serviceAccounts.acceptance;
const CANDIDATE_RESOURCE = `//run.googleapis.com/projects/${PROJECT}/locations/${REGION}/services/${GCP_IDENTITY.candidateService}`;
const CANDIDATE_IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/${GCP_IDENTITY.repository}/hkbuddy-v1-api@${IMAGE_DIGEST}`;
const RUN_REQUEST_LOG = `projects/${PROJECT}/logs/run.googleapis.com%2Frequests`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function rejectingGcloud(stderr) {
  return createGcloudExecutor({
    executable: 'python.exe',
    prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      throw error;
    },
  });
}

function rejectingGcloudWithCode(stderr, code) {
  return createGcloudExecutor({
    executable: 'python.exe',
    prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      error.code = code;
      throw error;
    },
  });
}

test('SDK 553 canonical Cloud Run service and job absence is exact', async (t) => {
  const serviceArgv = (service) => [
    'run', 'services', 'describe', service,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ];
  const jobArgv = (job) => [
    'run', 'jobs', 'describe', job,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ];

  for (const [name, argv, stderr, expectedCode] of [
    ...[GCP_IDENTITY.service, GCP_IDENTITY.candidateService].map((service) => [
      `service ${service}`,
      serviceArgv(service),
      `ERROR: (gcloud.run.services.describe) Cannot find service [${service}]\r\n`,
      'CLOUD_RUN_SERVICE_NOT_FOUND',
    ]),
    ...Object.values(GCP_IDENTITY.jobs).map((job) => [
      `job ${job}`,
      jobArgv(job),
      `ERROR: (gcloud.run.jobs.describe) Cannot find job [${job}].\n`,
      'NOT_FOUND',
    ]),
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => rejectingGcloud(stderr)(argv),
        (error) => error.code === expectedCode,
      );
    });
  }

  const stableArgv = serviceArgv(GCP_IDENTITY.service);
  const canonical = `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]`;
  for (const [name, argv, stderr] of [
    ['obsolete message', stableArgv, `ERROR: (gcloud.run.services.describe) Service [${GCP_IDENTITY.service}] could not be found.`],
    ['generic NOT_FOUND', stableArgv, `NOT_FOUND: ${GCP_IDENTITY.service}`],
    ['generic 404', stableArgv, `404: ${GCP_IDENTITY.service}`],
    ['extra prefix', stableArgv, `proxy: ${canonical}`],
    ['extra suffix', stableArgv, `${canonical} retry`],
    ['two trailing newlines', stableArgv, `${canonical}\n\n`],
    ['wrong project', stableArgv.with(4, '--project=foreign-project'), `${canonical}\n`],
    ['wrong region', stableArgv.with(5, '--region=us-central1'), `${canonical}\n`],
    ['wrong resource', stableArgv.with(3, GCP_IDENTITY.candidateService), `${canonical}\n`],
    ['wrong format', stableArgv.with(6, '--format=yaml'), `${canonical}\n`],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => rejectingGcloud(stderr)(argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }

  await assert.rejects(
    () => rejectingGcloudWithCode('generic NOT_FOUND from an unrelated transport', 'NOT_FOUND')(
      stableArgv,
    ),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS',
  );
});

test('traffic row representations validate before exact phase comparison', async (t) => {
  const {
    normalizeControlledTraffic,
    normalizeInternalTraffic,
    normalizeCloudRunV1Traffic,
    assertExactTraffic,
  } = releaseContract;
  for (const [name, value] of Object.entries({
    normalizeControlledTraffic,
    normalizeInternalTraffic,
    normalizeCloudRunV1Traffic,
    assertExactTraffic,
  })) assert.equal(typeof value, 'function', `${name} must be exported`);

  const candidate = [{ revision: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 }];
  const staged = [
    { revision: PRIOR_REVISION, tag: null, percent: 100 },
    { revision: STABLE_REVISION, tag: null, percent: 0 },
  ];
  const promoted = [{ revision: STABLE_REVISION, tag: null, percent: 100 }];

  assert.deepEqual(normalizeControlledTraffic([
    { revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 },
  ], { service: GCP_IDENTITY.candidateService }), candidate);
  assert.deepEqual(normalizeInternalTraffic(candidate, {
    service: GCP_IDENTITY.candidateService,
  }), candidate);
  assert.deepEqual(normalizeCloudRunV1Traffic([
    {
      revisionName: CANDIDATE_REVISION,
      tag: CANDIDATE_TAG,
      url: CANDIDATE_TAG_URL,
      percent: 100,
    },
  ], { service: GCP_IDENTITY.candidateService }), candidate);
  assert.deepEqual(normalizeCloudRunV1Traffic([
    {
      revisionName: CANDIDATE_REVISION,
      tag: CANDIDATE_TAG,
      url: CANDIDATE_CANONICAL_TAG_URL,
      percent: 100,
    },
  ], {
    service: GCP_IDENTITY.candidateService,
    serviceUrls: [CANDIDATE_TAG_URL.replace(`${CANDIDATE_TAG}---`, ''), CANDIDATE_CANONICAL_URL],
  }), candidate);
  assert.deepEqual(normalizeCloudRunV1Traffic([
    { revisionName: PRIOR_REVISION, percent: 100 },
    { revisionName: STABLE_REVISION, percent: 0 },
  ], { service: GCP_IDENTITY.service }), staged);
  assert.equal(assertExactTraffic(promoted, {
    kind: 'internal', service: GCP_IDENTITY.service, expected: promoted,
  }), true);
  assert.equal(assertExactTraffic([{
    revisionName: CANDIDATE_REVISION,
    tag: CANDIDATE_TAG,
    url: CANDIDATE_CANONICAL_TAG_URL,
    percent: 100,
  }], {
    kind: 'raw-v1',
    service: GCP_IDENTITY.candidateService,
    serviceUrls: [CANDIDATE_TAG_URL.replace(`${CANDIDATE_TAG}---`, ''), CANDIDATE_CANONICAL_URL],
    expected: candidate,
  }), true);

  const malformedPercent = [
    undefined, '100', Number.NaN, Number.POSITIVE_INFINITY, 99.5, -1, 101,
  ];
  for (const percent of malformedPercent) {
    await t.test(`controlled percent ${String(percent)}`, () => {
      assert.throws(() => normalizeControlledTraffic([
        { revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent },
      ], { service: GCP_IDENTITY.candidateService }));
    });
    await t.test(`internal percent ${String(percent)}`, () => {
      assert.throws(() => normalizeInternalTraffic([
        { revision: STABLE_REVISION, tag: null, percent },
      ], { service: GCP_IDENTITY.service }));
    });
    await t.test(`raw percent ${String(percent)}`, () => {
      assert.throws(() => normalizeCloudRunV1Traffic([
        { revisionName: STABLE_REVISION, percent },
      ], { service: GCP_IDENTITY.service }));
    });
  }

  for (const [name, rows, kind, service] of [
    ['controlled unknown key', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100, url: CANDIDATE_TAG_URL }], 'controlled', GCP_IDENTITY.candidateService],
    ['controlled revision alias', [{ revision: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 }], 'controlled', GCP_IDENTITY.candidateService],
    ['controlled latestRevision', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100, latestRevision: true }], 'controlled', GCP_IDENTITY.candidateService],
    ['controlled configurationName', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100, configurationName: 'foreign' }], 'controlled', GCP_IDENTITY.candidateService],
    ['internal missing explicit tag', [{ revision: STABLE_REVISION, percent: 100 }], 'internal', GCP_IDENTITY.service],
    ['internal revisionName alias', [{ revisionName: STABLE_REVISION, tag: null, percent: 100 }], 'internal', GCP_IDENTITY.service],
    ['raw revision alias', [{ revision: STABLE_REVISION, percent: 100 }], 'raw-v1', GCP_IDENTITY.service],
    ['raw tag without URL', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 }], 'raw-v1', GCP_IDENTITY.candidateService],
    ['raw URL without tag', [{ revisionName: CANDIDATE_REVISION, url: CANDIDATE_TAG_URL, percent: 100 }], 'raw-v1', GCP_IDENTITY.candidateService],
    ['raw malformed tag URL', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, url: `${CANDIDATE_TAG_URL}/extra`, percent: 100 }], 'raw-v1', GCP_IDENTITY.candidateService],
    ['duplicate revision', [{ revision: PRIOR_REVISION, tag: null, percent: 50 }, { revision: PRIOR_REVISION, tag: null, percent: 50 }], 'internal', GCP_IDENTITY.service],
    ['sum not 100', [{ revision: PRIOR_REVISION, tag: null, percent: 99 }], 'internal', GCP_IDENTITY.service],
  ]) {
    await t.test(name, () => {
      const normalizer = {
        controlled: normalizeControlledTraffic,
        internal: normalizeInternalTraffic,
        'raw-v1': normalizeCloudRunV1Traffic,
      }[kind];
      assert.throws(() => normalizer(rows, { service }));
    });
  }

  await t.test('hidden foreign zero-percent row is not discarded', () => {
    assert.throws(() => assertExactTraffic([
      ...promoted,
      { revision: `${GCP_IDENTITY.service}-${'d'.repeat(12)}`, tag: null, percent: 0 },
    ], {
      kind: 'internal', service: GCP_IDENTITY.service, expected: promoted,
    }));
  });
});

test('SDK 553 update-traffic acknowledgement is exact and remains non-authoritative', () => {
  const { validateTrafficTargetAcknowledgement } = releaseContract;
  assert.equal(typeof validateTrafficTargetAcknowledgement, 'function');
  const valid = [{
    displayPercent: '100%',
    displayRevisionId: STABLE_REVISION,
    displayTags: '',
    key: STABLE_REVISION,
    latestRevision: false,
    revisionName: STABLE_REVISION,
    serviceUrl: STABLE_URL,
    specPercent: '100',
    specTags: '-',
    statusPercent: '100',
    statusTags: '-',
    tags: [],
    urls: [],
  }];
  assert.equal(validateTrafficTargetAcknowledgement(valid, {
    revision: STABLE_REVISION,
    serviceUrl: STABLE_URL,
  }), true);
  for (const drift of [
    [],
    [...valid, structuredClone(valid[0])],
    [{ ...valid[0], extra: true }],
    [{ ...valid[0], revisionName: PRIOR_REVISION }],
    [{ ...valid[0], latestRevision: true }],
    [{ ...valid[0], statusPercent: 0 }],
    [{ ...valid[0], serviceUrl: `${STABLE_URL}/extra` }],
  ]) assert.throws(() => validateTrafficTargetAcknowledgement(drift, {
    revision: STABLE_REVISION,
    serviceUrl: STABLE_URL,
  }));
});

test('authoritative traffic receipt rejects coercion and hidden zero-percent revisions', () => {
  const { validateTrafficReceipt } = releaseContract;
  assert.equal(validateTrafficReceipt({
    service: GCP_IDENTITY.service,
    invokerIamDisabled: false,
    serviceMaxScale: 1,
    traffic: [{ revision: STABLE_REVISION, tag: null, percent: 100 }],
  }, { revision: STABLE_REVISION }), true);

  for (const serviceMaxScale of [undefined, '1', 0, 10]) {
    assert.throws(() => validateTrafficReceipt({
      service: GCP_IDENTITY.service,
      invokerIamDisabled: false,
      ...(serviceMaxScale === undefined ? {} : { serviceMaxScale }),
      traffic: [{ revision: STABLE_REVISION, tag: null, percent: 100 }],
    }, { revision: STABLE_REVISION }));
  }

  for (const traffic of [
    [{ revision: STABLE_REVISION, tag: null, percent: '100' }],
    [
      { revision: STABLE_REVISION, tag: null, percent: 100 },
      { revision: PRIOR_REVISION, tag: null, percent: 0 },
    ],
    [{ revision: STABLE_REVISION, percent: 100 }],
    [{ revisionName: STABLE_REVISION, tag: null, percent: 100 }],
  ]) assert.throws(() => validateTrafficReceipt({
    service: GCP_IDENTITY.service,
    invokerIamDisabled: false,
    serviceMaxScale: 1,
    traffic,
  }, { revision: STABLE_REVISION }));
});

test('Compute Address inventory accepts only the complete project-bound matrix', async (t) => {
  const { validateComputeAddressInventory } = provisionContract;
  assert.equal(typeof validateComputeAddressInventory, 'function');
  const host = `https://www.googleapis.com/compute/v1/projects/${PROJECT}`;
  const network = `${host}/global/networks/default`;
  const region = `${host}/regions/${REGION}`;
  const subnet = (name, overrides = {}) => ({
    name,
    selfLink: `${region}/subnetworks/${name}`,
    network,
    region,
    ipCidrRange: '10.2.0.0/24',
    ...overrides,
  });
  const subnets = [
    subnet('default'),
    subnet('external-vm', {
      ipCidrRange: '10.7.0.0/24',
      ipv6AccessType: 'EXTERNAL',
      stackType: 'IPV4_IPV6',
      purpose: 'PRIVATE',
      ipv6GceEndpoint: 'VM_ONLY',
      externalIpv6Prefix: '2001:db8:1::/64',
    }),
    subnet('external-netlb', {
      ipCidrRange: '10.8.0.0/24',
      ipv6AccessType: 'EXTERNAL',
      stackType: 'IPV4_IPV6',
      purpose: 'PRIVATE',
      ipv6GceEndpoint: 'VM_AND_FR',
      externalIpv6Prefix: '2001:db8:2::/64',
    }),
  ];
  const address = (name, fields) => ({
    name,
    address: fields.address,
    selfLink: fields.region === undefined
      ? `${host}/global/addresses/${name}`
      : `${fields.region}/addresses/${name}`,
    addressType: fields.addressType,
    ipVersion: fields.ipVersion,
    networkTier: fields.networkTier,
    status: fields.status,
    kind: 'compute#address',
    ...fields,
  });
  const internal = (name, fields) => address(name, {
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'RESERVED', ...fields,
  });
  const external = (name, fields) => address(name, {
    addressType: 'EXTERNAL', status: 'IN_USE', ...fields,
  });
  const addresses = [
    internal('dns', { purpose: 'DNS_RESOLVER', address: '10.2.0.5', region, subnetwork: subnets[0].selfLink }),
    internal('gce', { purpose: 'GCE_ENDPOINT', address: '10.2.0.6', region, subnetwork: subnets[0].selfLink }),
    internal('shared-vip', { purpose: 'SHARED_LOADBALANCER_VIP', address: '10.2.0.7', region, subnetwork: subnets[0].selfLink, status: 'IN_USE' }),
    internal('ipsec', { purpose: 'IPSEC_INTERCONNECT', address: '10.3.0.0', prefixLength: 24, region, network }),
    internal('psc', { purpose: 'PRIVATE_SERVICE_CONNECT', address: '10.4.0.1', network }),
    internal('serverless', { purpose: 'SERVERLESS', address: '10.5.0.0', prefixLength: 24, region }),
    internal('peering', { purpose: 'VPC_PEERING', address: '10.6.0.0', prefixLength: 16, network }),
    external('external-v4-regional', { address: '203.0.113.1', ipVersion: 'IPV4', networkTier: 'PREMIUM', region }),
    external('external-v4-pdp', {
      address: '203.0.113.2', ipVersion: 'IPV4', networkTier: 'STANDARD', region,
      ipCollection: `${region}/publicDelegatedPrefixes/hkbuddy-pdp`,
    }),
    external('external-v4-global', { address: '203.0.113.3', ipVersion: 'IPV4', networkTier: 'PREMIUM' }),
    external('external-nat', { address: '203.0.113.4', ipVersion: 'IPV4', networkTier: 'STANDARD', region, purpose: 'NAT_AUTO' }),
    external('external-v6-global', { address: '2001:db8:ffff::1', ipVersion: 'IPV6', networkTier: 'PREMIUM' }),
    external('external-v6-vm', {
      address: '2001:db8:1:0:1::', ipVersion: 'IPV6', networkTier: 'PREMIUM',
      region, prefixLength: 96, ipv6EndpointType: 'VM', subnetwork: subnets[1].selfLink,
    }),
    external('external-v6-netlb', {
      address: '2001:db8:2:0:1::', ipVersion: 'IPV6', networkTier: 'STANDARD',
      region, prefixLength: 96, ipv6EndpointType: 'NETLB', subnetwork: subnets[2].selfLink,
    }),
  ];
  assert.equal(validateComputeAddressInventory({
    addresses, networks: [{ name: 'default', selfLink: network }], subnets,
  }), true);

  const reject = (name, mutate) => t.test(name, () => {
    const candidate = structuredClone(addresses);
    mutate(candidate);
    assert.throws(() => validateComputeAddressInventory({
      addresses: candidate, networks: [{ name: 'default', selfLink: network }], subnets,
    }), (error) => error.code === 'CIDR_AUDIT_INVALID');
  });
  await reject('duplicate name', (rows) => { rows[1].name = rows[0].name; });
  await reject('duplicate selfLink', (rows) => { rows[1].selfLink = rows[0].selfLink; });
  await reject('foreign selfLink', (rows) => { rows[0].selfLink = rows[0].selfLink.replace(PROJECT, 'foreign-project'); });
  await reject('missing ipVersion', (rows) => { delete rows[0].ipVersion; });
  await reject('internal STANDARD tier', (rows) => { rows[0].networkTier = 'STANDARD'; });
  await reject('inapplicable null field', (rows) => { rows[0].network = null; });
  await reject('subnet single outside primary CIDR', (rows) => { rows[0].address = '10.9.0.1'; });
  await reject('network range missing network', (rows) => { delete rows[3].network; });
  await reject('selector-free range gains a selector', (rows) => { rows[5].network = network; });
  await reject('global IPv4 STANDARD tier', (rows) => { rows[9].networkTier = 'STANDARD'; });
  await reject('foreign PDP project', (rows) => { rows[8].ipCollection = rows[8].ipCollection.replace(PROJECT, 'foreign-project'); });
  await reject('NAT_AUTO gains ipCollection', (rows) => { rows[10].ipCollection = `${region}/publicDelegatedPrefixes/hkbuddy-pdp`; });
  await reject('global IPv6 gains prefix', (rows) => { rows[11].prefixLength = 96; });
  await reject('regional IPv6 selector-free', (rows) => { delete rows[12].subnetwork; });
  await reject('regional IPv6 wrong prefix', (rows) => { rows[12].prefixLength = 64; });
  await reject('regional IPv6 non-base address', (rows) => { rows[12].address = '2001:db8:1:0:1::1'; });
  await reject('regional IPv6 outside subnet prefix', (rows) => { rows[12].address = '2001:db8:9:0:1::'; });
  await reject('NETLB on VM_ONLY subnet', (rows) => { rows[13].subnetwork = subnets[1].selfLink; });
  await t.test('legacy impossible purpose is not an IPv6 endpoint mode', () => {
    const legacySubnets = structuredClone(subnets);
    legacySubnets[1].purpose = 'VM_ONLY';
    delete legacySubnets[1].ipv6GceEndpoint;
    assert.throws(() => validateComputeAddressInventory({
      addresses, networks: [{ name: 'default', selfLink: network }], subnets: legacySubnets,
    }), (error) => error.code === 'CIDR_AUDIT_INVALID');
  });
});

test('managed PSA Address describe requires the same explicit matrix fields', () => {
  const plane = new provisionContract.GcpControlPlane({
    contract: { resources: { serviceAccounts: [] } },
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  const exact = {
    name: GCP_IDENTITY.psaRange,
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`,
    address: '10.25.0.0',
    prefixLength: 16,
    addressType: 'INTERNAL',
    ipVersion: 'IPV4',
    networkTier: 'PREMIUM',
    status: 'RESERVED',
    purpose: 'VPC_PEERING',
    network: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
  };
  assert.equal(plane.compare('psa-range', exact), true);
  for (const candidate of [
    { ...exact, ipVersion: undefined },
    { ...exact, networkTier: undefined },
    { ...exact, prefixLength: '16' },
    { ...exact, kind: 'compute#forwardingRule' },
  ]) assert.equal(plane.compare('psa-range', candidate), false);
});

test('Service Account list and describe identities bind email, resource name, and project exactly', async (t) => {
  const email = GCP_IDENTITY.serviceAccounts.runtime;
  const displayName = 'Hong Kong Buddy Cloud Run runtime';
  const exactIdentity = {
    email,
    name: `projects/${PROJECT}/serviceAccounts/${email}`,
    projectId: PROJECT,
    displayName,
    disabled: false,
    oauth2ClientId: '123456789012345678901',
    uniqueId: '123456789012345678901',
  };

  assert.equal(provisionContract.validateServiceAccountIdentity(exactIdentity, {
    email, displayName,
  }), true);

  const plane = new provisionContract.GcpControlPlane({
    contract: { resources: { serviceAccounts: [{
      id: 'hkbuddy-v1-runtime', email, displayName,
    }] } },
    gcloud: async () => structuredClone(exactIdentity),
    request: async () => { throw new Error('REST must not run'); },
  });
  assert.deepEqual(await plane.read('service-account:hkbuddy-v1-runtime'), {
    status: 'present', value: exactIdentity,
  });
  assert.equal(plane.compare('service-account:hkbuddy-v1-runtime', exactIdentity), true);

  for (const [name, mutate] of [
    ['missing name', (value) => { delete value.name; }],
    ['foreign parent', (value) => { value.name = value.name.replace(PROJECT, 'foreign-project'); }],
    ['wildcard parent', (value) => { value.name = `projects/-/serviceAccounts/${email}`; }],
    ['uniqueId parent', (value) => { value.name = `projects/${PROJECT}/serviceAccounts/${value.uniqueId}`; }],
    ['case drift', (value) => { value.name = value.name.replace('/serviceAccounts/', '/serviceaccounts/'); }],
    ['path drift', (value) => { value.name = value.name.replace('/serviceAccounts/', '/serviceAccounts//'); }],
    ['email mismatch', (value) => { value.email = GCP_IDENTITY.serviceAccounts.build; }],
    ['missing projectId', (value) => { delete value.projectId; }],
    ['wrong projectId', (value) => { value.projectId = 'foreign-project'; }],
    ['disabled', (value) => { value.disabled = true; }],
    ['malformed disabled', (value) => { value.disabled = 'false'; }],
    ['displayName drift', (value) => { value.displayName = `${displayName} drift`; }],
    ['OAuth drift', (value) => { value.oauth2ClientId = 'not-numeric'; }],
    ['key drift', (value) => { value.oauth2ClientId = 'key:123'; }],
  ]) {
    await t.test(name, () => {
      const candidate = structuredClone(exactIdentity);
      mutate(candidate);
      assert.throws(
        () => provisionContract.validateServiceAccountIdentity(candidate, { email, displayName }),
        (error) => error.code === 'SERVICE_ACCOUNT_IDENTITY_INVALID',
      );
    });
  }
});

test('managed Service Account inventory binds each managed id to its exact expected email', () => {
  const { validateManagedServiceAccountInventory } = provisionContract;
  assert.equal(typeof validateManagedServiceAccountInventory, 'function');
  const expected = Object.values(GCP_IDENTITY.serviceAccounts).map((email) => ({
    id: email.split('@')[0], email,
  }));
  const rows = expected.map(({ email }) => ({
    email,
    name: `projects/${PROJECT}/serviceAccounts/${email}`,
    projectId: PROJECT,
  }));
  assert.equal(validateManagedServiceAccountInventory(rows, expected), true);
  const drift = structuredClone(rows);
  drift[0].email = `${expected[0].id}@foreign-project.iam.gserviceaccount.com`;
  drift[0].name = `projects/${PROJECT}/serviceAccounts/${drift[0].email}`;
  assert.throws(
    () => validateManagedServiceAccountInventory(drift, expected),
    (error) => ['LIST_RESPONSE_AMBIGUOUS', 'SERVICE_ACCOUNT_IDENTITY_INVALID'].includes(error.code),
  );
});

test('release archive freezes the exact raw Cloud Build Git blob beside the archive', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hkbuddy-task-5g-frozen-config-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const repositoryRoot = join(fixtureRoot, 'repository');
  await mkdir(join(repositoryRoot, 'production-v1', 'data', 'knowledge'), { recursive: true });
  const rawBuildConfig = Buffer.from('steps:\r\n  - id: exact-git-blob\r\n\r\n');
  await writeFile(join(repositoryRoot, 'production-v1', 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(repositoryRoot, 'production-v1', 'cloudbuild.yaml'), rawBuildConfig);
  await writeFile(
    join(repositoryRoot, 'production-v1', 'data', 'knowledge', 'hkbu-v1.json'),
    '{"sources":[],"claims":[]}\n',
  );
  const git = (...argv) => execFileSync('git', argv, {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Task 5G Contract');
  git('config', 'user.email', 'task-5g@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', 'production-v1');
  git('commit', '--quiet', '-m', 'fixture');
  const releaseSha = git('rev-parse', 'HEAD');

  await writeFile(
    join(repositoryRoot, 'production-v1', 'cloudbuild.yaml'),
    'steps:\n  - id: mutable-worktree-drift\n',
  );
  git('update-index', '--assume-unchanged', 'production-v1/cloudbuild.yaml');

  const result = await releaseContract.prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(fixtureRoot, 'source.tar.gz'),
  });
  const expectedHash = sha256(rawBuildConfig);
  assert.equal(result.buildConfigSha256, expectedHash);
  assert.equal(
    basename(result.buildConfig),
    `${releaseSha}.${expectedHash}.cloudbuild.yaml`,
  );
  assert.deepEqual(await readFile(result.buildConfig), rawBuildConfig);
  assert.equal(result.buildConfig.startsWith(repositoryRoot), false);
});

function privacyProofReference(id, observedAt) {
  const expiresAt = new Date(Date.parse(observedAt) + 5 * 60_000).toISOString();
  return {
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    filePath: `C:\\release\\privacy-${id}.json`,
    artifactSha256: id.repeat(64),
    objectSha256: id.repeat(64),
    boundarySha256: id.repeat(64),
    observedAt,
    expiresAt,
  };
}

function task8V3Entry(phase) {
  const start = privacyProofReference(phase === 'readiness' ? '1' : phase === 'workload' ? '3' : '5', PRIVACY_NOW);
  const end = privacyProofReference(
    phase === 'readiness' ? '2' : phase === 'workload' ? '4' : '6',
    new Date(Date.parse(PRIVACY_NOW) + 60_000).toISOString(),
  );
  return {
    schemaVersion: 3,
    filePath: `C:\\release\\${phase}.json`,
    artifactSha256: phase === 'readiness' ? '7'.repeat(64) : phase === 'workload' ? '8'.repeat(64) : '9'.repeat(64),
    objectSha256: phase === 'readiness' ? 'a'.repeat(64) : phase === 'workload' ? 'b'.repeat(64) : 'c'.repeat(64),
    candidateService: GCP_IDENTITY.candidateService,
    stableService: GCP_IDENTITY.service,
    trafficState: 'candidate-service-private-100',
    stableTrafficState: 'stable-prior-100',
    privacyProofs: { start, end },
  };
}

test('Task 8 schema v3 locators bind exact candidate-privacy schema references', () => {
  const { assertTask8Evidence } = releaseContract;
  assert.equal(typeof assertTask8Evidence, 'function');
  const valid = {
    readiness: task8V3Entry('readiness'),
    workload: task8V3Entry('workload'),
    mobile: task8V3Entry('mobile'),
  };
  assert.deepEqual(assertTask8Evidence(valid, {
    stableTrafficState: 'stable-prior-100',
    now: new Date('2026-08-27T08:02:00.000Z'),
  }), valid);

  for (const mutate of [
    (value) => { value.readiness.schemaVersion = 2; },
    (value) => { delete value.workload.privacyProofs.start; },
    (value) => { value.mobile.privacyProofs.end.expiresAt = value.mobile.privacyProofs.end.observedAt; },
    (value) => { value.mobile.privacyProofs.end.boundarySha256 = 'x'.repeat(64); },
    (value) => { value.readiness.privacyProofs.extra = value.readiness.privacyProofs.start; },
    (value) => { value.workload.privacyProofs.start.authorization = 'Bearer forbidden'; },
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => assertTask8Evidence(candidate, {
      stableTrafficState: 'stable-prior-100',
      now: new Date('2026-08-27T08:02:00.000Z'),
    }), /GCP release contract is invalid/);
  }
  const identical = structuredClone(valid);
  identical.readiness.privacyProofs.end = structuredClone(identical.readiness.privacyProofs.start);
  assert.throws(() => assertTask8Evidence(identical, {
    stableTrafficState: 'stable-prior-100',
    now: new Date('2026-08-27T08:02:00.000Z'),
  }), /GCP release contract is invalid/);
  assert.throws(() => assertTask8Evidence(valid, {
    stableTrafficState: 'stable-prior-100',
    now: new Date('2026-08-27T08:07:00.000Z'),
  }), /GCP release contract is invalid/);
});

test('candidate private invocation is acceptance-SA-only and never grants token creation', () => {
  const { candidatePrivateInvokerBinding } = releaseContract;
  assert.equal(typeof candidatePrivateInvokerBinding, 'function');
  assert.deepEqual(candidatePrivateInvokerBinding(), {
    member: `serviceAccount:${ACCEPTANCE_SERVICE_ACCOUNT}`,
    role: 'roles/run.servicesInvoker',
  });
  const serialized = JSON.stringify(candidatePrivateInvokerBinding());
  assert.equal(serialized.includes('admin@motionexp.com'), false);
  assert.equal(serialized.includes('serviceAccountOpenIdTokenCreator'), false);
  assert.equal(serialized.includes('serviceAccountTokenCreator'), false);
});

function basePrivacyBinding() {
  const binding = {
    projectId: PROJECT,
    projectNumber: PROJECT_NUMBER,
    organizationId: GCP_IDENTITY.organizationId,
    region: REGION,
    releaseSha: RELEASE_SHA,
    imageDigest: IMAGE_DIGEST,
    image: CANDIDATE_IMAGE,
    candidateService: GCP_IDENTITY.candidateService,
    candidateRevision: `${GCP_IDENTITY.candidateService}-${RELEASE_SHA.slice(0, 12)}`,
    candidateTag: `candidate-${RELEASE_SHA.slice(0, 12)}`,
    candidateOrigin: `https://candidate-${RELEASE_SHA.slice(0, 12)}---${GCP_IDENTITY.candidateService}-${PROJECT_NUMBER}.${REGION}.run.app`,
    candidateAudience: `https://${GCP_IDENTITY.candidateService}-${PROJECT_NUMBER}.${REGION}.run.app`,
    acceptanceServiceAccount: ACCEPTANCE_SERVICE_ACCOUNT,
    operator: 'admin@motionexp.com',
  };
  binding.expectedCandidate = expectedPrivacyCandidate(binding);
  return binding;
}

function expectedPrivacyCandidate(binding) {
  const probe = (path) => ({
    path, port: 8080, initialDelaySeconds: 0, timeoutSeconds: 1,
    periodSeconds: 10, failureThreshold: 3,
  });
  return {
    project: binding.projectId,
    region: binding.region,
    service: binding.candidateService,
    invokerIamDisabled: false,
    revision: binding.candidateRevision,
    tag: binding.candidateTag,
    image: binding.image,
    serviceAccount: GCP_IDENTITY.serviceAccounts.runtime,
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
    environment: {
      NODE_ENV: 'production',
      V1_RELEASE_COMMIT_SHA: binding.releaseSha,
    },
    secretEnvironment: {},
    secretMounts: {},
    probes: {
      startup: probe('/api/health/ready'),
      liveness: probe('/api/health/live'),
      readiness: probe('/api/health/ready'),
    },
    traffic: [{ revision: binding.candidateRevision, tag: binding.candidateTag, percent: 100 }],
    trafficState: 'candidate-service-private-100',
  };
}

function privacyRuntimeAnnotations(expected) {
  return {
    'run.googleapis.com/execution-environment': expected.executionEnvironment,
    'run.googleapis.com/network-interfaces': JSON.stringify([{
      network: expected.network, subnetwork: expected.subnet,
    }]),
    'run.googleapis.com/vpc-access-egress': expected.vpcEgress,
    'autoscaling.knative.dev/minScale': String(expected.minInstances),
    'autoscaling.knative.dev/maxScale': String(expected.maxInstances),
    'run.googleapis.com/cpu-throttling': String(expected.cpuThrottling),
    'run.googleapis.com/startup-cpu-boost': String(expected.startupCpuBoost),
  };
}

function privacyRuntimeSpec(expected) {
  const probe = ({ path, port, initialDelaySeconds, timeoutSeconds, periodSeconds, failureThreshold }) => ({
    httpGet: { path, port }, initialDelaySeconds, timeoutSeconds, periodSeconds, failureThreshold,
  });
  return {
    serviceAccountName: expected.serviceAccount,
    containerConcurrency: expected.concurrency,
    timeoutSeconds: `${expected.timeoutSeconds}s`,
    containers: [{
      name: 'hkbuddy-v1-api-1',
      workingDir: '/app',
      ports: [{ name: 'http1', containerPort: 8080 }],
      image: expected.image,
      resources: { limits: { cpu: String(expected.cpu), memory: expected.memory } },
      env: Object.entries(expected.environment).map(([name, value]) => ({ name, value })),
      startupProbe: probe(expected.probes.startup),
      livenessProbe: probe(expected.probes.liveness),
      readinessProbe: probe(expected.probes.readiness),
    }],
  };
}

function privacyServiceReadback(binding) {
  const expected = binding.expectedCandidate;
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: binding.candidateService,
      namespace: binding.projectNumber,
      generation: 7,
      labels: { 'cloud.googleapis.com/location': binding.region },
      annotations: {
        'run.googleapis.com/ingress': 'all',
        'run.googleapis.com/ingress-status': 'all',
        'run.googleapis.com/invoker-iam-disabled': 'false',
        'run.googleapis.com/maxScale': '1',
        'run.googleapis.com/urls': JSON.stringify([
          binding.candidateAudience,
          CANDIDATE_CANONICAL_URL,
        ]),
      },
    },
    spec: {
      template: {
        metadata: { name: binding.candidateRevision, annotations: privacyRuntimeAnnotations(expected) },
        spec: privacyRuntimeSpec(expected),
      },
      traffic: [{ revisionName: binding.candidateRevision, percent: 100, tag: binding.candidateTag }],
    },
    status: {
      address: { url: CANDIDATE_CANONICAL_URL },
      conditions: [{ type: 'Ready', status: 'True' }],
      latestCreatedRevisionName: binding.candidateRevision,
      latestReadyRevisionName: binding.candidateRevision,
      observedGeneration: 7,
      traffic: [{
        revisionName: binding.candidateRevision,
        percent: 100,
        tag: binding.candidateTag,
        url: `https://${binding.candidateTag}---${GCP_IDENTITY.candidateService}-c7dkesvlda-df.a.run.app`,
      }],
      url: CANDIDATE_CANONICAL_URL,
    },
  };
}

function privacyRevisionReadback(binding) {
  const expected = binding.expectedCandidate;
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Revision',
    metadata: {
      name: binding.candidateRevision,
      namespace: binding.projectNumber,
      generation: 11,
      ownerReferences: [{
        apiVersion: 'serving.knative.dev/v1',
        blockOwnerDeletion: true,
        controller: true,
        kind: 'Configuration',
        name: binding.candidateService,
        uid: 'ee358907-e7e0-4104-957c-709ba9c9259c',
      }],
      labels: {
        'cloud.googleapis.com/location': binding.region,
        'serving.knative.dev/configuration': binding.candidateService,
        'serving.knative.dev/service': binding.candidateService,
      },
      annotations: privacyRuntimeAnnotations(expected),
    },
    spec: privacyRuntimeSpec(expected),
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      imageDigest: binding.image,
      desiredReplicas: 1,
      observedGeneration: 11,
    },
  };
}

function privacyArtifactReadback(binding) {
  return {
    image_summary: {
      digest: binding.imageDigest,
      fully_qualified_digest: binding.image,
    },
  };
}

function jwtFor(payload, {
  header = { alg: 'RS256', typ: 'JWT', kid: 'kid-20260827' },
  signature = Buffer.alloc(32, 7).toString('base64url'),
} = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode(payload)}.${signature}`;
}

function fakeHeaders(entries = {}) {
  const values = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => values.get(String(name).toLowerCase()) ?? null };
}

function privacyFixtures(binding = basePrivacyBinding()) {
  const servicePolicy = {
    version: 1,
    etag: 'BwZakB-7zbk=',
    bindings: [{
      role: 'roles/run.servicesInvoker',
      members: [`serviceAccount:${binding.acceptanceServiceAccount}`],
    }],
  };
  const projectPolicy = { version: 1, etag: 'BwYAAQ==' };
  const organizationPolicy = { version: 1, etag: 'BwYABQ==' };
  const organization = {
    name: `organizations/${binding.organizationId}`,
    displayName: 'motionexp.com',
    lifecycleState: 'ACTIVE',
    creationTime: '2020-01-01T00:00:00.123456Z',
  };
  const project = {
    projectId: binding.projectId,
    projectNumber: binding.projectNumber,
    lifecycleState: 'ACTIVE',
    parent: { type: 'organization', id: binding.organizationId },
  };
  const role = {
    name: 'roles/run.servicesInvoker',
    stage: 'GA',
    deleted: false,
    includedPermissions: ['run.routes.invoke'],
  };
  const tokenPrerequisite = {
    version: 1,
    etag: 'BwYABg==',
    bindings: [{
      role: 'roles/iam.serviceAccountOpenIdTokenCreator',
      members: [`user:${binding.operator}`],
    }],
  };
  const effectivePolicy = {
    policyResults: [{
      fullResourceName: CANDIDATE_RESOURCE,
      policies: [
        {
          attachedResource: CANDIDATE_RESOURCE,
          policy: { bindings: structuredClone(servicePolicy.bindings) },
        },
      ],
    }],
  };
  const troubleshooter = {
    access: 'GRANTED',
    errors: [{
      code: 13,
      details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        domain: 'policytroubleshooter.googleapis.com',
        reason: 'ERROR_IAM_DENY',
      }],
      message: 'Failed to generate IAM deny explanation',
    }],
    explainedPolicies: [{
      access: 'NOT_GRANTED',
      fullResourceName: `//cloudresourcemanager.googleapis.com/projects/${binding.projectNumber}`,
      relevance: 'HEURISTIC_RELEVANCE',
      bindingExplanations: [{
        access: 'NOT_GRANTED',
        condition: {
          description: 'Limit operator bucket IAM access to the V1 buckets',
          expression: 'resource.service == "storage.googleapis.com"',
          title: 'HK Buddy V1 bucket IAM boundary',
        },
        conditionExplanation: {},
        memberships: {
          'user:admin@motionexp.com': {
            membership: 'MEMBERSHIP_NOT_INCLUDED', relevance: 'NORMAL',
          },
        },
        relevance: 'NORMAL',
        role: `projects/${binding.projectId}/roles/hkbuddyV1BucketIamPolicyOperator`,
        rolePermission: 'ROLE_PERMISSION_NOT_INCLUDED',
        rolePermissionRelevance: 'NORMAL',
      }],
    }, {
      access: 'GRANTED',
      fullResourceName: CANDIDATE_RESOURCE,
      relevance: 'HIGH',
      bindingExplanations: [{
        access: 'GRANTED',
        relevance: 'HIGH',
        role: 'roles/run.servicesInvoker',
        rolePermission: 'ROLE_PERMISSION_INCLUDED',
        memberships: {
          [`serviceAccount:${binding.acceptanceServiceAccount}`]: {
            membership: 'MEMBERSHIP_INCLUDED', relevance: 'HIGH',
          },
        },
      }],
    }],
  };
  const nowSeconds = Math.floor(Date.parse(PRIVACY_NOW) / 1_000);
  const token = jwtFor({
    iss: 'https://accounts.google.com',
    aud: binding.candidateAudience,
    sub: '123456789012345678901',
    email: binding.acceptanceServiceAccount,
    email_verified: true,
    iat: nowSeconds - 10,
    exp: nowSeconds + 3_590,
    azp: '123456789012-acceptance.apps.googleusercontent.com',
  });
  return {
    project, organization, servicePolicy, projectPolicy, organizationPolicy, role,
    roleDefinitions: { 'roles/run.servicesInvoker': role },
    folders: {}, tokenPrerequisite, effectivePolicy,
    troubleshooter, token,
    service: privacyServiceReadback(binding),
    revision: privacyRevisionReadback(binding),
    artifact: privacyArtifactReadback(binding),
    logEmptyPolls: 1,
    mutateLogEntry: () => undefined,
  };
}

function effectivePolicyFor(fixtures, binding) {
  const embedded = (policy) => ({
    ...(policy.bindings === undefined ? {} : { bindings: structuredClone(policy.bindings) }),
    ...(policy.auditConfigs === undefined
      ? {} : { auditConfigs: structuredClone(policy.auditConfigs) }),
  });
  const policies = [
    { attachedResource: CANDIDATE_RESOURCE, policy: embedded(fixtures.servicePolicy) },
    {
      attachedResource: `//cloudresourcemanager.googleapis.com/projects/${binding.projectId}`,
      policy: embedded(fixtures.projectPolicy),
    },
  ];
  let parent = `${fixtures.project.parent.type}s/${fixtures.project.parent.id}`;
  while (parent.startsWith('folders/')) {
    const folderId = parent.slice('folders/'.length);
    const folder = fixtures.folders[folderId];
    assert.ok(folder, `missing effective-policy folder ${folderId}`);
    policies.push({
      attachedResource: `//cloudresourcemanager.googleapis.com/folders/${folderId}`,
      policy: embedded(folder.policy),
    });
    parent = folder.descriptor.parent;
  }
  policies.push({
    attachedResource: `//cloudresourcemanager.googleapis.com/organizations/${binding.organizationId}`,
    policy: embedded(fixtures.organizationPolicy),
  });
  const present = policies.filter(({ attachedResource, policy }) => (
    attachedResource === CANDIDATE_RESOURCE
      || (policy.bindings?.length ?? 0) > 0
      || (policy.auditConfigs?.length ?? 0) > 0
  ));
  return { policyResults: [{ fullResourceName: CANDIDATE_RESOURCE, policies: present }] };
}

function createPrivacyHarness({ mutate = () => undefined } = {}) {
  const binding = basePrivacyBinding();
  const fixtures = privacyFixtures(binding);
  fixtures.readyData = {
    status: 'ready',
    productionReady: true,
    boundary: 'production-v1',
    checks: [
      'configuration', 'release-evidence', 'llm-smoke', 'database', 'media',
      'corpus', 'retention', 'dispatcher', 'runtime',
    ].map((name) => ({ name, status: 'ready' })),
  };
  mutate(fixtures, binding);
  const calls = [];
  const tokenCalls = [];
  const logRequests = [];
  const logPolls = new Map();
  const executor = async (argv) => {
    calls.push([...argv]);
    const command = argv.join(' ');
    if (command.startsWith('projects describe ')) return structuredClone(fixtures.project);
    if (command.startsWith(`run services get-iam-policy ${binding.candidateService}`)) {
      return structuredClone(fixtures.servicePolicy);
    }
    if (command.startsWith(`projects get-iam-policy ${binding.projectId}`)) {
      return structuredClone(fixtures.projectPolicy);
    }
    if (command.startsWith(`organizations get-iam-policy ${binding.organizationId}`)) {
      return structuredClone(fixtures.organizationPolicy);
    }
    if (command.startsWith(`organizations describe ${binding.organizationId}`)) {
      return structuredClone(fixtures.organization);
    }
    if (command.startsWith('resource-manager folders describe ')) {
      const folderId = argv[3];
      if (!fixtures.folders[folderId]) throw new Error('unknown folder');
      return structuredClone(fixtures.folders[folderId].descriptor);
    }
    if (command.startsWith('resource-manager folders get-iam-policy ')) {
      const folderId = argv[3];
      if (!fixtures.folders[folderId]) throw new Error('unknown folder');
      return structuredClone(fixtures.folders[folderId].policy);
    }
    if (command.startsWith(`iam service-accounts get-iam-policy ${binding.acceptanceServiceAccount}`)) {
      return structuredClone(fixtures.tokenPrerequisite);
    }
    if (command.startsWith('iam roles describe ')) {
      const positional = argv[3];
      const projectFlag = argv.find((member) => member.startsWith('--project='));
      const organizationFlag = argv.find((member) => member.startsWith('--organization='));
      const roleName = projectFlag
        ? `projects/${projectFlag.slice('--project='.length)}/roles/${positional}`
        : organizationFlag
          ? `organizations/${organizationFlag.slice('--organization='.length)}/roles/${positional}`
          : positional;
      const definition = fixtures.roleDefinitions[roleName];
      if (!definition) throw new Error('role unavailable');
      return structuredClone(definition);
    }
    if (command.startsWith('asset get-effective-iam-policy ')) return structuredClone(fixtures.effectivePolicy);
    if (command.startsWith('policy-troubleshoot iam ')) return structuredClone(fixtures.troubleshooter);
    if (command.startsWith(`run services describe ${binding.candidateService}`)) {
      return structuredClone(fixtures.service);
    }
    if (command.startsWith(`run revisions describe ${binding.candidateRevision}`)) {
      assert.equal(argv.includes('--service'), false);
      return structuredClone(fixtures.revision);
    }
    if (command.startsWith(`artifacts docker images describe ${binding.image}`)) {
      assert.equal(argv.some((member) => member.startsWith('--location=')), false);
      return structuredClone(fixtures.artifact);
    }
    if (command.startsWith('auth print-identity-token ')) {
      throw new Error('identity token must not use the JSON executor');
    }
    if (command.startsWith('logging read ')) {
      const filter = argv[2];
      assert.equal(filter.includes(`logName=\"${RUN_REQUEST_LOG}\"`), true);
      const lower = filter.match(/timestamp>="([^"]+)"/u)?.[1];
      const upper = filter.match(/timestamp<="([^"]+)"/u)?.[1];
      assert.equal(Number.isFinite(Date.parse(lower)), true);
      assert.equal(Date.parse(upper) - Date.parse(lower), 5 * 60_000 + 30_000);
      assert.equal(argv.includes('--freshness=5m'), false);
      assert.equal(argv.includes('--limit=2'), true);
      const trace = /trace=\"projects\/[^/]+\/traces\/([0-9a-f]{32})\"/.exec(filter)?.[1];
      const probe = logRequests.find((entry) => entry.traceId === trace);
      assert.ok(probe, 'log query must bind one issued probe trace');
      const attempts = (logPolls.get(trace) ?? 0) + 1;
      logPolls.set(trace, attempts);
      if (attempts <= fixtures.logEmptyPolls) return [];
      const entry = {
        insertId: `insert-${probe.kind}`,
        logName: RUN_REQUEST_LOG,
        severity: 'INFO',
        timestamp: PRIVACY_NOW,
        trace: `projects/${PROJECT}/traces/${trace}`,
        spanId: '0123456789abcdef',
        traceSampled: true,
        resource: {
          type: 'cloud_run_revision',
          labels: {
            configuration_name: binding.candidateService,
            project_id: PROJECT,
            location: REGION,
            service_name: GCP_IDENTITY.candidateService,
            revision_name: binding.candidateRevision,
          },
        },
        httpRequest: {
          requestMethod: 'GET',
          requestUrl: `${binding.candidateOrigin}${probe.path}`,
          status: probe.kind === 'anonymous' ? 403 : 200,
          userAgent: probe.userAgent,
          latency: '0.012345678s',
          protocol: 'HTTP/1.1',
          remoteIp: '203.0.113.7',
          serverIp: '10.24.0.2',
          requestSize: '123',
          responseSize: '456',
        },
      };
      if (probe.kind === 'anonymous') {
        entry.textPayload = 'The request was not authenticated. Either allow unauthenticated invocations or set the proper Authorization header.';
      }
      fixtures.mutateLogEntry(entry, probe);
      return [entry];
    }
    throw new Error(`unexpected privacy command: ${command}`);
  };
  const tokenExecutor = async (request) => {
    tokenCalls.push(structuredClone(request));
    return fixtures.token;
  };
  const fetch = async (url, options) => {
    const traceId = String(options.headers['X-Cloud-Trace-Context']).split('/')[0];
    const kind = Object.hasOwn(options.headers, 'Authorization') ? 'authenticated' : 'anonymous';
    const path = new URL(url).pathname;
    logRequests.push({ kind, path, traceId, userAgent: options.headers['User-Agent'] });
    assert.equal(['/api/health/live', '/api/health/ready'].includes(path), true);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(Object.hasOwn(options.headers, 'Cookie'), false);
    if (kind === 'anonymous') {
      assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
      return {
        status: 403,
        headers: fakeHeaders(),
        json: async () => { throw new Error('anonymous body must not be consumed'); },
      };
    }
    assert.equal(options.headers.Authorization, `Bearer ${fixtures.token}`);
    return {
      status: 200,
      headers: fakeHeaders({ 'content-type': 'application/json; charset=utf-8' }),
      json: async () => ({
        data: path === '/api/health/live'
          ? { status: 'ok', version: '0.1.0' }
          : structuredClone(fixtures.readyData),
        error: null,
        requestId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    };
  };
  let nonceIndex = 0;
  const nonce = () => `nonce-${++nonceIndex}`;
  return {
    binding, fixtures, calls, tokenCalls, logRequests, logPolls,
    executor, tokenExecutor, fetch, nonce,
    sleep: async () => undefined,
  };
}

test('privacy command plan is read-only and hard-gates exact live prerequisites', async () => {
  const { createCandidatePrivacyCommandPlan } = await import('../scripts/candidate-privacy-proof.js');
  const binding = basePrivacyBinding();
  const plan = createCandidatePrivacyCommandPlan(binding);
  assert.equal(plan.candidateResource, CANDIDATE_RESOURCE);
  assert.deepEqual(plan.tokenPrerequisite, [
    'iam', 'service-accounts', 'get-iam-policy', ACCEPTANCE_SERVICE_ACCOUNT,
    `--project=${PROJECT}`, '--format=json',
  ]);
  assert.deepEqual(plan.token, {
    generateIdToken: {
      endpoint: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(ACCEPTANCE_SERVICE_ACCOUNT)}:generateIdToken`,
      body: { audience: binding.candidateAudience, includeEmail: true },
    },
  });
  assert.deepEqual(plan.assetEffectiveIam, [
    'asset', 'get-effective-iam-policy', `--scope=organizations/${GCP_IDENTITY.organizationId}`,
    `--names=${CANDIDATE_RESOURCE}`, '--billing-project=tech-demo-433408',
    '--format=json',
  ]);
  assert.equal(Object.hasOwn(plan, 'assetAnalyses'), false);
  assert.deepEqual(plan.controlPlane, {
    service: [
      'run', 'services', 'describe', binding.candidateService,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
    revision: [
      'run', 'revisions', 'describe', binding.candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ],
    artifact: [
      'artifacts', 'docker', 'images', 'describe', binding.image,
      `--project=${PROJECT}`,
      '--format=json(image_summary.digest,image_summary.fully_qualified_digest)',
    ],
  });
  assert.deepEqual(plan.hierarchy.organizationDescribe, [
    'organizations', 'describe', GCP_IDENTITY.organizationId, '--format=json',
  ]);
  assert.deepEqual(plan.troubleshooter, [
    'policy-troubleshoot', 'iam', CANDIDATE_RESOURCE,
    `--principal-email=${ACCEPTANCE_SERVICE_ACCOUNT}`, '--permission=run.routes.invoke',
    `--project=${PROJECT}`, '--format=json',
  ]);
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes('analyze-iam-policy'), false);
  assert.equal(/\b(?:add|set|update|create|enable|disable|delete)-?iam-policy-binding\b/i.test(serialized), false);
  assert.equal(serialized.includes('serviceAccountTokenCreator'), false);
});

test('identity-token transport delegates OAuth handling to the principal-verified bounded requester', async () => {
  const {
    createCandidatePrivacyCommandPlan,
    createIdentityTokenExecutor,
  } = await import('../scripts/candidate-privacy-proof.js');
  const binding = basePrivacyBinding();
  const plan = createCandidatePrivacyCommandPlan(binding);
  const token = privacyFixtures(binding).token;
  let principalReads = 0;
  const requests = [];
  const request = async (input) => {
    requests.push(structuredClone(input));
    return { token };
  };
  Object.defineProperty(request, 'getPrincipal', {
    value: async () => { principalReads += 1; return 'admin@motionexp.com'; },
  });
  const tokenExecutor = createIdentityTokenExecutor({ request });
  assert.equal(await tokenExecutor(plan.token), token);
  assert.equal(principalReads, 1);
  assert.deepEqual(requests, [{
    method: 'POST',
    url: plan.token.generateIdToken.endpoint,
    body: plan.token.generateIdToken.body,
  }]);

  const makeRequest = ({ principal = 'admin@motionexp.com', response = { token }, error } = {}) => {
    const candidate = async () => {
      if (error) throw error;
      return structuredClone(response);
    };
    Object.defineProperty(candidate, 'getPrincipal', { value: async () => principal });
    return candidate;
  };
  for (const candidate of [
    makeRequest({ principal: 'foreign@example.test' }),
    makeRequest({ response: null }),
    makeRequest({ response: { token, extra: true } }),
    makeRequest({ response: { token: 'not-a-jwt' } }),
  ]) {
    await assert.rejects(
      () => createIdentityTokenExecutor({ request: candidate })(plan.token),
      /Candidate privacy proof failed/,
    );
  }
  const transportError = createIdentityTokenExecutor({
    request: makeRequest({ error: new Error(`provider leaked ${token}`) }),
  });
  await assert.rejects(() => transportError(plan.token), (error) => (
    error.message === 'Candidate privacy proof failed' && !error.message.includes(token)
  ));

  const foreignPlan = structuredClone(plan.token);
  foreignPlan.generateIdToken.endpoint = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/foreign%40example.com:generateIdToken';
  await assert.rejects(() => tokenExecutor(foreignPlan), /Candidate privacy proof failed/);
});

test('privacy proof validates a delayed token against its mint-time clock', async () => {
  const { runCandidatePrivacyProof } = await import('../scripts/candidate-privacy-proof.js');
  const start = Date.parse(PRIVACY_NOW);
  const harness = createPrivacyHarness({
    mutate: (fixtures, binding) => {
      fixtures.token = jwtFor({
        iss: 'https://accounts.google.com', aud: binding.candidateAudience,
        sub: '123456789012345678901', email: binding.acceptanceServiceAccount,
        email_verified: true, iat: Math.floor((start + 40_000) / 1_000),
        exp: Math.floor((start + 3_640_000) / 1_000),
      });
    },
  });
  let clockReads = 0;
  const proof = await runCandidatePrivacyProof({
    binding: harness.binding,
    executor: harness.executor,
    tokenExecutor: harness.tokenExecutor,
    fetch: harness.fetch,
    now: () => new Date(clockReads++ === 0 ? start : start + 45_000),
    nonce: harness.nonce,
    sleep: harness.sleep,
  });
  assert.equal(proof.result, 'pass');
  assert.equal(proof.occurredAt, new Date(start + 45_000).toISOString());
  assert.equal(proof.expiresAt, new Date(start + 345_000).toISOString());
});

test('controlled privacy producer proves inherited IAM, both edges, and exact logs without persisting credentials', async () => {
  const {
    finalizeCandidatePrivacyProof,
    runCandidatePrivacyProof,
    validateCandidatePrivacyProof,
  } = await import('../scripts/candidate-privacy-proof.js');
  const harness = createPrivacyHarness();
  const proof = await runCandidatePrivacyProof({
    binding: harness.binding,
    executor: harness.executor,
    tokenExecutor: harness.tokenExecutor,
    fetch: harness.fetch,
    now: () => new Date(PRIVACY_NOW),
    nonce: harness.nonce,
    sleep: harness.sleep,
  });
  assert.equal(proof.schemaVersion, 4);
  assert.equal(proof.result, 'pass');
  assert.equal(proof.occurredAt, PRIVACY_NOW);
  assert.equal(proof.expiresAt, '2026-08-27T08:05:00.000Z');
  assert.equal(proof.binding.candidateResource, CANDIDATE_RESOURCE);
  assert.equal(proof.identity.invokerMember, `serviceAccount:${ACCEPTANCE_SERVICE_ACCOUNT}`);
  assert.equal(proof.identity.invokerRole, 'roles/run.servicesInvoker');
  assert.equal(proof.identity.tokenCreatorPrerequisite, 'roles/iam.serviceAccountOpenIdTokenCreator');
  assert.equal(proof.controlPlane.stable, true);
  assert.equal(proof.controlPlane.beforeSha256, proof.controlPlane.afterSha256);
  assert.equal(
    proof.cloudAsset.publicPrincipalDenial.method,
    'effective-policy-role-definition-exclusion-v1',
  );
  assert.equal(proof.cloudAsset.publicPrincipalDenial.permission, 'run.routes.invoke');
  assert.equal(proof.cloudAsset.publicPrincipalDenial.principals.allUsers.decision, 'DENIED');
  assert.equal(proof.cloudAsset.publicPrincipalDenial.principals.allUsers.bindingCount, 0);
  assert.equal(
    proof.cloudAsset.publicPrincipalDenial.principals.allAuthenticatedUsers.bindingCount,
    0,
  );
  assert.deepEqual(proof.cloudAsset.publicPrincipalDenial.roleDefinitions, []);
  assert.equal(
    proof.cloudAsset.publicPrincipalDenial.sources.effectiveIamSha256,
    proof.cloudAsset.effectiveIamSha256,
  );
  assert.equal(
    proof.cloudAsset.publicPrincipalDenial.sources.hierarchyChainSha256,
    proof.hierarchy.chainSha256,
  );
  assert.equal(
    sha256(JSON.stringify(proof.cloudAsset.publicPrincipalDenial.effectivePolicyProjection)),
    proof.cloudAsset.effectiveIamSha256,
  );
  assert.equal(
    proof.cloudAsset.publicPrincipalDenial.sources.roleDefinitionsSha256,
    proof.hierarchy.policyRoleDefinitionsSha256,
  );
  assert.equal(
    proof.hierarchy.policyRoleDefinitionsSha256,
    proof.hierarchy.policyRoleDefinitionsSecondReadSha256,
  );
  assert.equal(proof.edge.anonymous.status, 403);
  assert.equal(proof.edge.authenticated.status, 200);
  assert.notEqual(proof.edge.anonymous.traceSha256, proof.edge.authenticated.traceSha256);
  assert.equal(validateCandidatePrivacyProof(proof, {
    binding: harness.binding,
    now: new Date(PRIVACY_NOW),
  }), true);
  assert.deepEqual(finalizeCandidatePrivacyProof(proof), proof);
  const forgedDenialProof = structuredClone(proof);
  forgedDenialProof.cloudAsset.publicPrincipalDenial.principals.allUsers.decision = 'GRANTED';
  const refinalizedForgedDenialProof = finalizeCandidatePrivacyProof(forgedDenialProof);
  assert.throws(() => validateCandidatePrivacyProof(refinalizedForgedDenialProof, {
    binding: harness.binding,
    now: new Date(PRIVACY_NOW),
  }), /Candidate privacy proof failed/);
  const legacyAnalyzerProof = structuredClone(proof);
  legacyAnalyzerProof.cloudAsset.analyses = {};
  const refinalizedLegacyAnalyzerProof = finalizeCandidatePrivacyProof(legacyAnalyzerProof);
  assert.throws(() => validateCandidatePrivacyProof(refinalizedLegacyAnalyzerProof, {
    binding: harness.binding,
    now: new Date(PRIVACY_NOW),
  }), /Candidate privacy proof failed/);
  assert.throws(() => validateCandidatePrivacyProof(proof, {
    binding: harness.binding,
    now: new Date(proof.expiresAt),
  }), /Candidate privacy proof failed/);
  const serialized = JSON.stringify(proof);
  assert.equal(serialized.includes(harness.fixtures.token), false);
  assert.equal(serialized.includes('Bearer '), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('Cookie'), false);
  assert.equal(serialized.includes('rawHeaders'), false);
  assert.equal(releaseContract.containsForbiddenPersistedSecret(proof), false);
  assert.equal(harness.logRequests.length, 2);
  assert.equal(harness.tokenCalls.length, 1);
  assert.equal(harness.calls.some((argv) => argv[0] === 'auth'), false);
  assert.equal(harness.calls.some((argv) => argv.includes('analyze-iam-policy')), false);
  assert.equal([...harness.logPolls.values()].every((count) => count === 2), true);
});

test('privacy denial attestation schema and source bindings fail closed under forgery', async (t) => {
  const {
    finalizeCandidatePrivacyProof,
    runCandidatePrivacyProof,
    validateCandidatePrivacyProof,
  } = await import('../scripts/candidate-privacy-proof.js');
  const harness = createPrivacyHarness({ mutate: (fixtures, binding) => {
    fixtures.projectPolicy.bindings = [{
      role: 'roles/logging.viewer', members: ['allUsers'],
    }];
    fixtures.roleDefinitions['roles/logging.viewer'] = {
      name: 'roles/logging.viewer', stage: 'GA', deleted: false,
      includedPermissions: ['logging.logEntries.list'],
    };
    fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
  } });
  const proof = await runCandidatePrivacyProof({
    binding: harness.binding, executor: harness.executor, tokenExecutor: harness.tokenExecutor,
    fetch: harness.fetch, now: () => new Date(PRIVACY_NOW), nonce: harness.nonce,
    sleep: harness.sleep,
  });
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
  };
  const refinalize = (candidate) => {
    const denial = candidate.cloudAsset.publicPrincipalDenial;
    const { attestationSha256: ignored, ...payload } = denial;
    void ignored;
    denial.attestationSha256 = sha256(JSON.stringify(canonicalize(payload)));
    return finalizeCandidatePrivacyProof(candidate);
  };
  const cases = [
    ['unknown field', (denial) => { denial.unknown = true; }],
    ['method drift', (denial) => { denial.method = 'provider-assertion'; }],
    ['permission drift', (denial) => { denial.permission = 'run.jobs.run'; }],
    ['effective-policy source drift', (denial) => {
      denial.sources.effectiveIamSha256 = 'f'.repeat(64);
    }],
    ['unknown principal', (denial) => { denial.principals.everyone = { decision: 'DENIED' }; }],
    ['forged grant decision', (denial) => { denial.principals.allUsers.decision = 'GRANTED'; }],
    ['binding-count drift', (denial) => { denial.principals.allUsers.bindingCount += 1; }],
    ['public binding witness omitted despite the persisted effective policy', (denial) => {
      denial.principals.allUsers.bindings = [];
      denial.principals.allUsers.bindingCount = 0;
    }],
    ['public binding witness digest is forged', (denial) => {
      denial.principals.allUsers.bindings[0].bindingSha256 = 'f'.repeat(64);
    }],
    ['foreign attached resource', (denial) => {
      denial.principals.allUsers.bindings[0].attachedResource =
        '//cloudresourcemanager.googleapis.com/projects/foreign-project';
    }],
    ['effective policy injects a folder outside the exact hierarchy chain', (denial) => {
      denial.effectivePolicyProjection.policyResults[0].policies.push({
        attachedResource: '//cloudresourcemanager.googleapis.com/folders/999999999999',
        policy: {
          auditConfigs: [],
          bindings: [{ role: 'roles/logging.viewer', members: ['allUsers'] }],
        },
      });
    }],
    ['invoke permission hidden in a public role', (denial) => {
      denial.roleDefinitions[0].includedPermissions = ['run.routes.invoke'];
    }],
    ['unreferenced role definition', (denial) => {
      denial.roleDefinitions.push({
        role: 'roles/browser', includedPermissions: ['resourcemanager.projects.get'],
      });
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const candidate = structuredClone(proof);
      mutate(candidate.cloudAsset.publicPrincipalDenial);
      assert.throws(() => validateCandidatePrivacyProof(refinalize(candidate), {
        binding: harness.binding,
        now: new Date(PRIVACY_NOW),
      }), /Candidate privacy proof failed/);
    });
  }
});

test('privacy producer traverses two folders and resolves predefined, project, and organization roles exactly', async () => {
  const { runCandidatePrivacyProof } = await import('../scripts/candidate-privacy-proof.js');
  const harness = createPrivacyHarness({ mutate: (fixtures, binding) => {
    fixtures.project.parent = { type: 'folder', id: '1001' };
    fixtures.folders = {
      1001: {
        descriptor: { name: 'folders/1001', parent: 'folders/1002', lifecycleState: 'ACTIVE' },
        policy: {
          version: 3,
          etag: 'BwYAAw==',
          bindings: [{ role: 'roles/logging.viewer', members: ['allUsers'] }],
        },
      },
      1002: {
        descriptor: {
          name: 'folders/1002',
          parent: `organizations/${binding.organizationId}`,
          lifecycleState: 'ACTIVE',
        },
        policy: { version: 1, etag: 'BwYABA==' },
      },
    };
    fixtures.projectPolicy.bindings = [{
      role: `projects/${binding.projectId}/roles/hkbuddyPublicMetadataReader`,
      members: ['allUsers'],
    }];
    fixtures.organizationPolicy.bindings = [{
      role: `organizations/${binding.organizationId}/roles/hkbuddyPublicMetadataReader`,
      members: ['allAuthenticatedUsers'],
    }];
    fixtures.roleDefinitions = {
      'roles/logging.viewer': {
        name: 'roles/logging.viewer', stage: 'GA', deleted: false,
        includedPermissions: ['logging.logEntries.list'],
      },
      [`projects/${binding.projectId}/roles/hkbuddyPublicMetadataReader`]: {
        name: `projects/${binding.projectId}/roles/hkbuddyPublicMetadataReader`,
        stage: 'GA', deleted: false, includedPermissions: ['resourcemanager.projects.get'],
      },
      [`organizations/${binding.organizationId}/roles/hkbuddyPublicMetadataReader`]: {
        name: `organizations/${binding.organizationId}/roles/hkbuddyPublicMetadataReader`,
        stage: 'GA', deleted: false, includedPermissions: ['resourcemanager.projects.get'],
      },
    };
    fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
  } });
  const proof = await runCandidatePrivacyProof({
    binding: harness.binding, executor: harness.executor, tokenExecutor: harness.tokenExecutor,
    fetch: harness.fetch, now: () => new Date(PRIVACY_NOW), nonce: harness.nonce,
    sleep: harness.sleep,
  });
  assert.equal(proof.result, 'pass');
  for (const folderId of ['1001', '1002']) {
    assert.equal(harness.calls.filter((argv) => argv.join(' ').startsWith(
      `resource-manager folders describe ${folderId}`,
    )).length, 2);
    assert.equal(harness.calls.filter((argv) => argv.join(' ').startsWith(
      `resource-manager folders get-iam-policy ${folderId}`,
    )).length, 2);
  }
  assert.equal(harness.calls.filter((argv) => (
    argv.join(' ') === 'iam roles describe roles/logging.viewer --format=json'
  )).length, 2);
  assert.equal(harness.calls.filter((argv) => argv.join(' ') === (
    `iam roles describe hkbuddyPublicMetadataReader --project=${PROJECT} --format=json`
  )).length, 2);
  assert.equal(harness.calls.filter((argv) => argv.join(' ') === (
    `iam roles describe hkbuddyPublicMetadataReader --organization=${GCP_IDENTITY.organizationId} --format=json`
  )).length, 2);
  assert.deepEqual(
    proof.cloudAsset.publicPrincipalDenial.roleDefinitions.map(({ role }) => role),
    [
      `organizations/${GCP_IDENTITY.organizationId}/roles/hkbuddyPublicMetadataReader`,
      `projects/${PROJECT}/roles/hkbuddyPublicMetadataReader`,
      'roles/logging.viewer',
    ].sort(),
  );
  assert.equal(proof.cloudAsset.publicPrincipalDenial.principals.allUsers.bindingCount, 2);
  assert.equal(
    proof.cloudAsset.publicPrincipalDenial.principals.allAuthenticatedUsers.bindingCount,
    1,
  );
});

test('privacy producer accepts allowlisted IAM audit config and harmless server-managed readback drift', async () => {
  const { runCandidatePrivacyProof } = await import('../scripts/candidate-privacy-proof.js');
  const harness = createPrivacyHarness({ mutate: (fixtures, binding) => {
    fixtures.projectPolicy.auditConfigs = [{
      service: 'allServices',
      auditLogConfigs: [{ logType: 'ADMIN_READ', exemptedMembers: [] }],
    }];
    fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
    let resourceVersion = 0;
    Object.defineProperty(fixtures.service.metadata, 'resourceVersion', {
      enumerable: true,
      get: () => String(++resourceVersion),
    });
    let revisionResourceVersion = 0;
    Object.defineProperty(fixtures.revision.metadata, 'resourceVersion', {
      enumerable: true,
      get: () => String(++revisionResourceVersion),
    });
  } });
  const proof = await runCandidatePrivacyProof({
    binding: harness.binding,
    executor: harness.executor,
    tokenExecutor: harness.tokenExecutor,
    fetch: harness.fetch,
    now: () => new Date(PRIVACY_NOW),
    nonce: harness.nonce,
    sleep: harness.sleep,
  });
  assert.equal(proof.result, 'pass');
  assert.equal(proof.controlPlane.beforeSha256, proof.controlPlane.afterSha256);
});

test('privacy producer accepts SDK 553 organization, folder, IAM, revision, and ingestion shapes', async () => {
  const { runCandidatePrivacyProof } = await import('../scripts/candidate-privacy-proof.js');
  const harness = createPrivacyHarness({ mutate: (fixtures, binding) => {
    fixtures.project.parent = { type: 'folder', id: '1001' };
    fixtures.folders = {
      1001: {
        descriptor: {
          name: 'folders/1001', parent: `organizations/${binding.organizationId}`,
          lifecycleState: 'ACTIVE', tags: { environment: 'production' },
        },
        policy: { version: 1, etag: 'BwYAAw==' },
      },
    };
    fixtures.projectPolicy = {
      version: 3,
      etag: 'BwYAAQ==',
      bindings: [{
        role: 'roles/logging.viewer', members: ['allUsers'],
        condition: {
          title: 'metadata-only', description: 'does not grant invocation',
          expression: 'request.time < timestamp("2030-01-01T00:00:00Z")',
          location: 'global',
        },
      }],
    };
    fixtures.roleDefinitions['roles/logging.viewer'] = {
      name: 'roles/logging.viewer', stage: 'GA', deleted: false,
      includedPermissions: ['logging.logEntries.list'],
    };
    fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
    fixtures.logEmptyPolls = 4;
  } });
  const proof = await runCandidatePrivacyProof({
    binding: harness.binding,
    executor: harness.executor,
    tokenExecutor: harness.tokenExecutor,
    fetch: harness.fetch,
    now: () => new Date(PRIVACY_NOW),
    nonce: harness.nonce,
    sleep: harness.sleep,
  });
  assert.equal(proof.result, 'pass');
  assert.equal(proof.cloudAsset.publicPrincipalDenial.principals.allUsers.bindingCount, 1);
  assert.equal(Math.max(...harness.logPolls.values()), 5);
});

test('privacy producer fails closed on incomplete effective policy, inherited public invoke, edge, or log drift', async (t) => {
  const { runCandidatePrivacyProof } = await import('../scripts/candidate-privacy-proof.js');
  const cases = [
    ['unstable hierarchy etag', (fixtures) => {
      let reads = 0;
      Object.defineProperty(fixtures.projectPolicy, 'etag', {
        enumerable: true,
        get: () => (++reads > 1 ? 'BwYACQ==' : 'BwYAAQ=='),
      });
    }],
    ['folder cycle', (fixtures) => {
      fixtures.project.parent = { type: 'folder', id: '1001' };
      fixtures.folders = {
        1001: {
          descriptor: { name: 'folders/1001', parent: 'folders/1002', lifecycleState: 'ACTIVE' },
          policy: { version: 1, etag: 'BwYAAw==' },
        },
        1002: {
          descriptor: { name: 'folders/1002', parent: 'folders/1001', lifecycleState: 'ACTIVE' },
          policy: { version: 1, etag: 'BwYABA==' },
        },
      };
    }],
    ['foreign organization ancestor', (fixtures) => {
      fixtures.project.parent = { type: 'folder', id: '1001' };
      fixtures.folders = {
        1001: {
          descriptor: { name: 'folders/1001', parent: 'organizations/999999999999', lifecycleState: 'ACTIVE' },
          policy: { version: 1, etag: 'BwYAAw==' },
        },
      };
    }],
    ['missing OpenID token prerequisite', (fixtures) => { fixtures.tokenPrerequisite.bindings = []; }],
    ['IAM policy unknown top-level key', (fixtures) => { fixtures.projectPolicy.unknown = true; }],
    ['IAM policy duplicate member', (fixtures) => {
      fixtures.projectPolicy.bindings = [{
        role: 'roles/logging.viewer', members: ['allUsers', 'allUsers'],
      }];
    }],
    ['IAM policy malformed condition', (fixtures) => {
      fixtures.projectPolicy.version = 3;
      fixtures.projectPolicy.bindings = [{
        role: 'roles/logging.viewer', members: ['allUsers'],
        condition: { title: 'bad', expression: 'true', unknown: 'drift' },
      }];
    }],
    ['legacy folder lifecycle enum', (fixtures) => {
      fixtures.project.parent = { type: 'folder', id: '1001' };
      fixtures.folders = {
        1001: {
          descriptor: {
            name: 'folders/1001', parent: `organizations/${GCP_IDENTITY.organizationId}`,
            lifecycleState: 'FOLDER_ACTIVE',
          },
          policy: { version: 1, etag: 'BwYAAw==' },
        },
      };
    }],
    ['inherited conditional public invoke', (fixtures, binding) => {
      fixtures.organizationPolicy.bindings = [{
        role: 'roles/run.servicesInvoker', members: ['allUsers'],
        condition: { title: 'still-public', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' },
      }];
      fixtures.organizationPolicy.version = 3;
      fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
    }],
    ['unresolvable custom role', (fixtures, binding) => {
      fixtures.projectPolicy.bindings = [{
        role: `projects/${PROJECT}/roles/unavailableRole`, members: ['allUsers'],
      }];
      fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
    }],
    ['mismatched custom role response name', (fixtures, binding) => {
      const roleName = `projects/${PROJECT}/roles/publicMetadataReader`;
      fixtures.projectPolicy.bindings = [{ role: roleName, members: ['allUsers'] }];
      fixtures.roleDefinitions[roleName] = {
        name: `projects/${PROJECT}/roles/foreignName`, stage: 'GA', deleted: false,
        includedPermissions: ['resourcemanager.projects.get'],
      };
      fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
    }],
    ['public role definition drifts between the two reads', (fixtures, binding) => {
      fixtures.projectPolicy.bindings = [{
        role: 'roles/logging.viewer', members: ['allUsers'],
      }];
      fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
      let reads = 0;
      fixtures.roleDefinitions['roles/logging.viewer'] = {
        name: 'roles/logging.viewer', stage: 'GA', deleted: false,
      };
      Object.defineProperty(fixtures.roleDefinitions['roles/logging.viewer'], 'includedPermissions', {
        enumerable: true,
        get: () => (++reads === 1
          ? ['logging.logEntries.list']
          : ['logging.logEntries.list', 'logging.logs.list']),
      });
    }],
    ['effective IAM omits nonempty project policy', (fixtures) => {
      fixtures.projectPolicy.bindings = [{ role: 'roles/logging.viewer', members: ['user:a@example.com'] }];
    }],
    ['effective IAM adds foreign policy', (fixtures) => {
      fixtures.effectivePolicy.policyResults[0].policies.push({
        attachedResource: '//cloudresourcemanager.googleapis.com/projects/999999999999',
        policy: { version: 1, etag: 'BwYAZA==' },
      });
    }],
    ['effective IAM duplicates an attached policy', (fixtures) => {
      fixtures.effectivePolicy.policyResults[0].policies.push(
        structuredClone(fixtures.effectivePolicy.policyResults[0].policies[0]),
      );
    }],
    ['effective IAM restores omitted policy envelope fields', (fixtures) => {
      fixtures.effectivePolicy.policyResults[0].policies[0].policy.etag = 'BwYAAA==';
      fixtures.effectivePolicy.policyResults[0].policies[0].policy.version = 1;
    }],
    ['effective IAM identifies the project by number instead of id', (fixtures, binding) => {
      fixtures.projectPolicy.bindings = [{
        role: 'roles/logging.viewer', members: ['user:a@example.com'],
      }];
      fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
      fixtures.effectivePolicy.policyResults[0].policies[1].attachedResource =
        `//cloudresourcemanager.googleapis.com/projects/${binding.projectNumber}`;
    }],
    ['effective IAM reorders nonempty direct policies', (fixtures, binding) => {
      fixtures.projectPolicy.bindings = [{ role: 'roles/logging.viewer', members: ['user:a@example.com'] }];
      fixtures.effectivePolicy = effectivePolicyFor(fixtures, binding);
      fixtures.effectivePolicy.policyResults[0].policies.reverse();
    }],
    ['ambiguous Troubleshooter', (fixtures) => { fixtures.troubleshooter.access = 'UNKNOWN'; }],
    ['unexpected Troubleshooter partial error', (fixtures) => {
      fixtures.troubleshooter.errors[0].details[0].reason = 'ERROR_UNKNOWN';
    }],
    ['extra Troubleshooter partial error', (fixtures) => {
      fixtures.troubleshooter.errors.push(structuredClone(fixtures.troubleshooter.errors[0]));
    }],
    ['Troubleshooter lacks high-relevance grant witness', (fixtures) => {
      fixtures.troubleshooter.explainedPolicies[1].bindingExplanations[0].relevance = 'NORMAL';
    }],
    ['Troubleshooter conditional ambiguity', (fixtures) => {
      fixtures.troubleshooter.explainedPolicies[1].bindingExplanations[0].condition = {
        evaluationState: 'TRUE',
      };
    }],
    ['invalid token audience', (fixtures, binding) => {
      const nowSeconds = Math.floor(Date.parse(PRIVACY_NOW) / 1_000);
      fixtures.token = jwtFor({
        iss: 'https://accounts.google.com', aud: 'https://foreign.example',
        sub: '123456789012345678901', email: binding.acceptanceServiceAccount,
        email_verified: true, iat: nowSeconds - 10, exp: nowSeconds + 3_590,
      });
    }],
    ['invalid token header', (fixtures) => {
      const claims = JSON.parse(Buffer.from(fixtures.token.split('.')[1], 'base64url').toString('utf8'));
      fixtures.token = jwtFor(claims, { header: { alg: 'HS256', typ: 'JWT', kid: 'kid' } });
    }],
    ['missing token signature', (fixtures) => {
      const claims = JSON.parse(Buffer.from(fixtures.token.split('.')[1], 'base64url').toString('utf8'));
      fixtures.token = jwtFor(claims, { signature: '' });
    }],
    ['token lifetime exceeds one-hour envelope', (fixtures) => {
      const claims = JSON.parse(Buffer.from(fixtures.token.split('.')[1], 'base64url').toString('utf8'));
      claims.exp = claims.iat + 3_701;
      fixtures.token = jwtFor(claims);
    }],
    ['request log payload', (fixtures) => {
      fixtures.logEmptyPolls = 0;
      fixtures.mutateLogEntry = (entry) => { entry.jsonPayload = { message: 'forbidden' }; };
    }],
    ['request log operation metadata', (fixtures) => {
      fixtures.logEmptyPolls = 0;
      fixtures.mutateLogEntry = (entry) => { entry.operation = { id: 'foreign' }; };
    }],
    ['request log error metadata', (fixtures) => {
      fixtures.logEmptyPolls = 0;
      fixtures.mutateLogEntry = (entry) => { entry.errorGroups = [{ id: 'foreign' }]; };
    }],
    ['request log configuration drift', (fixtures) => {
      fixtures.logEmptyPolls = 0;
      fixtures.mutateLogEntry = (entry) => {
        entry.resource.labels.configuration_name = 'foreign-configuration';
      };
    }],
    ['authenticated request log unexpectedly gains text payload', (fixtures) => {
      fixtures.logEmptyPolls = 0;
      fixtures.mutateLogEntry = (entry, probe) => {
        if (probe.kind === 'authenticated') entry.textPayload = 'unexpected authenticated payload';
      };
    }],
    ['anonymous request log text payload contains control characters', (fixtures) => {
      fixtures.logEmptyPolls = 0;
      fixtures.mutateLogEntry = (entry, probe) => {
        if (probe.kind === 'anonymous') entry.textPayload = 'unsafe\nsecond line';
      };
    }],
    ['anonymous request log text payload is unbounded', (fixtures) => {
      fixtures.logEmptyPolls = 0;
      fixtures.mutateLogEntry = (entry, probe) => {
        if (probe.kind === 'anonymous') entry.textPayload = 'x'.repeat(4097);
      };
    }],
    ['candidate service ingress drift', (fixtures) => {
      fixtures.service.metadata.annotations['run.googleapis.com/ingress'] = 'internal';
    }],
    ['candidate service max-scale drift', (fixtures) => {
      fixtures.service.metadata.annotations['run.googleapis.com/maxScale'] = '10';
    }],
    ['candidate service not ready', (fixtures) => {
      fixtures.service.status.conditions[0].status = 'False';
    }],
    ['candidate revision project drift', (fixtures) => {
      fixtures.revision.metadata.namespace = '999999999999';
    }],
    ['candidate service observed-generation drift', (fixtures) => {
      fixtures.service.status.observedGeneration = 6;
    }],
    ['candidate service address drift', (fixtures) => {
      fixtures.service.status.address.url = 'https://foreign.example';
    }],
    ['candidate service URL annotation missing', (fixtures) => {
      delete fixtures.service.metadata.annotations['run.googleapis.com/urls'];
    }],
    ['candidate service primary URL missing', (fixtures) => {
      delete fixtures.service.status.url;
    }],
    ['candidate service address missing', (fixtures) => {
      delete fixtures.service.status.address;
    }],
    ['candidate service address has an unknown field', (fixtures) => {
      fixtures.service.status.address.unexpected = 'drift';
    }],
    ['candidate service deterministic URL anchor missing', (fixtures) => {
      fixtures.service.metadata.annotations['run.googleapis.com/urls'] = JSON.stringify([
        CANDIDATE_CANONICAL_URL,
      ]);
    }],
    ['candidate service duplicate URL alias', (fixtures, binding) => {
      fixtures.service.metadata.annotations['run.googleapis.com/urls'] = JSON.stringify([
        binding.candidateAudience,
        binding.candidateAudience,
      ]);
      fixtures.service.status.url = binding.candidateAudience;
      fixtures.service.status.address.url = binding.candidateAudience;
    }],
    ['candidate service third URL alias', (fixtures, binding) => {
      fixtures.service.metadata.annotations['run.googleapis.com/urls'] = JSON.stringify([
        binding.candidateAudience,
        CANDIDATE_CANONICAL_URL,
        'https://another-provider-declared-identifier.run.app',
      ]);
    }],
    ['candidate service unsafe URL alias', (fixtures, binding) => {
      fixtures.service.metadata.annotations['run.googleapis.com/urls'] = JSON.stringify([
        binding.candidateAudience,
        'https://opaque-provider-identifier.run.app/path',
      ]);
    }],
    ['candidate service tagged traffic URL is undeclared', (fixtures, binding) => {
      fixtures.service.status.traffic[0].url = `https://${binding.candidateTag}---undeclared.run.app`;
    }],
    ['candidate service secondary URL alias drifts between reads', (fixtures, binding) => {
      fixtures.service.status.url = binding.candidateAudience;
      fixtures.service.status.address.url = binding.candidateAudience;
      fixtures.service.status.traffic[0].url = binding.candidateOrigin;
      let reads = 0;
      Object.defineProperty(fixtures.service.metadata.annotations, 'run.googleapis.com/urls', {
        enumerable: true,
        get: () => JSON.stringify([
          binding.candidateAudience,
          reads++ === 0
            ? CANDIDATE_CANONICAL_URL
            : 'https://changed-provider-identifier.run.app',
        ]),
      });
    }],
    ['candidate tagged traffic alias drifts between reads', (fixtures, binding) => {
      let reads = 0;
      Object.defineProperty(fixtures.service.status.traffic[0], 'url', {
        enumerable: true,
        get: () => reads++ === 0
          ? binding.candidateOrigin
          : `https://${binding.candidateTag}---${new URL(CANDIDATE_CANONICAL_URL).hostname}`,
      });
    }],
    ['candidate revision observed-generation drift', (fixtures) => {
      fixtures.revision.status.observedGeneration = 10;
    }],
    ['candidate container working-directory drift between reads', (fixtures) => {
      let reads = 0;
      Object.defineProperty(fixtures.service.spec.template.spec.containers[0], 'workingDir', {
        enumerable: true,
        get: () => (++reads > 1 ? '/foreign' : '/app'),
      });
    }],
    ['candidate revision desired replica drift', (fixtures) => {
      fixtures.revision.status.desiredReplicas = 2;
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const harness = createPrivacyHarness({ mutate });
      await assert.rejects(() => runCandidatePrivacyProof({
        binding: harness.binding,
        executor: harness.executor,
        tokenExecutor: harness.tokenExecutor,
        fetch: harness.fetch,
        now: () => new Date(PRIVACY_NOW),
        nonce: harness.nonce,
        sleep: harness.sleep,
      }), /Candidate privacy proof failed/);
    });
  }
});

test('privacy producer refuses a proof when its original evidence window expires during readback', async () => {
  const { runCandidatePrivacyProof } = await import('../scripts/candidate-privacy-proof.js');
  const harness = createPrivacyHarness({ mutate: (fixtures) => { fixtures.logEmptyPolls = 0; } });
  const startedAt = Date.parse(PRIVACY_NOW);
  let clockCalls = 0;
  await assert.rejects(() => runCandidatePrivacyProof({
    binding: harness.binding,
    executor: harness.executor,
    tokenExecutor: harness.tokenExecutor,
    fetch: harness.fetch,
    now: () => new Date(clockCalls++ < 3 ? startedAt : startedAt + 5 * 60_000),
    nonce: harness.nonce,
    sleep: harness.sleep,
  }), /Candidate privacy proof failed/);
  assert.equal(clockCalls, 5, 'the producer must capture one final post-readback clock');
});

function unresolvedReadinessEntry() {
  const entry = task8V3Entry('readiness');
  entry.filePath = 'C:\\release\\controlled-readiness.json';
  entry.artifactSha256 = '0'.repeat(64);
  entry.objectSha256 = '0'.repeat(64);
  for (const [boundary, reference] of Object.entries(entry.privacyProofs)) {
    reference.schemaVersion = 3;
    reference.filePath = `C:\\release\\controlled-readiness-privacy-${boundary}.json`;
    reference.artifactSha256 = '0'.repeat(64);
    reference.objectSha256 = '0'.repeat(64);
    reference.boundarySha256 = '0'.repeat(64);
  }
  return entry;
}

test('readiness producer runs fresh privacy and authoritative live/ready evidence without accepting JSON', async (t) => {
  const {
    finalizeTask8ReadinessRecord,
    runTask8Readiness,
    validateTask8ReadinessRecord,
  } = await import('../scripts/task8-readiness-producer.js');
  const sourceArchiveSha256 = 'e'.repeat(64);
  const run = async ({ mutate = () => undefined, entry = unresolvedReadinessEntry() } = {}) => {
    const harness = createPrivacyHarness({ mutate });
    let clockMilliseconds = Date.parse(PRIVACY_NOW);
    const result = await runTask8Readiness({
      binding: harness.binding,
      evidenceContract: entry,
      sourceArchiveSha256,
      executor: harness.executor,
      tokenExecutor: harness.tokenExecutor,
      fetch: harness.fetch,
      now: () => new Date(clockMilliseconds++),
      nonce: harness.nonce,
      sleep: harness.sleep,
    });
    return { harness, result };
  };

  const { harness, result } = await run();
  assert.equal(result.record.schemaVersion, 3);
  assert.equal(result.record.privacyProofs.start.schemaVersion, CANDIDATE_PRIVACY_SCHEMA_VERSION);
  assert.equal(result.record.privacyProofs.end.schemaVersion, CANDIDATE_PRIVACY_SCHEMA_VERSION);
  assert.equal(result.record.gate, 'readiness');
  assert.equal(result.record.result, 'pass');
  assert.equal(result.record.controlPlane.stable, true);
  assert.equal(result.record.controlPlane.beforeSha256, result.record.controlPlane.afterSha256);
  assert.deepEqual(result.record.readiness.checks.map(({ name }) => name), [
    'configuration', 'release-evidence', 'llm-smoke', 'database', 'media',
    'corpus', 'retention', 'dispatcher', 'runtime',
  ]);
  assert.equal(result.record.probes.live.status, 200);
  assert.equal(result.record.probes.ready.status, 200);
  assert.notEqual(
    result.record.privacyProofs.start.artifactSha256,
    result.record.privacyProofs.end.artifactSha256,
  );
  assert.deepEqual(Object.keys(result.artifacts), ['privacyStart', 'privacyEnd', 'readiness']);
  assert.equal(result.artifacts.readiness.contents, `${JSON.stringify(result.record, null, 2)}\n`);
  assert.equal(result.evidence.artifactSha256, result.record.artifactSha256);
  assert.equal(result.evidence.objectSha256, sha256(result.artifacts.readiness.contents));
  assert.deepEqual(result.evidence.privacyProofs, result.record.privacyProofs);
  assert.equal(validateTask8ReadinessRecord(result.record, {
    binding: harness.binding,
    sourceArchiveSha256,
    now: new Date(PRIVACY_NOW),
  }), true);
  assert.throws(() => validateTask8ReadinessRecord(result.record, {
    binding: harness.binding,
    sourceArchiveSha256,
    now: new Date(result.record.expiresAt),
  }), /Task 8 readiness production failed/);
  assert.deepEqual(finalizeTask8ReadinessRecord(result.record), result.record);
  assert.equal(harness.tokenCalls.length, 4, 'two privacy proofs and two health probes mint in memory');
  assert.equal(harness.logRequests.filter(({ path }) => path === '/api/health/live').length, 5);
  assert.equal(harness.logRequests.filter(({ path }) => path === '/api/health/ready').length, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(harness.fixtures.token), false);
  assert.equal(serialized.includes('Authorization'), false);

  const prebuilt = unresolvedReadinessEntry();
  prebuilt.artifactSha256 = '7'.repeat(64);
  let prebuiltCalls = 0;
  await assert.rejects(() => runTask8Readiness({
    binding: basePrivacyBinding(),
    evidenceContract: prebuilt,
    sourceArchiveSha256,
    executor: async () => { prebuiltCalls += 1; },
    tokenExecutor: async () => { prebuiltCalls += 1; },
    fetch: async () => { prebuiltCalls += 1; },
    now: () => new Date(PRIVACY_NOW),
    nonce: () => 'unused',
    sleep: async () => undefined,
  }), /Task 8 readiness production failed/);
  assert.equal(prebuiltCalls, 0);

  for (const [name, mutate] of [
    ['missing component', (fixtures) => { fixtures.readyData.checks.pop(); }],
    ['extra component', (fixtures) => { fixtures.readyData.checks.push({ name: 'extra', status: 'ready' }); }],
    ['reordered component', (fixtures) => { fixtures.readyData.checks.reverse(); }],
    ['not-ready component', (fixtures) => { fixtures.readyData.checks[3].status = 'not-ready'; }],
    ['wrong readiness boundary', (fixtures) => { fixtures.readyData.boundary = 'local-preview-only'; }],
    ['readiness unknown field', (fixtures) => { fixtures.readyData.unknown = true; }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(() => run({ mutate }), /Task 8 readiness production failed/);
    });
  }
});
