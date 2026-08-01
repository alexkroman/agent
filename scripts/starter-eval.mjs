// Copyright 2026 the AAI authors. MIT license.
/**
 * Starter-prompt eval: how many turns does the studio coding agent need to
 * produce a working agent from each getting-started prompt?
 *
 * Drives the studio's real HTTP surface — create project, broker a sandbox
 * session, stream one chat turn to the guest — so it exercises the same
 * server and guest path the browser does, but yields structured data:
 * step count, tool calls, and whether test_agent ended green.
 *
 *   node scripts/starter-eval.mjs [--only <substring>] [--out <file>]
 *
 * Not wired into CI: it spends real tokens on the caller's own key.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  checkCapabilities,
  checkMode,
  checkUi,
  EXPECTATIONS,
  parseLoadedConfig,
} from "./starter-expectations.mjs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const ORIGIN = process.env.AAI_ORIGIN ?? "http://127.0.0.1:8080";

/**
 * A turn can now legitimately run for many minutes (the step cap is 80), and
 * undici's default 300s body timeout kills the SSE stream mid-run — which
 * shows up as `TypeError: terminated` and looks exactly like the guest
 * crashing. It is the CLIENT giving up, so the client is what needs the
 * longer leash; the turn's real bound is TURN_TIMEOUT_MS below.
 */
const { Agent, fetch: undiciFetch } = await import(
  createRequire(import.meta.url).resolve("undici", { paths: ["packages/aai"] })
);
const streamDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });
/**
 * undici's OWN fetch, not the global. A dispatcher from this undici handed to
 * Node's internal (different-major) fetch fails as a bare
 * `TypeError: fetch failed` — the trap documented in CLAUDE.md's SSRF notes.
 */
const streamFetch = undiciFetch;
// Above the guest's HARD_TURN_MS (12 min) so the SERVER decides when a turn
// ends, not the measuring client — an aborted stream reads as a crash and
// loses the run.
const TURN_TIMEOUT_MS = 20 * 60_000;
/** Roughly the server's MAX_CHAT_STEPS; only used to flag long runs. */
const STEP_CAP_HINT = Number(process.env.AAI_STEP_CAP_HINT ?? 80);

function apiKey() {
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY;
  const cfg = path.join(homedir(), ".config", "aai", "config.json");
  const key = JSON.parse(readFileSync(cfg, "utf-8")).apiKey;
  if (!key) throw new Error("no apiKey in ~/.config/aai/config.json");
  return key;
}

/**
 * The studio's own starter prompts. Imported from the client module rather
 * than scraped: the prompts are multi-line concatenations with comments
 * between them, which no regex reads reliably.
 */
async function starters() {
  const mod = await import(
    new URL("../packages/aai-studio-client/src/starters.ts", import.meta.url).href
  );
  return mod.STARTERS;
}

