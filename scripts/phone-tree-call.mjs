#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * Have a deployed outbound-calling agent dial a REAL phone tree, and report
 * what the carrier decoded at every menu next to what the agent pressed.
 *
 * ```sh
 * TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… CALLS_API_KEY=… \
 *   node scripts/phone-tree-call.mjs \
 *     --agent https://<agent-url> \
 *     --scenario packages/aai-templates/templates/outbound-call-agent/phone-trees.ts#PHARMACY_CALL \
 *     --ivr-number +14155550199
 * ```
 *
 * ## Why a real call, when the eval walks the same tree
 *
 * `walkPhoneTree` (the eval) answers "does the model choose the right key".
 * It cannot answer whether the key ARRIVES: `sendDtmf` plays in-band tone
 * pairs into the agent's audio, which is resampled, μ-law-encoded and carried
 * over the phone network to a receiver that must decode them. A tone dropped by
 * a barge-in, clipped by the resampler or misread by the carrier looks, from
 * the agent's side, exactly like a press that worked. Only the far end can say,
 * and this script is the far end: a Twilio number whose `<Gather>` records the
 * digits it decoded.
 *
 * ## What it does
 *
 * 1. Loads the scenario — a module export `{ task, tree, goal }`, the same
 *    `PhoneTree` data the eval walks (a `.ts` file loads through Node's type
 *    stripping).
 * 2. Serves that tree as TwiML on a local port, behind a Cloudflare quick
 *    tunnel (`cloudflared` on PATH). Every request
 *    must carry a valid `X-Twilio-Signature`: the tunnel is public.
 * 3. Points `--ivr-number`'s voice webhook at it for the run and RESTORES the
 *    old one on exit, Ctrl-C included. The number must be on the account.
 * 4. Places the call through the agent's own API (`POST /api/v1/calls`) and
 *    polls it to the end.
 * 5. Prints both timelines and a verdict. Exit 0 when the agent reached the
 *    scenario's `goal` and every key it pressed is a key the menu decoded.
 *
 * `--human +1…` dials your phone at the leaf instead of the scripted line, so
 * you can play whoever picks up. `--serve-only` serves the tree on localhost
 * with no tunnel, no Twilio and no call, to read the TwiML by hand.
 *
 * Costs two calls' worth of Twilio minutes per run, on the calling account.
 */

import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sleep } from "../packages/aai/src/sdk/sleep.ts";
import { parseScriptArgs, requiredValue } from "./_args.mjs";

const SCRIPT = import.meta.url;
const { values } = parseScriptArgs({
  script: SCRIPT,
  options: {
    agent: { type: "string" },
    scenario: { type: "string" },
    "ivr-number": { type: "string" },
    human: { type: "string" },
    timeout: { type: "string", default: "420" },
    "serve-only": { type: "boolean", default: false },
  },
});

/** Seconds a menu waits for the first key after its prompt, and between keys. */
const GATHER_TIMEOUT_S = 8;
/** Most menu prompts played before the IVR hangs up — where a looping agent ends. */
const MAX_PROMPTS = 12;
/** How often the call is polled. */
const POLL_MS = 3000;
const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
/** What a menu says before playing again, by why it is playing again. */
const REPLAY_PREFIX = {
  invalid: "Sorry, that is not a valid option.",
  silent: "Sorry, I didn't get your selection.",
};

// ── the scenario ────────────────────────────────────────────────────────────

/** Load `file#EXPORT` — a `{ task, tree, goal }` the eval walks too. */
async function loadScenario(spec) {
  const [file, name = "default"] = spec.split("#");
  const mod = await import(pathToFileURL(resolve(file)).href);
  const scenario = mod[name];
  if (typeof scenario?.task !== "string" || typeof scenario?.tree !== "object") {
    throw new Error(`${spec}: expected an export { task, tree, goal? }, found ${typeof scenario}`);
  }
  return scenario;
}

const isMenu = (node) => node.options !== undefined;

/** One id per node OBJECT, so a leaf several menus share is one node. */
function indexTree(tree) {
  const ids = new Map();
  const byId = new Map();
  const visit = (node) => {
    if (ids.has(node)) return;
    const id = `n${ids.size}`;
    ids.set(node, id);
    byId.set(id, node);
    if (isMenu(node)) for (const next of Object.values(node.options)) visit(next);
  };
  visit(tree);
  return { idOf: (node) => ids.get(node), node: (id) => byId.get(id) };
}

/** The node `entry` selects — the same rule as `walkPhoneTree`, `#` read as the terminator. */
function select(menu, entry) {
  const own = (key) => (Object.hasOwn(menu.options, key) ? menu.options[key] : undefined);
  return own(entry) ?? (entry.endsWith("#") ? own(entry.slice(0, -1)) : undefined);
}

