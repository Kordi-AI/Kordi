# Room group join requests

Standalone design preview for "Ask to join" on groups listed in a Grounding room. Synthetic people, no network calls. Open `index.html` through a loopback static server.

Switch the viewer between a room member outside the group (Chen), the group owner (Alex) and another group member (Bea), and choose who may approve. The Mac pane shows the room's Groups section and the group chat; the iPhone pane shows the same two screens.

- Room member outside the group: **Ask to join**, then **Requested** with **Cancel**. After a decline the row is view-only.
- Approvers: a nested row under the group in the room, and a card in the group chat, each with **Decline** and **Approve**.
- Approve adds the requester the same way as accepting a room invitation, and System posts the usual joined line.
