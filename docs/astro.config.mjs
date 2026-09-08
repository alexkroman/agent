// Copyright 2026 the AAI authors. MIT license.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

/**
 * The narrative documentation site.
 *
 * Two trees land in one `dist/`, and the split is deliberate: this Astro build
 * renders the HANDWRITTEN guide, and `pnpm docs:api` renders the generated
 * TypeDoc reference into `public/reference/`, which Astro copies through
 * untouched. So the reference keeps its own tuned TypeDoc config (see
 * `typedoc.json`) and its own gates, and the guide never has to restate a
 * signature that a generator already owns.
 *
 * The output directory is unchanged (`docs/dist`), so `.github/workflows/docs.yml`
 * uploads the same path it always did.
 *
 * `/reference/` belongs entirely to TypeDoc, which is why the handwritten CLI
 * page sits at `/cli/` rather than under it — a generated tree and an authored
 * one sharing a URL prefix is a collision waiting for the first entry point
 * named like one of these pages.
 */

/**
 * GitHub Pages serves a project site under the repository name. Every absolute
 * link in this config has to carry it — Starlight prefixes `base` onto sidebar
 * links it owns, but `public/` assets are copied verbatim and get no prefix.
 */
const base = "/agent";

export default defineConfig({
  site: "https://alexkroman.github.io",
  base,
  outDir: "./dist",
  integrations: [
    starlight({
      // A broken cross-link is the failure these pages are most exposed to —
      // fifteen documents that route the reader to each other constantly — and
      // Astro does not check links on its own, so `turbo run docs` (which CI
      // runs on every PR) would have shipped one silently.
      plugins: [
        starlightLinksValidator({
          // `/reference/` is TypeDoc's tree, copied out of `public/` after the
          // content collection is built, so the validator cannot see it. It is
          // covered instead by the `docs` task rendering both halves together:
          // a reference that failed to render fails the build before this runs.
          exclude: [`${base}/reference/`, `${base}/reference/**`],
        }),
      ],
      title: "aai",
      description:
        "A voice agent is a directory of TypeScript files. Talk to it in your browser, put it on a phone number, ship it with one command.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/alexkroman/agent" }],
      editLink: {
        baseUrl: "https://github.com/alexkroman/agent/edit/main/docs/",
      },
      customCss: ["./src/styles/theme.css"],
      // Every page is short enough that a right-hand rail of two headings adds
      // furniture rather than navigation.
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 2 },
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Quickstart", link: "/start/quickstart/" },
            { label: "How it works", link: "/start/how-it-works/" },
          ],
        },
        {
          label: "Build",
          items: [
            { label: "Your agent", link: "/build/agent/" },
            { label: "Tools", link: "/build/tools/" },
            { label: "Remembering things", link: "/build/state/" },
            { label: "Testing", link: "/build/testing/" },
          ],
        },
        {
          label: "Ship it",
          items: [
            { label: "Run it locally", link: "/deploy/local/" },
            { label: "Publish", link: "/deploy/publish/" },
            { label: "Phone calls", link: "/deploy/phone/" },
          ],
        },
        {
          label: "Going further",
          items: [
            { label: "Voices and models", link: "/more/voices-and-models/" },
            { label: "Background jobs", link: "/more/background-jobs/" },
            { label: "Your own UI", link: "/more/custom-ui/" },
            { label: "Self-hosting", link: "/more/self-hosting/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", link: "/cli/" },
            {
              label: "SDK reference",
              link: `${base}/reference/`,
              attrs: { target: "_blank" },
            },
          ],
        },
      ],
    }),
  ],
});
