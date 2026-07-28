// Copyright 2025 the AAI authors. MIT license.
/** Inline stylesheet for the studio page (single-file, no build step). */

export const STUDIO_CSS = `
:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3;
  --muted: #8b949e; --accent: #2f81f7; --accent-2: #238636; --err: #f85149;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--text);
  font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  display: flex; flex-direction: column;
}
header {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px;
  border-bottom: 1px solid var(--border); background: var(--panel);
}
header h1 { font-size: 15px; margin: 0; font-weight: 600; }
header h1 span { color: var(--accent); }
header .spacer { flex: 1; }
input, textarea, button, select {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 10px; font-size: 13px;
}
textarea { font-family: var(--mono); resize: none; }
button { cursor: pointer; background: var(--panel); }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }
button:disabled { opacity: 0.5; cursor: default; }
main { flex: 1; display: flex; min-height: 0; }
main > * { min-height: 0; }
#sidebar {
  width: 200px; border-right: 1px solid var(--border); background: var(--panel);
  display: flex; flex-direction: column; padding: 10px; gap: 8px;
}
#sidebar h2, #right h2 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted); margin: 4px 0 2px;
}
#projects { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
#projects button {
  text-align: left; border: none; background: none; padding: 5px 8px; border-radius: 6px;
}
#projects button.active { background: var(--accent); color: #fff; }
.row { display: flex; gap: 6px; }
.row input { flex: 1; min-width: 0; }
#editor-pane { flex: 1.3; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
#tabs { display: flex; gap: 4px; padding: 8px 8px 0; flex-wrap: wrap; }
#tabs button { border-radius: 6px 6px 0 0; border-bottom: none; font-family: var(--mono); font-size: 12px; }
#tabs button.active { background: var(--bg); border-color: var(--accent); }
#editor { flex: 1; margin: 0 8px 8px; border-radius: 0 6px 6px 6px; padding: 12px; }
#editor-bar { display: flex; gap: 8px; padding: 0 8px 8px; align-items: center; }
#editor-bar .status { color: var(--muted); font-size: 12px; }
#right { flex: 1; display: flex; flex-direction: column; padding: 10px; gap: 8px; }
#chat-log {
  flex: 1; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px;
  padding: 10px; display: flex; flex-direction: column; gap: 8px; background: var(--panel);
}
.msg { white-space: pre-wrap; word-break: break-word; }
.msg.user { color: var(--accent); }
.msg.user::before { content: "you  "; color: var(--muted); font-family: var(--mono); font-size: 11px; }
.msg.assistant::before { content: "agent  "; color: var(--muted); font-family: var(--mono); font-size: 11px; }
.msg.tool { color: var(--muted); font-family: var(--mono); font-size: 12px; }
.msg.error { color: var(--err); }
#deploy-box { border: 1px solid var(--border); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
#deploy-secrets { height: 52px; font-size: 12px; }
#deploy-result a { color: var(--accent); }
#deploy-result { font-size: 13px; min-height: 18px; }
#gate {
  position: fixed; inset: 0; background: var(--bg); display: flex;
  align-items: center; justify-content: center; flex-direction: column; gap: 12px;
}
#gate .card {
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 28px; width: 380px; display: flex; flex-direction: column; gap: 10px;
}
#gate h1 { margin: 0 0 4px; font-size: 18px; }
#gate p { margin: 0; color: var(--muted); font-size: 13px; }
.hidden { display: none !important; }
`;
