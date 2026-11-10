# Send button proposal

Static browser preview for the chat send button. Today the Mac composer draws the lucide
paper plane in a 32px accent circle, which reads as Telegram, while the iPhone composer
already uses a bold up arrow in a 44pt circle. The page shows each option in the Mac
composer (empty and typed) and the iPhone composer (empty with the voice button, and
typed), plus a close-up. Clicking a filled button plays its send motion. It loads no
network resources.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/send-button
python3 -m http.server 8773 --bind 127.0.0.1
# open http://127.0.0.1:8773/
```

Query parameters (kept in sync with the controls): `theme=light|dark`,
`accent=classic|slate|teal|plum|clay` (the chat theme accents from `theme-palette.css`).

- Current: Mac paper plane, iPhone up arrow.
- Option A · Up arrow, both apps: replace the Mac paper plane with the iPhone arrow.
- Option B · Up arrow on a rounded key (recommended): the same arrow on a rounded square,
  9px radius on Mac and 12pt on iPhone, in the chat theme accent.
- Option C · Bird: the app-icon bird in white with its amber beak, tilted up; it hops and
  flies off on send.
- Option D · Leaf arrowhead: a leaf pointing up with a cut vein and a short stem.
- Option E · Ink key: Option B in the bird ink colour instead of the theme accent.

Option A was chosen by the owner on 2026-11-10. The Mac icon-only send buttons now draw
lucide `ArrowUp` at stroke width 2.5 in the existing accent circle; iPhone was already on
`arrow.up`. Labelled buttons ("Forward", "Send video", "Send report") keep their icons.

## Native implementation (all options as first sketched)

- Mac: one shared `ComposerSendGlyph` replaces lucide `Send` in the chat composers
  (`chatsPage.voiceControls.tsx`, `voiceRecordingRail.tsx`, `chatsPage.companionComposer.tsx`,
  `chatsPage.composerPrimitives.tsx`, `chatsPage.sessionPane.tsx`, `ProjectsPage.tsx`,
  `AgentStudioConversation.tsx`, `CloudPeerChatPanel.tsx`). For B and E, `.app-composer-send`
  drops `rounded-full` for a 9px radius. Labelled buttons such as "Send report" keep their
  own icons.
- iPhone: `ComposerView.sendOrVoiceButton`, the photo picker and voice message send buttons
  swap `Circle()` for `RoundedRectangle(cornerRadius: 12, style: .continuous)` (B and E), or
  draw the shared glyph (C and D). The empty-state voice button keeps the same shape as send
  so the control does not jump when typing starts.
