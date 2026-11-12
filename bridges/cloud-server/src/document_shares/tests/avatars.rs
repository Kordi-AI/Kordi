use super::super::access::syncable_avatar_url;
use super::super::model::DocumentFormat;
use super::super::public_page::{document_page, public_avatar_src, PageInput};
use super::sample_record;

#[test]
fn uploaded_avatars_reach_document_people_and_the_public_page() {
    let marker = crate::avatars::assets::uploaded_avatar_marker(&format!("ava_{}", "a".repeat(32)))
        .expect("uploaded marker");
    assert_eq!(
        syncable_avatar_url(&marker).as_deref(),
        Some(marker.as_str())
    );
    assert_eq!(
        syncable_avatar_url("kordi-avatar://uploaded/not-an-asset"),
        None
    );
    assert_eq!(syncable_avatar_url("javascript:alert(1)"), None);

    assert_eq!(
        public_avatar_src(&marker).as_deref(),
        Some(format!("/v1/avatars/assets/ava_{}/128.jpg", "a".repeat(32)).as_str())
    );
    assert_eq!(
        public_avatar_src("https://example.com/a.png").as_deref(),
        Some("https://example.com/a.png")
    );
    assert_eq!(public_avatar_src("http://example.com/a.png"), None);

    let mut record = sample_record(DocumentFormat::Markdown, "Alex Morgan");
    record.author.avatar_url = Some(marker);
    let page = document_page(
        &PageInput {
            token: &format!("kordi_ds_{}", "A".repeat(43)),
            record: &record,
            source: "Hello",
        },
        "nonce",
    );
    assert!(page.contains(&format!(
        r#"<img alt="" src="/v1/avatars/assets/ava_{}/128.jpg">"#,
        "a".repeat(32)
    )));
}
