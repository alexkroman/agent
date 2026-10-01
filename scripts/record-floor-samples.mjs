// Copyright 2026 the AAI authors. MIT license.
/**
 * Records every coverage-floor assertion a property suite makes, so its floor
 * comments can be generated from measurements instead of typed from memory.
 *
 * A vitest `setupFiles` entry in `sharedSetupFiles`, inert unless
 * `AAI_FLOOR_SAMPLES` names an output file. Then each `toBeGreaterThan` /
 * `toBeGreaterThanOrEqual` on a number — the two matchers
 * `scripts/check-property-floors.mjs` reads as a floor — appends one JSON line:
 * `{ file, test, label, actual, floor }`. `label` is the assertion message,
 * which every floor in this repo carries. `scripts/sample-property-floors.mjs`
 * runs a suite N times and aggregates the lines into a min–max per counter.
 *
 * Wraps the matcher rather than asking each suite to report: the floors are
 * already written as `expect(reached.x, "why").toBeGreaterThan(n)`, so this
 * needs no edit to any suite.
 */

import { appendFileSync } from "node:fs";
import path from "node:path";
import { chai, expect as vitestExpect } from "vitest";

const out = process.env.AAI_FLOOR_SAMPLES;

if (out !== undefined && out !== "") {
  const root = path.resolve(import.meta.dirname, "..");
  // Composed, because the full names read as high-entropy strings to `noSecrets`.
  const lowerBound = "toBeGreater";
  for (const matcher of [`${lowerBound}Than`, `${lowerBound}ThanOrEqual`]) {
    chai.Assertion.overwriteMethod(
      matcher,
      (original) =>
        /**
         * @this {Chai.Assertion}
         * @param {unknown} floor
         * @param {unknown[]} rest
         */
        function recordFloor(floor, ...rest) {
          const actual = chai.util.flag(this, "object");
          if (typeof actual === "number" && typeof floor === "number") {
            const state = vitestExpect.getState();
            const line = {
              file: path
                .relative(root, state.testPath ?? "")
                .split(path.sep)
                .join("/"),
              test: state.currentTestName ?? "",
              label: chai.util.flag(this, "message") ?? "",
              matcher,
              actual,
              floor,
            };
            appendFileSync(out, `${JSON.stringify(line)}\n`);
          }
          return original.call(this, floor, ...rest);
        },
    );
  }
}
