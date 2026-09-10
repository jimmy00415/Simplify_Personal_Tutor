# Hong Kong Buddy Production V1

Production V1 is a mobile-first, text-primary HKBU senior chat. Voice behaves like
a WeChat/WhatsApp voice message: the student records, reviews the transcript, and
sends it as one normal chat message. Intrinsically voice-mode assistant replies may
prepare optional AI voice automatically; normal text-mode replies generate voice
only after the student explicitly taps **Generate voice**. Text is always the durable
primary answer, and playback never starts before an explicit **Play** action.

This directory is isolated from the legacy application. It has its own runtime,
storage drivers, release evidence, reports, and deployment boundary. Do not point
it at the legacy app, legacy PostgreSQL database, or legacy Blob container.

## Cross-machine handoff — 2026-09-01

This handoff separates code readiness from live GCP state. The branch to resume
is `feat/production-v1-ai-senior`. Resolve and record its current commit with
`git rev-parse HEAD` after pulling; release artifacts must use that clean,
committed SHA and must not use an older local checkout.

### Last confirmed live boundary

- The selected host remains the shared GCP project
  `motion-expert-hk-ltd-webpage` (`582852715831`) and the verified operations
  email channel is
  `projects/motion-expert-hk-ltd-webpage/notificationChannels/5363602469320935089`.
- The V1 budget and alert policies, Artifact Registry repository, five service
  accounts, acceptance metadata-reader custom role, VPC/subnet/PSA connection,
  private HA PostgreSQL 16 instance and `hkbuddy_v1` database, both V1 buckets,
  and all ten empty Secret containers were created and read back in earlier
  guarded runs.
- The latest confirmed provision attempt stopped with
  `POST_CREATE_READBACK_FAILED` at `bucket-iam-baseline`. The media bucket had
  accepted the IAM-policy write, after which the fixed operator lost effective
  `storage.buckets.get`, `getIamPolicy`, and `setIamPolicy`; the build-source
  bucket still had those three permissions through its generated convenience
  bindings. No Secret version or `hkbuddy_app` / `hkbuddy_migrator` database
  user was created.
- The branch now contains a TDD-covered recovery: an exact three-permission
  custom role plus one permanent project IAM binding whose condition is limited
  to the two exact V1 bucket resource names. It runs before the full provision
  audit, restores access without project-wide Storage Admin, then sanitizes both
  local bucket policies. **That recovery code has not yet been executed live.**
- No V1 Cloud Run Job, private candidate service, stable service, public V1 URL,
  or production QR code exists. The legacy Azure app
  `hkbuddy-pilot-0630` was not modified.
- The original workstation's gcloud refresh token required reauthentication
  before this handoff could take a final fresh inventory. Treat the bullets
  above as the last confirmed snapshot and re-run the read-only preflight on the
  new computer before accepting them as current.

### Resume on the new computer

From a fresh clone:

```powershell
git switch feat/production-v1-ai-senior
git pull --ff-only
cd production-v1
npm ci
$controlledBrowserRoot = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\playwright'
$controlledTempRoot = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\temp'
$controlledTmpRoot = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\tmp'
New-Item -ItemType Directory -Force -Path $controlledBrowserRoot, $controlledTempRoot, $controlledTmpRoot | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = $controlledBrowserRoot
$env:TEMP = $controlledTempRoot
$env:TMP = $controlledTmpRoot
node node_modules/playwright/cli.js install chromium
npm run check
npm test
npm run security:dependencies
git status --short
```

The test and security commands must finish successfully and `git status` must
be empty before creating a frozen release archive. The full Task 8 browser
evidence suite intentionally binds itself to the exact controlled `D:` browser
cache and task-owned temporary roots above. A generic clone, or a computer
without that `D:` path, cannot claim full `npm test` PASS. Do not weaken or skip
that contract: focused GCP or release tests are useful diagnostics but are not a
substitute for the full release gate. If the harness cannot be reproduced,
record Task 8 as an outstanding external release gate.

On Windows, create a separate Cloud SDK configuration and authenticate the
fixed human operator again:

