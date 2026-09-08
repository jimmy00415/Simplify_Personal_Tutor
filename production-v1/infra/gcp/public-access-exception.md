# HK Buddy public-service exception

Owner approved this narrow exception on 2026-09-08. It applies only within existing project `motion-expert-hk-ltd-webpage` (582852715831); no organization-wide policy was changed.

The inherited `iam.allowedPolicyMemberDomains` policy permits customer `C02id5ehy` and prevented the stable Cloud Run service from granting `allUsers` the `roles/run.invoker` role. The project policy now preserves that default and adds a conditional exception for the following immutable tag IDs:

| Resource | Identity |
| --- | --- |
| Project-owned key | `tagKeys/281482050296340` |
| Value | `tagValues/281477068070447` |
| Namespaced value | `motion-expert-hk-ltd-webpage/hkbuddy-public-service/hkbuddy-v1-api` |
| Only bound resource | `//run.googleapis.com/projects/582852715831/locations/asia-east2/services/hkbuddy-v1-api` |

The effective project policy is:

```yaml
name: projects/582852715831/policies/iam.allowedPolicyMemberDomains
spec:
  rules:
    - condition:
        expression: resource.matchTagId('tagKeys/281482050296340', 'tagValues/281477068070447')
        title: hkbuddy-stable-public-access
      allowAll: true
    - values:
        allowedValues: [C02id5ehy]
```

Cloud Run invoker IAM checking remains enabled. Only the public stable service receives `allUsers` as Invoker; the exception tag must never be attached to the project, candidate service, or other resources. Tag administration must remain restricted to trusted administrators. Organization Policy API was enabled in this existing project for this configuration.

This project override snapshots the inherited customer allowlist. If the organization changes that allowlist, review this override too. Before updating this policy, reread it and preserve concurrent policy changes using its current etag. Do not blindly reapply the example above over a changed policy.

For future releases, preserve the stable service and its tag binding. Recreating it requires explicitly restoring the service-level binding. To withdraw public access, first remove the stable service's `allUsers` Invoker grant; removing a domain-sharing exception alone does not retroactively remove existing IAM grants. Then remove the tag binding and, if still unchanged and no longer needed, this project override to restore inheritance. Do not modify organization-wide restrictions or turn off invoker IAM checks.

Reference: [Google Cloud's tag-conditioned domain-sharing exception](https://cloud.google.com/blog/topics/developers-practitioners/how-create-public-cloud-run-services-when-domain-restricted-sharing-enforced).

## Verified release

- Public URL: https://hkbuddy-v1-api-582852715831.asia-east2.run.app
- Application commit: `8123f798051db3ddfe09d57aa42700951c4c9645`
- Stable revision: `hkbuddy-v1-api-8123f798051d`, 100% traffic.
- Image: `sha256:3b5759fb8e281574af4054c20975e2d51a98b070a63cd45175f5fc27ca8d3c1f`
- Promotion receipt: `0301036282796f30a1e41fac57b4b044e5645cbabf828438a9685231e55c47ae`
- Verified 2026-09-08: anonymous homepage/live/ready HTTP 200, all nine readiness checks ready, new anonymous session, real SSOid answer with verified grounding, test-session deletion, and QR decoded to the exact public URL.
- The candidate service was deleted by the release controller. Real iPhone/Safari testing was explicitly waived; browser acceptance used pinned Chromium mobile emulation.
