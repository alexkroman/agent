// Copyright 2026 the AAI authors. MIT license.
import url from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

/**
 * The narrative documentation site — and, since `starlight-typedoc` landed, the
 * generated API reference as well.
 *
 * There used to be two builds filling one `dist/`: this Astro one for the
 * handwritten guide, and a separate `typedoc` run rendering HTML into
 * `public/reference/`, which Astro copied through untouched. TypeDoc is still
 * the extractor — Starlight has no TypeScript analysis of its own, and nothing
 * else in the repo carries the doc COMMENTS (the API reports strip them) — but
 * its HTML theme is gone. The plugin runs the same converter with
 * `typedoc-plugin-markdown` and writes Starlight content pages, so `astro build`
 * is now the whole site.
 *
 * What that buys, beyond one theme and one nav: the reference is inside the
 * content collection, so `starlight-links-validator` sees it. Every guide link
 * into `/reference/` used to be excluded from validation for the plain reason
 * that `public/` is copied after the collection is built — i.e. the links most
 * likely to rot were the ones nothing checked.
 *
 * The output directory is unchanged (`docs/dist`), so
 * `.github/workflows/docs.yml` uploads the same path it always did.
 *
 * `/reference/` still belongs entirely to the generator, which is why the
 * handwritten CLI page sits at `/cli/` — an authored page and a generated tree
 * sharing a URL prefix is a collision waiting for the first entry point named
 * like one of these pages, and now they would collide inside one collection.
 */

/**
 * GitHub Pages serves a project site under the repository name. Starlight
 * prefixes `base` onto the links it owns, the generated sidebar group included,
 * so nothing here restates it.
 */
const base = "/agent";

/**
 * Read the same `typedoc.json` the markdown artifact extends, by ABSOLUTE path.
 *
 * TypeDoc would discover it by name from the working directory, which is right
 * whenever `astro` is invoked from `docs/` and silently renders a different
 * surface when it is not. Entry points, `treatWarningsAsErrors`,
 * `excludeInternal` and the `packageOptions` block are declared once, there.
 */
const typedocConfig = url.fileURLToPath(new URL("./typedoc.json", import.meta.url));

/**
 * The reference landing page, passed by ABSOLUTE path for the same reason.
 *
 * It also has to be passed at all: the plugin sets `readme: "none"` as a
 * PROGRAMMATIC option, which beats a config file, so `typedoc.json`'s value is
 * not enough. With no readme, TypeDoc's packages strategy emits every package
 * overview as a bare index the plugin then deletes — and the reference root
 * links to three pages that do not exist.
 */
const typedocReadme = url.fileURLToPath(new URL("./home.md", import.meta.url));

/**
 * Whether a sidebar entry is a GROUP — the only shape that can hold children.
 * A link, a `slug` entry and an `autogenerate` directive all carry no `items`.
 */
const isSidebarGroup = (item) => typeof item === "object" && item !== null && "items" in item;

/** How many groups a sidebar holds, at any depth. */
const countGroups = (items) =>
  (items ?? []).reduce(
    (total, item) => (isSidebarGroup(item) ? total + 1 + countGroups(item.items) : total),
    0,
  );

/** Recursively drop sidebar groups that hold nothing a reader can click. */
const pruneLinklessGroups = (items) =>
  (items ?? []).flatMap((item) => {
    if (!isSidebarGroup(item)) return [item];
    const prunedItems = pruneLinklessGroups(item.items);
    return prunedItems.length === 0 ? [] : [{ ...item, items: prunedItems }];
  });

/**
 * Delete the generated sidebar entries that lead NOWHERE.
 *
 * `starlight-typedoc` gives every module its own collapsible group and fills
 * it from the reflection GROUPS — Functions, Classes, Interfaces — each of
 * which it expects to find as a directory of per-symbol pages. With
 * `outputFileStrategy: "modules"` no such directory exists, so all 24 module
 * groups came out with zero children: a chevron that expands to nothing under
 * every package. Twenty-four dead ends is most of what the reference's nav
 * showed.
 *
 * Nothing becomes unreachable. Each module page is still built, and each
 * package's Overview page ends in a Modules list linking to all of them — so
 * the reader navigates the package from its own page, which is where the
 * module's one-line description is anyway. The sidebar keeps the entries that
 * work: the reference root and one Overview per package.
 *
 * It runs as a plugin rather than as an edit to the sidebar below because the
 * group there is a PLACEHOLDER — the real items are computed inside
 * `starlight-typedoc`'s own `config:setup` hook. Starlight runs plugins in
 * order and hands each one the config the previous plugins left, so this has
 * to stay AFTER `starlightTypeDoc()` in the list.
 *
 * The rule is "no clickable descendants", not a list of labels, so a future
 * plugin version that fills those groups in keeps them.
 */
const pruneLinklessSidebarGroups = () => ({
  name: "prune-linkless-sidebar-groups",
  hooks: {
    "config:setup"({ config, logger, updateConfig }) {
      const sidebar = pruneLinklessGroups(config.sidebar);
      // Announced, because a no-op is the failure mode worth hearing about: it
      // means either the generator stopped emitting the empty groups (good, and
      // this plugin can go) or the sidebar it hands over no longer has the shape
      // walked above (bad, and the nav quietly fills with dead ends again).
      const removed = countGroups(config.sidebar) - countGroups(sidebar);
      if (removed === 0) {
        logger.warn("No linkless sidebar groups found — starlight-typedoc may no longer emit any.");
      } else {
        logger.info(`Removed ${removed} sidebar group(s) with nothing to click.`);
        updateConfig({ sidebar });
      }
    },
  },
});

