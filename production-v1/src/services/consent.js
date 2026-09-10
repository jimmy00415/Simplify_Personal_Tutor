import { httpError } from '../http/errors.js';

export const COMBINED_PRIVACY_NOTICE_VERSION = '2026-09-10-ios-combined';
export const CONSENT_KINDS = Object.freeze(['ai', 'voice']);

export function publicConsent(session, noticeVersion) {
  const version = noticeVersion ?? null;
  return {
    privacyNoticeVersion: version,
    aiGranted: Boolean(version && session?.aiConsentVersion === version && session?.aiConsentAt),
    voiceGranted: Boolean(version && session?.voiceConsentVersion === version && session?.voiceConsentAt),
  };
}

export function aiConsentRequired(config) {
  return config?.requireAiConsent === true
    || config?.privacyNoticeVersion === COMBINED_PRIVACY_NOTICE_VERSION;
}

export function assertAiConsent(session, config) {
  if (!aiConsentRequired(config)) return;
  if (!publicConsent(session, config.privacyNoticeVersion).aiGranted) {
    throw httpError(403, 'AI_CONSENT_REQUIRED');
  }
}

export function assertVoiceConsent(session, config) {
  if (!aiConsentRequired(config)) return;
  if (!publicConsent(session, config.privacyNoticeVersion).voiceGranted) {
    throw httpError(403, 'VOICE_CONSENT_REQUIRED');
  }
}

export function normalizeConsentRequest(body, noticeVersion) {
  const kinds = Array.isArray(body?.kinds) ? [...new Set(body.kinds)] : [];
  if (kinds.length < 1 || kinds.some((kind) => !CONSENT_KINDS.includes(kind))) {
    throw httpError(400, 'INVALID_REQUEST');
  }
  if (!noticeVersion || body?.version !== noticeVersion) {
    throw httpError(400, 'INVALID_REQUEST');
  }
  return { kinds, version: noticeVersion };
}
