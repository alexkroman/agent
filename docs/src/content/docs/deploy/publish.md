---
title: Publish
description: One command to ship, and where your secrets go.
---

```sh
aai login      # once — links your AssemblyAI account
aai publish    # from the project directory
```

`aai publish` bundles the project, uploads it, syncs the keys in your `.env`
as agent secrets, and prints a URL.

The project is type-checked before it deploys. Run `aai build` first if you
want the full test suite to gate it too — that is what `aai build` does, and
it emits the same artifact.

## Secrets

Never hardcode a key in agent code.

| Where | How |
| --- | --- |
| Local | `.env` in the project root |
| Production | `aai secret put NAME` |
| In a tool | `ctx.env.MY_KEY`, or `requireEnv(ctx, "MY_KEY")` |

`aai publish` syncs `.env` into the agent's secrets for you, so a key that
works locally works deployed. `aai secret list` and `aai secret delete NAME`
manage them after that.

Declare the keys your tools read on the agent, and a missing one is named at
publish time instead of discovered by a caller:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support Line",
  requiredEnv: ["ORDERS_API_KEY"],
});
```

`aai login` stores your AssemblyAI key globally and is the only way the CLI
authenticates — an exported `ASSEMBLYAI_API_KEY` does not. For CI, point
`AAI_CONFIG_DIR` at a config directory holding a logged-in key.

## Afterwards

```sh
aai list       # your projects
aai logs       # what the deployed agent is doing
aai delete     # remove it
```

`aai pull <project>` materializes a published project locally so it runs under
`aai dev` again.
