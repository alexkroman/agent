---
"@alexkroman1/aai": minor
---

New "send" provider type: an outbound channel the agent can post to, declared as `send: slack()` from `@alexkroman1/aai/send`. Declaring a channel registers a `send_message` builtin tool and allowlists the channel's host for sandboxed tool code; `openSender()` resolves descriptors into a fetch-based `Sender` that works on the host and inside the guest sandbox. First channel: Slack incoming webhooks (`SLACK_WEBHOOK_URL`).
