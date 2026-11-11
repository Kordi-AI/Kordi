//! A text message must say something: an empty text block with no other
//! block or attachment is a client bug, never a message people should see.
use axum::http::StatusCode;
use serde_json::{Map, Value};

use super::http::MessageValidationError;

pub(super) fn reject_empty_text(
    kind: &str,
    content: &Map<String, Value>,
    attachment_ids: &[String],
) -> Result<(), MessageValidationError> {
    let blocks = content.get("blocks").and_then(Value::as_array);
    let says_nothing = blocks.is_some_and(|blocks| {
        blocks.iter().all(|block| {
            block["type"] == "text"
                && block["text"]
                    .as_str()
                    .is_none_or(|text| text.trim().is_empty())
        })
    });
    let attached = !attachment_ids.is_empty()
        || content
            .get("legacy_attachments")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
    if kind == "text" && says_nothing && !attached {
        return Err(MessageValidationError {
            status: StatusCode::BAD_REQUEST,
            code: "EMPTY_MESSAGE",
            message: "A message needs text or an attachment.",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::reject_empty_text;
    use serde_json::json;

    #[test]
    fn an_empty_text_message_is_refused_but_attachments_and_envelopes_pass() {
        let content = |value: serde_json::Value| value.as_object().unwrap().clone();
        let empty = content(json!({"schema":1,"blocks":[{"type":"text","text":"  "}]}));
        assert!(reject_empty_text("text", &empty, &[]).is_err());
        assert!(reject_empty_text("text", &content(json!({"schema":1,"blocks":[]})), &[]).is_err());
        assert!(reject_empty_text("text", &empty, &["media".into()]).is_ok());
        let envelope = content(
            json!({"schema":1,"blocks":[{"type":"text","text":"kordi-cloud-agent-response:e30"}]}),
        );
        assert!(reject_empty_text("text", &envelope, &[]).is_ok());
        assert!(reject_empty_text("voice", &empty, &[]).is_ok());
    }
}