async function api(key, endpoint, init = {}) {
  const res = await fetch(`${ORIGIN}/studio${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Stream one turn and summarize it. The guest speaks the AI SDK UI message
 * stream, so each SSE `data:` line is a typed part — counting `tool-input-*`
 * and reading `tool-output-*` is how step behavior is observed without
 * re-implementing the client.
 */
async function runTurn(key, url, prompt) {
  const started = Date.now();
  const res = await streamFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: prompt }] }],
    }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    dispatcher: streamDispatcher,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const summary = {
    toolCalls: [],
    errors: [],
    text: "",
    testAgentRuns: [],
    redChecks: [],
    lastTestAgentOutput: "",
    ms: 0,
  };
  const pending = new Map(); // toolCallId -> toolName

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      let part;
      try {
        part = JSON.parse(payload);
      } catch {
        continue;
      }
      if (part.type === "text-delta" && typeof part.delta === "string") summary.text += part.delta;
      if (typeof part.type === "string" && part.type.startsWith("tool-input-available")) {
        pending.set(part.toolCallId, part.toolName);
        summary.toolCalls.push(part.toolName);
      }
      if (typeof part.type === "string" && part.type.startsWith("tool-output-available")) {
        const name = pending.get(part.toolCallId);
        const out =
          typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");
        if (name === "test_agent") {
          summary.testAgentRuns.push({
            buildFailed: /error TS\d|Type check failed|Build failed|failed to load/i.test(out),
            testsFailed: /Tests: FAILED/i.test(out),
            excerpt: out.slice(0, 300),
          });
          summary.lastTestAgentOutput = out;
        }
        // Any verification that came back red, whichever tool ran it.
        //
        // Counting only test_agent makes the metric movable by reordering
        // tools: an agent that runs the cheap `check_types` first, fixes what
        // it finds, and only then builds scores zero repairs while having
        // written exactly the same wrong code. That reordering IS worth
        // something — check_types is far cheaper than a full build — but it is
        // a different thing from getting the code right, and optimizing one
        // number for both is how you end up congratulating yourself.
        if ((name === "test_agent" || name === "check_types") && /error TS\d/i.test(out)) {
          summary.redChecks.push(name);
        }
      }
      if (part.type === "error") summary.errors.push(String(part.errorText ?? "error"));
    }
  }
  summary.ms = Date.now() - started;
  return summary;
}

/** Wait for the guest's end-of-turn workspace sync to land. */
async function waitForWorkspace(key, project, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await api(key, `/projects/${project}`).catch(() => undefined);
    // agent.ts is the file every starter must produce; its presence means
    // the sync has happened rather than merely that the project exists.
    if (last?.files?.["agent.ts"] !== undefined) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Did this turn produce something the user could actually ship?
 *
 * Deliberately NOT "the tests passed": the agent writes its own tests, so
 * that measure can be satisfied by weakening an assertion. What matters is
 * whether the agent the runtime built covers what the prompt enumerated —
 * checked against the prompt, which the agent cannot edit.
 *
 * The failure taxonomy exists because "RED" was hiding three different
 * problems that want three different fixes: never verified (prompt
 * adherence), verified-and-broken (capability), and out of steps (budget).
 */
function verdict(s, expectation, files) {
  const last = s.testAgentRuns.at(-1);
  const built = Boolean(last && !last.buildFailed && !last.testsFailed);
  const source = files?.["agent.ts"] ?? "";
  const config = parseLoadedConfig(s.lastTestAgentOutput);
  const caps = expectation
    ? checkCapabilities(expectation, { config, source })
    : { covered: true, missing: [], missingBuiltins: [], toolCount: 0, tooFewTools: false };
  const mode = checkMode(config, source);
  const ui = checkUi(expectation, files);
  // "Ends by asking" is a real outcome, not a failure: it costs the user a
  // turn, which is the thing being minimized, so it is counted separately.
  const askedQuestion = /\?\s*$/.test(s.text.trim());

  const reasons = [];
  if (s.testAgentRuns.length === 0) reasons.push("never-verified");
  else if (!built) reasons.push("verified-broken");
  if (caps.missing.length) reasons.push(`missing:${caps.missing.join("/")}`);
  if (caps.missingBuiltins.length) reasons.push(`missing-builtin:${caps.missingBuiltins.join("/")}`);
  if (caps.tooFewTools) reasons.push(`too-few-tools:${caps.toolCount}`);
  if (!mode.ok) reasons.push(mode.note);
  if (!ui.ok) reasons.push(ui.note);
  // Tool calls, not steps: a step may issue several in parallel, so this is a
  // heuristic flag for "ran long", not proof the cap was hit.
  if (s.toolCalls.length >= STEP_CAP_HINT) reasons.push("ran-long");

  return {
    // The headline: built, loaded, and covers the ask.
    shippable: built && caps.covered && !caps.tooFewTools && mode.ok && ui.ok,
    builtClient: files?.["client.tsx"] !== undefined,
    endedGreen: built,
    reasons,
    askedQuestion,
    ranTestAgent: s.testAgentRuns.length,
    failedTestAgentRuns: s.testAgentRuns.filter((r) => r.buildFailed || r.testsFailed).length,
    toolCalls: s.toolCalls.length,
    errors: s.errors.length,
    seconds: Math.round(s.ms / 1000),
    failures: s.testAgentRuns.filter((r) => r.buildFailed || r.testsFailed).map((r) => r.excerpt),
    // Every red verification, not just the expensive one — see redChecks.
    redChecks: s.redChecks.length,
    firstTryClean: s.redChecks.length === 0,
    errorTexts: s.errors.slice(0, 3),
  };
}

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
// Repeats matter more than breadth here: run-to-run variance on an identical
// config swamps the effect of a prompt edit, so a single pass cannot tell a
// real improvement from a lucky one.
const repeat = args.includes("--repeat") ? Number(args[args.indexOf("--repeat") + 1]) : 1;

const key = apiKey();
const allStarters = await starters();

/**
 * Fail fast if an expectation demands something its prompt never asked for.
 *
 * This is the bug class that already bit once: a required `inventory` tool
 * for a prompt whose parenthetical DEFINED inventory as take/drop, which
 * failed a perfectly good agent. An expectation is a claim about the ask, so
 * it has to be checkable against the ask.
 */
for (const e of EXPECTATIONS) {
  const starter = allStarters.find((s) => s.label === e.label);
  if (!starter) throw new Error(`expectation for unknown starter: ${e.label}`);
  if (e.ui && !/client\.tsx|custom UI/i.test(starter.prompt)) {
    throw new Error(`expectation requires a UI but the prompt never asks for one: ${e.label}`);
  }
  for (const b of e.builtins ?? []) {
    if (!starter.prompt.includes(b)) {
      throw new Error(`expectation requires builtin ${b} but the prompt never names it: ${e.label}`);
    }
  }
  for (const b of e.builtinDelegation ?? []) {
    if (!starter.prompt.includes(b)) {
      throw new Error(`builtinDelegation names ${b}, which the prompt never asks for: ${e.label}`);
    }
  }
  // The other direction: a grader that says yes to everything measures
  // nothing. `builtinDelegation` accepts prose as evidence, so prove that an
  // agent with the prose and none of the machinery still fails.
  if (e.builtinDelegation && (e.capabilities ?? []).length > 0) {
    const proseOnly = `greeting: "${(e.capabilities ?? []).map((syn) => syn[0]).join(" and ")}"`;
    const { missing } = checkCapabilities(e, { config: null, source: proseOnly });
    if (missing.length !== e.capabilities.length) {
      throw new Error(`builtinDelegation passes on prose alone: ${e.label}`);
    }
  }
}

const cases = allStarters.filter((c) => !only || c.label.toLowerCase().includes(only.toLowerCase()));
if (cases.length === 0) throw new Error(`no starter matched ${only}`);

const results = [];
const plan = [];
for (let rep = 0; rep < repeat; rep++) for (const c of cases) plan.push({ ...c, rep });
for (const [i, c] of plan.entries()) {
  const project = `eval-${Date.now().toString(36)}-${i}`;
  process.stderr.write(`\n[${i + 1}/${plan.length}] r${c.rep + 1} ${c.label}\n  project ${project} … `);
  try {
    await api(key, "/projects", { method: "POST", body: JSON.stringify({ name: project }) });
    const session = await api(key, `/projects/${project}/session`, {
      method: "POST",
      body: "{}",
    });
    const summary = await runTurn(key, session.url, c.prompt);
    // Always snapshot: the capability check reads agent.ts, and the store is
    // in-memory, so a restart erases the evidence.
    //
    // POLL, do not read once. The guest syncs the workspace back to the host
    // in its onFinish handler, which can land after the stream closes — a
    // single read races it and returns the pre-turn state, which now means
    // an empty project and a capability check that fails everything.
    const workspace = await waitForWorkspace(key, project);
    const expectation = EXPECTATIONS.find((e) => e.label === c.label);
    const v = verdict(summary, expectation, workspace?.files);
    results.push({
      label: c.label,
      rep: c.rep,
      project,
      ...v,
      tools: summary.toolCalls,
      // Kept for every run, not just failures: the questions worth asking of
      // this data — did it build a client, which builtins did it reach for
      // unprompted — are answered by the runs that SUCCEEDED, and capturing
      // only failures biases every count that follows.
      ...(workspace ? { files: workspace.files } : {}),
    });
    process.stderr.write(
      `${v.shippable ? "SHIPPABLE" : "NOT-SHIPPABLE"}  tools=${v.toolCalls} ` +
        `repairs=${v.failedTestAgentRuns} red=${v.redChecks}  ${v.seconds}s` +
        (v.reasons.length ? `  [${v.reasons.join(" ")}]` : "") +
        `\n`,
    );
  } catch (err) {
    results.push({ label: c.label, rep: c.rep, project, error: String(err).slice(0, 300) });
    process.stderr.write(`ERROR ${String(err).slice(0, 200)}\n`);
  }
}

const report = JSON.stringify(results, null, 2);
if (outFile) writeFileSync(outFile, report);
console.log(report);
