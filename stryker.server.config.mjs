import { base } from "./stryker.base.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "packages/aai-server/ndjson-transport.ts",
    "packages/aai-server/orchestrator.ts",
    "packages/aai-server/ssrf.ts",
    "packages/aai-server/secrets.ts",
    "packages/aai-server/middleware.ts",
    "packages/aai-server/bundle-store.ts",
  ],
  htmlReporter: { fileName: "reports/mutation/server/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incrementalFile: ".stryker-incremental-server.json",
};
