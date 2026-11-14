# Closed groups

A group owner or admin can close a group, or one channel of it. Closing keeps
the conversation, its members and its history. Everyone can still read it, and
nothing new is written there.

## Server

- `DELETE /v2/chat/group-spaces/:group_space_id` closes every channel of the
  group. `DELETE /v2/chat/group-spaces/:group_space_id/channels/:conversation_id`
  closes one channel other than the first. The routes keep their historical
  paths, and the response keeps the `dissolved` key.
- Closing sets `closed_at` and `closed_by_account_id` on each conversation
  (migration 0206), bumps its version and sends `conversation.updated` to each
  member. The snapshot carries `closed: { closed_at, closed_by_account_id }`.
  Bootstrap carries the same field, so a device that was offline learns of the
  close on its next sync. Closing twice changes nothing and sends nothing.
- Closing a group also revokes its invitation links, cancels queued agent runs
  (`error_code = 'group_closed'`) and stops running agent subsessions.
- Writes to a closed conversation fail with HTTP 409 and the error code
  `group_closed`: new messages from people, agents or notices, edits,
  delete-for-everyone, reactions, attachment reactions and deletes, member
  adds and invitation accepts, new channels, title changes, owner transfers,
  agent run claims, calls and new plan cards.
- Reads stay allowed: history, threads, read receipts, read and delivery
  cursors, and hiding a message for oneself.
- Grounding room views leave out closed groups, so nobody new can find or join them.
- Anyone, the last admin and the last person included, may leave a closed
  group. Leaving is how a person removes it from their list. It posts no
  "left the group" notice and skips the admin hand-over checks.

## Clients

- A closed group and each closed channel stay in the chat list, dimmed, with
  "Closed" as the preview and no unread badge.
- Opening one shows the history read-only. One line replaces the composer:
  "This group was closed", with Delete chat next to it.
- The person who closed the group keeps it like everyone else.
- Delete chat on a closed group leaves it on the server. On a closed channel
  of an open group it hides that channel, as Delete chat does elsewhere.
- Older clients keep showing a closed group as open. Their sends fail with
  `group_closed`.

Design preview: `docs/design-previews/group-closed-state/`.
