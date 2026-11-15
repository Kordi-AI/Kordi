# Room match processing

Standalone design preview for room result rows that have no model result yet. Synthetic people, no network calls. Open `index.html` through a loopback static server.

- Rows with a model result show the score and headline, ranked by score.
- Rows still matching show a small neutral indicator in place of the score and no headline, ranked by the quick estimate below the scored rows.
- **Play results arriving** fills the matching rows one by one, as the background runs finish.

Toggles compare three indicators (ring, ticks, dots) and an optional topic hint under a matching row.
