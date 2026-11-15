# Room gallery

Standalone design preview for a Gallery tab on the Grounding room page, where room members share their artifacts for others to open, comment on and ask about. Synthetic people, no network calls. Open `index.html` through a loopback static server.

The Mac pane and the iPhone pane show the same state. The room opens on Gallery; People and Topics render today's lists. The query string keeps the switches and the open view (`?layout=a&review=comments&view=item:runner-cache`), so a state can be linked.

- Switches: Layout (A · Cards, B · List, C · By topic), Review (Comments, Comments + likes), Viewer (You, Bea), Gallery (Filled, Empty), Theme, and Reset.
- A · Cards: topic chips and **Share** above a 3-column grid (2 on iPhone) of thumbnails with type chip, title, author and comment count.
- B · List: the same toolbar over grouped rows with a type tile, "Author · Topic", comment count and chevron.
- C · By topic: one section per topic with its cards in a row, then Other; **Share** sits beside the first section title.
- Share: a dialog (sheet on iPhone) lists my recent artifacts with search, multi-select and one Topic preselected from the first pick. Shared items appear first; mine have **More** › Remove from gallery.
- Item screen: author row, the artifact read-only, then Comments with an input. Comments + likes adds a heart toggle and heart counts.
- Contact: **Message** for a contact opens a one-to-one chat with the artifact attached as a removable chip; **Add** for others becomes **Requested**. My own items show **More** instead.

The owner chose A · Cards with comments only. After trying it, the owner asked for a plainer item screen than this preview draws: the title stands alone without the type tile, and the sharer is a plain line (small avatar, name, topic) with the contact and open controls at the right, not a boxed row. The implemented surfaces are `app/desktop/src/features/commonGround/Gallery*.tsx` and `app/ios/Kordi/Features/CommonGround/CommonGroundGallery*.swift`.
