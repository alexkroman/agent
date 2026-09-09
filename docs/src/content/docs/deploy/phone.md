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

Set the phone number's **incoming-call webhook** to your published agent's URL
with `/phone` appended — `aai publish` prints the URL, and you add the path:

```text
https://<your-agent-url>/phone                  # Twilio
https://<your-agent-url>/phone?carrier=telnyx   # Telnyx
```

The `?carrier=telnyx` matters: the route assumes Twilio otherwise, and a
Telnyx number framed as Twilio will not connect. The platform answers that
webhook with the markup that opens the media stream — that part is not
something you configure.

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
