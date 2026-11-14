//! Why a background session's execution was stopped, as stored on the record.
//!
//! A reason names what ended the execution: a person's Stop (with the owner's
//! account), the parent agent, the Mac's execution lease lapsing (with the
//! last update the cloud refused), a sign-out or account change, a follow-up
//! that continued the task elsewhere, the app quitting, or the cloud (the
//! group closed, access revoked). Only known kinds and bounded fields are
//! kept; the server, never the client, supplies account identities.
use super::{ApiError, CloudSession};
use serde_json::{json, Value};
use uuid::Uuid;

const KINDS: &[&str] = &[
    "user",
    "agent",
    "lease_lapsed",
    "signed_out",
    "account_changed",
    "continued_elsewhere",
    "app_quit",
    "group_closed",
    "access_revoked",
    "cloud",
];

/// The reason a client reported, reduced to known fields. A person's Stop is
/// attributed to the account that published it.
pub(super) fn from_client(value: &Value, session: &CloudSession) -> Option<Value> {
    let kind = value.get("kind")?.as_str()?;
    if !KINDS.contains(&kind) {
        return None;
    }
    let mut reason = json!({ "kind": kind });
    if kind == "user" {
        reason["accountId"] = json!(session.account_id);
    }
    if let Some(status) = value
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (100..=599).contains(status))
    {
        reason["status"] = json!(status);
    }
    if let Some(code) = value.get("code").and_then(Value::as_str).filter(|code| {
        !code.is_empty()
            && code.len() <= 64
            && code
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }) {
        reason["code"] = json!(code);
    }
    Some(reason)
}

/// A person's Stop from any device; only the owner can stop an execution.
pub(super) fn user(account_id: &str) -> Value {
    json!({ "kind": "user", "accountId": account_id })
}

/// Reports a refused subsession request without its payload.
pub(super) fn log_refusal(route: &str, id: Uuid, account_id: &str, error: &ApiError) {
    let code = error
        .1
         .0
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    eprintln!(
        "[subsessions] refused route={route} subsession={id} account={account_id} status={} code={code}",
        error.0.as_u16()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> CloudSession {
        CloudSession {
            token_id: "token".into(),
            account_id: "acct_owner".into(),
            device_id: "device".into(),
        }
    }

    #[test]
    fn keeps_known_kinds_and_bounded_fields() {
        let reason = from_client(
            &json!({"kind":"lease_lapsed","status":409,"code":"subsession_version_conflict","extra":"x"}),
            &session(),
        )
        .unwrap();
        assert_eq!(
            reason,
            json!({"kind":"lease_lapsed","status":409,"code":"subsession_version_conflict"})
        );
        assert_eq!(from_client(&json!({"kind":"reboot"}), &session()), None);
        assert_eq!(from_client(&json!({"status":401}), &session()), None);
        let odd = from_client(
            &json!({"kind":"lease_lapsed","status":42,"code":"no spaces allowed"}),
            &session(),
        )
        .unwrap();
        assert_eq!(odd, json!({"kind":"lease_lapsed"}));
    }

    #[test]
    fn a_person_stop_names_the_publishing_account() {
        let reason = from_client(
            &json!({"kind":"user","accountId":"acct_someone_else"}),
            &session(),
        )
        .unwrap();
        assert_eq!(reason, json!({"kind":"user","accountId":"acct_owner"}));
    }
}
