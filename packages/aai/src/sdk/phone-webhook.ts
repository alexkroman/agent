// Copyright 2026 the AAI authors. MIT license.
/**
 * The call-answering WEBHOOK's wire format: the URL a dialled call is pointed
 * at, the `<Parameter>`s it carries, and the TwiML that connects it.
 *
 * An outbound call (`stepPlaceCall`) hands Twilio `Url=<agentUrl>/phone?…`
 * rather than inline TwiML, because only a webhook works on the managed
 * platform: `/:slug/phone` there is an HTTP route that brokers the sandbox and
 * answers with TwiML naming the sandbox's own `wss://…/phone`. Inline TwiML
 * would have had to name a WebSocket URL at dial time, and the platform's URL
 * is not one (the platform terminates no sessions, and carriers do not follow
 * a handshake redirect). A self-hosted server answers the same webhook itself
 * (`aai-runtime/telephony/telephony-server.ts`), so one dial shape serves both.
 *
 * The call's parameters ride the webhook's QUERY as `param.<name>=<value>`,
 * and whichever server answers copies them into the `<Stream>`'s
 * `<Parameter>`s, which is how `sessionContext` receives them as
 * `call.parameters`. The query is what the carrier signs, so a platform that
 * verifies `X-Twilio-Signature` covers them with no extra step.
 *
 * Three readers, one module: the SDK's dialler writes the URL, and the runtime
 * and `aai-server` read it back and render the TwiML — so the prefix, the
 * limits and the escaping cannot drift between them.
 *
 * @module
 */

/** At most this many `<Parameter>`s — what the answering bridge keeps (`session-call.ts`). */
export const MAX_CALL_PARAMETERS = 32;

/** Twilio's limit on one `<Parameter>`'s name plus value. */
export const MAX_CALL_PARAMETER_CHARS = 500;

/** The query-key prefix a call parameter travels under on the webhook URL. */
export const CALL_PARAMETER_PREFIX = "param.";

/**
 * Throw (plain `Error`) unless `parameters` is within Twilio's limits: at most
 * {@link MAX_CALL_PARAMETERS}, each a non-empty name and a string value
 * together under {@link MAX_CALL_PARAMETER_CHARS} characters.
 */
export function assertCallParameters(parameters: Readonly<Record<string, string>>): void {
  const entries = Object.entries(parameters);
  if (entries.length > MAX_CALL_PARAMETERS) {
    throw new Error(`at most ${MAX_CALL_PARAMETERS} call parameters, got ${entries.length}`);
  }
  for (const [name, value] of entries) {
    if (
      typeof value !== "string" ||
      name === "" ||
      name.length + value.length >= MAX_CALL_PARAMETER_CHARS
    ) {
      throw new Error(
        `call parameter ${JSON.stringify(name.slice(0, 40))} must be a non-empty name and a ` +
          `string value, together under ${MAX_CALL_PARAMETER_CHARS} characters`,
      );
    }
  }
}

/**
 * The webhook URL for an agent's public base: `ws(s)` becomes `http(s)`, a
 * trailing slash is dropped, and `/phone?carrier=<carrier>` plus one
 * `param.<name>` per parameter is appended.
 *
 * Throws on anything but an absolute `http(s)`/`ws(s)` URL with no query or
 * fragment, and on parameters {@link assertCallParameters} refuses — Twilio
 * would dial the number and then fail to fetch the webhook, which a person
 * hears as a call that rings and goes silent.
 */
export function phoneWebhookUrl(
  agentUrl: string,
  carrier: string,
  parameters: Readonly<Record<string, string>>,
): string {
  let url: URL;
  try {
    url = new URL(agentUrl);
  } catch (err: unknown) {
    throw new Error(`agentUrl is not a URL: ${JSON.stringify(agentUrl)}`, { cause: err });
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`agentUrl must be https:// or wss://, not ${url.protocol}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("agentUrl must be a base URL, with no query or fragment");
  }
  assertCallParameters(parameters);
  const query = new URLSearchParams({ carrier });
  for (const [name, value] of Object.entries(parameters)) {
    query.append(`${CALL_PARAMETER_PREFIX}${name}`, value);
  }
  const base = `${url.protocol.replace(/^ws/, "http")}//${url.host}${url.pathname}`;
  return `${base.replace(/\/+$/, "")}/phone?${query.toString()}`;
}

/**
 * The call parameters a webhook URL's query carries — every `param.<name>`,
 * prefix stripped. Throws (plain `Error`) when they break
 * {@link assertCallParameters}, so a server answers 400 rather than handing the
 * carrier TwiML it will refuse.
 */
export function callParametersFromQuery(query: URLSearchParams): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const [key, value] of query) {
    if (key.startsWith(CALL_PARAMETER_PREFIX)) {
      parameters[key.slice(CALL_PARAMETER_PREFIX.length)] = value;
    }
  }
  assertCallParameters(parameters);
  return parameters;
}

/**
 * XML-escape a value going into TwiML — all five specials, as numeric
 * references, so a quote in a parameter cannot close the attribute it is in.
 */
export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * The `<Connect><Stream>` element that connects an answered call's audio to
 * `streamUrl`, one `<Parameter>` per entry. The caller wraps it in
 * `<Response>`.
 */
export function connectStreamTwiml(
  streamUrl: string,
  parameters: Readonly<Record<string, string>>,
): string {
  const params = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
    .join("");
  return `<Connect><Stream url="${escapeXml(streamUrl)}">${params}</Stream></Connect>`;
}
