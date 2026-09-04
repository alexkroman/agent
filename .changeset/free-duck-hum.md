---
"@alexkroman1/aai-cli": minor
---

Improve the Deno Deploy target. `aai build --target deno` now emits a `deno.json` with a `start` task, so the output directory describes how to run itself and no command against it has to re-supply `--entrypoint`. Auto-detection also reads `DENO_DEPLOYMENT_ID` alongside `DENO_DEPLOY`: neither marker covers both generations of the platform, since Deno Deploy Classic sets only the former, so reading just `DENO_DEPLOY` left Classic undetectable.
