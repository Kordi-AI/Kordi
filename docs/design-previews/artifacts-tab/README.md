# Artifacts tab proposal

Standalone design preview for the chat and contact Artifacts tab. It uses synthetic people and documents, makes no network calls, and uses system fonts only. Open `index.html` through a loopback static server.

The switcher shows the tab as it is today, then three options:

- **A · List**: one centered column with search, a single New menu (New document, Add file), and rows grouped by day. Each row shows a type tile, the title, and type · author · time. No row is selected until it is clicked. On hover, the time is replaced by Open, Share, and More.
- **B · Cards**: thumbnails of each artifact's first lines, with New document as the first card.
- **C · List + reader**: a 300 px list rail with the selected artifact rendered on the right.

The owner chose B with a cards/list switch beside search. The shipped version is denser than this preview: smaller cards in one grid (changed files say how they changed), no New document card (it lives in the New menu), single-line list rows that line up with the toolbar, and an arrow on each row and card that opens the file in its default app.

The implemented surfaces are `app/desktop/src/pages/ArtifactInspector.tsx`, `app/desktop/src/pages/ArtifactListRow.tsx`, and `app/desktop/src/features/documents/ChatDocumentEntries.tsx`.
