// Copyright 2026 the AAI authors. MIT license.
/**
 * The console for the calls API: write a task, place the call, and watch the
 * transcript come back.
 *
 * Mounted with `mountPage()`: nobody talks to this agent from the browser —
 * it talks on the phone — so the page opens no session and asks for no
 * microphone. It is one more caller of `/api/v1/calls`, written against the
 * same contract (`api-types.ts`) the curl example is.
 *
 * ## Why it fetches by hand
 *
 * Every route checks `Authorization` (see `api.ts`), and `routeFetch` /
 * `useRoute` send no headers. So {@link callsApi} is the same few lines with
 * the header added: resolve `api/…` against the page's DIRECTORY (an agent
 * served below `/:slug/` reaches its own `/:slug/api`), send JSON, and turn a
 * failure into the route's own `{ error }` sentence.
 *
 * The key is kept in `localStorage` so a reload does not ask again; a browser
 * that refuses storage just asks each time.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { mountPage } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
import { type ReactNode, type SyntheticEvent, useCallback, useEffect, useState } from "react";
import type { CallList, CallRecord } from "./api-types.ts";

const KEY_STORAGE = "outbound-caller.api-key";

/** How often the open call is re-read while it is still going. */
const LIVE_POLL_MS = 1500;

/** How often the list is re-read. */
const LIST_POLL_MS = 5000;

const EXAMPLE_PROMPT =
  "Call Maria for Mission Dental to confirm her cleaning tomorrow at 2:30pm. " +
  "If she needs to reschedule, offer Thursday at 10am or Friday at 4pm. " +
  "If you get voicemail, ask her to call 415-555-0100.";

function readStoredKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function storeKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Storage refused (a private window): the key lives for this page only.
  }
}

/** One call to the agent's own `/api` routes, with the API key attached. */
async function callsApi<T>(
  method: "GET" | "POST",
  path: string,
  key: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(`api${path}`, new URL(".", window.location.href));
  // Every request carries a content type, so a GET and a POST build one way.
  const res = await fetch(url, {
    method,
    headers: { authorization: key, "content-type": "application/json" },
    ...omitUndefined({ body: body === undefined ? undefined : JSON.stringify(body) }),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const said = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
    throw new Error(said ?? `${method} ${path}: ${res.status}`);
  }
  return json as T;
}

function isFinished(call: CallRecord | undefined): boolean {
  return call?.status === "completed" || call?.status === "failed";
}

/** A pill for where a call is, or how it went once it is over. */
function StatusPill({ call }: { call: CallRecord }): ReactNode {
  const label = call.status === "completed" ? (call.outcome ?? "completed") : call.status;
  const live = call.status === "in-progress";
  const bad = call.status === "failed" || call.outcome === "failed";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs ${
        live
          ? "border-aai-primary text-aai-primary"
          : bad
            ? "border-red-500 text-red-500"
            : "border-aai-border text-aai-text opacity-80"
      }`}
    >
      {live ? "live" : label}
    </span>
  );
}

function Transcript({ call }: { call: CallRecord }): ReactNode {
  if (call.transcript.length === 0) {
    return (
      <p className="text-sm opacity-60">
        {isFinished(call) ? "Nothing was said on this call." : "Waiting for the call to connect…"}
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {call.transcript.map((turn, i) => (
        // Lines only ever append, so the index is a stable key.
        <li key={i} className={`flex ${turn.role === "agent" ? "justify-start" : "justify-end"}`}>
          <div
            className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
              turn.role === "agent" ? "bg-aai-surface text-aai-text" : "bg-aai-primary text-aai-bg"
            }`}
          >
            <span className="block text-xs opacity-70">
              {turn.role === "agent" ? "Agent" : "Callee"}
            </span>
            {turn.text}
          </div>
        </li>
      ))}
    </ol>
  );
}

