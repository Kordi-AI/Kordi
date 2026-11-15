//! Room gallery rules that need no database: the routes, titles, file
//! names, which files get a text preview, and how the preview is cut.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::IntoResponse;
use sqlx_postgres::PgPoolOptions;
use tower::ServiceExt;

use super::super::gallery::{file_name_for, never_render, preview_text, text_like, title_for};
use crate::events::EventBus;
use crate::server::ServerState;

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
fn content_answers_are_never_rendered_as_a_page() {
    let partial = (
        StatusCode::PARTIAL_CONTENT,
        [("content-type", "text/html")],
        "<script>",
    )
        .into_response();
    let response = never_render(partial);
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    let headers = response.headers();
    assert_eq!(headers["content-type"], "text/html");
    assert_eq!(
        headers["content-security-policy"],
        "sandbox; default-src 'none'"
    );
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["content-disposition"], "attachment");
}
