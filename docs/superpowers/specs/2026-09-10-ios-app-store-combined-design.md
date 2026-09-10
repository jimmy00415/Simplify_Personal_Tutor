# Hong Kong Buddy Combined iOS App Store Design

## Status

- Date: 2026-09-10
- Decision owner: product owner
- Execution mode: approved for specification and sequenced implementation
- Product line: extend the isolated `production-v1` application; the legacy
  tutoring/translation product remains unchanged
- Prerequisite specs that remain authoritative unless this document replaces a
  clause:
  - `docs/superpowers/specs/2026-08-25-production-v1-ai-senior-design.md`
  - `docs/superpowers/specs/2026-08-26-production-v1-gcp-launch-design.md`
  - `docs/superpowers/specs/2026-08-26-production-v1-shared-project-isolation-design.md`
- Visual reference: the existing V1 warm-cream messenger language, plus a
  compact native tab bar. Do not copy Apple, WhatsApp, WeChat, or HKBU brand
  chrome.

## Product Goal

Ship one unofficial iPhone application that a new HKBU student can download and
use without an account. The same guest session can:

1. ask grounded campus questions of the existing AI senior;
2. practise everyday Cantonese in Teaching or Free Talk;
3. translate a supervised elderly/community visit in four directions;
4. open a small offline phrasebook and a Today habit card.

This is a messaging-and-practice companion, not a live call, avatar, official
HKBU service, pronunciation scorer, or memory tutor.

## Product Promise

> Hong Kong Buddy helps HKBU students get verified campus next steps and
> practise useful everyday Cantonese. It is an AI assistant, not a student,
> staff member, or official university representative.

The App Store name, subtitle, screenshots, first screen, and in-app disclosure
must all keep that sentence. The listing must not claim:

- official HKBU endorsement or affiliation beyond “for HKBU students”;
- tone scoring, pronunciation grades, or fluency measurement;
- long-term memory, accounts, or cross-device history;
- that all data stays in Hong Kong;
- that recordings or prompts are never retained by providers;
- that speech recognition proves correct pronunciation.

## Why this is one app

The repository currently contains three identities: live campus V1, legacy V2
practice/translate, and an unimplemented 2.0 memory proposal. A public Hong
Kong App Store page can only tell one truth.

The combined first release therefore **ports** Today, Practice, Translate, and
Phrasebook onto the Production V1 origin and guest session. It does **not**
wrap the Azure legacy site and the Cloud Run campus chat as two WebViews.

Guideline 4.2 is the reason combined is useful only if the binary is more than
Safari. Native tabs, native microphone/lifecycle handling, an offline
phrasebook, first-run AI consent, and interruption-safe voice are required
product surfaces. Decorative native chrome around the current website is not
enough.

## Scope Boundary and Isolation

All runtime work stays under `production-v1/`.

It must not:

- modify `frontend/`, `backend/`, `backend/public/`, or the Azure workflow;
- call legacy `/api/recognize-and-respond`, `/api/visit-translate`,
  `/api/speech-token`, or any Azure/MiniMax/HKBU GenAI provider from the iOS
  binary or the V1 origin;
- deploy over `hkbuddy-pilot-0630`;
- add student SSO, Sign in with Apple, or in-app purchases;
- implement 2.0 long-term memory, learner mastery, or proactive
  recommendations;
- commit secrets, signing certificates, or App Store Connect API keys.

Copy static phrasebook rows, cultural-context JSON, visit fallbacks, and i18n
ideas out of the legacy tree. Treat those copies as V1-owned after the first
green test.

Local preview may still load `backend/.env` through an explicit `ENV_FILE`.
That file remains read-only.

## User Experience Contract

### Four tabs, one session

The signed-out iOS and mobile-web experience has a persistent bottom tab bar
with four destinations. Every tab shares the same `hb_v1_session` cookie.

1. **Today** — habit home, not a dashboard of charts.
2. **Campus** — the current V1 AI senior messenger, now a view rather than the
   entire application.
3. **Practice** — scenario Cantonese tutor.
4. **Translate** — visit interpreter.

Phrasebook and Privacy are sheets opened from Today or the header Info control.
They are not a fifth tab.

The tab bar is at least 49 pt tall including the home indicator, with 44 by 44
pt hit targets. The active tab remains selected across app backgrounding.
Deep links from Today change the selected tab and prefill the destination
composer or visit task; they do not open a second session.

