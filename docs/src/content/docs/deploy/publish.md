---
title: Publish
description: One command to ship to the managed platform, and where your secrets go.
---

```sh
aai login      # once — links your AssemblyAI account
aai publish    # from the project directory
```

`aai publish` type-checks the project, uploads your **source**, builds it on the
platform, deploys it, and prints the URL your agent is live at.

It does not run your tests. Run `aai build` first if you want them to gate a
ship.

## Secrets

Never hardcode a key in agent code. Put it in one of these instead:

| Where | How |
| --- | --- |
| Local | `.env` in the project root |
| Production | `printf %s "$VALUE" \| aai secret put NAME` |
| In a tool | `ctx.env.MY_KEY`, or `requireEnv(ctx, "MY_KEY")` |

`aai publish` syncs `.env` into the agent's secrets **before** it deploys, so a
key that works locally works deployed — on the first publish as much as on every
later one. There is no publish-twice step.

`aai secret list` and `aai secret delete NAME` manage them after that.

## Declare the keys your tools read

Name them on the agent and a missing one is **warned about by name** at deploy
time, instead of being discovered by a caller:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support Line",
  requiredEnv: ["ORDERS_API_KEY"],
});
```

## Managing the deployed agent

```sh
aai list       # your projects
aai logs       # what the deployed agent is doing
aai delete     # remove it
```

`aai pull <project>` materializes a published project locally so it runs under
`aai dev` again.

Every command takes `--help`; see the [CLI reference](/agent/cli/) for the full
list.

## Notes

**`aai secret put` reads the value from stdin, not from an argument.** Passing
it as an argument is refused, because it would land in your shell history. On a
terminal you can just run `aai secret put NAME` and be prompted, masked.

**The CLI's own credential is separate.** `aai login` stores your AssemblyAI key
globally and is the only way the CLI authenticates — an exported
`ASSEMBLYAI_API_KEY` does not. For CI, point `AAI_CONFIG_DIR` at a config
directory holding a logged-in key.

**Not using the managed platform?** `aai build --target node|vercel|deno|modal`
emits a deployment for your own host and prints the commands to ship it — see
[Deploy anywhere](/agent/deploy/anywhere/).

## Next

- [Phone calls](/agent/deploy/phone/) — putting the published agent on a number
- [Deploy anywhere](/agent/deploy/anywhere/) — Vercel, Deno Deploy, Modal
