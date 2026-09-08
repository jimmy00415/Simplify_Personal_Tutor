# Chromium microphone alignment regression fixture

`mobile-voice-chromium-shifted.wav` is a synthetic pinned-Chromium microphone capture from `mobile-voice-periodic-base.wav` with the test-only challenge seed `Buffer.alloc(32, 0x31)`. Captured on 2026-09-08 using the existing fake microphone browser flow; it contains no real microphone/user recording.

The browser capture lasts 1080 ms. The former coarse base-only alignment reports base correlation 0.993483 but watermark correlation 0.170466 and incorrectly rejects it. Matching the full challenge at every sample offset resolves the periodic-signal ambiguity while retaining the existing base, watermark, duration and replay rejection requirements.
