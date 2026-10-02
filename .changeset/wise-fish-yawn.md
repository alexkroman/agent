---
"aai-server": patch
"aai-studio-server": patch
---

Refuse an over-size secret update with a 413 before anything is written: the 64
KiB env cap is now checked on the merged project record and on every agent's
merged env, so a refused PUT no longer leaves the value in the project record.
The per-slug secret PUT and a deploy with an oversized env answer 413 instead of
500, and a project record already over the cap is applied name-by-name at deploy
with a warning instead of failing silently.
