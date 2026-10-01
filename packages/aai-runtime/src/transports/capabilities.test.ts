// Copyright 2026 the AAI authors. MIT license.
// The capability descriptors are the ONE answer to "what works on which
// transport": these specs hold the guide's table to them, and each descriptor
// to the verbs its transport really implements.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { makeLogger, silentLogger } from "../_test-utils.ts";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { makeCallbacks } from "./_transport-recorder.ts";
import {
  ASSEMBLYAI_S2S_CAPABILITIES,
  CAPABILITY_ROWS,
  OPENAI_REALTIME_CAPABILITIES,
  PIPELINE_CAPABILITIES,
  renderCapabilityTable,
  reportSessionCapabilities,
  type TransportCapability,
  type TransportVerb,
} from "./capabilities.ts";
import { createOpenaiRealtimeTransport } from "./openai-realtime-transport.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";
import { createS2sTransport } from "./s2s-transport.ts";
import type { Transport } from "./types.ts";

/** Every optional member of `Transport` — a compile error if the list drifts. */
type OptionalVerb = {
  [K in Exclude<keyof Transport, "capabilities">]-?: undefined extends Transport[K] ? K : never;
}[Exclude<keyof Transport, "capabilities">];
const verbsMatchInterface: [OptionalVerb, TransportVerb] extends [TransportVerb, OptionalVerb]
  ? true
  : false = true;

/** The three real transports, constructed (never started). */
function transports(): [string, Transport][] {
  const pipeline = createPipelineTransport(makeOpts().opts);
  const openai = createOpenaiRealtimeTransport({
    apiKey: "sk",
    options: {},
    sessionConfig: { systemPrompt: "" },
    toolSchemas: [],
    toolChoice: "auto",
    callbacks: makeCallbacks(),
    sid: "s",
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    logger: silentLogger,
  });
  const assembly = createS2sTransport({
    apiKey: "k",
    s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
    sessionConfig: { systemPrompt: "test", tools: [] },
    callbacks: makeCallbacks(),
    sid: "s",
    agent: "a",
    logger: silentLogger,
  });
  return [
    ["pipeline", pipeline],
    ["OpenAI Realtime", openai],
    ["AssemblyAI S2S", assembly],
  ];
}

/** The table's rows as trimmed cells, so prettier's column padding is ignored. */
function tableCells(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)));
}

describe("transport capabilities", () => {
  test("the optional verb list is the interface's", () => {
    expect(verbsMatchInterface).toBe(true);
  });

  test("each transport answers its own descriptor", () => {
    const byName = Object.fromEntries(transports());
    expect(byName.pipeline?.capabilities).toBe(PIPELINE_CAPABILITIES);
    expect(byName["OpenAI Realtime"]?.capabilities).toBe(OPENAI_REALTIME_CAPABILITIES);
    expect(byName["AssemblyAI S2S"]?.capabilities).toBe(ASSEMBLYAI_S2S_CAPABILITIES);
  });

  test("a verb is implemented exactly when its capability is claimed", () => {
    for (const [name, transport] of transports()) {
      for (const capability of Object.keys(CAPABILITY_ROWS) as TransportCapability[]) {
        const row: { verbs: readonly TransportVerb[] } = CAPABILITY_ROWS[capability];
        for (const verb of row.verbs) {
          expect
            .soft(typeof transport[verb] === "function", `${name}: ${capability} ↔ ${verb}`)
            .toBe(transport.capabilities[capability]);
        }
      }
    }
  });

  test("the guide's capability table is the rendered one", () => {
    const guide = readFileSync(new URL("./CLAUDE.md", import.meta.url), "utf8");
    const start = guide.indexOf("<!-- capability-table:start -->");
    const end = guide.indexOf("<!-- capability-table:end -->");
    expect(start, "transports/CLAUDE.md lost its capability-table markers").toBeGreaterThan(-1);
    // On a mismatch, paste `renderCapabilityTable()` between the markers and
    // run `pnpm exec prettier --write` on the guide.
    expect(tableCells(guide.slice(start, end))).toEqual(tableCells(renderCapabilityTable()));
  });
});

describe("reportSessionCapabilities", () => {
  test("warns for a declared knob the transport cannot apply, once", () => {
    const log = makeLogger();
    const once = new Set<string>();
    const declared = { dialogKnobs: true, personaKnobs: false };
    reportSessionCapabilities(ASSEMBLYAI_S2S_CAPABILITIES, "AssemblyAI S2S", declared, log, once);
    reportSessionCapabilities(ASSEMBLYAI_S2S_CAPABILITIES, "AssemblyAI S2S", declared, log, once);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("AssemblyAI S2S transport"));
    // And the code-driven verbs it lacks are said once, at info.
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  test("says nothing for a transport that can do everything declared", () => {
    const log = makeLogger();
    const declared = { dialogKnobs: true, personaKnobs: true };
    reportSessionCapabilities(PIPELINE_CAPABILITIES, "pipeline", declared, log, new Set());
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
});
