//! Scrubbing stored content of a deleted account: group and direct
//! envelopes, quote references and session ids.

use super::*;
use serde_json::json;

fn envelope(value: &Value) -> String {
    format!(
        "{CLOUD_GROUP_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
    )
}

fn decode(text: &str) -> Value {
    let encoded = text.strip_prefix(CLOUD_GROUP_PREFIX).unwrap();
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
}

#[test]
fn group_envelopes_lose_the_deleted_identity() {
    let removed = HashSet::from(["att_gone".to_string()]);
    let scrub = AccountScrub {
        account_id: "acct_gone",
        replacement_id: "acct_kordi_deleted",
        replacement_name: "Deleted account",
        removed_attachments: &removed,
        direct: false,
        quoted_messages: &HashSet::new(),
    };
    let inner = json!({
        "kind": "message",
        "actor": {"accountId": "acct_gone", "displayName": "Dana Doe", "avatarUrl": "https://example.test/a.png"},
        "participants": [
            {"accountId": "acct_gone", "displayName": "Dana Doe"},
            {"accountId": "acct_kept", "displayName": "Kim"}
        ],
        "message": {
            "senderKind": "agent",
            "senderAccountId": "acct_gone",
            "senderAgentId": "cloud-agent:acct_gone",
            "senderOwnerName": "Dana Doe",
            "senderDisplayName": "Dana's Kordi"
        }
    });
    let mut content = json!({
        "blocks": [{"type": "text", "text": envelope(&inner)}],
        "legacy_attachments": [
            {"attachmentId": "att_gone", "name": "Dana passport.jpg"},
            {"attachmentId": "att_kept", "name": "Plan.pdf"}
        ]
    });
    assert!(scrub.scrub(&mut content));
    let text = content["blocks"][0]["text"].as_str().unwrap();
    let decoded = decode(text);
    assert!(!decoded.to_string().contains("Dana"), "{decoded}");
    assert!(!decoded.to_string().contains("acct_gone"), "{decoded}");
    assert_eq!(decoded["participants"].as_array().unwrap().len(), 1);
    assert_eq!(decoded["actor"]["accountId"], "acct_kordi_deleted");
    assert_eq!(decoded["actor"]["displayName"], "Deleted account");
    assert!(decoded["actor"].get("avatarUrl").is_none());
    assert_eq!(
        decoded["message"]["senderAgentId"],
        "cloud-agent:acct_kordi_deleted"
    );
    let attachments = content["legacy_attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["attachmentId"], "att_kept");
}

#[test]
fn content_without_the_account_is_unchanged() {
    let removed = HashSet::new();
    let scrub = AccountScrub {
        account_id: "acct_gone",
        replacement_id: "acct_kordi_deleted",
        replacement_name: "Deleted account",
        removed_attachments: &removed,
        direct: false,
        quoted_messages: &HashSet::new(),
    };
    let mut content = json!({"blocks": [{"type": "text", "text": "See you at 5"}]});
    assert!(!scrub.scrub(&mut content));
}

#[test]
fn direct_envelopes_lose_the_deleted_identity_only_in_a_direct_scrub() {
    let removed = HashSet::new();
    let prefix = "kordi-cloud-message:";
    let inner = json!({
        "schemaVersion": 1,
        "kind": "message",
        "text": "@Dana's Kordi can you check?",
        "mentions": [{"accountId": "acct_gone", "displayName": "Dana Doe"}],
        "targetCloudAgentId": "agent_gone",
        "targetCloudAgentName": "Dana's Kordi",
        "targetCloudAgentOwnerAccountId": "acct_gone",
        "targetCloudAgentOwnerName": "Dana Doe"
    });
    let encoded = format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&inner).unwrap())
    );
    let content = json!({"blocks": [{"type": "text", "text": encoded}]});
    let mut scrub = AccountScrub {
        account_id: "acct_gone",
        replacement_id: "acct_kordi_deleted",
        replacement_name: "Deleted account",
        removed_attachments: &removed,
        direct: false,
        quoted_messages: &HashSet::new(),
    };
    assert!(
        !scrub.scrub(&mut content.clone()),
        "groups read group envelopes only"
    );

    scrub.direct = true;
    let mut scrubbed = content.clone();
    assert!(scrub.scrub(&mut scrubbed));
    let text = scrubbed["blocks"][0]["text"].as_str().unwrap();
    let decoded: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(text.strip_prefix(prefix).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(decoded["mentions"][0]["accountId"], "acct_kordi_deleted");
    assert_eq!(decoded["mentions"][0]["displayName"], "Deleted account");
    assert_eq!(
        decoded["targetCloudAgentOwnerAccountId"],
        "acct_kordi_deleted"
    );
    assert_eq!(decoded["targetCloudAgentOwnerName"], "Deleted account");
    assert_eq!(decoded["targetCloudAgentName"], "Deleted account");
    // Free text is not rewritten, as in groups.
    assert_eq!(decoded["text"], "@Dana's Kordi can you check?");
}

