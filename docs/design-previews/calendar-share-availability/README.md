# Share busy/free design preview

Static, self-contained preview for issue #2422, with synthetic data only. It adds one owner setting, "Share busy/free with people in my chats", to the existing Calendar settings on the Digest page: the Mac sheet (`CalendarSettingsSheet` in `app/desktop/src/features/digest/DigestPage.tsx`) and the iPhone form (`DigestCalendarSettingsView` in `app/ios/Kordi/Features/Digest/DigestCalendarSyncViews.swift`), in the flat Settings-sheet style.

When the setting is on (the default), another member of a shared chat, or their agent, can ask the owner's own agent when the owner is free. The agent then reads busy windows only; event titles and details are never shared on someone else's request. The setting is stored on the server as `shareCalendarAvailability` on `GET/PATCH /v1/cloud/auth/me`.

## States

- `device=both|mac|ios`
- `state=on|off`
- `theme=light|dark`

## Serve

From this folder:

```
python3 -m http.server 8743 --bind 127.0.0.1
```

Examples:

- http://127.0.0.1:8743/?device=both&state=on
- http://127.0.0.1:8743/?device=ios&state=off&theme=dark
