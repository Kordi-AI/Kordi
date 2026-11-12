# The Facilitator

The Facilitator is Kordi's neutral group agent. It helps members compare
options, make shared decisions, and clarify next steps on a service model
configured by the operator. The System account still posts server notices
with the front-facing Kordi bird. Stored identifiers retain the former PiP
name for compatibility.

Kordi runs two agents on its own service credentials: the System agent described here, and
Kordi Support, which people chat with directly. In code, "system agent" as a
contact kind (`system_agent`) means Support's direct chat contact, not this
agent.

## Responsibilities

| Job | What the System agent does | Code |
| --- | --- | --- |
| Group plans | A standing member of group conversations other than Grounding groups. It can propose a schedule, open a time or place poll, and send event reminders. Members vote, RSVP, and confirm on the card. | `bridges/cloud-server/src/system_agent/`, `plan_cards/` |
| Shared workflows | Proposes decision polls, Memory drafts, and assignments. Members vote or save a Memory draft, managers confirm decisions, and only the assignee can approve a handoff to their agent. | `bridges/cloud-server/src/system_agent/workflows/` |
| Group documents | Drafts and attaches a Markdown document when a new member request clearly asks for one. | `bridges/cloud-server/src/system_agent/draft.rs` |
| Grounding | Card builds, matching and group intros run on its service credential. Grounding is available only while the System agent is configured (`common_ground::available`). | `bridges/cloud-server/src/common_ground/` |

These are not System agent jobs:

| Job | Who runs it |
| --- | --- |
| Proactive | Your own agent watches your groups and asks you before it helps. It runs on your accounts, on your Mac first, and nothing reaches the group until you allow it ([proactive agent](development/proactive-agent.md)). |
| Digest | Your own saved provider accounts generate your private digest ([rolling digest](rolling-digest.md)). Group plans the System agent manages outrank digest suggestions (see below). |
| System notices | Grounding notices and group joined lines come from the System account `acct_kordi_system`, which calls no model. |
| Kordi Support | A separate Kordi-run agent with its own account and key that people chat with directly (`bridges/cloud-server/src/support/`). |

The rule: a job that acts for one person, reads their private data, or spends
on their behalf belongs to that person's agent and accounts. A job that serves
everyone in a conversation runs on the System agent.

## Identity

The System agent mirrors the Kordi Support agent's plumbing: a system account,
a locked agent definition, a default agent profile so member listings render
it, and a `ServiceProviderAuth` credential resolved at run time from server
configuration. It is bootstrapped at server start and joins every existing
group conversation; new groups get it at creation. Direct and AI sessions are
excluded until both clients render a third member there.

Stored identifiers keep the old name: the account `acct_kordi_pip`, the agent
definition `cloud_agent_kordi_pip`, run ids starting with `pip_`, the
credential ids `pip-service-openai` and `pip-service-api-key`, and the
`cloud_pip_conversation_state` table. Both clients recognise the account by
its id and show it as Facilitator.

## Configuration

Google Cloud deployments use workload identity and explicit Vertex model IDs; see
[Service models on Google Cloud](service-models-google-cloud.md). The OpenAI
settings below remain available for existing deployments and isolated fixtures.
Resource pool configuration can select a different provider and model for
each organization. Set an explicit model through one of these sources
before enabling the service. An approved assignment uses the assignee's
agent configuration and execution route.

| Variable | Meaning |
| --- | --- |
| `KORDI_SYSTEM_AGENT_PROVIDER` | `vertex-ai` selects Google Cloud; omitted or `openai` retains the existing provider |
| `KORDI_SYSTEM_AGENT_VERTEX_MODEL` | Explicit model ID for the Vertex Chat Completions endpoint; no default |
| `KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED` | `false` keeps Grounding available while disabling group-plan automation |
| `KORDI_SYSTEM_AGENT_OPENAI_API_KEY` | Service key for the configured OpenAI-compatible provider |
| `KORDI_SYSTEM_AGENT_ENABLED` | `false` switches it off; `true` without a complete provider configuration is an error |
| `KORDI_SYSTEM_AGENT_OPENAI_MODEL` | Required model ID for the OpenAI-compatible route. Also accepts the shared `KORDI_SERVICE_MODEL_MODEL` setting. |
| `KORDI_SYSTEM_AGENT_OPENAI_BASE_URL` | OpenAI-compatible gateway; https only (plain http for loopback); defaults to the OpenAI API |
| `KORDI_SYSTEM_AGENT_ACCOUNT_ID`, `KORDI_SYSTEM_AGENT_AGENT_ID`, `KORDI_SYSTEM_AGENT_AGENT_NAME`, `KORDI_SYSTEM_AGENT_AGENT_SUBTITLE`, `KORDI_SYSTEM_AGENT_OWNER_EMAIL` | Identity overrides; defaults are fine for every environment |

Each setting still accepts its old `KORDI_PIP_*` name, so deployments that set
the old names keep working; the new name wins when both are set.

With the System agent off, Grounding is off too: the server stops advertising
`commonGroundVersion` and the clients hide Grounding. A test stack that needs
Grounding must configure a service model.

