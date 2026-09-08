---
"aai-docs": minor
---

Add a narrative documentation site, and simplify the README onto it.

`docs/` rendered TypeDoc and nothing else, so the only documentation a user could reach was an alphabetical list of ~800 symbols — no help at all to somebody who has not yet written an `agent.ts`, which left the README to be the guide by default at 436 lines.

An Astro + Starlight site now lives under `docs/src/`: fifteen short pages across Get started, Build, Ship it, Going further and Reference. The generated reference is untouched underneath it — `docs:reference` renders TypeDoc into `docs/public/reference/`, `astro build` copies `public/` through verbatim, and `docs/dist` is still what `docs.yml` uploads. `/reference/` belongs entirely to the generated tree, which is why the handwritten CLI page sits at `/cli/`.

Three things gate it, and two of them found real defects on their first run:

- **The build runs on every PR.** CI already ran `turbo run docs`; that task now builds both halves, so a page that fails to build fails the required check rather than the Pages deploy after merge.
- **Every ` ```ts ` fence compiles**, under the same gate as the JSDoc examples (`scripts/check-doc-examples.mjs`). It rejected `createRuntimeServer(runtime)` and `stubGenerate([…])` — neither is a signature that exists. Because both gate specs scrape `MARKDOWN_FILES`' string literals, `assertEveryDocsPageListed` resolves the directory and fails naming a page nobody listed.
- **Broken internal links fail the build** (`starlight-links-validator`). This caught a defect on all fifteen pages: Astro prefixes `base` onto sidebar entries it owns and onto nothing else, so every in-page markdown link and the hero action resolved above the Pages project root.

Pagefind indexes only what Starlight marks, so site search covers the guide and not the ~780 reference files.
