export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function sendError(response, error) {
  const normalized = normalizeError(error);
  response.status(normalized.status).json({ data: null, error: { code: normalized.code, message: safeMessage(normalized.code) }, requestId: response.locals.requestId });
}

function normalizeError(error = {}) {
  if (error.type === 'entity.parse.failed' || error.code === 'INVALID_REQUEST') return { status: 400, code: 'INVALID_REQUEST' };
  if (error.type === 'entity.too.large' || error.status === 413) return { status: 413, code: 'PAYLOAD_TOO_LARGE' };
  const known = {
    SESSION_NOT_FOUND: 401, NOT_FOUND: 404, IDEMPOTENCY_CONFLICT: 409,
    AI_CONSENT_REQUIRED: 403, VOICE_CONSENT_REQUIRED: 403,
    INVALID_VOICE_DRAFT: 400, RATE_LIMITED: 429, ORIGIN_NOT_ALLOWED: 403,
    INVALID_EVENT_CURSOR: 400, VOICE_NOT_RELEASE_VERIFIED: 503,
    VOICE_UNSUPPORTED_MEDIA_TYPE: 415, VOICE_UPLOAD_TOO_LARGE: 413,
    VOICE_UPLOAD_TIMEOUT: 408, VOICE_UPLOAD_ABORTED: 408,
    VOICE_HASH_MISMATCH: 422, VOICE_INVALID_WAV: 422,
    VOICE_SPEECH_NOT_RECOGNIZED: 422, VOICE_PROVIDER_MISCONFIGURED: 503,
    VOICE_PROVIDER_INVALID_RESPONSE: 502, VOICE_TRANSCRIPTION_REJECTED: 502,
    VOICE_SYNTHESIS_REJECTED: 502, VOICE_TRANSCRIPTION_FAILED: 502,
    VOICE_SYNTHESIS_FAILED: 502, VOICE_PROVIDER_TIMEOUT: 504,
    VOICE_MEDIA_UNAVAILABLE: 503, VOICE_DRAFT_DELETED: 404,
    VOICE_UPLOAD_CANCELLED: 410, VOICE_DRAFT_ALREADY_ATTACHED: 409,
    RANGE_NOT_SATISFIABLE: 416,
  };
  if (error.code in known) {
    const allowedStoredStatus = Number.isInteger(error.status) && [408, 413, 415, 422, 429, 502, 503, 504].includes(error.status)
      ? error.status
      : known[error.code];
    return { status: allowedStoredStatus, code: error.code };
  }
  return { status: 500, code: 'INTERNAL_ERROR' };
}

function safeMessage(code) {
  const messages = {
    SESSION_NOT_FOUND: 'A valid session is required.',
    AI_CONSENT_REQUIRED: 'Please accept the AI disclosure before sending.',
    VOICE_CONSENT_REQUIRED: 'Please accept optional voice transcription first.',
    INVALID_REQUEST: 'The request is invalid.',
    INVALID_VOICE_DRAFT: 'The voice draft is unavailable.',
    PAYLOAD_TOO_LARGE: 'The request body is too large.',
    IDEMPOTENCY_CONFLICT: 'This client message ID was already used with different content.',
    RATE_LIMITED: 'Too many requests. Please try again later.',
    NOT_FOUND: 'The requested resource was not found.',
    INVALID_EVENT_CURSOR: 'The event cursor is invalid.',
    VOICE_NOT_RELEASE_VERIFIED: 'Voice is not verified for this release.',
    VOICE_UNSUPPORTED_MEDIA_TYPE: 'Only canonical WAV audio is accepted.',
    VOICE_UPLOAD_TOO_LARGE: 'The voice upload is too large.',
    VOICE_UPLOAD_TIMEOUT: 'The voice upload timed out.',
    VOICE_UPLOAD_ABORTED: 'The voice upload was interrupted.',
    VOICE_HASH_MISMATCH: 'The uploaded audio did not match its declared digest.',
    VOICE_INVALID_WAV: 'The uploaded audio is not canonical WAV.',
    VOICE_SPEECH_NOT_RECOGNIZED: 'Speech could not be recognized from this recording.',
    VOICE_PROVIDER_MISCONFIGURED: 'The voice provider is not configured correctly.',
    VOICE_PROVIDER_INVALID_RESPONSE: 'The voice provider returned an invalid response.',
    VOICE_TRANSCRIPTION_REJECTED: 'The transcription provider rejected this recording.',
    VOICE_SYNTHESIS_REJECTED: 'The voice provider rejected this synthesis request.',
    VOICE_TRANSCRIPTION_FAILED: 'Transcription is temporarily unavailable.',
    VOICE_SYNTHESIS_FAILED: 'Generated voice is temporarily unavailable.',
    VOICE_PROVIDER_TIMEOUT: 'The voice provider timed out.',
    VOICE_MEDIA_UNAVAILABLE: 'Voice media storage is temporarily unavailable.',
    VOICE_DRAFT_DELETED: 'The voice draft was deleted.',
    VOICE_UPLOAD_CANCELLED: 'The voice upload was cancelled.',
    VOICE_DRAFT_ALREADY_ATTACHED: 'The voice draft is already attached to a message.',
    RANGE_NOT_SATISFIABLE: 'The requested byte range is not satisfiable.',
  };
  return messages[code] ?? 'The service could not process this request.';
}
