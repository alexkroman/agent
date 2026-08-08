---
"@alexkroman1/aai": minor
---

Add the `@alexkroman1/aai/slugify` subpath (`slugifyName`) — one normalization of a human name into the platform slug grammar, shared by the CLI, the platform server, and the studio. The CLI's directory-derived project name previously used a hand-rolled regex, so `Café Ordering/` pushed as `caf-ordering` where the studio produced `cafe-ordering`.
