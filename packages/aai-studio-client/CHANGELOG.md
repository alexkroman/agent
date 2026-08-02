# aai-studio-client

## 0.2.0

### Minor Changes

- 293da11: The studio coding agent is now a Claude-Code-style agentic agent that runs
  INSIDE the project's own Modal sandbox, with the browser connected to it
  directly — mirroring the voice path. `POST /studio/projects/:project/
session` boots (or reuses) a guest sandbox through the same warm-pool
  machinery deployed agents use and returns the sandbox's public chat URL;
  turns stream browser→sandbox over SSE and never pass through the platform
  host. The loop runs in the guest on the caller's own key with tools over a
  real filesystem workspace — list/read (windowed)/write/edit/delete, glob,
  grep, bash (a real shell in the container), todo_write, test_agent, and
  the keyless web builtins — each with a user-friendly label served by the
  sandbox (`GET /studio/tools`) and rendered in the studio UI. End of turn,
  the guest syncs workspace edits and the conversation back over the
  authenticated control channel; test_agent builds via a guest→host RPC to
  the out-of-process build runner. The host-side chat loop, scan worker
  thread, and host tool implementations are removed — the SDK's
  `createServer` gains a `request` hook so the harness can serve the chat
  surface without a second HTTP server.

### Patch Changes

- df753ce: Remove the cascaded-agent (Assembly STT/TTS + Gemini Flash Lite) starter prompt from the studio

## 0.1.10

### Patch Changes

- 369f950: Ship a favicon.ico on the studio and voice agent pages: the AssemblyAI mark is bundled with the studio client and the default agent client, served at /favicon.ico (studio) and /:slug/favicon.ico (agents, with a custom client's own favicon taking precedence).
- 76b6f60: Default the studio coding agent to a cascaded pipeline (AssemblyAI STT, gpt-5.5 on the LLM Gateway, AssemblyAI TTS); the S2S voice agent API is now used only when the user asks for it. Codegen evals updated to grade the new default.

## 0.1.9

### Patch Changes

- 57e1807: Remove the studio's per-request LLM model picker — chat always runs on the host-configured default model (gpt-5.5 on the AssemblyAI LLM Gateway)

## 0.1.8

### Patch Changes

- e17fdc4: Remove the text-only dictation starter prompt (text-only agents are no longer a mode; use workflows)

## 0.1.7

### Patch Changes

- cf4b51f: Studio chat can switch models per request: the chat body accepts an optional `model` validated against the host-configured provider's own model list (LLM Gateway list, region-filtered), /studio/status advertises the list, and the studio client renders a model picker in the chat header. Providers and keys remain host-owned.

## 0.1.6

### Patch Changes

- ddd2aa6: Default the studio coding agent to gpt-5.5 on the LLM gateway and show the configured model as a chip in the studio chat header

## 0.1.5

### Patch Changes

- 0f95e0c: Rename the studio's user-facing brand name to AssemblyAI App Builder
- 857c7d3: Studio onboarding: expand the starter prompts to cover the aai-templates agent templates
- 8699bb4: Studio: a hung tool call no longer hangs the chat turn, and the user can cancel one.

  - Every coding-agent tool (studio, web, and MCP) now runs under a per-call deadline (`STUDIO_TOOL_TIMEOUT_MS`, default 120s) — a dead sandbox RPC or silent MCP server resolves to an error tool result instead of leaving the tool row shimmering forever.
  - The studio composer's send button becomes a Stop button while a turn streams; stopping aborts the SSE request, which cancels the server-side LLM stream, in-flight tool calls, and the session sandbox. Tool rows abandoned by a stop no longer shimmer.
  - A failed sandbox provisioning is no longer cached for the rest of the turn — one transient spawn failure used to answer "Sandbox unavailable" to every later `test_agent` call. Provisioning failures are now also logged host-side.

## 0.1.4

### Patch Changes

- 51d0e61: Studio client hardening: sign-out clears the query cache and applies to chat 401s, guided start can no longer create duplicate projects, IME-safe Enter handling, editor conflict warning for concurrent agent edits, live preview only reloads on publish, lazy-loaded code view, non-JSON API responses surface as ApiError, and new component/hook tests (removes the unused @alexkroman1/aai dependency).

## 0.1.3

### Patch Changes

- @alexkroman1/aai@1.9.2

## 0.1.2

### Patch Changes

- Updated dependencies [713025a]
  - @alexkroman1/aai@1.9.1

## 0.1.1

### Patch Changes

- Updated dependencies [0235618]
- Updated dependencies [4758dfc]
- Updated dependencies [0f72bef]
- Updated dependencies [bc62b75]
- Updated dependencies [7e67c24]
- Updated dependencies [8817f3f]
- Updated dependencies [394867e]
- Updated dependencies [8004ff8]
- Updated dependencies [262f1e7]
- Updated dependencies [257a372]
- Updated dependencies [0bdb115]
- Updated dependencies [578a840]
- Updated dependencies [c5a5351]
- Updated dependencies [0235618]
- Updated dependencies [0235618]
- Updated dependencies [a252842]
- Updated dependencies [bbb9d73]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [a413caf]
- Updated dependencies [d718fe9]
- Updated dependencies [2898f21]
- Updated dependencies [882e7d9]
- Updated dependencies [e2ee4fd]
- Updated dependencies [9750db7]
- Updated dependencies [0d024e0]
- Updated dependencies [cb2821c]
- Updated dependencies [9aed108]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [ab38293]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [860bb7d]
- Updated dependencies [82f8253]
- Updated dependencies [d718fe9]
- Updated dependencies [7240ce5]
- Updated dependencies [f22b0f4]
- Updated dependencies [0bb1a20]
- Updated dependencies [7d4a193]
- Updated dependencies [5bf4d41]
- Updated dependencies [ad295be]
- Updated dependencies [d22d9f8]
- Updated dependencies [8f2093b]
- Updated dependencies [296a874]
- Updated dependencies [752af3d]
- Updated dependencies [38f02fa]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [82f8253]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [2fd1078]
- Updated dependencies [711edeb]
- Updated dependencies [fd5a54e]
- Updated dependencies [a413caf]
- Updated dependencies [3db093f]
- Updated dependencies [0c57887]
- Updated dependencies [79e51cb]
- Updated dependencies [d718fe9]
- Updated dependencies [0235618]
- Updated dependencies [cf56703]
- Updated dependencies [115a88e]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
  - @alexkroman1/aai@1.9.0
