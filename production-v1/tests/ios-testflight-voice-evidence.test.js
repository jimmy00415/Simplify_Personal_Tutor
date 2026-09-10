import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finalizeEvidenceRecord,
  iosTestflightVoiceEvidenceContract,
  validateIosTestflightVoiceEvidence,
} from '../src/services/voice-evidence.js';

test('TestFlight voice evidence requires bundle id, build, and a real-device pass', () => {
  const now = new Date('2026-09-10T00:00:00.000Z');
  const commitSha = 'a'.repeat(40);
  const record = {
    schemaVersion: 1,
    commitSha,
    capability: 'ios-testflight-voice',
    bundleId: 'com.simplify.hongkongbuddy',
    cfBundleVersion: '1',
    normalizerContractVersion: 'canonical-wav-v1',
    normalizerSource: 'web-audio',
    reportSource: iosTestflightVoiceEvidenceContract.reportSource,
    deviceRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    deviceModelIdentifier: 'iPhone15,2',
    iosVersion: '26.0',
    occurredAt: now.toISOString(),
    result: 'pass',
  };
  const sealed = finalizeEvidenceRecord(record);
  assert.equal(validateIosTestflightVoiceEvidence(sealed, {
    expectedVersion: sealed.artifactSha256,
    commitSha,
    normalizerContractVersion: 'canonical-wav-v1',
    now,
  }), true);
  assert.equal(validateIosTestflightVoiceEvidence({ ...sealed, result: 'fail' }, {
    expectedVersion: sealed.artifactSha256,
    commitSha,
    normalizerContractVersion: 'canonical-wav-v1',
    now,
  }), false);
});
