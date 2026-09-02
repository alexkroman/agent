---
"@alexkroman1/aai-runtime": minor
---

Make a `createAgentServer` forwarding gap unrepresentable, and close the fourth one.

`AgentServerOptions` is a hand-written subset of `RuntimeOptions` where every field is optional, so an option added to the runtime is silently unreachable through the door most deployments use. That is not a hazard to remember — it has happened FOUR times, and each was found by somebody needing the option rather than by anything checking: `telephony` mounted an unauthenticated `WS /phone` with no way to switch it off, `page` served a static agent the voice surfaces, `env` left `AAI_WORKFLOW_API_TOKEN` and `DATABASE_URL` doing nothing, and `journal` left a deployment that owns a database unable to say so.

`journal` is forwarded now. And `agent-server-forwarding.ts` is what stops a fifth: every `RuntimeOptions` member is either on `AgentServerOptions` or on an explicit `UnforwardedRuntimeOption` deny-list carrying its reason, and `ForwardingGap` is the subtraction — `never` today, and the NAME of the offending member the moment one is added. It fails `turbo run typecheck` AND the build, since the module is compiled by `tsconfig.build.json` and a build failure cannot be skipped by a test filter. Same shape as `AgentConfigSchema`'s `HOST_ONLY_AGENT_FIELDS` subtraction one package over, for the same reason.

Checked in BOTH directions, and the reverse one earned its place immediately: a `StaleExcuse` (an entry naming a member `RuntimeOptions` no longer has) and a `RedundantExcuse` (one the door now forwards) each fail the same way, and the first caught three wrong entries on its first run — a draft excused `name`, `greeting` and `hostBaseAgent`, none of which is a `RuntimeOptions` member at all.
