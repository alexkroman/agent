---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-cli": minor
---

A channel refusal never carries a credential. Whatever a platform writes back — a 2xx refusal, a 4xx/5xx body or its preview, a fetch failure — has every credential value in the channel's options (Textbelt's `key`, a Slack `webhookUrl`, raw and URL-encoded) and every `key=`/`token=`/`secret=`-style query parameter replaced by `[redacted]` before it becomes a `ChannelDeliveryError`'s message. Textbelt had answered a text with a link with `…/whitelist?key=<the key>`, which went into the run's stored error, the logs and `text_me`'s result.

`run_code` can run self-hosted, opt-in: with `AAI_RUN_CODE=deno` in the process env, `aai dev` and `aai start` run each snippet in its own `deno` process with no permissions (no network, file, env, subprocess, FFI or sys access; local-module imports refused too), the code on stdin, a three-entry env, a 5 s deadline that kills the process group and capped output. The binary is `AAI_DENO_PATH` or the first `deno` (2.x) on `PATH`; enabled without one, the server warns once and `run_code` keeps refusing. Unset, nothing changes. `createAgentServer` now forwards `runCode`.