```powershell
$env:CLOUDSDK_CONFIG = Join-Path $env:LOCALAPPDATA 'gcloud-hkbuddy-production-v1'
New-Item -ItemType Directory -Force -Path $env:CLOUDSDK_CONFIG | Out-Null
gcloud auth login admin@motionexp.com
gcloud config set account admin@motionexp.com
gcloud config set project motion-expert-hk-ltd-webpage
gcloud auth list --filter=status:ACTIVE
gcloud config get-value project
```

Do not copy the old gcloud directory or reuse any pasted OAuth/verification
code. Do not set impersonation, access-token-file, or credential-file overrides.
Capture the read-only preflight first, but expect it may currently fail with
`PREFLIGHT_INVENTORY_INVALID` when it reaches the known locked media-bucket IAM
read. That expected failure is a snapshot, not permission to repair anything
manually and not evidence that the rest of the inventory passed. Then use only
the one exact confirmed resume command:

```powershell
npm run gcp:preflight -- --notification-channel=projects/motion-expert-hk-ltd-webpage/notificationChannels/5363602469320935089

npm run gcp:provision -- --confirm-project=motion-expert-hk-ltd-webpage --notification-channel=projects/motion-expert-hk-ltd-webpage/notificationChannels/5363602469320935089
```

The confirmed command may first create the narrow operator bucket-IAM role and
conditioned binding, then wait for Google IAM propagation. If it returns
`OPERATOR_BUCKET_IAM_PROPAGATION_TIMEOUT`, preserve the resources, wait, and run
the same command again; do not add `roles/storage.admin`, restore legacy
convenience bindings, delete either bucket, or create credentials manually.
For any other failure, record the JSON `code`, `mutationPerformed`, `completed`,
and `resumeBoundary`, perform read-only inspection, and fix the proven cause
before retrying.

After `GCP_PROVISION_COMPLETE`, continue the guarded release phases documented
in `infra/gcp/README.md`. The remaining external gates are still explicit:
owner confirmation of the legacy-resource inventory, a real iPhone Safari voice
evidence bundle, a 30-file multilingual canonical-WAV latency manifest, private
candidate acceptance, and final stable promotion. Generate and deliver a QR
only after the stable URL passes live text, voice, readiness, privacy, and mobile
acceptance.

## Local product preview

From `production-v1/`:

```powershell
$env:ENV_FILE='..\backend\.env'
npm.cmd start
```

The local default origin is `http://localhost:3000`. Set `V1_PUBLIC_ORIGIN` when
using another port or a LAN IP. Local mode uses the atomic JSON store and local
private media directory. It is a product preview, not a campus-distribution or
production-readiness result.