### First launch

The first cold start, before any campus, practice, or translate send, shows a
blocking AI disclosure that the student must accept or leave.

The disclosure must state, in the current UI language:

- this is an AI assistant, not an official HKBU representative;
- typed text is stored in Hong Kong and sent to Google Vertex AI using the
  global endpoint to produce a reply;
- optional voice uploads a recording to Google Speech-to-Text in Singapore
  before the student taps Send;
- generated assistant voice uses Google Text-to-Speech in Singapore;
- guest history does not follow the student to another browser or device;
- Clear conversation revokes this session and queues stored media for
  deletion;
- a link to `/legal/privacy` and `/legal/support`.

Decline leaves the app usable only for the hosted legal pages and the offline
phrasebook. No session-mutating API except legal GETs may run until AI consent
is recorded.

Microphone permission is a later, separate step. The first-run sheet must not
request the system microphone.

### Today

Today shows four durable regions:

1. A one-line greeting that uses the selected UI language.
2. A habit card: “Practised today” or the recommended line. State is
   device-local (`hk-buddy:v1.1:habitState`). Losing the phone loses the streak.
   That limitation is visible: “Saved on this iPhone only.”
3. Three shortcuts: Ask campus, Start practice, Open translator.
4. Phrase of the day from the bundled phrasebook, with actions “Practise this”
   and “Translate with this.”

Today never calls the campus retriever or the tutor model on its own. Opening
it is not personal-data processing beyond the existing session cookie.

### Campus

Campus preserves the V1 messenger contract:

- one timeline, text canonical, citations and handoff cards when grounded;
- hold-to-talk produces an editable transcript before Send;
- assistant voice is Generate then Play, never autoplay;
- fail-closed overdue, expired, or conflicted claims stay unverified;
- the assistant never claims to be a person or official representative.

The V1 one-screen isolation rule is relaxed only enough to place Campus inside
the tab shell. There is still no mode picker inside Campus.

### Practice

Practice is a tutor conversation, not a campus Q&A.

- Modes: `teaching` and `freeChat`. The toggle is visible and persists for the
  practice conversation.
- Scenarios, copied from the legacy list and owned by V1 after port:
  - Free Conversation
  - At the Restaurant
  - Meeting New People
  - Traveling in Hong Kong
  - Shopping Small Talk
  - Workplace Small Talk
- The student types or records. Recording uses the same V1 voice contract.
- The tutor replies in written Cantonese (Traditional Chinese). Coach notes
  appear in English: a short translation of the tutor reply, plus on-demand
  Correct Me.
- Teaching mode asks the model for corrections. Free Talk tolerates minor
  errors unless they block meaning.
- Correct Me runs on the last student utterance only.
- Tutor voice is opt-in Play. Practice must not autoplay TTS.
- First successful delivered practice exchange marks Today as practised.
- Practice must not send utterances through the campus retriever. Ordinary
  “點樣叫凍檸茶” is a tutor turn, not an unverified campus refusal.

The listing and the Practice header must say this is conversation practice, not
pronunciation assessment. Correct transcription is not a grade.

### Translate

Translate keeps the V2 job model:

| Student job | Directions |
|---|---|
| Resident speaks Cantonese | `yue_to_en`, `yue_to_zh` |
| Volunteer speaks English or Mandarin | `en_to_yue`, `zh_to_yue` |

- Input is text or the shared voice transcript draft.
- Output is a paired card: source, translation, Jyutping when the target is
  Cantonese, optional Play for Cantonese TTS, large-text toggle.
- English typed in resident mode auto-routes to `en_to_yue` and shows why.
- `needsConfirmation` is visible when the rule fallback, low confidence, or
  staff-confirm wording applies.
- The UI must say this is for a supervised visit, not medical or legal advice.
- Cantonese TTS speaks `speakableText`, never romanization-only strings.

### Phrasebook

The elderly-visit phrase set is bundled static JSON in the V1 client. The
phrasebook works offline after the first successful asset load. Each phrase
has `id`, `phase`, `category`, `cantonese`, `jyutping`, and `english`. Actions
hand the Cantonese line to Practice or the matching direction to Translate.
Phrasebook display is not an LLM call.

### Localization

