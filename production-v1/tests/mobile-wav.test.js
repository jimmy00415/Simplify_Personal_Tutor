import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CANONICAL_WAV, validateCanonicalWav } from '../src/media/canonical-wav.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mobile-voice-en.wav', import.meta.url));
const FIXED_SHA256 = '92bb7f07a1d1f95bf037dd805f3d5d06fb837a72839698e2b5f10674f095cf33';

test('controlled mobile voice fixture is fixed canonical non-silent PCM16LE', async () => {
  const bytes = await readFile(FIXTURE);
  const wav = validateCanonicalWav(bytes, { expectedSha256: FIXED_SHA256 });
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16_000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(wav.mimeType, 'audio/wav');
  assert.equal(wav.durationMs, 1_000);
  assert.ok(wav.durationMs > 250 && wav.durationMs < CANONICAL_WAV.maxDurationMs);
  let mean = 0;
  let squaredDelta = 0;
  let count = 0;
  for (let offset = CANONICAL_WAV.headerBytes; offset < bytes.length; offset += 2) {
    const sample = bytes.readInt16LE(offset);
    count += 1;
    const delta = sample - mean;
    mean += delta / count;
    squaredDelta += delta * (sample - mean);
  }
  assert.ok(squaredDelta / count > 1_000_000, 'fixture must contain non-silent sample variance');
});
