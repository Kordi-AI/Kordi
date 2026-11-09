# Desktop update card design preview

Static, self-contained preview for issue #2404, with synthetic data only. Every desktop update state uses the "Kordi for Mac" card layout from `app/desktop/src/features/onboarding/MacAppPrompt.tsx`, anchored at the help corner. It also shows the proposed Settings › Updates section with the Automatic updates toggle.

## States

- `state=ready`, `available`, `downloading`, `restarting`, `checking`, `current`, `failed`, `move`, `settings`
- `theme=light|dark`

## Serve

From this folder:

```
python3 -m http.server 8742 --bind 127.0.0.1
```
