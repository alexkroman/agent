// Copyright 2025 the AAI authors. MIT license.
// Entry: API-key gate, then the studio app under a QueryClientProvider.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
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
    <div className="flex h-full items-center justify-center">
      <div className="flex w-96 flex-col gap-2.5 rounded-xl border border-line bg-panel p-7">
        <h1 className="m-0 mb-1 text-lg font-semibold">
          <span className="text-accent">AAI</span> Studio
        </h1>
        <p className="m-0 text-[13px] text-dim">
          Build and deploy voice agents from your browser, with a coding agent doing the typing.
          Enter your platform API key to start.
        </p>
        <input
          className="field"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") enter();
          }}
          placeholder="API key"
          spellCheck={false}
        />
        <button type="button" className="btn btn-primary" onClick={enter}>
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
