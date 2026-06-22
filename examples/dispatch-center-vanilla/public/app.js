// Dispatch Command Center — vanilla browser client for the AssemblyAI Voice
// Agent API. No SDK, no framework, no bundler. This file:
//
//   1. mints a temporary token from our tiny token server (/token),
//   2. opens a WebSocket straight to wss://agents.assemblyai.com/v1/ws,
//   3. captures mic audio and streams it as base64 PCM16,
//   4. plays the agent's PCM16 audio back through an AudioWorklet,
//   5. executes tool calls locally and returns tool.result,
//   6. renders the conversation + dispatch dashboard with plain DOM.
//
// Everything the managed platform normally does server-side runs here in the
// browser instead — the only server piece is the token minter.

import { createKv } from "./dispatch.js";
import { GREETING, SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS, TOOL_SCHEMAS } from "./tools.js";

// The Voice Agent API defaults to audio/pcm at 24 kHz, PCM16 mono, in both
// directions — so we run the whole audio path at 24 kHz and skip resampling.
const SAMPLE_RATE = 24_000;
const AGENT_WS_URL = "wss://agents.assemblyai.com/v1/ws";
const VOICE = "david"; // deep, calming, conversational — fits a dispatcher

// ─── base64 <-> bytes (no library) ───────────────────────────────────────────

function uint8ToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Audio worklets (inline, as blob URLs) ────────────────────────────────────

const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.recording = false;
    const opts = options.processorOptions || {};
    this.fromRate = opts.contextRate || sampleRate;
    this.toRate = opts.targetRate || sampleRate;
    this.ratio = this.fromRate / this.toRate;
    this.needsResample = this.fromRate !== this.toRate;
    this.port.onmessage = (e) => {
      if (e.data.event === 'start') this.recording = true;
      else if (e.data.event === 'stop') this.recording = false;
    };
  }
  resample(input) {
    const ratio = this.ratio;
    const outLen = Math.ceil(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const idx = srcIdx | 0;
      const frac = srcIdx - idx;
      const a = input[idx];
      const b = idx + 1 < input.length ? input[idx + 1] : a;
      out[i] = a + frac * (b - a);
    }
    return out;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || !this.recording) return true;
    const raw = input[0];
    const samples = this.needsResample ? this.resample(raw) : raw;
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    this.port.postMessage({ event: 'chunk', buffer }, [buffer]);
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

const PLAYBACK_WORKLET = `
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.interrupted = false;
    this.isDone = false;
    this.playing = false;
    const rate = options.processorOptions?.sampleRate ?? 24000;
    this.jitterSamples = Math.floor(rate * 0.4);
    this.carry = null;
    this.samples = new Float32Array(rate * 60);
    this.writePos = 0;
    this.readPos = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.event === 'write') this.ingestBytes(d.buffer);
      else if (d.event === 'interrupt') { this.interrupted = true; }
      else if (d.event === 'done') this.isDone = true;
      else if (d.event === 'reset') {
        this.interrupted = false; this.isDone = false; this.playing = false;
        this.writePos = 0; this.readPos = 0; this.carry = null;
      }
    };
  }
  ingestBytes(uint8) {
    let bytes = uint8;
    if (this.carry !== null) {
      const merged = new Uint8Array(1 + bytes.length);
      merged[0] = this.carry; merged.set(bytes, 1);
      bytes = merged; this.carry = null;
    }
    if (bytes.length % 2 !== 0) {
      this.carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length === 0) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const numSamples = bytes.length / 2;
    for (let i = 0; i < numSamples; i++) {
      this.samples[this.writePos++] = view.getInt16(i * 2, true) / 0x8000;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (this.interrupted) { this.port.postMessage({ event: 'stopped' }); this.interrupted = false; out.fill(0); return true; }
    const avail = this.writePos - this.readPos;
    if (!this.playing) {
      if (avail >= this.jitterSamples || this.isDone) this.playing = true;
      else { out.fill(0); return true; }
    }
    if (avail > 0) {
      const n = Math.min(avail, out.length);
      out.set(this.samples.subarray(this.readPos, this.readPos + n));
      this.readPos += n;
      out.fill(0, n);
      return true;
    }
    out.fill(0);
    if (this.isDone) {
      this.isDone = false; this.playing = false; this.writePos = 0; this.readPos = 0;
      this.port.postMessage({ event: 'stopped' });
    }
    return true;
  }
}
registerProcessor('playback-processor', PlaybackProcessor);
`;

