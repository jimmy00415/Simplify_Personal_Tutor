# Hong Kong Buddy Production V1 — guarded GCP provisioning

This directory is the executable infrastructure contract for the existing,
billed Motion Expert shared project. It creates only the V1-namespaced resource
island and never adopts, updates, or deletes a non-V1 resource.

## Fixed boundary

- Project: `motion-expert-hk-ltd-webpage` (project number `582852715831`)
- Organization: `797368190621`
- Billing account: `01F9FD-24EA9B-A9232C`
- Cloud Run, Cloud SQL, Artifact Registry, and media storage: `asia-east2`
- Speech-to-Text and Text-to-Speech: `asia-southeast1`
- Vertex AI: `global`
- Monthly budget alert: `HKD 2300`, with 50/80/100% actual and 100%
  forecast thresholds; it is an alert, not a hard spend cap
- Runtime/database connectivity: Cloud Run Direct VPC with
  `private-ranges-only` egress and Cloud SQL private IP
- Cloud SQL transport: `sslmode=require`, with instance-side
  `ENCRYPTED_ONLY`

The selected project is a shared control-plane boundary, not a dedicated
project. Billing, quota, required API enablement, audit logs, and project IAM
are shared. The default VPC and automatically created subnets, the three
protected baseline IAM bindings, existing data, and every unrelated service are
read-only inventory. No launch command may create or relink the project, alter
its display name or labels, mutate the default network, broaden unrelated IAM,
or adopt, repair, rename, peer, or delete an existing resource. A foreign or
partial object at a managed identity is drift and stops the run before a write.
The earlier dedicated-project creation/billing procedure is superseded.

### Exact provisioned identities

The Tasks 1–2 operator boundary uses only these executable V1 identities:

- Cloud Run services: public stable `hkbuddy-v1-api` and private candidate
  `hkbuddy-v1-api-candidate`
- Artifact Registry Docker repository: `hkbuddy-v1`
- media bucket: `hkbuddy-v1-582852715831-media`
- regional Cloud Build source bucket: `hkbuddy-v1-582852715831-build-source`
  with uniform bucket-level access, enforced public-access prevention, disabled
  versioning and soft delete, and a one-day delete lifecycle
- Cloud SQL instance/database: `hkbuddy-v1-pg` / `hkbuddy_v1`
- VPC/subnet/PSA range: `hkbuddy-v1-vpc` /
  `hkbuddy-v1-ae2-run` / `hkbuddy-v1-google-services`
- service accounts:
  `hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  `hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  `hkbuddy-v1-migrator@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  `hkbuddy-v1-deployer@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  and
  `hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
- project custom roles:
  `hkbuddyV1AcceptanceBucketMetadataReader`, with only
  `storage.buckets.get`, and `hkbuddyV1BucketIamPolicyOperator`, with only
  `storage.buckets.get`, `storage.buckets.getIamPolicy`, and
  `storage.buckets.setIamPolicy`. The metadata-reader role is bound on the fixed
  media bucket to both the runtime and dependency-acceptance identities.
- generated/bootstrap Secret containers: `hkbuddy-v1-db-app-url`,
  `hkbuddy-v1-db-migrator-url`, `hkbuddy-v1-session-secret`, and
  `hkbuddy-v1-db-bootstrap-state`
- evidence Secret containers: `hkbuddy-v1-legacy-inventory`,
  `hkbuddy-v1-dependency-acceptance`, `hkbuddy-v1-llm-smoke`,
  `hkbuddy-v1-asr-smoke`, `hkbuddy-v1-tts-smoke`, and
  `hkbuddy-v1-ios-voice-acceptance`
- Cloud Run Jobs: `hkbuddy-v1-migrate`,
  `hkbuddy-v1-dependency-acceptance`, `hkbuddy-v1-llm-smoke`,
  `hkbuddy-v1-asr-smoke`, and `hkbuddy-v1-tts-smoke`

### Read-only Cloud Asset inventory consumer

The host does not enable Cloud Asset API. Before any provisioning write, the
control plane therefore performs one exhaustive, auto-paginated JSON inventory read of the host
using `tech-demo-433408` strictly as the Cloud Asset quota consumer:

```text
gcloud asset search-all-resources --scope=projects/motion-expert-hk-ltd-webpage --billing-project=tech-demo-433408 --project=motion-expert-hk-ltd-webpage --page-size=500 --read-mask=name,assetType,project,displayName,description,location,labels,parentFullResourceName,parentAssetType,state --order-by=assetType,name --format=json
```

`tech-demo-433408` is never a deployment host and is never the target of API
enablement, resource, billing, IAM, or REST mutation. Malformed, unavailable,
truncated/overflowed, wrong-project, or foreign managed-namespace inventory fails closed before a
host mutation.

The Cloud Asset collision audit applies the centralized obsolete executable
identity set to canonical name, display name, description, parent name, parent
type, and every label key/value. This includes the bare legacy Artifact
Registry repository identity and all prior resource aliases. The separate
legacy-inventory workflow remains explicitly read-only evidence and does not
authorize adopting any discovered legacy resource.

Cloud SQL assets use the official `//cloudsql.googleapis.com/...` full resource
name while retaining their `sqladmin.googleapis.com/*` asset types. Instance
and BackupRun descendants are accepted only with exact project, parent, type,
and canonical identity fields. Cloud Asset is inventory evidence, not a live
health source: BackupRun state and location are validated only as official
schema values because inventory can lag the authoritative Cloud SQL API.

The complete identities, APIs, IAM bindings, probes, backup controls, alert
policies, and budget thresholds live in `resource-contract.json`. The contract
is deliberately exact. Changing an identity or weakening a control makes the
scripts fail before mutation.

## Commands

`npm run gcp:preflight` is read-only. It requires the existing active shared
project, its exact project number and display name, no project labels, its open
billing link, and the three protected baseline IAM bindings. It never creates,
links, patches, or deletes the project, billing link, default network, or any
unrelated IAM policy.

