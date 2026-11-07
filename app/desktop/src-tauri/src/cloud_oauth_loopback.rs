use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const KORDI_FAVICON_DATA_URL: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='64 58 384 384'%3E%3Cmask id='kordi-bird-cut' maskUnits='userSpaceOnUse' x='-100' y='-100' width='712' height='712'%3E%3Cellipse cx='262' cy='292' rx='150' ry='136' fill='%23fff'/%3E%3Cpath d='M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z' fill='%23fff' stroke='%23fff' stroke-width='4' stroke-linejoin='round'/%3E%3Ccircle cx='194' cy='266' r='17'/%3E%3Cpath d='M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z'/%3E%3C/mask%3E%3Cg transform='translate(256,250) scale(0.94) translate(-270,-292)'%3E%3Cpath d='M120,276 L82,294 L120,312Z' fill='%23f7b32b' stroke='%23f7b32b' stroke-width='12' stroke-linejoin='round'/%3E%3Crect x='-100' y='-100' width='712' height='712' fill='%231f1a17' mask='url(%23kordi-bird-cut)'/%3E%3C/g%3E%3C/svg%3E";
const MAX_LOOPBACK_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Default)]
pub struct CloudOAuthLoopbackState {
    pub(crate) pending: Mutex<HashMap<String, oneshot::Receiver<Result<String, String>>>>,
    pub(crate) cancellations: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOAuthLoopbackStart {
    pub(crate) request_id: String,
    pub(crate) redirect_url: String,
}

#[tauri::command]
pub async fn cloud_oauth_loopback_prepare(
    state: State<'_, CloudOAuthLoopbackState>,
) -> Result<CloudOAuthLoopbackStart, String> {
    let request_id = format!("cloud_oauth_{}", uuid::Uuid::new_v4().simple());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("Unable to start local OAuth callback listener: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Unable to read local OAuth callback address: {err}"))?
        .port();
    let redirect_url = format!("http://127.0.0.1:{port}/oauth/{request_id}");
    let (tx, rx) = oneshot::channel();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .insert(request_id.clone(), rx);
    state
        .cancellations
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .insert(request_id.clone(), cancel_tx);

    tokio::spawn(run_loopback_listener(
        listener,
        request_id.clone(),
        tx,
        cancel_rx,
    ));

    Ok(CloudOAuthLoopbackStart {
        request_id,
        redirect_url,
    })
}

#[tauri::command]
pub async fn cloud_oauth_loopback_wait(
    state: State<'_, CloudOAuthLoopbackState>,
    request_id: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let rx = state
        .pending
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .remove(request_id.trim())
        .ok_or_else(|| "OAuth callback was not started.".to_string())?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(180_000).clamp(1_000, 600_000));
    let result = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("OAuth callback listener stopped before sign-in completed.".to_string()),
        Err(_) => Err("OAuth sign-in timed out. Try again.".to_string()),
    };
    if let Some(cancel) = state
        .cancellations
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .remove(request_id.trim())
    {
        let _ = cancel.send(());
    }
    result
}

#[tauri::command]
pub async fn cloud_oauth_loopback_cancel(
    state: State<'_, CloudOAuthLoopbackState>,
    request_id: String,
) -> Result<(), String> {
    state
        .pending
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .remove(request_id.trim());
    if let Some(cancel) = state
        .cancellations
        .lock()
        .map_err(|_| "OAuth callback state is unavailable.".to_string())?
        .remove(request_id.trim())
    {
        let _ = cancel.send(());
    }
    Ok(())
}

async fn run_loopback_listener(
    listener: TcpListener,
    request_id: String,
    tx: oneshot::Sender<Result<String, String>>,
    cancel_rx: oneshot::Receiver<()>,
) {
    let mut sender = Some(tx);
    // Matches the connector OAuth state lifetime on the server (ten minutes).
    let deadline = tokio::time::sleep(Duration::from_secs(10 * 60));
    tokio::pin!(deadline);
    tokio::pin!(cancel_rx);

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                if let Some(tx) = sender.take() {
                    let _ = tx.send(Err("OAuth sign-in was canceled.".to_string()));
                }
                return;
            }
            _ = &mut deadline => {
                if let Some(tx) = sender.take() {
                    let _ = tx.send(Err("OAuth sign-in timed out. Try again.".to_string()));
                }
                return;
            }
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue; };
                let completed = handle_loopback_connection(stream, &request_id, &mut sender).await;
                if completed {
                    return;
                }
            }
        }
    }
}

async fn handle_loopback_connection(
    mut stream: TcpStream,
    request_id: &str,
    sender: &mut Option<oneshot::Sender<Result<String, String>>>,
) -> bool {
    let Ok(Some(request)) =
        tokio::time::timeout(Duration::from_secs(10), read_loopback_request(&mut stream)).await
    else {
        return false;
    };
    let mut lines = request.lines();
    let first = lines.next().unwrap_or_default();

    if first.starts_with("GET ") {
        let html = completion_page_html(request_id);
        let _ = write_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            html.as_bytes(),
        )
        .await;
        return false;
    }

    if first.starts_with("POST ") && first.contains(&format!("/complete/{request_id}")) {
        let body = request
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or_default()
            .trim()
            .to_string();
        let _ = write_response(&mut stream, "200 OK", "text/plain; charset=utf-8", b"OK").await;
        if let Some(tx) = sender.take() {
            let _ = tx.send(Ok(body));
        }
        return true;
    }

    let _ = write_response(
        &mut stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        b"Not found",
    )
    .await;
    false
}

