# Unreadable links

Browser-only proposal for the Grounding card Build screen on the Mac and iPhone, for when a link in **Links** cannot be read. Today the screen shows a grey "Couldn't read linkedin.com" under the field and an unrelated red "Nothing here fits this profile" above Build, so the owner cannot tell the link is the cause.

- Each unread link gets one line in the error colour that says why, from the reason the server already returns (`sign_in`, `blocked`, `not_found`, `unreachable`, `unreadable`), followed by one action: "Paste the text into Notes", which focuses Notes.
- When every source was an unread link, the Build error names the link instead of "Nothing here fits this profile".
- Option A changes nothing before Build. Option B also flags a known sign-in site (LinkedIn, Facebook, Instagram) in grey as soon as it is pasted. B was chosen.

Data is synthetic and nothing connects to an API. Serve it bound to loopback, then open `http://127.0.0.1:8761/`:

```sh
cd docs/design-previews/grounding-unreadable-links
python3 -m http.server 8761 --bind 127.0.0.1
```

| Parameter | Values | Default |
| --- | --- | --- |
| `option` | `a`, `b` | `b` |
| `mode` | `mac`, `ios` | `mac` |
| `theme` | `light`, `dark` | `light` |

Try these in Links: `https://www.linkedin.com/in/your-name/` (sign-in), `https://site.invalid/` (unreachable), `https://example.com/missing` (not found), `https://example.com/` (read).
