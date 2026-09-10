import { createHash } from 'node:crypto';

import { GCP_IDENTITY } from '../gcp-identity.js';
import { readBoundedJsonObjectFile } from './release-evidence.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const RELEASE_SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AZURE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GOOGLE_PROJECT = GCP_IDENTITY.projectId;
const GOOGLE_SPEECH_LOCATION = GCP_IDENTITY.speechRegion;
const GOOGLE_RESPONSE_LANGUAGE_CODES = Object.freeze({
  en: 'en-US',
  'yue-Hant-HK': 'yue-Hant-HK',
  'cmn-Hans-CN': 'cmn-Hans-CN',
});
const VOICE_EVIDENCE_MAX_BYTES = 64 * 1_024;
const SPEECH_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'commitSha', 'capability', 'provider', 'contractVersion',
  'providerConfigDigest', 'occurredAt', 'result', 'latencyMs', 'artifactSha256',
]);
const ASR_FIXTURE_KEYS = Object.freeze(['fixtureSha256', 'fixtureDurationMs']);
const SPEECH_V2_KEYS = Object.freeze([
  'schemaVersion', 'commitSha', 'capability', 'provider', 'contractVersion',
  'providerConfigDigest', 'runtimeIdentity', 'occurredAt', 'result', 'samples',
  'artifactSha256',
]);
const ASR_V2_SAMPLE_KEYS = Object.freeze([
  'responseLanguage', 'locale', 'referenceId', 'fixtureOrigin', 'fixtureVoiceName',
  'fixtureGeneratorContractVersion', 'fixtureGeneratorConfigDigest', 'fixtureTtsLatencyMs',
  'fixtureSha256', 'fixtureDurationMs', 'fixtureByteLength', 'transcriptUtf8Bytes',
  'transcriptCodePointCount', 'normalizedReferenceCodePointCount',
  'normalizedEditDistance', 'normalizedErrorRate', 'asrLatencyMs',
]);
const TTS_V2_SAMPLE_KEYS = Object.freeze([
  'responseLanguage', 'locale', 'voiceName', 'latencyMs', 'audioSha256',
  'audioByteLength', 'decoder', 'decodedSampleCount', 'decodedSampleRate',
  'decodedChannelCount', 'decodedDurationMs', 'decodable',
]);
const SPEECH_V2_DEFINITIONS = Object.freeze({
  'yue-Hant-HK': Object.freeze({
    locale: 'yue-Hant-HK', referenceId: 'voice-smoke-yue-v1', voiceName: 'yue-HK-Chirp3-HD-Achernar',
  }),
  en: Object.freeze({
    locale: 'en-US', referenceId: 'voice-smoke-en-v1', voiceName: 'en-US-Chirp3-HD-Achernar',
  }),
  'cmn-Hans-CN': Object.freeze({
    locale: 'cmn-Hans-CN', referenceId: 'voice-smoke-cmn-v1', voiceName: 'cmn-CN-Chirp3-HD-Achernar',
  }),
});
const SPEECH_V2_LANGUAGES = Object.freeze(Object.keys(SPEECH_V2_DEFINITIONS));
const IOS_V4_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'commitSha', 'capability', 'normalizerContractVersion',
  'reportSource', 'deviceReportSha256', 'deviceReportByteLength', 'deviceRunId',
  'deviceModelIdentifier', 'iosVersion', 'safariVersion', 'captureMimeType',
  'deviceObservedAt', 'rawCaptureFormat', 'rawCaptureSha256', 'rawCaptureByteLength',
  'fixtureSha256', 'fixtureDurationMs', 'fixtureByteLength',
  'normalizationStepsSha256', 'normalizationStepsByteLength',
  'normalizerPackage', 'normalizerPlatform', 'normalizerBinarySha256',
  'normalizerVersion', 'normalizerArguments', 'normalizerExitCode',
  'normalizationBindingSha256', 'verifiedStepIds', 'occurredAt', 'result',
  'artifactSha256',
]);

