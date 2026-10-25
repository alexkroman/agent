// Copyright 2026 the AAI authors. MIT license.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { agent } from "@alexkroman1/aai";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { assemblyAIStt, deepgramStt, fallback } from "@alexkroman1/aai/stt";
import { describe, expect, test } from "vitest";
import {
  declaredStageKinds,
  omittedVendorMessage,
  omitVendorOpeners,
  VENDOR_OPENERS,
  vendorsToOmit,
} from "./_vendor-openers.ts";

const KINDS = VENDOR_OPENERS.map((entry) => entry.kind);
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

describe("declaredStageKinds", () => {
  test("reads both stages, fallback members included, defaults filled", () => {
    const config = toAgentConfig(
      agent({ name: "T", stt: fallback([assemblyAIStt(), deepgramStt()]) }),
    );
    expect([...(declaredStageKinds(config) ?? [])].sort(byCodeUnit)).toEqual([
      "assemblyai",
      "deepgram",
    ]);
  });

  test("a config with neither stage declares no kind; a non-config declares nothing at all", () => {
    expect(declaredStageKinds(toAgentConfig(agent({ name: "T", mode: "text" })))).toEqual(
      new Set(),
    );
    expect(declaredStageKinds(undefined)).toBeUndefined();
    expect(declaredStageKinds("not a config")).toBeUndefined();
  });
});

describe("vendorsToOmit", () => {
  test("the default pipeline reaches no vendor, so every one is left out", () => {
    expect(vendorsToOmit(toAgentConfig(agent({ name: "T" }))).sort(byCodeUnit)).toEqual(
      [...KINDS].sort(byCodeUnit),
    );
  });

  test("a declared vendor stays, the others go", () => {
    const config = toAgentConfig(agent({ name: "T", stt: deepgramStt() }));
    expect(vendorsToOmit(config).sort(byCodeUnit)).toEqual(
      KINDS.filter((k) => k !== "deepgram").sort(byCodeUnit),
    );
  });

  test("a text agent reaches no speech stage, so every vendor is left out", () => {
    expect(
      vendorsToOmit(toAgentConfig(agent({ name: "T", mode: "text" }))).sort(byCodeUnit),
    ).toEqual([...KINDS].sort(byCodeUnit));
  });

  test("an unreadable config (an older bundle) keeps every vendor in", () => {
    expect(vendorsToOmit(undefined)).toEqual([]);
  });
});

describe("omitVendorOpeners", () => {
  const plugin = omitVendorOpeners(["elevenlabs"]);
  const resolve = plugin.resolveId as (source: string, importer?: string) => string | null;
  const load = plugin.load as (id: string) => string | null;
  const DIST_IMPORTER = "/x/node_modules/@alexkroman1/aai-runtime/dist/agent-Btm1bsod.js";
  const SRC_IMPORTER = "/repo/packages/aai-runtime/src/providers/registry.ts";

  test("resolves the omitted vendor's opener in both shapes the bundler meets", () => {
    expect(resolve("./elevenlabs-BMoX3HYZ.js", DIST_IMPORTER)).toBe(
      "\0aai-omitted-vendor:elevenlabs",
    );
    expect(resolve("./stt/elevenlabs.ts", SRC_IMPORTER)).toBe("\0aai-omitted-vendor:elevenlabs");
  });

  test("leaves everything else to Vite: other vendors, other importers, bare specifiers", () => {
    expect(resolve("./deepgram-BQz5c9Wv.js", DIST_IMPORTER)).toBeNull();
    expect(resolve("./elevenlabs-BMoX3HYZ.js", "/repo/packages/aai/dist/index.js")).toBeNull();
    expect(resolve("./elevenlabs-BMoX3HYZ.js")).toBeNull();
    expect(resolve("@elevenlabs/elevenlabs-js", DIST_IMPORTER)).toBeNull();
    expect(load("/repo/packages/aai-runtime/dist/elevenlabs-BMoX3HYZ.js")).toBeNull();
  });

  test("the stub keeps the opener's name, loads silently, and throws when called", async () => {
    const code = load("\0aai-omitted-vendor:elevenlabs");
    expect(code).toContain("export function openElevenLabs()");
    const mod = (await import(`data:text/javascript,${encodeURIComponent(code ?? "")}`)) as {
      openElevenLabs: () => unknown;
    };
    const entry = VENDOR_OPENERS.find((candidate) => candidate.kind === "elevenlabs");
    if (entry === undefined) throw new Error("the table lost elevenlabs");
    expect(() => mod.openElevenLabs()).toThrow(omittedVendorMessage(entry));
    expect(omittedVendorMessage(entry)).toMatch(
      /ElevenLabs STT was left out of this bundle.*no "elevenlabs" stt stage.*@elevenlabs\/elevenlabs-js/,
    );
  });
});

describe("the table matches the built runtime", () => {
  // The runtime's `dist`, resolved the way the worker build resolves it: a
  // renamed chunk or opener would otherwise leave a vendor in silently.
  const runtimeDist = path.join(
    path.dirname(createRequire(import.meta.url).resolve("@alexkroman1/aai-runtime/package.json")),
    "dist",
  );
  const chunks = fs.existsSync(runtimeDist)
    ? fs.readdirSync(runtimeDist).filter((name) => name.endsWith(".js"))
    : [];

  test.each(VENDOR_OPENERS)("$kind: one `$module-<hash>.js` chunk exporting `$opener`", (entry) => {
    expect(chunks.length, `${runtimeDist} is missing — build aai-runtime first`).toBeGreaterThan(0);
    const matching = chunks.filter((name) =>
      new RegExp(`^${entry.module}-[\\w-]+\\.js$`).test(name),
    );
    expect(matching).toHaveLength(1);
    const source = fs.readFileSync(path.join(runtimeDist, matching[0] ?? ""), "utf-8");
    expect(source).toMatch(new RegExp(`^export \\{ ${entry.opener} \\};?$`, "m"));
    for (const pkg of entry.packages) expect(source).toContain(`from "${pkg}`);
  });

  test("the registry still reaches each opener through a lazy import of that chunk", () => {
    const registryChunk = chunks
      .map((name) => fs.readFileSync(path.join(runtimeDist, name), "utf-8"))
      .find((source) => source.includes("lazyOpener("));
    expect(registryChunk).toBeDefined();
    for (const entry of VENDOR_OPENERS) {
      expect(registryChunk).toMatch(
        new RegExp(`import\\("\\./${entry.module}-[\\w-]+\\.js"\\)\\)\\.${entry.opener}\\(`),
      );
    }
  });
});
