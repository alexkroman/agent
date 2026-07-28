// Copyright 2025 the AAI authors. MIT license.
/** Inline client script for the studio page (vanilla JS, no build step). */

export const STUDIO_JS = `
"use strict";
const $ = (id) => document.getElementById(id);
const state = { key: localStorage.getItem("aai-studio-key") || "", project: null, files: {}, current: null, chat: [], busy: false };

function headers(json) {
  const h = { Authorization: "Bearer " + state.key };
  if (json) h["Content-Type"] = "application/json";
  return h;
}
async function api(path, opts = {}) {
  const res = await fetch("/studio" + path, { ...opts, headers: { ...headers(opts.body != null), ...(opts.headers || {}) } });
  if (res.status === 401) { enterGate(); throw new Error("Unauthorized"); }
  return res;
}

// ── Gate (API key entry) ─────────────────────────────────────────────
function enterGate() { $("gate").classList.remove("hidden"); }
async function leaveGate() {
  state.key = $("gate-key").value.trim();
  if (!state.key) return;
  localStorage.setItem("aai-studio-key", state.key);
  $("gate").classList.add("hidden");
  await refreshProjects();
}

// ── Projects ─────────────────────────────────────────────────────────
async function refreshProjects() {
  const res = await api("/projects");
  const { projects } = await res.json();
  const box = $("projects");
  box.textContent = "";
  for (const name of projects) {
    const b = document.createElement("button");
    b.textContent = name;
    if (name === state.project) b.classList.add("active");
    b.onclick = () => openProject(name);
    box.appendChild(b);
  }
  if (!state.project && projects.length) await openProject(projects[0]);
}
async function createProject() {
  const name = $("new-project").value.trim();
  if (!name) return;
  const res = await api("/projects", { method: "POST", body: JSON.stringify({ name }) });
  if (!res.ok) { alert((await res.json()).error || "Failed to create project"); return; }
  $("new-project").value = "";
  state.project = name;
  await refreshProjects();
  await openProject(name);
}
async function openProject(name) {
  const res = await api("/projects/" + encodeURIComponent(name));
  if (!res.ok) return;
  const data = await res.json();
  state.project = name;
  state.files = data.files;
  state.current = "agent.ts" in data.files ? "agent.ts" : Object.keys(data.files)[0] || null;
  state.chat = [];
  $("chat-log").textContent = "";
  renderDeployed(data.deployedSlug);
  renderTabs();
  await refreshProjects();
}

// ── Editor ───────────────────────────────────────────────────────────
function renderTabs() {
  const tabs = $("tabs");
  tabs.textContent = "";
  for (const path of Object.keys(state.files).sort()) {
    const b = document.createElement("button");
    b.textContent = path;
    if (path === state.current) b.classList.add("active");
    b.onclick = () => { state.current = path; renderTabs(); };
    tabs.appendChild(b);
  }
  $("editor").value = state.current ? state.files[state.current] : "";
  $("editor").disabled = !state.current;
  $("file-name").textContent = state.current || "";
}
async function saveFile() {
  if (!state.current || !state.project) return;
  state.files[state.current] = $("editor").value;
  const res = await api("/projects/" + encodeURIComponent(state.project) + "/file", {
    method: "PUT",
    body: JSON.stringify({ path: state.current, content: $("editor").value }),
  });
  $("save-status").textContent = res.ok ? "saved" : "save failed";
  setTimeout(() => { $("save-status").textContent = ""; }, 1500);
}

// ── Deploy ───────────────────────────────────────────────────────────
function parseSecrets() {
  const env = {};
  for (const line of $("deploy-secrets").value.split("\\n")) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
function renderDeployed(slug) {
  const box = $("deploy-result");
  box.textContent = "";
  if (!slug) return;
  const a = document.createElement("a");
  a.href = "/" + slug + "/";
  a.target = "_blank";
  a.textContent = "Live: /" + slug + "/";
  box.appendChild(a);
}
async function deployNow() {
  if (!state.project || state.busy) return;
  const btn = $("deploy-btn");
  btn.disabled = true;
  btn.textContent = "Deploying…";
  try {
    const res = await api("/projects/" + encodeURIComponent(state.project) + "/deploy", {
      method: "POST",
      body: JSON.stringify({ env: parseSecrets() }),
    });
    const data = await res.json();
    if (res.ok) renderDeployed(data.slug);
    else { $("deploy-result").textContent = data.error || "Deploy failed"; }
  } finally {
    btn.disabled = false;
    btn.textContent = "Build & Deploy";
  }
}

// ── Chat ─────────────────────────────────────────────────────────────
function addMsg(cls, text) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  $("chat-log").appendChild(div);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return div;
}
async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !state.project || state.busy) return;
  input.value = "";
  state.busy = true;
  $("chat-send").disabled = true;
  state.chat.push({ role: "user", content: text });
  addMsg("user", text);
  let reply = "";
  let replyEl = null;
  try {
    const res = await api("/chat", {
      method: "POST",
      body: JSON.stringify({ project: state.project, messages: state.chat }),
    });
    if (!res.ok) { addMsg("error", (await res.json()).error || ("Chat failed: " + res.status)); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        handleEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    addMsg("error", String(err));
  } finally {
    if (reply) state.chat.push({ role: "assistant", content: reply });
    state.busy = false;
    $("chat-send").disabled = false;
    if (state.project) await openProject(state.project);
  }
  function handleEvent(ev) {
    if (ev.type === "text") {
      reply += ev.text;
      if (!replyEl) replyEl = addMsg("assistant", "");
      replyEl.textContent = reply;
      $("chat-log").scrollTop = $("chat-log").scrollHeight;
    } else if (ev.type === "tool_call") {
      addMsg("tool", "→ " + ev.name + " " + JSON.stringify(ev.input));
      replyEl = null;
      if (reply) { state.chat.push({ role: "assistant", content: reply }); reply = ""; }
    } else if (ev.type === "tool_result") {
      const out = typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output);
      addMsg("tool", "← " + out.slice(0, 400));
    } else if (ev.type === "error") {
      addMsg("error", ev.message);
    }
  }
}

// ── Wiring ───────────────────────────────────────────────────────────
$("gate-go").onclick = leaveGate;
$("gate-key").addEventListener("keydown", (e) => { if (e.key === "Enter") leaveGate(); });
$("new-project-btn").onclick = createProject;
$("new-project").addEventListener("keydown", (e) => { if (e.key === "Enter") createProject(); });
$("save-btn").onclick = saveFile;
$("editor").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveFile(); }
});
$("deploy-btn").onclick = deployNow;
$("chat-send").onclick = sendChat;
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
fetch("/studio/status").then((r) => r.json()).then(({ llm }) => {
  if (!llm) {
    $("chat-input").placeholder = "Chat disabled: server has no ANTHROPIC_API_KEY";
    $("chat-input").disabled = true;
    $("chat-send").disabled = true;
  }
}).catch(() => {});
if (state.key) { $("gate").classList.add("hidden"); refreshProjects().catch(() => enterGate()); }
`;