export const iosVoiceEvidenceContract = Object.freeze({
  schemaVersion: 4,
  reportSchemaVersion: 2,
  reportSource: 'real-iphone-safari-manual-v2',
  normalizationStepsSchemaVersion: 2,
  normalizationStepsSource: 'real-iphone-safari-normalization-v2',
  rawCaptureFormat: 'iso-bmff-audio-v1',
  stepIds: Object.freeze([
    'permission-prompt-granted', 'recording-auto-stopped-55s',
    'permission-tracks-stopped', 'cancel-stops-tracks',
    'single-idempotent-upload', 'transcript-editable-before-send',
    'text-fallback-after-denial', 'raw-container-not-uploaded',
  ]),
  normalizer: Object.freeze({
    package: '@ffmpeg-installer/ffmpeg@1.1.0',
    platforms: Object.freeze({
      'win32-x64': Object.freeze({
        installerVersion: '20181217-f22fcd4',
        binarySha256: 'c8abc49e7be62dde8e12972af373959e0076a7b8dc8040eb45978e0608f8781e',
        version: 'ffmpeg version N-92722-gf22fcd4483 Copyright (c) 2000-2018 the FFmpeg developers',
      }),
    }),
    arguments: Object.freeze([
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file', '-i', 'capture.mp4',
      '-map', '0:a:0', '-map_metadata', '-1', '-vn',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-flags:a', '+bitexact', '-fflags', '+bitexact', '-f', 'wav', 'derived.wav',
    ]),
  }),
});

function hasExactOwnKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  return actualKeys.every((key) => expected.has(key));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function finalizeEvidenceRecord(record) {
  const { artifactSha256: ignored, ...withoutDigest } = record;
  void ignored;
  return {
    ...withoutDigest,
    artifactSha256: createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex'),
  };
}

export function iosVoiceNormalizationBinding(value) {
  const binding = {
    deviceRunId: value?.deviceRunId,
    normalizerContractVersion: value?.normalizerContractVersion,
    rawCaptureSha256: value?.rawCaptureSha256,
    rawCaptureByteLength: value?.rawCaptureByteLength,
    fixtureSha256: value?.fixtureSha256,
    fixtureByteLength: value?.fixtureByteLength,
    fixtureDurationMs: value?.fixtureDurationMs,
    normalizationStepsSha256: value?.normalizationStepsSha256,
    normalizationStepsByteLength: value?.normalizationStepsByteLength,
    normalizerPackage: value?.normalizerPackage,
    normalizerPlatform: value?.normalizerPlatform,
    normalizerBinarySha256: value?.normalizerBinarySha256,
    normalizerVersion: value?.normalizerVersion,
    normalizerArguments: value?.normalizerArguments,
    normalizerExitCode: value?.normalizerExitCode,
  };
  return createHash('sha256').update(canonicalJson(binding)).digest('hex');
}

function azureRegion(settings) {
  const region = String(settings?.region ?? '');
  if (!AZURE_REGION.test(region)) throw new Error('Invalid Azure Speech region');
  return region;
}