The isolated development stack passes these through `deploy/dev/compose.yaml`
from the ignored `deploy/dev/.env` file.

## Persona and playbook

The [Facilitator skill](../bridges/skills/facilitator/SKILL.md) defines
how the model chooses a useful action in the language of the group. It can
stay silent, reply briefly, propose a plan or group workflow, or draft a
document. A direct mention and a quiet batch of group messages use the same
semantic response format.

Members retain control of shared actions. Only members vote, RSVP, confirm,
or cancel a plan. An assignee's approval posts an explicit mention of their
agent and creates a queued group reply. The agent updates that same reply
through processing and completion. The handoff carries the approved task
title and deliverable as its context.

Confirming with an option marks everyone who voted for it as attending.
Confirming adds the plan to every attending member's Kordi calendar
(`bridges/cloud-server/src/plan_cards/calendar.rs`), keyed by the card so
later changes update the same entry; a decline or a cancellation removes it.
It never reads or writes anyone's personal calendar.

## When the System agent spends a model call

It is on in every group once its provider is configured, unless
`KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED=false`. Resource pool admission applies
configured run and spend limits. A five-second sweep considers these signals:

| Trigger | Condition |
| --- | --- |
| New messages | A member (never the System agent itself) wrote, and the chat has been quiet for 30 seconds, or 2 minutes have passed since the first unseen message |
| Card changed | Votes or answers moved the card past the revision the System agent last saw and it has been quiet for 45 seconds |
| Reminder | An open plan starts within 24 hours or 2 hours and that reminder has not gone out |

Every condition reads the same card as the run input, the newest one not
canceled, and one reminder window at a time, so a chat the sweep selects
always yields a hook or moves its cursor instead of being selected again on
the next tick. The System agent records the revision it saw when a run starts
and after each of its own card actions, so its own calls never wake it, while
a vote cast during a run still does.

Ordinary member messages are batched until the conversation is quiet
(`KORDI_SYSTEM_AGENT_SILENCE_MINUTES`, 10 minutes by default). A direct mention
can run after the initial sweep debounce. The model interprets the bounded
snapshot, including deciding to stay silent on small talk. Semantic runs
make one model decision with a 1,536 output token limit. Recording member
actions and refreshing cards use no model calls.

### What a run sees

| Part | Limit |
| --- | --- |
| Messages | The newest 30, each cut to 400 characters, 6,000 characters in total; card-only messages are left out; `isNew` marks unseen ones |
| Members | Everyone up to 40; in a larger group the people speaking and on the card first, plus `memberCount` |
| Open card | Counts for going, declined, pending, and voted; each option's `voteCount`; above 30 participants only the organizer and people who have not answered are named |
| Tool results | The same compact card, never the full voter list |

## How the System agent and the digest stay out of each other's way

- The digest does not read the System agent's messages. They are
  coordination, not anyone's commitments, and reading them would rerun every
  member's digest each time a vote refreshes a card.
- Confirmed plans reach the digest as calendar events whose id starts with
  `plan:`. The digest treats them as confirmed context and never proposes
  updating or deleting them
  (`bridges/cloud-server/src/digest/system_agent_guard.rs` drops any such
  suggestion).
- Group plans outrank the digest. A create suggestion is dropped when it is
  the same arrangement as a plan the System agent tracks: it comes from that
  plan's chat at a nearby or unknown time, or it starts within 90 minutes of a
  plan event on the person's calendar and shares a meaningful title word. The
  rule runs when a digest is produced and again the moment a plan is
  confirmed, which removes competing suggestions from every member's saved
  digest without waiting for their next run.
- A calendar the System agent writes or removes marks that person's digest as
  changed, so it catches up after its quiet window like any other change.

## How a run happens

1. A five-second sweep (`bridges/cloud-server/src/system_agent/worker.rs`)
   selects conversations with the triggers above. Selection is an atomic
   per-row reservation, bounded to ten conversations per pass.
2. The sweep queues one cloud run (`pip_` prefix) whose prompt is a bounded
   JSON snapshot (`bridges/cloud-server/src/system_agent/input.rs`) within the
   limits above, and the hooks that woke the agent.
3. The runner reads the configured provider and model. A conversation or
   direct request run returns one structured action. Scheduling proposals
   from that response use the same server handler as the `plan_card` tool
   used by the other triggers.
4. The server validates group membership, source messages, and the requested
   action. Only scheduling proposals can be submitted through the runner.
   Member actions use the authenticated card routes.
5. The server publishes the card or attached document and any separate chat
   reply. Handled reminder hooks are stored to avoid duplicate reminders.

Failures back off at 1 minute, 5 minutes, 30 minutes, 2 hours, then 12 hours
between attempts (`bridges/cloud-server/src/system_agent/retry.rs`). Progress
is never reset on failure, so a persistently failing provider costs a handful
of calls per day, not thousands. A chat whose run expired or ended without
clearing its reservation is released on the next stale-run check.

## How the card reaches the clients

