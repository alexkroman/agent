# aai-studio-client — the studio's browser front-end (private)

Vite + React + Tailwind v4, served by aai-server. It talks to
[aai-studio-server](../aai-studio-server/CLAUDE.md) purely over HTTP/SSE — no
code imports in either direction. Repo-wide conventions live in the root
[CLAUDE.md](../../CLAUDE.md).

## Key files

- `packages/aai-studio-client/` — the studio's React front-end (Vite +
  Tailwind v4 + `useChat` + TanStack Query + CodeMirror), its own private
  workspace package built into its `dist/` by
  `pnpm --filter aai-studio-client build`. It talks to the server purely
  over HTTP/SSE (no code imports in either direction); aai-server serves
  the built artifact, resolved via `require.resolve` in
  `studio-static.ts` the same way aai-ui's `dist/default-client` is.
  Panes: `chat.tsx` (chat + composer), `code-view.tsx` / `preview.tsx`
  (the Code/Preview pane).
