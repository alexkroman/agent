// Copyright 2025 the AAI authors. MIT license.
import type * as preact from "preact";

type IconProps = { class?: string };

/** Magnifying glass icon for web_search. */
export function SearchIcon(props: IconProps): preact.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" stroke-linecap="round" />
    </svg>
  );
}

/** External link icon for visit_webpage. */
export function ExternalLinkIcon(props: IconProps): preact.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-3" stroke-linecap="round" />
      <path d="M9 2h5v5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M14 2L7 9" stroke-linecap="round" />
    </svg>
  );
}

/** Terminal icon for run_code. */
export function TerminalIcon(props: IconProps): preact.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <rect x="1" y="2" width="14" height="12" rx="1.5" />
      <path d="M4 6l3 2.5L4 11" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M9 11h3" stroke-linecap="round" />
    </svg>
  );
}

/** Download icon for fetch_json. */
export function DownloadIcon(props: IconProps): preact.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <path d="M8 2v9" stroke-linecap="round" />
      <path d="M4.5 8L8 11.5 11.5 8" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M2 13h12" stroke-linecap="round" />
    </svg>
  );
}

/** Chat bubble icon for user_input. */
export function ChatBubbleIcon(props: IconProps): preact.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H5l-3 3V3z" stroke-linejoin="round" />
    </svg>
  );
}

/** Bolt/lightning icon for default/unknown tools. */
export function BoltIcon(props: IconProps): preact.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      class={props.class}
    >
      <path d="M9 1L3 9h5l-1 6 6-8H8l1-6z" stroke-linejoin="round" />
    </svg>
  );
}
