---
"@alexkroman1/aai-cli": patch
---

Fix `aai init` failing at its install step under pnpm's release-age quarantine (`minimumReleaseAge`, on by default in pnpm 11). The scaffold pins the newest SDK release and this repo publishes several times a day, so no version satisfying the pinned range was ever old enough to clear the window and resolution failed outright. The scaffolded `pnpm-workspace.yaml` now exempts `@alexkroman1/*` from the quarantine, leaving every third-party dependency under whatever window the user configured.
