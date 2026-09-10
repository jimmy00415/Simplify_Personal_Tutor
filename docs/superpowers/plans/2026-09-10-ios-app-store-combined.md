# Hong Kong Buddy Combined iOS App Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for every behavior change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Production V1 into one unofficial HKBU student iPhone app: grounded campus chat plus ported Practice, Translate, Today, and Phrasebook, with App Store-grade consent, legal pages, and a Capacitor shell that can be signed on hosted macOS.

**Architecture:** Keep the V1 Express monolith, guest cookie, PostgreSQL, GCS media, Vertex/STT/TTS, safety router, and fail-closed campus answer path. Add server-authoritative AI/voice consent, a second `practice` conversation per session, visit-turn persistence, tutor and visit services that must not use the campus retriever, a four-tab web shell, hosted `/legal/*` pages, and a Capacitor iOS project generated in CI. Legacy Azure stays frozen.

**Tech Stack:** Node.js 22 ESM, Express 5, PostgreSQL 16, existing V1 Google providers, vanilla HTML/CSS/JS, Capacitor 7, optional native Swift WAV plugin, Codemagic (or equivalent) with Xcode 26, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-ios-app-store-combined-design.md`

## Global Constraints

- Work on `feat/production-v1-ai-senior` (or a branch created from it). Do not modify `frontend/`, `backend/`, `backend/public/`, the Azure workflow, or `hkbuddy-pilot-0630`.
- Copy legacy static data (phrasebook, cultural context, visit fallbacks) into `production-v1/` and treat the copies as V1-owned. Do not HTTP-call the legacy API from V1 or iOS.
- Never print, commit, or persist secrets, signing certificates, App Store Connect API keys, transcripts, audio, or provider bodies.
- Text is canonical. TTS never autoplays. Practice and Campus remain separate answer paths. `routeSafety` runs first on all free-form text.
- A campus claim is `verified` only under the existing evidence-ID rules. Practice must not attach the HKBU corpus.
- Production still requires ADC-only Google providers, single-instance policy, approved privacy notice, and existing readiness gates.
- Use `npm.cmd` on this Windows host. Follow red-green-refactor. Record the failing test before implementation.
- Do not merge, push, deploy, or submit to App Store Connect during a task unless the operator explicitly asks.
- Physical iPhone Safari and TestFlight voice passes are external gates. Do not waive them in code to go green.
- Uploads must target the iOS 26 SDK on hosted macOS. The Windows machine does not run the iOS Simulator.

---

## Planned File Structure

```text
production-v1/
  migrations/002_ios_combined.sql
  data/culture/cantonese-culture.json
  data/visit/visit-fallback.json
  public/
    index.html
    app-shell.js
    today-view.js
    practice-view.js
    visit-view.js
    phrasebook-view.js
    consent-controller.js
    legal-copy.js
    content/playbooks.js
    legal/privacy.html
    legal/support.html
    chat-copy.js
  src/
    http/consent.js
    http/practice.js
    http/visit.js
    http/legal.js
    services/tutor.js
    services/visit-translation.js
    services/consent.js
  ios-app/
    capacitor.config.ts
    package.json
    plugins/native-wav/
    resources/
    PrivacyInfo.xcprivacy
    Info.plist.tpl
    ci/codemagic.yaml
  tests/
    consent-api.test.js
    practice-api.test.js
    tutor-service.test.js
    visit-api.test.js
    visit-translation.test.js
    combined-ui-contract.test.js
    legal-pages.test.js
    ios-app-contract.test.js
