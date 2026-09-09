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

The default is empty: an agent that lists no carrier refuses phone calls.
You have to name the ones you use.

| Value | Result |
| --- | --- |
| `["twilio"]` | Serves Twilio, refuses Telnyx |
| `["twilio", "telnyx"]` | Both |
| `true` | Every carrier this build ships a codec for |
| `false`, `[]`, or absent | The route is not served at all |

## Pointing a number at it

**The deploy prints the URL to paste, one per carrier you declared**, with the
`?carrier=` parameter already filled in — copy it into the phone number's
**incoming-call webhook** field:

```text
telnyx webhook (paste into the phone number's config): https://<your-agent-url>/phone?carrier=telnyx
```

It is on the `--json` result too, as `webhooks`, so a script that deploys can
configure the number without re-deriving either half.

Nothing here has to be assembled by hand, and it is worth not assembling: the
route assumes Twilio when the parameter is absent, so a Telnyx number
configured without it is verified against the wrong scheme and every call is
refused with `403 Invalid webhook signature` — a failure that names the
signature rather than the missing parameter. The platform cannot infer the
carrier for you; it stores no description of your agent, which is why the CLI,
which has your `telephony` declaration in hand, is what prints this.

The platform answers that webhook with the markup that opens the media stream —
that part is not something you configure.

## Check the signature

Signature verification turns on when the agent has the carrier's own secret,
not by a flag. Set `TWILIO_AUTH_TOKEN` (or `TELNYX_PUBLIC_KEY`) as a secret
and every request is checked:

```sh
printf %s "$TWILIO_AUTH_TOKEN" | aai secret put TWILIO_AUTH_TOKEN
```

Set neither and the route is as open as any other — anyone who learns the URL
can make your agent answer. See [Publish](/agent/deploy/publish/) for how
secrets work.

**You do not have to remember this either.** A declared carrier whose secret is
missing from the env being uploaded is warned about by name at deploy time,
beside the provider-credential warning:

```text
telephony declares telnyx but TELNYX_PUBLIC_KEY is not set — the telnyx webhook
will be served with signature verification OFF, so anyone who knows the URL can
start a call.
```

It is a warning and not a refusal, for the same reason the credential check is:
the CLI sees the env it is about to upload and cannot see what an earlier
`aai secret put` already stored against the agent, so a secret the platform
holds looks missing from here.
