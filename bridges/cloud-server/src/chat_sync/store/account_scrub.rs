//! Removes a deleted account's identity from stored message content
//! (docs/development/account-deletion.md).
//!
//! Group messages carry a snapshot of their sender and participants inside
//! an encoded envelope, and other content can name an account next to its
//! display name or avatar. Every object that names the deleted account is
//! moved to the stand-in account: its name fields become the stand-in's name
//! and its avatar, handle and email fields are dropped. The deleted person
//! leaves participant lists, and attachments that were deleted with the
//! account leave attachment lists. Free text is not rewritten.
//!
//! A kept direct conversation also holds direct-message and agent-response
//! envelopes, and its messages can name the deleted person's agent as their
//! target; [`AccountScrub::direct`] reads those too.

use std::collections::HashSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{Map, Value};

use super::CLOUD_GROUP_PREFIX;

/// Encoded envelopes a direct conversation holds besides group envelopes.
const DIRECT_ENVELOPE_PREFIXES: &[&str] = &["kordi-cloud-message:", "kordi-cloud-agent-response:"];

/// The agent a direct message is addressed to, by its owner's account id,
/// and the names shown for it.
const TARGET_OWNER_KEY: &str = "targetCloudAgentOwnerAccountId";
const TARGET_NAME_KEYS: &[&str] = &["targetCloudAgentName", "targetCloudAgentOwnerName"];

/// Keys whose value is an account id.
const ACCOUNT_KEYS: &[&str] = &[
    "accountId",
    "account_id",
    "actorAccountId",
    "authorAccountId",
    "createdByAccountId",
    "ownerAccountId",
    "owner_account_id",
    "peerAccountId",
    "requesterAccountId",
    "senderAccountId",
    "sender_account_id",
    "senderOwnerAccountId",
];

/// Keys that hold a person's name next to their account id.
const NAME_KEYS: &[&str] = &[
    "actorName",
    "authorName",
    "displayName",
    "display_name",
    "name",
    "ownerName",
    "senderDisplayName",
    "senderName",
    "senderOwnerName",
];

/// Keys that identify a person and are dropped next to their account id.
const IDENTITY_KEYS: &[&str] = &[
    "avatar",
    "avatarSeed",
    "avatarUrl",
    "avatar_url",
    "email",
    "handle",
    "kordiId",
    "kordi_id",
    "ownerAvatarUrl",
    "primaryEmail",
    "publicHandle",
    "senderAvatar",
    "senderAvatarUrl",
];

const ATTACHMENT_KEYS: &[&str] = &["attachmentId", "attachment_id"];

pub(in crate::chat_sync::store) struct AccountScrub<'a> {
    pub account_id: &'a str,
    pub replacement_id: &'a str,
    pub replacement_name: &'a str,
    pub removed_attachments: &'a HashSet<String>,
    /// A kept direct conversation: also decodes direct-message and
    /// agent-response envelopes, and renames an agent target owned by the
    /// account.
    pub direct: bool,
}

impl AccountScrub<'_> {
    /// Scrubs `content` in place. Returns whether anything changed.
    pub fn scrub(&self, content: &mut Value) -> bool {
        let before = content.clone();
        self.value(content);
        *content != before
    }

    /// Prefixes of the encoded envelopes this scrub decodes. Messages whose
    /// content holds one may name the account without showing its id.
    pub fn envelope_prefixes(&self) -> Vec<&'static str> {
        let mut prefixes = vec![CLOUD_GROUP_PREFIX];
        if self.direct {
            prefixes.extend_from_slice(DIRECT_ENVELOPE_PREFIXES);
        }
        prefixes
    }

    fn value(&self, value: &mut Value) {
        match value {
            Value::String(text) => {
                if let Some(rewritten) = self.text(text) {
                    *text = rewritten;
                }
            }
            Value::Array(items) => self.array(items, false),
            Value::Object(object) => self.object(object),
            _ => {}
        }
    }

    fn text(&self, text: &str) -> Option<String> {
        for prefix in self.envelope_prefixes() {
            let Some(encoded) = text.strip_prefix(prefix) else {
                continue;
            };
            let mut envelope: Value = URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
            let before = envelope.clone();
            self.value(&mut envelope);
            if envelope == before {
                return None;
            }
            let bytes = serde_json::to_vec(&envelope).ok()?;
            return Some(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes)));
        }
        text.contains(self.account_id)
            .then(|| text.replace(self.account_id, self.replacement_id))
    }

    fn array(&self, items: &mut Vec<Value>, participants: bool) {
        items.retain(|item| {
            let Some(object) = item.as_object() else {
                return true;
            };
            let removed_attachment = ATTACHMENT_KEYS.iter().any(|key| {
                object
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|id| self.removed_attachments.contains(id))
            });
            let deleted_participant = participants && self.names_account(object);
            !removed_attachment && !deleted_participant
        });
        for item in items.iter_mut() {
            self.value(item);
        }
    }

    fn names_account(&self, object: &Map<String, Value>) -> bool {
        ACCOUNT_KEYS.iter().any(|key| {
            object
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|id| id.trim() == self.account_id)
        })
    }

    fn object(&self, object: &mut Map<String, Value>) {
        if self.names_account(object) {
            for key in NAME_KEYS {
                if let Some(value) = object.get_mut(*key) {
                    if value.is_string() {
                        *value = Value::String(self.replacement_name.to_string());
                    }
                }
            }
            for key in IDENTITY_KEYS {
                object.remove(*key);
            }
        }
        let targets_account = object
            .get(TARGET_OWNER_KEY)
            .and_then(Value::as_str)
            .is_some_and(|id| id.trim() == self.account_id);
        if self.direct && targets_account {
            for key in TARGET_NAME_KEYS {
                if let Some(value) = object.get_mut(*key) {
                    if value.is_string() {
                        *value = Value::String(self.replacement_name.to_string());
                    }
                }
            }
        }
        for (key, value) in object.iter_mut() {
            match value {
                Value::Array(items) => self.array(items, key == "participants"),
                _ => self.value(value),
            }
        }
    }
}

#[cfg(test)]
mod tests {
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
}
