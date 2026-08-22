// Copyright 2025 the AAI authors. MIT license.
/**
 * Internal-link resolution for the committed markdown reference.
 *
 * Split out of `docs-markdown.mjs` for the 500-line cap, and it is the right
 * seam: everything here is about the EMITTED markdown — heading slugs, anchor
 * allocation, and the one plugin bug that makes a repair necessary — where the
 * caller is about generating and comparing the tree. `docs-markdown.mjs` calls
 * `resolveLinks` and nothing else in this module.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimum number of internal links the resolution pass must have checked.
 *
 * Same argument as every other floor here — the pass reports a count, so a
 * link pattern that stopped matching would report "931 internal links resolve"
 * as "0 internal links resolve" and pass. Measured actual: 931.
 */
const MIN_LINKS = 600;

/**
 * Blank out fenced code blocks, keeping line count.
 *
 * A rendered page is mostly code fences (`useCodeBlocks: true`), and a `#`
 * inside one is a comment, not a heading — while `](…)` inside one is a
 * signature, not a link. Both would be read as the real thing.
 */
function maskFences(text) {
  let open = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        open = !open;
        return "";
      }
      return open ? "" : line;
    })
    .join("\n");
}

/**
 * The anchor a markdown renderer derives from a heading.
 *
 * GitHub's rule, which is also what every other renderer of this tree
 * implements: strip inline markup, lowercase, drop everything that is not a
 * letter, digit, space, hyphen or underscore, then hyphenate the spaces. The
 * backslash unescaping matters here specifically — the plugin escapes `_` in
 * symbol names, so `### ASSEMBLYAI\_TTS\_VOICES` slugs to
 * `assemblyai_tts_voices` and not to `assemblyaitts_voices`.
 */
