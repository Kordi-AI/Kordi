//! Reading the links a card build was given. Each public page is fetched once,
//! when the build starts, with an honest user agent and the public-only
//! transport shared with `web_fetch`. A page that is blocked, needs sign-in or
//! has no readable text keeps only its address and is reported back, so the
//! owner sees which links were not read instead of the build ignoring them.
//! Nothing here retries or works around a site that refuses the request.

use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::Regex;
use tokio::task::JoinSet;

use crate::common_ground::card::UnreadLink;
use crate::common_ground::prompt::Gathered;
use crate::common_ground::redact::{redact, squeeze};

/// Links read per build; later links keep only their address.
const MAX_READ_LINKS: usize = 6;
const LINK_TIMEOUT: Duration = Duration::from_secs(8);
/// Every link is read at the same time; this bounds the whole step.
const ALL_LINKS_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PAGE_BYTES: usize = 1_500_000;
/// Characters of a page's text the model reads.
const LINK_TEXT_CHARS: usize = 2_000;
const MAX_LINK_TITLE_CHARS: usize = 140;
/// Text shorter than this is a shell page (one that needs scripts or sign-in).
const MIN_TEXT_CHARS: usize = 40;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; KordiGrounding/1.0; +https://kordi.ai)";
/// What the model reads after a link it could not open, so it does not guess
/// from the address.
const NOT_READ_NOTE: &str = "(This page could not be read.)";

/// Why a link was not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LinkFailure {
    /// The site refused automated requests (403, 429, a challenge page).
    Blocked,
    /// The page needs the person to sign in.
    SignIn,
    NotFound,
    /// Timed out, or no public address.
    Unreachable,
    /// The page has no text to read (scripts only, or not a web page).
    Unreadable,
}

impl LinkFailure {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::SignIn => "sign_in",
            Self::NotFound => "not_found",
            Self::Unreachable => "unreachable",
            Self::Unreadable => "unreadable",
        }
    }
}

/// A page that was read: its title, when it has one, and its text.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct PageText {
    pub title: Option<String>,
    pub text: String,
}

/// Reads the link items in `evidence` in place and returns the links that
/// could not be read.
pub(super) async fn read(evidence: &mut [Gathered]) -> Vec<UnreadLink> {
    read_with(evidence, fetch, (LINK_TIMEOUT, ALL_LINKS_TIMEOUT)).await
}

/// `read` with the fetcher and the (per link, whole step) time limits passed
/// in, for tests.
pub(super) async fn read_with<F, Fut>(
    evidence: &mut [Gathered],
    fetch: F,
    (link_timeout, all_timeout): (Duration, Duration),
) -> Vec<UnreadLink>
where
    F: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<PageText, LinkFailure>> + Send + 'static,
{
    let targets: Vec<(usize, String)> = evidence
        .iter()
        .enumerate()
        .filter_map(|(index, item)| item.url.clone().map(|url| (index, url)))
        .take(MAX_READ_LINKS)
        .collect();
    if targets.is_empty() {
        return Vec::new();
    }
    let fetch = Arc::new(fetch);
    let mut tasks = JoinSet::new();
    for (index, url) in &targets {
        let fetch = Arc::clone(&fetch);
        let (index, url) = (*index, url.clone());
        tasks.spawn(async move {
            let result = match tokio::time::timeout(link_timeout, fetch(url)).await {
                Ok(result) => result,
                Err(_) => Err(LinkFailure::Unreachable),
            };
            (index, result)
        });
    }
    let mut results: Vec<(usize, Result<PageText, LinkFailure>)> = Vec::new();
    let _ = tokio::time::timeout(all_timeout, async {
        while let Some(joined) = tasks.join_next().await {
            if let Ok(result) = joined {
                results.push(result);
            }
        }
    })
    .await;
    tasks.abort_all();
    let mut unread = Vec::new();
    for (index, url) in targets {
        let result = results
            .iter()
            .find(|(done, _)| *done == index)
            .map(|(_, result)| result.clone())
            .unwrap_or(Err(LinkFailure::Unreachable));
        let item = &mut evidence[index];
        match result {
            Ok(page) => {
                if let Some(title) = page.title.filter(|title| !title.trim().is_empty()) {
                    item.title = squeeze(&redact(&title), MAX_LINK_TITLE_CHARS);
                }
                item.text = squeeze(&redact(&page.text), LINK_TEXT_CHARS);
            }
            Err(failure) => {
                item.text = format!("{} {NOT_READ_NOTE}", item.text);
                unread.push(UnreadLink {
                    url,
                    reason: failure.code().to_string(),
                });
            }
        }
    }
    unread
}

async fn fetch(url: String) -> Result<PageText, LinkFailure> {
    let page =
        kordi_tools::web_fetch::fetch_public_page(&url, LINK_TIMEOUT, USER_AGENT, MAX_PAGE_BYTES)
            .await
            .map_err(|_| LinkFailure::Unreachable)?;
    tokio::task::spawn_blocking(move || {
        classify(page.status, &page.final_url, &page.content_type, &page.body)
    })
    .await
    .unwrap_or(Err(LinkFailure::Unreadable))
}

/// Pages (host and path) that only ask someone signed out to sign in.
const SIGN_IN_PAGES: [&str; 4] = [
    "accounts.google.com",
    "login.microsoftonline.com",
    "www.linkedin.com/authwall",
    "www.linkedin.com/login",
];

