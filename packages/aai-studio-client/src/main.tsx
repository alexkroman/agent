// Copyright 2025 the AAI authors. MIT license.
// Entry: API-key gate, then the studio app under a QueryClientProvider.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import logoUrl from "./assets/assemblyai-logomark.svg";
import { isEnterSubmit } from "./send-button.tsx";
import "./styles.css";

// The platform API key is the caller's full account credential (it is also
// their AssemblyAI key). Deployed tenant agents are served from the *same web
// origin* as the studio (`/:slug/`), and that HTML/JS is attacker-controlled.
// `sessionStorage` (not `localStorage`) limits the blast radius: the key never
// persists across restarts and is unreadable from a separately-opened tab, so
// a phishing link to a malicious agent page cannot read a studio user's key.
//
// It does NOT protect against the studio's own Live pane: the preview iframes
// `/:slug/` same-origin (preview.tsx), and a same-origin iframe shares this
// tab's sessionStorage and can script the parent, so a hostile published
// client.tsx owns the studio session regardless of where the key lives.
// Sandboxing that iframe without `allow-same-origin` would close this but
// gives the frame an opaque origin, which blocks getUserMedia — the pane's
// whole purpose. The complete fix is serving tenant agent pages from a
// dedicated origin; until then the preview trusts the user's own published
// agent and nothing else is ever framed.
const KEY_STORAGE = "aai-studio-key";
const keyStore: Storage = sessionStorage;
const queryClient = new QueryClient();

// Storage access throws in some contexts (Safari private mode, storage blocked
// by policy) — degrade to a session-only key instead of crashing.
function readStoredKey(): string {
  try {
    return keyStore.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function writeStoredKey(key: string | null): void {
  try {
    if (key === null) keyStore.removeItem(KEY_STORAGE);
    else keyStore.setItem(KEY_STORAGE, key);
  } catch {
    // Storage unavailable — the key still lives in component state for this tab.
  }
}

function Gate({ onEnter }: { onEnter: (key: string) => void }) {
  const [draft, setDraft] = useState("");
  const enter = () => {
    const key = draft.trim();
    if (key) onEnter(key);
  };
  return (
    <div className="flex h-full items-center justify-center bg-cream">
      <div className="flex w-[420px] flex-col gap-3.5 rounded-lg border border-line bg-panel p-10 shadow-sm">
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="AssemblyAI" className="h-5 w-5" />
          <span className="font-serif text-[16px]">AssemblyAI App Builder</span>
        </div>
        <h1 className="m-0 font-serif text-[26px] leading-[1.18] font-normal text-balance">
          Build your first voice agent
        </h1>
        <p className="m-0 text-[15px] leading-[21px] text-muted">
          Describe a voice agent and App Builder writes and tests it — you publish when it's ready.
          Enter your platform API key to start.
        </p>
        <input
          className="field h-10"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isEnterSubmit(e)) enter();
          }}
          placeholder="API key"
          spellCheck={false}
        />
        <button type="button" className="btn btn-primary h-10 self-start px-5" onClick={enter}>
          Open App Builder
        </button>
      </div>
    </div>
  );
}

function Root() {
  const [apiKey, setApiKey] = useState(readStoredKey);

  if (!apiKey) {
    return (
      <Gate
        onEnter={(key) => {
          writeStoredKey(key);
          setApiKey(key);
        }}
      />
    );
  }

  return (
    <App
      apiKey={apiKey}
      onSignOut={() => {
        writeStoredKey(null);
        setApiKey("");
        // Query keys don't carry the API key, so cached projects/files from
        // this key must not survive into the next one entered.
        queryClient.clear();
      }}
    />
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Studio shell is missing its #root element");
createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
);
