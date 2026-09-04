// Copyright 2026 the AAI authors. MIT license.
/**
 * Rate-limiting the upload progress report to what a bar can actually show.
 *
 * `onProgress` fires on every `XMLHttpRequest` progress event, and the parts
 * uploader runs `UPLOAD_PART_CONCURRENCY` of those at once — so the raw rate is
 * on the order of a hundred reports a second, sustained for the whole upload,
 * which for the multi-hundred-megabyte files this feature exists for is
 * minutes. Each one is a `setState`, and each re-renders the enclosing `<Form>`
 * subtree: every field `<WorkflowFields>` rendered, the bar, and
 * `<WorkflowProgress>` beside it. Progress events arrive as separate
 * macrotasks, so React's automatic batching does not merge them.
 *
 * The bar has at most ~100 visually distinct states. Dropping a report that
 * would render identically is therefore free, and it is the whole mechanism —
 * no timer, so the LAST report of a burst is never left unrendered waiting for
 * a window to close.
 */

import type { UploadStatus } from "./use-workflow-form.ts";

/**
 * What the bar draws, as a comparable string.
 *
 * The fraction is quantized to a tenth of a percent — finer than anything the
 * bar or the byte readout resolves. Everything else is compared exactly:
 * `paused` is a state change a person is waiting to see, and the name/index
 * pair moving means a different FILE, which must never be coalesced away.
 */
function renderKey(status: UploadStatus): string {
  const { name, index, count, loaded, total, fraction, paused } = status;
  const shown = fraction === undefined ? loaded : Math.round(fraction * 1000);
  return `${paused} ${index} ${count} ${total ?? -1} ${shown} ${name}`;
}

/**
 * Wrap an `UploadStatus` setter so redundant reports never reach React.
 *
 * Clearing the status (`undefined`) always passes and resets the comparison —
 * it ends one file's bar, and the next file must not be coalesced against the
 * previous one's last frame.
 */
export function coalesceUploadReports(
  set: (status: UploadStatus | undefined) => void,
): (status: UploadStatus | undefined) => void {
  let last: string | undefined;
  return (status) => {
    if (status === undefined) {
      last = undefined;
      set(undefined);
      return;
    }
    const key = renderKey(status);
    if (key === last) return;
    last = key;
    set(status);
  };
}
