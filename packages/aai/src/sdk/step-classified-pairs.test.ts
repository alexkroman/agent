// Copyright 2026 the AAI authors. MIT license.
/**
 * Every raw step primitive points at its classified spelling — `orFail(stepX)` —
 * in its OWN doc.
 *
 * `guard-invariants` rule 26 already fails a raw call inside a shipped
 * `workflows/` body, and the shipped guide carries the translation table. What
 * neither reaches is the place an author actually meets these functions: the
 * autocomplete popup and the generated reference page, both of which render the
 * function's own JSDoc and nothing else. Before this, one of seven raw
 * functions said anything there.
 *
 * The pairing cannot be inverted — putting the verdict vocabulary on `/step`
 * would hand it to every tool body and spec that imports that subpath, which is
 * why `/step-errors` exists at all (see its module doc). So the discoverable
 * name stays the wrong one inside a workflow, and the least this surface can do
 * is say so where it is read. (It used to name eight `*OrFail` twins, which
 * `orFail(stepX)` replaced.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** Raw primitive → the module that declares it, and the spelling it must name. */
const PAIRS: readonly (readonly [string, string, string])[] = [
  ["stepFetch", "step-fetch.ts", "orFail(stepFetch)"],
  ["stepGenerate", "step-generate.ts", "orFail(stepGenerate)"],
  ["stepGenerateJson", "step-generate-json.ts", "orFail(stepGenerateJson)"],
  ["stepTranscribeSync", "step-transcribe-sync.ts", "orFail(stepTranscribeSync)"],
  ["stepTranscribeUpload", "step-transcribe.ts", "orFail(stepTranscribeUpload)"],
  ["stepTranscribePoll", "step-transcribe.ts", "orFail(stepTranscribePoll)"],
  ["stepTranscribeSubmit", "step-transcribe.ts", "orFail(stepTranscribeSubmit)"],
  ["sendToChannel", "channels/shared/send.ts", "orFail(sendToChannel)"],
];

const here = fileURLToPath(new URL(".", import.meta.url));

/** The JSDoc block immediately above `export … function <name>`, or undefined. */
function docFor(source: string, name: string): string | undefined {
  const declaration = new RegExp(`^export (?:async )?function ${name}\\b`, "m").exec(source);
  if (declaration === null) return undefined;
  const close = source.lastIndexOf(" */", declaration.index);
  if (close === -1) return undefined;
  const open = source.lastIndexOf("/**", close);
  return open === -1 ? undefined : source.slice(open, close);
}

describe("raw step primitives name their orFail spelling", () => {
  // A floor, because this suite's whole output is a count over a hand-kept
  // list: a `docFor` that stopped matching would find nothing and pass.
  test("the pair list still resolves to real declarations", () => {
    for (const [raw, file] of PAIRS) {
      const source = readFileSync(`${here}${file}`, "utf8");
      expect(docFor(source, raw), `${file} no longer declares ${raw}`).toBeDefined();
    }
    expect(PAIRS.length).toBeGreaterThanOrEqual(8);
  });

  test.each(PAIRS)("%s names %s", (raw, file, twin) => {
    const doc = docFor(readFileSync(`${here}${file}`, "utf8"), raw);
    expect(doc).toContain(twin);
  });
});
