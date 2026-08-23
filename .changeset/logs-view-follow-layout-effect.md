---
"aai-studio-server": patch
---

Studio Logs pane: follow the bottom in a `useLayoutEffect` rather than a
`useEffect`, so the frame that first shows a new line already shows it scrolled
to. A passive effect runs after paint, so the browser drew one frame with the
line rendered and the scroller still at its old offset — a jump on every line
while following, at whatever rate the agent logs.

Named on `aai-studio-server` deliberately: the change is in
`aai-studio-client`, whose `dist/` is baked into the one Modal image, and
`deploy.yml` fires on a bump to `aai-server` or `aai-studio-server` — so a
changeset naming only the client would ship this to nothing.