Known absence of only the exact release-evidence operator role and/or its exact
conditional binding is reported as
`RELEASE_EVIDENCE_IAM_REPAIR_REQUIRED` with `mutationPerformed=false` and the
missing fixed resource IDs. A fully reconciled state passes. Unknown,
malformed, widened, duplicate, or otherwise drifted conditional IAM remains a
fatal allowlist failure rather than a repair suggestion.

Organization, billing account, project parent, and project billing link are
accepted only in the explicitly enumerated canonical API shapes with exact
case, delimiter, segment count, and required fields. The project-wide CIDR
audit uses the following exhaustive `INTERNAL` address model, derived offline
from the installed Cloud SDK 553 Compute v1 schema:

| Purpose | Scope | Required selector | Address form |
| --- | --- | --- | --- |
| `DNS_RESOLVER` | regional | exact project/region subnetwork selfLink | one host address |
| `GCE_ENDPOINT` | regional | exact project/region subnetwork selfLink | one host address |
| `SHARED_LOADBALANCER_VIP` | regional | exact project/region subnetwork selfLink | one host address |
| `IPSEC_INTERCONNECT` | regional | exact project network selfLink | IPv4 range |
| `PRIVATE_SERVICE_CONNECT` | global | exact project network selfLink | one host address |
| `SERVERLESS` | regional | no selector, or one exact enumerated same-region subnetwork selfLink | IPv4 range |
| `VPC_PEERING` | global | exact project network selfLink | IPv4 range |

Every Address also requires its exact host-project, name-matching Address
`selfLink`. Global purposes use the exact global Address path and omit `region`;
regional purposes use an exact regional Address path whose region agrees with
`item.region`. A subnetwork selector must be in that same region. This applies
even to selector-free `SERVERLESS`; it does not falsely require every unrelated
regional row in the host project to be `asia-east2`.

Cloud Run Direct VPC egress can create a Google-managed `SERVERLESS` Address
reservation inside the selected subnet. The audit accepts that form only when
it has no network selector, names one enumerated same-region subnetwork on a
known enumerated network, and its canonical `/8` through `/30` IPv4 range is
fully contained in that subnet's primary CIDR. A reservation contained in the
exact managed V1 subnet is an owned child allocation rather than a collision
with its parent `/26`; it remains present for every other overlap calculation.
The operator does not delete or alter this Google-managed reservation.

Single-address INTERNAL rows must omit `prefixLength`; they are normalized to
`/32` only for overlap calculation. Range rows require a canonical network-base
IPv4 prefix from 8 through 30. Both `RESERVED` and `IN_USE` rows are fully
validated and included in overlap checks. `RESERVING`, unknown status, an
incomplete or wrong-scope/selector shape, and unknown purposes fail closed.
INTERNAL `NAT_AUTO`, `CROSS_SITE_NETWORK`, and `PRIVATE_NAT` are rejected.

A complete ordinary `EXTERNAL` row is validated before being excluded from
INTERNAL IPv4 overlap math. It must have stable `RESERVED` or `IN_USE` status,
an exact host-project/name/scope Address `selfLink`, and a canonical address
matching `IPV4` or `IPV6`. Ordinary external purpose is absent. A regional `NAT_AUTO`
is allowed only with exact regional scope. IPv4 rejects IPv6-only endpoint fields.
Global IPv6 rejects regional fields. Regional IPv6 may carry prefix length 96,
`ipv6EndpointType` `VM` or `NETLB`, and a same-region exact subnetwork selector.
Missing address/selfLink, transient `RESERVING`, unknown purpose/status,
noncanonical IP, foreign project, or contradictory scope fails closed.

After Cloud SQL allocates its private address, Service Networking installs one
imported `/24` route inside the managed PSA `/16`. Preflight exempts that route
only when four live facts agree: the exact managed PSA Address, the exact
Service Networking connection and reserved range, an exact `RUNNABLE`
private-only Cloud SQL instance with one canonical private IPv4 address, and one
exact auto-generated peering route whose `/24` contains that address. Missing,
duplicate, static, tagged, foreign, or otherwise drifted routes remain CIDR
collisions. Networks, subnets, routes, addresses, every Service Networking
connection, and the Cloud SQL instance are then read again. The complete CIDR
audit must remain valid, while the managed connection, private-network proof,
and exact imported-route proof must be unchanged before the audit can finish.

The billing account must report `currencyCode=HKD`. Google requires a fixed
budget amount to use the billing account's native currency, so the reviewed
live ruling is `HKD 2300` rather than the earlier `USD 300` draft. Any currency
mismatch fails before mutation.

An optional existing target-project Monitoring channel can be checked with:

```text
npm run gcp:preflight -- --notification-channel=projects/motion-expert-hk-ltd-webpage/notificationChannels/NUMERIC_ID
```

The channel must have display name `HK Buddy V1 operations`, exact ownership
labels `application=hong_kong_buddy`, `environment=production_v1`, and
`hkbuddy_contract=operations`, the sole endpoint label
`email_address=admin@motionexp.com`, have `type=email`, be enabled, and have
`verificationStatus=VERIFIED`. Billing Budgets does not accept an arbitrary
Monitoring channel type. A missing, disabled, inaccessible, non-email, or
unverified channel is not treated as usable.

Monitoring REST normalizes either the exact project-ID or project-number alias
to the project-ID resource name shown above. The scripts accept only those two
exact target-project forms and use the project-ID form for Monitoring and
Billing Budget payloads. Cloud Asset inventory is validated independently
against its numeric Monitoring asset name and numeric `project` field.

`npm run gcp:provision` is also inert by default: it validates the contract and
prints the planned fixed operation IDs. The mutating first-stage bootstrap is:

```text
npm run gcp:provision -- --confirm-project=motion-expert-hk-ltd-webpage
```

That exact form first re-audits the immutable shared-project baseline and every
managed-resource collision, then enables only the required APIs and stops at
the required channel gate. After the operator creates and verifies the email
channel, the mutating resume form is:

