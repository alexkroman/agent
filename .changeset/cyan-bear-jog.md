---
"@alexkroman1/aai": minor
---

Add a channels concept to the API: `@alexkroman1/aai/channels` publishes a serializable channel descriptor, a platform-neutral `ChannelMessage`, and `sendToChannel`, which renders and posts one and classifies the refusal. Slack is the first channel — `slack({ webhookUrl })` covers both incoming webhooks (Block Kit) and workflow triggers (flat variables), with `isSlackWebhookUrl` published so the destination can be refused at the form's edge. `sendToChannelClassified` on `/step-errors` is the pre-classified caller.
