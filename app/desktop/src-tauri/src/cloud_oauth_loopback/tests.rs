mod completion_page_tests {
    use super::super::{completion_page_html, KORDI_FAVICON_DATA_URL};

    fn visible_copy_rules(html: &str) -> usize {
        html.matches("[data-copy~=\"").count()
    }

    #[test]
    fn renders_kordi_header_and_boots_as_account_loading() {
        let html = completion_page_html("cloud_oauth_abc123");

        // The page boots in the account loading state; the script switches the
        // kind for connector grants and the status once the POST resolves.
        assert!(html.contains("data-status=\"loading\" data-kind=\"account\""));
        assert!(html.contains("<header class=\"mast\">"));
        assert!(html.contains("<span>kordi</span>"));
        assert!(html.contains("rel=\"icon\" type=\"image/svg+xml\""));
        assert!(html.contains(KORDI_FAVICON_DATA_URL));
        assert!(html.contains("mask='url(#kordi-bird-cut)'"));
        assert!(html.contains("fill='#f7b32b'"), "bird keeps its amber beak");
        assert!(html.contains("<title>Sign in · Kordi</title>"));
        assert!(html.contains("role=\"status\" aria-live=\"polite\""));

        // Every kind and status pair has pre-rendered copy and one CSS rule,
        // so switching states never shifts the layout.
        for copy in [
            "account-loading",
            "account-success",
            "account-error",
            "connector-loading",
            "connector-success",
            "connector-error",
        ] {
            assert!(
                html.contains(&format!("data-copy=\"{copy}\"")),
                "missing title: {copy}"
            );
        }
        assert_eq!(visible_copy_rules(&html), 6);
    }

    #[test]
    fn account_copy_is_a_title_and_one_short_line() {
        let html = completion_page_html("cloud_oauth_abc123");

        assert!(html.contains(">Signing in…</h1>"));
        assert!(html.contains(">You’re signed in</h1>"));
        assert!(html.contains(">Couldn’t sign in</h1>"));
        assert!(html.contains("You can close this tab and go back to Kordi."));
        assert!(html.contains("Go back to Kordi and try again."));
        for removed in [
            "Signed in.",
            "Your account is connected",
            "Finishing the secure browser handoff",
            "Kordi sign-in",
            "&copy; Kordi 2026",
            "Close window",
            "<button",
            "Authentication Successful",
            "KORDI LOGIN",
        ] {
            assert!(!html.contains(removed), "unexpected copy: {removed}");
        }
    }

    #[test]
    fn connector_grants_name_the_provider_from_the_fragment() {
        let html = completion_page_html("cloud_oauth_connector");

        assert!(html.contains("params.has('kordi_connector')"));
        assert!(html.contains("params.has('kordi_connector_error')"));
        assert!(html.contains("JSON.parse(atob(encoded)).provider"));
        // Only listed providers are named; inherited keys such as `constructor` are not.
        assert!(html.contains("Object.prototype.hasOwnProperty.call(names, id)"));
        for (id, name) in [
            ("github", "GitHub"),
            ("gmail", "Gmail"),
            ("google_calendar", "Google Calendar"),
            ("slack", "Slack"),
            ("outlook", "Outlook"),
        ] {
            assert!(
                html.contains(&format!("{id}: '{name}'")),
                "missing provider: {id}"
            );
        }
        assert!(
            html.contains("Connecting <span data-provider=\"your account\">your account</span>…")
        );
        assert!(html.contains("<span data-provider=\"Account\">Account</span> connected"));
        assert!(html
            .contains("Couldn’t connect <span data-provider=\"your account\">your account</span>"));
        assert!(html.contains("'Connect ' + provider"));
        // Provider names are written as text, never parsed as markup.
        assert!(html.contains("node.textContent ="));
        assert!(!html.contains("innerHTML"));
    }

    #[test]
    fn script_posts_the_fragment_and_reports_fragment_errors() {
        let html = completion_page_html("cloud_oauth_xyz789");
        assert!(html.contains("fetch('/complete/cloud_oauth_xyz789'"));
        assert!(html.contains("method: 'POST'"));
        assert!(html.contains("body: window.location.hash || ''"));
        assert!(html.contains("params.has('kordi_cloud_oauth_error')"));
        assert!(html.contains("res.ok && !failed ? 'success' : 'error'"));
    }

    #[test]
    fn page_uses_the_kordi_web_palette_type_and_dark_mode() {
        let html = completion_page_html("cloud_oauth_palette");

        assert!(html.contains("--paper: #fcfaf8"));
        assert!(html.contains("--cardinal: #8c1515"));
        assert!(html.contains("--paper: #191817"));
        assert!(html.contains("prefers-color-scheme: dark"));
        assert!(html.contains(
            "--sans: Geist, -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif"
        ));
        assert!(html.contains("font-size: clamp(2.5rem, 1.6rem + 2.6vw, 3.75rem);"));
        assert!(html.contains("font-weight: 600;"));
        assert!(html.contains("border-top-color: var(--cardinal)"));
        assert!(html.contains("prefers-reduced-motion: reduce"));
        assert!(!html.contains("Iowan Old Style"));
        assert!(!html.contains("Palatino"));
        assert!(!html.contains("text-transform: uppercase"));
        assert!(!html.contains("linear-gradient"));
        assert!(!html.contains("filter: blur"));
    }

    #[test]
    fn page_has_no_external_network_or_banned_design_patterns() {
        let html = completion_page_html("cloud_oauth_selfcontained");

        // The loopback server can't proxy external assets and we don't want
        // the callback page to phone home, so the page must be self-contained.
        for forbidden in [
            "fonts.googleapis",
            "fonts.gstatic",
            "cdn.",
            "https://",
            "url(\"",
            "@font-face",
        ] {
            assert!(
                !html.contains(forbidden),
                "callback page must not reference external resources: {forbidden}"
            );
        }

        assert!(!html.contains("background-clip: text"));
        assert!(!html.contains("border-left: 4px"));
        assert!(!html.contains("border-left: 3px"));
        assert!(!html.contains("class=\"card\""));
        assert!(!html.contains("outline:"), "no focus rings on this page");
        // Only the bird mark's beak, tail and wing paths: no status icons.
        assert_eq!(html.matches("<path").count(), 3);
    }
}

