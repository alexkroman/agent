---
"aai-guest": minor
"aai-studio-server": minor
"aai-server": minor
"@alexkroman1/aai": minor
"aai-studio-client": minor
---

The studio coding agent is now a Claude-Code-style agentic agent that runs
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
