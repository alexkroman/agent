# Demo script — End-of-Day Debrief

Read this aloud in one take: hold the talk button (or record it as an audio
file and upload it), then press **Go**. It is deliberately disfluent — the
fillers, false starts, and self-corrections are part of the demo, because the
extraction step acts on final intent and reports every guess it makes.

## The ramble (~90 seconds)

> Okay, uh, end of day. So — finished up the Hendersons' inspection this
> afternoon. Furnace is fine, but their water heater is on its last legs,
> it's leaking at the base, needs replacing. Quote them, um... let's say
> around eighteen hundred dollars, that's parts and labor. Oh and go ahead
> and order the water heater — the fifty gallon one, same as we put in on,
> uh, the Miller job. Then set up a follow-up with the Hendersons for, let's
> do Wednesday — no wait, I've got the county thing Wednesday — make it
> Thursday morning. And, uh, last thing, shoot Mike a message: the Oak
> Street job is gonna slip a day, the drywall guys didn't show, so tell him
> Oak Street is now looking like Friday instead of Thursday.

## What one run should produce

Four actions extracted from one clip, then executed and reported:

| Action | Tool | Expected outcome |
| --- | --- | --- |
| Quote the Hendersons ~$1,800 for a water heater replacement | `file_quote` | Filed to the app database with a record id; **assumption reported**: "around eighteen hundred" → 1800 |
| Order a 50-gallon water heater | `order_part` | Ordered, linked to the Hendersons; may assume the model from "same as the Miller job" |
| Follow-up with the Hendersons | `schedule_followup` | Scheduled for **Thursday morning** — the Wednesday false start must be dropped, not scheduled |
| Message Mike about Oak Street | `send_message` (Slack) | One message sent: Oak Street slips a day, Friday instead of Thursday |

The run report should have one line per action — filed/ordered/scheduled/sent
with the key values and record id, `ASSUMED` for each guess, `SKIPPED` (with
the missing value named) for anything it could not do.

## Variations worth showing

- **The self-correction**: the Wednesday → Thursday flip is the money shot —
  a chat agent would ask "Wednesday or Thursday?"; the workflow just takes
  the final value and moves on.
- **A missing value**: drop the amount ("quote them for the water heater")
  and the quote line should come back `SKIPPED: no amount stated` rather
  than an invented number.
- **No Slack webhook**: without `SLACK_WEBHOOK_URL` set, the notify action
  fails as a tool error and the report says the message was **not** sent —
  the other three actions still land.

## Setup

```sh
aai secret put SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...  # deployed
# or put it in .env for `aai dev`
```

Only `ASSEMBLYAI_API_KEY` is needed for STT + the LLM (one key, gateway
model). Runs are independent — press record and ramble again for a fresh
debrief.
