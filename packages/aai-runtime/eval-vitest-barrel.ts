// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/eval/vitest` — the eval suite, as vitest sees it.
 *
 * Everything here either INSTALLS something or OWNS a lifetime, which is the
 * repo's rule for what belongs on a runner-flavoured subpath: `describeEval`
 * registers a suite, opens a session per case and closes it afterwards, and
 * decides whether this run has a live model or a scripted one. `vitest` is an
 * OPTIONAL peer dependency, so importing this module is what pulls it in — the
 * driving half (`@alexkroman1/aai-runtime/eval`) stays runner-agnostic and can
 * be used from any harness.
 *
 * @module eval/vitest
 */

export {
  type DescribeEvalOptions,
  describeEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  resolveEvalMode,
  resolveWorkflowEvalMode,
} from "./eval/describe.ts";
// The workflow-app suite. Its own function rather than a flag on `describeEval`
// because the two gate on different credentials and hand a case different
// things — see the module doc.
export {
  describeWorkflowEval,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
} from "./eval/describe-workflows.ts";