function CallDetail({ id, apiKey }: { id: string; apiKey: string }): ReactNode {
  const [call, setCall] = useState<CallRecord | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const finished = isFinished(call);

  useEffect(() => {
    setCall(undefined);
    setError(undefined);
  }, [id]);

  useEffect(() => {
    if (finished) return;
    let stopped = false;
    const read = () =>
      callsApi<CallRecord>("GET", `/v1/calls/${encodeURIComponent(id)}`, apiKey)
        .then((answer) => {
          if (!stopped) setCall(answer);
        })
        .catch((err: unknown) => {
          if (!stopped) setError(err instanceof Error ? err.message : String(err));
        });
    void read();
    const timer = setInterval(() => void read(), LIVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, apiKey, finished]);

  if (error !== undefined) return <p className="text-sm text-red-500">{error}</p>;
  if (call === undefined) return <p className="text-sm opacity-60">Loading…</p>;
  return (
    <article className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-lg">{call.phone_number}</h2>
        <StatusPill call={call} />
        {call.duration_seconds !== undefined && (
          <span className="text-sm opacity-70">{call.duration_seconds}s</span>
        )}
        <span className="ml-auto font-mono text-xs opacity-60">{call.id}</span>
      </header>
      {call.error !== undefined && <p className="text-sm text-red-500">{call.error}</p>}
      {call.summary !== undefined && (
        <section className="rounded-lg border border-aai-border p-3">
          <h3 className="mb-1 text-xs uppercase opacity-60">Summary</h3>
          <p className="text-pretty text-sm leading-relaxed">{call.summary}</p>
        </section>
      )}
      <Transcript call={call} />
      {finished && (
        <details className="text-xs">
          <summary className="cursor-pointer opacity-70">Raw JSON</summary>
          <pre className="aai-scroll mt-2 overflow-x-auto rounded-md bg-aai-surface p-3">
            {JSON.stringify(call, null, 2)}
          </pre>
        </details>
      )}
    </article>
  );
}

function NewCall({
  apiKey,
  onPlaced,
}: {
  apiKey: string;
  onPlaced: (call: CallRecord) => void;
}): ReactNode {
  const [phone, setPhone] = useState("");
  const [prompt, setPrompt] = useState(EXAMPLE_PROMPT);
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const placed = await callsApi<CallRecord>("POST", "/v1/calls", apiKey, {
        phone_number: phone.trim(),
        prompt,
        ...(webhook.trim() === "" ? {} : { webhook_url: webhook.trim() }),
      });
      onPlaced(placed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded-md border border-aai-border bg-aai-bg px-3 py-2 text-sm text-aai-text";
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Phone number
        <input
          className={`${input} font-mono`}
          type="tel"
          required
          placeholder="+14155550132"
          pattern="\+[1-9][0-9]{6,14}"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        What should the agent do on this call?
        <textarea
          className={`${input} min-h-32 leading-relaxed`}
          required
          maxLength={4000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Webhook URL (optional)
        <input
          className={input}
          type="url"
          placeholder="https://example.com/hooks/calls"
          value={webhook}
          onChange={(event) => setWebhook(event.target.value)}
        />
      </label>
      {error !== undefined && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || apiKey === ""}
        className="self-start rounded-md bg-aai-primary px-4 py-2 text-sm text-aai-bg disabled:opacity-50"
      >
        {busy ? "Placing…" : "Place call"}
      </button>
    </form>
  );
}

function CallsList({
  apiKey,
  selected,
  onSelect,
  refresh,
}: {
  apiKey: string;
  selected: string | undefined;
  onSelect: (id: string) => void;
  refresh: number;
}): ReactNode {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  // `refresh` is a dependency on purpose: placing a call bumps it, so the new
  // call shows without waiting for the next poll.
  useEffect(() => {
    if (apiKey === "") return;
    let stopped = false;
    const read = () =>
      callsApi<CallList>("GET", "/v1/calls", apiKey)
        .then((answer) => {
          if (stopped) return;
          setCalls(answer.calls);
          setError(undefined);
        })
        .catch((err: unknown) => {
          if (!stopped) setError(err instanceof Error ? err.message : String(err));
        });
    void read();
    const timer = setInterval(() => void read(), LIST_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [apiKey, refresh]);

  if (error !== undefined) return <p className="text-sm text-red-500">{error}</p>;
  if (calls.length === 0) return <p className="text-sm opacity-60">No calls yet.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {calls.map((call) => (
        <li key={call.id}>
          <button
            type="button"
            onClick={() => onSelect(call.id)}
            className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
              call.id === selected ? "border-aai-primary" : "border-aai-border"
            }`}
          >
            <span className="font-mono">{call.phone_number}</span>
            <StatusPill call={call} />
            <span className="ml-auto text-xs opacity-60">
              {new Date(call.created_at).toLocaleTimeString()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function App(): ReactNode {
  const [apiKey, setApiKey] = useState(readStoredKey);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);

  const saveKey = useCallback((key: string) => {
    setApiKey(key);
    storeKey(key);
  }, []);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 bg-aai-bg p-4 text-aai-text md:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-balance text-2xl">Outbound Caller</h1>
        <p className="text-pretty text-sm opacity-70">
          Give the agent a number and a task. It places the call, carries out the task, and the
          transcript appears here as the conversation happens.
        </p>
      </header>

      <label className="flex flex-col gap-1 text-sm md:max-w-md">
        API key (the agent's <code>CALLS_API_KEY</code>)
        <input
          className="rounded-md border border-aai-border bg-aai-bg px-3 py-2 font-mono text-sm text-aai-text"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => saveKey(event.target.value)}
        />
      </label>

      <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="flex flex-col gap-6">
          <div className="rounded-lg border border-aai-border bg-aai-surface p-4">
            <h2 className="mb-3 text-lg">New call</h2>
            <NewCall
              apiKey={apiKey}
              onPlaced={(call) => {
                setSelected(call.id);
                setRefresh((n) => n + 1);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-lg">Recent calls</h2>
            {apiKey === "" ? (
              <p className="text-sm opacity-60">Enter the API key to see calls.</p>
            ) : (
              <CallsList
                apiKey={apiKey}
                selected={selected}
                onSelect={setSelected}
                refresh={refresh}
              />
            )}
          </div>
        </section>
        <section className="rounded-lg border border-aai-border p-4">
          {selected === undefined ? (
            <p className="text-sm opacity-60">Place a call or pick one to see its transcript.</p>
          ) : (
            <CallDetail id={selected} apiKey={apiKey} />
          )}
        </section>
      </div>
    </main>
  );
}

mountPage({ name: "Outbound Caller", component: App });
