# Facilitator in the @ menu design preview

Static before/after of the group composer's @ menu on Mac and iPhone. In group chats, "Facilitator" leads the Agents section, with the Kordi bird and "Built in". Picking it sends a mention that the server answers as the Facilitator, and it is never routed to a person's agent.

The page follows the system light or dark appearance.

## Serve

The page uses the app's own avatar, so serve from the repository root:

```
python3 -m http.server 8762 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8762/docs/design-previews/facilitator-mention-menu/`.