Useful local checks:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run readiness
```

Local readiness intentionally exits nonzero with the boundary
`local-preview-only`. It must never be reported as production-ready.

## Production topology and runtime gate

V1 runs as one new application replica behind HTTPS:

- Node/Express serves the chat UI, API, dispatcher, and SSE updates.
- A new PostgreSQL resource stores sessions, conversations, turns, event replay,
  quotas, media ownership, deletion outbox, and durable worker state.
- The private `hkbuddy-v1-582852715831-media` GCS bucket stores opaque
  voice/TTS attempt objects with uniform bucket-level access and public-access
  prevention.
- The reviewed HKBU corpus in `data/knowledge/hkbu-v1.json` is the grounding
  boundary; only allowlisted official HKBU sources can support verified claims.
- One real LLM provider is required. ASR and TTS are separately configured and
  separately release-evidenced capabilities.
- The GCP release selectors are `vertex-ai`, `google-stt-v2`, and `google-tts`.
  All three share Application Default Credentials from the attached Cloud Run
  runtime service account. API keys, access-token settings, credential JSON,
  and credential-file paths are rejected.

The production resource island is fixed to the already billed shared host
project `motion-expert-hk-ltd-webpage` (`582852715831`): Artifact Registry
repository `hkbuddy-v1`, public stable Cloud Run service `hkbuddy-v1-api`,
private candidate Cloud Run service `hkbuddy-v1-api-candidate`, Cloud SQL instance
`hkbuddy-v1-pg` with database `hkbuddy_v1`, VPC `hkbuddy-v1-vpc`, subnet
`hkbuddy-v1-ae2-run`, PSA range `hkbuddy-v1-google-services`, and the exact
regional private lifecycle-bounded Cloud Build source bucket
`hkbuddy-v1-582852715831-build-source`, plus the exact `hkbuddy-v1-*` service
accounts, secrets, and Jobs in
`infra/gcp/resource-contract.json`. The application resource island is
dedicated, but project API enablement, quota, billing, audit logs, and the
project IAM boundary are shared.

The default VPC and its subnets, protected baseline IAM, existing data, and all
unrelated services are read-only inventory. Provisioning never attaches to,
updates, peers, deletes, renames, repairs, or adopts them. A same-name resource
with foreign ownership or any protected-state drift stops before mutation. The
earlier dedicated-project creation and billing-link procedure is superseded;
operators must not create or relink a project for this release.

Production does not listen on a port until the first retention run succeeds and
all six live checks are ready: database, private media, corpus, retention,
dispatcher, and single-instance runtime. Configuration and release evidence are
validated before opening PostgreSQL or GCS. The LLM smoke artifact is also
validated before startup and re-read on every readiness evaluation; readiness
never calls the provider. There is no production fallback to the local drivers
or deterministic model.

## Governed HKBU knowledge boundary

The 2026-08-26 snapshot contains exactly 29 manually reviewed first-party HKBU
page sources, 61 atomic claims, and 19 closed intent groups. At the snapshot
review instant, 56 claims are supportable, four historical/conflicted claims are
quarantined, and one future-dated library claim is not yet valid. A source count
is not permission to answer: each claim must also pass its own verification,
validity, review, query-scope, and clarification gates.

Normal answers never run a web search. Verified citations come only from the
bundled reviewed corpus. An official directory used to hand a student to the
right office is rendered as a separate handoff card, never as factual evidence.
Inventory, listed-hours, and programme-scope claims cannot establish current
availability; conflicted or overdue facts fail closed.

The following remain deliberately excluded or unconfirmed:

- the Cantonese Peer Tutoring current-semester offer, because the current English
  route fails and the located schedule is still 2025/26;
- `lc.hkbu.edu.hk` and `www.hkbu.edu.hk`, which are not V1 allowlisted hosts;
- current opening status for Nan Yuan and H.F.C.@Scholars Court pending a newer,
  internally consistent Estates Office update;
- general bedding-purchase, grocery, SIM-card vendor, price, brand, and shopping
  recommendations. NTTIH bedding is only a reviewed room inclusion; the Welfare
  Shop claim covers only its reviewed categories.

The monitor-only command fetches only validated canonical corpus URLs and emits
safe digests and review candidates. It never edits attestations or promotes web
content:

```powershell
npm.cmd run monitor:knowledge -- --baseline-file C:\absolute\reviewed-baseline.json
```

The baseline is a knowledge-owner-reviewed JSON object that maps every exact
corpus `sourceId` to its lowercase SHA-256 content digest, with no missing or
extra keys. A missing, relative, malformed, or incomplete baseline fails before
any network request. A content change, fetch failure, conflict, expiry, or
overdue review produces a non-green/unknown candidate and a nonzero exit. A
knowledge owner must compare the safe output, manually reopen the first-party
page, and ship any approved corpus change through a new frozen release.

After startup, one low-frequency single-flight watchdog owns live dependency
evaluation. A red result pauses turn dispatch and rejects every state-changing
API request with `503`; a later green result resumes both. Public
`GET /api/health/ready` serves only the watchdog's sanitized cache, so repeated
public probes never create PostgreSQL or GCS traffic.

## Production setting names

Store secrets only in the new app's secret manager/environment. Never commit
values. The production boundary uses these setting names:

- HTTP/runtime: `NODE_ENV`, `PORT`, `V1_PUBLIC_ORIGIN`, `V1_SESSION_SECRET`,
  `V1_TRUST_PROXY_HOPS`, `V1_INSTANCE_POLICY`
- PostgreSQL: `V1_STORE_DRIVER`, `V1_DATABASE_URL`,
  `V1_POSTGRES_RESOURCE_ID`
- private GCS: `V1_MEDIA_DRIVER=gcs`,
  `V1_GOOGLE_CLOUD_PROJECT=motion-expert-hk-ltd-webpage`,
  `V1_GCS_BUCKET=hkbuddy-v1-582852715831-media`, and
  `V1_GCS_RESOURCE_ID=//storage.googleapis.com/projects/_/buckets/hkbuddy-v1-582852715831-media`;
  authentication is attached-service-account ADC only