UI language is `en`, `yue-Hant-HK`, or `cmn-Hans-CN` and applies to:

- tab labels, Today, sheets, consent, legal summaries;
- errors, rate-limit, deletion, and voice status;
- Campus welcome and starter prompts (already present);
- Practice and Translate chrome.

Tutor replies stay in written Cantonese. Coach notes stay in English unless a
later spec changes that. Campus reply language remains a per-send Campus
setting, independent of UI language.

### Accessibility

- WCAG 2.2 AA contrast, visible focus, 44 pt targets, live regions.
- VoiceOver can complete text send on every tab without hold-to-talk.
- Hold-to-talk has a press-to-toggle alternative (already in V1).
- Reduced motion, safe-area, Dynamic Type up to AX3 without clipping the
  composer or tab bar.
- Store listing may claim accessibility only after a real-device VoiceOver
  pass of Today → Campus send → Practice send → Translate → Clear.

## Technical Architecture

### Runtime shape

```text
iPhone Capacitor shell
  -> bundled or same-origin V1 web UI
       -> Express /api/v1
            -> guest session + consent
            -> campus conversation (existing)
            -> practice conversation (new)
            -> visit turns (new)
            -> shared voice + media + retention
            -> safety router
            -> campus answer path | tutor path | visit path
            -> Vertex / STT / TTS
  <- SSE for campus and practice timelines
```

The iOS binary does not embed a second origin. Production `V1_PUBLIC_ORIGIN`
remains the API and legal origin. Capacitor may load the bundled static UI
against that origin, or load the origin itself after first-run consent; both
are same-product. It must not load `hkbuddy-pilot-0630` or any Azure host.

### Two answer paths, one safety door

`routeSafety` in `production-v1/src/knowledge/safety.js` runs on every free-form
campus, practice, Correct Me, and visit source text. Emergency matches return
the existing 999 / HKBU Security template and do not call the tutor or
translator.

After safety:

- **Campus** keeps `createAnswerService`: retriever, grounding snapshot,
  evidence-ID validation, fail-closed unverified fallback.
- **Practice** uses a new `createTutorService`. The model receives scenario,
  mode, recent practice turns, and optional cultural-context snippets. It
  returns structured JSON `{ replyText, coachNotes, needsConfirmation }`.
  `replyText` is Cantonese. `coachNotes` is English. No campus evidence IDs
  are accepted. The campus corpus is not attached.
- **Visit** uses a new `createVisitTranslationService`: rule-based
  `visitTranslationFallback` first, then one Vertex JSON translation, then
  mock/staff-confirm fallback. No Azure Translator in this release.

Vertex remains `gemini-2.5-flash` at location `global` with ADC only.

### One voice contract

All microphone use produces the existing canonical 16 kHz mono PCM16LE WAV and
uploads through `POST /api/v1/voice/transcriptions`.

The iOS app must not include the Azure Speech SDK, MiniMax browser recording
shortcuts, or raw container uploads.

Web Audio normalization stays the default path. If TestFlight WKWebView
decode is silent or fails after a passing Safari gate, a native
`AVAudioRecorder` / `AVAudioEngine` plugin must emit the same WAV bytes and
the same `normalizerContractVersion` family (`native-wav-v1` is a new
allowed source, evidenced separately). Safari success is not TestFlight
success.

Assistant and tutor TTS reuse `POST /api/v1/messages/:id/audio` or a practice
equivalent that stores MP3 in the existing media store. Playback is always an
explicit user action.

### Native shell

New Capacitor application under `production-v1/ios-app/`:

- committed: `capacitor.config.json` / `.ts`, plugin TypeScript, Swift plugin
  sources, `Info.plist` templates, `PrivacyInfo.xcprivacy`, icon set inputs;
- CI-generated: the Xcode project under `ios/` when the hosted Mac runs
  `npx cap add ios` / `npx cap sync`.

Required native behavior:

- tab bar is native or a native-backed custom bar that survives keyboard and
  safe area;
- `NSMicrophoneUsageDescription` explains transcription for optional voice
  messages, not “improving the app”;
- `WKUIDelegate` media-capture permission is implemented so `getUserMedia` is
  not silently denied;
- app lifecycle cancels an in-flight recording on `pagehide`, incoming call,
  and audio-session interruption;
