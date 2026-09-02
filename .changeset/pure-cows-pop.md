---
"@alexkroman1/aai": minor
"aai-server": minor
---

Publish `@alexkroman1/aai/html` — `htmlToText`, `parseFeed` and `pageMetadata` over the htmlparser2 and html-to-text parsers the SDK already carried, so a step reading somebody else's markup gets a real parse instead of regexes. The `link-digest` and `podcast-digest` templates move onto it, dropping ~65 lines of hand-written scraping. Also: one `jitteredBackoff` in place of three byte-identical retry-delay copies (guard-invariants rule 31), and `aai-server`'s TTL cache moves from quick-lru to the lru-cache it already depended on, making its entry cap exact.
