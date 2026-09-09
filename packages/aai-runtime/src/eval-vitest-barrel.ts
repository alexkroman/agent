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
} from "./eval/describe.ts";
// The TEXT-agent suite. Its own function rather than a flag on `describeEval`
// for the reason there are two harnesses at all: `createRuntime` refuses
// `text: true` by name, so there is no session to open — see the module doc.
export {
  type DescribeTextEvalOptions,
  describeTextEval,
  type EvalTextTest,
  type EvalTextTestContext,
} from "./eval/describe-text.ts";
// The workflow-app suite. Its own function rather than a flag on `describeEval`
// because the two gate on different credentials and hand a case different
// things — see the module doc.
export {
  describeWorkflowEval,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
} from "./eval/describe-workflows.ts";
// WHICH MODEL a suite runs against — the decision every one of the three
// `describe*Eval` doors below makes before registering a case, published so a
// harness that is not vitest can ask the same question. See its module doc.
export { resolveEvalMode, resolveWorkflowEvalMode } from "./eval/eval-mode.ts";
