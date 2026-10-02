// Copyright 2026 the AAI authors. MIT license.
// The build/deploy typecheck gate (_typecheck-gate.ts): the skip flag, and
// a failed check turned into a `typecheck_failed` CliError. What the check
// itself reports is typecheck.test.ts.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import { CliError } from "./_output.ts";
import { createFakeUi, test } from "./_test-utils.ts";
import { assertTypechecks } from "./_typecheck-gate.ts";

describe("assertTypechecks", () => {
  test("skip runs nothing and says nothing", async () => {
    const ui = createFakeUi();
    // A directory that does not exist: any attempt to check it would show.
    await assertTypechecks("/nonexistent/project", { skip: true, ui });
    expect(ui.all()).toEqual([]);
  });

  test("announces the step, and passes a project with no tsconfig.json", async ({
    tmpDir: dir,
  }) => {
    const ui = createFakeUi();
    await expect(assertTypechecks(dir, { ui })).resolves.toBeUndefined();
    expect(ui.said("step")).toEqual(["Type checking…"]);
  });

  test("a failed check is a typecheck_failed CliError naming the opt-out", async ({
    tmpDir: dir,
  }) => {
    // A tsconfig with no TypeScript installed beside it fails without
    // spawning a compiler (see typecheck.test.ts for why that is loud).
    await writeFile(path.join(dir, "tsconfig.json"), "{}");
    const error = await assertTypechecks(dir, { ui: createFakeUi() }).catch((err) => err);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "typecheck_failed",
      hint: expect.stringContaining("--skip-typecheck"),
    });
    expect(String(error.message)).toContain("TypeScript is not installed");
  });
});