/// Words of a challenge page served instead of the content.
const CHALLENGE_MARKERS: [&str; 5] = [
    "unusual traffic from your computer",
    "id=\"gs_captcha",
    "g-recaptcha",
    "cf-challenge",
    "please verify you are a human",
];

/// Turns a fetched page into text, or says why it cannot be read.
pub(super) fn classify(
    status: u16,
    final_url: &str,
    content_type: &str,
    body: &str,
) -> Result<PageText, LinkFailure> {
    let landed = final_url
        .split_once("://")
        .map_or(final_url, |(_, rest)| rest)
        .to_ascii_lowercase();
    if SIGN_IN_PAGES.iter().any(|host| landed.starts_with(host)) {
        return Err(LinkFailure::SignIn);
    }
    // Google answers a refused request with a redirect to its "sorry" page.
    if landed.contains("google.com/sorry/") {
        return Err(LinkFailure::Blocked);
    }
    match status {
        200..=299 => {}
        401 => return Err(LinkFailure::SignIn),
        403 | 429 | 503 => return Err(LinkFailure::Blocked),
        404 | 410 => return Err(LinkFailure::NotFound),
        _ => return Err(LinkFailure::Unreadable),
    }
    let lower_head: String = body
        .chars()
        .take(200_000)
        .collect::<String>()
        .to_lowercase();
    if CHALLENGE_MARKERS
        .iter()
        .any(|marker| lower_head.contains(marker))
    {
        return Err(LinkFailure::Blocked);
    }
    let html = content_type.contains("html")
        || lower_head.contains("<html")
        || lower_head.contains("<body");
    let page = if landed.starts_with("scholar.google.") {
        scholar_profile(body).ok_or(LinkFailure::Unreadable)?
    } else if html {
        let (title, text) = kordi_tools::web_fetch::page_text(body);
        let description = meta_description(body);
        let text = match description {
            Some(description) if !text.contains(&description) => format!("{description}\n{text}"),
            _ => text,
        };
        PageText { title, text }
    } else if content_type.starts_with("text/") || content_type.is_empty() {
        PageText {
            title: None,
            text: body.to_string(),
        }
    } else {
        return Err(LinkFailure::Unreadable);
    };
    let text = page.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() < MIN_TEXT_CHARS {
        return Err(LinkFailure::Unreadable);
    }
    Ok(PageText {
        title: page.title.map(|title| clean_inline(&title)),
        text,
    })
}

static META_DESCRIPTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<meta\s+[^>]*name=["'](?:og:)?description["'][^>]*content=["']([^"']*)["']"#)
        .expect("valid meta description regex")
});
static SCHOLAR_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div id="gsc_prf_in"[^>]*>(.*?)</div>"#).expect("valid scholar name regex")
});
static SCHOLAR_AFFILIATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div class="gsc_prf_il">(.*?)</div>"#).expect("valid affiliation regex")
});
static SCHOLAR_INTEREST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a [^>]*class="gsc_prf_inta[^"]*"[^>]*>(.*?)</a>"#)
        .expect("valid interest regex")
});
static SCHOLAR_PAPER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a [^>]*class="gsc_a_at"[^>]*>(.*?)</a>"#).expect("valid paper regex")
});
static TAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<[^>]+>").expect("valid tag regex"));

/// Text between tags, with entities decoded and bidirectional marks removed.
fn clean_inline(html: &str) -> String {
    let text = TAGS.replace_all(html, " ");
    let text = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    text.chars()
        .filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn meta_description(html: &str) -> Option<String> {
    META_DESCRIPTION
        .captures(html)
        .and_then(|caps| caps.get(1))
        .map(|found| clean_inline(found.as_str()))
        .filter(|text| !text.is_empty())
}

/// A Google Scholar profile: the name, affiliation, interests and the paper
/// titles it lists. The generic reader would mostly see table chrome.
fn scholar_profile(html: &str) -> Option<PageText> {
    let name = SCHOLAR_NAME
        .captures(html)
        .and_then(|caps| caps.get(1))
        .map(|found| clean_inline(found.as_str()))
        .filter(|name| !name.is_empty())?;
    let affiliation = SCHOLAR_AFFILIATION
        .captures(html)
        .and_then(|caps| caps.get(1))
        .map(|found| clean_inline(found.as_str()))
        .unwrap_or_default();
    let all = |pattern: &Regex| -> Vec<String> {
        pattern
            .captures_iter(html)
            .filter_map(|caps| caps.get(1).map(|found| clean_inline(found.as_str())))
            .filter(|text| !text.is_empty())
            .collect()
    };
    let interests = all(&SCHOLAR_INTEREST);
    let papers = all(&SCHOLAR_PAPER);
    let mut lines = vec![name.clone()];
    if !affiliation.is_empty() {
        lines.push(affiliation);
    }
    if !interests.is_empty() {
        lines.push(format!("Research interests: {}", interests.join(", ")));
    }
    if !papers.is_empty() {
        lines.push(format!("Papers: {}", papers.join("; ")));
    }
    Some(PageText {
        title: Some(format!("{name} - Google Scholar")),
        text: lines.join(" · "),
    })
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod tests;
