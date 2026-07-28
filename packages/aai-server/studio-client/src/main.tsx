// Copyright 2025 the AAI authors. MIT license.
// Entry: API-key gate, then the studio app under a QueryClientProvider.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import logoUrl from "./assets/assemblyai-logomark.svg";
import "./styles.css";

const KEY_STORAGE = "aai-studio-key";
const queryClient = new QueryClient();

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
          <span className="font-serif text-[17px]">AAI Studio</span>
        </div>
        <h1 className="m-0 font-serif text-[27px] leading-[1.18] font-normal text-balance">
          Build your first voice agent
        </h1>
        <p className="m-0 text-[15px] leading-[22px] text-muted">
          Describe an agent and the studio writes and tests it — you publish when it's ready. Enter
          your platform API key to start.
        </p>
        <input
          className="field h-10"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") enter();
          }}
          placeholder="API key"
          spellCheck={false}
        />
        <button type="button" className="btn btn-primary h-10 self-start px-5" onClick={enter}>
          Open Studio
        </button>
      </div>
    </div>
  );
}

function Root() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? "");

  if (!apiKey) {
    return (
      <Gate
        onEnter={(key) => {
          localStorage.setItem(KEY_STORAGE, key);
          setApiKey(key);
        }}
      />
    );
  }

  return (
    <App
      apiKey={apiKey}
      onSignOut={() => {
        localStorage.removeItem(KEY_STORAGE);
        setApiKey("");
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