```text
npm run gcp:provision -- --confirm-project=motion-expert-hk-ltd-webpage --notification-channel=projects/motion-expert-hk-ltd-webpage/notificationChannels/NUMERIC_ID
```

No abbreviated confirmation, alternate project, extra flag, or legacy identity
is accepted. The project and its billing link must already exist and match the
immutable shared baseline; neither is ever created, linked, patched, or adopted.
Every confirmed run first proves the fixed CLI/REST operator, immutable project,
organization and billing parent, Cloud Asset resource identities, existing V1
bucket ownership, and the complete version-3 project IAM policy. It may then
create or adopt the exact bucket-policy operator custom role and add its one
conditioned project binding, then create or adopt the distinct release-evidence
object operator role and binding, before the ordinary complete collision and
network-CIDR audit. These are the only permitted mutations before the full
audit; unknown role state, alternate conditions, duplicate or extra members,
project-policy drift, or an unprovable response blocks them.

The fixed binding grants `user:admin@motionexp.com` only the three custom-role
permissions above and only when all of these are true: service is
`storage.googleapis.com`, resource type is `storage.googleapis.com/Bucket`, and
resource name is exactly one of the two V1 `projects/_/buckets/...` names. It
does not grant object read/write/delete access and does not apply to any other
bucket in the shared project. The project policy is read and written as version
3 with its authoritative `etag`; response loss can recover only from an exact
full-policy readback. Propagation is bounded and verified by exact effective
permission probes plus real bucket-policy GETs. A timeout preserves the desired
narrow binding and reports `operator-bucket-iam-propagation` for an idempotent
rerun; it never falls back to project-wide Storage Admin or legacy grants.

The second role contains exactly `storage.objects.get`,
`storage.objects.list`, and `storage.objects.delete`. Its separate binding is
for `user:admin@motionexp.com` and the fixed media bucket only. The Bucket
condition branch exists solely because object listing is evaluated at bucket
scope. The Object branch restricts get/delete to resource names beginning
exactly with
`projects/_/buckets/hkbuddy-v1-582852715831-media/objects/release-evidence/`.
The trailing slash is contractual: sibling prefixes such as
`release-evidence-evil/` fail closed. This role does not grant object creation,
does not apply to the build-source bucket, and does not change its existing
creator-only operator binding. The policy uses the same requested version 3,
authoritative `etag`, exact full-policy response-loss recovery, and a bounded
effective `storage.objects.list` propagation gate. Its timeout boundary is
`operator-release-evidence-iam-propagation`.

After that recovery and its readback, the script restarts the complete ordinary
pre-mutation audit. The operator creates the real email channel in that project
and completes its external email verification. A rerun with the numeric verified
channel creates and reads back the budget and alert policies before any VPC, HA
Cloud SQL, storage, secret, or workload-IAM mutation. The script reports the
exact resume boundary and never rolls back or deletes partial resources.

Cloud Storage creates each uniform-access bucket with four legacy convenience
role groups derived from the shared project's Owner, Editor, and Viewer basic
roles. These broad generated bucket grants are not part of the V1 IAM
allowlist. Basic project Owner alone does not intrinsically preserve all three
bucket-policy permissions after those local grants are removed; the exact
conditioned project binding above is therefore established and proven first.
Immediately after both buckets exist, two fixed IAM-baseline steps
read each policy through the Storage JSON API with policy version 3 requested.
Only the exact platform defaults for this project ID and an already-present
subset of that bucket's configured V1 bindings are accepted. The step removes
only those exact defaults, preserves the configured subset, and writes the
complete edited policy with the authoritative read `etag`. Unknown, foreign,
conditional, duplicate, malformed, or missing-etag policy state fails before
the PUT. A concurrent `ABORTED` etag conflict is deterministic and is never
adopted; only a lost transport response can recover through one exact policy
readback. A separate exact post-write readback is mandatory. Both bucket
baselines complete before any Secret version or database-user credential write,
and the terminal IAM readback still requires the final configured allowlist.

### 2026-09-03 release-evidence recovery note

The last confirmed release attempt on
`0ce6399791b393500cd393e41c1d340d8232518c` passed build, migration, inventory,
and all four acceptance Jobs but stopped before collection because the fixed
operator lacked media object get/list/delete. The new release-evidence
role/binding and early gate described above are committed source, not an
assertion that they have run in GCP. Any new source commit supersedes that
attempt and requires a fresh SHA-bound build/evidence chain. Follow the
authentication, preflight, and exact resume commands in the top-level README;
do not manually widen Storage IAM or reuse old acceptance outputs.

Database absence is determined from the successful, project- and
instance-scoped `gcloud sql databases list` JSON response with one exact
canonical built-in `postgres` row as a positive completeness witness; an empty
list or generic database `describe` 404 is never accepted as absence.
Immediately before the database insert, provisioning reads the exact instance,
exhaustively paginates the official Cloud SQL v1 operations list, waits while
any operation is `PENDING` or `RUNNING`, and reads the instance again. Only a
stable quiet instance can receive the official v1 `databases.insert` request. Its returned
`CREATE_DATABASE` operation is identity-bound and polled with a wall-clock
deadline until an error-free `DONE`, followed by the ordinary exact database
list readback. The remaining wall-clock deadline is propagated into every
in-flight gcloud and authenticated REST read. Official Cloud SQL
`operationInProgress` and `invalidState` conflicts trigger a bounded backoff and
complete readiness re-proof. A received but unknown or malformed HTTP 409 is a
deterministic, non-recoverable conflict; only a genuine lost transport response
can use exact readback recovery.

## CLI launch on Windows

The script uses `execFile` with an argument array; it never builds a shell
command string. On the standard Windows Cloud SDK installation it invokes the
bundled Python runtime and `gcloud.py` directly. A nonstandard installation must
provide both absolute paths:

- `V1_GCP_PYTHON_EXECUTABLE`
- `V1_GCLOUD_PY_PATH`

