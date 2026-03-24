// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type { ComponentChildren } from "preact";
import { useSession } from "../signals.ts";
import { Button } from "./button.tsx";

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
  className,
}: {
  children: ComponentChildren;
  icon?: ComponentChildren | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  buttonText?: string | undefined;
  className?: string | undefined;
}) {
  const { started, start } = useSession();

  if (started.value) {
    return <>{children}</>;
  }

  return (
    <div class={clsx("flex items-center justify-center h-screen bg-aai-bg font-aai", className)}>
      <div class="flex flex-col items-center gap-4 bg-aai-surface border border-aai-border rounded-lg px-12 py-10 max-w-sm text-center">
        {icon}
        {title && <h1 class="font-semibold text-aai-primary m-0">{title}</h1>}
        {subtitle && <p class="text-sm text-aai-text-muted m-0">{subtitle}</p>}
        <Button size="lg" className="mt-2 w-full" onClick={start}>
          {buttonText}
        </Button>
      </div>
    </div>
  );
}