function blobUrl(src) {
  return URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
}

// ─── Session ──────────────────────────────────────────────────────────────────

class DispatchSession {
  constructor(ui) {
    this.ui = ui;
    this.kv = createKv();
    this.ws = null;
    this.ctx = null;
    this.stream = null;
    this.capNode = null;
    this.playNode = null;
    this.sessionReady = false;
    this.started = false;
    this.running = false;
    this.state = "idle";
    // Reply/tool lifecycle (mirrors the reference SessionCore).
    this.currentReplyId = null;
    this.pendingTools = [];
    this.toolChain = Promise.resolve();
  }

  setState(state) {
    this.state = state;
    this.ui.setState(state);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.setState("connecting");
    try {
      const token = await this.mintToken();
      await this.initAudio();
      this.openSocket(token);
    } catch (err) {
      this.ui.showError(String(err?.message || err), "start_failed");
      this.setState("idle");
      this.started = false;
    }
  }

  async mintToken() {
    const res = await fetch("/token");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Token request failed (${res.status}): ${text}`);
    }
    const { token } = await res.json();
    if (!token) throw new Error("Token server returned no token");
    return token;
  }

  async initAudio() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
    await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    await Promise.all([
      this.ctx.audioWorklet.addModule(blobUrl(CAPTURE_WORKLET)),
      this.ctx.audioWorklet.addModule(blobUrl(PLAYBACK_WORKLET)),
    ]);

    const mic = this.ctx.createMediaStreamSource(this.stream);
    this.capNode = new AudioWorkletNode(this.ctx, "capture-processor", {
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { contextRate: this.ctx.sampleRate, targetRate: SAMPLE_RATE },
    });
    mic.connect(this.capNode);
    this.capNode.port.onmessage = (e) => {
      if (e.data.event !== "chunk") return;
      if (!this.running || !this.sessionReady) return;
      this.sendAudio(new Uint8Array(e.data.buffer));
    };

    this.playNode = new AudioWorkletNode(this.ctx, "playback-processor", {
      processorOptions: { sampleRate: SAMPLE_RATE },
    });
    this.playNode.connect(this.ctx.destination);
  }

  openSocket(token) {
    const ws = new WebSocket(`${AGENT_WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            system_prompt: SYSTEM_PROMPT,
            greeting: GREETING,
            tools: TOOL_SCHEMAS,
            output: { voice: VOICE, format: { encoding: "audio/pcm" } },
            input: { format: { encoding: "audio/pcm" } },
          },
        }),
      );
    });

    ws.addEventListener("message", (ev) => this.onMessage(ev));

    ws.addEventListener("close", (ev) => {
      if (!this.sessionReady && this.started) {
        this.ui.showError(
          ev.code === 1008 ? "Unauthorized — check ASSEMBLYAI_API_KEY" : `Connection closed (code ${ev.code})`,
          "connection",
        );
      }
      this.teardown();
      this.setState("idle");
      this.started = false;
    });

    ws.addEventListener("error", () => {
      this.ui.showError("WebSocket error", "connection");
    });
  }

  onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "session.ready":
      case "session.updated":
        if (!this.sessionReady) {
          this.sessionReady = true;
          this.running = true;
          this.capNode?.port.postMessage({ event: "start" });
          this.setState("listening");
        }
        break;
      case "input.speech.started":
        // User barged in — drop any audio still playing.
        this.playNode?.port.postMessage({ event: "interrupt" });
        this.setState("listening");
        break;
      case "input.speech.stopped":
        break;
      case "transcript.user.delta":
        this.ui.setPartialTranscript(msg.text || "…");
        break;
      case "transcript.user":
        this.ui.setPartialTranscript(null);
        if (msg.text) this.ui.addMessage("user", msg.text);
        this.setState("thinking");
        break;
      case "reply.started":
        this.currentReplyId = msg.reply_id ?? "";
        this.setState("speaking");
        break;
      case "reply.audio":
        if (msg.data) {
          if (this.state !== "speaking") this.setState("speaking");
          const bytes = base64ToUint8(msg.data);
          this.playNode?.port.postMessage({ event: "write", buffer: bytes }, [bytes.buffer]);
        }
        break;
      case "transcript.agent":
        if (msg.text && !msg.interrupted) this.ui.addMessage("assistant", msg.text);
        break;
      case "tool.call":
        this.enqueueToolCall(msg);
        break;
      case "reply.done":
        void this.handleReplyDone(msg.status);
        break;
      case "session.error":
        this.ui.showError(msg.message || "Session error", msg.code || "error");
        break;
      case "error":
        this.ui.showError(msg.message || "Error", "error");
        break;
      default:
        break;
    }
  }

  // Tool calls are executed as they arrive but their results are BUFFERED —
  // the Voice Agent API requires that `tool.result` is sent only once
  // `reply.done` is the latest event (see handleReplyDone). Executions are
  // chained so they run in order, mirroring the reference SessionCore.
  enqueueToolCall(msg) {
    if (this.currentReplyId === null) return; // tool call with no active reply
    this.toolChain = this.toolChain.then(async () => {
      const tool = TOOLS[msg.name];
      let result;
      if (!tool) {
        result = { error: `Unknown tool: ${msg.name}` };
      } else {
        try {
          result = await tool.execute(msg.arguments ?? {}, this.toolCtx());
        } catch (err) {
          result = { error: String(err?.message || err) };
        }
      }
      this.pendingTools.push({ callId: msg.call_id, result: JSON.stringify(result) });
    });
  }

  toolCtx() {
    return { kv: this.kv, send: (event, data) => this.ui.onEvent(event, data) };
  }

  // A `reply.done` either (a) was interrupted, (b) closes a tool-call round —
  // flush buffered results and the agent speaks its answer next, or (c) ends
  // the turn for real. Only (c) hands control back to the mic.
  async handleReplyDone(status) {
    const replyId = this.currentReplyId;
    if (replyId === null) return; // duplicate / no active reply

    if (status === "interrupted") {
      this.pendingTools = [];
      this.currentReplyId = null;
      this.playNode?.port.postMessage({ event: "interrupt" });
      this.setState(this.running ? "listening" : "ready");
      return;
    }

    await this.toolChain; // let in-flight tool executions settle
    if (this.currentReplyId !== replyId) {
      this.pendingTools = [];
      return; // a newer reply superseded this one
    }

    if (this.pendingTools.length > 0) {
      for (const t of this.pendingTools) {
        this.send({ type: "tool.result", call_id: t.callId, result: t.result });
      }
      this.pendingTools = [];
      this.setState("thinking"); // agent will now speak its answer
    } else {
      this.currentReplyId = null;
      this.playNode?.port.postMessage({ event: "done" });
      this.setState(this.running ? "listening" : "ready");
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendAudio(bytes) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(`{"type":"input.audio","audio":"${uint8ToBase64(bytes)}"}`);
    }
  }

  toggle() {
    this.running = !this.running;
    if (this.running) {
      this.capNode?.port.postMessage({ event: "start" });
      this.setState("listening");
    } else {
      this.capNode?.port.postMessage({ event: "stop" });
      this.playNode?.port.postMessage({ event: "interrupt" });
      this.setState("ready");
    }
    this.ui.setRunning(this.running);
  }

  async reset() {
    this.teardown();
    this.started = false;
    this.state = "idle";
    await this.kv.clear();
    this.ui.reset();
  }

  teardown() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.sessionReady = false;
    this.running = false;
    this.currentReplyId = null;
    this.pendingTools = [];
    this.toolChain = Promise.resolve();
    try {
      this.capNode?.port.postMessage({ event: "stop" });
      this.stream?.getTracks().forEach((t) => t.stop());
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.capNode = null;
    this.playNode = null;
    this.stream = null;
    this.ctx = null;
  }
}

