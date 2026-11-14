# Facilitator naming design preview

Static, self-contained before/after of the Facilitator rename and the Grounding group intro change:

- Group notices (the intro and the joined line) show as "Facilitator", like the System agent, with the same Kordi bird.
- The intro leaves invited people out until they accept; the joined line introduces them.
- A structured mention followed by a period ("@Alex Rivera.") highlights as one mention.
- Topics that hold a name ("GitHub app integrations") keep their capitals in the joined line.
- Settings › Usage and the AI consent line say "Facilitator" instead of "System agent".

The page follows the system light or dark appearance.

## Serve

The page uses the app's own avatar, so serve from the repository root:

```
python3 -m http.server 8762 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8762/docs/design-previews/facilitator-naming/`.