The active Cloud SDK configuration remains operator-controlled. Use the
dedicated Production V1 configuration directory when running the reviewed live
command; the scripts never switch configurations implicitly. For example, set
`CLOUDSDK_CONFIG` to the reviewed `gcloud-hkbuddy-production-v1` directory in
the operator process before invoking npm.

Authenticated HTTPS calls acquire an access token in memory for the one active
gcloud account. The reviewed launch authority is fixed to
`admin@motionexp.com`; both CLI and REST must resolve to that account before
mutation. The script rejects every effective `CLOUDSDK_AUTH_*` credential
override and any active gcloud `auth` override, including impersonation,
access-token-file, and credential-file settings. It introspects the actual
access token and compares the returned email rather than trusting the requested
account argument. This also makes the protected human `roles/owner` baseline explicit
instead of accepting whichever identity happens to be active. The bearer token
is never placed in an argument or report. This operator authentication path is
separate from the runtime: Cloud Run uses its attached service account through
application default credentials.

## Frozen release commands

`scripts/gcp-release.js` is also inert by default. The source archive command
accepts only one clean lower-case 40-hex `HEAD`, rejects tracked or untracked
worktree changes, fixes every archive member mtime to that commit's validated
`%ct`, archives the `production-v1` tree outside the repository, and returns
its SHA-256:

```text
node scripts/gcp-release.js --prepare-archive --repository-root=ABSOLUTE_REPOSITORY_ROOT --destination=ABSOLUTE_OUTPUT/source.tar.gz --release-sha=40_HEX_SHA
node scripts/gcp-release.js --prepare-archive --repository-root=ABSOLUTE_REPOSITORY_ROOT --destination=ABSOLUTE_OUTPUT/source.tar.gz --release-sha=40_HEX_SHA --confirm-archive=40_HEX_SHA
```

The release manifest is a local JSON control record with exact keys for the
release SHA, absolute archive path and hash, immutable image digest, numeric DB
Secret versions, one UUIDv4 acceptance run ID, the four exact generation-bound
GCS output objects, project number, previous V1 revision, and the six evidence
artifacts. The legacy inventory is also carried separately because it must be
published before the dependency Job can run. Each evidence member separates
its local absolute JSON path, semantic artifact SHA-256, exact object-byte
SHA-256, fixed Secret ID, and expected numeric Secret version. The release
runner verifies the file bytes, embedded commit/artifact binding, size, and
basic secret-safety before its first Secret Manager mutation. In the confirmed
`evidence` phase it additionally validates the iOS artifact as either the
complete current v4 contract or the exact current owner waiver. The unchanged
v4 branch requires the exact release SHA and semantic artifact hash,
canonical-WAV normalizer contract, pinned normalizer identity/result, and both
device/evidence clocks. The waiver branch requires the final lowercase 40-hex
release SHA, `admin@motionexp.com`, `real-iphone-safari`, the exact reason and
single limitation, canonical approval/expiry instants exactly seven days apart,
no more than five minutes of future skew, and an unexpired self-hash-valid
record with no extra keys. A merely self-hashed JSON object cannot be published.
Receipt-bound
cleanup and rollback later verify the immutable historical bytes and hashes
without pretending that the original acceptance is still fresh. Every
inventory/evidence payload is frozen from those validated bytes before any
cloud mutation and sent to `gcloud secrets versions add --data-file=-` over
stdin; the original path is never reopened for publication. The mutation plan,
exact numeric-version metadata readback, private payload readback, and durable
safe result bind both the semantic artifact SHA-256 and exact object SHA-256.
Payload readback uses the CLI's checksum-verified Secret access response and is
never copied into a receipt or public report. Evidence must not contain credentials.

Create the waiver only when exercising the product owner's explicit deferral
for this release, only after the final commit SHA is known, and only at a new
absolute JSON path outside tracked source:

```text
npm run acceptance:ios-waiver -- --release-sha=FINAL_40_HEX_SHA --destination=ABSOLUTE_NEW_JSON_PATH --confirm-owner=admin@motionexp.com
```

This substitutes only for physical iPhone/Safari evidence. It does not alter
the manifest/evidence/receipt chain or numeric Secret version binding, and it
does not waive controlled Playwright `390x844` mobile, real Google LLM/ASR/TTS,
privacy, readiness, latency/workload, trace, candidate, or promotion gates. A
release using it must be described as not real-iPhone certified; runtime must
continue to expose `iosVoiceCertified=false` and
`iosVoiceAcceptanceVersion=null`.
`previousRevision` and `previousImageDigest` are one
fail-closed pair: both are `null` only for an evidenced empty-host first
release; every later release supplies the exact controller revision
`hkbuddy-v1-api-<12-lowercase-hex>` and its immutable `sha256:` image digest.
The first `build` invocation alone accepts
`imageDigest: null`; its verified receipt returns the digest that must replace
that null before any later phase is accepted. One phase is selected at a time:

```text
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=build
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=build --confirm-release=40_HEX_SHA
```

The complete guarded order is `build`, `migration`, `inventory`, `acceptance`,
`collect`, `evidence`, `candidate`, `readiness`, `workload`, `mobile`, then
`promote`. `candidate-cleanup` is the pre-promotion recovery phase and
`rollback` is the separately confirmed post-promotion recovery phase. Every
phase is first inspected without confirmation and then repeated with the exact
`--confirm-release=40_HEX_SHA`; no phase may be skipped.
For an empty-host first release, `promote` includes the audited singleton
handoff: it publishes a fresh candidate privacy proof, journals deletion of the
private candidate, proves canonical candidate absence, and only then starts the
stable service. Confirmed `candidate` and `promote` phases for a later release
return `ROLLING_RELEASE_UNSUPPORTED_SINGLETON` without a control-plane call
until durable candidate/stable workload lanes and separate worker leadership
are implemented; `candidate-cleanup` and `rollback` remain available.
Build completion requires the custom build identity; a fresh production-only install;
an exact `DEPENDENCY_SECURITY_EXCEPTION_REVIEWED` gate receipt before the image
step; verified provenance backed by the required Container Analysis API and the
Google-managed Cloud Build service agent; successful image/corpus and OCI-label checks; one
Build ID; the archive hash; and the final digest. A missing, failed, expired, or
drifted dependency gate is a failed build receipt. `inventory` accepts the
legacy inventory with `secretVersion: null`, publishes it once, and treats the
numeric version in Secret Manager's add response as authoritative. It describes
 and accesses that exact version before recording it in the phase receipt; refresh
