# Agent communication with Mac-first execution

`reach_out` sends an explicit question to an agent in the same conversation.
It returns a delivery receipt, not a fabricated answer. The first turn ends;
the recipient's answer queues a continuation of the original agent's task.
The public question and recipient reply are canonical chat messages. A
continuation publishes only new useful work requested by the user, not a
confirmation, quotation, or paraphrase of the reply already in this conversation.

The parent yields with the internal `{"agentExchangeOutcome":"waiting"}`
completion. Both publishers consume it before storing a terminal synchronization
event: the message text is empty and the outcome lives in metadata. The read
model retires progress without rendering a bubble, including replay and legacy
records whose transport status is received, delivered, or read.
On resumption, `{"agentExchangeOutcome":"silent"}` acknowledges that no
additional work is needed. The server accepts it only for a continuation with
a public reply, atomically completes the run and exchange, and creates no
message. An empty answer, failed provider, silent recipient, or timeout without
a public reply is not a successful silent completion. Retries retain the same
lease checks and idempotency as a visible result.

Streaming snapshots buffer reserved outcome prefixes before they can render.
Owner-local overlays, peer progress, and stored progress use the same rule; a
terminal failure clears internal visibility metadata and remains visible. This
also prevents a control token from flashing before the final acknowledgement.

The continuation's original request comes from the canonical triggering
message, including after further delegation. An executor prompt may contain
conversation history; that history must not become a list of unfinished tasks.

The server owns a durable exchange record, not the model execution location.
Each recipient and continuation is an ordinary run: a ready owner Mac gets
its existing preference window and execution lease. Eligible cloud fallback
uses that same run after the window expires. Existing project-device rules
still apply. No laptop-to-laptop bridge or inbound Mac listener is needed.

## Ongoing discussions

The agent mentioned first leads the request; agents mentioned later are its
discussion partners. Only the leading agent runs, and its prompt keeps the
partner's mention so it can `reach_out` to it. When the sender's own agent
leads in a direct or group chat, it runs on the sender's Mac as the owner's
own request, which is the only kind of run that may reach other agents.

An owner can ask agents to keep talking, discuss, or align. Each continuation
may answer back with one new `reach_out` to the same agent and yield with
`waiting` again; the next reply queues the next continuation. The discussion
ends when its goal is reached, the other agent has nothing new, or the root's
budget of eight exchanges is spent. The final continuation always publishes a
short closing summary of two or three lines: what was agreed or found and
anything left open. A continuation that asks again stays a quiet yield, and
a single question still finishes silently. The continuation prompt carries
`remainingRequests` and the earlier answered rounds of the task. A follow-up's
recipient receives the earlier rounds with that same requester. Both are
public messages of this conversation, sent as untrusted data and clipped to a
fixed size.

## Delivery and recovery

- Sending the same tool call again returns the same receipt. A replayed call
  with the same parent, target, and question also returns that receipt.
- A reply is stored separately from acknowledgement that its continuation
  finished. Human read receipts never advance agent processing state.
- Desktop discovery and cloud leasing reconcile durable records. Restarting
  either process does not require a process-local callback to find the reply.
- An expired desktop claim can be rediscovered. New local request IDs include
  the claim, and stale executors cannot publish through the new lease.
- Duplicate completion is idempotent. A single exchange can create only one
  recipient run and one continuation run. Model/tool execution is at least
  once after a crash; external side effects still need their own idempotency.
- An unavailable recipient or a ten-minute deadline produces an explicit
  failure result for the original agent. It is never presented as a reply
  from the recipient. Cancelling the root prevents its continuation.

The design borrows SwarmChat's separation of durable message delivery from
independent agent execution and its recovery through rereading pending work.
Kordi uses its existing PostgreSQL transactions, canonical chat, and fenced
leases, rather than adopting a second message server or chat read cursor.

## Authorization

Only a live execution lease for an owner's own request can send outreach to
agents; another person's request can only ask that person (see below).
Targets must be active agents belonging to current conversation members;
custom agents must allow participant conversations. Handles must be unique,
or the caller must supply the exact agent ID. Both execution and publication
revalidate membership and the original source request. A removed member or
deleted source cancels pending work. Replies are untrusted conversation data,
not permission to access private resources. No project files, hidden history,
or credentials are automatically attached. Shared recipient turns cannot
redelegate; they may only ask their own owner. A root task has a bounded budget of eight exchanges.

The desktop checks server capability before advertising `reach_out`. Both
local engines hide it without an attached runtime. Cloud leases explicitly
advertise support, so older servers do not create a false tool promise.

## Validation

Database regression tests use three disposable synthetic accounts and cover
request deduplication, Mac priority, expired-lease recovery, stale completion,
reply/continuation idempotency, direct chat, revoked membership, and timeout.
Frontend tests cover concurrent discovery, rediscovery after a failed claim,
lease loss, stored routing, and retrying a lost completion acknowledgement.
Regression tests also cover silent completion on Mac and cloud, stale claims,
completion retries, missing replies, hidden progress, and useful follow-up output.
Real test-client validation must additionally check visible messages and the
continued response. It must preserve the existing profiles and account data.

## Queue and acknowledgement reference

