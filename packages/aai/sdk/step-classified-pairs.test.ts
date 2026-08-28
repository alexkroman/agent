// Copyright 2026 the AAI authors. MIT license.
/**
 * Every raw step primitive points at its `Classified` twin, in its OWN doc.
 *
 * `guard-invariants` rule 26 already fails a raw call inside a shipped
 * `workflows/` body, and the shipped guide carries the translation table. What
 * neither reaches is the place an author actually meets these functions: the
 * autocomplete popup and the generated reference page, both of which render the
 * function's own JSDoc and nothing else. Before this, one of seven raw
 * functions said anything there.
 *
 * The pairing cannot be inverted — putting the wrappers on `/step` would drag
 * the DevKit's `workflow` package into every tool body and spec that imports
 * it, which is why `/step-errors` exists at all (see its module doc). So the
 * discoverable name stays the wrong one inside a workflow, and the least this
 * surface can do is say so where it is read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** Raw primitive → the module that declares it, and the twin it must name. */
const PAIRS: readonly (readonly [string, string, string])[] = [
  ["stepFetch", "step-fetch.ts", "stepFetchOk"],
  ["stepGenerate", "step-generate.ts", "stepGenerateClassified"],
  ["stepGenerateJson", "step-generate-json.ts", "stepGenerateJsonClassified"],
  ["stepTranscribeSync", "step-transcribe-sync.ts", "stepTranscribeSyncClassified"],
  ["stepTranscribeUpload", "step-transcribe.ts", "stepTranscribeUploadClassified"],
  ["stepTranscribePoll", "step-transcribe.ts", "stepTranscribePollClassified"],
  ["stepTranscribeSubmit", "step-transcribe.ts", "stepTranscribeSubmitClassified"],
  ["sendToChannel", "channels/send.ts", "sendToChannelClassified"],
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

describe("raw step primitives name their Classified twin", () => {
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
