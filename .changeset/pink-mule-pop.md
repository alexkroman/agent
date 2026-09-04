---
"@alexkroman1/aai": minor
---

Network builtins take a `signal`, and an untyped call can no longer ignore `ToolFailure`. `fetchJson`/`visitWebpage`/`webSearch` (`@alexkroman1/aai/tools`) accept `signal` in `CallOptions` and both call shapes, folded into the builtin's own request deadline with `AbortSignal.any` — so "pass `ctx.signal` to anything slow" no longer means abandoning the screened fetch for a raw one. Their default type argument is `Record<string, DefaultToolResult>` rather than `DefaultToolResult`: `any | ToolFailure` collapsed to `any`, so an untyped call could read any field off a result that was really `{ error }`. Past an `isToolFailure` narrowing a field is still `any`, so loose call sites need no cast; a non-object body (a top-level array) now needs the type argument.
