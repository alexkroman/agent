---
"@alexkroman1/aai-cli": minor
---

Guard the `-preview` slug suffix at the deploy boundary. That suffix is owned by the studio's auto-preview deploys and reaped hourly by the orphan-preview sweep, so a CLI caller that claimed it by accident would lose the agent — and any app-database data — on a schedule no redeploy could undo. `aai deploy` now rejects a requested `*-preview` slug unless the new `--allow-preview-slug` flag is passed (set only by the studio's own in-guest deploy).
