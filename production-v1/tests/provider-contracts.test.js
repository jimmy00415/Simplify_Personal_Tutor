import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { createAsrProvider } from '../src/providers/asr.js';
import { createLlmProvider, ProviderError, providerLimits } from '../src/providers/llm.js';
import { createTtsProvider } from '../src/providers/tts.js';
import {
  runProviderSmoke,
  writeLlmSmokeEvidence,
} from '../scripts/provider-smoke.js';
import {
  finalizeReleaseEvidenceRecord,
  llmProviderConfigDigest,
  validateLlmSmokeEvidence,
} from '../src/services/release-evidence.js';

const SMOKE_COMMIT = 'a'.repeat(40);
const SMOKE_NOW = new Date('2026-08-25T12:00:00.000Z');

function canonicalWavFixture(durationSeconds) {
  const pcmBytes = durationSeconds * 32_000;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcmBytes, 40);
  for (let offset = 44; offset < wav.length; offset += 1) wav[offset] = (offset - 44) % 251;
  return wav;
}

const TURN_INPUT = Object.freeze({
  turnId: 'turn-123',
  systemPrompt: 'Return one strict JSON object.',
  responseLanguage: 'en',
  messages: [{ role: 'user', content: 'Where is the Duo guide?' }],
  evidenceSnapshot: [{ id: 'evidence.ito.duo.new-phone', text: 'Use the official Duo self-service path.' }],
  actionSnapshot: [{ id: 'action.ito.duo.open', label: { en: 'Open Duo guidance' }, sourceId: 'hkbu.ito.duo' }],
  maxOutputTokens: 180,
});

