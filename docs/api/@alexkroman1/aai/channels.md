# channels

`@alexkroman1/aai/channels` — where a run's output GOES.

One vendor today, one shape: a factory returns a serializable DESCRIPTOR
(`{ kind, options }`) and [sendToChannel](#sendtochannel) posts a [ChannelMessage](#channelmessage)
to it. Nothing here opens a socket at import time, and nothing reads a
credential out of the environment — see [SlackChannelOptions](#slackchanneloptions) for why
a channel's credential is passed in where a provider's is not.

## Example

**Post a run's result to Slack**

```ts
import { slackChannel } from "@alexkroman1/aai/channels";
import { sendToChannelOrFail } from "@alexkroman1/aai/step-errors";

export async function postSummary(webhookUrl: string, points: string[]): Promise<string> {
  return await sendToChannelOrFail(slackChannel({ webhookUrl }), {
    text: `Weekly summary: ${points.length} items`,
    heading: "Weekly summary",
    sections: [{ title: "Highlights", bullets: points }],
  });
}
```

## A channel is the OUTBOUND half, deliberately

The word is used elsewhere for a bidirectional edge adapter — `vercel/eve`'s
`defineChannel` owns inbound routes, a session address, and delivery back —
and that is a different concept than this one. The narrow reading is the
useful one here because it is what a durable step has: no session to resume,
no route to serve, one message to place somewhere and a verdict to reach
about whether a failed attempt is worth repeating. eve's own docs decline to
abstract this case and send authors to the provider's API plus an
application-owned outbox; this SDK's steps already have the durability half,
so what was left to write is the render-and-classify half.

## What each piece is for

- [slackChannel](#slackchannel-1) — declare a destination. [isSlackWebhookUrl](#isslackwebhookurl) guards
  the value where a PERSON supplies it, which is a security boundary and not
  only a typo check.
- [sendToChannel](#sendtochannel) — post, and throw a [ChannelDeliveryError](#channeldeliveryerror)
  carrying the retry verdict. `sendToChannelOrFail`
  (`@alexkroman1/aai/step-errors`) is the same call with the fatal/retryable
  mapping already applied.
- [renderChannelPayload](#renderchannelpayload) — the request that WOULD be sent, pure, so a
  spec can assert the body without a network.

This subpath names neither `zod` nor `@alexkroman1/aai/step-errors`, which is
what lets an `agent.ts` import [isSlackWebhookUrl](#isslackwebhookurl) for a schema
refinement without pulling either into its graph.

## Functions

### escapeSlackMrkdwn()

```ts
function escapeSlackMrkdwn(text: string): string;
```

The three characters Slack's mrkdwn reserves.

Only three, and only these: Slack's own escaping rules say `&`, `<` and `>`
and nothing else, so escaping more would put backslashes in front of the
apostrophes in every summary. `&` first, or the ampersands introduced by the
other two get double-escaped.

#### Parameters

##### text

`string`

#### Returns

`string`

***

### explainChannelFailure()

```ts
function explainChannelFailure(channel: Channel, detail: string): string;
```

The sentence a person can act on for a refusal this channel understands.

#### Parameters

##### channel

[`Channel`](#channel)

##### detail

`string`

#### Returns

`string`

#### Throws

when `channel.kind` names no known channel.

***

### explainSlackChannelFailure()

```ts
function explainSlackChannelFailure(options: SlackChannelOptions, detail: string): string;
```

The sentence a person can act on, chosen from what the URL and the body say.

`workflow_not_published` is called out by name because it is the one 4xx
with a fix that is not "check your URL" — the URL is fine and the workflow
behind it was never published — and nothing in Slack's generic message says
so.

#### Parameters

##### options

[`SlackChannelOptions`](#slackchanneloptions)

##### detail

`string`

#### Returns

`string`

***

### isSlackWebhookUrl()

```ts
function isSlackWebhookUrl(value: string): boolean;
```

Whether a string is a Slack webhook URL at all — an incoming webhook or a
workflow trigger, on one of Slack's two webhook hosts.

**A HOST check rather than "is it a URL", and this is a security boundary as
much as a usability one.** The value becomes the target of a POST carrying
whatever the run summarized, so anything that is not Slack is an
exfiltration endpoint somebody typed into a form. Refuse it where the value
is accepted — a 400 at the call site — rather than at delivery, which is a
failed run after the expensive work has already been paid for.

#### Parameters

##### value

`string`

#### Returns

`boolean`

#### Example

**Refuse a non-Slack destination at the form's edge**

```ts
import { isSlackWebhookUrl } from "@alexkroman1/aai/channels";
import { z } from "zod";

export const input = z.object({
  webhookUrl: z
    .string()
    .trim()
    .url()
    .refine(isSlackWebhookUrl, "Enter a Slack webhook URL from hooks.slack.com"),
});
```

***

### isSlackWorkflowTriggerUrl()

```ts
function isSlackWorkflowTriggerUrl(url: string): boolean;
```

A workflow trigger, which takes flat variables and not Block Kit.

#### Parameters

##### url

`string`

#### Returns

`boolean`

***

### registerChannelHandler()

```ts
function registerChannelHandler(kind: ChannelHandler): void;
```

Register a channel kind, so `sendToChannel` can dispatch a descriptor
carrying its tag.

The SDK registers what it ships (Slack today). Call this for a destination
it does not — an internal notifier, a platform with no adapter here — and
the rest of the channel surface works unchanged: `slackChannel()` has no privileges
a hand-written descriptor factory lacks.

**Register before the first send, and remember a descriptor outlives the
process.** A channel round-trips through a durable run's journal, so a run
resumed in a fresh worker dispatches on a tag whose module that worker may
never have imported. Register at module load in the agent's entry, not
lazily beside the first call.

Re-registering a kind REPLACES it, which is what makes a shipped channel
overridable — and is why the tag is the identity rather than the value.

#### Parameters

##### kind

[`ChannelHandler`](#channelhandler)

#### Returns

`void`

***

### registeredChannelKindNames()

```ts
function registeredChannelKindNames(): readonly string[];
```

The tags [sendToChannel](#sendtochannel) can dispatch, in registration order.

#### Returns

readonly `string`[]

***

### renderChannelPayload()

```ts
function renderChannelPayload(channel: Channel, message: ChannelMessage): ChannelPayload;
```

The request a channel would send for this message — PURE, so the branch a
channel takes over its own options is testable without a network.

That branch is not academic: on Slack it decides between Block Kit and flat
workflow variables, and the wrong one is a 400 on the whole payload.

#### Parameters

##### channel

[`Channel`](#channel)

##### message

[`ChannelMessage`](#channelmessage)

#### Returns

[`ChannelPayload`](#channelpayload)

#### Throws

when `channel.kind` names no known channel.

***

### renderSlackChannelPayload()

```ts
function renderSlackChannelPayload(message: ChannelMessage, options: SlackChannelOptions): ChannelPayload;
```

Block Kit, or flat variables — see the module doc.

#### Parameters

##### message

[`ChannelMessage`](#channelmessage)

##### options

[`SlackChannelOptions`](#slackchanneloptions)

#### Returns

[`ChannelPayload`](#channelpayload)

***

### renderSlackPlainText()

```ts
function renderSlackPlainText(message: ChannelMessage): string;
```

The trigger body: one string, because that is all a variable can hold.

`text` leads rather than being dropped — on this arm it is the notification
line AND the only place the caller's own summary of the message survives.

#### Parameters

##### message

[`ChannelMessage`](#channelmessage)

#### Returns

`string`

***

### sendToChannel()

```ts
function sendToChannel(channel: Channel, message: ChannelMessage): Promise<string>;
```

Post one message, and classify the failure honestly.

The 4xx/5xx split is the whole reason this is not a one-line `stepFetch`.
A revoked webhook, an unpublished Slack workflow and a wrong variable name
all answer 4xx and will answer 4xx identically on every retry — retrying
them burns a step's attempts and delays the real error by minutes. A 5xx is
the platform having a bad minute, which is precisely what retries are for,
and any `Retry-After` it named is carried on the error.

The `ChannelDeliveryError` it throws is what `toStepError` reads, so a step
body hands it straight on and the engine gives up or waits the right amount
— see [ChannelDeliveryError](#channeldeliveryerror), or reach for `sendToChannelOrFail`
(`@alexkroman1/aai/step-errors`) to skip the `.catch`.

#### Parameters

##### channel

[`Channel`](#channel)

##### message

[`ChannelMessage`](#channelmessage)

#### Returns

`Promise`\<`string`\>

whatever the platform answered with, or `"ok"` when it sent no body.

#### Throws

on any non-2xx.

#### Example

```ts
import { sendToChannel, slackChannel } from "@alexkroman1/aai/channels";
import { throwStepError } from "@alexkroman1/aai/step-errors";

export async function announce(webhookUrl: string): Promise<string> {
  return await sendToChannel(slackChannel({ webhookUrl }), { text: "Run finished." }).catch(
    throwStepError,
  );
}
```

***

### slackChannel()

```ts
function slackChannel(options: SlackChannelOptions): SlackChannel;
```

Declare a Slack destination.

#### Parameters

##### options

[`SlackChannelOptions`](#slackchanneloptions)

#### Returns

[`SlackChannel`](#slackchannel)

#### Example

**Post a digest to Slack from a step**

```ts
import { slackChannel } from "@alexkroman1/aai/channels";
import { sendToChannelOrFail } from "@alexkroman1/aai/step-errors";

export async function postDigest(webhookUrl: string, summary: string): Promise<string> {
  return await sendToChannelOrFail(slackChannel({ webhookUrl }), {
    text: `Daily digest: ${summary}`,
    heading: "Daily digest",
    sections: [{ body: summary }],
  });
}
```

## Classes

### ChannelDeliveryError

A post the channel refused, carrying the verdict the caller needs.

`retryable` is the whole point, and it is why this is a class rather than a
thrown `Response`. A revoked webhook, an unpublished Slack workflow and a
wrong variable name all answer 4xx and will answer 4xx identically on every
attempt — retrying them burns a step's attempts and delays the real error by
minutes. A 5xx is the platform having a bad minute, which is precisely what
retries are for.

`toStepError` (`@alexkroman1/aai/step-errors`) reads both fields, exactly as
it already does for `StepGenerateError` and `TranscribeError` — so a step
body hands this straight to it and the DevKit gives up or waits out the
platform's own `Retry-After` without the body deciding anything.

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new ChannelDeliveryError(message: string, init: {
  cause?: unknown;
  channelKind: string;
  retryable: boolean;
  retryAfter?: Date;
  status?: number;
}): ChannelDeliveryError;
```

###### Parameters

###### message

`string`

###### init

###### cause?

`unknown`

###### channelKind

`string`

###### retryable

`boolean`

###### retryAfter?

`Date`

###### status?

`number`

###### Returns

[`ChannelDeliveryError`](#channeldeliveryerror)

###### Overrides

```ts
Error.constructor
```

#### Properties

##### channelKind

```ts
readonly channelKind: string;
```

The channel that refused it — `"slack"`, and so on.

##### name

```ts
readonly name: "ChannelDeliveryError" = "ChannelDeliveryError";
```

###### Overrides

```ts
Error.name
```

##### retryable

```ts
readonly retryable: boolean;
```

Whether another attempt could plausibly succeed.

##### retryAfter

```ts
readonly retryAfter: Date | undefined;
```

When the platform named a `Retry-After`, the moment it asked for.

##### status

```ts
readonly status: number | undefined;
```

The HTTP status, or `undefined` when the request never got an answer.

## Interfaces

### ChannelDescriptor

Base shape for a channel descriptor: a `kind` tag plus an opaque `options`
payload, so the dispatch table picks the renderer and passes the author's
options through verbatim.

#### Type Parameters

##### Kind

`Kind` *extends* `string`

##### Options

`Options`

#### Properties

##### kind

```ts
readonly kind: Kind;
```

##### options

```ts
readonly options: Options;
```

***

### ChannelHandler

Everything one channel kind supplies: how to turn a [ChannelMessage](#channelmessage)
into the request body that platform takes, and what to say when the platform
refuses one.

A channel is defined as a VALUE of this shape, in the module that owns the
platform, and `sendToChannel` reaches it through the registry. The generic
send path therefore imports nothing vendor-specific and adding a channel
touches no shared file — which is the whole reason this interface is public
rather than an internal shape inside `send.ts`, where it started with Slack's
option-narrowing spelled out beside the dispatch table.

`render` and `advice` are handed the descriptor's RAW options, because a
descriptor round-trips through a durable run's journal and arrives as
whatever was written there. Narrowing them is the kind's own job and the
reason it owns this function: a cast here would fail as `POST undefined`
rather than naming the field that is missing.

#### Properties

##### advice

```ts
readonly advice: (options: Record<string, unknown>, detail: string) => string;
```

What to tell an author when the platform refuses a post.

###### Parameters

###### options

`Record`\<`string`, `unknown`\>

###### detail

`string`

###### Returns

`string`

##### kind

```ts
readonly kind: string;
```

The `kind` tag its descriptors carry, e.g. `"slack"`.

##### render

```ts
readonly render: (message: ChannelMessage, options: Record<string, unknown>) => ChannelPayload;
```

Turn a message into this platform's request.

###### Parameters

###### message

[`ChannelMessage`](#channelmessage)

###### options

`Record`\<`string`, `unknown`\>

###### Returns

[`ChannelPayload`](#channelpayload)

***

### ChannelMessage

What gets posted, in terms no single platform owns.

**`text` is not decoration and it is not optional.** It is what a push
notification and a screen reader read, and it is the WHOLE message on a
channel that has no rich format — a Slack workflow trigger takes flat string
variables and there is no `blocks` variable to send. A channel with a rich
format renders `heading`/`sections` and uses `text` as the notification
line; a channel without one renders `text` and folds the rest into it. Leave
it off and Slack notifies as "[no preview]"; that is the failure this field
exists to prevent.

#### Properties

##### heading?

```ts
readonly optional heading?: string;
```

The title above the sections.

##### sections?

```ts
readonly optional sections?: readonly ChannelSection[];
```

The body, in blocks.

##### subtitle?

```ts
readonly optional subtitle?: string;
```

A line under the heading — context for the whole message.

##### text

```ts
readonly text: string;
```

The notification line, and the fallback body. Always sent.

***

### ChannelPayload

A rendered request: where to POST and what to send.

Returned by [renderChannelPayload](#renderchannelpayload), which is PURE — the branch a
channel takes over its own options is testable without a network, and on
Slack that branch is the difference between a delivered message and a 400.

#### Properties

##### body

```ts
readonly body: Record<string, unknown>;
```

The JSON body.

##### headers?

```ts
readonly optional headers?: Readonly<Record<string, string>>;
```

Headers beyond `Content-Type: application/json`.

##### url

```ts
readonly url: string;
```

Absolute URL to POST to.

***

### ChannelSection

One block of a message: a titled chunk, optionally linked, with prose and
bullets under it.

Everything is optional because a channel renders what it was given rather
than demanding a shape — a section with only `body` is a paragraph, one with
only `title` and `url` is a link.

#### Properties

##### body?

```ts
readonly optional body?: string;
```

The prose.

##### bullets?

```ts
readonly optional bullets?: readonly string[];
```

Bullet points under the prose.

##### subtitle?

```ts
readonly optional subtitle?: string;
```

A line under the title — a source, a byline, a timestamp.

##### title?

```ts
readonly optional title?: string;
```

The section's headline. Rendered as a link when `url` is set.

##### url?

```ts
readonly optional url?: string;
```

Where `title` points.

***

### SlackChannelOptions

What [slackChannel](#slackchannel-1) takes.

**No credential is read from the environment**, and that is a deliberate
difference from a provider descriptor. A webhook URL IS the credential —
anyone holding it can post — and the destination is usually per-run rather
than per-deploy: one deployed agent posts to whichever workspace each run
names. So it is passed in, and the guard for it ([isSlackWebhookUrl](#isslackwebhookurl))
is published so the check can happen at the form's edge.

#### Properties

##### textParam?

```ts
readonly optional textParam?: string;
```

The workflow variable the message text is sent as — WORKFLOW TRIGGER URLs
only, where it must match a variable that workflow declares. Ignored by an
incoming webhook, which takes Block Kit.

###### Default Value

`"text"`

##### webhookUrl

```ts
readonly webhookUrl: string;
```

An incoming webhook (`hooks.slack.com/services/…`) or a workflow trigger
(`hooks.slack.com/triggers/…`). Validate it with
[isSlackWebhookUrl](#isslackwebhookurl) wherever it is accepted from a person.

## Type Aliases

### Channel

```ts
type Channel = ChannelDescriptor<string, Record<string, unknown>> & {
  __surface?: "channel";
};
```

Any channel descriptor — what [sendToChannel](#sendtochannel) takes.

The `__surface` property is a compile-time tag, so a PROVIDER descriptor
cannot be handed to a channel operation and vice versa. It is optional and
never present at runtime, so a plain `{ kind, options }` object parsed off
the wire stays assignable — the same trick `ProviderDescriptor`'s `__stage`
plays for the four pipeline stages.

#### Type Declaration

##### \_\_surface?

```ts
readonly optional __surface?: "channel";
```

Compile-time surface tag; never present at runtime.

***

### SlackChannel

```ts
type SlackChannel = Channel & {
  kind: typeof SLACK_CHANNEL_KIND;
  options: SlackChannelOptions & Record<string, unknown>;
};
```

A Slack channel descriptor, as returned by [slackChannel](#slackchannel-1).

#### Type Declaration

##### kind

```ts
readonly kind: typeof SLACK_CHANNEL_KIND;
```

##### options

```ts
readonly options: SlackChannelOptions & Record<string, unknown>;
```

## Variables

### CHANNEL\_POST\_TIMEOUT\_MS

```ts
const CHANNEL_POST_TIMEOUT_MS: 30000 = 30000;
```

A platform is not slow. A post that has not answered in 30s is not going to,
and a step holding a socket open past that is a step nobody can cancel.

***

### SLACK\_CHANNEL\_HANDLER

```ts
const SLACK_CHANNEL_HANDLER: ChannelHandler;
```

Slack as a [ChannelHandler](#channelhandler) — what `sendToChannel` dispatches to for a
`"slack"` descriptor.

Exported so a host that assembles its own channel set can name it, and so
this module is a complete unit: everything the send path needs to handle
Slack is here, and `send.ts` imports this one value rather than four
functions and an options type.

***

### SLACK\_CHANNEL\_KIND

```ts
const SLACK_CHANNEL_KIND: "slack" = "slack";
```

The `kind` tag on a Slack channel descriptor.