mod completion_page_preview {
    use super::super::completion_page_html;
    use std::fs;

    // Gated on KORDI_RENDER_OAUTH_CALLBACK to keep CI runs from writing files.
    // Run with: KORDI_RENDER_OAUTH_CALLBACK=1 cargo test -p kordi-desktop --lib completion_page_preview -- --nocapture
    #[test]
    fn render_to_tmp() {
        if std::env::var("KORDI_RENDER_OAUTH_CALLBACK").is_err() {
            return;
        }
        let html = completion_page_html("preview");
        let path = std::env::temp_dir().join("kordi-oauth-callback.html");
        fs::write(&path, &html).expect("write preview");
        println!("preview: {}", path.display());
    }
}

mod request_tests {
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::oneshot;
    use tokio::time::{sleep, timeout};

    use super::super::handle_loopback_connection;

    #[tokio::test]
    async fn waits_for_a_split_post_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = "#kordi_cloud_oauth=encoded-session";
        let client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream
                .write_all(
                    format!(
                        "POST /complete/cloud_oauth_split HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            sleep(Duration::from_millis(50)).await;
            stream.write_all(body.as_bytes()).await.unwrap();
        });
        let (stream, _) = listener.accept().await.unwrap();
        let (tx, rx) = oneshot::channel();
        let mut sender = Some(tx);

        let completed = timeout(
            Duration::from_secs(1),
            handle_loopback_connection(stream, "cloud_oauth_split", &mut sender),
        )
        .await
        .unwrap();

        assert!(completed);
        assert_eq!(rx.await.unwrap(), Ok(body.to_string()));
        client.await.unwrap();
    }
}

mod cancellation_tests {
    use std::time::Duration;

    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::oneshot;
    use tokio::time::timeout;

    use super::super::run_loopback_listener;

    #[tokio::test]
    async fn cancellation_closes_the_listener_without_waiting_for_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (result_tx, result_rx) = oneshot::channel();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let task = tokio::spawn(run_loopback_listener(
            listener,
            "cloud_oauth_cancelled".to_string(),
            result_tx,
            cancel_rx,
        ));

        cancel_tx.send(()).unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), result_rx)
                .await
                .unwrap()
                .unwrap(),
            Err("OAuth sign-in was canceled.".to_string())
        );
        timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert!(TcpStream::connect(address).await.is_err());
    }
}
