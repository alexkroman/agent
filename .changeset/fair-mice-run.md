---
"@alexkroman1/aai-ui": patch
---

Change the default client theme to a neutral palette (near-white background,
zinc borders, near-black primary) so an unthemed agent no longer looks like the
studio's own cream-and-indigo chrome when previewed inside it. Pass
`mountClient({ theme })` to keep the previous colors.
