---
title: CLI
description: The aai subcommands you will use, and what each is for.
---

```sh
npm i -g @alexkroman1/aai-cli
```

A scaffolded project also exposes `dev`, `build`, `eval`, `start` and
`publish:agent` as `npm run <name>`, using the project's own copy of the CLI.
Its `npm test` is `aai test`, which runs the whole suite; `npm run test:agent`
narrows that to `agent.test.ts`.

## Building

| Command | What it does |
| --- | --- |
| `aai init [dir]` | Scaffold a new agent project and install its dependencies with your package manager (pnpm, npm, bun or yarn). `--template <name>` picks a template. |
| `aai templates` | List available project templates. |
| `aai dev` | Start a local development server. `--port`; watches for file changes at a terminal, `--watch=false` (or `AAI_DEV_WATCH=0`) to turn that off. |
| `aai test` | Run every non-eval spec in the project. `--only` narrows it to `agent.test.ts`. |
| `aai eval` | Run behaviour evals against a live model. |
| `aai build` | Bundle without deploying. `--target node\|vercel\|deno\|modal`, `--skip-tests`, `--skip-typecheck`. |
| `aai start` | Serve the built agent. `--port`, `--host`. |

## Shipping

| Command | What it does |
| --- | --- |
| `aai login` | Link your account and save your API key. Do this once. |
| `aai publish` | Bundle, upload, and deploy this project to production. |
| `aai push` | Sync source to the studio workspace without deploying. |
| `aai pull <project>` | Materialize a project into a local directory. |
| `aai list` | List your projects. |
| `aai logs` | Show what the deployed agent has printed. |
| `aai delete` | Delete the project and its deployed agents. |

## Secrets

| Command | What it does |
| --- | --- |
| `aai secret put NAME` | Set a secret. The value is read from stdin. |
| `aai secret list` | List secret names. |
| `aai secret delete NAME` | Remove one. |

The value never goes in argv — it would land in your shell history:

```sh
printf %s "$VALUE" | aai secret put NAME
```

`aai publish` already syncs your `.env` into the agent's secrets, so these are
for changing one afterwards.

## Workflows

| Command | What it does |
| --- | --- |
| `aai workflow list` | List the workflows this agent declares. |
| `aai workflow runs` | List recent runs of one workflow, newest first. |
| `aai workflow show` | Show one run, including its output. |
| `aai workflow cancel` | Stop a running workflow run. |

Run any command with `--help` for its full options — this table names the ones
you will reach for, not every flag. Field-level options for `agent()` are in
the [SDK reference](/agent/reference/).
