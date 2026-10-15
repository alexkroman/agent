---
"@alexkroman1/aai-ui": patch
---

Change the default client theme to a neutral palette (near-white background,
zinc borders, near-black primary) so an unthemed agent no longer looks like the
studio's own cream-and-indigo chrome when previewed inside it. Pass
`mountClient({ theme })` to keep the previous colors.

The default fonts are now the platform's system UI and monospace faces instead
of Monument Grotesk and JetBrains Mono, and the start-screen and console-shell
titles are a semibold sans instead of a serif. The `font-aai-serif` token stays
for clients that opt into it.
