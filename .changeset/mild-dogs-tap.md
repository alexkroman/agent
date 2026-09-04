---
"@alexkroman1/aai-cli": patch
---

aai secret put no longer blocks forever: the value source is decided by stdin rather than by the output mode, an idle stdin gives up after 10s naming both working forms, a value passed as an argument is refused instead of silently discarded, and `--help` documents the stdin contract. JSON-mode output is stripped of ANSI escapes, so a bundler's coloured diagnostic is legible in the envelope, and an unknown command is reported as a JSON result naming the command instead of a colour-escaped sentence on stderr.