the manifest from that receipt before `acceptance`.
`acceptance` runs the `hkbuddy-v1-dependency-acceptance`
Job as
`hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
and the `hkbuddy-v1-llm-smoke`, `hkbuddy-v1-asr-smoke`, and
`hkbuddy-v1-tts-smoke` Jobs as
`hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`;
every Job is digest-pinned and its exact service account is read back before
execution. Each
Job creates one private, release/run-scoped GCS JSON object with an
overwrite-preventing generation precondition. `collect` first describes one
exact numeric generation, downloads only that generation to the planned local
path, and independently derives the semantic artifact and exact object-byte
SHA-256 values. Evidence publication accepts `secretVersion: null` for each
not-yet-published item. The numeric version returned by each Secret Manager add
response is bound to that item's exact describe and payload readback, journal
checkpoint, and phase receipt. It never predicts `latest + 1` or reads `latest`.
Only after all versions read back does it delete those exact GCS generations and require zero SHA-scoped
output residue. Before any release command is selected or executed, the
controller reconstructs all 17 storage operations and rejects any foreign
bucket, sibling prefix, different release SHA, widened residue listing, missing
generation, invalid generation, or extra storage operation. Neither workload
identity can publish Secret versions; that
authority remains with the reviewed deployer. Candidate deployment is
digest-pinned on the separate `hkbuddy-v1-api-candidate` service, always tagged
and private at 100%; it never mutates `hkbuddy-v1-api`. `/api/health/ready` is
both the startup dependency gate and readiness probe, plus `/api/health/live`
as the liveness probe. Public IAM can
be changed only after the active account reads back as the reviewed owner
`admin@motionexp.com`; the deployer is deliberately not granted
`roles/run.admin` or service-IAM administration.

A checkpointed Secret-version publication can resume only by re-reading the
exact numeric version captured in its safe result. An add intent without its
checkpoint is correlation-ambiguous: the controller fails closed, never repeats
the add, and the operator supersedes that release attempt under the release
procedure.

The manifest is deliberately refreshed between boundaries: `build` supplies
the immutable image digest; successful Jobs supply numeric GCS generations;
`collect` supplies the four semantic/object digest pairs; and Secret Manager
supplies numeric versions. The initial manifest carries complete unresolved
locator contracts for all three controlled phases: `readiness`, `workload`, and
`mobile` each has its final absolute paths and full privacy-reference shape, but
every artifact, object, and boundary SHA-256 is exactly 64 zeroes. Each matching
phase rejects prebuilt evidence, creates and validates its own create-only
bundle, and returns the resolved hashes. Before the next phase, carry forward
the resolved earlier entries while leaving each not-yet-run entry as its full
zero contract; refresh the just-completed entry from its authoritative receipt
before `mobile` or `promote`. A value from stdout is never accepted on its own:
the next phase requires the corresponding exact control-plane or file readback.

The operator command sequence, after each required manifest refresh, is:

```text
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=build
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=build --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=migration
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=migration --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=inventory
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=inventory --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=acceptance
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=acceptance --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=collect
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=collect --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=evidence
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=evidence --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=candidate
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=candidate --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=readiness
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=readiness --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=workload
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=workload --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=mobile
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=mobile --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=promote
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=promote --confirm-release=40_HEX_SHA
```

Use only the recovery phase appropriate to the observed state, again previewing
before exact confirmation:

```text
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=candidate-cleanup
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=candidate-cleanup --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=rollback
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=rollback --confirm-release=40_HEX_SHA
```

Every built image contains `/app/release-manifest.json` with exactly the schema
version, frozen release SHA, source-archive SHA-256, and
`git-archive:production-v1` source marker. Cloud Build verifies that file
against its substitutions. Jobs and the service receive
`V1_RELEASE_MANIFEST_FILE=/app/release-manifest.json` and
`V1_RELEASE_COMMIT_SHA`; no workload needs a `.git` directory or a mutable tag.

## Idempotence and failure behavior

Each durable operation follows this sequence:

1. describe or list;
2. compare every contract-bearing field;
3. create only when absent;
4. read back and compare again.

An inaccessible (`403`) resource is unknown, never absent. Canonical absence is
recognized only when the exact family-specific describe argv, project/location,
resource identity, and installed-gcloud error form agree for Artifact Registry,
service accounts, custom roles, Compute networks/subnets/addresses, Cloud SQL
instances/databases, Storage buckets, Secret Manager secrets, and Cloud Run
jobs. Cloud Run service bootstrap retains its exclusive
`CLOUD_RUN_SERVICE_NOT_FOUND` code. Generic not-found stderr or a wrong command,
format, project, region, or resource is transport-ambiguous. This includes the
target shared project: a `403`, absence, wrong project number, or baseline drift
fails closed and never creates or probes a project. `ALREADY_EXISTS`, permission
failure, unresolved readback, a global bucket/project collision, immutable
drift, wrong parent, public bucket
principal, broad workload IAM, missing metric descriptor, or ambiguous result
stops the run. If a create response is lost, the script accepts it only when an
immediate readback proves the exact contract. The safe report identifies the
last completed step and the next resume boundary without including provider
error bodies.

List-based readbacks validate every non-paginated response and exhaust every
paginated endpoint before deciding absence, uniqueness, or exactness. A null,
primitive, wrong container shape, malformed member, or malformed successful
page is ambiguous, never empty. A project-policy subset audit runs immediately after
project resolution. A second subset audit covers every managed bucket,
repository, secret, and service-account policy after the empty containers exist
but before any secret value or database user is written. These audits permit
not-yet-created expected grants but reject every unmodeled entitlement. The
pre-mutation project audit compares its initial enabled-API set with both sides
of the IAM bracket and uses the bracket's stable final set for every subsequent
managed-identity, network, and resource inventory decision; any A-to-B drift
fails before mutation. The
final readback is mandatory, not advisory: it re-describes every
resource, re-audits all five service accounts for user-managed keys, rejects a
public bucket member, and compares the managed project, both buckets, repository,
secret, and service-account IAM policies to exact per-scope allowlists. It also
lists project custom roles and requires the one fixed GA
`hkbuddyV1AcceptanceBucketMetadataReader` definition with exactly
`storage.buckets.get`; an extra permission, role, deletion, or stage drift is a
hard failure. Any
extra managed workload binding, conditional replacement, or missing binding
fails the run. The exact IAM decision is the terminal final-readback operation:
the control plane lists enabled APIs immediately before and after the IAM read,
requires the two canonical sets to match, and authorizes against the second set.
It never accepts a caller-supplied or cached API snapshot. Workload principals may never receive
`roles/iam.serviceAccountTokenCreator`; the only such binding is the expected
Google-managed Cloud Build service agent on
`hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`.
The observed protected baseline binding
`serviceAccount:582852715831@cloudservices.gserviceaccount.com` plus
`roles/editor` is protected and immutable. Additional Editor grants are
forbidden. This observed binding is distinct from optional newer service-agent bindings
that Google may materialize only as the exact member/role pairs
enumerated by the contract.

The Cloud Build service agent's automatically managed project-level
`roles/cloudbuild.serviceAgent` grant is separately required and is never
re-created by this script. Exact official service-agent member/role pairs for
the enabled or used APIs are permitted if Google materializes them; arbitrary
Google-managed roles, external users/service accounts, public principals, and
extra project or resource bindings are rejected. In particular, an optional
Container Registry service agent and an optional Pub/Sub service agent are
accepted only as their exact project-number principals with respectively
`roles/containerregistry.ServiceAgent` and `roles/pubsub.serviceAgent`, and
only while their owning APIs are enabled. Each enabled-service row must identify
the exact numeric-project Service Usage resource, repeat the same canonical API
name in `config.name`, and report `state=ENABLED`; missing, disabled,
contradictory, foreign-project, or duplicate rows fail closed. These dependency grants do not permit
either service-agent role on any other principal. An optional
newer Google APIs Service Agent entitlement may be only the exact
`roles/compute.instanceGroupManagerServiceAgent` pair enumerated by the
contract; it does not replace or weaken the immutable observed Editor baseline
above.

Cloud SQL is created through the supported SQL Admin v1 `instances.insert`
request because the installed GA Cloud SDK cannot bind the named PSA allocation
on its create command. The request sets
`settings.ipConfiguration.allocatedIpRange=hkbuddy-v1-google-services`,
the explicit `ENTERPRISE` edition required by the `db-custom-1-3840` machine
type on PostgreSQL 16, private IP only, `ENCRYPTED_ONLY`, HA,
backup/PITR/WAL retention, retained and final backups, and deletion protection
in one reviewed body. Its long-running v1 operation is polled through the
canonical `/v1/projects/.../operations/...` endpoint and must finish
successfully before the complete instance readback is accepted.

Artifact Registry is created and read back as an exact writable
`STANDARD_REPOSITORY`; a remote or virtual Docker repository with the same name
is a collision, not an acceptable substitute.

## Database identities and secrets

`hkbuddy_app` and `hkbuddy_migrator` are different PostgreSQL identities.
Cloud SQL's authenticated users API receives passwords only in an HTTPS JSON
body. The application user is created with only `pg_read_all_data` and
`pg_write_all_data`, which prevents Cloud SQL from automatically assigning
`cloudsqlsuperuser`; the migrator is explicitly assigned
`cloudsqlsuperuser` for DDL.

The application URL, migrator URL, and session value are generated in memory.
They are sent only in authenticated SQL Admin or Secret Manager request bodies.
They never appear in gcloud arguments, stdout, logs, reports, or temporary
files. Every generated credential, including both URL passwords, must remain a
canonical unpadded base64url encoding of exactly 32 bytes on readback; a weak or
noncanonical pre-existing value is drift. Secret containers also require exact
Google-managed automatic replication, exact labels, and no expiry, TTL,
rotation, topic, or CMEK control. Runtime and migration URLs point at the private IP and contain only
`sslmode=require`. A non-secret bootstrap receipt binds the user roles to the
numeric URL-secret versions. Existing users without that receipt stop as an
ambiguous partial state.

Only numeric Secret Manager versions are returned for the later Cloud Run
service/job specification. `latest` is not a deployment pin. The runtime gets
access to the application URL and session secret only; the migrator gets access
to the migrator URL only.

The base provisioning pass also creates six empty evidence containers:
`hkbuddy-v1-legacy-inventory`, `hkbuddy-v1-dependency-acceptance`,
`hkbuddy-v1-llm-smoke`, `hkbuddy-v1-asr-smoke`, `hkbuddy-v1-tts-smoke`, and
`hkbuddy-v1-ios-voice-acceptance`. It creates no version in those containers.
The frozen-release task adds exactly one accepted numeric version to each and
mounts it read-only; startup validation remains fail closed. Runtime receives
secret-scoped accessor grants for these six containers so no project-wide
Secret Manager access is needed.

The
`hkbuddy-v1-deployer@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
deployer can act as
`hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
`hkbuddy-v1-migrator@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
`hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`, and
`hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
only through service-account-scoped
`roles/iam.serviceAccountUser` bindings. There is no project-wide `actAs`
grant. The build identity writes only to the `hkbuddy-v1` repository and project
logs. The fixed human operator has create-only object authority on the exact
build-source bucket so `gcloud builds submit` can stage one frozen archive; it
cannot read, list, overwrite, or delete staged objects, and the bucket removes
them through its one-day lifecycle. The deployer reads only that repository and
has `roles/run.developer`.
Separately, the human operator's release-evidence role permits list on the fixed
media bucket and get/delete only below `release-evidence/`; it grants no create
permission and no access to build-source objects. These two human-operator
contracts are independent and must not be merged or widened.
The runtime identity has `roles/storage.objectUser` plus the existing
`hkbuddyV1AcceptanceBucketMetadataReader` role on the fixed media bucket. The
single `storage.buckets.get` permission lets startup and readiness verify the
bucket name, uniform bucket-level access, and public-access prevention; it does
not grant bucket listing, IAM-policy access, or Storage administration.
The acceptance identity is DB/GCS-only: it can read the app and migrator URL
Secret containers plus the exact release-bound legacy inventory mounted by the
dependency Job, exercise and clean up private bucket objects, and write platform
logs. Its normal object grant is complemented only by the custom
`storage.buckets.get` permission on the fixed media bucket so the dependency
Job can attest the bucket's exact production project number; it receives no
bucket-list or storage-admin role. It has no Vertex AI, STT, TTS,
runtime-serving, or evidence
Secret-version publishing role. Provider and voice smoke jobs instead run as
the exact
`hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
serving identity; every job readback must record the attached identity before
its evidence can be accepted.

