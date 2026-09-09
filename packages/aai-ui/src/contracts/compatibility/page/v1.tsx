// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:page` epoch 1.
 *
 * Epoch 2 made `mountPage`'s `component` optional — with none, the page is a
 * shell built from each workflow's own input schema — and defaulted
 * `fetchClientConfig`'s URL to `pageBaseUrl()`. Epoch 1 passed both
 * explicitly, which is what this pins: the additions are a default and an
 * optional parameter, so an author who supplies their own component and their
 * own URL keeps working.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 4 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import type { PageConfig, PageHandle } from "../../../index.ts";
import { fetchClientConfig, mountPage } from "../../../index.ts";

function Shell(): React.JSX.Element {
  return <p>Digest</p>;
}

// An explicit component: required at epoch 1, optional at epoch 2.
mountPage({ component: Shell, name: "Digest" });

// An explicit platform URL: required at epoch 1, defaulted at epoch 2.
export const config = (base: string): ReturnType<typeof fetchClientConfig> =>
  fetchClientConfig(base);

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  pageConfig: PageConfig;
  pageHandle: PageHandle;
};
