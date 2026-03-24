// Copyright 2025 the AAI authors. MIT license.

import type { Signal } from "@preact/signals";
import clsx from "clsx";
import type * as preact from "preact";
import type { SessionError } from "../types.ts";

export function ErrorBanner({
  error,
  className,
}: {
  error: Signal<SessionError | null>;
  className?: string;
}): preact.JSX.Element | null {
  if (!error.value) return null;
  return (
    <div
      class={clsx(
        "mx-4 mt-3 px-3 py-2 rounded-aai border border-aai-error/40 bg-aai-error/8 text-[13px] leading-[130%] text-aai-error",
        className,
      )}
    >
      {error.value.message}
    </div>
  );
}