// ─── UI ─────────────────────────────────────────────────────────────────────

const alertColors = { green: "#22c55e", yellow: "#eab308", orange: "#f97316", red: "#ef4444" };
const severityColors = { critical: "#ef4444", urgent: "#f97316", moderate: "#eab308", minor: "#22c55e" };
const statusColors = {
  incoming: "#818cf8",
  triaged: "#a78bfa",
  dispatched: "#f59e0b",
  en_route: "#3b82f6",
  on_scene: "#22c55e",
  resolved: "#6b7280",
  escalated: "#ef4444",
};
const stateLabels = {
  idle: "STANDBY",
  connecting: "CONNECTING",
  ready: "READY",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "TRANSMITTING",
};
function stateColor(s) {
  return s === "listening" || s === "ready"
    ? "#22c55e"
    : s === "thinking"
      ? "#eab308"
      : s === "speaking"
        ? "#3b82f6"
        : "#6b7280";
}

class UI {
  constructor() {
    this.dash = { alertLevel: "green", incidents: {} };
    this.messages = [];
    this.render();
    this.session = new DispatchSession(this);
    this.wireControls();
  }

  el(id) {
    return document.getElementById(id);
  }

  render() {
    document.getElementById("app").innerHTML = `
      <div class="dc-header">
        <div class="dc-title">
          <span style="color:#3b82f6">&#9670;</span>
          Dispatch Command Center
          <span id="state-dot" class="dc-dot"></span>
          <span id="state-label" class="dc-state-label">STANDBY</span>
        </div>
        <div class="dc-alert-wrap">
          <span class="dc-alert-caption">SYSTEM ALERT:</span>
          <span id="alert-badge" class="dc-alert-badge">GREEN</span>
        </div>
      </div>
      <div class="dc-main">
        <div class="dc-feed-col">
          <div id="messages" class="dc-messages">
            <div id="empty" class="dc-empty">Dispatch Command Center standing by. Click START to begin operations.</div>
          </div>
          <div id="transcript-line" class="dc-transcript" style="display:none">
            <span class="dc-live-dot"></span><span id="transcript-text"></span>
          </div>
          <div id="error-line" class="dc-error" style="display:none"></div>
          <div class="dc-controls">
            <div id="controls-inner"></div>
            <div style="flex:1"></div>
            <span id="incident-count" class="dc-count">0 incidents logged</span>
          </div>
        </div>
        <div class="dc-sidebar">
          <div class="dc-panel">
            <div class="dc-panel-title">Operations Summary</div>
            <div class="dc-stat"><span>Active Incidents</span><span id="stat-active">0</span></div>
            <div class="dc-stat"><span>Resolved</span><span id="stat-resolved" style="color:#22c55e">0</span></div>
            <div class="dc-stat"><span>Total Logged</span><span id="stat-total">0</span></div>
          </div>
          <div class="dc-panel">
            <div class="dc-panel-title">Active Incidents</div>
            <div id="active-incidents"><div class="dc-none">No active incidents</div></div>
          </div>
          <div class="dc-panel">
            <div class="dc-panel-title">Severity Legend</div>
            ${Object.entries(severityColors)
              .map(
                ([sev, color]) =>
                  `<div class="dc-legend"><span class="dc-swatch" style="background:${color}"></span><span>${sev}</span></div>`,
              )
              .join("")}
          </div>
          <div class="dc-panel">
            <div class="dc-panel-title">Training Scenarios</div>
            <div class="dc-hint">Say "run mass casualty scenario" or "simulate active shooter" to test dispatch operations with complex multi-incident drills.</div>
          </div>
        </div>
      </div>`;
    this.renderControls();
  }