- keyboard and status bar do not cover the composer;
- privacy manifest lists collected data types that match the store labels;
- no unused camera, location, contacts, or tracking APIs.

Uploads to App Store Connect must be built with Xcode 26 and the iOS 26 SDK.
The deployment target may be iOS 17 or later. The deployment target is not
iOS 26-only.

Windows development produces the web UI, API, tests, and plugin sources.
Codemagic or an equivalent hosted macOS workflow signs and uploads. The iOS
Simulator is not available on the Windows workstation and is not an acceptance
substitute.

## Data Model

The existing session, campus conversation, messages, turns, events, media,
voice uploads, deletion outbox, and rate-limit tables remain. Combined
release adds the following.

### `sessions` additions

- `ai_consent_version` (nullable text)
- `ai_consent_at` (nullable timestamptz)
- `voice_consent_version` (nullable text)
- `voice_consent_at` (nullable timestamptz)

A mutating campus, practice, or visit POST without a current
`ai_consent_version` matching `V1_PRIVACY_NOTICE_VERSION` returns `403`
`AI_CONSENT_REQUIRED`. Voice transcription additionally requires current
voice consent or returns `403` `VOICE_CONSENT_REQUIRED`.

### `conversations`

Replace the current one-conversation-per-session unique constraint with:

- `kind` `campus | practice`
- `UNIQUE (session_id, kind)`
- practice-only `mode` `teaching | freeChat` (null on campus)
- practice-only `scenario` (null on campus)

Session bootstrap creates the campus conversation as today. The practice
conversation is created on first Practice open or first practice send.

### `visit_turns`

- `id`
- `session_id`
- `client_turn_id` (idempotency)
- `direction`
- `source_text`
- `translated_text`
- `display_text`
- `romanization_json`
- `auto_routed`
- `route_reason`
- `needs_confirmation`
- `provider`
- `media_id` (nullable Cantonese TTS)
- `created_at`

Visit history is session-scoped, shown as the last several pairs, and purged
with the guest session.

### Client-only state

Safe to keep on device, never required for deletion of server data:

- UI language
- habit card
- TTS playback speed
- last selected tab
- last visit job and direction

## HTTP API

Existing `/api/v1/session`, `/messages`, `/events`, `/voice/*`, and `/media/*`
remain the campus and shared-voice surface. Bootstrap responses gain:

```json
{
  "consent": {
    "privacyNoticeVersion": "2026-09-10-ios-combined",
    "aiGranted": false,
    "voiceGranted": false
  },
  "conversations": {
    "campus": { "id": "..." },
    "practice": null
  }
}
```

