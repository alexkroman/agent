---
title: Phone calls
description: A phone call is an ordinary session. Say which carriers may dial in.
---

Nothing below the carrier bridge knows a call is a phone call. It speaks the
same protocol the browser does, so interruption handling, history, and every
option behave identically.

One field opts in:

```ts
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support Line",
  telephony: ["twilio"],
});
```

`telephony` is an **allow-list, and its default is empty** — an agent that
declares nothing refuses the connection. That is deliberate: the phone route
starts the same session on the same credentials as the browser one, but it is
reached by a URL a carrier dials rather than by the page your deployment
serves, so who may reach it is a decision each agent makes.

| Value | Result |
| --- | --- |
| `["twilio"]` | Serves Twilio, refuses Telnyx |
| `["twilio", "telnyx"]` | Both |
| `true` | Every carrier this build ships a codec for |
| `false`, `[]`, or absent | The route is not served at all |

Point your Twilio Media Streams or Telnyx media-streaming webhook at the
published agent's `/phone` URL, which `aai publish` prints. The carrier's own
webhook signature is checked where the webhook lands.

Nothing else changes. The same tools, the same state, the same prompt.