docs/superpowers/specs/2026-09-10-ios-app-store-combined-design.md
docs/app-store/listing-draft.md
```

Existing V1 files are modified in place. Do not create a second Express app.

---

## Task 1: Hosted legal pages and first-use AI consent

**Files:**

- Create: `production-v1/public/legal/privacy.html`
- Create: `production-v1/public/legal/support.html`
- Create: `production-v1/src/http/legal.js`
- Create: `production-v1/src/http/consent.js`
- Create: `production-v1/src/services/consent.js`
- Create: `production-v1/migrations/002_ios_combined.sql` (consent columns first; conversation/visit tables may land in Task 2 if split, but prefer one migration)
- Create: `production-v1/tests/legal-pages.test.js`
- Create: `production-v1/tests/consent-api.test.js`
- Modify: `production-v1/src/app.js`
- Modify: `production-v1/src/http/session.js`
- Modify: `production-v1/src/stores/postgres-store.js`
- Modify: `production-v1/src/stores/atomic-file-store.js`
- Modify: `production-v1/src/stores/store-contract.js`
- Modify: `production-v1/src/config.js`
- Modify: `production-v1/public/index.html`
- Modify: `production-v1/public/app.js`
- Modify: `production-v1/tests/session-api.test.js`
- Modify: `production-v1/tests/ui-contract.test.js`

**Interfaces:**

- `POST /api/v1/consent` body `{ kinds: ["ai"] | ["ai","voice"], version }`
- `DELETE /api/v1/consent/voice`
- Session bootstrap includes `consent` and refuses mutating campus sends with `403 AI_CONSENT_REQUIRED` until AI consent matches `V1_PRIVACY_NOTICE_VERSION`
- `GET /legal/privacy` and `GET /legal/support` are static, no auth, no session write

- [ ] **Step 1: Write failing legal and consent tests.** Assert privacy HTML names Vertex, Speech-to-Text, Text-to-Speech, `asia-east2`, `asia-southeast1`, and global Gemini; forbids “stays in Hong Kong” and “never retained”; support page has a contact path. Assert a text send before consent is 403; after `POST /consent` `{ kinds: ["ai"] }` a text send is accepted; voice transcription without voice consent is 403; withdrawing voice leaves text working.

- [ ] **Step 2: Confirm red.**

  ```powershell
  cd production-v1
  node --test tests/legal-pages.test.js tests/consent-api.test.js
  ```

  Expected: FAIL because routes, columns, and pages do not exist.

- [ ] **Step 3: Add migration columns and store methods** `recordConsent`, `withdrawVoiceConsent`, `getConsent`. Bump default `V1_PRIVACY_NOTICE_VERSION` example to `2026-09-10-ios-combined`.

- [ ] **Step 4: Implement legal static routes and consent HTTP.** Gate existing `POST /api/v1/messages` and `POST /api/v1/voice/transcriptions`. Do not require consent for `GET /legal/*` or `GET /api/health/*`.

- [ ] **Step 5: Add the first-run AI disclosure dialog** in the web client. Continue/Leave. Voice remains a later sheet. Link both legal URLs. Cover English, 廣東話, and 普通話.

- [ ] **Step 6: Verify green.**

  ```powershell
  npm.cmd test -- --test-name-pattern="legal|consent|session-api|ui-contract"
  npm.cmd run check
  ```

- [ ] **Step 7: Commit.** `feat(v1): add App Store consent and hosted legal pages`

---

## Task 2: Practice conversation, tutor service, and Correct Me

**Files:**

- Modify: `production-v1/migrations/002_ios_combined.sql` (conversation `kind`, drop single-conversation unique)
- Create: `production-v1/src/services/tutor.js`
- Create: `production-v1/src/http/practice.js`
- Create: `production-v1/data/culture/cantonese-culture.json` (copy, then trim to V1-owned JSON)
- Create: `production-v1/tests/tutor-service.test.js`
- Create: `production-v1/tests/practice-api.test.js`
- Modify: `production-v1/src/stores/postgres-store.js`
- Modify: `production-v1/src/stores/atomic-file-store.js`
- Modify: `production-v1/src/stores/store-contract.js`
- Modify: `production-v1/src/services/turn-processor.js`
- Modify: `production-v1/src/services/dispatcher.js`
- Modify: `production-v1/src/app.js`
- Modify: `production-v1/src/services/retention.js`
- Modify: `production-v1/tests/retention.test.js`

**Interfaces:**

- `conversations.kind` is `campus | practice`; `UNIQUE (session_id, kind)`
- `createTutorService({ llmProvider, culture, safety })`
- `POST /api/v1/practice/messages` 202 + dispatcher; payload `{ text, voiceDraftId, clientMessageId, scenario, mode }`
- `POST /api/v1/practice/correct` on last student utterance
- Tutor prompt never includes campus evidence snapshots

- [ ] **Step 1: Write failing tutor and practice tests.** Deterministic LLM fixture returns JSON. Assert teaching vs freeChat system prompts differ; cultural snippet may be attached; safety emergency bypasses the model; parser rejects campus `evidenceIds` if the model invents them; practice send without AI consent is 403; campus `GET /messages` does not include practice turns.

- [ ] **Step 2: Confirm red.**

  ```powershell
  node --test tests/tutor-service.test.js tests/practice-api.test.js
  ```

- [ ] **Step 3: Implement store changes.** Existing sessions get a `campus` kind backfill. Bootstrap still returns the campus conversation as the default timeline.

- [ ] **Step 4: Implement `createTutorService` and practice HTTP.** Reuse leases, idempotency hash, SSE, rate-limit buckets named `practice-message` and `practice-correct`.

- [ ] **Step 5: Extend Clear / retention** so practice messages and media delete with the session.

- [ ] **Step 6: Verify green.**

  ```powershell
  npm.cmd test -- --test-name-pattern="tutor|practice|retention|session-api"
  npm.cmd run check
  ```

- [ ] **Step 7: Commit.** `feat(v1): add practice tutor path beside campus chat`

---

## Task 3: Visit translation API

**Files:**

- Create: `production-v1/src/services/visit-translation.js`
- Create: `production-v1/src/http/visit.js`
- Create: `production-v1/data/visit/visit-fallback.json` or ported JS module under `src/knowledge/`
- Create: `production-v1/tests/visit-translation.test.js`
- Create: `production-v1/tests/visit-api.test.js`
- Modify: `production-v1/migrations/002_ios_combined.sql` (`visit_turns`)
- Modify: stores, `app.js`, retention, rate limits

**Interfaces:**

- `POST /api/v1/visit-translate` `{ sourceText, direction, voiceDraftId, clientTurnId, inputType, userJob }`
- Directions: `yue_to_en | yue_to_zh | en_to_yue | zh_to_yue`
- Response includes `translatedText`, `displayText`, `romanization`, `autoRouted`, `routeReason`, `needsConfirmation`, `provider`
- Rule fallback before Vertex; mock/staff-confirm last; no Azure Translator

- [ ] **Step 1: Write failing visit tests.** Cover the four directions, English-in-resident auto-route, rule-based hit without LLM, romanization-like TTS suppression, consent 403, idempotent `clientTurnId`, safety emergency.

- [ ] **Step 2: Confirm red.**

  ```powershell
  node --test tests/visit-translation.test.js tests/visit-api.test.js
  ```

- [ ] **Step 3: Port fallback/routing logic into V1-owned modules.** Do not import from `backend/services/*` at runtime.

- [ ] **Step 4: Implement persistence, rate limit `visit-translate`, and session delete cascade.**

- [ ] **Step 5: Optional Cantonese TTS** through the existing media generation path, explicit Play only.

- [ ] **Step 6: Verify green.**

  ```powershell
  npm.cmd test -- --test-name-pattern="visit|consent|retention"
  npm.cmd run check
  ```

- [ ] **Step 7: Commit.** `feat(v1): add visit translation on the guest session`

---

## Task 4: Combined four-tab web shell

**Files:**

- Create: `production-v1/public/app-shell.js`
- Create: `production-v1/public/today-view.js`
- Create: `production-v1/public/practice-view.js`
- Create: `production-v1/public/visit-view.js`
- Create: `production-v1/public/phrasebook-view.js`
- Create: `production-v1/public/consent-controller.js`
- Create: `production-v1/public/content/playbooks.js`
- Create: `production-v1/tests/combined-ui-contract.test.js`
- Modify: `production-v1/public/index.html`
- Modify: `production-v1/public/styles.css`
- Modify: `production-v1/public/app.js`
- Modify: `production-v1/public/chat-copy.js`
- Modify: `production-v1/public/manifest.webmanifest`
- Modify: `production-v1/tests/ui-contract.test.js`

**Interfaces:**

- Tab bar: Today, Campus, Practice, Translate
- Phrasebook and Privacy are sheets
- Campus existing modules keep working inside the Campus tab
- Habit state key `hk-buddy:v1.1:habitState`
- Manifest name/description match the combined promise

- [ ] **Step 1: Write failing UI contract tests.** Assert four tabs, first-run AI dialog before send, legal links, no Azure Speech SDK script tags, no autoplay audio attributes, Practice mode toggle, six scenario labels, visit job cards, phrasebook offline JSON, copy for consent/errors/deletion in all three languages, 44 px targets, safe-area CSS.

- [ ] **Step 2: Confirm red.**

  ```powershell
  node --test tests/combined-ui-contract.test.js tests/ui-contract.test.js
  ```

- [ ] **Step 3: Implement the shell around the existing Campus messenger.** Do not rewrite timeline/voice modules; mount them on the Campus tab.

- [ ] **Step 4: Implement Today, Practice, Translate, Phrasebook views** against the new APIs. First successful practice delivery calls `markHabitPractised`.

- [ ] **Step 5: Update welcome/listing-facing copy** so the header can say “Campus and Cantonese companion” while Campus keeps “AI assistant, not official HKBU.”

- [ ] **Step 6: Verify green.**

  ```powershell
  npm.cmd test -- --test-name-pattern="ui-contract|combined-ui"
  npm.cmd run check
  ```

- [ ] **Step 7: Commit.** `feat(v1): add Today Practice Translate shell`

---

## Task 5: Capacitor iOS shell, privacy manifest, and CI archive

**Files:**

- Create: `production-v1/ios-app/capacitor.config.ts`
- Create: `production-v1/ios-app/package.json`
- Create: `production-v1/ios-app/Info.plist.tpl`
- Create: `production-v1/ios-app/PrivacyInfo.xcprivacy`
- Create: `production-v1/ios-app/ci/codemagic.yaml`
- Create: `production-v1/ios-app/plugins/native-wav/` (interface + failing Swift stub is enough until Task 6)
- Create: `production-v1/tests/ios-app-contract.test.js`
- Create: `docs/app-store/listing-draft.md`
- Modify: `production-v1/package.json` (script `ios:sync` documentation only if it does not require Xcode on Windows)

**Interfaces:**

- `appId` `com.simplify.hongkongbuddy` (change only if the operator supplies another bundle id)
- `server.url` is unset for bundled UI; API origin is `V1_PUBLIC_ORIGIN`
- `NSMicrophoneUsageDescription` states optional voice-message transcription
- Privacy manifest matches Other User Content, Audio Data, User ID
- Codemagic workflow: Node 22, `npx cap sync ios`, Xcode 26, archive, upload TestFlight

- [ ] **Step 1: Write failing iOS contract tests.** Read committed templates; assert microphone string, no camera/location keys, privacy manifest data types, Capacitor config hostname allowlist equals production origin pattern, CI yaml mentions `IPHONEOS_DEPLOYMENT_TARGET` and iOS 26 SDK, listing draft forbids official-HKBU and tone-scoring claims.

- [ ] **Step 2: Confirm red.**

  ```powershell
  node --test tests/ios-app-contract.test.js
  ```

- [ ] **Step 3: Author Capacitor config, plist template, privacy manifest, listing draft, and CI yaml.** Do not commit certificates. Document the hosted-Mac commands in `production-v1/ios-app/README.md`.

- [ ] **Step 4: Verify green.**

  ```powershell
  node --test tests/ios-app-contract.test.js tests/legal-pages.test.js
  npm.cmd run check
  ```

- [ ] **Step 5: Commit.** `feat(v1): add Capacitor iOS shell contracts`

Windows cannot run `cap add ios` successfully without a Mac. The Xcode project is CI-generated and gitignored unless the operator later chooses to commit it from a Mac checkout.

---

## Task 6: Voice on device — Safari gate, then TestFlight, native WAV if needed

**Files:**

- Modify: `production-v1/public/voice-capture.js` (feature-detect native plugin)
- Create: `production-v1/ios-app/plugins/native-wav/` complete implementation when the WKWebView gate fails
- Modify: `production-v1/scripts/ios-voice-evidence.js` or add `scripts/ios-testflight-voice-evidence.js`
- Modify: `production-v1/src/config.js` (`V1_IOS_TESTFLIGHT_VOICE_ACCEPTANCE_FILE`)
- Modify: `production-v1/tests/voice-evidence.test.js`
- Modify: `production-v1/README.md`

**Interfaces:**

- Safari evidence contract unchanged
- TestFlight evidence binds `bundleId`, `cfBundleVersion`, `commitSha`, `normalizerSource` `web-audio | native-wav-v1`
- Production App Store `voiceInput` requires both evidence files

- [ ] **Step 1: Write failing evidence tests** for the TestFlight record schema and the dual-gate production capability.

- [ ] **Step 2: Confirm red, then implement schema/config only.** Do not fake a device pass.

- [ ] **Step 3: Operator — Safari.** Run the existing real-iPhone Safari acceptance on the combined web UI. Record the ignored evidence file. If this fails, stop. Do not wrap.

- [ ] **Step 4: Operator — hosted Mac.** CI produces a TestFlight build. Install on the same iPhone. Repeat record / normalize / transcribe / edit / send / generate / play, plus the interruption matrix in the spec.

- [ ] **Step 5: If WKWebView normalize is silent or throws,** implement the native WAV plugin to the canonical contract and re-run Step 4. Do not lower the WAV spec.

- [ ] **Step 6: Bind both evidence files in the release manifest.** Missing TestFlight evidence keeps App Store `voiceInput` false; text remains usable.

- [ ] **Step 7: Commit schema/plugin/docs only.** `feat(v1): add TestFlight voice evidence gate`

---

## Task 7: Localization, report-answer, and knowledge screenshot gate

**Files:**

- Modify: `production-v1/public/chat-copy.js` and new view copy modules
- Modify: `production-v1/public/index.html` (report control)
- Create: `production-v1/src/http/report.js` (minimal)
- Create: `production-v1/tests/report-api.test.js`
- Modify: `production-v1/data/knowledge/hkbu-v1.json` only after a knowledge owner reviews overdue claims
- Modify: `production-v1/tests/knowledge.test.js` if snapshot counts/dates change
- Modify: `docs/app-store/listing-draft.md` screenshot checklist

- [ ] **Step 1: Write failing tests** that every user-visible error, consent, deletion, and voice status string exists for `en`, `yue-Hant-HK`, and `cmn-Hans-CN`. Assert assistant bubbles have a Report action; `POST /api/v1/reports` stores id/kind/reason only.

- [ ] **Step 2: Implement copy + report endpoint.**

- [ ] **Step 3: Knowledge owner re-reviews claims whose `reviewAfter` is past.** Ship a new snapshot or accept fail-closed unverified answers. Do not screenshot stale student-card dates.

- [ ] **Step 4: Verify green.**

  ```powershell
  npm.cmd test -- --test-name-pattern="combined-ui|report|knowledge"
  npm.cmd run check
  ```

- [ ] **Step 5: Commit.** `feat(v1): localize launch chrome and add answer reporting`

---

## Task 8: Freeze, TestFlight acceptance, App Store submit checklist

**Files:**

- Modify: `production-v1/README.md` (combined launch gates)
- Create: `docs/app-store/submit-checklist.md`

This task is mostly operator evidence. Engineering only writes the checklist and refuses to mark voice ready without the files.

- [ ] **Step 1: Write `docs/app-store/submit-checklist.md`** with the ten acceptance gates from the spec, plus App Store Connect fields (privacy labels, age answers, review notes, HTTPS export).

- [ ] **Step 2: Run the full V1 suite on Windows** with the documented Task 8 Playwright harness if available. If the D: harness is missing, record it as an outstanding external gate; do not weaken it.

  ```powershell
  cd production-v1
  npm.cmd run check
  npm.cmd test
  npm.cmd run security:dependencies
  ```

- [ ] **Step 3: Operator completes TestFlight matrix** on the physical iPhone. Attach ignored evidence. Confirm packet capture matches `/legal/privacy`.

- [ ] **Step 4: Operator fills App Store Connect** from `docs/app-store/listing-draft.md`. Screenshots from the TestFlight build only.

- [ ] **Step 5: Submit only when every spec gate is evidenced.** Apple approval is not claimed by a green CI job.

- [ ] **Step 6: Commit checklist/README.** `docs(v1): add App Store submit checklist`

---

## External gates (not waivable in code)

- Physical iPhone for Safari and TestFlight voice
- Hosted macOS with Xcode 26 for signing
- Apple Developer Program and App Store Connect access (operator)
- Knowledge-owner corpus review before time-sensitive screenshots
- HKBU naming authorization if the subtitle keeps “HKBU”
- Vertex cache / abuse-log settings before any “not retained” or “not used for training” sentence beyond the current cautious policy

## Done when

The same frozen commit has: hosted legal pages, versioned consent, practice and visit APIs, four-tab UI, Capacitor/CI contracts, dual iOS voice evidence (or voice capability off), localized chrome, report control, listing/checklist docs, and a green `npm.cmd check` plus focused tests. Legacy Azure is untouched. No 2.0 memory and no second backend.
