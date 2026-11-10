# Read receipt ticks proposal

Browser-only proposal for issue #2455, aligned with Telegram: one tick when the
server has the message, two ticks once it is read, no "delivered" state, no
reader count on the bubble, and a "Seen by" row that loads when the message
menu opens. It uses synthetic people and a synthetic group ("Launch prep"),
loads nothing from the network, and changes nothing outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/receipt-ticks
python3 -m http.server 51794 --bind 127.0.0.1
# open http://127.0.0.1:51794/
```

`index.html` shows one state; `states.html` shows every state for one platform
and appearance. Query parameters (kept in sync with the controls):

| Parameter | Values | Default |
| --- | --- | --- |
| `device` | `mac`, `ios` | `mac` |
| `theme` | `light`, `dark` | `light` |
| `state` | see below (`index.html` only; `index.html#seen-list` also works) | `group-sent` |

## States

| State | What it shows |
| --- | --- |
| `group-sent` | Group, your latest message with one tick |
| `group-read` | The same with two ticks |
| `dm-sent`, `dm-read` | The same in a direct conversation |
| `before-after` | Now (Sent, Delivered, Read) beside Proposed (Sent, Read), for group and direct |
| `seen-loading` | Message menu on your group message; the row is loading |
| `seen-none` | The row says "Not seen yet" and cannot be chosen; the bubble has one tick |
| `seen-one` | One reader, shown by name with their avatar |
| `seen-several` | "8 Seen" with the first four avatars |
| `seen-list` | The full list: 8 readers in the order they read, each with a time |
| `large-group` | A group of 140: the menu has no Seen row, the ticks are unchanged |
| `incoming` | Someone else's message: no ticks, no Seen row |

Example: `http://127.0.0.1:51794/index.html?device=ios&theme=dark&state=seen-several`.
On `index.html`, choosing the Seen row opens `seen-list`, and Back (Mac) or Done
(iPhone) returns to `seen-several`.

## What is copied from the app

- Bubbles: Classic theme colours, 14px (Mac) and 17pt (iPhone) text, the
  6/4 corner pair and the Telegram Web K tail from `messageBubbleShape.tsx` and
  `MessageBubbleGeometry`. Tick glyphs and tints are today's: lucide `Check` and
  `CheckCheck` on Mac, two offset SF `checkmark` glyphs on iPhone; one tick in
  `--app-chat-reply-own` / `ownReplyAccent`, two in
  `--app-chat-mention-own-person` / `ownPersonMention`.
- Mac menu: the dense-menu surface, 13.5rem list under the 17.5rem reaction
  pill, today's item order, and the Seen row metrics of
  `.app-message-context-menu-seen` (11px muted label, 18px avatars, up to four).
  The full list is a detail view of the same surface with a back arrow, as the
  model picker does.
- iPhone menu: the floating `MessageActionOverlay` (blurred backdrop, lifted
  bubble, 52pt reaction pill, 238pt menu, 44pt rows) with the Seen row of
  `MessageActionReadReceiptRow` at the bottom. The full list is a sheet in the
  flat Settings-sheet style (inline title, Done, 48pt rows, no cards).
- Avatars: the Boring Avatars "Marble" generator the server uses, drawn inline.

## Findings from the current code

- Sent and Delivered already draw the same single tick on both platforms
  (`messageDeliveryVisual`, `MessageDeliveryGlyph`); only the accessibility label
  differs. In groups, Read already means "at least one member has read it"
  (`cloudGroupMessages.ts`). The bubble change is therefore mostly semantic; the
  cost saving comes from loading readers on demand.
- The iPhone bubble does not draw a reader count today. The count is only in
  the VoiceOver label ("Seen by 3"), and "N Seen" appears in the message menu.
  The Now column shows this as it is.

## Decided

Approved on 2026-11-10: direct conversations lose "delivered" too; VoiceOver
says "Sent" or "Seen" without a number; one reader's row opens the one-row
list; the copy for nobody yet is "Not seen yet".