Final readback also lists user-managed keys for all five service accounts and
fails if any exist. Runtime provider access is via Cloud Run application
default credentials, never an API key or downloaded service-account key.

## Monitoring contract

The contract creates six metric policies and five event policies: Cloud Run
5xx ratio, P95 latency and the one-instance cap; Cloud SQL CPU, storage and
connections; Cloud SQL backup failure, failover and restart; Cloud Build
failure; and Cloud Run deployment failure. Before a metric policy is created,
the exact Monitoring metric descriptor must resolve. Before an event policy is
created, the exact Logging filter is submitted to the read-only
`entries:list` endpoint. An unsupported descriptor or filter stops before the
Monitoring policy write. The verified email channel is then used by every
policy and by the exact HKD 2300 budget alert.

## Release boundary

This task provisions or exactly reads back only the isolated resource island
inside the protected existing project. It does not build an image,
run migration 001, create a Cloud Run candidate, or route traffic. Those actions
belong to the frozen-release tasks after this contract and its independent
review are green. The Cloud Run template in the JSON is the binding input for
the first-release two-service acceptance: the private candidate is always 100%
during acceptance, then the controller proves its canonical absence before it
creates the accepted stable revision privately at 100%. Both services
use one instance, always-allocated CPU, Direct VPC, and separate live/ready
probes. That later task also supplies the six accepted evidence versions; this
base task deliberately leaves those containers versionless.

