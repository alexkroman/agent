// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:page` epoch 1.
 *
 * Epoch 2 made `mountPage`'s `component` optional — with none, the page is a
 * shell built from each workflow's own input schema — and defaulted
 * `fetchClientConfig`'s URL to `pageBaseUrl()`. Epoch 1 passed both
 * explicitly, which is what this file pins: the additions are a default and an
 * optional parameter, so an author who supplies their own component and their
 * own URL keeps working.
 */

import { fetchClientConfig, mountPage, useWorkflows } from "@alexkroman1/aai-ui";

function Shell(): React.JSX.Element {
  const { workflows } = useWorkflows();
  return (
    <ul>
      {workflows.map((workflow) => (
        <li key={workflow.name}>{workflow.name}</li>
      ))}
    </ul>
  );
}

// An explicit component: required at epoch 1, optional at epoch 2.
mountPage({ component: Shell, name: "Digest" });

// An explicit platform URL: required at epoch 1, defaulted at epoch 2.
export const config = (base: string): ReturnType<typeof fetchClientConfig> =>
  fetchClientConfig(base);