- Cloud Run identity/origins:
  `V1_RUNTIME_SERVICE_ACCOUNT=hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  `V1_PUBLIC_ORIGIN=https://hkbuddy-v1-api-582852715831.asia-east2.run.app`,
  and a SHA-bound private candidate origin of
  `https://candidate-<12-lowercase-hex>---hkbuddy-v1-api-candidate-582852715831.asia-east2.run.app`
- model: `V1_LLM_PROVIDER`, `V1_LLM_CREDENTIAL_VERSION`, plus the selected
  provider's complete V1-prefixed credential, endpoint, model/deployment,
  API-version, and request-profile set
- speech: `V1_ASR_PROVIDER`, `V1_TTS_PROVIDER` and the selected provider's
  complete credentials/settings and credential-rotation version
- policy: `V1_PRIVACY_NOTICE_VERSION`, `V1_PRIVACY_NOTICE_APPROVED`,
  `V1_RETENTION_WORKER_ENABLED`
- frozen release: `V1_RELEASE_COMMIT_SHA`
- legacy isolation: `V1_LEGACY_RESOURCE_INVENTORY_FILE`,
  `V1_LEGACY_RESOURCE_INVENTORY_VERSION`,
  `V1_LEGACY_RESOURCE_INVENTORY_APPROVED`
- real dependency evidence: `V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE`,
  `V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION`
- LLM evidence: `V1_LLM_SMOKE_EVIDENCE_FILE`,
  `V1_LLM_SMOKE_EVIDENCE_VERSION`
- voice evidence: `V1_ASR_SMOKE_EVIDENCE_FILE`,
  `V1_ASR_SMOKE_EVIDENCE_VERSION`, `V1_TTS_SMOKE_EVIDENCE_FILE`,
  `V1_TTS_SMOKE_EVIDENCE_VERSION`, `V1_IOS_VOICE_ACCEPTANCE_FILE`,
  `V1_IOS_VOICE_ACCEPTANCE_VERSION`,
  `V1_IOS_TESTFLIGHT_VOICE_ACCEPTANCE_FILE`,
  `V1_IOS_TESTFLIGHT_VOICE_ACCEPTANCE_VERSION`

Combined App Store launch (Today / Campus / Practice / Translate) uses the
same Cloud Run origin. Apply `migrations/002_ios_combined.sql` before enabling
`V1_PRIVACY_NOTICE_VERSION=2026-09-10-ios-combined` or `V1_REQUIRE_AI_CONSENT`.
App Store voice stays off until both Safari and TestFlight evidence files pass.
See `docs/app-store/submit-checklist.md`.

Production database and GCS selection accepts only V1-prefixed settings.
Production LLM selection follows the same V1-only rule. Unprefixed settings are
local-compatibility inputs and cannot satisfy production. Dependency init,
readiness, startup, PostgreSQL connection, query, and statement waits also have
bounded `V1_*_TIMEOUT_MS` settings documented in `.env.example`; the readiness
watchdog interval is configured separately with
`V1_READINESS_WATCHDOG_INTERVAL_MS`.

For the Google release, configure `V1_GOOGLE_CLOUD_PROJECT` as
`motion-expert-hk-ltd-webpage`, `V1_VERTEX_LOCATION=global`, and
`V1_VERTEX_MODEL=gemini-2.5-flash`. STT is fixed to `chirp_2` through the `_`
recognizer in `asia-southeast1`. TTS uses the regional
`asia-southeast1` endpoint and exactly one evidenced Chirp 3 HD Achernar voice
for each supported locale: `en-US`, `yue-HK`, and `cmn-CN`. Unsupported reply
languages are rejected; there is no hidden runtime voice fallback. Rotate the
non-secret `V1_GOOGLE_CREDENTIAL_VERSION` label whenever attached service-account
authority changes. Tokens, prompts, transcripts, audio, and upstream bodies are
never evidence fields.

