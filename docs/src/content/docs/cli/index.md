---
title: CLI
description: The aai subcommands you will use, and what each is for.
---

```sh
npm i -g @alexkroman1/aai-cli
```

A scaffolded project ships its own copy of the CLI, so you can also run it
without a global install: `dev`, `build`, `eval`, `start` and `publish:agent`
are `npm run <name>`. Its `npm test` is `aai test`, which runs the whole suite;
`npm run test:agent` narrows that to `agent.test.ts`.

## Building

| Command | What it does |
| --- | --- |
| `aai init [dir]` | Scaffold a new agent project and install its dependencies with your package manager (pnpm, npm, bun or yarn). `--template <name>` picks a template. |
| `aai templates` | List the available project templates. |
| `aai dev` | Start a local development server and print a URL to talk to. `--port` sets the port; it rebuilds on save unless you pass `--watch=false` (or set `AAI_DEV_WATCH=0`). |
| `aai test` | Run every non-eval spec in the project. `--only` narrows it to `agent.test.ts`. |
| `aai eval` | Run the behaviour evals. Each suite runs against a live model when a provider key resolves, and against the scripted model when none does — see [Evals](/agent/build/evals/). |
| `aai build` | Bundle the project without deploying it. `--target node\|vercel\|deno\|modal`, `--skip-tests`, `--skip-typecheck` (`--help` spells the last two `--skipTests`/`--skipTypecheck`; both forms work). |
| `aai start` | Serve the built agent. `--port`, `--host`. |

## Shipping

| Command | What it does |
| --- | --- |
| `aai login` | Link your account and save your API key. Do this once. |
| `aai publish` | Bundle, upload, and deploy this project to production. |
| `aai push` | Sync your source to the studio workspace without deploying it. |
| `aai pull <project>` | Download a project into a local directory. |
| `aai list` | List your projects. |
| `aai logs` | Show what the deployed agent has printed. |
| `aai delete` | Delete the project and its deployed agents. |

## Secrets

| Command | What it does |
| --- | --- |
| `aai secret put NAME` | Set a secret. The value is read from stdin, or prompted for, masked, when stdin is a terminal. |
| `aai secret list` | List the secret names. |
| `aai secret delete NAME` | Delete a secret. |

`aai publish` already syncs your `.env` into the agent's secrets, so these
commands are for changing one afterwards.

:::caution[Keep the value out of argv]
A secret passed as an argument lands in your shell history. Pipe it in
instead:

```sh
printf %s "$VALUE" | aai secret put NAME
```

:::

## Workflows

| Command | What it does |
| --- | --- |
| `aai workflow list` | List the workflows this agent declares. |
| `aai workflow runs` | List recent runs of one workflow, newest first. |
| `aai workflow show` | Show one run, including its output. |
| `aai workflow cancel` | Cancel a run that is still going. |

Run any command with `--help` for its full options. These tables name the ones
you will reach for, not every flag. Field-level options for `agent()` are in
the [SDK reference](/agent/reference/).
