# App Store submit checklist

Engineering can go green without these. Submission cannot.

## Product gates

1. Hosted `/legal/privacy` and `/legal/support` match the live processors and regions.
2. First-run AI consent is recorded before campus, practice, or visit sends.
3. Practice and visit never use the campus retriever.
4. Text is canonical. TTS never autoplays.
5. Safari real-iPhone voice evidence is bound (`V1_IOS_VOICE_ACCEPTANCE_FILE`).
6. TestFlight real-iPhone voice evidence is bound (`V1_IOS_TESTFLIGHT_VOICE_ACCEPTANCE_FILE`). Missing either file keeps App Store `iosAppStoreVoiceInput` false.
7. Knowledge owner re-reviews claims whose `reviewAfter` is past, or accept fail-closed unverified answers. Do not screenshot overdue student-card dates.
8. Packet capture on device matches the privacy notice (Vertex global, STT/TTS `asia-southeast1`, API `asia-east2`).
9. App Store Connect privacy labels, age answers, and review notes are filled from `docs/app-store/listing-draft.md`.
10. HTTPS export / encryption answer is consistent with ATS and TLS only.

## Windows suite (this repo)

```powershell
cd production-v1
npm.cmd run check
npm.cmd test
npm.cmd run security:dependencies
```

The controlled Playwright harness at `D:\VS_PROJECT\Testing\HongKong_Buddy` is present on this Windows workstation. Use the README Task 8 `PLAYWRIGHT_BROWSERS_PATH` / `TEMP` / `TMP` roots when running the full suite for a release freeze. Do not weaken that contract. If those roots are missing on another machine, record Task 8 as an outstanding external gate.

Recorded on this workstation (2026-09-10), not waivers:

- Focused combined product tests and `npm.cmd run check` are green.
- A one-process `npm.cmd test` still hits pre-existing unref event-loop cancellations in `gcp-infra-contract` / `voice-media`, plus Cloud SDK bundled-Python tests in `latency-acceptance`.
- `npm.cmd run security:dependencies` returned `DEPENDENCY_AUDIT_NOT_ALLOWED` because live `npm audit --omit=dev` no longer matches the pinned two-moderate exception. Do not `npm audit fix` or loosen the gate here.
- Task 8 Playwright must be run with the exact D: browser/temp roots. Apple/TestFlight/Xcode 26 remain operator-only.

## Operator-only

- Physical iPhone Safari pass
- Hosted macOS Xcode 26 archive and TestFlight
- Apple Developer Program / App Store Connect access
- Apply `002_ios_combined.sql` before enabling `V1_REQUIRE_AI_CONSENT` or `V1_PRIVACY_NOTICE_VERSION=2026-09-10-ios-combined` on Cloud Run

Apple approval is not claimed by a green CI job.
