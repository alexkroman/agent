// Copyright 2025 the AAI authors. MIT license.

import type { ComponentChildren } from "preact";
import { useSession } from "../signals.ts";

/**
 * A centered start screen with icon, title, subtitle, and a start button.
 * Renders `children` (the main app) once the session has started.
 *
 * @example
 * ```tsx
 * function MyAgent() {
 *   return (
 *     <StartScreen icon="🍕" title="Pizza Palace" subtitle="Voice-powered ordering">
 *       <ChatView />
 *     </StartScreen>
 *   );
 * }
 * ```
 */
export function StartScreen({
  children,
  icon,
  title,
  subtitle,
  buttonText = "Start",
}: {
  children: ComponentChildren;
  icon?: ComponentChildren | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  buttonText?: string | undefined;
}) {
  const { started, start } = useSession();

  if (started.value) {
    return <>{children}</>;
  }

  return (
    <div class="flex items-center justify-center h-screen bg-aai-bg font-aai">
      <div class="flex flex-col items-center gap-6 bg-aai-surface border border-aai-border rounded-lg px-12 py-10">
        {icon}
        {title && <h1 class="text-3xl font-bold text-aai-primary m-0">{title}</h1>}
        {subtitle && <p class="text-sm text-aai-text-muted m-0">{subtitle}</p>}
        <button
          type="button"
          class="mt-2 px-8 py-3 rounded-aai text-sm font-medium cursor-pointer bg-aai-primary text-white border-none"
          onClick={start}
        >
          {buttonText}
        </button>
      </div>
    </div>
  );
}
