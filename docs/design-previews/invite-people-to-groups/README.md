# Invite people to groups

Standalone design preview for inviting Grounding people into an existing group, with their approval. Synthetic people, no network calls. Open `index.html` through a loopback static server.

1. A person's Grounding page gets an **Invite** tile. It opens a group picker: A is a small dialog with Invite, B is a menu where one click sends. Groups the person is in show Member; groups with a pending invitation show Invited.
2. Group › Add people lists people from my Grounding (my open and recent rooms, and my matches), without current members, people already invited and blocked people. A keeps one list (Contacts, then From Grounding); B adds a Grounding tab.
3. The invitee sees the invitation in Contacts › Requests with row B and detail 2 from `room-invitation-requests/`, with the source ("from <room>" or "from Grounding"), and joins only after Join.

Contacts keep today's behaviour: Add people adds them right away.