### Stable, candidate, promotion, and rollback safety

The public stable service is exactly `hkbuddy-v1-api`, with origin
`https://hkbuddy-v1-api-582852715831.asia-east2.run.app`. The private candidate
service is exactly `hkbuddy-v1-api-candidate`. A frozen commit
`<40-lowercase-hex>` produces candidate revision
`hkbuddy-v1-api-candidate-<first-12-hex>`, tag `candidate-<first-12-hex>`, and
tagged QA origin
`https://candidate-<first-12-hex>---hkbuddy-v1-api-candidate-582852715831.asia-east2.run.app`.
Every candidate is routed at 100% on that private service, whose exact Invoker
policy contains only `user:admin@motionexp.com`; `allUsers` and
`allAuthenticatedUsers` are forbidden. Identity tokens use the untagged
candidate-service root as audience while requests target the tagged QA origin.
The controlled candidate and stable Service specs pin
`run.googleapis.com/invoker-iam-disabled` to exact lowercase string `false`.
Google's server-validated `services replace --dry-run` response may elide that
safe-default annotation even though the generated input pins it; the controller
therefore applies the same strict enabled-IAM-check interpretation to that
response before any deployment. Raw Cloud Run v1 live readbacks accept only
annotation absence (the enabled
default) or a present no-whitespace string whose case-folded value is `false`;
malformed annotations, boolean values, semantic true, wrong apiVersion/kind,
spec-only traffic, or drift fail before dependent mutation. This same proof is
required for candidate/stable deploy and readback, promotion, cleanup, rollback,
response-loss recovery, and compensation; IAM policy alone is insufficient.
The stable service is not changed during candidate deployment or acceptance.
Candidate, readiness, workload, mobile, trace, and phase receipts bind
`candidateService`, `stableService`,
`trafficState=candidate-service-private-100`, and `stableTrafficState` equal to
`stable-absent` or `stable-prior-100`. Old percent-only and same-service states
fail closed.

On a first promotion, exact stable-service absence and null prior fields are
required. After all candidate/mobile evidence is validated, the controller
publishes a fresh candidate privacy proof, deletes the private candidate, and
proves its canonical absence before creating the accepted stable revision
privately at 100%. It then freshly verifies the stable service, revision,
image/config, traffic, and private IAM. `allUsers:roles/run.invoker` is the final
mutation and only its IAM readback may follow. The handoff proof must be fresh
before deletion; after durable deletion it is validated at its recorded instant
while fresh candidate-absence and stable-private readbacks guard publication.
Later candidate/promotion execution is intentionally fail-closed under the
current global singleton runtime. Permission errors, ambiguous absence, an
existing stable service with null prior fields, or a missing stable service with
non-null prior fields fail closed.

The manifest-driven release phases are dry-run unless the exact frozen SHA is
confirmed:

```text
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=candidate
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=candidate --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=promote --confirm-release=40_HEX_SHA
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=rollback --confirm-release=40_HEX_SHA
```

Immediately before every guarded Cloud Run Job execution, the release command
reads the exact Job's complete execution history and journals a canonical
name/UID set digest with the Job generation, Job UID, project, and region. When
an operator supplies immutable `FAILED_PRECONDITION` command-log evidence to
recover an open acceptance execute intent, an unchanged non-empty historical
set is valid proof that the rejected request created no execution. Any added,
removed, duplicate, malformed, wrong-Job, foreign-project, or foreign-region
execution—or an ambiguous Job/list read—fails closed and leaves the intent open;
restart recovery never executes the Job again.

