// Copyright 2026 the AAI authors. MIT license.
// Model select box — lists only the provider/model pairs the server can
// actually run (GET /studio/models), and remembers the pick in localStorage.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { api, type ModelChoice, type ModelOptions } from "./api.ts";

const STORAGE_KEY = "aai-studio-model";
/** Separator for the <option> value; neither provider nor model contains it. */
const VALUE_SEP = "::";

function readStored(): ModelChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelChoice>;
    if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") return null;
    return { provider: parsed.provider, model: parsed.model };
  } catch {
    // Unavailable or corrupt storage just means "no preference".
    return null;
  }
}

function writeStored(choice: ModelChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Private-mode / quota failures must not break the chat.
  }
}

function isOffered(options: ModelOptions | undefined, choice: ModelChoice | null): boolean {
  if (!(options && choice)) return false;
  return options.providers.some(
    (p) => p.provider === choice.provider && p.models.includes(choice.model),
  );
}

export type ModelChoiceState = {
  options: ModelOptions | undefined;
  /** The effective choice: a valid stored pick, else the server default. */
  choice: ModelChoice | null;
  setChoice: (choice: ModelChoice) => void;
};

/**
 * Own the model choice. A stored pick the server no longer offers (key
 * removed, model retired) silently falls back to the host default rather
 * than sending something that would 400.
 */
export function useModelChoice(apiKey: string): ModelChoiceState {
  const [stored, setStored] = useState<ModelChoice | null>(readStored);

  const query = useQuery({
    queryKey: ["models", apiKey],
    queryFn: () => api.models(apiKey),
  });

  const setChoice = useCallback((choice: ModelChoice) => {
    writeStored(choice);
    setStored(choice);
  }, []);

  const choice = useMemo(
    () => (isOffered(query.data, stored) ? stored : (query.data?.default ?? null)),
    [query.data, stored],
  );

  return { options: query.data, choice, setChoice };
}

type ModelPickerProps = ModelChoiceState & { disabled?: boolean };

export function ModelPicker({ options, choice, setChoice, disabled }: ModelPickerProps) {
  const providers = options?.providers ?? [];
  if (!choice || providers.length === 0) return null;

  // A single model on offer isn't a choice — just name it.
  const total = providers.reduce((n, p) => n + p.models.length, 0);
  if (total < 2) {
    return (
      <span className="font-mono text-[11px] normal-case tracking-normal text-dim">
        {choice.provider}/{choice.model}
      </span>
    );
  }

  return (
    <select
      className="field max-w-[15rem] py-0.5 font-mono text-[11px] normal-case tracking-normal"
      value={`${choice.provider}${VALUE_SEP}${choice.model}`}
      disabled={disabled}
      title="Model used by the coding agent"
      aria-label="Coding agent model"
      onChange={(e) => {
        const [provider, model] = e.target.value.split(VALUE_SEP);
        if (provider && model) setChoice({ provider, model });
      }}
    >
      {providers.map((p) => (
        <optgroup key={p.provider} label={p.label}>
          {p.models.map((model) => (
            <option key={model} value={`${p.provider}${VALUE_SEP}${model}`}>
              {model}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