export function providerConfigDescriptor(config, capability) {
  const provider = config?.provider;
  const settings = config?.settings ?? {};
  if (provider === 'azure' && capability === 'asr') {
    const region = azureRegion(settings);
    return {
      provider, capability,
      endpoint: `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK&format=simple`,
      region, language: 'zh-HK', format: 'simple',
      contentType: 'audio/wav; codecs=audio/pcm; samplerate=16000',
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'azure' && capability === 'tts') {
    const region = azureRegion(settings);
    return {
      provider, capability,
      endpoint: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      region, language: 'zh-HK', voice: 'zh-HK-HiuMaanNeural',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'minimax' && capability === 'tts') {
    let url;
    try { url = new URL(String(settings.baseUrl ?? '')); } catch { throw new Error('Invalid MiniMax base URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid MiniMax base URL');
    return {
      provider, capability,
      endpoint: `${url.href.replace(/\/+$/, '')}/v1/t2a_v2`,
      model: settings.model, voice: settings.voice,
      languageBoost: 'Chinese,Yue', sampleRate: 32_000, bitrate: 128_000,
      format: 'mp3', channel: 1,
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'google-stt-v2' && capability === 'asr') {
    if (settings.projectId !== GOOGLE_PROJECT || settings.location !== GOOGLE_SPEECH_LOCATION
      || settings.model !== 'chirp_2' || settings.recognizer !== '_'
      || JSON.stringify(settings.languageCodes) !== JSON.stringify(['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'])) {
      throw new Error('Invalid Google STT V2 configuration');
    }
    return {
      provider, capability,
      endpoint: `https://${settings.location}-speech.googleapis.com/v2/projects/${settings.projectId}/locations/${settings.location}/recognizers/${settings.recognizer}:recognize`,
      projectId: settings.projectId,
      location: settings.location,
      recognizer: settings.recognizer,
      model: settings.model,
      languageCodes: [...settings.languageCodes],
      allowedResponseLanguages: Object.keys(GOOGLE_RESPONSE_LANGUAGE_CODES),
      responseLanguageCodes: { ...GOOGLE_RESPONSE_LANGUAGE_CODES },
      languageOrderPolicy: 'selected-first-then-configured-order-v1',
      contentType: 'application/json',
      inputEncoding: 'canonical-wav-v1',
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'google-tts' && capability === 'tts') {
    const expectedVoices = {
      en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
      yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
      zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
    };
    if (settings.projectId !== GOOGLE_PROJECT || settings.location !== GOOGLE_SPEECH_LOCATION
      || JSON.stringify(settings.voices) !== JSON.stringify(expectedVoices)) {
      throw new Error('Invalid Google TTS configuration');
    }
    return {
      provider, capability,
      endpoint: `https://${settings.location}-texttospeech.googleapis.com/v1/text:synthesize`,
      projectId: settings.projectId,
      location: settings.location,
      voices: expectedVoices,
      audioEncoding: 'MP3',
      outputChannels: 1,
      credentialVersion: settings.credentialVersion ?? null,
      fallbackPolicy: 'none',
    };
  }
  throw new Error('Unsupported speech provider configuration');
}

export function providerConfigDigest(config, capability) {
  return createHash('sha256').update(canonicalJson(providerConfigDescriptor(config, capability))).digest('hex');
}

export function readEvidenceRecord(filePath, dependencies = {}) {
  return readBoundedJsonObjectFile(filePath, {
    ...dependencies,
    maximumBytes: VOICE_EVIDENCE_MAX_BYTES,
  });
}

function artifactValid(record, expectedVersion) {
  if (!record || !DIGEST.test(String(record.artifactSha256 ?? ''))
    || record.artifactSha256 !== expectedVersion) return false;
  return finalizeEvidenceRecord(record).artifactSha256 === record.artifactSha256;
}

function timeValid(record, now, maximumAgeMs) {
  const occurredAt = Date.parse(record?.occurredAt);
  const nowMs = new Date(now).getTime();
  return Number.isFinite(occurredAt) && Number.isFinite(nowMs)
    && occurredAt <= nowMs + FUTURE_SKEW_MS
    && nowMs - occurredAt <= maximumAgeMs;
}

function speechFixtureValid(record, capability) {
  if (capability === 'asr') {
    return DIGEST.test(String(record?.fixtureSha256 ?? ''))
      && Number.isFinite(record?.fixtureDurationMs)
      && record.fixtureDurationMs > 0;
  }
  return capability === 'tts'
    && record?.fixtureSha256 === undefined
    && record?.fixtureDurationMs === undefined;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function speechV2SamplesValid(record, capability, fixtureGeneratorConfigDigest) {
  if (!Array.isArray(record.samples) || record.samples.length !== SPEECH_V2_LANGUAGES.length) return false;
  const observed = new Set();
  for (const sample of record.samples) {
    const definition = SPEECH_V2_DEFINITIONS[sample?.responseLanguage];
    if (!definition || observed.has(sample.responseLanguage)) return false;
    observed.add(sample.responseLanguage);
    if (sample.locale !== definition.locale) return false;
    if (capability === 'tts') {
      if (!hasExactOwnKeys(sample, TTS_V2_SAMPLE_KEYS)
        || sample.voiceName !== definition.voiceName
        || !finiteNonNegative(sample.latencyMs)
        || !DIGEST.test(String(sample.audioSha256 ?? ''))
        || !Number.isSafeInteger(sample.audioByteLength) || sample.audioByteLength <= 4
        || sample.decoder !== 'mpg123-decoder@1.0.3'
        || !Number.isSafeInteger(sample.decodedSampleCount) || sample.decodedSampleCount <= 0
        || !Number.isSafeInteger(sample.decodedSampleRate)
        || sample.decodedSampleRate < 8_000 || sample.decodedSampleRate > 96_000
        || !Number.isSafeInteger(sample.decodedChannelCount)
        || sample.decodedChannelCount < 1 || sample.decodedChannelCount > 2
        || !Number.isFinite(sample.decodedDurationMs) || sample.decodedDurationMs <= 0
        || sample.decodedDurationMs > 60_000
        || Math.abs(sample.decodedDurationMs
          - ((sample.decodedSampleCount / sample.decodedSampleRate) * 1_000)) > 1e-6
        || sample.decodable !== true) return false;
      continue;
    }
    if (!hasExactOwnKeys(sample, ASR_V2_SAMPLE_KEYS)
      || sample.referenceId !== definition.referenceId
      || sample.fixtureOrigin !== 'google-tts-linear16-v1'
      || sample.fixtureVoiceName !== definition.voiceName
      || sample.fixtureGeneratorContractVersion !== 'google-tts-linear16-v1'
      || sample.fixtureGeneratorConfigDigest !== fixtureGeneratorConfigDigest
      || !DIGEST.test(String(sample.fixtureGeneratorConfigDigest ?? ''))
      || !finiteNonNegative(sample.fixtureTtsLatencyMs)
      || !DIGEST.test(String(sample.fixtureSha256 ?? ''))
      || !Number.isFinite(sample.fixtureDurationMs) || sample.fixtureDurationMs <= 0 || sample.fixtureDurationMs > 60_000
      || !Number.isSafeInteger(sample.fixtureByteLength) || sample.fixtureByteLength <= 44
      || !Number.isSafeInteger(sample.transcriptUtf8Bytes) || sample.transcriptUtf8Bytes <= 0
      || !Number.isSafeInteger(sample.transcriptCodePointCount) || sample.transcriptCodePointCount <= 0
      || !Number.isSafeInteger(sample.normalizedReferenceCodePointCount) || sample.normalizedReferenceCodePointCount <= 0
      || !Number.isSafeInteger(sample.normalizedEditDistance) || sample.normalizedEditDistance < 0
      || !finiteNonNegative(sample.normalizedErrorRate) || sample.normalizedErrorRate > 0.35
      || Math.abs(sample.normalizedErrorRate
        - Number((sample.normalizedEditDistance / sample.normalizedReferenceCodePointCount).toFixed(6))) > 1e-6
      || !finiteNonNegative(sample.asrLatencyMs)) return false;
  }
  return SPEECH_V2_LANGUAGES.every((language) => observed.has(language));
}

export function validateSpeechEvidence(record, {
  expectedVersion, commitSha, capability, provider, contractVersion,
  configDigest, runtimeIdentity, fixtureGeneratorConfigDigest, now,
}) {
  if (record?.schemaVersion === 2) {
    const expectedProvider = capability === 'asr' ? 'google-stt-v2' : 'google-tts';
    return Boolean(
      hasExactOwnKeys(record, SPEECH_V2_KEYS)
      && provider === expectedProvider
      && record.provider === expectedProvider
      && /^[0-9a-f]{40}$/.test(String(commitSha ?? ''))
      && artifactValid(record, expectedVersion)
      && record.commitSha === commitSha
      && record.capability === capability
      && record.contractVersion === contractVersion
      && record.providerConfigDigest === configDigest
      && DIGEST.test(String(configDigest ?? ''))
      && typeof runtimeIdentity === 'string' && runtimeIdentity.length > 0
      && record.runtimeIdentity === runtimeIdentity
      && record.result === 'pass'
      && speechV2SamplesValid(record, capability, fixtureGeneratorConfigDigest)
      && timeValid(record, now, 30 * DAY_MS)
    );
  }
  const allowedProviders = capability === 'asr'
    ? new Set(['azure', 'google-stt-v2'])
    : new Set(['azure', 'minimax', 'google-tts']);
  const expectedKeys = capability === 'asr'
    ? [...SPEECH_EVIDENCE_KEYS, ...ASR_FIXTURE_KEYS]
    : SPEECH_EVIDENCE_KEYS;
  return Boolean(
    hasExactOwnKeys(record, expectedKeys)
    && allowedProviders.has(provider)
    && RELEASE_SHA.test(String(commitSha ?? ''))
    && artifactValid(record, expectedVersion)
    && record.schemaVersion === 1
    && record.commitSha === commitSha
    && record.capability === capability
    && record.provider === provider
    && record.contractVersion === contractVersion
    && record.providerConfigDigest === configDigest
    && record.result === 'pass'
    && Number.isFinite(record.latencyMs) && record.latencyMs >= 0
    && speechFixtureValid(record, capability)
    && timeValid(record, now, 30 * DAY_MS),
  );
}

export function validateIosVoiceEvidence(record, {
  expectedVersion, commitSha, normalizerContractVersion, now,
}) {
  return Boolean(
    hasExactOwnKeys(record, IOS_V4_EVIDENCE_KEYS)
    && RELEASE_SHA.test(String(commitSha ?? ''))
    && artifactValid(record, expectedVersion)
    && record.schemaVersion === iosVoiceEvidenceContract.schemaVersion
    && record.commitSha === commitSha
    && record.capability === 'ios-voice'
    && record.normalizerContractVersion === normalizerContractVersion
    && record.reportSource === iosVoiceEvidenceContract.reportSource
    && DIGEST.test(String(record.deviceReportSha256 ?? ''))
    && Number.isSafeInteger(record.deviceReportByteLength)
    && record.deviceReportByteLength > 0 && record.deviceReportByteLength <= 64 * 1_024
    && UUID.test(String(record.deviceRunId ?? ''))
    && /^iPhone\d{1,2},\d{1,2}$/.test(String(record.deviceModelIdentifier ?? ''))
    && /^\d+(?:\.\d+){1,2}$/.test(String(record.iosVersion ?? ''))
    && /^\d+(?:\.\d+){1,2}$/.test(String(record.safariVersion ?? ''))
    && record.captureMimeType === 'audio/mp4'
    && record.rawCaptureFormat === iosVoiceEvidenceContract.rawCaptureFormat
    && DIGEST.test(String(record.rawCaptureSha256 ?? ''))
    && Number.isSafeInteger(record.rawCaptureByteLength)
    && record.rawCaptureByteLength > 32 && record.rawCaptureByteLength <= 64 * 1_024 * 1_024
    && DIGEST.test(String(record.fixtureSha256 ?? ''))
    && Number.isFinite(record.fixtureDurationMs)
    && record.fixtureDurationMs > 0 && record.fixtureDurationMs <= 55_500
    && Number.isSafeInteger(record.fixtureByteLength)
    && record.fixtureByteLength > 44 && record.fixtureByteLength <= 2 * 1_024 * 1_024
    && DIGEST.test(String(record.normalizationStepsSha256 ?? ''))
    && Number.isSafeInteger(record.normalizationStepsByteLength)
    && record.normalizationStepsByteLength > 0 && record.normalizationStepsByteLength <= 64 * 1_024
    && record.normalizerPackage === iosVoiceEvidenceContract.normalizer.package
    && Object.hasOwn(iosVoiceEvidenceContract.normalizer.platforms, record.normalizerPlatform)
    && record.normalizerBinarySha256
      === iosVoiceEvidenceContract.normalizer.platforms[record.normalizerPlatform]?.binarySha256
    && record.normalizerVersion
      === iosVoiceEvidenceContract.normalizer.platforms[record.normalizerPlatform]?.version
    && JSON.stringify(record.normalizerArguments)
      === JSON.stringify(iosVoiceEvidenceContract.normalizer.arguments)
    && record.normalizerExitCode === 0
    && DIGEST.test(String(record.normalizationBindingSha256 ?? ''))
    && record.normalizationBindingSha256 === iosVoiceNormalizationBinding(record)
    && JSON.stringify(record.verifiedStepIds) === JSON.stringify(iosVoiceEvidenceContract.stepIds)
    && record.result === 'pass'
    && timeValid(record, now, 90 * DAY_MS)
    && timeValid({ occurredAt: record.deviceObservedAt }, now, 90 * DAY_MS),
  );
}

export const iosTestflightVoiceEvidenceContract = Object.freeze({
  schemaVersion: 1,
  capability: 'ios-testflight-voice',
  reportSource: 'real-iphone-testflight-manual-v1',
  normalizerSources: Object.freeze(['web-audio', 'native-wav-v1']),
  keys: Object.freeze([
    'schemaVersion', 'commitSha', 'capability', 'bundleId', 'cfBundleVersion',
    'normalizerContractVersion', 'normalizerSource', 'reportSource',
    'deviceRunId', 'deviceModelIdentifier', 'iosVersion', 'occurredAt',
    'result', 'artifactSha256',
  ]),
});

export function validateIosTestflightVoiceEvidence(record, {
  expectedVersion, commitSha, normalizerContractVersion, now,
}) {
  return Boolean(
    hasExactOwnKeys(record, iosTestflightVoiceEvidenceContract.keys)
    && RELEASE_SHA.test(String(commitSha ?? ''))
    && artifactValid(record, expectedVersion)
    && record.schemaVersion === iosTestflightVoiceEvidenceContract.schemaVersion
    && record.commitSha === commitSha
    && record.capability === iosTestflightVoiceEvidenceContract.capability
    && record.bundleId === 'com.simplify.hongkongbuddy'
    && typeof record.cfBundleVersion === 'string'
    && record.cfBundleVersion.length > 0
    && record.normalizerContractVersion === normalizerContractVersion
    && iosTestflightVoiceEvidenceContract.normalizerSources.includes(record.normalizerSource)
    && record.reportSource === iosTestflightVoiceEvidenceContract.reportSource
    && UUID.test(String(record.deviceRunId ?? ''))
    && /^iPhone\d{1,2},\d{1,2}$/.test(String(record.deviceModelIdentifier ?? ''))
    && /^\d+(?:\.\d+){1,2}$/.test(String(record.iosVersion ?? ''))
    && record.result === 'pass'
    && timeValid(record, now, 90 * DAY_MS),
  );
}

export const voiceEvidenceContracts = Object.freeze({
  asr: 'azure-asr-v1',
  googleAsr: 'google-stt-v2-v2',
  azureTts: 'azure-tts-v1',
  minimaxTts: 'minimax-tts-v1',
  googleTts: 'google-tts-v3',
  googleFixtureGenerator: 'google-tts-linear16-v1',
  speechMaximumAgeMs: 30 * DAY_MS,
  iosMaximumAgeMs: 90 * DAY_MS,
  futureSkewMs: FUTURE_SKEW_MS,
});
