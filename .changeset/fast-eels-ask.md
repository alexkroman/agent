---
"aai-studio-server": patch
"aai-server": patch
---

Studio: rotating the account API key releases the old key's owner mapping, so
its holder's CLI no longer lands in the rotating account's scope; DELETE …/file
deletes an empty file and 404s a name only the file map's prototype holds
