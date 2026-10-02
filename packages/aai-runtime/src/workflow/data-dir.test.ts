// Copyright 2026 the AAI authors. MIT license.
// Where the local workflow world keeps its state: the operator's directory, or
// a per-process one under the OS temp dir.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isPerProcessDataDir, localWorkflowDataDir, WORKFLOW_DATA_DIR_ENV } from "./data-dir.ts";

describe("localWorkflowDataDir", () => {
  test("is the configured directory when the env names one", () => {
    expect(localWorkflowDataDir({ [WORKFLOW_DATA_DIR_ENV]: "/srv/agent/.workflow-data" })).toBe(
      "/srv/agent/.workflow-data",
    );
  });

  test("is a per-process temp directory otherwise", () => {
    expect(localWorkflowDataDir({})).toBe(join(tmpdir(), `aai-workflow-data-${process.pid}`));
  });
});

describe("isPerProcessDataDir", () => {
  test("recognizes only the default, so a configured directory is never called ephemeral", () => {
    expect(isPerProcessDataDir(localWorkflowDataDir({}))).toBe(true);
    expect(isPerProcessDataDir("/srv/agent/.workflow-data")).toBe(false);
  });
});

test("the env key keeps its name", () => {
  expect(WORKFLOW_DATA_DIR_ENV).toBe("AAI_WORKFLOW_DATA_DIR");
});
