---
"@alexkroman1/aai": minor
---

Agents declare which phone carriers may reach them: `agent({ telephony: ["twilio"] })` mounts `WS /phone` for exactly those carriers, and an agent that declares none no longer serves the route at all. Previously every voice agent served Twilio and Telnyx framing from boot — `aai dev`, a self-hosted server and every deployed sandbox alike — whether or not it had a phone number. `RuntimeServerOptions.telephony` / `AgentServerOptions.telephony` take the same declaration (a boolean or a carrier list) and default to the agent's own; an unknown carrier is still refused with a 400, and a real carrier the agent did not declare with a 404.
