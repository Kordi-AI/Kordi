use super::*;

fn background_session(conn: &rusqlite::Connection, parent_request: &str) -> Result<String> {
    kordi_session::store::create_session_with_parent_and_message(
        conn,
        "/tmp/test",
        Some("session:group:g1"),
        Some(parent_request),
    )
}

#[test]
fn a_task_restarted_from_a_follow_up_answers_the_original_request() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    let first = background_session(&conn, "msg:ui:original")?;
    let follow_up = format!("background-result:{first}:failed");
    assert_eq!(
        root_request_from_store(&conn, &follow_up)?,
        "msg:ui:original"
    );
    // A restart that itself failed and was restarted again.
    let second = background_session(&conn, &follow_up)?;
    let second_follow_up = format!("background-result:{second}:failed");
    assert_eq!(
        root_request_from_store(&conn, &second_follow_up)?,
        "msg:ui:original"
    );
    Ok(())
}

#[test]
fn other_request_ids_are_kept() -> Result<()> {
    let conn = kordi_session::store::open_memory()?;
    assert_eq!(
        root_request_from_store(&conn, " msg:ui:request ")?,
        "msg:ui:request"
    );
    // An unknown background session keeps the follow-up id.
    assert_eq!(
        root_request_from_store(&conn, "background-result:missing:done")?,
        "background-result:missing:done"
    );
    Ok(())
}
