# Card auto rebuild

Browser-only proposal for the Grounding card page on the Mac and iPhone (issue #2433). The header button "Rebuild from memory" becomes "Rebuild", and an opt-in auto rebuild keeps the card current while the owner's memory changes or new events arrive from connected accounts. Option A adds a "Rebuild automatically" switch on the card page; option B puts the choice in a menu on the Rebuild button, with separate Memory and Events ticks. A was chosen: one switch covers both triggers.

A manual Rebuild shows the full rebuild (disabled button, progress bar, dimmed topics). With auto on, changes land quietly instead: after a short quiet period the meta line shows "Updating", then a new topic line or a refreshed reference appears in place and the card reads "updated just now". "New memory" and "New event" in the review header simulate one change; "Conversation" keeps adding memories (and an event every third tick) until it is switched off. Data is synthetic and nothing connects to an API.

Serve it bound to loopback, then open `http://127.0.0.1:8746/`:

```sh
cd docs/design-previews/card-auto-rebuild
python3 -m http.server 8746 --bind 127.0.0.1
```

Every view has a link through the query string:

| Parameter | Values | Default |
| --- | --- | --- |
| `option` | `a`, `b` | `a` |
| `mode` | `mac`, `ios` | `mac` |
| `theme` | `light`, `dark` | `light` |
| `auto` | `off`, `on` | `off` |
| `mem`, `ev` | `on`, `off` (option B only; auto is on when either is on) | follow `auto` |

For example `?option=b&mode=ios&mem=on&ev=off`. The Conversation toggle is not stored in the URL.