## Frozen release and guarded evidence

Freeze and review a clean commit before any real gate. `V1_RELEASE_COMMIT_SHA`
must equal that clean `HEAD` before and after every acceptance run.

1. Obtain an owner-reviewed safe legacy manifest. Do not infer an empty legacy
   inventory from missing environment variables.

   ```powershell
   npm.cmd run acceptance:legacy-inventory -- --manifest <absolute-owner-reviewed-safe-json> --confirm-owner-reviewed-legacy-resources
   ```

2. Configure only the approved new V1 PostgreSQL/GCS resources plus the
   `V1_ACCEPTANCE_*` settings. The acceptance schema and GCS prefix must contain
   the same fresh UUID. Then run:

   ```powershell
   npm.cmd run acceptance:dependencies
   ```

   The command is blocked unless every identity/confirmation gate passes. It
   creates only the UUID-scoped schema/prefix and proves both are absent again in
   `finally`. Never run it against an existing app or an unreviewed resource.

3. Apply and verify the complete migration set as a separate one-shot command
   against only the approved new V1 database:

   ```powershell
   npm.cmd run migrate
   ```

   Application startup never runs migrations and refuses a database without
   every expected migration version.

4. Run the separately guarded LLM, ASR, TTS, and real-iPhone acceptance against
   the frozen candidate. A configured provider is not a verified capability.
   The LLM smoke requires strict V1 provider settings, a lowercase frozen commit
   SHA, and the exact real-provider confirmation:

   ```powershell
   npm.cmd run smoke:provider -- --confirm-real-provider
   ```

   Bind the resulting immutable `reports/llm/` artifact through
   `V1_LLM_SMOKE_EVIDENCE_FILE` and its artifact digest through
   `V1_LLM_SMOKE_EVIDENCE_VERSION`. Runtime startup and every readiness check
   validate that file against the frozen commit, provider, effective non-secret
   configuration, and credential-rotation version without making another
   provider request. The evidence expires after seven days and permits at most
   five minutes of future clock skew. It is a release attestation, not a claim
   that the upstream provider is live at every later instant.

5. With an explicitly approved new candidate and non-sensitive canonical WAV
   manifest:

   ```powershell
   $env:V1_LOAD_TEST_CONFIRM='true'
   npm.cmd run acceptance:latency -- --candidate-origin <new-https-origin> --asr-manifest <absolute-safe-json> --confirm-approved-candidate
   ```

   This fixed workload is 200 text turns across 20 sessions at concurrency 5,
   30 ASR samples across 10/30/55-second buckets, and 30 TTS requests. A fake or
   local run is not SLO evidence.

6. Run `npm.cmd run readiness`. In production this starts the complete live
   runtime on an ephemeral loopback port, revalidates every dependency/evidence
   gate, reports only safe statuses/versions, and closes the probe runtime.

All generated evidence under `reports/` is ignored, immutable, artifact-hashed,
and bound to the frozen commit. It must not contain credentials, message text,
transcripts, audio, provider bodies, private URLs, or raw errors.

## Retention, deletion, backups, and corpus review

- Anonymous guest sessions are purged after 30 days without message, event, or
  voice-upload activity. This is an inactivity window, not a per-message maximum;
  an active guest session retains its earlier conversation until the session has
  been inactive for the full window or the user clears it.
- Voice/TTS media: 7 days.
- Expired rate-limit buckets are removed by the same fenced retention run.
- Explicit conversation deletion revokes ownership first and queues GCS deletion
  durably; failed physical deletion remains retryable.
- The retention worker records durable heartbeat/success state. A stopped or stale
  worker makes readiness fail.
- Run `npm.cmd run cleanup:retention` only in a fully evidenced production V1
  environment and never beside the live singleton. It uses the same retention
  service and storage boundary, then durably marks its one-shot worker stopped.
- Configure encrypted PostgreSQL backups and recovery testing for the new V1
  resource. GCS is temporary media, not the source of conversational truth.
- Review every corpus claim at its stated cadence, update source attestations, and
  ship corpus changes through a new frozen release. Overdue/conflicted/unknown
  information must be disclosed rather than invented.

