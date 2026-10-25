// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { agent } from "./define.ts";
import { stepFetch } from "./step-fetch.ts";
import { stepGenerate } from "./step-generate.ts";
import { stepNotifyClient } from "./step-notify-client.ts";
import { publishStepReporter, stepReport } from "./step-report.ts";
import { stepSpeak } from "./step-speak.ts";
import { stepTranscribePoll } from "./step-transcribe.ts";
import { stepUploadInfo } from "./step-uploads.ts";
import { deployedAgent } from "./testing-discovery.ts";
import {
  describeAgent,
  installStubClientInbox,
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  installStubWorkflows,
  installStubWorld,
} from "./testing-vitest.ts";
import { createRunSnapshot } from "./testing-workflows.ts";
import type { ToolDef } from "./types.ts";

/**
 * Each fake is asserted twice: once that it is INSTALLED, and once — from the
 * next test — that it is GONE.
 *
 * The second half is the whole reason this module exists. `onTestFinished` runs
 * against the test that registered it, so a fake installed inside a test body
 * (which is where every template's `stubProvider()` helper is called) unwinds
 * without the caller keeping a registry. A leak here does not fail this file;
 * it fails a different one, later, which is what makes it worth pinning.
 */
describe("installStubUploads", () => {
  test("publishes the store", async () => {
    const uploads = installStubUploads({ upl_1: new Uint8Array([1, 2, 3]) });
    await expect(stepUploadInfo("upl_1")).resolves.toMatchObject({ size: 3 });
    expect(uploads.writes).toEqual([]);
  });

  test("and the store is gone by the next test", async () => {
    await expect(stepUploadInfo("upl_1")).rejects.toThrow();
  });
});

describe("installStubStepFetch", () => {
  test("publishes the fetch, recording what the step sent", async () => {
    const fetched = installStubStepFetch(() => ({ body: { ok: true } }));
    const answered = await stepFetch("https://example.test/thing");
    expect(await answered.json()).toEqual({ ok: true });
    expect(fetched.calls.map((call) => call.url)).toEqual(["https://example.test/thing"]);
  });

  test("defaults to an empty 200 when given no answer", async () => {
    installStubStepFetch();
    const answered = await stepFetch("https://example.test/thing");
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({});
  });
});

describe("installStubReporter", () => {
  test("captures what a step narrates", async () => {
    const reported = installStubReporter();
    await stepReport("halfway");
    expect(reported.lines).toEqual(["halfway"]);
  });

  test("and is unpublished by the next test", async () => {
    // Back to the console fallback, which is what an unpublished slot means —
    // and the proof that `onTestFinished` really ran the previous test's
    // `restore`, with no `afterEach` anywhere in this file.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await stepReport("nobody is listening");
    expect(spy).toHaveBeenCalled();
  });
});

describe("installStubSpeech", () => {
  test("publishes a synthesizer and records what it was asked to say", async () => {
    // No `vi.stubEnv` for the key: the fake presents it to nobody, so it
    // does not ask for one.
    const speech = installStubSpeech();
    await stepSpeak("Three findings.");
    expect(speech.calls[0]?.text).toBe("Three findings.");
  });

  test("a per-test install needs no registry: this test's fake is the one that answers", async () => {
    // Failing rather than speaking is the half a spec cannot write by leaving
    // the slot empty: unpublished means "no synthesizer here", which is a
    // different sentence and a different branch from a provider that refused.
    installStubSpeech({ error: new Error("provider said no") });
    await expect(stepSpeak("Anything.")).rejects.toThrow("provider said no");
  });
});

describe("installStubClientInbox", () => {
  test("publishes an inbox and records what was pushed", async () => {
    const inbox = installStubClientInbox();
    await stepNotifyClient("kitchen", { id: "wrun_1", event: "reminder" });
    expect(inbox.calls).toMatchObject([{ clientId: "kitchen", notice: { id: "wrun_1" } }]);
  });

  test("and the inbox is gone by the next test", async () => {
    await expect(stepNotifyClient("kitchen", { id: "wrun_2", event: "reminder" })).rejects.toThrow(
      /inbox|client/i,
    );
  });

  test("passes its options through: a busy device is a throw the step sees", async () => {
    installStubClientInbox({ answer: "busy" });
    await expect(
      stepNotifyClient("kitchen", { id: "wrun_3", event: "reminder" }),
    ).rejects.toThrow();
  });
});

