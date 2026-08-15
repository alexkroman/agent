// Copyright 2026 the AAI authors. MIT license.
// "Phone number" — the carrier webhook URLs for this project's published
// agent, one per carrier, each with a copy button and its signing secret.
//
// The whole integration on the user's side is pasting one of these into a
// phone number's voice webhook, so the URL is the entire feature as far as
// this pane is concerned. It is not derivable by hand: it needs the platform
// origin, the project's PUBLISHED slug (not its name), and the `?carrier=`
// value, and getting any of the three wrong produces a number that answers
// and then hangs up.

import { platformOrigin } from "./platform-origin.ts";
import { Card } from "./settings-card.tsx";
import { useCopy } from "./use-copy.ts";

/** A carrier the platform can emit a media-stream document for. */
type Carrier = {
  id: string;
  label: string;
  /** Where in that carrier's console the URL goes. */
  webhook: string;
  /** The secret that turns on webhook verification for this carrier. */
  secret: string;
  /** Where the user finds that secret's value. */
  secretSource: string;
};

const CARRIERS: readonly Carrier[] = [
  {
    id: "twilio",
    label: "Twilio",
    webhook: "Phone number → Voice → A call comes in → Webhook (HTTP POST)",
    secret: "TWILIO_AUTH_TOKEN",
    secretSource: "Twilio Console → Account Info → Auth Token",
  },
  {
    id: "telnyx",
    label: "Telnyx",
    webhook: "TeXML Application → Webhook URL (HTTP POST)",
    secret: "TELNYX_PUBLIC_KEY",
    secretSource: "Telnyx Portal → Account Settings → Keys & Credentials → Public Key",
  },
];

/**
 * The webhook URL for one carrier.
 *
 * `?carrier=` is spelled out even for Twilio, which the platform already
 * defaults to. This URL is pasted into a carrier console once and then never
 * looked at again, so it has to keep meaning the same thing — a default is a
 * decision the platform is free to revisit, and the copies already sitting in
 * people's phone-number settings are not.
 */
export function phoneWebhookUrl(origin: string, slug: string, carrier: string): string {
  return `${origin}/${slug}/phone?carrier=${carrier}`;
}

/** Whether a carrier's signing secret is set, and whether it has landed. */
export type SecretState = "missing" | "pending" | "live";

/**
 * Resolve a signing secret's state from the Secrets card's own two lists.
 *
 * `pending` is the one worth distinguishing: the project holds the value but
 * no deploy has carried it onto the published agent yet, so verification is
 * NOT running even though the name is visible in the list below. Reporting
 * that as set would tell someone their webhook is protected while it is still
 * accepting anything.
 */
export function secretState(
  secret: string,
  secretNames: readonly string[],
  pendingSecrets: readonly string[],
): SecretState {
  if (!secretNames.includes(secret)) return "missing";
  return pendingSecrets.includes(secret) ? "pending" : "live";
}

function SecretHint({ carrier, state }: { carrier: Carrier; state: SecretState }) {
  if (state === "live") {
    return (
      <span className="text-[11px] text-muted">
        <code className="font-mono">{carrier.secret}</code> is set — calls are verified.
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="text-[11px] text-muted">
        <code className="font-mono">{carrier.secret}</code> is saved but reaches this agent on your
        next publish — calls are not verified yet.
      </span>
    );
  }
  return (
    <span className="text-[11px] text-muted">
      Add <code className="font-mono">{carrier.secret}</code> in Secrets below to verify calls
      really came from {carrier.label} ({carrier.secretSource}). Until then anyone with this URL can
      start calls on your account.
    </span>
  );
}

type PhoneCardProps = {
  /**
   * The project's PUBLISHED slug. Absent until the first Publish — and this
   * card gates on it, unlike its neighbours. Secrets and Database record an
   * intent that a later deploy picks up, so they are useful before anything
   * ships; a webhook URL is not an intent. Pointed at an unpublished slug it
   * resolves to nothing, and the caller hears the agent-not-found message and
   * gets hung up on, which is a worse answer than not showing a URL yet.
   */
  deployedSlug?: string | undefined;
  /** Secret names this project holds — the Secrets card's own list. */
  secretNames: readonly string[];
  /** Of those, the ones no deployed agent carries yet. */
  pendingSecrets: readonly string[];
};

export function PhoneCard({ deployedSlug, secretNames, pendingSecrets }: PhoneCardProps) {
  const copier = useCopy();
  const origin = platformOrigin();

  return (
    <Card
      title="Phone number"
      blurb="Point a phone number's voice webhook at one of these and calls to it reach this agent. Each carrier also needs its signing secret set below before the platform will verify the calls are really from them."
    >
      {deployedSlug === undefined ? (
        <p className="m-0 text-[13px] leading-5 text-muted">
          Publish this project to get its webhook URL.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {CARRIERS.map((carrier) => {
            const url = phoneWebhookUrl(origin, deployedSlug, carrier.id);
            return (
              <li key={carrier.id} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-medium text-fg">{carrier.label}</span>
                  <span className="text-[11px] text-subtle">{carrier.webhook}</span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 rounded-md border border-line bg-cream px-3 py-2 font-mono text-xs break-all">
                    {url}
                  </code>
                  <button
                    type="button"
                    className="btn px-2 py-1 text-xs"
                    onClick={() => copier.copy(url)}
                    aria-label={`Copy the ${carrier.label} webhook URL`}
                  >
                    {copier.label(url)}
                  </button>
                </div>
                <SecretHint
                  carrier={carrier}
                  state={secretState(carrier.secret, secretNames, pendingSecrets)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
