---
"@alexkroman1/aai": patch
---

Agents can press phone keys: `sendDtmf(ctx, keys)` (on
`@alexkroman1/aai/experimental`) plays DTMF tones into the session's audio,
which a `WS /phone` call carries to the carrier in-band, so an agent can answer
an automated phone menu ("press 1 for…") or enter an extension.
`sentDtmfCalls(ctx)` reads back what a `createToolContext` tool pressed. The
outbound-call-agent template gains a `press_keys` tool and prompt guidance for
phone menus.
