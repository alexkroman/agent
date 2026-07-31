---
"aai-server": patch
---

Fix orphaned Modal sandboxes surviving for hours: the guest harness now self-exits after 5 minutes without host traffic (fed by per-harness host heartbeats) and hard-exits on stdin EOF, so Modal's idleTimeoutMs can actually reap sandboxes whose host died without teardown. Also sets TINI_SUBREAPER=1 in guest sandboxes to silence the denoland/deno image's tini warning.
