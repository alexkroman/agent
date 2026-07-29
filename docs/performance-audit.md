# Performance audit (subagent fan-out)

Date: 2026-07-29. Method: four parallel auditors, one per subsystem — `aai`
host runtime, `aai-server` (sandbox/RPC/auth/store), `aai-ui` (browser
client), and studio + CLI — each reading the actual code and reporting only
evidence-backed findings with file/line references. Top findings were
re-verified against source before inclusion. Line numbers are as of this
audit's commit.

## Fix status

All Priority 1 and Priority 2 findings below are **fixed** on this branch,
as are the Priority 3 items, with these exceptions:

+ **`bytesToPcm16` copy branch** — skipped: eliminating it would widen the
  public `SttSession.sendAudio(Int16Array)` contract across all four STT
  providers (two don't use `PcmFrameAccumulator` at all) for a micro win.
+ **ElevenLabs STT backpressure** — skipped: the SDK keeps its WebSocket
  private with no buffered-amount accessor, so the stall is unobservable;
  documented at the send site. All other provider sockets are gated.
+ **`client/send` double-serialization** — partially fixed: `ClientSink.event`
  accepts only the event object, so the sink-side stringify stays; the
  handler now checks sink liveness before serializing and keeps a single
  stringify for the byte cap.
+ **Per-slug Prometheus label cardinality** — deliberately unchanged: it is
  a documented design decision guarded by a cardinality permitlist test.

The `evalWorkerBundle` ESM retention is mitigated (byte-identical rebuilds
are served from a hash-keyed memo; one module per *distinct* dev build is
still retained, documented as inherent to in-process evaluation).

## Executive summary

The codebase is unusually performance-conscious: the realtime audio paths
(browser worklets, host PCM accumulation, S2S/pipeline transports, NDJSON
transport) are already tight, deliberately and often with comments explaining
why. **No high-severity hot-path defects were found in the audio pipeline.**

The actionable wins cluster in four places:

1. **Developer loop** — `aai dev` runs a full cold Vite build per file save.
2. **Session/tool latency at scale** — full transcript shipped over stdio RPC
   per tool call; small PBKDF2 verify cache; small worker-code cache.
3. **Studio turn latency** — MCP connect blocks time-to-first-token; full
   workspace S3 read-modify-write per tool step; Publish rebuilds artifacts
   `test_agent` just built and bypasses the warm sandbox pool.
4. **UI render granularity** — `ChatView`/`MessageList` subscribe to the full
   session snapshot and re-render at STT-partial rate, negating the package's
   own narrow-subscription and row-cache optimizations.

One robustness-flavored perf item stands out: provider-facing WebSockets have
**no backpressure guard** (the client-facing side does), so a stalled provider
socket accumulates audio in memory indefinitely.

## Priority 1 — schedule these

### 1.1 `aai dev` full cold rebuild per file change

`packages/aai-cli/_dev-server.ts:87-90` → `buildWorker`
(`packages/aai-cli/worker-bundler.ts:61-88`): every watcher event runs a
from-scratch `vite.build()` (plugin init, dep-graph resolution, full Rollup
pass over agent.ts plus all bundled deps incl. zod) then `evalWorkerBundle`.
No Rollup watch mode, no esbuild incremental context, no persistent Vite
instance — 1–3 s per save on typical projects.

**Fix:** long-lived watcher (Vite build `--watch` API, or an esbuild
`context()` with `rebuild()`) feeding `evalWorkerBundle`; fall back to the
cold path on config change. Dev builds are already unminified, so an
esbuild dev path would cut rebuilds to tens of ms.

Related: `evalWorkerBundle` (`packages/aai-cli/_bundler.ts:62-82`)
dynamic-imports a uniquely-named `.mjs` per rebuild to defeat the ESM cache —
Node's module registry never evicts, so every prior bundle stays resident for
the life of the `aai dev` process (memory grows one full bundle per save).

### 1.2 Full conversation transcript shipped over stdio RPC on every tool call

`packages/aai-server/sandbox.ts:206-218` sends
`{ name, args, sessionId, messages: messages ?? [] }` per `tool/execute`;
`guest/deno-harness.ts:162-228` parses it on the guest's single event loop.
With `maxHistory` = 200, late-session tool calls pay stringify + pipe + parse
of hundreds of KB — while the caller waits on a voice reply (audible dead
air), repeated per step in multi-tool turns (`maxSteps` up to 10).

**Fix:** send a per-session delta (guest already keeps per-session state), or
omit/cap `messages` unless the tool declares it needs history.

### 1.3 No backpressure on provider-facing WebSockets

`packages/aai/host/s2s.ts:240-243` (`sendAudio` gated only on `readyState`),
same pattern in `transports/openai-realtime-transport.ts:336-339` and the
STT senders (`providers/stt/soniox.ts:153-156`, `deepgram.ts:111-114`, SDK
paths). `HeaderWebSocket` (`host/_ws.ts:9-25`) doesn't expose
`bufferedAmount`, so no caller can check. The client-facing sink has an
explicit guard (`ws-handler.ts:118-136`); the provider direction has none.
A stalled provider link accumulates ~64–130 KB/s per session forever (audio
is real-time paced, the queue never drains).

**Fix:** expose `bufferedAmount` on `HeaderWebSocket`; in `sendAudio`, drop
frames (audio is loss-tolerant) or raise a `connection` error past a cap,
mirroring the client-side guard.

### 1.4 PBKDF2 verify cache too small for multi-tenant scale

`packages/aai-server/secrets.ts:25-28`: `VERIFY_CACHE_MAX = 256`, 5-min TTL,
keyed `(apiKey, storedHash)` (multi-owner agents consume one entry per hash).
Past ~256 active pairs per 5 min, every owner-authenticated request pays the
full 600k-iteration PBKDF2 (~100 ms) and contends for the libuv threadpool —
a latency cliff as tenancy grows.

**Fix:** raise the cap substantially (entries ~200 B; 10k ≈ 2 MB), and/or key
a positive-match cache by `SHA-256(apiKey)` so plaintext keys aren't held and
the cap can be generous.

### 1.5 Studio: MCP connect blocks time-to-first-token every chat turn

`packages/aai-server/studio/studio-agent.ts:261` awaits `openMcpTools()`
(`studio-mcp.ts:90-114,140-159`) before `streamText`: an HTTPS connect +
`tools/list` round trip per turn, each phase bounded at 5 s — up to ~10 s of
dead air against a degraded docs server, ~200 ms healthy-case, all ahead of
the first token.

**Fix (keeps the per-turn-client design):** cache the tool schema list
process-wide with a TTL, and/or start `openMcpTools()` concurrently with the
first `streamText` step — tools are only needed when the model calls one.

## Priority 2 — cheap wins

### 2.1 Studio: full workspace S3 read-modify-write per tool step

`studio-agent.ts:117-128` (`withFiles`) + `studio-workspace.ts:93-120`: every
tool call — including `list_files`/`read_file`/`grep` — does an S3 GET of the
entire workspace JSON (≤1 MB) + full parse; mutations re-serialize and PUT the
whole doc. A 16-step turn can pay ~30 serialized S3 round trips. Read once per
turn into memory (tools are the only writer during a turn), keep write-through
PUTs for freshness.

### 2.2 Studio Publish: no build cache, cold sandbox

`studio/studio-deploy.ts:59-75`: Publish re-materializes and rebuilds the
exact artifacts `test_agent` just built — `filesHash` (already computed at
deploy, line 113) is a ready-made cache key. And `describeBundle`
(`sandbox-vm.ts:283-304`) always cold-spawns instead of taking the warm pool
the route already holds (`studio-routes.ts:202` passes it to chat sandboxes).

### 2.3 Worker-code cache: 8 entries / 60 s TTL

`packages/aai-server/bundle-store.ts:30-40,156-164`: hosts serving >8
churning agents re-download up-to-10 MB bundles from S3 on each cold start;
the 60 s TTL forces refetch even for the same agents although bundles are
immutable per deploy (deploys already `invalidate()`). Byte-budget the cache
(e.g. 128 MB) and drop/lengthen the TTL.

### 2.4 `bundle/load` percent-encodes the whole bundle into a `data:` URL

`guest/deno-harness.ts:243-259`: `encodeURIComponent(code)` over up to 10 MB
on the guest event loop, inside the timed cold-start `bundle/load` round trip,
in a 64 MB cgroup (source + JSON copy + percent-encoded copy live
simultaneously). Use `URL.createObjectURL(new Blob([code]))` — Deno imports
`blob:` modules — and revoke after import.

### 2.5 UI: `ChatView` / `MessageList` full-snapshot subscriptions

`packages/aai-ui/components/chat-view.tsx:65` and
`components/message-list.tsx:214` use `useSession()` but read only a few
fields — so both re-render on every `user_transcript_partial` (~5–20/s) and
every custom event, cascading into `Controls` (whose documented narrow
subscription at `controls.tsx:28` is thereby nullified). Replace with
`useSessionSelector` calls; optionally `memo()` the children.

### 2.6 UI: `ThemeProvider` merged theme not memoized

`packages/aai-ui/context.ts:123` builds `{ ...DEFAULT_THEME, ...value }`
fresh per render — in custom-client compositions this permanently defeats the
`useChatItems` row cache (`message-list.tsx:178` compares theme identity),
rebuilding every message row on each parent render. Wrap in `useMemo`.

### 2.7 Studio chat body validation double-stringifies up to 4 MB

`studio/studio-schemas.ts:76-97`: per-message `JSON.stringify` refine plus a
whole-array stringify refine ≈ 8 MB of re-serialization (tens of ms blocking)
per near-limit request, on a body just parsed from a string. Enforce the
aggregate cap from raw body byte length; cap per-message size from part
string lengths.

### 2.8 Guest stdout writes are synchronous

`guest/harness-rpc.ts:47-56`: `Deno.stdout.writeSync` loop — any single write
exceeding the ~64 KB pipe buffer while the host is busy blocks the guest's
entire event loop (all concurrent tools in that sandbox). Serialize async
writes through a promise chain; same ordering guarantee, no block.

### 2.9 OpenAI stream-repair: O(chunk²) line splitting + parse-everything

`packages/aai/host/providers/_openai-stream-repair.ts:163-207`: repeated
`buffer.slice(newline + 1)` reallocates the tail per line, and every `data:`
line is JSON-parsed even though the vast majority can never need repair. On
the LLM token stream of every AssemblyAI-gateway pipeline turn. Use a moving
start index + one tail slice per transform; substring pre-check
(`includes('"tool_calls"')` / `'"choices":null'`) before parsing.

## Priority 3 — micro / take-or-leave

+ `client/send` double-serialization: `sandbox.ts:86-100` stringifies payload
  only to measure size, then the sink re-serializes. Serialize once.
+ Guest fetch relay chunk size: `sandbox-fetch.ts:22` `CHUNK_SIZE` 64 KB →
  raise to 256 KB–1 MB to cut per-chunk framing/base64/JSON cycles.
+ Deploy path: duplicated `matchesAnyHash` (`deploy.ts:62` vs `:104-106`) and
  a guaranteed fresh-salt PBKDF2 on `POST /deploy` even for existing slugs.
+ Cold `resolveSandbox` serializes manifest read ahead of the parallel fetch
  trio (`sandbox.ts:326-349`) — one extra storage RTT per first-session-per-
  slug-per-replica.
+ Pipeline text micro-opts: `countWords` full scan per STT partial where only
  a ≥2 threshold is consumed (`pipeline-user-speech.ts:227`; use
  `scanWords(text, max(minBargeInWords, 1))`); `utteranceLooksComplete`
  allocates all word matches to read the last (`pipeline-text.ts:112-119`).
+ `bytesToPcm16` copy branch on odd `byteOffset` (`host/_pcm.ts:8-16`) —
  second small copy per mic frame; could copy straight into the accumulator.
+ UI: smooth `scrollIntoView` restarted per STT partial
  (`message-list.tsx:109-121`) — use `instant` while streaming; `useSession()`
  allocates a 15-property object per consumer render (`context.ts:63-74`).
+ `readJson` stringify→parse round trip on cache miss
  (`bundle-store.ts:89`).
+ Per-slug Prometheus label cardinality (`metrics.ts:28-47`) grows unbounded
  with tenant count — deliberate today, revisit at scale.
+ Studio `filesHash` recomputed per project GET (`studio-routes.ts:122`) —
  sub-ms now, fold into a stored hash if workspaces grow.

## Already well-optimized (verified — don't re-litigate)

+ **Browser audio path:** worklet-side resampling + Int16 conversion with
  reused buffers, ~100 ms batches posted as one transferred ArrayBuffer; 60 s
  ring-buffer playback node reused across turns; zero-copy binary WS frames,
  no base64 anywhere; mic frames dropped past 64 KiB `bufferedAmount`
  (correct live-speech policy); steady-state TTS chunks touch no React state.
+ **UI store:** `useSyncExternalStore` + cached-selector
  `useSessionSelector`; one notify per WS message; `useChatItems` row cache
  re-renders one row per append; bounded history/events/pre-init buffers;
  watermarked tail-scan hooks; AbortController-managed listeners — no leaks
  found across reconnects.
+ **Host runtime:** binary audio bypasses JSON/Zod both directions; hand-built
  JSON for outbound S2S audio; zero-copy base64 helpers; fixed-buffer PCM
  accumulator coalescing 20 ms→100 ms frames; STT/TTS opened concurrently
  with each side adopted as it lands; per-day-cached system prompt (measured
  hottest session-start item); module-scope regexes/Zod schemas; coalescing
  timers everywhere, zero `setInterval`; bounded pre-ready buffering; TTS
  clause-boundary coalescing with immediate first chunk.
+ **Server:** sandbox boot overlaps session start (only tool execution awaits
  the VM); non-blocking warm pool with fallback + background replenish;
  gVisor rootfs prepared once; PBKDF2 result caching with unclaimed-slug
  skip; TTL-cached bundle-store reads incl. confirmed-miss caching;
  incremental line scan in the guest (explicitly avoids O(n²) split);
  drain-aware NDJSON write chain with sync fast path; zero-copy fetch-relay
  chunk views + single-pass final concat; `Promise.all` upgrade path;
  keyed-lock cleanup; metrics built at module load with lazy collect.
+ **Studio/CLI:** process-lifetime system-prompt + static-asset caches; lazy
  pooled chat sandboxes; deploy worker+client builds parallel off one
  materialize; gzipped deploy payloads with retry; 300 ms-debounced watcher
  that builds the new server before closing the old; `withPreservedNodeEnv`
  around every Vite build; grep/edit tools designed to avoid whole-file I/O.
