// The proposed loopback completion page, kept in step with
// `completion_page_document` in app/desktop/src-tauri/src/cloud_oauth_loopback.rs.
// The page is self-contained: no fonts, images or scripts load from anywhere.

const BIRD = `<svg viewBox='64 58 384 384' aria-hidden='true'><mask id='kordi-bird-cut' maskUnits='userSpaceOnUse' x='-100' y='-100' width='712' height='712'><ellipse cx='262' cy='292' rx='150' ry='136' fill='#fff'/><path d='M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z' fill='#fff' stroke='#fff' stroke-width='4' stroke-linejoin='round'/><circle cx='194' cy='266' r='17'/><path d='M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z'/></mask><g transform='translate(256,250) scale(0.94) translate(-270,-292)'><path d='M120,276 L82,294 L120,312Z' fill='#f7b32b' stroke='#f7b32b' stroke-width='12' stroke-linejoin='round'/><rect x='-100' y='-100' width='712' height='712' fill='currentColor' mask='url(#kordi-bird-cut)'/></g></svg>`;

export const CSS = `
    :root {
      color-scheme: light;
      --paper: #fcfaf8;
      --ink: #191817;
      --muted: #6d6865;
      --rule: #e8ddd8;
      --cardinal: #8c1515;
      --bird: #1f1a17;
      --sans: Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
        --paper: #191817;
        --ink: #f6f1ed;
        --muted: #bcb3ae;
        --rule: #3a3431;
        --cardinal: #e5837a;
        --bird: #f6f1ed;
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --paper: #191817;
      --ink: #f6f1ed;
      --muted: #bcb3ae;
      --rule: #3a3431;
      --cardinal: #e5837a;
      --bird: #f6f1ed;
    }

    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--sans);
      color: var(--ink);
      background: var(--paper);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .mast {
      width: min(calc(100% - 4.25rem), 1312px);
      min-height: 80px;
      margin-inline: auto;
      display: flex;
      align-items: center;
    }
    .brand { display: inline-flex; align-items: center; gap: .6rem; color: var(--bird); }
    .brand svg { width: 39px; height: 39px; flex: none; }
    .brand span { color: var(--ink); font-size: 1.65rem; font-weight: 600; letter-spacing: -.045em; line-height: 1; }

    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: clamp(56px, 14vh, 140px) 1.75rem 56px;
      text-align: center;
    }
    .spinner {
      display: none;
      width: 28px;
      height: 28px;
      margin-bottom: 24px;
      border: 2px solid var(--rule);
      border-top-color: var(--cardinal);
      border-radius: 50%;
      animation: spin 700ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
    [data-status="loading"] .spinner { display: block; }

    h1 {
      max-width: 14ch;
      margin: 0;
      font-size: clamp(2.5rem, 1.6rem + 2.6vw, 3.75rem);
      font-weight: 600;
      line-height: 1.06;
      letter-spacing: -.045em;
      text-wrap: balance;
    }
    p {
      max-width: 34ch;
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 1.0625rem;
      line-height: 1.6;
      text-wrap: balance;
    }
    [data-copy] { display: none; }
    [data-kind="account"][data-status="loading"] [data-copy~="account-loading"],
    [data-kind="account"][data-status="success"] [data-copy~="account-success"],
    [data-kind="account"][data-status="error"] [data-copy~="account-error"],
    [data-kind="connector"][data-status="loading"] [data-copy~="connector-loading"],
    [data-kind="connector"][data-status="success"] [data-copy~="connector-success"],
    [data-kind="connector"][data-status="error"] [data-copy~="connector-error"] { display: block; }

    @media (max-width: 520px) {
      .mast { width: calc(100% - 3.5rem); min-height: 68px; }
      .brand svg { width: 32px; height: 32px; }
      .brand span { font-size: 1.45rem; }
      h1 { font-size: clamp(2.125rem, 9vw, 2.75rem); }
    }
`;

export const BODY = `
  <header class="mast">
    <div class="brand" aria-label="Kordi">${BIRD}<span>kordi</span></div>
  </header>
  <main role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <h1 data-copy="account-loading">Signing in…</h1>
    <h1 data-copy="account-success">You’re signed in</h1>
    <h1 data-copy="account-error">Couldn’t sign in</h1>
    <h1 data-copy="connector-loading">Connecting <span data-provider="your account">your account</span>…</h1>
    <h1 data-copy="connector-success"><span data-provider="Account">Account</span> connected</h1>
    <h1 data-copy="connector-error">Couldn’t connect <span data-provider="your account">your account</span></h1>
    <p data-copy="account-success connector-success">You can close this tab and go back to Kordi.</p>
    <p data-copy="account-error connector-error">Go back to Kordi and try again.</p>
  </main>
`;

export function script(requestId) {
  return `
    (function() {
      var root = document.documentElement;
      var params = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
      var names = {
        github: 'GitHub',
        gmail: 'Gmail',
        google_calendar: 'Google Calendar',
        slack: 'Slack',
        outlook: 'Outlook'
      };
      var failed = params.has('kordi_cloud_oauth_error') || params.has('kordi_connector_error');

      // A connector grant names its provider in the base64url JSON fragment.
      if (params.has('kordi_connector') || params.has('kordi_connector_error')) {
        var provider = '';
        try {
          var encoded = (params.get('kordi_connector') || '').replace(/-/g, '+').replace(/_/g, '/');
          provider = names[JSON.parse(atob(encoded)).provider] || '';
        } catch (error) {}
        root.setAttribute('data-kind', 'connector');
        document.querySelectorAll('[data-provider]').forEach(function(node) {
          node.textContent = provider || node.getAttribute('data-provider');
        });
        document.title = (provider ? 'Connect ' + provider : 'Connect') + ' · Kordi';
      }

      function setStatus(next) { root.setAttribute('data-status', next); }
      fetch('/complete/${requestId}', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: window.location.hash || '',
      })
        .then(function(res) { setStatus(res && res.ok && !failed ? 'success' : 'error'); })
        .catch(function() { setStatus('error'); });
    })();
  `;
}

export function completionDocument(requestId) {
  return `<!doctype html>
<html lang="en" data-status="loading" data-kind="account">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Sign in · Kordi</title>
  <style>${CSS}</style>
</head>
<body>${BODY}
  <script>${script(requestId)}</script>
</body>
</html>`;
}
