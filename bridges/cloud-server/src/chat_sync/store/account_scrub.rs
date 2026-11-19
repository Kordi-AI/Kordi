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
//!
//! A quote, forward or thread reference (`messageAction.source`) names its
//! source message's sender only by a label. A reference whose
//! `sourceMessageId` is one of the deleted account's messages
//! ([`AccountScrub::quoted_messages`]) gets the stand-in's name as its
//! label; its text preview is free text and stays.
//!
//! Session ids (`session:…`) are never rewritten: a kept direct
//! conversation keeps its session id, which names the deleted account, so a
//! reference to it must keep naming it to lead back to the same chat.

use std::collections::{BTreeSet, HashSet};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{Map, Value};
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

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

/// The message a quote, forward or thread reference points at, and the
/// label it shows for that message's sender.
const SOURCE_MESSAGE_KEY: &str = "sourceMessageId";
const SOURCE_SENDER_KEYS: &[&str] = &["senderLabel"];

/// Session ids keep the account id they name; see the module notes.
const SESSION_ID_PREFIX: &str = "session:";

pub(in crate::chat_sync::store) struct AccountScrub<'a> {
    pub account_id: &'a str,
    pub replacement_id: &'a str,
    pub replacement_name: &'a str,
    pub removed_attachments: &'a HashSet<String>,
    /// A kept direct conversation: also decodes direct-message and
    /// agent-response envelopes, and renames an agent target owned by the
    /// account.
    pub direct: bool,
    /// Ids of the account's messages in the conversation (message id, client
    /// message id, and the id inside its envelope); a reference to one of
    /// them shows the stand-in as sender.
    pub quoted_messages: &'a HashSet<String>,
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

    /// Every id the messages `message_ids` go by: the stored id, the
    /// client's id, and the id inside a group envelope. A quote, forward or
    /// thread reference names its source by one of them.
    pub async fn message_ids(
        transaction: &mut Transaction<'_, Postgres>,
        message_ids: &BTreeSet<Uuid>,
    ) -> Result<HashSet<String>, sqlx_core::Error> {
        let ids: Vec<Uuid> = message_ids.iter().copied().collect();
        let rows: Vec<(Uuid, Uuid, Value)> = query_as(
            "SELECT message_id, client_message_id, content FROM cloud_chat_messages \
             WHERE message_id = ANY($1)",
        )
        .bind(&ids)
        .fetch_all(&mut **transaction)
        .await?;
        let mut quoted = HashSet::new();
        for (message_id, client_message_id, content) in rows {
            quoted.insert(message_id.to_string());
            quoted.insert(client_message_id.to_string());
            quoted.extend(Self::envelope_message_id(&content));
        }
        Ok(quoted)
    }

    /// The id a group envelope in `content` gives its message, which a
    /// reference may use instead of the stored message id.
    pub fn envelope_message_id(content: &Value) -> Option<String> {
        let blocks = content.get("blocks")?.as_array()?;
        blocks.iter().find_map(|block| {
            let encoded = block
                .get("text")?
                .as_str()?
                .strip_prefix(CLOUD_GROUP_PREFIX)?;
            let envelope: Value = URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())?;
            envelope
                .get("message")?
                .get("id")?
                .as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
        })
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
        if text.starts_with(SESSION_ID_PREFIX) {
            return None;
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
        let quotes_account = object
            .get(SOURCE_MESSAGE_KEY)
            .and_then(Value::as_str)
            .is_some_and(|id| self.quoted_messages.contains(id.trim()));
        if quotes_account {
            for key in SOURCE_SENDER_KEYS {
                if let Some(value) = object.get_mut(*key) {
                    if value.is_string() {
                        *value = Value::String(self.replacement_name.to_string());
                    }
                }
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
mod tests;