function openAiSuccess(rawText = '{"replyText":"ok"}', finishReason = 'stop') {
  return new Response(JSON.stringify({
    id: 'request-1',
    choices: [{ message: { content: rawText }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'header-request-1' } });
}

function miniMaxSuccess(rawText = '{"replyText":"ok"}', stopReason = 'end_turn') {
  return new Response(JSON.stringify({
    id: 'minimax-request-1',
    content: [{ type: 'thinking', thinking: 'not transport output' }, { type: 'text', text: rawText }],
    stop_reason: stopReason,
    usage: { input_tokens: 11, output_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function vertexSuccess(rawText = '{"replyText":"ok"}', finishReason = 'STOP') {
  return new Response(JSON.stringify({
    responseId: 'request-1',
    candidates: [{ content: { parts: [{ text: rawText }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
  }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'header-request-1' } });
}

function createSmokeProvider(options) {
  return createLlmProvider({
    ...options,
    googleAuthProvider: { fetch: options.fetchImpl },
  });
}

test('Google auth adapter caches bounded ADC tokens and sanitizes authentication failures', async () => {
  const authModule = await import('../src/providers/google-auth.js').catch(() => ({}));
  assert.equal(typeof authModule.createGoogleAccessTokenProvider, 'function');
  const calls = { tokens: 0, fetches: [] };
  let now = 1_000;
  const provider = authModule.createGoogleAccessTokenProvider({
    auth: {
      async getAccessToken() {
        calls.tokens += 1;
        return { token: 'private-access-token', res: { data: { expiry_date: now + 120_000 } } };
      },
    },
    now: () => now,
    fetchImpl: async (url, init) => {
      calls.fetches.push({ url, init });
      return new Response('{}', { status: 200 });
    },
  });
  await provider.fetch('https://googleapis.test/v1', { headers: { 'content-type': 'application/json' } });
  now += 1_000;
  await provider.fetch('https://googleapis.test/v1', { headers: { accept: 'application/json' } });
  assert.equal(calls.tokens, 1);
  assert.equal(calls.fetches[0].init.headers.Authorization, 'Bearer private-access-token');
  assert.deepEqual(Object.keys(provider), ['fetch']);

  const failing = authModule.createGoogleAccessTokenProvider({
    auth: { getAccessToken: async () => { throw new Error('upstream body private-access-token'); } },
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  await assert.rejects(failing.fetch('https://googleapis.test/v1'), (error) => {
    assert.equal(error.code, 'GOOGLE_AUTHENTICATION_FAILED');
    assert.equal(String(error).includes('private-access-token'), false);
    assert.equal(String(error).includes('upstream body'), false);
    return true;
  });
});

test('Google auth rejects an already-aborted request before token acquisition', async () => {
  const { createGoogleAccessTokenProvider } = await import('../src/providers/google-auth.js');
  let tokenCalls = 0;
  let fetchCalls = 0;
  const provider = createGoogleAccessTokenProvider({
    auth: { getAccessToken: async () => { tokenCalls += 1; return 'private-access-token'; } },
    fetchImpl: async () => { fetchCalls += 1; return new Response('{}'); },
  });
  const controller = new AbortController();
  controller.abort(new Error('private abort reason'));

  await assert.rejects(
    provider.fetch('https://googleapis.test/v1', { signal: controller.signal }),
    (error) => error.code === 'GOOGLE_AUTHENTICATION_FAILED'
      && !String(error).includes('private abort reason'),
  );
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('Google auth settles a hanging token acquisition when the request deadline aborts', async () => {
  const { createGoogleAccessTokenProvider } = await import('../src/providers/google-auth.js');
  let started;
  const tokenStarted = new Promise((resolve) => { started = resolve; });
  let fetchCalls = 0;
  const provider = createGoogleAccessTokenProvider({
    auth: { getAccessToken: async () => { started(); return new Promise(() => {}); } },
    fetchImpl: async () => { fetchCalls += 1; return new Response('{}'); },
  });
  const controller = new AbortController();
  const pending = provider.fetch('https://googleapis.test/v1', { signal: controller.signal });
  await tokenStarted;
  controller.abort(new Error('private deadline reason'));
  const result = await Promise.race([
    pending.catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('DID_NOT_SETTLE'), 100)),
  ]);

  assert.notEqual(result, 'DID_NOT_SETTLE');
  assert.equal(result.code, 'GOOGLE_AUTHENTICATION_FAILED');
  assert.equal(String(result).includes('private deadline reason'), false);
  assert.equal(fetchCalls, 0);
});

test('Vertex AI uses ADC generateContent and normalizes candidate text without exposing provider bodies', async () => {
  let request;
  const provider = createLlmProvider({
    config: {
      provider: 'vertex-ai', timeoutMs: 12_000,
      settings: { projectId: 'motion-expert-hk-ltd-webpage', location: 'global', model: 'gemini-2.5-flash' },
    },
    googleAuthProvider: {
      fetch: async (url, init) => {
        request = { url, init };
        return new Response(JSON.stringify({
          responseId: 'vertex-request-1',
          candidates: [{ content: { role: 'model', parts: [{ text: '{"replyText":"ok"}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  });
  const result = await provider.generate(TURN_INPUT);
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, 'https://aiplatform.googleapis.com/v1/projects/motion-expert-hk-ltd-webpage/locations/global/publishers/google/models/gemini-2.5-flash:generateContent');
  assert.deepEqual(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(Object.hasOwn(body.generationConfig, 'thinkingConfig'), false);
  assert.match(body.systemInstruction.parts[0].text, /one strict JSON object/i);
  assert.match(body.contents.at(-1).parts[0].text, /untrusted_reference_data/);
  assert.deepEqual(result, {
    rawText: '{"replyText":"ok"}', provider: 'vertex-ai', latencyMs: result.latencyMs,
    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
    finishReason: 'stop', providerRequestId: 'vertex-request-1',
  });
});

test('Google STT V2 and TTS issue locale-bound ADC requests with no hidden fallback', async () => {
  const requests = [];
  const auth = {
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.includes(':recognize')) {
        return new Response(JSON.stringify({ results: [{ alternatives: [{ transcript: '你好', confidence: 0.93 }] }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ audioContent: Buffer.from('ID3fixture').toString('base64') }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  };
  const asr = createAsrProvider({
    config: { provider: 'google-stt-v2', settings: {
      projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1', model: 'chirp_2', recognizer: '_',
      languageCodes: ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'], credentialVersion: 'runtime-sa-rotation-v1',
    } },
    googleAuthProvider: auth,
  });
  const asrResult = await asr.transcribe(Buffer.from('RIFFcanonical-wav'), { responseLanguage: 'en' });
  const asrBody = JSON.parse(requests[0].init.body);
  assert.match(requests[0].url, /asia-southeast1-speech\.googleapis\.com\/v2\/projects\/motion-expert-hk-ltd-webpage\/locations\/asia-southeast1\/recognizers\/_:recognize$/);
  assert.deepEqual(asrBody.config.languageCodes, ['en-US']);
  assert.equal(asrBody.config.model, 'chirp_2');
  assert.equal(asrResult.transcript, '你好');
  await asr.transcribe(Buffer.from('RIFFcanonical-wav'), { responseLanguage: 'yue-Hant-HK' });
  await asr.transcribe(Buffer.from('RIFFcanonical-wav'), { responseLanguage: 'cmn-Hans-CN' });
  assert.deepEqual(JSON.parse(requests[1].init.body).config.languageCodes, ['yue-Hant-HK']);
  assert.deepEqual(JSON.parse(requests[2].init.body).config.languageCodes, ['cmn-Hans-CN']);

  const tts = createTtsProvider({
    config: { provider: 'google-tts', settings: {
      projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1', credentialVersion: 'runtime-sa-rotation-v1',
      voices: {
        en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
        yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
        zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
      },
    } },
    googleAuthProvider: auth,
  });
  const ttsResult = await tts.synthesize('Hello', { responseLanguage: 'en' });
  const ttsBody = JSON.parse(requests[3].init.body);
  assert.equal(requests[3].url, 'https://asia-southeast1-texttospeech.googleapis.com/v1/text:synthesize');
  assert.deepEqual(ttsBody.voice, { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' });
  assert.deepEqual(ttsBody.audioConfig, { audioEncoding: 'MP3' });
  assert.equal(ttsResult.buffer.toString('ascii'), 'ID3fixture');
  await assert.rejects(tts.synthesize('未知', { responseLanguage: 'fr' }), (error) => error.code === 'VOICE_SYNTHESIS_REJECTED');
  assert.equal(requests.length, 4);
});

test('Google STT rejects unsupported response locales before ADC transport', async () => {
  let requests = 0;
  const asr = createAsrProvider({
    config: { provider: 'google-stt-v2', settings: {
      projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1', model: 'chirp_2', recognizer: '_',
      languageCodes: ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'], credentialVersion: 'runtime-sa-rotation-v1',
    } },
    googleAuthProvider: { fetch: async () => { requests += 1; return new Response('{}'); } },
  });

  await assert.rejects(
    asr.transcribe(Buffer.from('RIFFcanonical-wav'), { responseLanguage: 'fr' }),
    (error) => error.code === 'VOICE_TRANSCRIPTION_REJECTED' && error.retryable === false,
  );
  assert.equal(requests, 0);
});

test('Google STT V2 recognizes long canonical WAV chunks concurrently and preserves transcript order', async () => {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const asr = createAsrProvider({
    config: { provider: 'google-stt-v2', settings: {
      projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1', model: 'chirp_2', recognizer: '_',
      languageCodes: ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'], credentialVersion: 'runtime-sa-rotation-v1',
    } },
    googleAuthProvider: {
      fetch: async (url, init) => {
        const index = requests.length + 1;
        requests.push({ url, init });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(JSON.stringify({
          results: [{ alternatives: [{ transcript: `part-${index}`, confidence: 0.9 }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  });

  const original = canonicalWavFixture(30);
  const result = await asr.transcribe(original, { responseLanguage: 'en' });

  assert.equal(requests.length, 3);
  assert.equal(maxInFlight, 3);
  const chunks = requests.map(({ init }) => Buffer.from(JSON.parse(init.body).content, 'base64'));
  assert.equal(chunks.every((chunk) => chunk.subarray(0, 4).toString('ascii') === 'RIFF'), true);
  assert.equal(chunks.every((chunk) => chunk.readUInt32LE(40) <= 10 * 32_000), true);
  assert.equal(chunks.reduce((total, chunk) => total + chunk.readUInt32LE(40), 0), 30 * 32_000);
  assert.equal(Buffer.concat(chunks.map((chunk) => chunk.subarray(44))).equals(original.subarray(44)), true);
  assert.equal(result.transcript, 'part-1 part-2 part-3');
});

test('Google STT V2 ignores silent long-audio chunks but still rejects wholly unrecognized speech', async () => {
  const config = { provider: 'google-stt-v2', settings: {
    projectId: 'motion-expert-hk-ltd-webpage', location: 'asia-southeast1', model: 'chirp_2', recognizer: '_',
    languageCodes: ['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'], credentialVersion: 'runtime-sa-rotation-v1',
  } };
  let requests = 0;
  const partlySilent = createAsrProvider({
    config,
    googleAuthProvider: {
      fetch: async () => {
        requests += 1;
        const results = requests === 2 ? [] : [{ alternatives: [{ transcript: `spoken-${requests}` }] }];
        return new Response(JSON.stringify({ results }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  const partial = await partlySilent.transcribe(canonicalWavFixture(30), { responseLanguage: 'en' });
  assert.equal(partial.transcript, 'spoken-1 spoken-3');

  const whollySilent = createAsrProvider({
    config,
    googleAuthProvider: { fetch: async () => new Response(JSON.stringify({ results: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) },
  });
  await assert.rejects(
    whollySilent.transcribe(canonicalWavFixture(30), { responseLanguage: 'en' }),
    (error) => error.code === 'VOICE_SPEECH_NOT_RECOGNIZED',
  );
});

test('legacy Cantonese-only TTS adapters reject English and Mandarin before provider transport', async () => {
  const configurations = [
    { provider: 'azure', settings: { apiKey: 'azure-key', region: 'eastasia' } },
    {
      provider: 'minimax',
      settings: {
        apiKey: 'minimax-key', baseUrl: 'https://minimax.test', model: 'speech-02-hd', voice: 'Cantonese_KindWoman',
      },
    },
  ];
  for (const config of configurations) {
    let requests = 0;
    const provider = createTtsProvider({
      config,
      fetchImpl: async () => {
        requests += 1;
        throw new Error('provider transport must not run');
      },
    });
    for (const responseLanguage of ['en', 'cmn-Hans-CN']) {
      await assert.rejects(
        provider.synthesize('Immutable server text', { responseLanguage }),
        (error) => error.code === 'VOICE_SYNTHESIS_REJECTED' && error.retryable === false,
      );
    }
    assert.equal(requests, 0, config.provider);
  }
});

function smokeEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    V1_RELEASE_COMMIT_SHA: SMOKE_COMMIT,
    V1_RUNTIME_SERVICE_ACCOUNT: 'hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com',
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_LLM_CREDENTIAL_VERSION: 'runtime-sa-rotation-v1',
    V1_GOOGLE_CLOUD_PROJECT: 'motion-expert-hk-ltd-webpage',
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    ...overrides,
  };
}

function cleanFrozenGit() {
  return async () => ({ commitSha: SMOKE_COMMIT, clean: true });
}

test('provider contract builds HKBU compatibility and Azure OpenAI deployment requests without key leakage', async () => {
  const cases = [
    {
      name: 'hkbu',
      settings: { apiKey: 'hkbu-secret-key', baseUrl: 'https://genai.test/api/v0/rest/', model: 'gpt-4o-mini', apiVersion: '2024-10-21' },
      expectedUrl: 'https://genai.test/api/v0/rest/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21',
      expectedHeader: ['api-key', 'hkbu-secret-key'],
      bodyCheck(body) { assert.equal(body.max_tokens, 180); assert.equal(body.temperature, 1); },
    },
    {
      name: 'azure-openai',
      settings: { apiKey: 'azure-secret-key', endpoint: 'https://azure.test/', deployment: 'gpt-5-mini', apiVersion: '2024-10-21', requestProfile: 'reasoning' },
      expectedUrl: 'https://azure.test/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-10-21',
      expectedHeader: ['api-key', 'azure-secret-key'],
      bodyCheck(body) { assert.equal(body.max_completion_tokens, 1600); assert.equal('temperature' in body, false); },
    },
  ];

  for (const item of cases) {
    let request;
    const provider = createLlmProvider({
      config: { provider: item.name, settings: item.settings },
      fetchImpl: async (url, init) => { request = { url, init }; return openAiSuccess(); },
    });
    const result = await provider.generate(TURN_INPUT);
    const body = JSON.parse(request.init.body);
    assert.equal(request.url, item.expectedUrl);
    assert.equal(request.init.headers[item.expectedHeader[0]], item.expectedHeader[1]);
    assert.equal(request.init.headers['Content-Type'], 'application/json');
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(JSON.stringify(body), /untrusted_reference_data/);
    assert.equal(JSON.stringify(body).includes(item.expectedHeader[1]), false);
    item.bodyCheck(body);
    assert.deepEqual(Object.keys(result).sort(), ['finishReason', 'latencyMs', 'provider', 'providerRequestId', 'rawText', 'usage'].sort());
    assert.equal(result.provider, item.name);
    assert.equal(result.rawText, '{"replyText":"ok"}');
  }
});

test('provider contract uses the selected MiniMax Anthropic X-Api-Key contract and text blocks only', async () => {
  let request;
  const provider = createLlmProvider({
    config: {
      provider: 'minimax',
      settings: { apiKey: 'minimax-secret-key', anthropicBaseUrl: 'https://minimax.test/anthropic/', model: 'MiniMax-M2.1' },
    },
    fetchImpl: async (url, init) => { request = { url, init }; return miniMaxSuccess(); },
  });
  const result = await provider.generate(TURN_INPUT);
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, 'https://minimax.test/anthropic/v1/messages');
  assert.equal(request.init.headers['X-Api-Key'], 'minimax-secret-key');
  assert.equal(request.init.headers.Authorization, undefined);
  assert.match(body.system, /^Return one strict JSON object\./);
  assert.match(body.system, /responseLanguage=en/);
  assert.match(body.system, /English/);
  assert.equal(body.messages.some((message) => message.role === 'system'), false);
  assert.match(body.messages.at(-1).content, /untrusted_reference_data/);
  assert.match(body.messages.at(-1).content, /action\.ito\.duo\.open/);
  assert.match(body.messages.at(-1).content, /Open Duo guidance/);
  assert.equal(result.rawText, '{"replyText":"ok"}');
  assert.equal(result.finishReason, 'end_turn');
});

test('provider binds the trusted server-selected response language instead of inferring from the final reference message', async () => {
  let requestBody;
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    fetchImpl: async (url, init) => { requestBody = JSON.parse(init.body); return openAiSuccess(); },
  });

  await provider.generate({
    ...TURN_INPUT,
    responseLanguage: 'cmn-Hans-CN',
    messages: [{ role: 'user', content: 'English-looking latest student message' }],
  });

  const system = requestBody.messages[0].content;
  assert.match(system, /responseLanguage=cmn-Hans-CN/);
  assert.match(system, /Simplified Chinese/);
  assert.match(system, /do not infer.*reference data/i);
  assert.equal(requestBody.messages.at(-2).content, 'English-looking latest student message');
  assert.match(requestBody.messages.at(-1).content, /untrusted_reference_data/);
});

test('provider contract requires HTTPS before fetch and refuses redirects without forwarding credentials', async () => {
  const insecure = [
    { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'http://hkbu.test', model: 'model', apiVersion: 'v1' } },
    { provider: 'azure-openai', settings: { apiKey: 'key', endpoint: 'http://azure.test', deployment: 'neutral', apiVersion: 'v1', requestProfile: 'standard' } },
    { provider: 'minimax', settings: { apiKey: 'key', anthropicBaseUrl: 'http://minimax.test', model: 'model' } },
  ];
  for (const config of insecure) {
    let calls = 0;
    const provider = createLlmProvider({ config, fetchImpl: async () => { calls += 1; return openAiSuccess(); } });
    await assert.rejects(provider.generate(TURN_INPUT), (error) => error.code === 'PROVIDER_NOT_CONFIGURED');
    assert.equal(calls, 0);
  }

  let calls = 0;
  let forwardedCredential = false;
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'redirect-secret', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    fetchImpl: async (url, init) => {
      calls += 1;
      if (init.redirect !== 'error') {
        forwardedCredential = init.headers['api-key'] === 'redirect-secret';
        return openAiSuccess();
      }
      return new Response('', { status: 307, headers: { location: 'https://redirected.test/collect' } });
    },
  });
  await assert.rejects(provider.generate(TURN_INPUT), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(calls, 1);
  assert.equal(forwardedCredential, false);

  let smokeCalls = 0;
  const smokeErrors = [];
  const smokeStatus = await runProviderSmoke({
    argv: ['--confirm-real-provider'],
    env: {
      NODE_ENV: 'test', V1_LLM_PROVIDER: 'hkbu', V1_HKBU_API_KEY: 'never-forward',
      V1_HKBU_BASE_URL: 'http://hkbu.test', V1_HKBU_MODEL: 'model', V1_HKBU_API_VERSION: 'v1',
      V1_LLM_CREDENTIAL_VERSION: 'credential-v1', V1_RELEASE_COMMIT_SHA: SMOKE_COMMIT,
    },
    fetchImpl: async () => { smokeCalls += 1; return openAiSuccess(); },
    stdout: () => {}, stderr: (line) => smokeErrors.push(line),
  });
  assert.equal(smokeStatus, 2);
  assert.equal(smokeCalls, 0);
  assert.match(smokeErrors.join('\n'), /CONFIG_INVALID/);
});

test('Azure uses an explicit request profile rather than inferring capability from deployment aliases', async () => {
  const requests = [];
  for (const requestProfile of ['standard', 'reasoning']) {
    const provider = createLlmProvider({
      config: {
        provider: 'azure-openai',
        settings: {
          apiKey: 'key', endpoint: 'https://azure.test', deployment: 'neutral-production-slot',
          apiVersion: '2024-10-21', requestProfile, minCompletionTokens: 1_600,
        },
      },
      fetchImpl: async (url, init) => { requests.push(JSON.parse(init.body)); return openAiSuccess(); },
    });
    await provider.generate(TURN_INPUT);
  }
  assert.equal(requests[0].max_completion_tokens, 180);
  assert.equal(requests[0].temperature, 0.2);
  assert.equal(requests[1].max_completion_tokens, 1_600);
  assert.equal('temperature' in requests[1], false);

  let missingCalls = 0;
  const missing = createLlmProvider({
    config: {
      provider: 'azure-openai',
      settings: { apiKey: 'key', endpoint: 'https://azure.test', deployment: 'gpt-5-looking-alias', apiVersion: '2024-10-21' },
    },
    fetchImpl: async () => { missingCalls += 1; return openAiSuccess(); },
  });
  await assert.rejects(missing.generate(TURN_INPUT), (error) => error.code === 'PROVIDER_NOT_CONFIGURED');
  assert.equal(missingCalls, 0);

  assert.throws(() => loadConfig({
    NODE_ENV: 'test', V1_LLM_PROVIDER: 'azure-openai', V1_AZURE_OPENAI_KEY: 'key',
    V1_AZURE_OPENAI_ENDPOINT: 'https://azure.test', V1_AZURE_OPENAI_DEPLOYMENT: 'neutral',
    V1_AZURE_OPENAI_API_VERSION: '2024-10-21', V1_AZURE_OPENAI_REQUEST_PROFILE: 'guess',
  }), /REQUEST_PROFILE/);
});

test('provider aggregate request budget retains the current inbound and newest complete history pairs', async () => {
  let requestBody;
  const messages = [];
  for (let index = 0; index < 30; index += 1) {
    messages.push({ role: 'user', content: `old-user-${index}-${'u'.repeat(3_000)}` });
    messages.push({ role: 'assistant', content: `old-assistant-${index}-${'a'.repeat(3_000)}` });
  }
  messages.push({ role: 'user', content: 'CURRENT-INBOUND-MUST-REMAIN' });
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    fetchImpl: async (url, init) => { requestBody = init.body; return openAiSuccess(); },
  });
  await provider.generate({ ...TURN_INPUT, messages });
  const body = JSON.parse(requestBody);
  const history = body.messages.slice(1, -1);
  assert.equal(Buffer.byteLength(requestBody) <= providerLimits.requestBytes, true);
  assert.equal(history.at(-1).content, 'CURRENT-INBOUND-MUST-REMAIN');
  assert.equal(history.some((message) => message.content.startsWith('old-user-29-')), true);
  assert.equal(history.some((message) => message.content.startsWith('old-user-0-')), false);
  assert.equal(history.length % 2, 1);
  for (let index = 0; index < history.length - 1; index += 2) {
    assert.equal(history[index].role, 'user');
    assert.equal(history[index + 1].role, 'assistant');
  }
});

test('provider rejects an oversized required reference envelope before fetch', async () => {
  let calls = 0;
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    fetchImpl: async () => { calls += 1; return openAiSuccess(); },
  });
  await assert.rejects(provider.generate({
    ...TURN_INPUT,
    evidenceSnapshot: [{ id: 'evidence.oversized', text: 'x'.repeat(providerLimits.requestBytes) }],
  }), (error) => error.code === 'PROVIDER_REQUEST_TOO_LARGE');
  assert.equal(calls, 0);
});

test('provider contract retries one transient failure inside one deadline with byte-identical body', async () => {
  const calls = [];
  const delays = [];
  let now = 1_000;
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    now: () => now,
    sleep: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
    totalDeadlineMs: 12_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body, signal: init.signal });
      if (calls.length === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '1' } });
      return openAiSuccess();
    },
  });
  const result = await provider.generate(TURN_INPUT);
  assert.equal(result.rawText, '{"replyText":"ok"}');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(delays, [1000]);
  assert.equal(calls.every((call) => call.signal instanceof AbortSignal), true);
});

test('provider contract does not retry auth, schema, refusal, content-filter, or successful truncation failures', async () => {
  const cases = [
    ['auth', () => new Response('denied', { status: 401 }), 'PROVIDER_AUTH_FAILED'],
    ['invalid schema', () => new Response('{bad json', { status: 200 }), 'PROVIDER_INVALID_RESPONSE'],
    ['refusal', () => new Response(JSON.stringify({ choices: [{ message: { refusal: 'no', content: '' }, finish_reason: 'stop' }] }), { status: 200 }), 'PROVIDER_REFUSED'],
    ['content filter', () => openAiSuccess('', 'content_filter'), 'PROVIDER_CONTENT_FILTERED'],
    ['truncation', () => openAiSuccess('{"partial":', 'length'), 'PROVIDER_OUTPUT_TRUNCATED'],
  ];
  for (const [name, responseFactory, code] of cases) {
    let calls = 0;
    const provider = createLlmProvider({
      config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
      fetchImpl: async () => { calls += 1; return responseFactory(); },
      sleep: async () => {},
    });
    await assert.rejects(provider.generate(TURN_INPUT), (error) => error instanceof ProviderError && error.code === code, name);
    assert.equal(calls, 1, name);
  }
});

test('provider contract caps the complete response body at 256 KiB', async () => {
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    fetchImpl: async () => new Response('x'.repeat((256 * 1024) + 1), { status: 200 }),
  });
  await assert.rejects(provider.generate(TURN_INPUT), (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('provider contract enforces one shared total deadline across retry delay and response reading', async () => {
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    totalDeadlineMs: 20,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return openAiSuccess();
    },
  });
  await assert.rejects(provider.generate(TURN_INPUT), (error) => error.code === 'PROVIDER_TIMEOUT');
});

test('provider config exposes selected private settings only and keeps publicStatus secret-free', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'minimax',
    V1_MINIMAX_API_KEY: 'selected-secret',
    V1_MINIMAX_BASE_URL: 'https://minimax.test',
    V1_MINIMAX_ANTHROPIC_BASE_URL: 'https://minimax.test/anthropic',
    V1_MINIMAX_LLM_MODEL: 'MiniMax-M2.1',
    HKBU_API_KEY: 'unselected-hkbu-secret', HKBU_BASE_URL: 'https://hkbu.test', HKBU_MODEL: 'hkbu', HKBU_API_VERSION: 'v1',
  });
  assert.deepEqual(config.llm.settings, {
    apiKey: 'selected-secret',
    baseUrl: 'https://minimax.test',
    anthropicBaseUrl: 'https://minimax.test/anthropic',
    model: 'MiniMax-M2.1',
  });
  assert.equal(JSON.stringify(config.publicStatus).includes('selected-secret'), false);
  assert.equal(JSON.stringify(config.llm.settings).includes('unselected-hkbu-secret'), false);
});

test('provider smoke requires the exact sole confirmation argument before config, Git, or network access', async () => {
  for (const argv of [
    [],
    ['--confirm-real-provider', '--extra'],
    ['--extra', '--confirm-real-provider'],
    ['--confirm-real-provider', '--confirm-real-provider'],
  ]) {
    const errors = [];
    let networkCalls = 0;
    let gitCalls = 0;
    let writes = 0;
    const exitCode = await runProviderSmoke({
      argv,
      env: smokeEnvironment(),
      fetchImpl: async () => { networkCalls += 1; return openAiSuccess('{"ok":true}'); },
      inspectGit: async () => { gitCalls += 1; return { commitSha: SMOKE_COMMIT, clean: true }; },
      writeEvidence: async () => { writes += 1; },
      stdout: () => {},
      stderr: (line) => errors.push(line),
    });
    assert.equal(exitCode, 2);
    assert.equal(networkCalls, 0);
    assert.equal(gitCalls, 0);
    assert.equal(writes, 0);
    assert.deepEqual(JSON.parse(errors.at(-1)), {
      provider: null,
      httpClass: null,
      normalizedSuccess: false,
      latencyMs: 0,
      artifactSha256: null,
      code: 'CONFIRMATION_REQUIRED',
    });
  }
});

test('default smoke bootstrap rejects legacy-only or non-lowercase production identity before Git or provider construction', async (t) => {
  const cases = [
    ['legacy-only provider variables', {
      NODE_ENV: 'test',
      V1_RELEASE_COMMIT_SHA: SMOKE_COMMIT,
      V1_LLM_CREDENTIAL_VERSION: 'credential-v7',
      LLM_PROVIDER: 'hkbu', HKBU_API_KEY: 'legacy-private-key',
      HKBU_BASE_URL: 'https://hkbu.test', HKBU_MODEL: 'model', HKBU_API_VERSION: 'v1',
    }],
    ['uppercase release SHA', smokeEnvironment({ V1_RELEASE_COMMIT_SHA: SMOKE_COMMIT.toUpperCase() })],
  ];
  for (const [name, env] of cases) {
    await t.test(name, async () => {
      let gitCalls = 0;
      let providerConstructions = 0;
      let networkCalls = 0;
      const errors = [];
      const exitCode = await runProviderSmoke({
        argv: ['--confirm-real-provider'],
        env,
        inspectGit: async () => { gitCalls += 1; return { commitSha: SMOKE_COMMIT, clean: true }; },
        createProvider: () => {
          providerConstructions += 1;
          return { generate: async () => ({ provider: 'hkbu', rawText: '{"ok":true}' }) };
        },
        fetchImpl: async () => { networkCalls += 1; return openAiSuccess('{"ok":true}'); },
        stdout: () => {},
        stderr: (line) => errors.push(line),
      });
      assert.equal(exitCode, 2);
      assert.equal(gitCalls, 0);
      assert.equal(providerConstructions, 0);
      assert.equal(networkCalls, 0);
      assert.equal(JSON.parse(errors.at(-1)).code, 'CONFIG_INVALID');
    });
  }
});

test('confirmed provider smoke emits one strict commit/config-bound immutable evidence record', async () => {
  const output = [];
  const errors = [];
  const records = [];
  let calls = 0;
  let gitCalls = 0;
  let requestedBody;
  const clock = [1_000, 1_123];
  const exitCode = await runProviderSmoke({
    argv: ['--confirm-real-provider'],
    env: smokeEnvironment(),
    createProvider: createSmokeProvider,
    fetchImpl: async (url, init) => {
      calls += 1;
      requestedBody = init.body;
      return vertexSuccess('{"ok":true}');
    },
    inspectGit: async () => {
      gitCalls += 1;
      return { commitSha: SMOKE_COMMIT, clean: true };
    },
    writeEvidence: async (record) => {
      records.push(record);
      return 'C:\\private\\path\\must-not-print.json';
    },
    now: () => SMOKE_NOW,
    clockMs: () => clock.shift(),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.equal(gitCalls, 2);
  assert.equal(records.length, 1);
  assert.match(requestedBody, /\{\\"ok\\":true\}/);
  assert.equal(JSON.parse(requestedBody).generationConfig.maxOutputTokens, 64);
  assert.deepEqual(JSON.parse(requestedBody).generationConfig.thinkingConfig, { thinkingBudget: 0 });
  const record = records[0];
  assert.deepEqual(Object.keys(record).sort(), [
    'artifactSha256', 'capability', 'commitSha', 'contractVersion', 'httpClass',
    'latencyMs', 'normalizedSuccess', 'occurredAt', 'provider', 'providerConfigDigest',
    'requestCount', 'result', 'schemaVersion', 'usage',
  ].sort());
  assert.deepEqual(record.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.equal(record.latencyMs, 123);
  const selected = loadConfig({ ...smokeEnvironment(), NODE_ENV: 'test' }).llm;
  selected.credentialVersion = 'runtime-sa-rotation-v1';
  assert.equal(record.providerConfigDigest, llmProviderConfigDigest(selected));
  assert.equal(validateLlmSmokeEvidence(record, {
    expectedVersion: record.artifactSha256,
    commitSha: SMOKE_COMMIT,
    provider: 'vertex-ai',
    configDigest: record.providerConfigDigest,
    now: SMOKE_NOW,
  }).valid, true);

  assert.equal(errors.length, 0);
  assert.equal(output.length, 1);
  const rendered = output[0];
  assert.deepEqual(JSON.parse(rendered), {
    provider: 'vertex-ai',
    httpClass: '2xx',
    normalizedSuccess: true,
    latencyMs: 123,
    artifactSha256: record.artifactSha256,
    code: 'LLM_SMOKE_RECORDED',
  });
  for (const forbidden of [
    'private', 'path',
    record.providerConfigDigest, '{"ok":true}', 'request-1',
  ]) assert.equal(rendered.includes(forbidden), false);
});

test('provider smoke preserves normalized Vertex token usage in immutable evidence', async () => {
  const records = [];
  const llm = {
    available: true, provider: 'vertex-ai', credentialVersion: 'runtime-sa-rotation-v1', timeoutMs: 12_000,
    settings: { projectId: 'motion-expert-hk-ltd-webpage', location: 'global', model: 'gemini-2.5-flash' },
  };
  const exitCode = await runProviderSmoke({
    argv: ['--confirm-real-provider'],
    loadSmokeConfig: () => ({ releaseCommitSha: SMOKE_COMMIT, llm }),
    inspectGit: cleanFrozenGit(),
    createProvider: ({ fetchImpl }) => ({
      generate: async () => {
        await fetchImpl('https://aiplatform.googleapis.com/v1/test', {});
        return {
          provider: 'vertex-ai', rawText: '{"ok":true}', latencyMs: 1,
          usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
          finishReason: 'stop', providerRequestId: 'private-request-id',
        };
      },
    }),
    fetchImpl: async () => new Response('{}', { status: 200 }),
    writeEvidence: async (record) => { records.push(record); },
    now: () => SMOKE_NOW,
    clockMs: (() => { const values = [1_000, 1_001]; return () => values.shift(); })(),
    stdout: () => {},
    stderr: () => {},
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(records[0].usage, { inputTokens: 11, outputTokens: 5, totalTokens: 16 });
});

test('provider smoke rejects dirty or moving Git state before publishing evidence', async (t) => {
  const cases = [
    ['dirty before request', [{ commitSha: SMOKE_COMMIT, clean: false }], 0, 2],
    ['wrong commit before request', [{ commitSha: 'b'.repeat(40), clean: true }], 0, 2],
    ['dirty after request', [
      { commitSha: SMOKE_COMMIT, clean: true },
      { commitSha: SMOKE_COMMIT, clean: false },
    ], 1, 1],
    ['commit moved after request', [
      { commitSha: SMOKE_COMMIT, clean: true },
      { commitSha: 'b'.repeat(40), clean: true },
    ], 1, 1],
  ];
  for (const [name, states, expectedNetworkCalls, expectedExitCode] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      let writes = 0;
      const errors = [];
      const exitCode = await runProviderSmoke({
        argv: ['--confirm-real-provider'],
        env: smokeEnvironment(),
        createProvider: createSmokeProvider,
        fetchImpl: async () => { calls += 1; return vertexSuccess('{"ok":true}'); },
        inspectGit: async () => states.shift(),
        writeEvidence: async () => { writes += 1; },
        clockMs: (() => { let value = 1_000; return () => { value += 1; return value; }; })(),
        stdout: () => {},
        stderr: (line) => errors.push(line),
      });
      assert.equal(exitCode, expectedExitCode);
      assert.equal(calls, expectedNetworkCalls);
      assert.equal(writes, 0);
      assert.equal(JSON.parse(errors.at(-1)).code, 'RELEASE_GIT_STATE_INVALID');
    });
  }
});

test('provider smoke hard-caps network use at one request and rechecks Git after provider failure', async () => {
  let networkCalls = 0;
  let gitCalls = 0;
  let writes = 0;
  const errors = [];
  const exitCode = await runProviderSmoke({
    argv: ['--confirm-real-provider'],
    env: smokeEnvironment(),
    fetchImpl: async () => { networkCalls += 1; return openAiSuccess('{"ok":true}'); },
    createProvider: ({ fetchImpl }) => ({
      provider: 'hkbu',
      async generate() {
        await fetchImpl('https://hkbu.test/first', {});
        await fetchImpl('https://hkbu.test/second', {});
        return { provider: 'hkbu', rawText: '{"ok":true}', usage: null };
      },
    }),
    inspectGit: async () => { gitCalls += 1; return { commitSha: SMOKE_COMMIT, clean: true }; },
    writeEvidence: async () => { writes += 1; },
    stdout: () => {},
    stderr: (line) => errors.push(line),
  });

  assert.equal(exitCode, 1);
  assert.equal(networkCalls, 1);
  assert.equal(gitCalls, 2);
  assert.equal(writes, 0);
  assert.equal(JSON.parse(errors.at(-1)).code, 'PROVIDER_SMOKE_REQUEST_LIMIT');
});

test('provider smoke requires exact normalized JSON and redacts provider and artifact failures', async (t) => {
  for (const rawText of ['{}', '{"ok":1}', '{"ok":true,"extra":1}', '```json\n{"ok":true}\n```']) {
    await t.test(`invalid normalized payload ${rawText}`, async () => {
      let writes = 0;
      const errors = [];
      const exitCode = await runProviderSmoke({
        argv: ['--confirm-real-provider'],
        env: smokeEnvironment(),
        createProvider: createSmokeProvider,
        fetchImpl: async () => vertexSuccess(rawText),
        inspectGit: cleanFrozenGit(),
        writeEvidence: async () => { writes += 1; },
        clockMs: (() => { let value = 1_000; return () => ++value; })(),
        stdout: () => {}, stderr: (line) => errors.push(line),
      });
      assert.equal(exitCode, 1);
      assert.equal(writes, 0);
      assert.equal(JSON.parse(errors.at(-1)).code, 'PROVIDER_INVALID_RESPONSE');
    });
  }

  const providerErrors = [];
  const providerExit = await runProviderSmoke({
    argv: ['--confirm-real-provider'],
    env: smokeEnvironment(),
    createProvider: createSmokeProvider,
    fetchImpl: async () => new Response('never-print-this-key private provider body', { status: 401 }),
    inspectGit: cleanFrozenGit(),
    stdout: () => {}, stderr: (line) => providerErrors.push(line),
  });
  assert.equal(providerExit, 1);
  assert.deepEqual(JSON.parse(providerErrors.at(-1)), {
    provider: 'vertex-ai', httpClass: '4xx', normalizedSuccess: false,
    latencyMs: JSON.parse(providerErrors.at(-1)).latencyMs,
    artifactSha256: null, code: 'PROVIDER_AUTH_FAILED',
  });
  assert.equal(providerErrors.join('\n').includes('never-print-this-key'), false);
  assert.equal(providerErrors.join('\n').includes('private provider body'), false);

  const writeErrors = [];
  const writeExit = await runProviderSmoke({
    argv: ['--confirm-real-provider'],
    env: smokeEnvironment(),
    createProvider: createSmokeProvider,
    fetchImpl: async () => vertexSuccess('{"ok":true}'),
    inspectGit: cleanFrozenGit(),
    writeEvidence: async () => { const error = new Error('C:\\private\\evidence.json'); error.code = 'EEXIST'; throw error; },
    clockMs: (() => { let value = 1_000; return () => ++value; })(),
    stdout: () => {}, stderr: (line) => writeErrors.push(line),
  });
  assert.equal(writeExit, 1);
  assert.equal(JSON.parse(writeErrors.at(-1)).code, 'LLM_SMOKE_ARTIFACT_EXISTS');
  assert.equal(writeErrors.join('\n').includes('private'), false);
});

test('default LLM evidence writer creates a digest-named file exclusively with private permissions', async () => {
  const record = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: SMOKE_COMMIT,
    capability: 'llm',
    provider: 'hkbu',
    contractVersion: 'llm-connectivity-json-v1',
    providerConfigDigest: 'b'.repeat(64),
    occurredAt: SMOKE_NOW.toISOString(),
    result: 'pass',
    httpClass: '2xx',
    normalizedSuccess: true,
    requestCount: 1,
    latencyMs: 1,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  });
  let madeDirectory;
  let invocation;
  const filePath = await writeLlmSmokeEvidence(record, {
    rootDirectory: 'C:\\candidate',
    makeDirectory: async (directory, options) => { madeDirectory = { directory, options }; },
    writeArtifact: async (path, contents, options) => { invocation = { path, contents, options }; },
  });

  assert.equal(madeDirectory.options.recursive, true);
  assert.equal(filePath, invocation.path);
  assert.equal(filePath.endsWith(`${SMOKE_COMMIT}-llm-${record.artifactSha256}.json`), true);
  assert.deepEqual(invocation.options, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  assert.deepEqual(JSON.parse(invocation.contents), record);
});
