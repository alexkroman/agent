// Copyright 2025 the AAI authors. MIT license.
/**
 * The studio page served at `GET /` — a self-contained HTML document (inline
 * CSS + JS, no build step, no external resources) hosting the browser coding
 * agent: project sidebar, file editor, chat with the agent, and a
 * build-and-deploy panel.
 */

import { STUDIO_CSS } from "./studio-page-css.ts";
import { STUDIO_JS } from "./studio-page-js.ts";

/**
 * Everything is inline and same-origin, so the policy allows exactly that
 * and nothing else.
 */
export const STUDIO_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

export function studioPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AAI Studio</title>
<style>${STUDIO_CSS}</style>
</head>
<body>
<header>
  <h1><span>AAI</span> Studio</h1>
  <div class="spacer"></div>
</header>
<main>
  <div id="sidebar">
    <h2>Projects</h2>
    <div id="projects"></div>
    <div class="row">
      <input id="new-project" placeholder="new-project-name" spellcheck="false">
      <button id="new-project-btn" title="Create project">+</button>
    </div>
  </div>
  <div id="editor-pane">
    <div id="tabs"></div>
    <textarea id="editor" spellcheck="false" disabled></textarea>
    <div id="editor-bar">
      <button id="save-btn">Save</button>
      <span class="status" id="file-name"></span>
      <span class="status" id="save-status"></span>
    </div>
  </div>
  <div id="right">
    <h2>Coding agent</h2>
    <div id="chat-log"></div>
    <div class="row">
      <input id="chat-input" placeholder="Describe the voice agent you want to build…">
      <button id="chat-send" class="primary">Send</button>
    </div>
    <div id="deploy-box">
      <h2>Deploy</h2>
      <textarea id="deploy-secrets" placeholder="Secrets, one per line: ASSEMBLYAI_API_KEY=..." spellcheck="false"></textarea>
      <div class="row">
        <button id="deploy-btn" class="primary">Build &amp; Deploy</button>
        <div id="deploy-result"></div>
      </div>
    </div>
  </div>
</main>
<div id="gate">
  <div class="card">
    <h1><span style="color:#2f81f7">AAI</span> Studio</h1>
    <p>Build and deploy voice agents from your browser, with a coding agent doing the typing. Enter your platform API key to start.</p>
    <input id="gate-key" type="password" placeholder="API key" spellcheck="false">
    <button id="gate-go" class="primary">Open Studio</button>
  </div>
</div>
<script>${STUDIO_JS}</script>
</body>
</html>`;
}
