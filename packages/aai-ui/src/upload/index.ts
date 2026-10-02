// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow hooks' upload machinery, as the rest of the package sees it:
 * claiming an id per file and transferring it (`files.ts`), the pause gate
 * (`session.ts` — the buttons over it are the form's statechart,
 * `../_workflow-form-state.ts`), the reload recall (`recall.ts`) and the report
 * coalescing (`report.ts`). Everything not re-exported here is private to
 * `upload/` — guard-invariants rule 37 fails an import from outside it that
 * names any module but this one.
 *
 * @module
 */

export { createUploadSession, type UploadSession, uploadFiles } from "./files.ts";
export { recallUploadId, rememberUploadId } from "./recall.ts";
export { coalesceUploadReports } from "./report.ts";
export {
  createUploadGate,
  randomUploadId,
  sendThroughGate,
  type UploadGate,
} from "./session.ts";
