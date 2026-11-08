//! One public web page read outside a tool call, for server features that read
//! a link a person gave them (a Grounding card's sources). It uses the same
//! public-only transport as shared `web_fetch`: no private or local networks,
//! ports 80 and 443 only, and every redirect is checked.

use super::*;

/// A fetched page, before any extraction. Non-success statuses are returned,
/// not raised, so callers can say why a page could not be read.
#[derive(Debug, Clone)]
pub struct PublicPage {
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    /// The body as text, cut at the byte limit.
    pub body: String,
}

/// Fetches `raw_url` over the public-only transport with the caller's user
/// agent, keeping at most `max_bytes` of the body.
pub async fn fetch_public_page(
    raw_url: &str,
    timeout: Duration,
    user_agent: &str,
    max_bytes: usize,
) -> KordiResult<PublicPage> {
    let url = parse_http_url("public_page", raw_url)?;
    crate::web::public::validate_url(&url)?;
    let client = crate::web::public::client(timeout, MAX_REDIRECTS)?;
    let mut response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, user_agent)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, "en")
        .send()
        .await
        .map_err(|error| KordiError::Tool(format!("Page request failed: {error}")))?;
    let final_url = response.url().to_string();
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| KordiError::Tool(format!("Could not read the page: {error}")))?
    {
        let room = max_bytes.saturating_sub(bytes.len());
        if chunk.len() >= room {
            bytes.extend_from_slice(&chunk[..room]);
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(PublicPage {
        final_url,
        status,
        content_type,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// A page's title and readable text, without scripts, navigation or markup.
pub fn page_text(html: &str) -> (Option<String>, String) {
    (extract_title(html), extract_main_content_text(html).0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_local_and_private_addresses() {
        for url in [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://169.254.169.254/latest",
        ] {
            let error = fetch_public_page(url, Duration::from_secs(1), "test", 1024)
                .await
                .expect_err(url);
            assert!(error.to_string().contains("public"), "{url}: {error}");
        }
    }

    #[test]
    fn page_text_keeps_the_title_and_visible_text() {
        let (title, text) = page_text(
            "<html><head><title>Jane Doe</title><script>x()</script></head><body><nav>Menu</nav><main><h1>Jane Doe</h1><p>Works on agent memory.</p></main></body></html>",
        );
        assert_eq!(title.as_deref(), Some("Jane Doe"));
        assert!(text.contains("Works on agent memory."));
        assert!(!text.contains("x()"));
    }
}
