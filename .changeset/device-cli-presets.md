---
"@alexkroman1/aai": minor
"@alexkroman1/aai-cli": minor
"aai-templates": minor
"aai-studio-server": patch
---

One-line project configs, a tunnel for `aai dev`, source-linked SDKs and local secrets.

- **`"extends": "@alexkroman1/aai/tsconfig"`** is a whole agent project's `tsconfig.json`: the compiler options the scaffold used to copy, plus `vite/client` in `types` and the `virtual:aai/agent` declaration (the scaffold's old `global.d.ts`) through its `files`. A project that sets its own `include` or `files` must also list `@alexkroman1/aai/presets/agent-env.d.ts`.
- **`defineAgentTestConfig(overrides?)`** on `@alexkroman1/aai/testing/vite` is a whole `vitest.config.ts`: `aaiAgentPlugin()`, `globals: true`, `reporters: ["default"]`. `plugins` in the overrides are appended, `test` is merged key by key.
- **No `vite.config.ts` needed.** With a `client.tsx` and no `vite.config.*`, `aai dev` and `aai build` use `@vitejs/plugin-react` (with the Fast Refresh exclude the scaffold's config carried) and `@tailwindcss/vite` from the project's own devDependencies, failing `client_plugins_missing` if either is absent. A project's own `vite.config.*` still wins. `aai init` for a template with no `client.tsx` no longer writes the UI dependencies.
- **`aai dev --tunnel`** starts a cloudflared quick tunnel (`AAI_CLOUDFLARED_PATH` or `cloudflared` on `PATH`), sets `PUBLIC_URL` to it, prints it and returns it as `publicUrl`; the tunnel exiting ends `aai dev`. **`--on-public-url <cmd>`** runs a shell command with `PUBLIC_URL` set once the server is up, and again with it empty on shutdown.
- **`AAI_DEV_SOURCE=1`** makes a CLI running from an SDK checkout (a `link:`ed SDK) resolve every SDK package through its `@dev/source` export — in Node and in every Vite build, and in `defineAgentTestConfig()` — so SDK edits need no build step.
- **`aai secret put --local NAME`** / **`aai secret delete --local NAME`** edit the project's `.env` (value from stdin or a masked prompt), keeping every other line, the file's mode, and a spelling `parseEnv` reads back unchanged.
- The scaffold ships `tsconfig.json` and `vitest.config.ts` as one line each, and no `global.d.ts` or `vite.config.ts`; studio workspaces follow it.
