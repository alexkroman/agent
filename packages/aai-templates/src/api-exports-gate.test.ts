// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `API-EXPORTS.json` is a description of the published surface, and it can be
 * WRONG in ways only its own shape reveals.
 *
 * It is generated (`pnpm api-report`) and committed, and `check:api-report`
 * compares it against a fresh extraction — two things one script derives, which
 * is the comparison this repo keeps finding a hole in: an extraction that went
 * thin agrees with a committed nothing. So this suite reads the file itself and
 * asserts the properties a reader relies on when they settle a
 * "which package exports this name" question against it.
 *
 * Split from `api-contracts-gate.test.ts`, which had reached the 700-line test
 * cap. The seam is the artifact: that file asserts the EPOCH metadata really
 * describes the capability roots, this one asserts the export MAP, and the two
 * shared exactly two symbols — `byCodeUnit` and the raw source below. It lives
 * in aai-templates for the same reason its sibling does: raw imports reach the
 * repo root, and this package's tsconfig pulls in no node types.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, sole } from "./_gate-support.ts";

// `import.meta.glob` is compiled away by Vite, so its options must be a literal
// at every call site — a shared `const raw = {…}` fails the transform. `?? "{}"`
// keeps a source that stopped resolving visible as an empty map, which the
// assertions below then fail on.
const exportsSource: string =
  sole(
    import.meta.glob("../../../API-EXPORTS.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "{}";

describe("API-EXPORTS.json", () => {
  const surface = JSON.parse(exportsSource) as Record<string, string[]>;

  test("it names every published entry point, sorted", () => {
    const specifiers = Object.keys(surface);
    expect(specifiers.length, "API-EXPORTS.json parsed to nothing").toBeGreaterThanOrEqual(20);
    expect(specifiers).toContain("@alexkroman1/aai");
    expect(specifiers).toContain("@alexkroman1/aai-ui");
    expect(specifiers).toContain("@alexkroman1/aai-cli/typecheck");
    for (const [specifier, names] of Object.entries(surface)) {
      expect(names.length, `${specifier} exports nothing`).toBeGreaterThan(0);
      expect(names, `${specifier} is unsorted`).toEqual([...names].sort(byCodeUnit));
      expect(new Set(names).size, `${specifier} repeats a name`).toBe(names.length);
    }
  });

  test("it carries only exported names, never forgotten ones", () => {
    // The reports include types a public signature mentions but does not export
    // (`includeForgottenExports`). Those are reviewable in the report and must
    // NOT appear here, or the list stops meaning "what a consumer can import".
    // `Db` was the original example here — exported from the root and merely
    // REFERENCED by `/testing`. It is off the root now (it went to `/internal`
    // with `ctx.db`), so it appears on neither, which is a weaker case than the
    // one this spec needs: the assertion is about a name that IS exported
    // somewhere not leaking into a subpath that only mentions it.
    expect(surface["@alexkroman1/aai"]).not.toContain("Db");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("Db");
    // `WorkflowClient` is the live case, which `createStubWorkflows` takes and
    // returns.
    expect(surface["@alexkroman1/aai"]).toContain("WorkflowClient");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("WorkflowClient");
    // …and for `GenerateFn` and `ToolDef`, which the fakes added in epoch 9 take
    // and return.
    for (const forgotten of ["GenerateFn", "ToolDef"]) {
      expect(surface["@alexkroman1/aai"]).toContain(forgotten);
      expect(surface["@alexkroman1/aai/testing"]).not.toContain(forgotten);
    }
    // `WorkflowRunSnapshot` is the same shape one subpath over: `/testing`'s
    // `createRunSnapshot` returns it, and it is EXPORTED from
    // `@alexkroman1/aai/workflow-api` rather than from the root, because what a
    // run IS is read by a page or a script and never written in an `agent.ts`.
    expect(surface["@alexkroman1/aai/workflow-api"]).toContain("WorkflowRunSnapshot");
    expect(surface["@alexkroman1/aai"]).not.toContain("WorkflowRunSnapshot");
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("WorkflowRunSnapshot");
    // `ToolModules` is `ProjectFiles.tools`'s type and lives on `/manifest`,
    // which is not an authoring subpath at all — so it is forgotten HERE and
    // absent from the root too, which is the intended shape: the value a caller
    // passes is an `import.meta.glob` result, not something to name. Most specs
    // now import `virtual:aai/agent` and never see one.
    expect(surface["@alexkroman1/aai/testing"]).not.toContain("ToolModules");
    expect(surface["@alexkroman1/aai/testing"]).toEqual([
      "ProjectFiles",
      "RecordedSleep",
      "RecordedStep",
      "RunSnapshotOverrides",
      "STUB_SPEECH_PCM_BYTES",
      "SentEvent",
      "StepRoute",
      "StepUnmatched",
      "StubDelegate",
      "StubDelegateCall",
      "StubDelegateReply",
      "StubDelegateRoute",
      "StubEmitted",
      "StubGateway",
      "StubGatewayCall",
      "StubGatewayOptions",
      "StubGatewayRoute",
      "StubGenerate",
      "StubGenerateCall",
      "StubGenerateReply",
      "StubGenerateRoute",
      "StubReporter",
      "StubSpeech",
      "StubSpeechCall",
      "StubSpeechOptions",
      "StubStepAnswer",
      "StubStepFetch",
      "StubStepRequest",
      "StubTranscribe",
      "StubTranscribeCall",
      "StubTranscribeFailure",
      "StubTranscribeLeg",
      "StubTranscribeOptions",
      "StubUpload",
      "StubUploadWrite",
      "StubUploads",
      "StubUploadsOptions",
      "TestToolContext",
      "ToolBearingAgent",
      "ToolContextOverrides",
      "ToolRunner",
      "WORKFLOW_CONTEXT_NOW",
      "WorkflowContextOptions",
      "WorkflowContextRecorder",
      "createProgressStream",
      "createRunSnapshot",
      "createStubWorkflows",
      "createToolContext",
      "createWorkflowContext",
      "deployedAgent",
      "expectDialogOk",
      "expectToolOk",
      "parseSchemaInput",
      "parseToolInput",
      "routeStepFetch",
      "runTool",
      "schemaInputIssues",
      "stubDelegate",
      "stubGateway",
      "stubGatewayRoute",
      "stubGenerate",
      "stubReporter",
      "stubSpeech",
      "stubStepFetch",
      "stubStepInfo",
      "stubTranscribe",
      "stubUploads",
      "toolInputIssues",
      "toolOf",
      "toolRunner",
    ]);
    // The vitest half is mostly the INSTALLATION of each fake above it — the
    // same stubs with `onTestFinished(restore)` done. That is the whole reason
    // it is a subpath rather than part of `/testing`, which stays
    // framework-agnostic: importing it is what pulls the runner in.
    // `mockWorkflows` is here for the other half of the same rule — it installs
    // nothing and restores nothing, but its methods are `vi.fn`s, so `vi` IS its
    // content. See `sdk/testing-vitest.ts`.
    expect(surface["@alexkroman1/aai/testing/vitest"]).toEqual([
      "StubWorkflowsOptions",
      "installStubGateway",
      "installStubReporter",
      "installStubSpeech",
      "installStubStepFetch",
      "installStubTranscribe",
      "installStubUploads",
      "installStubWorkflows",
    ]);
    // `WorkflowClient` is `mockWorkflows`'s return type and is FORGOTTEN here
    // for the same reason it is forgotten on `/testing`: it is exported from the
    // root, so a consumer names it from there.
    expect(surface["@alexkroman1/aai/testing/vitest"]).not.toContain("WorkflowClient");
  });
});
