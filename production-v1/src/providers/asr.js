import {
  SPEECH_LIMITS,
  SpeechProviderError,
  logSpeech,
  readBoundedResponse,
  responseContentType,
  speechError,
  withSpeechDeadline,
} from './speech-common.js';
import { GCP_IDENTITY } from '../gcp-identity.js';
import { createGoogleAccessTokenProvider } from './google-auth.js';
import { CANONICAL_WAV } from '../media/canonical-wav.js';

const AZURE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_MATCH = new Set(['NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout']);
const GOOGLE_RESPONSE_LANGUAGES = Object.freeze({
  en: 'en-US',
  'yue-Hant-HK': 'yue-Hant-HK',
  'cmn-Hans-CN': 'cmn-Hans-CN',
});
const GOOGLE_CHUNK_PCM_BYTES = 10 * CANONICAL_WAV.byteRate;

function canonicalPcmBytes(buffer) {
  if (buffer.length < CANONICAL_WAV.headerBytes
    || buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
    || buffer.subarray(8, 12).toString('ascii') !== 'WAVE'
    || buffer.subarray(12, 16).toString('ascii') !== 'fmt '
    || buffer.subarray(36, 40).toString('ascii') !== 'data') return null;
  const pcmBytes = buffer.readUInt32LE(40);
  return buffer.readUInt32LE(4) === buffer.length - 8
    && buffer.readUInt32LE(16) === 16
    && buffer.readUInt16LE(20) === CANONICAL_WAV.format
    && buffer.readUInt16LE(22) === CANONICAL_WAV.channels
    && buffer.readUInt32LE(24) === CANONICAL_WAV.sampleRate
    && buffer.readUInt32LE(28) === CANONICAL_WAV.byteRate
    && buffer.readUInt16LE(32) === CANONICAL_WAV.blockAlign
    && buffer.readUInt16LE(34) === CANONICAL_WAV.bitsPerSample
    && pcmBytes > 0
    && pcmBytes % CANONICAL_WAV.blockAlign === 0
    && CANONICAL_WAV.headerBytes + pcmBytes === buffer.length
    ? pcmBytes
    : null;
}

function canonicalWavChunk(buffer, pcmOffset, pcmBytes) {
  const chunk = Buffer.allocUnsafe(CANONICAL_WAV.headerBytes + pcmBytes);
  buffer.copy(chunk, 0, 0, CANONICAL_WAV.headerBytes);
  chunk.writeUInt32LE(chunk.length - 8, 4);
  chunk.writeUInt32LE(pcmBytes, 40);
  buffer.copy(
    chunk,
    CANONICAL_WAV.headerBytes,
    CANONICAL_WAV.headerBytes + pcmOffset,
    CANONICAL_WAV.headerBytes + pcmOffset + pcmBytes,
  );
  return chunk;
}

function googleAudioChunks(buffer) {
  const pcmBytes = canonicalPcmBytes(buffer);
  if (pcmBytes === null || pcmBytes <= GOOGLE_CHUNK_PCM_BYTES) return [buffer];
  const chunks = [];
  for (let offset = 0; offset < pcmBytes; offset += GOOGLE_CHUNK_PCM_BYTES) {
    chunks.push(canonicalWavChunk(buffer, offset, Math.min(GOOGLE_CHUNK_PCM_BYTES, pcmBytes - offset)));
  }
  return chunks;
}

function combineGoogleResults(results) {
  const recognizedResults = results.filter(Boolean);
  if (recognizedResults.length === 0) throw speechError('VOICE_SPEECH_NOT_RECOGNIZED', 422, false, 'no_match');
  if (recognizedResults.length === 1) return recognizedResults[0];
  const confidences = recognizedResults.map(({ confidence }) => confidence).filter(Number.isFinite);
  return {
    transcript: recognizedResults.map(({ transcript }) => transcript).join(' ').trim(),
    confidence: confidences.length > 0
      ? confidences.reduce((total, confidence) => total + confidence, 0) / confidences.length
      : null,
  };
}

function azureAsrUrl(region) {
  if (!AZURE_REGION.test(String(region ?? ''))) throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  return `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK&format=simple`;
}

function statusError(status) {
  if (status === 401 || status === 403) return speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'authentication');
  if (status === 408 || status === 429 || status >= 500) return speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'transient');
  return speechError('VOICE_TRANSCRIPTION_REJECTED', 502, false, 'rejected');
}

