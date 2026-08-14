---
"@alexkroman1/aai-cli": minor
---

Add four templates ported from popular LangChain/LangGraph agents. Three are voice agents: travel-concierge (the customer-support bot's specialist-desk delegation, with every booking staged for a spoken confirmation before it applies), support-line (self-RAG/CRAG document grading, query rewriting and a groundedness check before anything is said out loud), and plan-and-execute (plan-and-execute, one step per tool call so the caller can redirect between them, with real web search in the executor). The fourth, redline, is a workflow app: the reflection agent's write/critique/revise loop as a page over a durable run, exiting on the critic's journaled verdict.
