// Copyright 2026 the AAI authors. MIT license.
/**
 * The one fixture the studio's suites still share: claiming a slug for a project.
 *
 * It used to carry a fake app-database PROVISIONER too — the studio's Database
 * switch drove one, and two suites had written the same eight-method stub. Both the
 * switch and the provisioner are gone (durable runs, the run journal and session
 * state are the platform's now), so what is left is the small thing that was never
 * about databases.
 */

import { hashApiKey } from "aai-server/secrets";
import type { BundleStore } from "aai-server/store-types";

export function claimSlug(store: BundleStore, slug: string, key: string): Promise<void> {
  return store.putAgent({
    slug,
    env: {},
    worker: "export default {}",
    clientFiles: {},
    credential_hashes: [hashApiKey(key)],
  });
}