Promotion freshly validates candidate service/revision/private IAM/image,
immutable readiness/workload/mobile artifacts, the complete receipt chain, and
200 candidate-service production traces before stable mutation. Every lost
mutation response is followed by an exact fresh readback and an explicit
`responseLossRecoveries` result. Confirmed later promotion is blocked before
control-plane access while the singleton runtime remains in force, so no later
promotion restoration path is invoked. A lost first-promotion public-IAM response is never followed by an
automatic restore: exact public IAM is adopted, while ambiguous state fails
closed without a second IAM mutation.

Rollback loads the complete mobile receipt chain and operates only on a genuine
receipt-proven prior stable revision; it never depends on candidate existence or
changes candidate IAM. With no genuine prior stable target it returns
`ROLLBACK_UNAVAILABLE_NO_PRIOR_RELEASE` before any control-plane call. Candidate
cleanup is separately receipt-bound on both first and
later releases: it validates the exact candidate service/revision/tag/image and
private IAM, deletes only `hkbuddy-v1-api-candidate`, and verifies canonical
candidate-specific absence. It never changes stable traffic or stable IAM.
An exact initial candidate-specific canonical absence is an `already-absent`
no-mutation recovery: revision, artifact, IAM, and delete operations are skipped,
then canonical absence is read back again. Raw null output, generic 404, wrong
identity, and ambiguous errors never count as absence.
Neither recovery phase deletes database, media, evidence, protected baseline,
or unrelated services. Drift or an unprovable response-loss state fails closed
with the recovery boundary visible.

## Stage D evidence and promotion barrier

Stage D is implemented and locally contract-tested only; it does not authorize
or attest a live GCP mutation. Candidate privacy publication is the final
candidate operation. The candidate receipt hashes its complete seven-field
privacy reference, and an independent authority anchor reconstructed from the
journaled publication plus terminal candidate-receipt digest must agree exactly.
Historical proofs are checked at their recorded gate clocks. A long workload
may exceed five minutes: its start proof is checked at workload start and its
end proof at workload end, while promotion freshness is an independent current-
clock check. Every fresh wrapper rejects `current >= expiresAt`.

Privacy publication deliberately does not call Cloud Asset
`analyze-iam-policy`. A complete release produces more policy proofs than the
organization's daily free Policy Analyzer query allowance, so that API cannot
be a reliable release dependency. Each proof instead reads the complete
authoritative service/project/folder/organization IAM hierarchy twice, matches
it to Cloud Asset effective-IAM output, resolves every role bound to
`allUsers` or `allAuthenticatedUsers` twice, and rejects any such role that
contains `run.routes.invoke`. The persisted schema-v4 denial attestation carries
a bounded canonical effective-policy projection and hierarchy chain so later
validation re-derives every public binding and source hash rather than trusting
self-reported summaries. Exact private service IAM, an authenticated Policy
Troubleshooter grant, an anonymous 401/403 edge probe, an authenticated 200 edge
probe, and their Cloud Run request logs remain independently required.

Candidate privacy, readiness, the journaled privacy-start/privacy-end/workload
three-file bundle, and the seven-file mobile bundle use intent-before-create
publication. Restart adopts only exact intended bytes and reconstructs the
missing suffix or terminal record. Reads are size-bounded and bind an open file
descriptor to the pathname and parent identity; publication binds the durable
temp inode and parent before and after the create-only hard link. Foreign,
mixed, oversized, replaced, linked/junction, wrong-attempt, or receipt-drifted
state fails closed without overwrite. This assumes a trusted operator-owned
local directory: portable Node on Windows has no handle-relative `openat`, so it
does not eliminate every actively malicious same-user kernel pathname race.

Mobile accepts no prebuilt evidence. It produces fresh privacy-start, exact
candidate/stable before readbacks, the pinned browser run, exact after readbacks,
privacy-end, four screenshots, and a terminal receipt. Promotion then appends an
attempt-bound proof checkpoint before the first-release handoff. It rereads all
evidence/receipt predecessors and candidate authority before deletion, then
requires canonical candidate absence and authoritative stable service,
revision, image/config, traffic, IAM, and owner authority state before public
IAM. The final intent binds the canonical promotion-barrier digest. An expired
open proof is preserved and followed by another proof before irreversible
handoff. Every resumed first-release mutation revalidates owner authority and
its durable before-state. After candidate deletion, an open final-IAM intent
adopts exact public state or retries only the same idempotent grant from exact
private state because re-proof is no longer possible. Mixed/ambiguous state
blocks. No cloud mutation is permitted after the terminal promotion mutation.

The deterministic browser contract is Playwright `1.62.1`, Chromium revision
`1234` / `151.0.7922.34`, `390x844` at DPR 1, four fully opaque PNGs with unique
encoded and decoded-pixel hashes, and canonical WAV SHA-256
`92bb7f07a1d1f95bf037dd805f3d5d06fb837a72839698e2b5f10674f095cf33` (GCP-synthesized spoken “Hello”, padded to one second).
Its positive local harness runs the real Production V1 shell, native exact
EventSource, and product voice/message/media APIs. Node creates a private
per-run watermarked WAV challenge, verifies the actual Chromium command line,
captures and correlates the uploaded bytes, and observes explicit playback from
isolated CDP plus native media/Media/WebAudio signals. No browser binding secret
is exposed to the page and no page-lifecycle boolean authorizes acceptance.
Node-owned observations also prove transcript/draft/ID/retry correlations,
observe download attempts on every page, and cover all thirteen UI checks.
Text-answer TTS is opt-in; recovery may resume an existing retryable generation
but cannot auto-enqueue an untouched text answer. It is not real-iOS evidence.
Real iOS, live candidate/provider/GCP proof, promotion, stable/public acceptance,
runtime health, URL, and QR remain explicit operator gates.
