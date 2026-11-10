# Event RSVP proposal

Browser-only proposal: the Edit event dialog shows who is going, who can't make
it and who has not replied when the event came from a group plan card. It uses
sample people and a sample chat, loads no network resources, and changes nothing
outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/event-rsvp
python3 -m http.server 8762 --bind 127.0.0.1
# open http://127.0.0.1:8762/
```

Query parameters (kept in sync with the controls):

| Parameter | Values | Default |
| --- | --- | --- |
| `device` | `mac`, `ios` | `mac` |
| `theme` | `light`, `dark` | `light` |
| `variant` | `both`, `a`, `b` | `both` |
| `rsvp` | `mixed`, `all-going`, `no-replies`, `not-from-card` | `mixed` |
| `role` | `member`, `organizer` | `member` |
| `load` | `ready`, `loading` | `ready` |

## Dialog

The Mac dialog keeps today's `.digest-sheet` fields, order and footer (Title,
Start time, End time (optional), Remind me, the timezone line, Remove event /
Cancel / Save event). The iPhone sheet keeps the `DigestEventEditor` rows in the
flat Settings-sheet style. Only events that came from a plan card get the new
People section; `rsvp=not-from-card` shows the dialog unchanged.

- Header: "People" and the card's counts ("2 going · 1 can't · 1 no reply").
- Your answer: "Can't make it" / "I'm in", the same actions as the card. A
  calendar event from a card exists only while you are going, so "I'm in" is
  the current state. "Can't make it" asks once, then the event leaves your
  calendar (Undo answers "I'm in" again). The organizer gets no buttons, as on
  the card.
- "Planned with the System agent in Friday crew." stays as the closing line.

## Variants

- **A · Grouped list**: Going, Can't make it and No reply, each with avatar and
  full name; the organizer is tagged. Mac lays the groups out as columns; iPhone
  stacks them as rows. Empty groups are hidden.
- **B · Avatar row**: one row of faces sorted going, no reply, can't, each with
  a status badge (check, dots, cross) and a first name; the full name, status
  and role are in the tooltip and accessibility label.

## Data

A card's calendar event id is `plan:<eventId>` (`plan_cards/calendar.rs`), so
the client can read the card with the existing member-checked
`GET /v1/cloud/plan_cards/:eventId` when the dialog opens and act with the
existing `rsvp` action. Nothing about other people is copied into the private
calendar row, and someone who leaves the chat stops seeing answers.
