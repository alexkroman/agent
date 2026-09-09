---
"@alexkroman1/aai": patch
---

Stop the API reference landing page rendering `AAI SDK` twice.

TypeDoc renders the project `name` as that page's own `<h1>` — plus the toolbar link and the `<title>` — and `docs/home.md`, which is the page's readme body, opened with `# AAI SDK` as well, so it stacked two identical `<h1>AAI SDK</h1>` elements at the top. The heading is gone from `home.md`; verified by reading the built page before and after (`docs/public/reference/index.html`, which Astro copies to `docs/dist/reference/`), two `<h1>` down to one, with the `<title>`, the toolbar and every `##` heading unchanged.

`home.md` now starts on its first sentence, with a `markdownlint-disable-next-line MD041` above it — so `check:markdown`'s "first line should be a top-level heading" is off for one LINE rather than the file being added to `ignores`, and every other rule still reads the ~90 lines of prose below it.

One thing to know before editing that comment: TypeDoc does not strip an HTML comment, it passes it through — invisible in HTML, which is what makes the directive harmless — but the markdown parser still reads its CONTENTS. A first attempt put the explanation there as a multi-line comment quoting `# AAI SDK` in backticks, and the backticks became a `<code>` element that broke the comment open and leaked the text into the page as a second `<h1>`, reproducing the exact defect it was explaining. The reasoning lives in `docs/CLAUDE.md`; the comment in `home.md` is one character-free line.

Nothing downstream regenerates: the markdown rendering sets `readme: "none"`, so `home.md` reaches `docs/dist` only.
