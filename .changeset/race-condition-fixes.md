---
"@alexkroman1/aai": patch
"aai-server": patch
---

Fix race conditions and concurrency issues across the stack:

- **Session registry** (host): reconnect-resume no longer lets an old session's delayed teardown delete the resumed session's registry entries (delete-by-identity); idle timer can no longer re-arm after `stop()`; `remember` serializes its KV read-modify-write; OpenAI Realtime transport no longer double-emits `cancelled`.
- **Pipeline transport**: turn epochs gate queued turns so they can't run after `stop()`/`reset()`/`cancelReply()`; interrupted-turn persistence no-ops after `reset()`; the dead-air cover timer is abort-aware; late TTS audio after a barge-in is dropped instead of re-advancing the playback clock; tool-call repair captures its own turn's abort signal; `cancelReply()` resets the endpoint settler.
- **AssemblyAI TTS**: `cancel()` now actually cancels — the adapter drops the connection (suppressing stale audio/done/error events) and reconnects, so barge-in works and cancelled text can't splice into the next turn.
- **Sandbox platform** (aai-server): slot session releases are identity-bound so a stale release can't idle-evict a redeployed agent's new sandbox mid-call; sessions re-validate the sandbox before starting; a failed sandbox VM start detaches from the slot instead of poisoning it; dead warm-pool harnesses fall back to a cold spawn; gVisor cleanup is properly idempotent.
- **Studio**: all workspace mutations run under a per-project keyed lock (no more lost writes from concurrent tool calls or editor saves), and Publish re-reads the workspace instead of writing back a stale pre-build snapshot.
- **Browser client** (aai-ui): a stale audio init can no longer unlock a newer one (orphaned live mic); the greeting replay respects turn boundaries; a server-initiated `reset` discards in-flight file uploads; stale playback-stop events can't resolve a later turn's drain early.
- **CLI**: `NODE_ENV` preservation around Vite builds is refcounted (concurrent builds can't leak `production` into the process); config writes are atomic (temp+rename); a slug-less first deploy is no longer retried (no duplicate agents); the dev server watcher starts before the initial build, shutdown is idempotent, and restart retries a busy port; `fsKv` writes are atomic.
