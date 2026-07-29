---
"@alexkroman1/aai-cli": minor
---

Security, correctness, and CLI-behavior fixes from a full package review.

Security hardening:

- The global `config.json` (which stores the API key) is now written with
  `0600` permissions (dir `0700`); an existing world-readable config is
  tightened on the next write.
- Loopback origins supplied by a repo's `.aai/project.json` are no longer
  implicitly trusted with the API key — approve them with `--server` like any
  other origin. Dev mode is unaffected.
- The `slug` from `.aai/project.json` is validated against the platform slug
  shape before being interpolated into request paths, and
  `aai secret delete` URL-encodes the secret name.
- `AAI_TEMPLATES_REF` is validated as a git-ref shape.

Behavior fixes:

- `ensureApiKey` fails fast with a clear error instead of prompting when
  there is no TTY (the hidden prompt used to swallow piped stdin — e.g. the
  secret value in `echo "$V" | aai secret put NAME --json` — and hang).
- A typo'd flag (`aai -v`, `aai --hlep`) no longer silently triggers a
  production deploy; only a truly bare `aai` runs the default command, and an
  implicit deploy now asks for confirmation on a TTY.
- `aai dev` no longer unconditionally demands an AssemblyAI key — the key is
  only requested when the agent's providers need it (`aai init --skip-api` is
  now a deprecated no-op; platform commands resolve the key after the
  server-trust check).
- Deploy env semantics: an `ASSEMBLYAI_API_KEY` declared in `.env`
  deliberately wins over the CLI login key (the login key is a floor,
  matching the server's `defaultEnv` merge).
- A deploy that succeeds but fails to write `.aai/project.json` now surfaces
  the slug loudly instead of reading as a failed deploy; a deploy failure
  during `aai init` warns and keeps the scaffolded project instead of failing
  the whole init.
- `aai dev`: signal handlers install before startup so Ctrl-C during boot is
  clean; Vite uses `strictPort` so the printed URL can't point at the wrong
  server; the giget template extraction dir is cleaned up on success.

Internals/deps: single `ensureApiKey` owner, `_delete.ts` merged into
`delete.ts`, dead `sessionId` config field and unused `./types` subpath
export removed, `dotenv` replaced by `node:util` `parseEnv`, `consola`
replaced by `picocolors`, `execa` bumped to v10, zod kept off the CLI
startup path.