function parseAzurePayload(buffer) {
  let payload;
  try { payload = JSON.parse(buffer.toString('utf8')); } catch { throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (payload.RecognitionStatus !== 'Success') {
    if (NO_MATCH.has(payload.RecognitionStatus)) {
      throw speechError('VOICE_SPEECH_NOT_RECOGNIZED', 422, false, 'not_recognized');
    }
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (typeof payload.DisplayText !== 'string' || !payload.DisplayText.trim()) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  return {
    transcript: payload.DisplayText.trim(),
    confidence: Number.isFinite(payload.Confidence) ? Number(payload.Confidence) : null,
  };
}

function googleAsrUrl(settings) {
  if (settings?.projectId !== GCP_IDENTITY.projectId
    || settings.location !== GCP_IDENTITY.speechRegion || settings.model !== 'chirp_2'
    || settings.recognizer !== '_'
    || JSON.stringify(settings.languageCodes) !== JSON.stringify(['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'])) {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  return `https://${settings.location}-speech.googleapis.com/v2/projects/${settings.projectId}/locations/${settings.location}/recognizers/${settings.recognizer}:recognize`;
}

function googleLanguageCodes(responseLanguage) {
  const selected = GOOGLE_RESPONSE_LANGUAGES[responseLanguage];
  if (!selected) throw speechError('VOICE_TRANSCRIPTION_REJECTED', 502, false, 'rejected');
  return [selected];
}

function parseGooglePayload(buffer) {
  let payload;
  try { payload = JSON.parse(buffer.toString('utf8')); } catch {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.results)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  const alternatives = payload.results
    .map((result) => result?.alternatives?.[0])
    .filter((alternative) => typeof alternative?.transcript === 'string' && alternative.transcript.trim());
  const transcript = alternatives.map((alternative) => alternative.transcript.trim()).join(' ').trim();
  if (!transcript) throw speechError('VOICE_SPEECH_NOT_RECOGNIZED', 422, false, 'not_recognized');
  return {
    transcript,
    confidence: Number.isFinite(alternatives[0]?.confidence) ? Number(alternatives[0].confidence) : null,
  };
}

export function createAsrProvider({
  config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger,
  totalDeadlineMs = SPEECH_LIMITS.deadlineMs,
  googleAuthProvider: suppliedGoogleAuthProvider,
} = {}) {
  if (!['azure', 'google-stt-v2'].includes(config?.provider) || typeof fetchImpl !== 'function') {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const google = config.provider === 'google-stt-v2';
  if (!google && (!config.settings?.apiKey || !config.settings?.region)) {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const url = google ? googleAsrUrl(config.settings) : azureAsrUrl(config.settings.region);
  const googleAuthProvider = google
    ? suppliedGoogleAuthProvider ?? createGoogleAccessTokenProvider({ fetchImpl })
    : null;
  if (google && typeof googleAuthProvider?.fetch !== 'function') {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const transcribe = async (audio, { signal, responseLanguage = 'yue-Hant-HK' } = {}) => {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio ?? []);
    if (!google && responseLanguage !== 'yue-Hant-HK') {
      throw speechError('VOICE_TRANSCRIPTION_REJECTED', 502, false, 'rejected');
    }
    const googleLanguages = google ? googleLanguageCodes(responseLanguage) : null;
    const startedAt = now();
    try {
      const result = await withSpeechDeadline({
        signal,
        deadlineMs: totalDeadlineMs,
        operation: async (deadlineSignal) => {
          const recognize = async (requestBuffer) => {
            let response;
            try {
              const requestBody = google ? JSON.stringify({
                config: {
                  autoDecodingConfig: {},
                  model: config.settings.model,
                  languageCodes: googleLanguages,
                },
                content: requestBuffer.toString('base64'),
              }) : requestBuffer;
              const providerFetch = googleAuthProvider?.fetch ?? fetchImpl;
              response = await providerFetch(url, {
                method: 'POST',
                headers: google ? {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                } : {
                  'Ocp-Apim-Subscription-Key': config.settings.apiKey,
                  'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
                  Accept: 'application/json',
                },
                body: requestBody,
                signal: deadlineSignal,
                redirect: 'error',
              });
            } catch (error) {
              if (deadlineSignal.aborted) throw error;
              if (error?.code === 'GOOGLE_AUTHENTICATION_FAILED') {
                throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'authentication');
              }
              throw speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'network');
            }
            const body = await readBoundedResponse(response, SPEECH_LIMITS.asrResponseBytes, deadlineSignal);
            if (!response.ok) throw statusError(response.status);
            if (responseContentType(response) !== 'application/json') {
              throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
            }
            return google ? parseGooglePayload(body) : parseAzurePayload(body);
          };
          if (!google) return recognize(buffer);
          const chunks = googleAudioChunks(buffer);
          if (chunks.length === 1) return recognize(buffer);
          const results = await Promise.all(chunks.map(async (chunk) => {
            try {
              return await recognize(chunk);
            } catch (error) {
              if (error instanceof SpeechProviderError && error.code === 'VOICE_SPEECH_NOT_RECOGNIZED') return null;
              throw error;
            }
          }));
          return combineGoogleResults(results);
        },
      });
      const normalized = { ...result, provider: config.provider, latencyMs: Math.max(0, now() - startedAt) };
      logSpeech(logger, { stage: 'asr', provider: config.provider, statusClass: '2xx', latencyMs: normalized.latencyMs, byteCount: buffer.length });
      return normalized;
    } catch (error) {
      const normalized = error instanceof SpeechProviderError
        ? error
        : speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'network');
      logSpeech(logger, { stage: 'asr', provider: config.provider, statusClass: normalized.httpStatus ? `${Math.floor(normalized.httpStatus / 100)}xx` : null, latencyMs: Math.max(0, now() - startedAt), byteCount: buffer.length, errorCode: normalized.code });
      throw normalized;
    }
  };
  return { provider: config.provider, transcribe };
}

export const speechProviderLimits = SPEECH_LIMITS;
