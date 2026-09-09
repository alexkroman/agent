---
title: Phone calls
description: A phone call is an ordinary session. Say which carriers may dial in.
---

A phone call runs exactly like a browser session: the same tools, the same
state, the same prompt. One field turns it on:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support Line",
  telephony: ["twilio"],
});
```

The default is empty, so an agent that lists no carrier refuses phone calls. You
have to name the ones you use.

| Value | Result |
| --- | --- |
| `["twilio"]` | Serves Twilio, refuses Telnyx |
| `["twilio", "telnyx"]` | Serves both |
| `true` | Serves every carrier this build ships a codec for |
| `false`, `[]`, or absent | Does not serve the route at all |

## Pointing a number at it

Paste the URL `aai publish` prints into the phone number's **incoming-call
webhook** field. There is one line per carrier you declared, with the
`?carrier=` parameter already filled in:

```text
telnyx webhook: https://<your-agent-url>/phone?carrier=telnyx
```

`aai publish --json` carries the same lines in its `output` field, so a script
that publishes does not have to re-derive either half.

:::caution[Do not assemble the URL by hand]
The route assumes Twilio when `?carrier=` is absent, so a Telnyx number
configured without it is verified against the wrong scheme and every call is
refused with `403 Invalid webhook signature` — a failure that names the
signature rather than the missing parameter.
:::

The platform cannot infer the carrier for you, because it stores no description
of your agent. That is why the CLI, which has your `telephony` declaration in
hand, is what prints these URLs.

The platform answers that webhook with the markup that opens the media stream.
That part is not something you configure.

## Check the signature

Signature verification turns on when the agent has the carrier's own secret, not
by a flag. Set `TWILIO_AUTH_TOKEN` (or `TELNYX_PUBLIC_KEY`) as a secret and
every request is checked:

```sh
printf %s "$TWILIO_AUTH_TOKEN" | aai secret put TWILIO_AUTH_TOKEN
```

Set neither and the route is as open as any other — anyone who learns the URL
can make your agent answer. See [Publish](/agent/deploy/publish/) for how
secrets work.

You do not have to remember this. A declared carrier whose secret is missing
from the env being uploaded is warned about by name at deploy time, beside the
provider-credential warning:

```text
telephony declares telnyx but TELNYX_PUBLIC_KEY is not set — the telnyx webhook
will be served with signature verification OFF, so anyone who knows the URL can
start a call. Declare TELNYX_PUBLIC_KEY in .env and redeploy (already set on
the platform with `aai secret put`? then this is already handled).
```

It is a warning rather than a refusal, for the same reason the credential check
is. The CLI sees the env it is about to upload, and cannot see what an earlier
`aai secret put` already stored against the agent — so a secret the platform
holds looks missing from here.
