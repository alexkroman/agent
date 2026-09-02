---
"aai-server": patch
---

Sort the platform manifests to syncpack's format rules (key order and exports condition order). No behaviour change: every manifest is deep-equal across the reformat, verified before landing. The version bump is here because package.json is shipped source, so check:deploy-changeset requires a carrier to name the deploy rather than letting a manifest edit ride an unrelated release.