pub(crate) async fn read_loopback_request(stream: &mut TcpStream) -> Option<String> {
    let mut request = Vec::with_capacity(4 * 1024);
    let header_end = loop {
        let mut chunk = [0_u8; 4 * 1024];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.len() > MAX_LOOPBACK_REQUEST_BYTES {
            return None;
        }
        if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = std::str::from_utf8(&request[..header_end]).ok()?;
    let content_length = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(Some(0))?;
    let request_length = header_end.checked_add(content_length)?;
    if request_length > MAX_LOOPBACK_REQUEST_BYTES {
        return None;
    }
    while request.len() < request_length {
        let remaining = request_length - request.len();
        let mut chunk = [0_u8; 4 * 1024];
        let chunk_length = remaining.min(chunk.len());
        let read = stream.read(&mut chunk[..chunk_length]).await.ok()?;
        if read == 0 {
            return None;
        }
        request.extend_from_slice(&chunk[..read]);
    }
    request.truncate(request_length);
    String::from_utf8(request).ok()
}

pub(crate) async fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.shutdown().await
}

fn completion_page_html(request_id: &str) -> String {
    completion_page_document("loading", &completion_page_script(request_id))
}

fn completion_page_document(status: &str, script: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en" data-status="{status}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <link rel="icon" type="image/svg+xml" href="{favicon}" />
  <title>Kordi sign-in</title>
  <style>{style}</style>
</head>
<body>
  <div class="page">
    <header>
      <div class="brand" aria-label="Kordi">
        <svg viewBox='64 58 384 384' aria-hidden='true'><mask id='kordi-bird-cut' maskUnits='userSpaceOnUse' x='-100' y='-100' width='712' height='712'><ellipse cx='262' cy='292' rx='150' ry='136' fill='#fff'/><path d='M400,342 C436,322 462,272 470,204 C448,236 420,244 386,218Z' fill='#fff' stroke='#fff' stroke-width='4' stroke-linejoin='round'/><circle cx='194' cy='266' r='17'/><path d='M269.6,333.2 C292,299.6 348,282 397.6,285.2 C381.6,325.2 336.8,357.2 288.8,355.6 C272.8,354 264.8,344.4 269.6,333.2Z'/></mask><g transform='translate(256,250) scale(0.94) translate(-270,-292)'><path d='M120,276 L82,294 L120,312Z' fill='currentColor' stroke='currentColor' stroke-width='12' stroke-linejoin='round'/><rect x='-100' y='-100' width='712' height='712' fill='currentColor' mask='url(#kordi-bird-cut)'/></g></svg>
        <span>kordi</span>
      </div>
    </header>
    <main role="status" aria-live="polite">
      <section class="copy">
        <h1 data-title-loading>Signing in</h1>
        <h1 data-title-success>You’re signed in</h1>
        <h1 data-title-error>Couldn’t sign in</h1>

        <p data-sub-loading>Finishing sign-in with Kordi.</p>
        <p data-sub-success>You can close this tab and return to Kordi.</p>
        <p data-sub-error>Return to Kordi and try again.</p>
      </section>
    </main>
  </div>
  <script>{script}</script>
</body>
</html>"#,
        style = completion_page_css(),
        favicon = KORDI_FAVICON_DATA_URL,
    )
}

// This callback is served by a short-lived loopback listener, so it must remain
// self-contained. It follows the kordi.ai sign-in pages (logo top left, one
// centered title and line) without loading external fonts or assets.
fn completion_page_css() -> &'static str {
    r#"
    :root {
      color-scheme: light dark;
      --paper: #fcfaf8;
      --ink: #191817;
      --muted: #6d6865;
      --error: #8c1515;
    }

    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: var(--ink);
      background: var(--paper);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .page { min-height: 100vh; display: flex; flex-direction: column; }
    header { padding: 22px max(16px, calc((100vw - 1200px) / 2)); }
    .brand {
      width: fit-content;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--ink);
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -.02em;
      line-height: 1;
    }
    .brand svg { width: 22px; height: 22px; flex: 0 0 auto; }
    main { flex: 1; display: flex; justify-content: center; padding: clamp(56px, 20vh, 200px) 16px 56px; }
    .copy { width: min(100%, 420px); text-align: center; }
    h1 {
      display: none;
      margin: 0 0 12px;
      color: var(--ink);
      font-size: clamp(2.125rem, 1.5rem + 1.6vw, 2.75rem);
      font-weight: 600;
      line-height: 1.1;
      letter-spacing: -.045em;
      text-wrap: balance;
    }
    p {
      display: none;
      margin: 0;
      color: var(--muted);
      font-size: 1.0625rem;
      line-height: 1.6;
      text-wrap: balance;
    }
    [data-status="error"] [data-sub-error] { color: var(--error); }
    [data-status="loading"] [data-title-loading],
    [data-status="loading"] [data-sub-loading],
    [data-status="success"] [data-title-success],
    [data-status="success"] [data-sub-success],
    [data-status="error"]   [data-title-error],
    [data-status="error"]   [data-sub-error] { display: block; }

    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #191814;
        --ink: #f2efe9;
        --muted: #b8b0a7;
        --error: #e38b84;
      }
    }
    "#
}

fn completion_page_script(request_id: &str) -> String {
    format!(
        r#"
    (function() {{
      const root = document.documentElement;
      // The page boots in `loading` state via the data attribute on <html>;
      // we toggle to `success` / `error` after the POST resolves so CSS can
      // swap the visible title + subtitle without any flash.
      function setStatus(next) {{ root.setAttribute('data-status', next); }}

      fetch('/complete/{request_id}', {{
        method: 'POST',
        headers: {{ 'content-type': 'text/plain' }},
        body: window.location.hash || '',
      }})
        .then(function(res) {{ setStatus(res && res.ok ? 'success' : 'error'); }})
        .catch(function() {{ setStatus('error'); }});
    }})();
    "#
    )
}

#[cfg(test)]
#[path = "cloud_oauth_loopback/tests.rs"]
mod tests;
