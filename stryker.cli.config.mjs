import { base } from "./stryker.base.config.mjs";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    "packages/aai-cli/_api-client.ts",
    "packages/aai-cli/_bundler.ts",
    "packages/aai-cli/_config.ts",
    "packages/aai-cli/_deploy.ts",
    "packages/aai-cli/_init.ts",
    "packages/aai-cli/_dev-server.ts",
    "packages/aai-cli/_templates.ts",
    "packages/aai-cli/secret.ts",
  ],
  htmlReporter: { fileName: "reports/mutation/cli/index.html" },
  thresholds: { high: 70, low: 50, break: 40 },
  incrementalFile: ".stryker-incremental-cli.json",
};