/** Keys as a carrier sees them: separators and pauses gone, `#` (Gather's finishOnKey) dropped. */
const asDecoded = (keys) =>
  keys
    .replace(/[\s,w-]/gi, "")
    .replace(/[a-d]/g, (k) => k.toUpperCase())
    .replaceAll("#", "");

// ── TwiML ───────────────────────────────────────────────────────────────────

const xml = (text) =>
  text.replace(
    /[<>&"']/g,
    (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[c]};`,
  );

const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

function menuTwiml(base, id, menu, prefix) {
  // One key per option: answer on the first press, as a real single-key menu does.
  const single = Object.keys(menu.options).every((key) => key.length === 1);
  const digits = single ? ' numDigits="1"' : "";
  const said = prefix === "" ? menu.prompt : `${prefix} ${menu.prompt}`;
  return twiml(
    `<Gather input="dtmf" action="${base}/press/${id}" method="POST" timeout="${GATHER_TIMEOUT_S}" finishOnKey="#"${digits}>` +
      `<Say>${xml(said)}</Say></Gather>` +
      `<Redirect method="POST">${base}/node/${id}?replay=silent</Redirect>`,
  );
}

function leafTwiml(base, id, leaf, human) {
  if (human !== undefined) return twiml(`<Dial>${xml(human)}</Dial>`);
  // Listen to the agent's reply, so the report has what the far end HEARD.
  return twiml(
    `<Say>${xml(leaf.prompt)}</Say>` +
      `<Gather input="speech" action="${base}/heard/${id}" method="POST" speechTimeout="auto" timeout="10"/>` +
      "<Say>Goodbye.</Say><Hangup/>",
  );
}

// ── the IVR server ──────────────────────────────────────────────────────────

/** Twilio's request signature: HMAC-SHA1 over the full URL plus the sorted POST params. */
function twilioSignature(token, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", token).update(data).digest("base64");
}

function validSignature(token, url, params, given) {
  const want = Buffer.from(twilioSignature(token, url, params));
  const got = Buffer.from(given ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/**
 * The tree as a Twilio webhook. `events` is the far end's account of the call:
 * every prompt played, every entry decoded, the leaf, and what was said there.
 */
function startIvr({ tree, token, human, publicBase }) {
  const index = indexTree(tree);
  const events = [];
  let prompts = 0;
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`ivr: ${err instanceof Error ? err.message : err}`);
      res.writeHead(500).end();
    });
  });

  /** A menu or leaf being played; `replay` says why a menu plays again. */
  function onNode(id, node, replay, params) {
    if (isMenu(node) && ++prompts > MAX_PROMPTS) {
      events.push({ kind: "gave-up", node: node.name });
      return twiml("<Say>Goodbye.</Say><Hangup/>");
    }
    if (replay === "silent") events.push({ kind: "no-input", node: node.name });
    if (!isMenu(node)) {
      events.push({ kind: "leaf", node: node.name, callSid: params.CallSid });
      return leafTwiml(publicBase(), id, node, human);
    }
    if (replay === null) events.push({ kind: "menu", node: node.name, callSid: params.CallSid });
    return menuTwiml(publicBase(), id, node, REPLAY_PREFIX[replay ?? ""] ?? "");
  }

  /** The digits a menu's `<Gather>` decoded, and where they lead. */
  function onPress(id, menu, params) {
    const digits = params.Digits ?? "";
    const next = select(menu, digits);
    events.push({ kind: "press", node: menu.name, digits, next: next?.name });
    const to = next === undefined ? `${id}?replay=invalid` : index.idOf(next);
    return twiml(`<Redirect method="POST">${publicBase()}/node/${to}</Redirect>`);
  }

  /** What the leaf's speech `<Gather>` heard the agent say. */
  function onHeard(leaf, params) {
    events.push({ kind: "heard", node: leaf.name, speech: params.SpeechResult ?? "" });
    return twiml("<Say>Thanks, goodbye.</Say><Hangup/>");
  }

  /** The TwiML for one signed request, or `undefined` for a path that is not the tree's. */
  function route(url, params) {
    const [, kind, id = ""] = url.pathname.split("/");
    const node = index.node(id);
    if (node === undefined) return;
    if (kind === "node") return onNode(id, node, url.searchParams.get("replay"), params);
    if (kind === "press" && isMenu(node)) return onPress(id, node, params);
    if (kind === "heard") return onHeard(node, params);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://ivr");
    if (url.pathname === "/healthz") return res.writeHead(200).end("ok");
    const params = req.method === "POST" ? await readForm(req) : {};
    const signed = `${publicBase()}${req.url}`;
    if (!validSignature(token, signed, params, req.headers["x-twilio-signature"])) {
      return res.writeHead(403).end("bad signature");
    }
    const body = route(url, params);
    if (body === undefined) return res.writeHead(404).end();
    return res.writeHead(200, { "content-type": "text/xml" }).end(body);
  }

  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      ready({
        server,
        events,
        port: typeof address === "object" && address ? address.port : 0,
        entry: index.idOf(tree),
      });
    });
  });
}

// ── the tunnel, Twilio, the agent ───────────────────────────────────────────

/** A quick tunnel to `port`, once it answers from the outside. */
async function openTunnel(port) {
  const bin = "cloudflared";
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = await new Promise((found, fail) => {
    let seen = "";
    const timer = setTimeout(() => fail(new Error("cloudflared printed no URL in 60s")), 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(new Error(`cannot run ${bin}: ${err.message} (brew install cloudflared)`));
    });
    child.stderr.on("data", (chunk) => {
      seen += chunk;
      const match = QUICK_TUNNEL_URL_RE.exec(seen);
      if (match) {
        clearTimeout(timer);
        found(match[0]);
      }
    });
  });
  // A fresh quick tunnel's hostname takes a few seconds to resolve.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ok = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return { url, close: () => child.kill() };
    if (Date.now() > deadline) throw new Error(`tunnel ${url} never answered`);
    await sleep(1000);
  }
}

function twilioApi(sid, token) {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
  return async (path, form) => {
    const res = await fetch(`${base}${path}`, {
      method: form ? "POST" : "GET",
      headers: { authorization: auth },
      // A `URLSearchParams` body sets the form content-type itself.
      body: form ? new URLSearchParams(form) : null,
      signal: AbortSignal.timeout(15_000),
    });
    const body = /** @type {Record<string, any>} */ (await res.json());
    if (!res.ok) throw new Error(`Twilio ${path}: ${res.status} ${body.message ?? ""}`);
    return body;
  };
}

/** Point `number`'s voice webhook at `url`; answers the restore. */
async function borrowNumber(twilio, number, url) {
  const found = await twilio(
    `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
  );
  const own = found.incoming_phone_numbers?.[0];
  if (own === undefined) throw new Error(`${number} is not a number on this Twilio account`);
  const path = `/IncomingPhoneNumbers/${own.sid}.json`;
  await twilio(path, { VoiceUrl: url, VoiceMethod: "POST" });
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await twilio(path, { VoiceUrl: own.voice_url ?? "", VoiceMethod: own.voice_method ?? "POST" });
    console.error(`restored ${number}'s voice webhook`);
  };
}