describe("installStubTranscribe", () => {
  test("answers the transcription endpoints", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    const provider = installStubTranscribe({ text: "we ship tuesday" });
    await expect(stepTranscribePoll("job_a")).resolves.toMatchObject({
      transcript: { text: "we ship tuesday" },
    });
    expect(provider.calls.map((call) => call.leg)).toEqual(["poll"]);
  });

  test("a per-test install needs no registry: this test's fake is the one that answers", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
    // The registry this replaces — `const restores: (() => void)[]` plus an
    // `afterEach` that splices it — appeared three times in one template spec.
    installStubTranscribe({ text: "this test's own answer" });
    await expect(stepTranscribePoll("job_a")).resolves.toMatchObject({
      transcript: { text: "this test's own answer" },
    });
  });
});

describe("installStubGateway", () => {
  test("installs the fake as the global fetch and returns its live call log", async () => {
    const calls = installStubGateway('{"headline":"Otters use tools"}');
    await fetch("https://gateway.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Otters use tools." }] }),
    });
    expect(calls[0]?.prompt).toBe("Otters use tools.");
  });
});

describe("installStubWorkflows", () => {
  const runs = [
    createRunSnapshot({ runId: "a", status: "running" }),
    createRunSnapshot({ runId: "b", status: "pending" }),
    createRunSnapshot({ runId: "c", status: "completed", output: "done" }),
  ];

  test("answers every lookup from the one list, findByKey included", async () => {
    const workflows = installStubWorkflows({ runs, runId: "wrun_x" });
    await expect(workflows.start("digest", {})).resolves.toBe("wrun_x");
    await expect(workflows.get("a")).resolves.toMatchObject({ runId: "a" });
    await expect(workflows.findByKey("caller-1")).resolves.toHaveLength(3);
    await expect(workflows.find("digest", "caller-1")).resolves.toHaveLength(3);
    await expect(workflows.recent("digest")).resolves.toHaveLength(3);
  });

  test("latest is the first, live the first still going, and signalRun is delivered", async () => {
    const workflows = installStubWorkflows({ runs: [runs[2] as (typeof runs)[number], ...runs] });
    await expect(workflows.latest("digest")).resolves.toMatchObject({ runId: "c" });
    await expect(workflows.live("digest", "caller-1")).resolves.toMatchObject({ runId: "a" });
    await expect(workflows.signalRun("digest", "caller-1", "approved", { ok: true })).resolves.toBe(
      true,
    );
    expect(vi.mocked(workflows.signalRun).mock.calls[0]).toEqual([
      "digest",
      "caller-1",
      "approved",
      { ok: true },
    ]);
    await expect(installStubWorkflows().live("digest")).resolves.toBeUndefined();
  });

  test("cancelAll counts the unfinished runs, as one cancel per run would", async () => {
    const workflows = installStubWorkflows({ runs });
    await expect(workflows.cancelAll("digest", "caller-1")).resolves.toBe(2);
    await expect(workflows.cancel("a")).resolves.toBe(true);
    await expect(workflows.wakeUp("a")).resolves.toBe(0);
  });
});

describe("installStubGateway seeds the credential", () => {
  test("seeds ASSEMBLYAI_API_KEY when the process holds none", () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", undefined);
    installStubGateway("ok");
    expect(process.env.ASSEMBLYAI_API_KEY).toBe("sk-aai-stub");
  });

  test("keeps a value the spec set itself", () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-mine");
    installStubGateway("ok");
    expect(process.env.ASSEMBLYAI_API_KEY).toBe("sk-mine");
  });

  test("`apiKey: false` seeds nothing, for the spec whose subject is the refusal", () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", undefined);
    installStubGateway("ok", { apiKey: false });
    expect(process.env.ASSEMBLYAI_API_KEY).toBeUndefined();
  });

  test("and the seed is gone by the next test", () => {
    // `unstubEnvs` would do this too; the explicit restore is for a project
    // whose config does not set it.
    expect(process.env.ASSEMBLYAI_API_KEY).not.toBe("sk-aai-stub");
  });
});

describe("installStubWorkflows derives the listing from the agent", () => {
  test("reports the agent's declared workflows", () => {
    const def = { workflows: { recap: {}, digest: {} } };
    expect(installStubWorkflows({ agent: def }).listing()).toEqual([
      { name: "recap" },
      { name: "digest" },
    ]);
  });

  test("an explicit `names` wins over the agent", () => {
    const def = { workflows: { recap: {} } };
    expect(installStubWorkflows({ agent: def, names: ["other"] }).listing()).toEqual([
      { name: "other" },
    ]);
  });
});

