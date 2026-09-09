---
"@alexkroman1/aai-cli": minor
---

Three CLI defaults now match what the docs told people to do.

`aai test` runs every non-eval spec in the project. It previously ran `agent.test.ts` alone and then FAILED naming any spec it had skipped, so a bare `aai test` could not pass on any project with a second spec file — the scaffold had already routed around it. `--only` is the fast inner loop and reports the specs it skipped rather than failing; `--all` is still accepted and does nothing, because it is what the old failure's own hint told people to put in CI.

`aai dev` watches when stdin and stdout are both TTYs. A restart ends in-flight voice sessions, which is right while you are editing and wrong while something drives the agent for twenty minutes — so a harness or process supervisor, having no TTY, gets today's behaviour. `--watch=false` and `AAI_DEV_WATCH=0` turn it off.

`aai init` installs with the caller's package manager (`npm_config_user_agent`, then pnpm/npm/bun/yarn on PATH) and stamps `packageManager` only for the one used. It previously ran `corepack enable` and installed with pnpm only — on users the install instructions had told to use npm, and `corepack` does not exist on Node 25 or 26, half the range the scaffold allows.