export default defineConfig({
  site: "https://alexkroman.github.io",
  base,
  outDir: "./dist",
  integrations: [
    starlight({
      plugins: [
        starlightTypeDoc({
          output: "reference",
          sidebar: { label: "SDK reference", collapsed: true },
          typeDoc: {
            options: typedocConfig,
            readme: typedocReadme,
            // `index`, not the plugin's `README`, so the reference landing
            // page is `/reference/` — the URL twelve guide pages already link
            // to, and the one anybody would guess. The cost is one collision:
            // `@alexkroman1/aai`'s root module is NAMED `index` (no `@module`
            // tag on the barrel, so TypeDoc falls back to the file), and it
            // already wanted `index.md` in the package directory. The package
            // overview keeps that name and the module page becomes
            // `index-1.md`. Every link to it is generated, so the wart is the
            // URL alone; the fix, if it ever matters, is naming those two root
            // barrels with `@module` — which renames a file in the committed
            // `docs/api/` artifact too, so it is a change of its own.
            entryFileName: "index",
            // Anchors, written as HTML, because the generator and the renderer
            // allocate them differently and only the generator's are linked.
            // `treatWarningsAsErrors` proves a `{@link}` resolved in TypeDoc's
            // MODEL; the anchor it then writes is allocated while walking the
            // reflection tree, so `DialogPosition` becomes `#dialogposition-1`
            // once the `Dialog.position` member has taken `#dialogposition` —
            // and no heading a markdown renderer emits ever reaches that index.
            // 45 links across 14 pages, which the link validator now sees.
            // `scripts/docs-markdown-links.mjs` repairs the same class in the
            // committed artifact by walking the suffix down; here the headings
            // can simply carry the id the generator used.
            useHTMLAnchors: true,
            // One page per MODULE — i.e. per published entry point — not the
            // plugin's per-symbol default. Per-symbol is ~780 pages, and
            // Pagefind indexes every page in the collection: fifteen guide
            // pages would be a rounding error in the site's own search
            // results. It is also the shape `typedoc.markdown.json` already
            // chose for the committed artifact, so a reader who follows a
            // heading link from one lands in the same place in the other.
            outputFileStrategy: "modules",
            // Same argument as the committed markdown: the entry points are
            // `dist/*.d.ts` with no declaration maps, so a source link points
            // at emitted output with a line number that moves on any unrelated
            // rebuild.
            disableSources: true,
            // A markdown table cell cannot hold a blank line, so the table
            // variants flatten every multi-paragraph doc comment in this repo
            // into one run-on cell — and those comments are the substance.
            parametersFormat: "list",
            typeDeclarationFormat: "list",
            interfacePropertiesFormat: "list",
            classPropertiesFormat: "list",
            typeAliasPropertiesFormat: "list",
            propertyMembersFormat: "list",
            enumMembersFormat: "list",
            // One heading per top-level declaration rather than one per leaf of
            // a nested object type: `verbose` rendered `estelle.accent`,
            // `estelle.gender`, … sixteen voices deep, and did the same for the
            // gateway model catalog.
            typeDeclarationVisibility: "compact",
          },
        }),
        // Runs after the generator, on the sidebar it produced. See above.
        pruneLinklessSidebarGroups(),
        // A broken cross-link is the failure these pages are most exposed to —
        // fifteen documents that route the reader to each other constantly,
        // plus a generated reference they link INTO — and Astro does not check
        // links on its own, so `turbo run docs` (which CI runs on every PR)
        // would have shipped one silently.
        starlightLinksValidator(),
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
            { label: "Evals", link: "/build/evals/" },
          ],
        },
        {
          label: "Ship it",
          items: [
            { label: "Run it locally", link: "/deploy/local/" },
            { label: "Publish", link: "/deploy/publish/" },
            { label: "Phone calls", link: "/deploy/phone/" },
            { label: "Deploy anywhere", link: "/deploy/anywhere/" },
          ],
        },
        {
          label: "Going further",
          items: [
            { label: "Voices and models", link: "/more/voices-and-models/" },
            { label: "Background jobs", link: "/more/background-jobs/" },
            // Split out of the Evals page — a workflow eval opens no session and
            // scripts no reply, so it is a different subject that happened to sit
            // at the end of one. It lives HERE rather than under Build because it
            // is unreadable before Background jobs: it opens on `workflowApp()`,
            // uploads and `app.run`, none of which Build introduces.
            { label: "Workflow evals", link: "/more/workflow-evals/" },
            { label: "Your own UI", link: "/more/custom-ui/" },
            { label: "Self-hosting", link: "/more/self-hosting/" },
          ],
        },
        {
          label: "Reference",
          items: [{ label: "CLI", link: "/cli/" }],
        },
        // The generated group, built from the reflections rather than listed:
        // a new subpath export reaches the sidebar without anybody editing it,
        // which is the one hand-kept list this file no longer carries.
        typeDocSidebarGroup,
      ],
    }),
  ],
});
