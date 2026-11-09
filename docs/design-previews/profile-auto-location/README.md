# Automatic location and time zone proposal

Browser-only preview for issue #2439: the profile Location and Time zone rows
follow the Mac or iPhone automatically, and a value the person sets by hand is
never overwritten. Sample data only (Maya, `maya@example.com`, two sample
places). It loads no network resources and changes nothing outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/profile-auto-location
python3 -m http.server 8764 --bind 127.0.0.1
# open http://127.0.0.1:8764/
```

Query parameters (kept in sync with the controls): `device=mac|ios`,
`theme=light|dark`, `state=auto|manual|denied|empty`, `place=paloalto|thuwal`.
Defaults: `mac`, system theme, `auto`, `paloalto`. "Device is in" moves the
sample device so automatic fields update and manual ones stay put. The contact
card shows the saved values that contacts and chat members (and their agents) see.

## States

| State | Location | Time zone |
| --- | --- | --- |
| `auto` | Device city, "Automatic" marker (Mac) / filled arrow (iPhone) | Device zone, "Automatic" marker / small filled arrow |
| `manual` | Typed value; arrow button turns automatic on | Picked zone; "Automatic" is the first menu or list item |
| `denied` | Automatic, OS access off: last city stays, one link line to Settings | Automatic (needs no permission) |
| `empty` | Empty; arrow button asks for permission | Automatic by default |

Interactions: typing in Location switches it to manual. The Mac "Automatic"
marker on Location turns it off. The arrow button turns it on and, when the
OS has not been asked yet, shows the system prompt (an approximation). "Don't
Allow" keeps the field as it is and shows the Settings line. In the preview,
that link grants access. Time zone uses the native select on Mac (first item
"Automatic · <device zone>") and the existing picker on iPhone, whose
"Automatic" row now names the device zone.

## Proposed behavior

- **Mode per field, stored on the server.** A Mac and an iPhone must agree on
  whether a field is automatic, so a client-only setting is not enough. Add
  `cloud_accounts.location_mode` and `time_zone_mode` (`'automatic' | 'manual'`,
  nullable for "never chosen"). Migration `0190_profile_field_modes.sql`: `0187`
  is the newest on main, and `0188`/`0189` are taken by open branches. Backfill
  `time_zone_mode = 'manual'` where `time_zone` is set, `'automatic'` otherwise;
  leave `location_mode` null. The owner payload returns `locationMode` and
  `timeZoneMode`; public profiles do not.
- **Edits.** `PATCH /v1/cloud/auth/me` accepts `locationMode` and
  `timeZoneMode` next to the values. A typed or picked value is sent with mode
  `manual`; turning automatic on sends mode `automatic` with the device value.
- **Device sync, race-safe.** A separate device write (for example
  `PUT /v1/cloud/auth/me/device-place` with `timeZone` and `location`) updates a
  field only `WHERE <field>_mode = 'automatic'` in the same statement, so a
  manual value set on another device is never overwritten. Each device writes
  only when its own observed value changed since its last write (stored
  locally), so a desk Mac does not flip a travelling iPhone's city back.
- **Time zone.** The device IANA zone: Mac `Intl.DateTimeFormat().resolvedOptions()`
  (already in `refreshDesktopTimeZone`), iPhone `TimeZone.current.identifier`.
  Synced on launch, on foreground, and on system time-zone change
  (`NSSystemTimeZoneDidChange` on iPhone; the desktop already rechecks the zone
  each minute and on focus). Validation is unchanged (`chrono_tz`).
- **Location.** City level only: `locality, administrativeArea` for the US
  ("Palo Alto, CA"), otherwise `locality, country` ("Thuwal, Saudi Arabia"),
  under the existing 80-character limit. Request reduced accuracy
  (`kCLLocationAccuracyReduced`), reverse-geocode one fix, and store only the
  string; coordinates are never stored or sent. Refresh on launch and
  foreground when 6 hours have passed or the fix moved more than 5 km. On iPhone,
  also on significant-change events when the app already receives them for
  Nearby; no new background mode. Geocode with a fixed English locale so
  devices with different languages do not flip the string.
- **Defaults and permission.** Time zone: automatic by default for accounts with
  no time zone (no permission, low sensitivity, already sent as device metadata).
  Location: off by default and never prompted on launch. The OS prompt appears
  only when the person taps the arrow. The city is shown to every contact and
  chat member, so it should be an explicit choice; an empty row with a one-tap
  arrow keeps that choice cheap. Denied keeps the field as it is; no time-zone
  region fallback.
- **Usage strings** need to cover the profile city (Mac `NSLocationUsageDescription`
  and `NSLocationWhenInUseUsageDescription`, iPhone
  `NSLocationWhenInUseUsageDescription`), for example "Kordi keeps the city on
  your profile current when you turn that on, and finds nearby people when you ask."

## Sources

- Server: `bridges/cloud-server/src/auth/routes/profile_handlers.rs`
  (`PATCH /me` update), `profile_handlers/fields.rs` (cleaners, 80-character
  location, IANA zone check), `types/profile.rs`, migration `0141_account_profile_fields.sql`.
- Mac: `app/desktop/src/pages/CloudProfilePanel.tsx` (rows; Time zone `""` is
  "Automatic" today but stores null), `cloudProfileDraft.ts` (zone labels),
  `styles/cloud-profile-editor.css`, `src-tauri/src/nearby_location/` (Core
  Location through `objc2-core-location`), `src-tauri/Info.plist`, `Entitlements.plist`.
- iPhone: `app/ios/Kordi/Features/Profile/ProfileEditorView.swift` (rows,
  `TimeZonePickerView`), `Features/CommonGround/CommonGroundNearbyLocator*.swift`,
  `Supporting/Info.plist`.

## Known differences from the app

- System permission prompts are approximations, not the real system sheets.
- The Mac dialog rail is abbreviated; the zone list is a short sample.
- Clocks on the contact card use a fixed sample instant.
