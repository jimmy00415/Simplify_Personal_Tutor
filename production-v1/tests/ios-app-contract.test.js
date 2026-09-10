import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const iosRoot = new URL('../ios-app/', import.meta.url);

async function text(name) {
  return readFile(new URL(name, iosRoot), 'utf8');
}

test('iOS templates include microphone use, privacy types, and no camera or location keys', async () => {
  const plist = await text('Info.plist.tpl');
  const privacy = await text('PrivacyInfo.xcprivacy');
  const capacitor = await text('capacitor.config.ts');
  const ci = await text('ci/codemagic.yaml');
  const listing = await readFile(new URL('../../docs/app-store/listing-draft.md', import.meta.url), 'utf8');

  assert.match(plist, /NSMicrophoneUsageDescription/);
  assert.match(plist, /optional voice-message transcription/i);
  assert.doesNotMatch(plist, /NSCameraUsageDescription|NSLocationWhenInUseUsageDescription|NSLocationAlways/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeOtherUserContent/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeAudioData/);
  assert.match(privacy, /NSPrivacyCollectedDataTypeUserID/);
  assert.match(capacitor, /com\.simplify\.hongkongbuddy/);
  assert.match(capacitor, /asia-east2\.run\.app/);
  assert.match(ci, /IPHONEOS_DEPLOYMENT_TARGET/);
  assert.match(ci, /iOS 26|xcode:\s*26/i);
  assert.match(listing, /Do not claim official university endorsement, tone scoring/);
  assert.match(listing, /not an official/);
  assert.doesNotMatch(listing, /official HKBU endorsement guaranteed|provides tone scoring|pronunciation grades for learners/i);
});
