// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";

/** @public */
export type ButtonVariant = "default" | "secondary" | "ghost";
/** @public */
export type ButtonSize = "default" | "lg";

/** @public */
export function Button({
  variant = "default",
  size = "default",
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: preact.ComponentChildren;
} & Omit<preact.JSX.HTMLAttributes<HTMLButtonElement>, "className">) {
  return (
    <button
      type="button"
      style={
        size === "lg"
          ? {
              display: "grid",
              placeItems: "center",
              appearance: "none",
              margin: 0,
              padding: "12px 32px",
              lineHeight: 1,
            }
          : undefined
      }
      class={clsx(
        size !== "lg" &&
          "flex items-center justify-center appearance-none m-0 h-8 px-3 py-1.5 w-fit leading-none",
        "rounded-aai text-sm font-medium cursor-pointer border outline-none",
        variant === "secondary" && "bg-aai-surface-hover text-aai-text-secondary border-aai-border",
        variant === "ghost" && "bg-transparent text-aai-text-secondary border-aai-border",
        variant === "default" && "bg-aai-primary text-white border-transparent",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
