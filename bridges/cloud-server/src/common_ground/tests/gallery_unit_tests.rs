//! Room gallery rules that need no database: the routes, titles, file
//! names, which files get a text preview, and how the preview is cut.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use chrono::Utc;
use sqlx_postgres::PgPoolOptions;
use tower::ServiceExt;

use super::super::gallery::{
    candidate_title, copies, file_name_for, readable_text, text_like, title_for, Artifact, Copies,
    HEAD_CHARS,
};
use crate::events::EventBus;
use crate::server::ServerState;

/// An artifact whose title without its text is `title`.
fn artifact(content_type: Option<&str>, file_name: &str, title: &str) -> Artifact {
    Artifact {
        attachment_id: "att_unit".to_string(),
        object_key: "att_unit".to_string(),
        title: title.to_string(),
        file_name: file_name.to_string(),
        content_type: content_type.map(str::to_string),
        size_bytes: Some(10),
        updated_at: Utc::now(),
        head: None,
    }
}

#[tokio::test]
async fn every_gallery_route_is_mounted_behind_the_session() {
    // The session check refuses before any database access.
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = crate::server::router(Arc::new(ServerState::new(pool, EventBus::noop())));
    let room = "/v1/cloud/common-ground/rooms/1234/gallery";
    let item = format!("{room}/00000000-0000-0000-0000-000000000001");
    for (method, path) in [
        ("GET", room.to_string()),
        ("POST", room.to_string()),
        ("GET", format!("{room}/candidates")),
        ("GET", item.clone()),
        ("DELETE", item.clone()),
        ("GET", format!("{item}/content")),
        ("POST", format!("{item}/comments")),
        (
            "DELETE",
            format!("{item}/comments/00000000-0000-0000-0000-000000000002"),
        ),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(&path)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
    }
}

#[test]
fn titles_prefer_the_rename_then_the_agent_title_then_the_file_name() {
    assert_eq!(
        title_for(Some(" Research   plan "), Some("Agent"), Some("a.md")),
        "Research plan"
    );
    assert_eq!(
        title_for(Some("  "), Some("Agent report"), None),
        "Agent report"
    );
    assert_eq!(
        title_for(None, None, Some("notes/Q3 plan.final.md")),
        "Q3 plan.final"
    );
    assert_eq!(title_for(None, None, Some(".env")), ".env");
    assert_eq!(title_for(None, None, None), "Untitled");
    assert_eq!(title_for(None, None, Some("   ")), "Untitled");
    let long = "x".repeat(300);
    assert_eq!(title_for(Some(&long), None, None).chars().count(), 200);
}

#[test]
fn file_names_are_never_empty() {
    assert_eq!(file_name_for(Some(" report.pdf ")), "report.pdf");
    assert_eq!(file_name_for(Some("")), "Untitled");
    assert_eq!(file_name_for(None), "Untitled");
}

#[test]
fn text_files_are_told_by_content_type_or_extension() {
    for (content_type, name) in [
        (Some("text/markdown"), "a"),
        (Some("text/plain; charset=utf-8"), "a"),
        (Some("text/csv"), "a"),
        (Some("application/json"), "a"),
        (None, "notes.md"),
        (Some(""), "data.tsv"),
        (Some("application/octet-stream"), "main.RS"),
    ] {
        assert!(text_like(content_type, name), "{content_type:?} {name}");
    }
    for (content_type, name) in [
        (Some("image/png"), "a.md"),
        (Some("application/pdf"), "a.txt"),
        (None, "archive.zip"),
        (None, "README"),
        (None, ".md"),
    ] {
        assert!(!text_like(content_type, name), "{content_type:?} {name}");
    }
}

#[test]
fn previews_are_cut_on_a_character_boundary() {
    let notes = artifact(Some("text/plain"), "notes.txt", "notes");
    let preview_text = |bytes: &[u8]| copies(&notes, readable_text(bytes)).preview;
    let text = "é".repeat(900);
    let preview = preview_text(text.as_bytes()).unwrap();
    assert_eq!(preview.chars().count(), 800);
    assert!(preview.chars().all(|c| c == 'é'));
    assert_eq!(
        preview_text("\u{feff}# Plan".as_bytes()).as_deref(),
        Some("# Plan")
    );
    assert_eq!(preview_text(b"short").as_deref(), Some("short"));
    assert_eq!(preview_text(&[0xff, 0xfe, 0x00]), None, "not UTF-8");
    assert_eq!(preview_text(b"a\0b"), None, "binary");
    assert_eq!(preview_text(b"  \n "), None, "blank");
}

#[test]
fn a_document_title_comes_from_its_heading() {
    let markdown = artifact(Some("text/markdown"), "Untitled", "Renamed");
    // The heading wins over a renamed title, as in the chat reader.
    let text = "Intro\n\n# Field  notes\n\nBody";
    assert_eq!(
        copies(&markdown, Some(text)),
        Copies {
            title: "Field notes".to_string(),
            preview: Some(text.to_string()),
        }
    );
    assert_eq!(
        copies(&markdown, Some("## Only a subheading")).title,
        "Renamed"
    );
    assert_eq!(copies(&markdown, Some("No heading")).title, "Renamed");
    assert_eq!(copies(&markdown, None).title, "Renamed", "unread text");
    let by_name = artifact(Some("application/octet-stream"), "plan.md", "plan");
    assert_eq!(copies(&by_name, Some("# Plan")).title, "Plan");

    let html = artifact(Some("text/html"), "page.html", "page");
    let page = "<html><head><title>Q3 &amp; Q4</title></head><h1>Body</h1></html>";
    assert_eq!(copies(&html, Some(page)).title, "Q3 & Q4");
    assert_eq!(
        copies(&html, Some("<h1>No title element</h1>")).title,
        "page"
    );

    // Text files that are not documents keep the title without their text.
    for (content_type, name) in [
        (Some("text/plain"), "notes.txt"),
        (Some("application/json"), "notes.json"),
        (None, "notes.py"),
    ] {
        let file = artifact(content_type, name, "notes");
        assert_eq!(
            copies(&file, Some("# Not a title")).title,
            "notes",
            "{name}"
        );
    }
}

#[test]
fn candidate_titles_read_only_whole_lines_of_the_stored_head() {
    let limit = HEAD_CHARS as usize;
    let mut document = artifact(Some("text/markdown"), "Untitled", "Renamed");
    assert_eq!(candidate_title(&document), "Renamed", "no stored text");
    document.head = Some("\u{feff}# Plan\n\nText".to_string());
    assert_eq!(candidate_title(&document), "Plan");

    // A head at the limit may stop mid-line, so its last line is not read.
    let filler = format!("{}\n", "x".repeat(limit - 10));
    let cut = format!("{filler}# Heading");
    assert_eq!(cut.chars().count(), limit);
    document.head = Some(cut);
    assert_eq!(candidate_title(&document), "Renamed");
    // Shorter than the limit, the head is the whole text.
    document.head = Some(format!("{filler}# Head"));
    assert_eq!(candidate_title(&document), "Head");
    // Earlier lines still count at the limit.
    document.head = Some(format!("# Plan\n{}", "x".repeat(limit - 7)));
    assert_eq!(candidate_title(&document), "Plan");
    document.head = Some(format!("# {}", "x".repeat(limit - 2)));
    assert_eq!(candidate_title(&document), "Renamed", "one cut line");

    // Stored text of a file that is not a document gives no heading.
    let mut notes = artifact(Some("text/plain"), "notes.txt", "notes");
    notes.head = Some("# Plan".to_string());
    assert_eq!(candidate_title(&notes), "notes");
}