  renderControls() {
    const started = this.session?.started;
    const running = this.session?.running;
    const inner = this.el("controls-inner");
    if (!started) {
      inner.innerHTML = `<button id="btn-start" class="dc-btn dc-btn-primary">Start Dispatch</button>`;
      this.el("btn-start").onclick = () => this.session.start();
    } else {
      inner.innerHTML = `
        <button id="btn-toggle" class="dc-btn ${running ? "dc-btn-muted" : "dc-btn-primary"}">${running ? "Pause" : "Resume"}</button>
        <button id="btn-reset" class="dc-btn dc-btn-danger">Reset</button>`;
      this.el("btn-toggle").onclick = () => this.session.toggle();
      this.el("btn-reset").onclick = () => this.session.reset();
    }
  }

  wireControls() {
    this.renderControls();
  }

  setState(state) {
    this.el("state-dot").style.background = stateColor(state);
    this.el("state-dot").style.animation =
      state === "listening"
        ? "dc-pulse 1.5s ease-in-out infinite"
        : state === "thinking"
          ? "dc-pulse 0.8s ease-in-out infinite"
          : "none";
    this.el("state-label").textContent = stateLabels[state] || state.toUpperCase();
    this.renderControls();
  }

  setRunning() {
    this.renderControls();
  }

