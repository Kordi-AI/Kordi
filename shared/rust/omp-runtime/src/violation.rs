//! Protocol violations, logged on the native side. The person sees one fixed
//! sentence for every violation, so without this log a failed run cannot say
//! which check rejected the worker. The detail never carries frame content:
//! only a parser position and fixed wording, counts, or a tool or hook name.

use serde_json::error::Category;

use crate::error::{ProtocolViolation, RuntimeError};

impl RuntimeError {
    /// `violation` as an error, after logging its code and `detail`.
    pub(crate) fn protocol(violation: ProtocolViolation, detail: &str) -> Self {
        eprintln!("[omp] protocol violation: {} ({detail})", violation.code());
        Self::Protocol(violation)
    }
}

/// A worker line that is not a frame.
pub(crate) fn malformed(error: &serde_json::Error) -> RuntimeError {
    RuntimeError::protocol(ProtocolViolation::MalformedFrame, &malformed_detail(error))
}

/// A violation about the tool or hook call `name`.
pub(crate) fn named(violation: ProtocolViolation, kind: &str, name: &str) -> RuntimeError {
    RuntimeError::protocol(violation, &name_detail(kind, name))
}

/// A tool or hook call whose ID is empty or already used in this run.
pub(crate) fn call_id(kind: &str, name: &str) -> RuntimeError {
    let kind = format!("empty or reused call ID, {kind}");
    RuntimeError::protocol(ProtocolViolation::CallId, &name_detail(&kind, name))
}

/// A result that arrived while host tools or hooks were still pending.
pub(crate) fn pending((tools, hooks): (usize, usize)) -> RuntimeError {
    let detail = format!("{tools} tools, {hooks} hooks still pending");
    RuntimeError::protocol(ProtocolViolation::PendingCallbacks, &detail)
}

/// Why a worker line is not a frame. A syntax error's wording is fixed by the
/// parser, such as "unexpected end of hex escape"; a data error's
/// wording can quote the frame, so it is only named.
pub(crate) fn malformed_detail(error: &serde_json::Error) -> String {
    let at = format!("line {} column {}", error.line(), error.column());
    match error.classify() {
        Category::Syntax => error.to_string(),
        Category::Data => "not a known frame shape".to_string(),
        Category::Eof => format!("incomplete JSON at {at}"),
        Category::Io => "unreadable frame".to_string(),
    }
}

/// A tool or hook name as the worker sent it, reduced to name characters.
pub(crate) fn name_detail(kind: &str, name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
        .take(64)
        .collect();
    if name.is_empty() {
        format!("unnamed {kind}")
    } else {
        format!("{kind} {name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lone_surrogate_frame_is_named_without_its_content() {
        let frame = br#"{"type":"event","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"event":{"kind":"text_delta","delta":"secret \ud835"}}"#;
        let error = serde_json::from_slice::<crate::protocol::WorkerOutput>(frame)
            .err()
            .unwrap();
        let detail = malformed_detail(&error);
        assert!(detail.contains("hex escape"), "{detail}");
        assert!(!detail.contains("secret"), "{detail}");
    }

    #[test]
    fn a_data_error_is_named_without_its_content() {
        let frame = br#"{"type":"event","schemaVersion":"secret"}"#;
        let error = serde_json::from_slice::<crate::protocol::WorkerOutput>(frame)
            .err()
            .unwrap();
        let detail = malformed_detail(&error);
        assert_eq!(detail, "not a known frame shape");
        assert!(!detail.contains("secret"), "{detail}");
    }

    #[test]
    fn tool_names_are_reduced_to_name_characters() {
        assert_eq!(
            name_detail("tool", "create_document"),
            "tool create_document"
        );
        assert_eq!(name_detail("tool", "a b\n\"c\""), "tool abc");
        assert_eq!(name_detail("hook", " "), "unnamed hook");
        assert_eq!(name_detail("tool", &"x".repeat(200)).len(), 5 + 64);
    }
}
