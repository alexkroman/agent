---
"@alexkroman1/aai": minor
---

Add `createHostServer` and let host-mode callers bring their own provider credentials — a self-hosted multi-tenant voice server that ships with no agent.

The handshake's `host` block accepts a `credentials` record keyed by env var name (`{ ASSEMBLYAI_API_KEY: "…" }`), merged over the server's env for that connection and winning on conflict. A server can therefore hold no provider keys at all and let every session run on its caller's, so an unauthenticated caller has no operator credential to spend. Names are bounded by `ALL_PROVIDER_ENV_VARS` — the allowlist that already bounds `withHostCredentialFallback` — and an unlisted name rejects the handshake by name, since the record reaches the env the per-connection runtime is built from, where an unbounded one could set `DATABASE_URL`.

`createHostServer` (exported from `@alexkroman1/aai/runtime`) is that server in one call: no agent, no `AAI_ALLOW_HOST` flag to remember, no credentials required. It declines plain `/websocket` sessions instead of demanding a placeholder agent and a hand-rolled runtime facade, and `defaults` carries the provider triple and any operator policy every tenant should inherit. New `examples/host-server`.

Also corrects `buildHostAgent`'s docs: a host session with no base agent gets the default all-AssemblyAI pipeline, not the S2S path — that comment predated the pipeline-by-default flip.

Also adds `createAgentServer` for the single-agent case — the mirror of `createHostServer`. `createRuntime` + `createServer` stay exported and unchanged (an embedder wiring `runtime.startSession(ws)` into an existing stack, or the guest harness whose runtime does not exist until the bundle arrives, still needs them), but the ordinary "I have an agent, serve it" path no longer re-states `name` and `greeting` from the agent it just passed. That duplication had a silent failure mode: omitting `greeting` raised nothing and `GET /client-config` simply served none. `decliningRuntime` is exported alongside it — the `SessionRuntime` that turns sessions away with a protocol error, previously hand-rolled in `createHostServer`.

New `@alexkroman1/aai-ui/client-dir` subpath exports `defaultClientDir()`, the path of the prebuilt browser client, replacing the three-line `require.resolve` dance that `aai-cli`'s dev server and every self-hosted example each carried.