describe("installStubWorld", () => {
  test("routes the model FIRST, then the pages, through one published step fetch", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", undefined);
    const world = installStubWorld({
      model: '{"headline":"Otters"}',
      pages: { "https://example.test/otters": { body: "<p>otters</p>" } },
    });
    // The credential the gateway step refuses without is seeded.
    expect(process.env.ASSEMBLYAI_API_KEY).toBe("sk-aai-stub");
    expect(await stepGenerate("Summarize the otters.")).toBe('{"headline":"Otters"}');
    expect(world.model[0]?.prompt).toBe("Summarize the otters.");
    const page = await stepFetch("https://example.test/otters");
    expect(await page.text()).toBe("<p>otters</p>");
    // A leg nobody named is a finding, never an empty 200.
    await expect(stepFetch("https://example.test/elsewhere")).rejects.toThrow(
      /no fetch route for GET https:\/\/example.test\/elsewhere/,
    );
  });

  test("leaves a reporter already published in place — an eval's `run.reported` keeps reading", async () => {
    const seen: unknown[] = [];
    publishStepReporter((chunk) => {
      seen.push(chunk);
    });
    onTestFinished(() => publishStepReporter(undefined));
    const world = installStubWorld({});
    await stepReport("still the harness's");
    expect(seen).toEqual(["still the harness's"]);
    expect(world.reported.lines).toEqual([]);
    // `reporter: true` displaces it on purpose; `false` never publishes.
    const forced = installStubWorld({ reporter: true });
    await stepReport("now the stub's");
    expect(forced.reported.lines).toEqual(["now the stub's"]);
    expect(seen).toEqual(["still the harness's"]);
  });

  test("publishes its recording reporter when nothing is published", async () => {
    const world = installStubWorld({ reporter: undefined });
    await stepReport("recorded");
    expect(world.reported.lines).toEqual(["recorded"]);
  });

  test("a `pages` handler is the last leg, and an unanswered request throws naming it", async () => {
    installStubWorld({ pages: () => undefined });
    await expect(stepFetch("https://example.test/none")).rejects.toThrow(
      "installStubWorld: no leg answers GET https://example.test/none",
    );
  });

  test("with `transcribe`, the provider owns the slot and the model is its `otherwise`", async () => {
    const world = installStubWorld({
      model: '{"summary":"shipped"}',
      transcribe: { text: "we ship tuesday" },
    });
    await expect(stepTranscribePoll("job_a")).resolves.toMatchObject({
      transcript: { text: "we ship tuesday" },
    });
    expect(await stepGenerate("Summarize.")).toBe('{"summary":"shipped"}');
    // The provider logs what fell through to its `otherwise` too, as `other`.
    expect(world.provider.map((call) => call.leg)).toEqual(["poll", "other"]);
    expect(world.model).toHaveLength(1);
  });

  test("speech, uploads and the reporter are installed when named", async () => {
    const world = installStubWorld({
      speech: true,
      uploads: { upl_1: new Uint8Array([1, 2, 3]) },
    });
    await stepSpeak("Three findings.");
    expect(world.speech.map((call) => call.text)).toEqual(["Three findings."]);
    await expect(stepUploadInfo("upl_1")).resolves.toMatchObject({ size: 3 });
    expect(world.files).toBeDefined();
    await stepReport("working");
    expect(world.reported.lines).toEqual(["working"]);
  });

  test("names nothing, installs nothing but the reporter", async () => {
    const world = installStubWorld({ apiKey: false });
    expect(world).toMatchObject({ model: [], provider: [], speech: [], uploads: [] });
    expect(world.files).toBeUndefined();
    await expect(stepSpeak("Anything.")).rejects.toThrow();
  });
});

const addItem: ToolDef = {
  description: "Add an item",
  execute: (args) => ({ added: args.item }),
};

describeAgent(
  deployedAgent(agent({ name: "Desk" }), {
    tools: { "./tools/add_item.ts": { default: addItem } },
  }),
  (run, def) => {
    test("hands the body the typed runner and the agent", async () => {
      expect(def.name).toBe("Desk");
      expect(await run(addItem, { item: "apple" })).toEqual({ added: "apple" });
      expect(await run("add_item", { item: "pear" })).toEqual({ added: "pear" });
    });
  },
);

describeAgent(agent({ name: "Mute" }), (run) => {
  test("a tool-less agent keeps its deployable case, and the runner refuses at the call", async () => {
    await expect(run("anything")).rejects.toThrow("declares no tools");
  });
});
