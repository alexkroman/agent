# @alexkroman1/aai-cli

The `aai` command — scaffold, run, test, and publish aai voice agents.

```sh
npm i -g @alexkroman1/aai-cli
```

## Commands

| Command | What it does |
| --- | --- |
| `aai init [dir]` | Scaffold a new agent project (`--template <name>`, `--yes`) |
| `aai templates` | List the shipped project templates |
| `aai dev` | Local dev server: loads `agent.ts`, rebuilds on change, serves the browser client (`--port`) |
| `aai test` | Run the project's vitest suite |
| `aai eval` | Run the project's behaviour evals (`agent.eval.test.ts`) — a real session, a live model with a key, a scripted one without |
| `aai build` | Bundle without deploying (type-checks first; `--skipTypecheck` opts out) |
| `aai list` | List your studio projects |
| `aai pull <project>` | Pull a studio project into a local directory, ready for `aai dev` |
| `aai push` | Sync this project's source to its studio workspace (fast-forward-checked; `--force` overwrites) |
| `aai publish` | Push, then deploy to production — the studio's Publish button from the terminal (`.env` syncs as agent secrets) |
| `aai start` | Serve the built agent from a plain Node process — no platform account |
| `aai delete` | Remove a deployed agent |
| `aai login` | Link the account the CLI acts as |
| `aai secret put\|delete\|list` | Manage a deployed agent's secrets |
| `aai logs` | Read the deployed agent's log ring (`--follow` polls it) |
| `aai workflow list\|runs\|show\|cancel` | Inspect the deployed agent's durable workflow runs |

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

`aai publish` type-checks the project locally, then builds and deploys inside
the project's sandbox — byte-for-byte the studio's Publish path. It preflights
the credentials the agent declares, and prints the agent's public URL.

## Notes

- A bare `aai` in a project directory offers to publish (TTY-confirmed);
  outside one it runs `init`.
- `--server <url>` targets a self-hosted platform; the origin is remembered
  in your user config after explicit approval.
- `aai login` is the only way to authenticate — it links an account already
  signed in to the studio. An exported `ASSEMBLYAI_API_KEY` does not log you
  in; in a project that variable is a provider credential for `aai dev`.
- The API key is stored `0600` in your user config dir (`AAI_CONFIG_DIR`
  overrides the location). Non-interactive callers point `AAI_CONFIG_DIR` at a
  config dir holding a key from an interactive `aai login`.

## Documentation

SDK API reference: <https://alexkroman.github.io/agent/>
