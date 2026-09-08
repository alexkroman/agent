---
title: CLI
description: Every aai subcommand, and what it is for.
---

```sh
npm i -g @alexkroman1/aai-cli
```

A scaffolded project also exposes `dev`, `build`, `test`, `eval`, and `start`
as `npm run <name>`, which use the project's own copy of the CLI.

## Building

| Command | What it does |
| --- | --- |
| `aai init [dir]` | Scaffold a new agent project. `--template <name>` picks one. |
| `aai templates` | List available project templates. |
| `aai dev` | Start a local development server. `--port`, `--watch`. |
| `aai test` | Run `agent.test.ts`. `--all` runs every spec in the project. |
| `aai eval` | Run behaviour evals against a live model. |
| `aai build` | Bundle without deploying. `--skip-tests`, `--skip-typecheck`. |
| `aai start` | Serve the built agent. `--port`, `--host`. |

## Shipping

| Command | What it does |
| --- | --- |
| `aai login` | Link your account and save your API key. Do this once. |
| `aai publish` | Push this project and deploy it to production. |
| `aai push` | Sync source to the studio workspace without deploying. |
| `aai pull <project>` | Materialize a project into a local directory. |
| `aai list` | List your projects. |
| `aai logs` | Show what the deployed agent has printed. |
| `aai delete` | Delete the project and its deployed agents. |

## Secrets

| Command | What it does |
| --- | --- |
| `aai secret put NAME` | Set a secret. |
| `aai secret list` | List secret names. |
| `aai secret delete NAME` | Remove one. |

`aai publish` already syncs your `.env` into the agent's secrets, so these are
for changing one afterwards.

## Workflows

| Command | What it does |
| --- | --- |
| `aai workflow list` | List the workflows this agent declares. |
| `aai workflow` | Inspect and steer durable runs. |

Run any command with `--help` for its full options.
