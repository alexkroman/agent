// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { ReactNode } from "react";
import { useSession, useTheme } from "../context.ts";
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
 *
 * @public
 */
export function StartScreen({
  children,
  icon,
  title,
  subtitle,
  buttonText = "Start",
  className,
}: {
  children: ReactNode;
  icon?: ReactNode | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  buttonText?: string | undefined;
  className?: string | undefined;
}) {
  const { started, start } = useSession();
  const theme = useTheme();

  if (started) {
    return children;
  }

  return (
    <div
      className={clsx("flex items-center justify-center h-screen font-aai", className)}
      style={{ background: theme.bg }}
    >
      <div
        className="flex flex-col items-center gap-4 border rounded-lg px-12 py-10 max-w-sm text-center"
        style={{ background: theme.surface, borderColor: theme.border }}
      >
        {icon}
        {title && (
          <h1 className="font-semibold m-0" style={{ color: theme.primary }}>
            {title}
          </h1>
        )}
        {subtitle && (
          <p className="text-sm m-0" style={{ color: "rgba(255,255,255,0.284)" }}>
            {subtitle}
          </p>
        )}
        <Button size="lg" className="mt-2 w-full" onClick={start}>
          {buttonText}
        </Button>
      </div>
    </div>
  );
}
