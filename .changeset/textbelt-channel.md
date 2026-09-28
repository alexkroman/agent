---
"@alexkroman1/aai": minor
---

SMS through Textbelt, as a channel and as an opt-in builtin.

- `textbeltChannel({ key, to })` on `@alexkroman1/aai/channels` texts one number, fixed when the channel is built, so a message cannot redirect it. It works with `sendToChannel` / `sendToChannelOrFail` like `slackChannel`. Textbelt reports a refusal (out of quota, a bad number, a link on a key not yet allowed to send links) as `200 {"success": false}`, so the channel turns that into a non-retryable `ChannelDeliveryError` instead of counting it as delivered. A 5xx or 429 is still retryable. The rendered text is capped at `TEXTBELT_MAX_MESSAGE_CHARS` (1,000) and ends with an ellipsis when cut. It is sent as one text, which Textbelt splits into segments and bills per segment.
- `allowedSmsRecipient(claimed, env)` picks the number a "text me" may reach. That is `claimed` only if its E.164 form equals `SMS_TO_PHONE` or one of the comma-separated `SMS_ALLOWED_PHONES`, and otherwise `SMS_TO_PHONE`. A workflow step can apply the same rule as the builtin.
- New `text_me` builtin, off unless listed in `builtinTools`. It texts the owner the full version of something too long to say. It takes `message` and an optional http(s) `url`, reads `TEXTBELT_KEY`, and picks the recipient with `allowedSmsRecipient(sessionClientPhone(ctx), ctx.env)`. The model never chooses the number. A failure is returned as the tool's result, not thrown.
