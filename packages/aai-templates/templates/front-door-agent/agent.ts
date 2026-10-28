import { agent } from "@alexkroman1/aai";
import { askDigest, pairPhone, pairStatus, ring } from "./routes.ts";

// A smart front door. Visitors ring and talk to the house; the owner's phone, linked to
// the door, sees each visit live and is told when someone leaves a message, even when the
// conversation at the door is long over.
//
// One page (client.tsx) is both ends. Opened at the door it is the DOOR: its own ?client=
// id, a Ring button, a conversation. Opened on the owner's phone and linked, it is the
// door's TWIN: it sends the door's id (createLinkedClient), holds the door's inbox
// (useInbox), and watches the door's sessions as they happen.
//
// Linking is a spoken code. The phone asks POST /api/pair, which mints six digits and
// starts a `pair` run keyed by the code's HASH (workflows/pair.ts); the owner reads the
// code to the door, whose link_phone tool hashes what it heard and signals the run waiting
// under that key. The platform gives an agent no database, so a pending link is a run.
//
// Telling the phone is stepNotifyClient from the `announce` run: a visitor's message
// (tools/leave_message.ts), or a ring from real doorbell hardware posting a signed
// Standard Webhooks delivery to POST /api/ring. `digest` reads the door's own log of the
// day with stepClientTranscript and sends the phone a summary.
//
// Set DOORBELL_WEBHOOK_SECRET for the hardware ring; everything else is keyless.
export default agent({
  name: "Front Door",
  listing:
    "A smart front door: visitors ring and leave messages, and your linked phone hears about it",
  greeting: "Hello, you've reached the front door. Who's there?",
  routes: {
    "POST /pair": pairPhone,
    "GET /pair/:runId": pairStatus,
    "POST /digest": askDigest,
    "POST /ring": ring,
  },
});