Student email authentication is deliberately deferred. Anonymous secure-session
cookies are V1's current identity boundary; do not describe them as student SSO.

## Deployment and rollback boundary

`Dockerfile` pins the Node 22 OCI base, installs production packages with
`npm ci` from `package-lock.json`, copies only runtime, migration, and public
assets, and runs as the unprivileged `node` user on port 8080. Local Docker is
not required for this tranche. The reviewed release controller, not an ad hoc
project command, builds the frozen source in the selected shared host:

```powershell
node scripts/gcp-release.js --manifest=<absolute-release-manifest.json> --phase=build
node scripts/gcp-release.js --manifest=<absolute-release-manifest.json> --phase=build --confirm-release=<lowercase-40-hex-sha>
```

The build rejects a noncanonical SHA and publishes only through
`hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com` to
`asia-east2-docker.pkg.dev/motion-expert-hk-ltd-webpage/hkbuddy-v1/hkbuddy-v1-api@sha256:<64-lowercase-hex>`.
Run `npm.cmd run migrate` as a separate one-shot job; it is never part of
`CMD` or application startup.

Follow the infrastructure operator guide's manifest refresh points and complete
`build -> migration -> inventory -> acceptance -> collect -> evidence ->
candidate -> readiness -> workload -> mobile -> promote`; a local pass or a
partial receipt chain is not deployment readiness. Every acceptance deploys
only the digest-pinned revision
`hkbuddy-v1-api-candidate-<12-lowercase-hex>` to the separate
`hkbuddy-v1-api-candidate` service, with the SHA-bound
`candidate-<12-lowercase-hex>` tag at 100% private traffic. It has only the
reviewed operator's Cloud Run Invoker binding: no public principal is accepted.
Both controlled Service specs pin
`run.googleapis.com/invoker-iam-disabled` to exact lowercase string `false`.
Every live candidate, stable, promotion, rollback, cleanup, response-loss, and
compensation readback also proves the Invoker IAM check remains enabled: a raw
Cloud Run v1 Service may omit the annotation because enabled is the safe
default, or may contain a no-whitespace case-insensitive spelling of `false`.
Boolean values, whitespace, `true`, malformed annotations, wrong Service shape,
and annotation drift fail before dependent mutation; a private IAM policy alone
is not privacy evidence.
Identity-token audience is the untagged candidate-service root; authenticated
requests target the tagged candidate URL. Task 8 and phase receipts record
`trafficState=candidate-service-private-100` plus `stableTrafficState` as
`stable-absent` or `stable-prior-100`. The public `hkbuddy-v1-api` service is
unchanged throughout candidate deployment and acceptance.

Existing stable services require an exact paired `previousRevision` and
`previousImageDigest`. Empty-host promotion requires both fields to be null and
the exact stable-service describe to return `CLOUD_RUN_SERVICE_NOT_FOUND`.
Permission errors, generic not-found text, and any command/resource mismatch
fail closed. Promote only after privacy, real provider, iOS voice, dependency,
retention, readiness, mobile, latency, production-trace, and receipt gates all
pass for the same frozen commit. A later promotion creates the accepted
`hkbuddy-v1-api-<sha12>` revision untagged at 0% while the evidenced prior stable
revision remains at 100%, validates image/config and public IAM, then atomically
switches stable traffic to the new revision at 100%; public IAM is read-only.
A first promotion creates and verifies that stable revision privately at 100%,
then makes `allUsers:roles/run.invoker` the final mutation, followed only by an
IAM readback. Ambiguous first-release IAM restores the exact private stable IAM
and accepted private stable service; ambiguous later promotion restores the
exact prior stable revision at 100% without changing public IAM.

