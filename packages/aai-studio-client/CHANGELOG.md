# aai-studio-client

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
