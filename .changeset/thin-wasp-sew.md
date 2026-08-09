---
"aai-server": patch
---

Fix the Modal container crash-loop: guard the image recipe's repo read behind modal.is_local(), and verify the rollout in CI instead of trusting modal deploy's exit code