Rollback is separately confirmed. Before traffic mutation it validates the
complete mobile receipt chain, the candidate receipt's prior revision/image
binding, all local evidence, and fresh stable revision/image/IAM readbacks.
Rollback is unavailable only when no genuine prior stable release exists; a
later rollback routes only `hkbuddy-v1-api` back to the exact evidenced prior
revision at 100% and leaves the private candidate service unchanged. Receipt-
bound candidate cleanup is valid on first and later releases: it validates the
exact candidate service/revision/tag/image/private IAM, deletes only
`hkbuddy-v1-api-candidate`, and verifies canonical candidate-service absence.
If the receipt-bound initial precheck is already-absent through the exact
candidate-specific `CLOUD_RUN_SERVICE_NOT_FOUND` classifier, cleanup performs no
revision, artifact, IAM, or delete operation and repeats the exact canonical
absence readback before reporting no mutation. A raw null describe, generic
404, wrong identity, or ambiguous error is never an absence witness.
It never changes stable traffic or IAM. These phases do not delete data and
never edit,
restarts, redeploys, migrates, or repoints `hkbuddy-pilot-0630`. No legacy app,
protected shared-project state, or unrelated service is changed by candidate,
promotion, or rollback.

## Stage D controlled acceptance contract (local implementation only)

The local release controller treats candidate privacy publication as the last
candidate operation. Its receipt still hashes the complete seven-field privacy
reference, while an independent authority anchor is reconstructed from the
journaled publication and the terminal candidate-receipt digest; a self-consistent
forged receipt chain therefore cannot redefine that reference. Historical privacy proofs are validated against the clock
recorded at their own gate; that historical proof-at-gate result is not a live
freshness claim. Readiness, workload, and mobile freshness are checked
separately, and promotion always requires a new proof evaluated with the current
post-proof clock. Fresh validators reject the exact `expiresAt` boundary.

Candidate privacy and readiness publication, the workload privacy-start /
privacy-end / workload three-file bundle, and the seven-file mobile bundle are
journaled byte-for-byte before create-only publication. A restart may adopt only
the exact intended regular-file bytes. Every evidence adoption read is bounded
by the intended length and rechecks descriptor, pathname, and parent identity;
publication similarly rechecks the durable temp inode and parent before and
after the create-only link. Foreign bytes, oversized files, replacement,
symbolic links, Windows junctions, incomplete bundles, receipt drift, and
caller-supplied prebuilt mobile evidence fail closed without overwrite.

These are the strongest portable Node filesystem checks used inside a trusted,
operator-owned local evidence directory. Node on Windows has no handle-relative
`openat` primitive, so this is not a claim that an actively malicious same-user
process cannot win every kernel pathname race.

Promotion uses append-only, attempt-bound proof checkpoints. After stable
staging, it publishes a fresh proof, then uses the current clock to validate the
proof and reread every receipt/evidence predecessor plus candidate/stable
service, revision, image/config, traffic, IAM, and authority state. The final
intent is bound to the canonical digest of that complete promotion barrier.
Expired pre-intent proofs are preserved and followed by a new proof; an expired,
unperformed final intent with exact before-state is explicitly aborted before a
new proof/intent. Mixed or ambiguous state blocks, and only reads plus durable
local writes may follow the terminal public mutation.

The controlled mobile producer is pinned to Playwright `1.62.1`, Chromium
revision `1234` / browser `151.0.7922.34`, a `390x844` DPR-1 isolated context,
and canonical one-second PCM16LE 16 kHz mono WAV SHA-256
`ef989be190f7e9cef40b80516209d972eb08910263ddee3a44f52fdf84e534a7`.
The positive local harness starts the real Production V1 application and uses
its native authenticated EventSource and product HTTP APIs. For every run, Node
derives a private temporary WAV by adding a cryptographic low-amplitude
watermark to the reviewed public fixture, verifies Chromium's actual command
line, captures the real upload bytes, and accepts only the challenge-correlated
signal. Playback is witnessed outside the page main world through isolated CDP,
native media, Media, and WebAudio observations; there is no page-visible
instrumentation token or page-lifecycle authority. Node-owned observations also
bind transcript/draft identity, supported and unsupported reply IDs, explicit
text-answer TTS opt-in, retryable prior generation recovery, explicit playback,
retry/canonical-ID/reload state, downloads on every page, and the thirteen UI
checks. Untouched text answers are never auto-enqueued by startup or interval
recovery. Four fully opaque, structurally decoded PNGs must have unique encoded
and decoded-pixel hashes. This is deterministic Chromium
mobile-web evidence, not real-iOS Safari acceptance. Live GCP/provider evidence,
real iOS, promotion, public IAM, and production runtime health remain separate
unexecuted operator gates.