  // Partial user transcript (transcript.user.delta) — flashed in the live line
  // until the final transcript.user arrives. Pass null to hide.
  setPartialTranscript(text) {
    const line = this.el("transcript-line");
    if (text == null) {
      line.style.display = "none";
      return;
    }
    line.style.display = "flex";
    this.el("transcript-text").textContent = text;
  }

  addMessage(role, content) {
    this.el("empty")?.remove();
    this.messages.push({ role, content });
    const div = document.createElement("div");
    div.className = `dc-msg dc-msg-${role}`;
    div.innerHTML = `<div class="dc-msg-role">${role === "assistant" ? "DISPATCH" : "OPERATOR"}</div>${escapeHtml(content)}`;
    this.el("messages").insertBefore(div, this.el("transcript-line"));
    const m = this.el("messages");
    m.scrollTop = m.scrollHeight;
  }

  showError(message, code) {
    const line = this.el("error-line");
    line.style.display = "block";
    line.textContent = `ERROR: ${message} (${code})`;
  }

  // Tool "send" events flow here (mirrors the template's useEvent("incidents")).
  onEvent(event, result) {
    if (event !== "incidents") return;
    const r = result || {};
    if (r.state) {
      this.dash.alertLevel = r.state.alertLevel;
      for (const inc of Object.values(r.state.incidents)) {
        this.dash.incidents[inc.id] = {
          id: inc.id,
          severity: inc.severity,
          status: inc.status,
          location: inc.location,
        };
      }
    } else if (r.incident) {
      this.dash.incidents[r.incident.id] = {
        ...this.dash.incidents[r.incident.id],
        id: r.incident.id,
        severity: r.incident.severity,
        status: r.incident.status,
        location: r.incident.location,
      };
    }
    if (r.systemAlertLevel) this.dash.alertLevel = r.systemAlertLevel;
    this.renderDashboard();
  }

  renderDashboard() {
    const list = Object.values(this.dash.incidents).reverse();
    const active = list.filter((i) => i.status !== "resolved");
    const resolved = list.filter((i) => i.status === "resolved").length;

    const alert = this.dash.alertLevel;
    const badge = this.el("alert-badge");
    badge.textContent = alert.toUpperCase();
    badge.style.background = alertColors[alert] || "#6b7280";
    badge.style.color = alert === "yellow" ? "#000" : "#fff";
    badge.style.animation = alert === "red" ? "dc-pulse 1s ease-in-out infinite" : "none";

    this.el("stat-active").textContent = String(active.length);
    this.el("stat-active").style.color = active.length > 3 ? "#ef4444" : "#e2e8f0";
    this.el("stat-resolved").textContent = String(resolved);
    this.el("stat-total").textContent = String(list.length);
    this.el("incident-count").textContent = `${list.length} incident${list.length !== 1 ? "s" : ""} logged`;

    const container = this.el("active-incidents");
    if (active.length === 0) {
      container.innerHTML = `<div class="dc-none">No active incidents</div>`;
      return;
    }
    container.innerHTML = active
      .map((inc) => {
        const color = severityColors[inc.severity] || "#334155";
        return `
        <div class="dc-incident" style="border:1px solid ${color}40;border-left:3px solid ${color}">
          <div class="dc-incident-head">
            <span class="dc-incident-id">${inc.id}</span>
            ${inc.severity ? `<span class="dc-incident-sev" style="background:${color}30;color:${color}">${inc.severity}</span>` : ""}
          </div>
          ${inc.location ? `<div class="dc-incident-loc">${escapeHtml(inc.location)}</div>` : ""}
          ${inc.status ? `<div class="dc-incident-status" style="color:${statusColors[inc.status] || "#6b7280"}">${inc.status.replace("_", " ")}</div>` : ""}
        </div>`;
      })
      .join("");
  }

  reset() {
    this.dash = { alertLevel: "green", incidents: {} };
    this.messages = [];
    this.render();
    this.el("error-line").style.display = "none";
    this.renderDashboard();
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

new UI();
