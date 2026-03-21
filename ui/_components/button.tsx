// Copyright 2025 the AAI authors. MIT license.

import type * as preact from "preact";
import { cn } from "../_cn.ts";

type ButtonVariant = "default" | "secondary" | "ghost";

const base =
  "h-8 px-3 py-1.5 rounded-aai text-sm font-medium leading-[130%] cursor-pointer border outline-none";

const variants: Record<ButtonVariant, string> = {
  default: "bg-aai-primary text-white border-transparent",
  secondary: "bg-aai-surface-hover text-aai-text-secondary border-aai-border",
  ghost: "bg-transparent text-aai-text-secondary border-aai-border",
};

export function Button({
  variant = "default",
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  className?: string;
  children?: preact.ComponentChildren;
} & Omit<preact.JSX.HTMLAttributes<HTMLButtonElement>, "className">) {
  return (
    <button type="button" class={cn(base, variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}