New routes, all cookie-authenticated and CSRF-guarded:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/consent` | Record `ai` and/or `voice` consent for the current notice version |
| DELETE | `/api/v1/consent/voice` | Withdraw voice consent; later transcriptions 403; text remains |
| GET | `/api/v1/practice/session` | Create or return the practice conversation |
| POST | `/api/v1/practice/mode` | Set `teaching` or `freeChat` |
| POST | `/api/v1/practice/messages` | Tutor turn; 202 + existing dispatcher |
| POST | `/api/v1/practice/correct` | Correct Me on the last student utterance |
| POST | `/api/v1/visit-translate` | Synchronous visit translation |
| GET | `/legal/privacy` | Hosted PICS + privacy policy |
| GET | `/legal/support` | Support contact and data-request route |

`DELETE /api/v1/session` already clears campus data. It must also revoke
practice messages, visit turns, and their media deletion jobs.

Practice messages reuse the messages/turns/events model with
`conversation.kind = practice`. Campus `GET /messages` and SSE stay scoped to
the campus conversation. Practice has its own `GET /api/v1/practice/messages`
and `GET /api/v1/practice/events` (or a `conversation` query that the server
authorizes only for the session’s practice id). A client must not be able to
subscribe to another conversation id.

Rate limits are separate buckets so practice or visit abuse cannot exhaust
campus quotas. Suggested ceilings, tunable in config:

- practice messages: 30 / 5 min, 200 / day
- Correct Me: 10 / 10 min
- visit translate: 20 / 10 min, 80 / day
- shared ASR/TTS remain the existing V1 ceilings

## Privacy, PDPO, and App Store legal

This section is product behavior. Company registration and Apple Developer
enrolment are out of scope.

### Hosted notices

`/legal/privacy` is the public collection notice and privacy policy. It must
be available without JavaScript and in English and Traditional Chinese at
minimum, Simplified Chinese preferred. It must name:

- data user / contact for access and correction;
- purposes: campus answers, Cantonese practice, visit translation, security,
  abuse prevention, retention;
- data classes: message text, voice recordings, transcripts, generated audio,
  session identifiers, coarse IP for rate limits, consent records;
- recipient classes: Google Cloud (Cloud Run, Cloud SQL, Cloud Storage in
  `asia-east2`; Vertex AI global processing; Speech-to-Text and
  Text-to-Speech in `asia-southeast1`);
- that provision of voice is voluntary;
- retention: 30 days of guest inactivity for conversations; 7 days for media;
  backups may persist longer until they expire;
- how to withdraw consent and request access/correction after the cookie is
  gone (the support address);
- that a guest session is not anonymous if the student identifies themselves.

Forbidden claims unless a later evidenced addendum proves them:

- “All data stays in Hong Kong”
- “Never retained by Google”
- “Not used for training” without citing the current Vertex terms and the
  project’s cache / abuse-log configuration
- “Deleted everywhere instantly”

`/legal/support` publishes a contact path and states typical response timing
for access/correction. Guideline 1.5 requires this URL in the app and in
App Store Connect.

`V1_PRIVACY_NOTICE_VERSION` for this release is `2026-09-10-ios-combined`.
Production still requires `V1_PRIVACY_NOTICE_APPROVED=true`.

### Consent semantics

| Action | Required consent | Leaves the device |
|---|---|---|
| Open Today / Phrasebook / legal | Session cookie only | Cookie, client instance id |
| Accept AI disclosure | AI consent record | Notice version |
| Send campus or practice text | AI | Text + context to Vertex; text stored in HK |
| Record / transcribe | AI + voice | WAV to STT Singapore; object in GCS HK |
| Edit transcript | none new | Does not undo the earlier audio processing |
| Generate or Play tutor/campus voice | AI | Text to TTS Singapore |
| Clear conversation | none | Revokes session; queues media delete |
| Withdraw voice | voice withdrawal | Future ASR 403 |

“Not sent to chat yet” may describe the transcript only. Voice UI must also
say the recording is uploaded for transcription when the student releases.

Consent versions are server-authoritative. `sessionStorage` may cache UI
state but cannot grant a 403-bypass.

### Privacy nutrition labels

Declare at least:

- User Content → Other User Content (chat, practice, translations)
- User Content → Audio Data (optional voice)
- Identifiers → User ID (session id / token hash purpose)
- Identifiers → Device ID if `X-Client-Instance-Id` is retained beyond the
  rate-limit window
- Product Interaction / Diagnostics only if logs retain more than counters

Do not select Data Not Collected. Do not enable App Tracking Transparency
unless a later release tracks across apps.

### Age rating and safety

The app is not in the Kids Category and must not say “for children.”
Unrestricted guest chat plus medical, counselling, and emergency routing
means the age questionnaire cannot honestly land at 4+. Expect 12+ or 17+
from the actual answers.

Campus medical and counselling intents remain informational pointers to
official HKBU pages. The app does not diagnose, counsel, or replace 999.

There is no social feed, so Guideline 1.2 UGC moderation (block/report other
users) does not apply. A “Report this answer” control on campus and practice
assistant bubbles is still required so a student can flag a wrong or unsafe
reply. Reports store only message id, conversation kind, reason code, and
timestamp — not a second copy of the transcript — and surface on the support
path.

### HKBU intellectual property

In-app and listing copy must keep “AI assistant, not an official HKBU
representative.” Icons and screenshots must not use the HKBU logo or imply
university publication. The corpus may continue to quote reviewed official
pages with citations. Authorization to keep “HKBU” in the subtitle is a
launch operator decision; the engineering fallback subtitle is “Campus and
Cantonese companion.”

## Knowledge freshness

The live V1 corpus snapshot on 2026-09-10 was `2026-08-26`. Daily claims with
`reviewAfter` before the screenshot date must be re-reviewed and shipped in a
new frozen corpus before App Store screenshots that show those facts.

The existing fail-closed freshness rules stay. Combined release does not
loosen them so Practice can look more capable.

`monitor:knowledge` remains propose-only.

## App Store listing contract

| Field | First-release rule |
|---|---|
| Name | `Hong Kong Buddy` (≤ 30 characters) |
| Subtitle | Campus and Cantonese for students — no “Official HKBU”, no “tone trainer” |
| Category | Education |
| Age | From the questionnaire; not Kids Category |
| Privacy policy URL | Production `/legal/privacy` |
| Support URL | Production `/legal/support` |
| Screenshots | Combined tabs: Today, Campus citation, Practice, Translate. No legacy V2 shots, no 2.0 memory mockups |
| Review notes | Guest app, no login; demo the four tabs; voice optional; AI/HKBU disclosure location |
| Export compliance | Standard HTTPS exemption |
| IAP | None |

Store screenshots are taken from the exact TestFlight build, not Safari.

## Windows-to-iOS delivery

```text
Windows workstation
  -> production-v1 web UI, API, tests, Capacitor config, plugin sources