function headingSlug(heading) {
  return heading
    .replace(/\\(.)/g, "$1")
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Every anchor a file offers, in document order, WITH the `-1`/`-2`
 * de-duplication renderers apply to a repeated heading.
 *
 * De-duplication is not optional: this tree has 83 links to a legitimately
 * suffixed anchor (`#sessionslot-1` — `sessionSlot()` the function and
 * `SessionSlot` the interface both slug to `sessionslot`), and a checker
 * without it reports every one of them as broken. 83 false positives is a
 * checker nobody keeps.
 */
function headingAnchors(text) {
  const seen = new Map();
  const anchors = new Set();
  for (const match of maskFences(text).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const base = headingSlug(match[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/**
 * Every link in `masked` that stays inside the tree, resolved against `file`.
 *
 * An empty target is the plugin's rendering of a symbol member with no page
 * (`[dispose]()`), and a scheme means the link leaves the tree; neither is this
 * pass's business.
 */
function* internalLinks(masked, file) {
  const dirOf = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  for (const match of masked.matchAll(/\]\(([^)\s]*)\)/g)) {
    const href = match[1];
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const hash = href.indexOf("#");
    const path = hash === -1 ? href : href.slice(0, hash);
    const fragment = hash === -1 ? "" : decodeURIComponent(href.slice(hash + 1));
    yield { href, path, fragment, target: path ? join(dirOf, path) : file };
  }
}

/**
 * The lower-indexed anchor a `#base-N` fragment should have named, or `null`.
 *
 * Walks `-N+1`, … , bare `base` and stops at the first index the target file
 * really offers. It can only ever answer with a heading that exists.
 */
function walkDownSuffix(fragment, offered) {
  const suffixed = fragment.match(/^(.*)-(\d+)$/);
  if (!suffixed) return null;
  for (let n = Number(suffixed[2]) - 1; n >= 0; n--) {
    const candidate = n === 0 ? suffixed[1] : `${suffixed[1]}-${n}`;
    if (offered.has(candidate)) return candidate;
  }
  return null;
}

/** `{}` when a link resolves, `{ repaired }`, or `{ broken: <reason> }`. */
function judgeLink(link, anchors) {
  const offered = anchors.get(link.target);
  if (!offered) return { broken: "no such file in the render" };
  if (!link.fragment || offered.has(link.fragment)) return {};
  const repaired = walkDownSuffix(link.fragment, offered);
  return repaired
    ? { repaired }
    : { broken: `no heading in ${link.target} slugs to "${link.fragment}"` };
}

/**
 * One file's verdicts: the literal rewrites to apply, and how many links it
 * offered. Appends to the shared `broken` and `repairs` collectors.
 */
function judgeFile(file, body, anchors, broken, repairs) {
  /** @type {Map<string, string>} */
  const rewrites = new Map();
  let count = 0;
  for (const link of internalLinks(maskFences(body), file)) {
    count++;
    const verdict = judgeLink(link, anchors);
    if (verdict.broken) broken.push(`${file}: ${link.href} — ${verdict.broken}`);
    if (!verdict.repaired) continue;
    rewrites.set(`](${link.href})`, `](${link.path}#${verdict.repaired})`);
    repairs.add(`${file}: #${link.fragment} -> #${verdict.repaired}`);
  }
  return { rewrites, count };
}

/**
 * Repair the one class of dead anchor the RENDERER produces, and fail on the
 * rest.
 *
 * The plugin keeps its own anchor registry and allocates from it while walking
 * the reflection MODEL, using a dotted path (`Dialog.position`); a reader's
 * renderer allocates while walking the emitted DOCUMENT, using the heading text
 * (`position()`). The two agree almost always and cannot be relied on to: in
 * this tree `Dialog.position` slugs to `dialogposition` and takes that anchor
 * from the `DialogPosition` interface, which is then registered as
 * `dialogposition-1` — an index no heading ever reaches, since `DialogPosition`
 * is the only heading that slugs to `dialogposition`. Nine links in `index.md`
 * pointed there. Reproduced against the plugin's own `ModuleRouter`
 * (typedoc-plugin-markdown 4.12.0); it is upstream and not fixable from a
 * config or a doc comment, and the colliding names are both public API.
 *
 * So a `#base-N` that no heading produces is walked DOWN — `-N+1`, … , bare
 * `base` — and rewritten to the first index a heading does produce. That is
 * exactly the correction for an over-allocated registry, it cannot invent a
 * target (only an existing heading is ever the result), and every repair is
 * printed and lands visibly in the committed diff. Anything it cannot repair —
 * a missing file, a fragment with no suffix and no heading — is a FAILURE, not
 * a repair: those are the shapes a genuine regression takes.
 */
function resolveLinks(dir, files) {
  const text = new Map(files.map((file) => [file, readFileSync(join(dir, file), "utf8")]));
  const anchors = new Map([...text].map(([file, body]) => [file, headingAnchors(body)]));
  /** @type {string[]} */
  const broken = [];
  /** @type {Set<string>} */
  const repairs = new Set();
  let checked = 0;

  for (const file of files) {
    const { rewrites, count } = judgeFile(file, text.get(file), anchors, broken, repairs);
    checked += count;
    if (rewrites.size === 0) continue;
    let body = text.get(file);
    for (const [from, to] of rewrites) body = body.split(from).join(to);
    writeFileSync(join(dir, file), body);
  }

  if (broken.length > 0) {
    console.error("\ndocs-markdown: the render contains links that go nowhere.\n");
    for (const line of broken) console.error(`  - ${line}`);
    console.error(
      "\nA dead link is not caught by `treatWarningsAsErrors`: that option proves the " +
        "{@link} resolved in TypeDoc's model, not that the anchor it emitted exists. " +
        "Fix the symbol reference, or the heading it should point at.\n",
    );
    process.exit(1);
  }
  if (checked < MIN_LINKS) {
    console.error(
      `docs-markdown: only ${checked} internal link(s) found, under the floor of ` +
        `${MIN_LINKS}. The link pattern stopped matching — this pass was about to ` +
        "report success over nothing.",
    );
    process.exit(1);
  }
  return { checked, repairs: [...repairs] };
}

export { resolveLinks };
