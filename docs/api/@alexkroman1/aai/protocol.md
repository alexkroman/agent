# protocol

WebSocket wire-format types shared by server and client.

This is the published wire contract (`@alexkroman1/aai/protocol`) for
building custom clients or servers that speak the session protocol —
aai-ui's browser session is built on it.

## Functions

### buildClientConfig()

```ts
function buildClientConfig(src: {
  greeting?: string;
  name?: string;
  page?: "voice" | "static";
  sessionUrl?: string;
}): {
  greeting?: string;
  name?: string;
  page: "voice" | "static";
  sessionUrl?: string;
};
```

Build the `GET /client-config` response body from an agent-shaped config.

Every server that serves the endpoint (a self-hosted `createServer`, the
platform's per-slug handler, the CLI dev server) goes through this, so a
surface rule can't drift between them.

#### Parameters

##### src

###### greeting?

`string`

###### name?

`string`

###### page?

`"voice"` \| `"static"`

###### sessionUrl?

`string`

#### Returns

```ts
{
  greeting?: string;
  name?: string;
  page: "voice" | "static";
  sessionUrl?: string;
}
```

##### greeting?

```ts
optional greeting?: string;
```

##### name?

```ts
optional name?: string;
```

##### page

```ts
page: "voice" | "static";
```

##### sessionUrl?

```ts
optional sessionUrl?: string;
```

***

### buildReadyConfig()

```ts
function buildReadyConfig(s2sConfig: {
  inputSampleRate: number;
  outputSampleRate: number;
}): {
  audioFormat: "pcm16";
  sampleRate: number;
  ttsSampleRate: number;
};
```

Build the protocol-level session config (the `config` frame's audio fields)
from the session's input/output sample rates — used by every session mode,
pipeline and S2S alike.

#### Parameters

##### s2sConfig

###### inputSampleRate

`number`

###### outputSampleRate

`number`

#### Returns

```ts
{
  audioFormat: "pcm16";
  sampleRate: number;
  ttsSampleRate: number;
}
```

##### audioFormat

```ts
audioFormat: "pcm16";
```

##### sampleRate

```ts
sampleRate: number;
```

##### ttsSampleRate

```ts
ttsSampleRate: number;
```

***

### lenientParse()

```ts
function lenientParse<T>(
   schema: ZodType<T>, 
   json: unknown, 
   knownTypes?: ReadonlySet<string>
): 
  | {
  data: T;
  ok: true;
}
  | {
  error: string;
  malformed: boolean;
  ok: false;
};
```

Two-phase message parse: tries the strict schema first, then falls back to
the envelope to distinguish unknown-but-valid types (safe to ignore during
rolling upgrades) from genuinely malformed messages.

Return value when `ok: false`:
- `malformed: true` — message doesn't have a `{ type: string }` shape (likely
  corrupt data), OR its `type` is one of `knownTypes` but it still failed
  strict validation (e.g. a `tool_result` missing `toolCallId`); both should
  warn
- `malformed: false` — has a valid `type` field whose value is unrecognised;
  safe to ignore (e.g. new message type from a newer server version)

Passing `knownTypes` is what separates "unknown newer-version type" from
"known type that failed validation" — without it, an invalid known message
is silently swallowed as if it were a forward-compat unknown type. When
parsing client→server messages, pass [SESSION\_COMMAND\_TYPES](#session_command_types) as
`knownTypes`.

#### Type Parameters

##### T

`T`

#### Parameters

##### schema

`ZodType`\<`T`\>

##### json

`unknown`

##### knownTypes?

`ReadonlySet`\<`string`\>

#### Returns

  \| \{
  `data`: `T`;
  `ok`: `true`;
\}
  \| \{
  `error`: `string`;
  `malformed`: `boolean`;
  `ok`: `false`;
\}

## Interfaces

### ClientSink

Typed interface for pushing session events to a connected client.

Events send JSON text frames; audio chunks (`playAudioChunk`) send raw PCM16
binary frames. There is no `playAudioDone` — the turn's `audio.completed` is
an ordinary event now, and the sink orders it behind held audio by type. That
is what let it join the retained stream: a method on the sink was a frame no
event log could see.

#### Methods

##### close()?

```ts
optional close(reason?: string): void;
```

Close the underlying connection (best-effort, idempotent). Used when the
server retires a session out from under a connected client — a resume
takeover, or a sandbox teardown — so the client gets a real close to
react to instead of a socket that silently stops answering.

###### Parameters

###### reason?

`string`

###### Returns

`void`

##### event()

```ts
event(e: 
  | {
  audioFormat: string;
  meta: {
     at: number;
     id: string;
  };
  sampleRate: number;
  sessionId?: string;
  ttsSampleRate: number;
  type: "session.configured";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "audio.completed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "speech.started";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "speech.stopped";
}
  | {
  eotConfidence?: number;
  meta: {
     at: number;
     id: string;
  };
  text: string;
  type: "user-transcript.updated";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  text: string;
  type: "user-transcript.committed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  text: string;
  type: "agent-transcript.updated";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  recovery?: "session-failed" | "turn-failed";
  text: string;
  type: "agent-transcript.committed";
}
  | {
  args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  meta: {
     at: number;
     id: string;
  };
  toolCallId: string;
  toolName: string;
  type: "tool.called";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  result: string;
  toolCallId: string;
  type: "tool.completed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "reply.completed";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "reply.cancelled";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "session.reset";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  type: "session.timed-out";
}
  | {
  code:   | "audio"
     | "connection"
     | "internal"
     | "llm"
     | "protocol"
     | "stt"
     | "tool"
     | "tts";
  fatal: boolean;
  message: string;
  meta: {
     at: number;
     id: string;
  };
  type: "error.reported";
}
  | {
  data: unknown;
  event: string;
  meta: {
     at: number;
     id: string;
  };
  type: "custom.emitted";
}
  | {
  meta: {
     at: number;
     id: string;
  };
  state: unknown;
  type: "state.updated";
}
  | {
  messages: {
     content: string;
     role: "assistant" | "user";
  }[];
  meta: {
     at: number;
     id: string;
  };
  toolCalls: {
     afterMessageIndex: number;
     args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     callId: string;
     name: string;
     result?: string;
     status: "done" | "pending";
  }[];
  type: "history.restored";
}): void;
```

Push a session event (JSON text frame) to the client.

Takes an ALREADY-STAMPED [SessionEvent](#sessionevent): the envelope is minted once,
by the session's emitter, which is also what appends the event to the
retained stream. A sink that stamped its own would mint a second id for an
event the stream had already recorded under another.

###### Parameters

###### e

  \| \{
  `audioFormat`: `string`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `sampleRate`: `number`;
  `sessionId?`: `string`;
  `ttsSampleRate`: `number`;
  `type`: `"session.configured"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"audio.completed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"speech.started"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"speech.stopped"`;
\}
  \| \{
  `eotConfidence?`: `number`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `text`: `string`;
  `type`: `"user-transcript.updated"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `text`: `string`;
  `type`: `"user-transcript.committed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `text`: `string`;
  `type`: `"agent-transcript.updated"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `recovery?`: `"session-failed"` \| `"turn-failed"`;
  `text`: `string`;
  `type`: `"agent-transcript.committed"`;
\}
  \| \{
  `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `toolCallId`: `string`;
  `toolName`: `string`;
  `type`: `"tool.called"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `result`: `string`;
  `toolCallId`: `string`;
  `type`: `"tool.completed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"reply.completed"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"reply.cancelled"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"session.reset"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"session.timed-out"`;
\}
  \| \{
  `code`:   \| `"audio"`
     \| `"connection"`
     \| `"internal"`
     \| `"llm"`
     \| `"protocol"`
     \| `"stt"`
     \| `"tool"`
     \| `"tts"`;
  `fatal`: `boolean`;
  `message`: `string`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"error.reported"`;
\}
  \| \{
  `data`: `unknown`;
  `event`: `string`;
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `type`: `"custom.emitted"`;
\}
  \| \{
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `state`: `unknown`;
  `type`: `"state.updated"`;
\}
  \| \{
  `messages`: \{
     `content`: `string`;
     `role`: `"assistant"` \| `"user"`;
  \}[];
  `meta`: \{
     `at`: `number`;
     `id`: `string`;
  \};
  `toolCalls`: \{
     `afterMessageIndex`: `number`;
     `args`: `z.ZodRecord`\<`z.ZodString`, `z.ZodUnknown`\>;
     `callId`: `string`;
     `name`: `string`;
     `result?`: `string`;
     `status`: `"done"` \| `"pending"`;
  \}[];
  `type`: `"history.restored"`;
\}

###### Returns

`void`

##### playAudioChunk()

```ts
playAudioChunk(chunk: Uint8Array): void;
```

Send a single PCM16 audio chunk (raw binary frame) to the client.

###### Parameters

###### chunk

`Uint8Array`

###### Returns

`void`

#### Properties

##### open

```ts
readonly open: boolean;
```

True when the underlying connection is open and will accept calls.

## Type Aliases

### HostConfig

```ts
type HostConfig = z.infer<typeof HostConfigSchema>;
```

Host-provided agent configuration for a host-mode connection.

***

### ReadyConfig

```ts
type ReadyConfig = z.infer<typeof ReadyConfigSchema>;
```

Protocol-level session config returned to the client on connect.

***

### SessionCommand

```ts
type SessionCommand = z.infer<typeof SessionCommandSchema>;
```

**Client→server** text messages (binary frames carry raw PCM16 audio).

Note there is no `history` command any more. A reconnecting client used to
push its own `messages` back because the server kept no record; the server is
authoritative now and a resume reads the retained event stream by index. See
"One durable session event stream" in the SDK guide.

***

### SessionErrorCode

```ts
type SessionErrorCode = z.infer<typeof SessionErrorCodeSchema>;
```

Error codes for categorizing session errors on the wire.

#### Remarks

The field a client renders its error banner from (`error.reported.code`, and
`SessionError.code` in `@alexkroman1/aai-ui`). Eight values, by where the
failure came from:

- `stt` — speech-to-text: the provider refused the connection, or its stream
  failed mid-utterance.
- `llm` — the model call for a reply failed. In pipeline mode the caller also
  hears `errorPhrase`, so the turn is handed back rather than going silent.
- `tts` — synthesis failed, which is the one the caller cannot hear.
- `tool` — a tool threw and the failure could not be given to the model.
- `protocol` — a frame that does not parse, or one sent in a state that has
  no answer for it.
- `connection` — the session's own link, or a provider's, went away.
- `audio` — the audio path: a rate the transport cannot honour, a decode.
- `internal` — anything the runtime could not classify.

**Severity is `fatal`, not the code**, and the two are independent: any of
these can arrive on a session that continues. `fatal: false` means surface
the message and keep the session interactive. It is REQUIRED: a fatal frame
is not a banner — `aai-ui` answers one by releasing the microphone and ending
the call — so every emitter states which it means rather than inheriting a
default that takes the whole session down.

***

### SessionEvent

```ts
type SessionEvent = z.infer<typeof SessionEventSchema>;
```

One **server→client** session event, envelope included: a fact the session
reports, in the shape it takes on the wire and in the retained stream.

This is what a hook handler receives and what a client parses. Host code
EMITS a [SessionEventBody](#sessioneventbody) and the session's emitter stamps the
envelope — see the module doc.

***

### SessionEventBody

```ts
type SessionEventBody = DistributiveOmit<SessionEvent, "meta">;
```

A session event as its EMITTER writes it — everything but the envelope,
which the session stamps exactly once.

***

### SessionEventMeta

```ts
type SessionEventMeta = z.infer<typeof SessionEventMetaSchema>;
```

The envelope every session event carries.

## Variables

### CLIENT\_CONFIG\_METHODS

```ts
const CLIENT_CONFIG_METHODS: readonly string[];
```

The only method the endpoint answers — read by the host's route dispatch, so
this is the value and not a description of it.

Beside the path for the same reason the path is exported at all: the platform
proxies this route, and `aai-server`'s `GUEST_ROUTE_EXPOSURE` has to name the
verbs the guest answers. A hardcoded `"GET"` on that side would be a second
source of truth for a one-word fact, which is the shape that rots — see
`WORKFLOW_API_METHODS` on `@alexkroman1/aai-runtime` for the same rule on the
workflow route, where it has already cost two incidents.

***

### CLIENT\_CONFIG\_PATH

```ts
const CLIENT_CONFIG_PATH: "client-config" = "client-config";
```

Relative path of the client-config endpoint under an agent's base URL.

***

### ClientConfigResponseSchema

```ts
const ClientConfigResponseSchema: z.ZodObject<{
  greeting: z.ZodOptional<z.ZodString>;
  name: z.ZodOptional<z.ZodString>;
  page: z.ZodEnum<{
     static: "static";
     voice: "voice";
  }>;
  sessionUrl: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
```

Body of `GET /client-config`. Unknown fields are stripped, so a response
from an older server still parses.

***

### EVENT\_ID\_PREFIX

```ts
const EVENT_ID_PREFIX: "evt_" = "evt_";
```

The prefix every session-event id carries, so an id names its own kind.

`evt_` then a ULID — see [SessionEventMeta](#sessioneventmeta) and its `id` field for what
the id is and is not good for. The link names the TYPE rather than the field
because the type is `z.infer`red, so TypeDoc documents it as an anonymous
object and has no anchor to point a member link at.

***

### HostConfigMessageSchema

```ts
const HostConfigMessageSchema: z.ZodObject<{
  audioFormat: z.ZodOptional<z.ZodEnum<{
     pcm16: "pcm16";
  }>>;
  host: z.ZodObject<{
     audioLeadMs: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
     credentials: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
     greeting: z.ZodOptional<z.ZodString>;
     sttPrompt: z.ZodOptional<z.ZodString>;
     systemPrompt: z.ZodString;
     tools: z.ZodArray<z.ZodObject<{
        description: z.ZodString;
        name: z.ZodString;
        parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        type: z.ZodLiteral<"function">;
     }, z.core.$strip>>;
  }, z.core.$strip>;
  sampleRate: z.ZodOptional<z.ZodNumber>;
  ttsSampleRate: z.ZodOptional<z.ZodNumber>;
  type: z.ZodLiteral<"config">;
}, z.core.$strip>;
```

The host-mode handshake frame: the first inbound message on a host-mode
WebSocket connection, carrying the [HostConfigSchema](#hostconfigschema) payload.

A host-mode client sends a single `config` frame that also carries the
audio negotiation fields (`audioFormat`/`sampleRate`/`ttsSampleRate`)
alongside `host`; they are captured here (optional) so the host-mode
handshake can honor the client's requested sample rates instead of
discarding them.

***

### HostConfigSchema

```ts
const HostConfigSchema: z.ZodObject<{
  audioLeadMs: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
  credentials: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
  greeting: z.ZodOptional<z.ZodString>;
  sttPrompt: z.ZodOptional<z.ZodString>;
  systemPrompt: z.ZodString;
  tools: z.ZodArray<z.ZodObject<{
     description: z.ZodString;
     name: z.ZodString;
     parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     type: z.ZodLiteral<"function">;
  }, z.core.$strip>>;
}, z.core.$strip>;
```

Host-provided agent configuration for a host-mode connection: the caller
(e.g. an external evaluation harness) supplies the system prompt, optional
greeting, and tool schemas for a single session instead of using a deployed
agent.

Validated standalone rather than as a `SessionCommandSchema` member — the
host-mode handshake consumes this message *before* `wireSessionSocket`
attaches, so it must never reach `dispatchMessage`/`SessionCommandSchema`.

***

### ReadyConfigSchema

```ts
const ReadyConfigSchema: z.ZodObject<{
  audioFormat: z.ZodEnum<{
     pcm16: "pcm16";
  }>;
  sampleRate: z.ZodNumber;
  ttsSampleRate: z.ZodNumber;
}, z.core.$strip>;
```

Zod schema for [ReadyConfig](#readyconfig).

***

### RestoredToolCallSchema

```ts
const RestoredToolCallSchema: z.ZodObject<{
  afterMessageIndex: z.ZodNumber;
  args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  callId: z.ZodString;
  name: z.ZodString;
  result: z.ZodOptional<z.ZodString>;
  status: z.ZodEnum<{
     done: "done";
     pending: "pending";
  }>;
}, z.core.$strip>;
```

One tool call as a RESUME reports it — see `history.restored`.

Its own schema because the host builds these (`historyFromEvents`) and the
client reads them, so the shape wants one name on both sides. It is deliberately
NOT `tool.called` plus `tool.completed`: those are two live events, and what a
restore sends is their settled JOIN.

***

### SESSION\_COMMAND\_TYPES

```ts
const SESSION_COMMAND_TYPES: ReadonlySet<string>;
```

The set of recognised client→server command `type` values — pass to
 `lenientParse` so a known-but-invalid message warns instead of being
 silently dropped as an unknown forward-compat type.

***

### SESSION\_EVENT\_TYPES

```ts
const SESSION_EVENT_TYPES: ReadonlySet<string>;
```

Every event name, as a set — for `lenientParse`'s known-types argument.

***

### SessionCommandSchema

```ts
const SessionCommandSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
  type: z.ZodLiteral<"audio_ready">;
}, z.core.$strip>, z.ZodObject<{
  type: z.ZodLiteral<"cancel">;
}, z.core.$strip>, z.ZodObject<{
  type: z.ZodLiteral<"reset">;
}, z.core.$strip>, z.ZodObject<{
  bufferedMs: z.ZodNumber;
  type: z.ZodLiteral<"playback_progress">;
}, z.core.$strip>, z.ZodObject<{
  error: z.ZodOptional<z.ZodString>;
  result: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
  toolCallId: z.ZodString;
  type: z.ZodLiteral<"tool_result">;
}, z.core.$strip>], "type">;
```

Zod schema for [SessionCommand](#sessioncommand).

***

### SessionErrorCodeSchema

```ts
const SessionErrorCodeSchema: z.ZodEnum<{
  audio: "audio";
  connection: "connection";
  internal: "internal";
  llm: "llm";
  protocol: "protocol";
  stt: "stt";
  tool: "tool";
  tts: "tts";
}>;
```

Zod schema for session error codes.

***

### SessionEventMetaSchema

```ts
const SessionEventMetaSchema: z.ZodObject<{
  at: z.ZodNumber;
  id: z.ZodString;
}, z.core.$strip>;
```

Zod schema for [SessionEventMeta](#sessioneventmeta).

***

### SessionEventSchema

```ts
const SessionEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
  audioFormat: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  sampleRate: z.ZodNumber;
  sessionId: z.ZodOptional<z.ZodString>;
  ttsSampleRate: z.ZodNumber;
  type: z.ZodLiteral<"session.configured">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"audio.completed">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"speech.started">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"speech.stopped">;
}, z.core.$strip>, z.ZodObject<{
  eotConfidence: z.ZodOptional<z.ZodNumber>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"user-transcript.updated">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"user-transcript.committed">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  text: z.ZodString;
  type: z.ZodLiteral<"agent-transcript.updated">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  recovery: z.ZodOptional<z.ZodEnum<{
     session-failed: "session-failed";
     turn-failed: "turn-failed";
  }>>;
  text: z.ZodString;
  type: z.ZodLiteral<"agent-transcript.committed">;
}, z.core.$strip>, z.ZodObject<{
  args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  toolCallId: z.ZodString;
  toolName: z.ZodString;
  type: z.ZodLiteral<"tool.called">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  result: z.ZodString;
  toolCallId: z.ZodString;
  type: z.ZodLiteral<"tool.completed">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"reply.completed">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"reply.cancelled">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"session.reset">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"session.timed-out">;
}, z.core.$strip>, z.ZodObject<{
  code: z.ZodEnum<{
     audio: "audio";
     connection: "connection";
     internal: "internal";
     llm: "llm";
     protocol: "protocol";
     stt: "stt";
     tool: "tool";
     tts: "tts";
  }>;
  fatal: z.ZodBoolean;
  message: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"error.reported">;
}, z.core.$strip>, z.ZodObject<{
  data: z.ZodUnknown;
  event: z.ZodString;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  type: z.ZodLiteral<"custom.emitted">;
}, z.core.$strip>, z.ZodObject<{
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  state: z.ZodUnknown;
  type: z.ZodLiteral<"state.updated">;
}, z.core.$strip>, z.ZodObject<{
  messages: z.ZodArray<z.ZodObject<{
     content: z.ZodString;
     role: z.ZodEnum<{
        assistant: "assistant";
        user: "user";
     }>;
  }, z.core.$strip>>;
  meta: z.ZodObject<{
     at: z.ZodNumber;
     id: z.ZodString;
  }, z.core.$strip>;
  toolCalls: z.ZodArray<z.ZodObject<{
     afterMessageIndex: z.ZodNumber;
     args: z.ZodRecord<z.ZodString, z.ZodUnknown>;
     callId: z.ZodString;
     name: z.ZodString;
     result: z.ZodOptional<z.ZodString>;
     status: z.ZodEnum<{
        done: "done";
        pending: "pending";
     }>;
  }, z.core.$strip>>;
  type: z.ZodLiteral<"history.restored">;
}, z.core.$strip>], "type">;
```

## References

### ClientConfigResponse

Re-exports [ClientConfigResponse](workflow-api.md#clientconfigresponse)
