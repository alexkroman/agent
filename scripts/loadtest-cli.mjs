#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * `pnpm loadtest [<harness>] [flags…]` — one root script for every load harness.
 *
 *   pnpm loadtest --scenario=http --ports=simple=4100   # scripts/loadtest.mjs
 *   pnpm loadtest boot stub                             # scripts/loadtest-boot.sh
 *   pnpm loadtest probe --port=4900 --speak             # scripts/loadtest-probe.mjs
 *
 * The first argument picks a harness from {@link HARNESSES} when it names one;
 * anything else (including a leading flag) goes to the default HTTP / workflow /
 * session harness. Everything after the harness name is that harness's own
 * argv, untouched. `scripts/loadtest-boot.sh`'s header lists what each is for.
 */

import process from "node:process";

import { runChild } from "./_run-child.mjs";

/** Harness name -> the argv that runs it, from the repo root. */
const HARNESSES = {
  boot: ["bash", "scripts/loadtest-boot.sh"],
  endpoint: ["node", "scripts/loadtest-stub-endpoint.mjs"],
  phone: ["node", "scripts/loadtest-phone.mjs"],
  platform: ["node", "scripts/loadtest-platform.mjs"],
  probe: ["node", "scripts/loadtest-probe.mjs"],
  runs: ["node", "scripts/loadtest-runs.mjs"],
  turns: ["node", "scripts/loadtest-turns.mjs"],
};

const [first, ...rest] = process.argv.slice(2);

if (first === "help" || first === "--help") {
  console.log(`Usage: pnpm loadtest [${Object.keys(HARNESSES).join("|")}] [flags…]`);
  console.log("With no harness name it runs scripts/loadtest.mjs; see that file for its flags.");
  process.exit(0);
}

const harness =
  first !== undefined && Object.hasOwn(HARNESSES, first) ? HARNESSES[first] : undefined;
const command =
  harness === undefined
    ? ["node", "scripts/loadtest.mjs", ...process.argv.slice(2)]
    : [...harness, ...rest];

runChild(command, { label: "loadtest", interruptExitCode: 0 });
