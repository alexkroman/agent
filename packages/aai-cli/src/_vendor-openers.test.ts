// Copyright 2026 the AAI authors. MIT license.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { agent } from "@alexkroman1/aai";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { assemblyAIStt, deepgramStt, fallback } from "@alexkroman1/aai/stt";
import { describe, expect, test } from "vitest";
import { compareCodeUnits } from "./_utils.ts";
import {
  omitVendorOpeners,
  openerSpecifiers,
  VENDOR_OPENERS,
  vendorsToOmit,
} from "./_vendor-openers.ts";

const KINDS = [...VENDOR_OPENERS.map((entry) => entry.kind)].sort(compareCodeUnits);

/** The runtime's real directory, resolved the way the plugin resolves it from this package. */
const RUNTIME_DIR = fs.realpathSync(
  path.dirname(createRequire(import.meta.url).resolve("@alexkroman1/aai-runtime/package.json")),
);

describe("vendorsToOmit", () => {
  test("the default pipeline reaches no vendor, so every one is left out", () => {
    expect(vendorsToOmit(toAgentConfig(agent({ name: "T" }))).sort(compareCodeUnits)).toEqual(
      KINDS,
    );
  });

  test("a declared vendor stays, a fallback member included; the others go", () => {
    const config = toAgentConfig(
      agent({ name: "T", stt: fallback([assemblyAIStt(), deepgramStt()]) }),
    );
    expect(vendorsToOmit(config).sort(compareCodeUnits)).toEqual(
      KINDS.filter((kind) => kind !== "deepgram"),
    );
  });

  test("a text agent reaches no speech stage, so every vendor is left out", () => {
    const config = toAgentConfig(agent({ name: "T", mode: "text" }));
    expect(vendorsToOmit(config).sort(compareCodeUnits)).toEqual(KINDS);
  });

  test("an unreadable config (an older bundle) keeps every vendor in", () => {
    expect(vendorsToOmit(undefined)).toEqual([]);
    expect(vendorsToOmit("not a config")).toEqual([]);
  });
});

describe("omitVendorOpeners", () => {
  const plugin = omitVendorOpeners(import.meta.dirname, ["elevenlabs"]);
  const resolve = plugin.resolveId as (source: string, importer?: string) => string | null;
  const load = plugin.load as (id: string) => string | null;
  const DIST_IMPORTER = path.join(RUNTIME_DIR, "dist/agent-Btm1bsod.js");
  const SRC_IMPORTER = path.join(RUNTIME_DIR, "src/providers/registry.ts");
  const STUB = "\0aai-omitted-vendor:elevenlabs";

  test("resolves the omitted vendor's opener at both specifiers the registry uses", () => {
    expect(resolve("./providers/stt/elevenlabs.js", DIST_IMPORTER)).toBe(STUB);
    expect(resolve("./stt/elevenlabs.ts", SRC_IMPORTER)).toBe(STUB);
  });

  test("leaves everything else to Vite: other vendors, other importers, bare specifiers", () => {
    expect(resolve("./providers/stt/deepgram.js", DIST_IMPORTER)).toBeNull();
    // A project of the runtime's own name, or beside it, is not the runtime.
    expect(
      resolve("./providers/stt/elevenlabs.js", `${RUNTIME_DIR}-fork/dist/agent.js`),
    ).toBeNull();
    expect(resolve("./stt/elevenlabs.ts", "/home/me/aai-runtime/tools/x.ts")).toBeNull();
    expect(resolve("./providers/stt/elevenlabs.js")).toBeNull();
    expect(resolve("@elevenlabs/elevenlabs-js", DIST_IMPORTER)).toBeNull();
    expect(load(path.join(RUNTIME_DIR, "dist/providers/stt/elevenlabs.js"))).toBeNull();
  });

  test("the stub keeps the opener's name, loads silently, and throws when called", async () => {
    const code = load(STUB);
    expect(code).toContain("export function openElevenLabs()");
    const mod = (await import(`data:text/javascript,${encodeURIComponent(code ?? "")}`)) as {
      openElevenLabs: () => unknown;
    };
    expect(() => mod.openElevenLabs()).toThrow(
      /ElevenLabs STT was left out of this bundle.*no "elevenlabs" stt stage.*@elevenlabs\/elevenlabs-js/,
    );
  });
});

describe("the table matches the built runtime", () => {
  // Read from the runtime's `dist` as the worker build resolves it: a moved
  // opener or a renamed export would otherwise leave a vendor in silently.
  const dist = path.join(RUNTIME_DIR, "dist");

  test.each(VENDOR_OPENERS)(
    "$kind: `$module` is a chunk at its stable path exporting `$opener`",
    (entry) => {
      const chunk = path.join(dist, openerSpecifiers(entry).dist);
      expect(fs.existsSync(chunk), `${chunk} is missing — build aai-runtime first`).toBe(true);
      const source = fs.readFileSync(chunk, "utf-8");
      expect(source).toMatch(new RegExp(`^export \\{ ${entry.opener} \\};?$`, "m"));
      for (const pkg of entry.packages) expect(source).toContain(`from "${pkg}`);
    },
  );

  test("the registry still reaches each opener through a lazy import of that chunk", () => {
    let registry: string | undefined;
    for (const name of fs.readdirSync(dist)) {
      if (!name.endsWith(".js")) continue;
      const source = fs.readFileSync(path.join(dist, name), "utf-8");
      if (source.includes("lazyOpener(")) {
        registry = source;
        break;
      }
    }
    expect(registry).toBeDefined();
    for (const entry of VENDOR_OPENERS) {
      expect(registry).toContain(`import("${openerSpecifiers(entry).dist}")).${entry.opener}(`);
    }
  });
});
