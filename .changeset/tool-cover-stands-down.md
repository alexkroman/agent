---
"@alexkroman1/aai": patch
"@alexkroman1/aai-runtime": patch
---

The generic dead-air phrase ("I'm checking on this.") no longer plays as a preamble to a tool turn's answer.

Once a tool call that declares its own cover (a `start` or `delayed` message) begins, the transport's dead-air cover stays silent for the rest of that turn, not only while the call runs. Before, a lookup that returned quickly left the generic cover armed, and it fired a beat before the reply, which played as "I'm checking on this. It's 59 degrees…". Tools with no cover of their own are unchanged.

The network builtins (`web_search`, `visit_webpage`, `get_page_design`, `fetch_json`, `open_meteo`, `brave_search`, `google_places`) now declare a single `delayed` hold line at 2.5s, so a fast call says only its answer and a slow one still says what it is doing.
