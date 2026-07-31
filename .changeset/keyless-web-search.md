---
"@alexkroman1/aai": minor
---

`web_search` no longer requires `BRAVE_API_KEY`: it is now backed by
DuckDuckGo's keyless HTML endpoint (scraping approach ported from
openclaw's duckduckgo plugin, MIT). Every agent gets web search with zero
configuration; the Brave Search implementation and its key handling are
removed.