[SwarmChat's design](https://github.com/Pranjal2041/swarmchat/blob/main/DESIGN.md)
and its `swarmchat/client.py` wait implementation separate message delivery from
acknowledgement. Waiting starts at a saved position; unconfirmed deliveries can
be received again after interruption. Acknowledgements travel as protocol data,
not chat messages. Its viewer does not move an agent's read position.

Kordi uses durable per-exchange request, reply, and processed state instead of
reusing a person's chat read cursor. Polling discovers pending work; a fenced
Mac-first lease controls execution. Completion acknowledgements are idempotent,
and recovery republishes no question or reply that already has a durable ID.
Terminal synchronization metadata retires UI progress without assistant text.

The public question carries durable waiting, processing, and terminal metadata. State changes update that same canonical message and sync version; they never append another acknowledgement. The UI shows waiting/processing on the question until the continuation is acknowledged, including after history replay. Ordered text segments are sanitized after live/history merging, because they may arrive before the aggregate assistant text.

The recipient also has a durable pending response under its own identity. Its
answer replaces that row in place, retaining the message ID, timeline sequence,
and group timestamp. A pending row is not a received reply and never permits a
silent continuation. Cancellation, lost membership, and timeout retire it as
synchronization-only metadata. Group envelopes retain the conversation's stored
group space, which can differ from the channel's session ID.

The client replay coordinator acknowledges each message revision separately.
A completed replay key for the question must not suppress its later processing
or completion revision, even though all revisions share one canonical message.

## Asking a person

`reach_out` also asks a person in the same conversation (`targetKind`
`person`, an exact account ID or a unique @handle). Nothing runs for the
person. The server records a person exchange (migration 188), posts the
question as the agent's visible message mentioning them, and marks it waiting
for that person by name; Mac shows "Waiting for <name>" on the question.

The answer is the person's next human message in the conversation after the
question, or their reply, quote, or thread reply to it. Their agent's
messages, forwards, replies to other messages, messages before the question,
and messages that ask an agent for something (a new request, routed as usual)
never count. With several open questions to the same person, a reply
to one question answers that question; any other message answers the oldest.
Matching runs when the message is stored and again in the reconcile sweep, so
a missed hook is recovered from durable records. The answer then resumes the
asking agent through the ordinary continuation, with person-specific wording.

People get 24 hours. When the deadline passes, the continuation states that
no answer arrived and the agent says so instead of inventing one. Each
question counts toward the task's budget of eight. Targets are active
members, not service accounts, and not blocked either way. Leaving the
conversation cancels a pending question.

In a direct or group conversation a plain follow-up does not reach an agent,
so the person who made the request is a target too (listed with `requester`).
When the agent needs their input before it can finish, guidance tells it to ask
with `reach_out` instead of ending its turn with a question; their next plain
message, or a reply to the question, continues the task in the language of the
request, never silently. The question carries `agentExchangeWaitingForAccountId`,
so the asked person's own Mac shows "Waiting for your reply" while others see
the name (`agentExchangeWaitingForRequester` additionally marks the owner's own
question to themselves, for older clients). A new request from them to the
same agent supersedes and cancels the open question. In the owner's private
agent chat every message already reaches the agent, so nobody there is a target.

A run requested by someone other than the agent's owner may ask only that
requester: the capability lists no agents and only them, any other target is
refused, and owner-private tools, calendar, and connectors stay unavailable.
The continuation keeps the same owner and requester and the same limits. A
run that answers another agent's request, or a child task, cannot ask anyone.

## Conversation context

The system prompt prefix stays the same from run to run of an agent in a
conversation, so providers can reuse it: it carries only stable guidance
(including the reach_out rules), never per-run data. Per-run data goes to the
tail of the context:

- The turn identity (request, requester, policy) and a short runtime note:
  the current time in the owner's time zone (else UTC), the members only when
  they changed since the agent's previous run in this conversation, and whom
  reach_out can reach for this request. The Mac stores it as a hidden message
  before the request; the cloud runner sends it after the history (OMP: a
  trailing message after the request). Every direct or group run carries it
  from admission (`turn_identity`), whichever executor takes the run.
- `read_session mode=info` returns the conversation kind and title, active
  people with display name and @handle (owner and requester marked), their
  agents and whose they are, each person's profile location and time zone
  when set (not for people who declined AI), the current time, this task's
  open questions, and live plan cards (summary). It is scoped to the run's
  lease on the cloud runner and the Mac. Names and profile fields are
  untrusted data.

Stable guidance tells agents to use it instead of asking who is in the chat,
where they are, or what day it is, and to reply in the language of the
current request. Model and thinking-effort change notices never appear in
run history.

## Answering agents ask their own owner

A run answering another agent's request may ask its own owner, and nobody
else, through a person exchange (for example to confirm what it may share).
It ends its turn with `waiting`; the asking agent's request then waits for
that owner (its deadline extends past the owner's 24 hours and its question
shows who it waits for). The owner's reply continues the answering agent,
and its answer is published as the reply to the asking agent, which resumes
as usual. When an agent cannot answer, the asking agent's continuation asks
that agent's owner directly as a person instead of posting open questions.

## Processing rows for runs without a mention

A run started by an exchange rather than a fresh mention shows its processing
row as soon as the run exists, for both the Mac and the cloud runner: the
answering agent's reply row is created with the question, and an asking
agent's continuation row is created with its resume run, replying to the
answer it continues from. The run's answer replaces that row in place. A run
that ends silently or waits retires the row (complete, empty, synchronization
only); a failure shows the failure and a stop shows "Stopped". The server
ends every such row, so the desktop keeps it without a heartbeat.
