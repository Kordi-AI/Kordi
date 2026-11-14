# Closed group proposal

Static browser preview: when a group owner or admin closes a group, every member keeps it in their list,
marked closed, with the history readable and the composer replaced by one line. It loads no network
resources and uses sample data.

```sh
cd docs/design-previews/group-closed-state
python3 -m http.server 8781 --bind 127.0.0.1
# open http://127.0.0.1:8781/
```

Query parameters (kept in sync with the controls): `theme=light|dark`, `footer=a|b`, `creator=keep|drop`.

- Footer A: "This group was closed", nothing else. Delete chat is in the row menu and swipe.
- Footer B (chosen): the same line with Delete chat next to it.
- Creator keep (recommended): the creator sees the closed group like everyone else.
- Creator drop: closing removes it from the creator's list.

The owner picked Footer B and creator keep on 2026-11-13.