Hosted macOS CI (Xcode 26)
  -> cap sync, archive, sign, upload
Physical iPhone
  -> Safari voice evidence, then TestFlight voice + interruption matrix
App Store Connect (browser)
  -> listing, labels, submit
```

Physical iPhone evidence is an external gate. A cloud Mac cannot prove
incoming-call interruption, Bluetooth route changes, or lock-screen recording
loss.

Required device matrix before submit:

- one current iPhone on a current iOS 26.x;
- permission denied / granted / revoked;
- incoming call, Siri, headphone removal during record and during playback;
- background, lock, force-quit, reopen;
- Wi-Fi loss during upload and Wi-Fi to cellular;
- double Send / Retry;
- Clear conversation during transcription;
- 55-second auto-stop.

`V1_IOS_VOICE_ACCEPTANCE_FILE` remains the Safari gate. Combined release adds
`V1_IOS_TESTFLIGHT_VOICE_ACCEPTANCE_FILE` bound to the signed build’s bundle
id, version, and commit. Production `voiceInput` in the App Store binary
requires both.

## Acceptance gates

The release is App Store-submittable only when all of the following are true
for the same frozen commit:

1. **One promise** — listing, icon, and first screen describe the combined
   unofficial companion actually implemented.
2. **Consent** — first send is blocked without AI consent; voice is optional;
   legal URLs load; packet capture matches the policy.
3. **Campus** — grounded or honestly unverified; overdue claims fail closed;
   emergency routing still fires.
4. **Practice** — teaching and free talk deliver Cantonese replies; Correct Me
   works; no campus retriever on practice turns; no autoplay.
5. **Translate** — four directions, auto-route, Jyutping, confirmation, no
   romanization TTS.
6. **Deletion** — Clear removes campus, practice, and visit media through the
   existing outbox; documented backup exception is in the policy.
7. **iOS binary** — signed TestFlight build, iOS 26 SDK, privacy manifest,
   microphone string, native tabs.
8. **Device voice** — Safari evidence and TestFlight evidence both current;
   native WAV plugin shipped if WKWebView normalize failed.
9. **Localization / a11y** — consent, errors, and deletion in three
   languages; VoiceOver text path recorded.
10. **Ops** — existing single-instance readiness still green; new routes
    covered by rate limits; knowledge snapshot re-reviewed for screenshot
    claims.

## Out of scope

- Apple Developer Program enrolment, D-U-N-S, banking, and tax
- HKBU trademark licence negotiation (flagged, not implemented)
- Accounts, Sign in with Apple, in-app account deletion
- In-app purchases or paid tutoring
- 2.0 memory, recommendations, proactivity
- Tone / GOP pronunciation scoring
- Azure, MiniMax, or HKBU GenAI inside this app
- Android
- Changing the live Azure legacy app
- Multi-instance Cloud Run
- Claiming data residency or zero provider retention

## Relationship to existing V1 rules

Unless this document explicitly replaces a rule, V1 remains binding:

- text is canonical;
- no fake presence;
- one Cloud Run instance;
- ADC-only Google providers;
- 30-day inactivity and 7-day media retention;
- fail-closed production readiness;
- no secrets in git;
- guest cookie identity.

This release replaces only the “one screen, no mode picker” product-isolation
rule, and only by adding Today, Practice, Translate, and legal surfaces around
the existing Campus messenger.