fn quote(source_message_id: &str, session_id: &str, label: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "kind": "quote",
        "source": {
            "sourceSessionId": session_id,
            "sourceMessageId": source_message_id,
            "senderLabel": label,
            "textPreview": "Maya said the studio moved",
            "attachmentCount": 0
        }
    })
}

#[test]
fn a_quote_of_the_deleted_account_names_the_stand_in_in_a_group() {
    let removed = HashSet::new();
    let quoted = HashSet::from(["msg-by-gone".to_string()]);
    let scrub = AccountScrub {
        account_id: "acct_gone",
        replacement_id: "acct_kordi_deleted",
        replacement_name: "Deleted account",
        removed_attachments: &removed,
        direct: false,
        quoted_messages: &quoted,
    };
    let inner = json!({
        "kind": "message",
        "actor": {"accountId": "acct_kept", "displayName": "Rowan"},
        "participants": [{"accountId": "acct_kept", "displayName": "Rowan"}],
        "message": {
            "id": "msg-reply",
            "senderAccountId": "acct_kept",
            "senderDisplayName": "Rowan",
            "text": "Thanks",
            "messageAction": quote("msg-by-gone", "session:group:space-1", "Maya")
        }
    });
    let mut content = json!({"blocks": [{"type": "text", "text": envelope(&inner)}]});
    assert!(scrub.scrub(&mut content));
    let decoded = decode(content["blocks"][0]["text"].as_str().unwrap());
    let source = &decoded["message"]["messageAction"]["source"];
    assert_eq!(source["senderLabel"], "Deleted account");
    assert_eq!(source["sourceMessageId"], "msg-by-gone");
    assert_eq!(source["sourceSessionId"], "session:group:space-1");
    // The preview is free text and is not rewritten.
    assert_eq!(source["textPreview"], "Maya said the studio moved");
    // The person who replied keeps their name.
    assert_eq!(decoded["message"]["senderDisplayName"], "Rowan");

    // A quote of someone else's message keeps its label.
    let other = json!({
        "kind": "message",
        "actor": {"accountId": "acct_kept", "displayName": "Rowan"},
        "message": {"messageAction": quote("msg-by-kept", "session:group:space-1", "Kim")}
    });
    let mut content = json!({"blocks": [{"type": "text", "text": envelope(&other)}]});
    assert!(!scrub.scrub(&mut content));
}

#[test]
fn a_quote_in_a_kept_direct_chat_keeps_its_session_and_names_the_stand_in() {
    let removed = HashSet::new();
    let quoted = HashSet::from(["00000000-0000-4000-8000-000000000001".to_string()]);
    let scrub = AccountScrub {
        account_id: "acct_gone",
        replacement_id: "acct_kordi_deleted",
        replacement_name: "Deleted account",
        removed_attachments: &removed,
        direct: true,
        quoted_messages: &quoted,
    };
    let prefix = "kordi-cloud-message:";
    let session = "session:direct-person:acct_gone:acct_kept";
    let inner = json!({
        "schemaVersion": 1,
        "kind": "message",
        "text": "Got it",
        "messageAction": quote("00000000-0000-4000-8000-000000000001", session, "Maya")
    });
    let encoded = format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&inner).unwrap())
    );
    let mut content = json!({"blocks": [{"type": "text", "text": encoded}]});
    assert!(scrub.scrub(&mut content));
    let text = content["blocks"][0]["text"].as_str().unwrap();
    let decoded: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(text.strip_prefix(prefix).unwrap())
            .unwrap(),
    )
    .unwrap();
    let source = &decoded["messageAction"]["source"];
    assert_eq!(source["senderLabel"], "Deleted account");
    assert_eq!(
        source["sourceSessionId"], session,
        "the reference still leads to the kept conversation, whose session id is unchanged"
    );
    // A bare session id elsewhere in the content is kept as well.
    let mut plain = json!({"sessionId": session, "agentId": "cloud-agent:acct_gone"});
    assert!(scrub.scrub(&mut plain));
    assert_eq!(plain["sessionId"], session);
    assert_eq!(plain["agentId"], "cloud-agent:acct_kordi_deleted");
}

#[test]
fn the_envelope_message_id_is_read_from_a_group_envelope() {
    let inner = json!({"kind": "message", "message": {"id": " msg-1 ", "text": "Hi"}});
    let content = json!({"blocks": [{"type": "text", "text": envelope(&inner)}]});
    assert_eq!(
        AccountScrub::envelope_message_id(&content).as_deref(),
        Some("msg-1")
    );
    let plain = json!({"blocks": [{"type": "text", "text": "Hi"}]});
    assert_eq!(AccountScrub::envelope_message_id(&plain), None);
}
