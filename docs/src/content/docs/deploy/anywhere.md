---
title: Deploy anywhere
description: One flag builds for Vercel, Deno Deploy, Modal, or plain Node.
---

[`aai publish`](/agent/deploy/publish/) ships to the managed platform. When
you'd rather own the hosting, `aai build --target <host>` emits a deployment
for one of four, and prints the exact sequence to deploy it:

```sh
aai build --target vercel
aai build --target deno
aai build --target modal
aai build --target node     # the default
```

| Target | What it emits | Deployed with |
| --- | --- | --- |
| `node` | nothing extra — just the worker | `aai start`, in any container |
| `vercel` | a prebuilt deployment in `.vercel/output/` | `vercel deploy --prebuilt` |
| `deno` | a self-contained `.aai/deno/` | `deno deploy --prod` |
| `modal` | a self-contained `.aai/modal/` with an `app.py` | `modal deploy` |

## The flag is usually optional

`aai build` detects the host it is running on. A Vercel build sets `VERCEL`,
and Deno Deploy's git integration sets `DENO_DEPLOYMENT_ID` — so pointing
either platform at your repository needs no configuration and no flag.

The flag is for the other direction: building on **your** machine and uploading
the result. That is the whole story for Modal, which runs no build of its own,
so `--target modal` is the only way to reach it.

## It prints the sequence, not one command

For every target but `node`, the build ends by printing the ordered steps —
with what it knows already filled in:

```text
Deploy it with:
  1. deno deploy create --source local --region us --runtime-mode dynamic
       --entrypoint server.mjs --do-not-use-detected-build-config
       --org <ORG> --app <APP>                       (first deploy only)
  2. deno deploy env add ASSEMBLYAI_API_KEY <value> --org <ORG> --app <APP>
  3. cd .aai/deno && deno deploy --prod --org <ORG> --app <APP>
Re-run `aai build --target deno` before every deploy.
```

Two things worth noticing:

- **Set the secrets before the first deploy.** Some hosts fail the deploy
  outright when one is missing, rather than starting and failing later.
- **Re-run `aai build` before every deploy.** The host uploads whatever is in
  the emitted directory, so a stale build ships and reports success.

`<ORG>`, `<APP>` and `<value>` stay as placeholders: they are account state and
secrets, and the build knows neither.

`aai build --target <host> --json` returns the same steps as data, including
the build step the printed version omits — a CI job scripting a fresh checkout
needs it.

## Trying one locally

Every target but Vercel can be run before you deploy it:

```sh
aai start                              # node
cd .aai/deno && deno task start        # deno
modal serve .aai/modal/app.py          # modal
```

## Declaring your keys

Whichever host you pick, list what your tools read in `requiredEnv` — see
[Publish](/agent/deploy/publish/). The build warns by name about anything the
deployment will be missing.

Your `.env` is never uploaded to the host. The secret step in the printed
sequence is how the values get there.