async function placeCall(agent, key, number, task) {
  const res = await fetch(new URL("/api/v1/calls", agent), {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({ phone_number: number, prompt: task }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = /** @type {{ id?: string }} */ (await res.json());
  if (res.status !== 201)
    throw new Error(`POST /api/v1/calls: ${res.status} ${JSON.stringify(body)}`);
  return body.id;
}

async function awaitCall(agent, key, id, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  let last;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const res = await fetch(new URL(`/api/v1/calls/${id}`, agent), {
      headers: { authorization: key },
      signal: AbortSignal.timeout(15_000),
    });
    last = /** @type {Record<string, any>} */ (await res.json());
    if (last.status === "completed" || last.status === "failed") return last;
  }
  return { ...last, error: `still ${last?.status ?? "unknown"} after ${timeoutS}s` };
}

// ── the report ──────────────────────────────────────────────────────────────

/** One line of the menu's side, or `undefined` for an event it does not print. */
function describeEvent(e) {
  switch (e.kind) {
    case "press":
      return `${e.node.padEnd(14)} decoded ${JSON.stringify(e.digits)} → ${e.next ?? "no such option, replayed"}`;
    case "no-input":
      return `${e.node.padEnd(14)} decoded nothing in ${GATHER_TIMEOUT_S}s, replayed`;
    case "leaf":
      return `reached ${e.node}${e.callSid ? `   (IVR leg ${e.callSid})` : ""}`;
    case "heard":
      return `heard the agent say: ${JSON.stringify(e.speech)}`;
    case "gave-up":
      return `hung up after ${MAX_PROMPTS} prompts at ${e.node}`;
    default:
      return;
  }
}

/** The keys the agent's transcript says it pressed — `press_keys` writes `[pressed …]`. */
const pressedIn = (transcript) =>
  transcript.flatMap((turn) => {
    const keys = /^\[pressed (.+)\]$/.exec(turn.text)?.[1];
    return keys === undefined ? [] : [keys];
  });

/** The verdict lines, and whether the run passed. */
function verdict(goal, events, pressed) {
  const sent = pressed.map(asDecoded).join("");
  const decoded = events
    .filter((e) => e.kind === "press")
    .map((e) => e.digits)
    .join("");
  const reached = events.find((e) => e.kind === "leaf")?.node;
  const goalOk = goal === undefined ? reached !== undefined : reached === goal;
  const keysOk = sent === decoded;
  const lines = [
    `${goalOk ? "✓" : "✗"} reached ${reached ?? "no leaf"}${goal ? ` (goal: ${goal})` : ""}`,
    keysOk
      ? `✓ every key the agent pressed reached the menu (${JSON.stringify(sent)})`
      : `✗ the agent pressed ${JSON.stringify(sent)} but the menu decoded ${JSON.stringify(decoded)} — ` +
        "tones lost or misread on the line (a barge-in cuts unplayed tones), not a wrong choice",
  ];
  if (keysOk && !goalOk)
    lines.push("→ the keys arrived; the model CHOSE wrong — that is the eval's subject");
  return { lines, ok: goalOk && keysOk };
}

/** Both sides of the call, and whether they agree. Returns the exit code. */
function report(scenario, events, record) {
  console.log("\nThe menu's side (what Twilio decoded):");
  for (const line of events.map(describeEvent)) if (line !== undefined) console.log(`  ${line}`);
  const transcript = record?.transcript ?? [];
  console.log("\nThe agent's side (its transcript):");
  for (const turn of transcript)
    console.log(`  ${turn.role === "agent" ? "agent " : "callee"}  ${turn.text}`);
  if (record?.error) console.log(`  error: ${record.error}`);
  const { lines, ok } = verdict(scenario.goal, events, pressedIn(transcript));
  console.log("\nVerdict:");
  for (const line of lines) console.log(`  ${line}`);
  return ok ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────

/** Serve the tree on localhost only — no tunnel, no Twilio, no call — to read the TwiML. */
async function serveOnly(scenario) {
  const token = "serve-only";
  let port = 0;
  const publicBase = () => `http://127.0.0.1:${port}`;
  const ivr = await startIvr({ tree: scenario.tree, token, human: values.human, publicBase });
  port = ivr.port;
  console.log(`serving on ${publicBase()}/node/${ivr.entry} (signature token "${token}")`);
}

/** A set, non-empty env var, or a throw naming it. */
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The flags a real call needs, checked before anything is borrowed. */
function callFlags() {
  const agent = requiredValue(values.agent, "--agent", SCRIPT);
  const ivrNumber = requiredValue(values["ivr-number"], "--ivr-number", SCRIPT);
  if (!E164_RE.test(ivrNumber)) throw new Error(`--ivr-number ${ivrNumber} is not E.164`);
  if (values.human !== undefined && !E164_RE.test(values.human)) {
    throw new Error(`--human ${values.human} is not E.164`);
  }
  return { agent, ivrNumber };
}

/** The whole run: serve, tunnel, borrow the number, call, report, restore. */
async function callThrough(scenario) {
  const { agent, ivrNumber } = callFlags();
  const token = requireEnv("TWILIO_AUTH_TOKEN");
  const twilio = twilioApi(requireEnv("TWILIO_ACCOUNT_SID"), token);
  const callsKey = requireEnv("CALLS_API_KEY");

  let publicUrl = "";
  const ivr = await startIvr({
    tree: scenario.tree,
    token,
    human: values.human,
    publicBase: () => publicUrl,
  });
  const tunnel = await openTunnel(ivr.port);
  publicUrl = tunnel.url;
  const restore = await borrowNumber(twilio, ivrNumber, `${publicUrl}/node/${ivr.entry}`);
  const shutdown = async (code) => {
    await restore().catch((err) => console.error(`could NOT restore ${ivrNumber}: ${err.message}`));
    tunnel.close();
    ivr.server.close();
    process.exit(code);
  };
  process.once("SIGINT", () => void shutdown(130));

  try {
    console.error(`IVR at ${publicUrl}, answering ${ivrNumber}`);
    const id = await placeCall(agent, callsKey, ivrNumber, scenario.task);
    console.error(`call ${id} placed; following it…`);
    const record = await awaitCall(agent, callsKey, id, Number(values.timeout));
    await shutdown(report(scenario, ivr.events, record));
  } catch (err) {
    console.error(`phone-tree-call: ${err instanceof Error ? err.message : err}`);
    await shutdown(1);
  }
}

const scenario = await loadScenario(requiredValue(values.scenario, "--scenario", SCRIPT));
await (values["serve-only"] ? serveOnly(scenario) : callThrough(scenario));
