---
"@alexkroman1/aai": minor
---

Replace three hand-rolled parsers with the libraries already in the tree: the workflow run event stream now parses with `eventsource-parser` (the parser aai-studio-client already uses, and a transitive dependency besides), `web_search` extracts DuckDuckGo results with `htmlparser2` instead of six regexes, and tool-call argument salvage repairs with `jsonrepair` in place of a hand-written control-character escaper and fence regex.

This fixes three silent failures. A CRLF event stream parsed as zero frames, so every workflow run fell back to polling; `web_search` dropped results whose markup used single quotes and could lift `<script>` text into a description; and tool-call arguments with an unquoted key were handed to the tool as an EMPTY object, reported as success, because `parsePartialJson` calls that a repaired parse. Repairing now also covers single-quoted strings, unquoted keys, Python `None`/`True`/`False`, comments, and fences that are not anchored to the whole payload.

The `entities` dependency is removed from `@alexkroman1/aai` — htmlparser2 decodes text and attributes itself.
