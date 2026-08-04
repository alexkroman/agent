# @alexkroman1/aai-cli

The `aai` command — scaffold, run, test, and publish aai voice agents.

```sh
npm i -g @alexkroman1/aai-cli   # or: npx @alexkroman1/aai-cli@latest
```

## Commands

| Command | What it does |
| --- | --- |
| `aai init [dir]` | Scaffold a new agent project (`--template <name>`, `--yes`) |
| `aai templates` | List the shipped project templates |
| `aai dev` | Local dev server: loads `agent.ts`, rebuilds on change, serves the browser client (`--port`) |
| `aai test` | Run the project's vitest suite |
| `aai build` | Bundle without deploying (type-checks first; `--skipTypecheck` opts out) |
| `aai list` | List your studio projects |
| `aai pull <project>` | Pull a studio project into a local directory, ready for `aai dev` |
| `aai push` | Sync this project's source to its studio workspace (fast-forward-checked; `--force` overwrites) |
| `aai publish` | Push, then deploy to production — the studio's Publish button from the terminal (`.env` syncs as agent secrets) |
| `aai delete` | Remove a deployed agent |
| `aai secret put\|delete\|list` | Manage a deployed agent's secrets |
| `aai storage status\|enable\|disable` | Manage the agent's opt-in SQL database (`ctx.db`) |

Every command accepts `--json` for machine-readable output (auto-detected
when stdout is not a TTY). `aai <command> --help` shows flags.

## Typical flow

```sh
aai init my-agent --template pizza-ordering
cd my-agent
# put ASSEMBLYAI_API_KEY=... in .env
aai dev            # talk to it at the printed URL
aai publish        # ship it; .env values become the agent's secrets
```

Every published agent is also a **studio project**: publishing prints a
studio link where the same source can be edited in the browser (with the
coding agent), and `aai pull` brings those edits back to your machine.
`push`/`pull` are fast-forward-only — an edit made in the studio since your
last pull surfaces as a conflict instead of being overwritten.

Publishes type-check the project locally, then build and deploy inside the
project's sandbox — byte-for-byte the studio's Publish path — preflight
required credentials, and print the agent's public URL.

## Notes

- A bare `aai` in a project directory offers to publish (TTY-confirmed);
  outside one it runs `init`.
- `--server <url>` targets a self-hosted platform; the origin is remembered
  in your user config after explicit approval.
- The API key is stored `0600` in your user config dir (`AAI_CONFIG_DIR`
  overrides the location).

## Documentation

SDK API reference: <https://alexkroman.github.io/agent/>
