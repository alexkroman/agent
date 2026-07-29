---
"@alexkroman1/aai": minor
---

Add a `get_page_design` builtin that fetches a webpage's raw HTML and CSS — markup with scripts/comments stripped, `<style>` blocks, and linked stylesheets — so an agent can study or mimic another site's visual design. Every request (page and stylesheets) goes through the SSRF-safe fetch; a blocked or failing stylesheet degrades to a per-sheet error. The studio coding agent now gets the tool alongside `visit_webpage`.
