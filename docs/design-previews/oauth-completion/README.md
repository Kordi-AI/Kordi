# OAuth completion page proposal

Static browser preview for the page the desktop app serves on `127.0.0.1` after a browser
OAuth hand-off (`completion_page_document` in
`app/desktop/src-tauri/src/cloud_oauth_loopback.rs`). Today the page uses a serif
"Signed in." heading with no accent and shows the same copy when a connector such as
GitHub is connected.

The proposal follows the kordi.ai log-in and hand-off pages (`login.html` and
`login/done.html` on the homepage `main` branch): the bird and bold `kordi` wordmark in an
80px header, a centered Geist-weight title at the log-in title scale, one muted line, and
the cardinal spinner from the web hand-off page. It adds a dark palette, since the web
pages have none. Connector grants read the provider from the `#kordi_connector` fragment
and say what happened, for example "GitHub connected", with the tab titled
"Connect GitHub · Kordi". A provider error fragment carries no provider, so that error
reads "Couldn’t connect your account".

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/oauth-completion
python3 -m http.server 8779 --bind 127.0.0.1
# open http://127.0.0.1:8779/
```

Query parameters (kept in sync with the controls): `theme=light|dark`,
`width=desktop|phone`, `font=system|geist`. `frame.html` renders one full-size page; its
URL fragment stands in for the OAuth callback fragment.

The Embedded Geist option needs `geist-400.ttf` and `geist-600.ttf` copied from the
homepage repo (`research-preview/public/assets/fonts/`) into `fonts/`, which is not
committed. It shows what the page would look like with Geist embedded as a data URL
instead of the system stack.

The owner approved this design on 2026-11-13. The desktop loopback page and the CLI
provider callback page (`agent/crates/cli/src/oauth/provider_callback.html`) now use it,
with the system stack (Geist when installed, otherwise the platform sans-serif) rather
than an embedded font.
