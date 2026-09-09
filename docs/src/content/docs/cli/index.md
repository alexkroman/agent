---
title: CLI
description: The aai subcommands you will use, and what each is for.
---

`aai` is the command line for a voice agent project. It scaffolds one, runs it
locally, tests it, and ships it to production. You use it from the first line of
code onward.

```sh
npm i -g @alexkroman1/aai-cli
```

A scaffolded project ships its own copy, so the global install is optional:
`npm run dev`, `npm run build`, `npm run eval`, `npm start` and
`npm run publish:agent` map to the commands below. `npm test` is `aai test`, and
`npm run test:agent` is `aai test --only`.

Every command takes `--help` and `--json`. The tables name the flags you reach
for; `--help` has the rest.

## Building

| Command | What it does |
| --- | --- |
| `aai init [dir]` | Scaffold a new project and install its dependencies with your package manager (pnpm, npm, bun or yarn). `--template <name>` picks a template, `--force` overwrites existing files. |
| `aai templates` | List the templates `--template` accepts. |
| `aai dev` | Start a local development server and print a URL to talk to. It rebuilds on save. `--port` sets the port (default 3000); `--watch=false`, or `AAI_DEV_WATCH=0`, stops the rebuilding. |
| `aai test` | Run every spec in the project except the evals. `--only` narrows it to `agent.test.ts`. |
| `aai eval` | Run `agent.eval.test.ts`. Each suite runs against a live model when a provider key resolves, and against the scripted model when none does — see [Evals](/agent/build/evals/). |
| `aai build` | Bundle the project without deploying it. `--target node\|vercel\|deno\|modal` (detected when you omit it), `--skip-tests`, `--skip-typecheck`. |
| `aai start` | Serve a build. `--port`, `--host` (loopback by default). |

## Shipping

These five talk to the **studio** — the hosted workspace your project is
mirrored into, and what `publish` deploys from.

| Command | What it does |
| --- | --- |
| `aai login` | Link your signed-in browser account and save your API key. Do this once. |
| `aai publish` | Push to the studio and deploy to production. `--skip-typecheck`; `--force` overwrites studio-side changes instead of failing the fast-forward check. |
| `aai push` | Sync your source to the studio workspace without deploying it. `--force` as above. |
| `aai pull <project> [dir]` | Download a studio project into `dir` (default: the project name). `--force` writes into a directory that is not empty. |
| `aai list` | List your studio projects. |
| `aai logs [dir]` | Show what the deployed agent has printed. `--follow` keeps printing new output. |
| `aai delete` | Delete the studio project this directory is linked to, and its deployed agents. |

## Secrets

| Command | What it does |
| --- | --- |
| `aai secret put NAME` | Create or update a secret. The value is read from stdin, or prompted for, masked, when stdin is a terminal. |
| `aai secret list` | List the secret names. |
| `aai secret delete NAME` | Delete a secret. |

`aai publish` already syncs your `.env` into the agent's secrets, so these
commands are for changing one afterwards.

:::caution[Keep the value out of argv]
A secret passed as an argument lands in your shell history and in `ps` output.
`aai secret put` refuses one. Pipe it in instead:

```sh
printf %s "$VALUE" | aai secret put NAME
```

:::

## Workflows

These read the [background job](/agent/more/background-jobs/) API of a deployed
agent.

| Command | What it does |
| --- | --- |
| `aai workflow list` | List the workflows this agent declares. |
| `aai workflow runs <workflow>` | List recent runs of one workflow, newest first. `--limit` caps the count. |
| `aai workflow show <runId>` | Show one run, including its output. |
| `aai workflow cancel <runId>` | Stop a run that is still going. |

All four take `--agent <url>` to target a server you are running yourself
(`aai dev` on `http://localhost:3000`, say) instead of the deployed one, and
`--token` for an agent whose operator set `AAI_WORKFLOW_API_TOKEN`.

## Notes

- `--help` on any command lists every flag it accepts. A flag it does not know
  is refused rather than ignored.
- `--json` prints one result line for scripts. It turns on by itself when
  stdout is not a terminal.
- `--server <url>` points a platform command at a different platform server.
- Both spellings of a multi-word flag work: `--skip-tests` and `--skipTests`.
- Field-level options for `agent()` are in the
  [SDK reference](/agent/reference/).