A plan shows as two separate cards, each its own card-only message apart from
the System agent's text: a vote card while the group chooses between options,
and a calendar card for the plan itself, posted when a single option is
proposed or a vote is confirmed. Both refresh in place after each successful
tool action, including date, time, and location changes, even if a later step
in the run fails. Each card message carries a single `plan_card` block with a
`view` of `vote` or `event`: the card's identity, state, title, time, place,
options with votes, unresolved fields, and every participant's RSVP. macOS
(`app/desktop/src/kordi-app/components/planCard.tsx`) and iOS
(`app/ios/Kordi/Features/Conversation/PlanCardView.swift`) render the block as
a compact card in the style of the Kordi Support permission card: while the
card polls, the options are the buttons; otherwise "I'm in" and "Can't make
it", plus a Confirm button for the organizer and chat admins while the plan is
awaiting confirmation. Confirmation requires an exact start date and time, but
does not require every member to respond. Unanswered members remain pending,
including an admin who confirms without choosing "I'm in". Only attending
members get personal calendar entries. Cancel and reopen remain restricted to
the organizer or a chat admin. Card instants are always RFC 3339 with an
offset. Clients display the viewer's local time with a timezone label. The
System agent uses an explicitly named timezone or the event location's
timezone before falling back to the organizer's timezone, and applies clear
message corrections to the same card. For a concrete replacement, the System
agent proposes the full revised details directly, without a separate reopen.
Validation and replacement share one mutation: a rejected replacement preserves
the prior card and its calendar entries. Invalid time ranges return an actionable
validation error. A successful replacement resets affected attendee answers and
awaits confirmation before recreating the same per-member calendar event IDs.
The runner only submits proposals. When details are unclear, the Facilitator can ask a question. Authorized members can reopen plans from the card.

A member's button press goes to `POST /v1/cloud/plan_cards` as that member. On
`plan_card_revision_conflict`, desktop and iOS read the latest snapshot from
`GET /v1/cloud/plan_cards/:event_id`, which requires active conversation
membership. They refresh the card without replaying the rejected decision;
the member can review the new details before confirming again. A failed
refresh remains an actionable error. While an action is pending, the card
keeps its displayed snapshot; afterward it uses the newest available revision
and retains its last successful snapshot if the action fails.

Votes and answers apply at any revision, so a member is never told to refresh
first. After a successful change the route refreshes the card inside the
newest System agent message that carries it, in place and without an edit
marker, so every device shows the response on the card itself. No chat line
and no model run is spent on a vote; the System agent's own messages stay
reserved for guiding the group, and a later sweep lets it react when the
votes change what happens next.

A transcript shows one card per plan. Only the newest message carrying a
card renders it, at the newest snapshot known for that plan; every earlier
copy keeps just its text.

## Scope

The Facilitator operates in group chats. A member's agent performs an
assignment only after the assignee approves it on the card.

## Validation

Unit coverage: `cargo test -p kordi-cloud-server --lib system_agent::`,
`cargo test -p kordi-cloud-server --lib plan_cards::` and
`cargo test -p kordi-cloud-agent-runner --lib system_agent::`. The database
tests for the sweep query, card lifecycle, votes, participant membership, and
run scope run against a task-owned PostgreSQL database:
`KORDI_DIGEST_TEST_DATABASE_URL=... cargo test -p kordi-cloud-server --lib -- --ignored system_agent:: plan_cards::`.

Validated on the isolated development backend (2026-09-16, as PiP) with two
synthetic accounts in a fresh group, a Kordi-operated key, and no @-mention
anywhere:

| Step | Messages | The System agent's action | Card |
| --- | --- | --- | --- |
| Proposal | organizer proposes two options, peer picks one, organizer locks it | propose, then confirm; posts one message | revision 3, `confirmed`, organizer yes, peer pending |
| Partial decline | peer: "I can't make it on Saturday anymore" | rsvp no on the peer's behalf; posts one message | revision 4, still `confirmed`, peer no |
| Organizer cancels | organizer: "cancel lunch for everyone" | cancel; posts one message | revision 5, `canceled` |

Every step produced exactly one cloud run, about 20 seconds after the last
message; no run failed and the agent's own messages did not queue a further
run. Manual runner calls also confirmed that a member's own call may not act
for another member while the System agent's run may, inside its own
conversation only.

Two failure modes found and fixed during validation: the model sends optional
strings as `""` (an empty `existingEventId` is now a new card, not a missing
one), and it may send ambiguous times (`startAt`/`endAt` now require an RFC
3339 offset and return a 400 that explains the format).

### Optional provider fallback

Development runners can configure `KORDI_SYSTEM_AGENT_FALLBACK_API_KEY`,
`KORDI_SYSTEM_AGENT_FALLBACK_BASE_URL` (HTTPS), and
`KORDI_SYSTEM_AGENT_FALLBACK_MODEL` in the private development environment
file (the old `KORDI_PIP_FALLBACK_*` names still work). Leave the key unset to
disable fallback. The current provider remains primary. On a provider error,
or after 90 seconds without its response, the System agent switches once to
the configured OpenAI-compatible provider and continues with the same tool
history. Completed card actions are not replayed. A failure of the fallback
ends the run and uses normal backoff. Never commit the key or put it in
workflow logs.
