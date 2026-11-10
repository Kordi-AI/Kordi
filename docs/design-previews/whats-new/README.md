# What’s new design preview

Static, self-contained preview of the Help menu's What’s new view (`app/desktop/src/features/onboarding/HelpReleaseNotes.tsx`). It shows the current layout next to three proposals, using the release highlights already bundled with the app.

## States

- `theme=light|dark`
- `earlier=off|on` adds the optional Earlier versions rows

## Serve

From this folder:

```
python3 -m http.server 8758 --bind 127.0.0.1
```
