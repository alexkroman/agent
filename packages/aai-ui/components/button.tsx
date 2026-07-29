// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { useTheme } from "../context.ts";

/**
 * Visual style of a {@link Button} (design-system "website refresh":
 * rectangular, ALL-CAPS, tracked labels).
 *
 * - `"default"` — Primary filled button (indigo background).
 * - `"secondary"` — Outlined primary (transparent background, primary border).
 * - `"ghost"` — Raised neutral (surface background with hairline border).
 */
type ButtonVariant = "default" | "secondary" | "ghost";

/**
 * Size preset for a {@link Button}.
 *
 * - `"default"` — Compact control (height 36 px).
 * - `"lg"` — Primary CTA (height 44 px, generous padding).
 */
type ButtonSize = "default" | "lg";

/**
 * A styled button with variant and size presets.
 *
 * Accepts all standard `<button>` HTML attributes in addition to the props
 * listed below.
 *
 * @example
 * ```tsx
 * <Button variant="secondary" onClick={handleClick}>
 *   Stop
 * </Button>
 *
 * <Button size="lg" className="w-full">
 *   Start Conversation
 * </Button>
 * ```
 *
 * @param variant - Visual style (`"default"` | `"secondary"` | `"ghost"`). Defaults to `"default"`.
 * @param size - Size preset (`"default"` | `"lg"`). Defaults to `"default"`.
 * @param className - Additional CSS class names.
 * @param children - Button label / content.
 *
 * @public
 */
export function Button({
  variant = "default",
  size = "default",
  className,
  children,
  style,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const theme = useTheme();

  let variantStyle: CSSProperties;
  if (variant === "default") {
    variantStyle = { background: theme.primary, color: theme.surface, borderColor: "transparent" };
  } else if (variant === "secondary") {
    variantStyle = {
      background: "transparent",
      color: theme.primary,
      borderColor: theme.primary,
    };
  } else {
    variantStyle = {
      background: theme.surface,
      color: theme.text,
      borderColor: theme.border,
    };
  }

  return (
    <button
      type="button"
      style={{ ...variantStyle, ...style }}
      className={clsx(
        "inline-flex items-center justify-center appearance-none m-0 w-fit whitespace-nowrap",
        size === "lg" ? "h-11 px-7 text-xs" : "h-9 px-5 text-[11px]",
        "rounded-aai font-aai font-medium tracking-[1.4px] uppercase leading-none",
        "cursor-pointer border outline-none transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
