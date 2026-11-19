# Account deletion

An account is deleted in one of two ways: by the person, through
`POST /v1/cloud/account/security/delete`, or by an operator, through the
[`delete-accounts` command](#operator-command). Both run the same steps. They
differ only in [direct conversations](#direct-conversations): the person's own
deletion empties them, an operator's keeps them for the other person.

`POST /v1/cloud/account/security/delete` deletes the signed-in account. It
takes the same proof as the other [account security](account-security.md)
changes: `currentPassword` when the account has a password, otherwise
`verificationId` and `verificationCode` from `POST /password/code`, or a
sign-in within the last ten minutes. It answers `204`, and every session and
token of the account stops working at once; a web page that called it with
its session cookie also gets both web session cookies cleared. From then on
every credential of the account is answered with `account_deleted`; see
[For clients](#for-clients).

```json
{ "currentPassword": "…" }
```

Errors are the security page's: `current_password_required`,
`reauthentication_required`, `invalid_current_password`, code errors,
`account_changed` (the password or email changed meanwhile), and
`rate_limited`. An emailed code is spent before anything is removed, so a
wrong code changes nothing.

## What happens

Owner decision B1: people keep what they wrote to each other, but nothing
identifies the deleted person.

- **Groups other people are still in** are kept. A group the person owned
  passes to the longest-standing admin, else the longest-standing active
  member, in each of its conversations. Their messages stay and are shown
  as **Deleted account**: they move to the server-managed stand-in account
  `acct_kordi_deleted` ([`src/deleted_account.rs`](../../bridges/cloud-server/src/deleted_account.rs)),
  which joins the conversation as a member who left so clients can name the
  sender. Their name, handle, avatar and email are scrubbed from every stored
  message of the conversation (group envelopes list every participant), and
  their attachments are removed from the messages. Free text that mentions
  them by name is not rewritten.
- **Direct conversations** another person is still in depend on who deletes
  the account; see [Direct conversations](#direct-conversations).
- **Conversations with no other active person** are deleted.
- **Everything else the account owns** is deleted with the account row:
  uploads, avatars, memories, connectors, agents, runs, scheduled tasks,
  devices, sessions, contacts, Grounding cards, and the personal
  organization. Other organizations lose the member; when the last owner
  goes, the longest-standing admin is promoted (migration 0168).
- Plan cards and agent-session requests they made in conversations others
  keep, and comments they left on other people's documents (with the replies
  to them), are kept from the stand-in.
- Other people's digests built from their messages are cleared and rebuilt
  without them, synced copies of emptied direct conversations are deleted,
  and access waitlist requests and pending sign-up codes under any of their
  emails are removed.
- Quote, forward and thread references (`messageAction.source`) in kept
  conversations that point at one of their messages, by its stored id, its
  client id or the id inside its group envelope, show **Deleted account** as
  `senderLabel`. The reference's `textPreview` is free text and stays, and
  its `sourceSessionId` is never rewritten: no `session:…` id is, so a
  reference into a kept direct conversation still names the deleted account
  like the conversation's own session id does, and jump-to-message keeps
  working.

Signing up again with the same email, or signing in with the same Google,
GitHub or Apple account, creates a new account with a new id. Nothing of the
deleted account is reachable from it: no contacts, conversations, memories,
devices or organizations.

Remaining members get `membership.updated` for each kept conversation and
`message.updated` for up to 200 of its newest changed messages; older
changed messages load the new way.

## Direct conversations

`account_deletion::DirectConversations` chooses what happens to a direct
conversation that the other person is still in.

- **Empty**, when a person deletes their own account: the conversation loses
  every message, plan card and call. The other person is removed and gets
  `membership.removed`, so their devices drop it; the empty row stays only so
  that removal reaches them through the sync stream.
- **Keep**, when an operator deletes the account: the other person keeps the
  conversation as a group is kept. Every message stays. The deleted person's
  messages move to the stand-in, which joins as a member who left, and their
  identity is scrubbed. Besides group envelopes, the scrub reads the
  direct-message and agent-response envelopes a direct conversation holds,
  and renames an agent target the deleted person owned. Plan cards stay, the
  deleted person's from the stand-in. Calls the deleted person started go with
  the account; their call notices stay as messages. If the deleted person
  owned the conversation, the other person becomes its owner.

  The kept conversation is then closed, with the stand-in as
  `closed_by_account_id`, the way a [closed group](group-closed-state.md) is:
  its history stays readable, queued agent runs in it are cancelled, and new
  messages, edits, reactions, calls, plan cards and agent runs are refused
  with `group_closed`. Nothing is ever delivered to the stand-in, which has no
  devices, agents or notifications. The other person's devices learn of the
  new member list, the changed messages and the close through the sync
  stream, as for a kept group and a closed group.

  The conversation keeps its session id, which names the deleted account's
  id, so local copies stay attached to it. Account ids are not reused, so
  one person can keep several such conversations without a conflict. None of
  them is the direct conversation with the stand-in: service accounts never
  count as a conversation member, so a direct conversation with the stand-in
  cannot be opened or found. When the remaining person's account is deleted
  later, nobody is left and the conversation is deleted.

  The contact goes with the account, so a client that builds person chats
  from the contact list must read kept direct conversations from the sync
  stream instead; see [Kept direct conversations on clients](#kept-direct-conversations-on-clients).

### Kept direct conversations on clients

The server contract is the existing chat sync one; account deletion adds no
endpoint, event or field. A client finds a kept direct conversation in the
`conversations` of `GET /v2/chat/sync/bootstrap` and in the `conversation`
payload of `membership.updated`, `message.updated` and
`conversation.updated` events from `GET /v2/chat/sync`.

- **Detection.** A conversation snapshot with `kind: "direct"`, the viewer
  (`preferences.account_id`) in `members` with `membership_state: "active"`,
  and `closed.closed_by_account_id: "acct_kordi_deleted"` is a direct
  conversation kept after the other account was deleted. Its
  `legacy_session_id` is unchanged, `session:direct-person:<a>:<b>` naming the
  viewer and the deleted account, which no longer appears in `members` at
  all, not even as `left`. Anyone else keeps a member row once in a
  conversation (active, left or removed), so a `session:direct-person:` id
  whose other account has no member row, with the viewer active, is the same
  signal. It also holds in the `membership.updated` and `message.updated`
  payloads that reach the device before the close.
- **Not kept.** A direct conversation emptied by the other person's own
  deletion also loses that person's member row, so the viewer's active row is
  required. The server sets the viewer's row to `removed`, deletes every
  message and the conversation's earlier sync events, and sends only
  `membership.removed` (payload `conversation_id`, `account_id`,
  `membership_state: "removed"`, `version`; no `conversation`). Bootstrap
  lists only conversations where the viewer is active, so the emptied
  conversation never reaches a client as a snapshot. On that event a client
  drops the conversation and its local messages, and a `membership.removed`
  for the viewer removes a kept conversation the same way.
- **Members.** The viewer is the only `active` member. `acct_kordi_deleted`
  is listed, with `membership_state: "left"` and `display_name: "Deleted
  account"`, only when the deleted person had written there; otherwise the
  conversation has a single member row.
- **Messages.** The deleted person's messages have `sender_account_id:
  "acct_kordi_deleted"`; the viewer's are unchanged. Plan cards stay, the
  deleted person's created by `acct_kordi_deleted`.
- **Writes.** Every write is refused with HTTP 409 and the error code
  `group_closed`. The error message is the closed group's ("This group was
  closed."), so clients show their own wording for this case.
- **Live order.** When the account is deleted while the viewer's device is
  connected, the viewer's sync stream carries, from one transaction:
  `membership.updated` (the new member list, no `closed` yet), up to 200
  `message.updated` for the newest changed messages, each with the same
  `conversation` payload, then `conversation.updated` with `closed: {
  "closed_at": "<timestamp>", "closed_by_account_id": "acct_kordi_deleted" }`.
  The contact removal reaches the viewer's devices separately, after the
  commit and only through the event bus, so a client must not wait for it.

The desktop and web apps show such a conversation as follows; other clients
should match it:

- It stays in the chat list, by recency, as **Deleted account** with its
  usual last message preview. Its avatar is generated from the stand-in
  `acct_kordi_deleted`, the same for every deleted account, never from the
  deleted id. It is not dimmed and does not read "Closed".
- Its chat id and session id are the ones it had before, keyed by the deleted
  account id from the session id, so local copies stay attached. Both
  sides' messages stay in it; the other side's show as from Deleted account.
- One line, "This account was deleted.", replaces the composer, and a refused
  send, edit or reaction says the same. Everything a closed group hides is
  hidden.
- The Info tab loads no profile for the deleted id and shows the plain
  overview; the sender avatar opens no profile.
- It is never a contact, so it is in no people picker, group invitation list,
  mention list or Grounding surface.

## For clients

Without help, a deleted account looks exactly like a sign-out elsewhere: its
sessions are gone, so requests get `401` and sockets close. Clients must tell
the two apart, because a deleted account's local data has to be erased while
a sign-out keeps it. The server therefore answers credentials of a deleted
account with the code `account_deleted`:

| Where | Deleted account | Signed out, revoked or expired |
| --- | --- | --- |
| Any API request with `Authorization: Bearer kordi_cs_…` (an app session, a browser sign-in's access token), including `GET /v1/cloud/auth/me`, `POST /v2/chat/realtime/ticket` and `POST /v1/cloud/documents/:id/collab/ticket` | `401`, `{"errorCode": "account_deleted", "message": "This account was deleted."}` | `401`, `errorCode: "invalid_session"` |
| Any request with the web session cookie, including `GET /v1/cloud/auth/web/session` and the cookie path of the ticket routes | `401`, `{"error": "account_deleted", "errorCode": "account_deleted", …}` | `401`, `errorCode: "login_required"` |
| `POST /v1/cloud/auth/app/token` with `grant_type=refresh_token` | `400`, `{"error": "invalid_grant", "error_description": "This account was deleted.", "errorCode": "account_deleted", "message": …}` | `400`, `error` and `errorCode` both `invalid_grant` |
| `GET /v1/cloud/ws?token=…` (legacy gateway upgrade) | `401` with the bearer body above | `401` without a body |
| A WebSocket closed because the account is gone: chat realtime (`/v2/chat/realtime`), the legacy gateway (`/v1/cloud/ws`) and document editing (`/v1/cloud/documents/:id/collab`) | close code `4410`, reason `account_deleted` | unchanged: no code (realtime and gateway) or `4403` (document editing) |

The refresh answer keeps the RFC 6749 shape: `error` stays `invalid_grant`,
so OAuth clients that only read `error` still sign out. Clients read
`errorCode` to learn why; never parse `error_description` or `message`.

A socket learns of the deletion from the database signal that a removed
session or device sends (migration 0175), or from its periodic recheck, and
then checks that the account row is gone before it chooses `4410`. A
reconnecting client asks for a ticket first, and the ticket routes already
answer `account_deleted`, so it never needs the socket to tell it.

How the server knows: the deletion transaction lists, in
`cloud_deleted_account_credentials` (migration 0208,
[`account_deletion::credentials`](../../bridges/cloud-server/src/account_deletion/credentials.rs)),
the SHA-256 of each of the account's credentials that still worked: unrevoked,
unexpired session tokens on authorized devices (app bearer tokens, browser
sign-in access tokens and web session cookies, all `cloud_refresh_tokens`
rows), and refresh tokens of unrevoked browser sign-ins that were not
rotated, or were rotated within the 60-second reuse grace. A row holds only
the hash, its kind (`session` or `refresh`) and its expiry: when the
credential would have expired anyway, at most 30 days after the deletion. It
names no account, device, email or person. A credential that was already
signed out, revoked or expired keeps its old answer. Only a rejected
credential pays for the lookup, and an hourly sweep deletes expired rows.
Both deletion paths list them, since both run `delete_in_transaction`; an
operator's dry run rolls them back with everything else.

What a client must do on `account_deleted` from any request, or a `4410`
close from any socket:

1. Stop every retry and refresh loop, and do not call the logout or revoke
   routes (they would only answer `401` again).
2. End the local session: remove the stored token and browser sign-in.
3. Erase the account's local data.
4. Show the sign-in screen.

A plain `invalid_session` or `login_required` keeps today's behaviour: sign
out and keep the account's local data, so signing in again restores it. A
client holding a browser sign-in first tries one refresh on
`invalid_session`, and signs out only if that refresh is refused too; a
refresh answered with `account_deleted` erases as above.

The apps do this as follows:

- **iPhone.** Any `account_deleted` (in `errorCode`, `error_code`, `reason`
  or `error`, never `error_description`) or a `4410` close ends every retry
  loop, wipes the account's local data and shows the sign-in screen. Delete
  account in Profile runs `POST /delete` and then the same wipe.
- **Mac.** Profile > Session has **Delete account**. Its dialog states
  what is deleted, asks for the proof the server needs (the current
  password; else an emailed code with resend; nothing after a sign-in within
  ten minutes; otherwise it asks the person to sign in again), and confirms
  once more before `POST /delete`. After the `204`, and on any
  `account_deleted` or `4410`, the app clears the keychain session without
  calling logout, marks the account's folder `APP_DATA_DIR/accounts/<hash>/`
  for removal through the `cloud_account_storage_mark_for_removal` command,
  stops the account's running local agent turns with the `signed_out` stop
  reason, clears the account's local storage keys, and shows the sign-in
  screen. The folder is in use while the app runs, so marked folders are
  removed at the next start, before any account folder is opened. A `401` on
  the realtime ticket now ends the session at once instead of waiting for the
  15-second `/me` poll.
- **Web.** The same Profile row and dialog. After the `204` (whose response
  already cleared the cookies) the page does not call the logout route; on
  any `account_deleted` or `4410` it erases the account's IndexedDB chat
  store and local storage keys and goes to the site's sign-in page without a
  `next` parameter.

## Operator command

```sh
kordi-cloud-server delete-accounts --delete-file accounts.txt \
  --keep person@example.test --keep acct_example [--confirm]
```

- `--database-url` falls back to `DATABASE_URL`.
- `--delete-file` lists one account id or email per line. Blank lines and
  `#` comments are ignored. An email matches an account's primary email or a
  verified sign-in email, ignoring case.
- `--keep` names an account to keep, by id or email, and repeats.
- Without `--confirm` the command is a dry run.

It refuses to start, before changing anything, when the delete list is empty,
when an entry on either list matches no account or more than one, when an
account is on both lists (entries are compared by the account they resolve
to, so an id and an email of one account match), or when an account is one
the server runs: a service account, the Deleted account stand-in, or the
owner of a system-managed agent. An account named twice is deleted once.

A dry run deletes each account in its own transaction with `Keep` and rolls
it back, then prints what it removed: conversations deleted, kept, direct
kept, direct emptied and groups transferred, devices, and objects queued.
Nothing changes and no provider is contacted. Each account is measured on
its own, so a direct conversation between two listed accounts counts as kept
for both; a confirmed run keeps it with the first and deletes it with the
second.

With `--confirm`, accounts are deleted one at a time, each in its own
transaction, with the steps below: the provider revocations, the deletion
with `Keep`, the `account.deleted` audit event with the counts and
`"proof": "operator"`, and the after-commit work. A failed account is
reported and the command goes on; it prints a summary and exits non-zero if
any account failed.

The command reads the server's configuration from the environment, as the
server does, so it is run where the server's environment is available:

- Connector and Sign in with Apple revocations use the connector cipher,
  provider and Apple settings. Without them, revocation is skipped, as in a
  server without them; Apple tokens move to the retry queue in the
  transaction either way.
- `NATS_URL` (and `KORDI_NATS_TOKEN`) publishes device revocations and
  contact removals. Without it nothing is published on the event bus. Chat
  realtime connections of deleted devices still close, since deleting a
  device or session signals them through the database.
- The object store settings let the command delete the queued objects at
  once. Without them the keys stay in `cloud_object_deletions` and the
  running server's deletion worker removes them.

## Order of work

1. For the person's own deletion, a short transaction locks the account,
   checks that its password and email are unchanged since the proof was
   checked, and spends an emailed code. The operator command has no proof
   step. Then, outside any transaction, connectors are revoked at their
   providers while their credentials still exist, and Sign in with Apple
   tokens are revoked with Apple (`account_deletion::prepare`). Failures are
   logged and never stop the deletion.
2. One transaction locks the account (and, for the person's own deletion,
   checks it again), moves or deletes conversations, clears
   rows that point at the account's attachments, sandboxes or personal
   organization, deletes records that have no foreign key
   (`cloud_audit_events`, `cloud_agent_omp_state`, `cloud_connector_audit`,
   `cloud_connector_removal_requests`), deletes waitlist requests and pending
   sign-up codes under the account's emails, queues object-store keys in
   `cloud_object_deletions`, moves Apple tokens that could not be revoked to
   `cloud_apple_token_revocations` for a retry worker, lists the hashes of
   the account's live credentials in `cloud_deleted_account_credentials`,
   deletes the account row, and writes the `account.deleted` audit event with
   counts only.
3. After commit every device's live connections are closed (with close
   code `4410`), contacts' devices are told the contact is gone, and queued
   objects are deleted. A failed
   object delete stays queued and is retried with backoff by a background
   worker; a missing object counts as deleted.

Migration 0179 lets the account's project devices and commands, agent
exchanges, and references from other people's runs follow the deletion.
Foreign keys to kept conversations, messages and plan cards stay strict, so a
row the server failed to move makes the deletion fail instead of silently
disappearing.
