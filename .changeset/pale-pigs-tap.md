---
"@alexkroman1/aai": minor
---

Add ctx.workflows.publicWebhookUrl(token) — the PUBLIC callback URL a durable run hands a third party, built from a new publicUrl option on createRuntime/createAgentServer. The Workflow DevKit's own hook.url is composed from getWorkflowMetadata().url, which is http://localhost:<port> off the running process, so a deployed agent was handing out the inside of a sandbox that has self-exited by the time the callback arrives. Unconfigured, the accessor throws naming the option rather than minting a localhost URL that fails days later at somebody else's server.
