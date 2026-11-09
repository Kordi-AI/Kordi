use super::*;

const LIMITS: (Duration, Duration) = (Duration::from_millis(50), Duration::from_millis(200));

fn link(url: &str) -> Gathered {
    Gathered {
        source: "Link".into(),
        title: url.into(),
        date: None,
        url: Some(url.into()),
        text: url.into(),
    }
}

fn note() -> Gathered {
    Gathered {
        source: "Notes".into(),
        title: "Your notes".into(),
        date: None,
        url: None,
        text: "Working on agent evaluation.".into(),
    }
}

/// A synthetic profile page with the markup Google Scholar profiles use.
const SCHOLAR_PAGE: &str = r#"<html><head><title>&#8234;Jane Doe&#8236; - &#8234;Google Scholar&#8236;</title>
<meta name="description" content="Professor of Computer Science"></head><body>
<div id="gsc_prf_in">Jane Doe</div>
<div class="gsc_prf_il">Professor of Computer Science, <a class="gsc_prf_ila" href="/x">Example University</a></div>
<div class="gsc_prf_il" id="gsc_prf_int"><a href="/a" class="gsc_prf_inta gs_ibl">multi-agent systems</a><a href="/b" class="gsc_prf_inta gs_ibl">AI evaluation</a></div>
<table><tr><td><a href="javascript:void(0)" data-href="/p1" class="gsc_a_at">Evaluating agents in the wild</a></td></tr>
<tr><td><a href="javascript:void(0)" data-href="/p2" class="gsc_a_at">Cooperation &amp; trust among LLM agents</a></td></tr></table>
</body></html>"#;

#[test]
fn scholar_profiles_read_name_affiliation_interests_and_papers() {
    let page = classify(
        200,
        "https://scholar.google.com/citations?user=abcDEF123&hl=en",
        "text/html; charset=UTF-8",
        SCHOLAR_PAGE,
    )
    .expect("readable profile");
    assert_eq!(page.title.as_deref(), Some("Jane Doe - Google Scholar"));
    assert!(page
        .text
        .starts_with("Jane Doe · Professor of Computer Science, Example University"));
    assert!(page
        .text
        .contains("Research interests: multi-agent systems, AI evaluation"));
    assert!(page
        .text
        .contains("Papers: Evaluating agents in the wild; Cooperation & trust among LLM agents"));
}

#[test]
fn refused_and_challenge_pages_are_reported_not_read() {
    let blocked = |status, url, body| classify(status, url, "text/html", body).unwrap_err();
    assert_eq!(
        blocked(
            429,
            "https://scholar.google.com/citations?user=x",
            "Too many"
        ),
        LinkFailure::Blocked
    );
    assert_eq!(
        blocked(
            200,
            "https://www.google.com/sorry/index?continue=https://scholar.google.com/citations",
            "<html><body>Our systems have detected unusual traffic from your computer network.</body></html>"
        ),
        LinkFailure::Blocked
    );
    assert_eq!(
        blocked(
            200,
            "https://scholar.google.com/citations?user=x",
            "<html><body><div id=\"gs_captcha_ccl\">Please show you're not a robot</div></body></html>"
        ),
        LinkFailure::Blocked
    );
    assert_eq!(
        blocked(
            200,
            "https://accounts.google.com/v3/signin",
            "<html><body>Sign in to continue to Google Scholar and more</body></html>"
        ),
        LinkFailure::SignIn
    );
    assert_eq!(
        blocked(404, "https://example.com/gone", ""),
        LinkFailure::NotFound
    );
    // A page that is only a script shell has nothing to read.
    assert_eq!(
        blocked(
            200,
            "https://example.com/app",
            "<html><body><div id=\"root\"></div><script>start()</script></body></html>"
        ),
        LinkFailure::Unreadable
    );
}

#[test]
fn ordinary_pages_keep_their_title_description_and_text() {
    let page = classify(
        200,
        "https://example.com/~jane",
        "text/html",
        r#"<html><head><title>Jane Doe</title><meta name="description" content="Researcher in agent evaluation."></head>
<body><nav>Home</nav><main><p>I study how people and AI agents work together in teams.</p></main></body></html>"#,
    )
    .expect("readable page");
    assert_eq!(page.title.as_deref(), Some("Jane Doe"));
    assert!(page.text.starts_with("Researcher in agent evaluation."));
    assert!(page
        .text
        .contains("I study how people and AI agents work together in teams."));
    assert!(!page.text.contains("Home"));
}

#[tokio::test]
async fn read_links_fills_pages_and_reports_the_ones_it_could_not_read() {
    let mut evidence = vec![
        note(),
        link("https://example.com/~jane"),
        link("https://scholar.google.com/citations?user=abc"),
    ];
    let unread = read_with(
        &mut evidence,
        |url: String| async move {
            if url.contains("scholar") {
                Err(LinkFailure::Blocked)
            } else {
                Ok(PageText {
                    title: Some("Jane Doe".into()),
                    text: "I study how people and AI agents work together.".into(),
                })
            }
        },
        LIMITS,
    )
    .await;
    assert_eq!(
        unread,
        vec![UnreadLink {
            url: "https://scholar.google.com/citations?user=abc".into(),
            reason: "blocked".into(),
        }]
    );
    assert_eq!(evidence[0], note());
    assert_eq!(evidence[1].title, "Jane Doe");
    assert_eq!(
        evidence[1].text,
        "I study how people and AI agents work together."
    );
    assert_eq!(
        evidence[1].url.as_deref(),
        Some("https://example.com/~jane")
    );
    // The model is told the page was not read, so it does not guess from the address.
    assert!(evidence[2].text.ends_with("(This page could not be read.)"));
    assert_eq!(
        evidence[2].url.as_deref(),
        Some("https://scholar.google.com/citations?user=abc")
    );
}

#[tokio::test]
async fn a_link_that_never_answers_times_out_as_unreachable() {
    let mut evidence = vec![link("https://slow.example.com/")];
    let unread = read_with(
        &mut evidence,
        |_url: String| async move {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok(PageText {
                title: None,
                text: String::new(),
            })
        },
        LIMITS,
    )
    .await;
    assert_eq!(unread.len(), 1);
    assert_eq!(unread[0].reason, "unreachable");
}
