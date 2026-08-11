---
"aai-studio-server": patch
---

Show the agent's API URLs on the studio Settings pane, each with a copy button. The studio frames the agent in an iframe, which is the one place its address is never visible, and the address is not guessable: it needs the platform origin and the published slug rather than the project name. Both the session and workflow endpoints are listed because the platform stores no agent config and so cannot tell which one a project serves.
