---
"aai-studio-server": patch
"aai-server": patch
---

Slim the studio to voice agents only: remove the Voice agent / Workflow project
kind (one system prompt, one starter list), the API, Workflows and Logs panes,
the public /studio/api/<slug> page, and the Secrets pane's .env paste box. The
Twilio and Telnyx webhook URLs move to the Settings pane.
