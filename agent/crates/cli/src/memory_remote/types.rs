//! Account memory wire types (`/v1/cloud/memory`).

use serde::{Deserialize, Serialize};

/// One account memory as the server returns it.
///
/// Group memories are shared by the group, so the list also holds memories
/// other members saved. The cache stores them like any other row: they arrive
/// with `pending_upload = 0`, so the Mac never uploads or archives them on its
/// own. The owner fields stay out of the cache; the agent only reads the text,
/// and the desktop Memory tab reads owners from the account list.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemory {
    pub memory_id: String,
    pub scope: String,
    pub scope_id: String,
    #[serde(default)]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
    /// The account that saved the memory.
    #[serde(default)]
    pub owner_account_id: Option<String>,
    /// That account's display name, when it has one.
    #[serde(default)]
    pub owner_name: Option<String>,
    /// The main category; equals `categories[0]` on servers that send both.
    #[serde(default)]
    pub category: Option<String>,
    /// 1 to 3 categories, main one first. Older servers send only
    /// `category`; read both through [`RemoteMemory::memory_categories`].
    #[serde(default)]
    pub categories: Vec<String>,
    /// `low`, `medium` or `high`, derived by the server from the categories.
    #[serde(default)]
    pub sensitivity: Option<String>,
    #[serde(default)]
    pub declaration_type: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_kind: Option<String>,
}

impl RemoteMemory {
    /// The known categories, main one first: `categories`, else the single
    /// `category` an older server sends. Empty when neither names a known
    /// category.
    pub fn memory_categories(&self) -> Vec<String> {
        kordi_tools::memory_categories::stored_memory_categories(
            &self.categories,
            self.category.as_deref(),
        )
    }
}

/// Body of `POST /v1/cloud/memory`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewRemoteMemory {
    pub scope: String,
    pub scope_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_memory_id: Option<String>,
    /// The main category, sent next to `categories` so an older server that
    /// reads only this field still files the memory. Set both through
    /// [`NewRemoteMemory::with_categories`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 1 to 3 categories, main one first; wins over `category` on servers
    /// that read it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub categories: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    /// `user` or `agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_by: Option<String>,
}

impl NewRemoteMemory {
    /// Set `categories` and `category` (the first of them) together.
    pub fn with_categories(mut self, categories: Vec<String>) -> Self {
        self.category = categories.first().cloned();
        self.categories = categories;
        self
    }
}

/// Account memory switches as the server returns them.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemorySettings {
    pub memory_enabled: bool,
    pub exclude_sensitive: bool,
}

/// Body of `GET /v1/cloud/memory`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemoryList {
    pub memories: Vec<RemoteMemory>,
    pub settings: RemoteMemorySettings,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MemoryRemoteError {
    /// The server cannot be reached, the person is signed out, or the server
    /// predates the memory routes. The Mac keeps working locally.
    #[error("account memory is unavailable: {0}")]
    Unavailable(String),
    /// The server guards rejected the text (422 `memory_rejected`).
    #[error("{0}")]
    Rejected(String),
    /// Memory is off for the account (409 `memory_disabled`).
    #[error("Memory is turned off for this account, so nothing was saved.")]
    Disabled,
    #[error("account memory request failed: {0}")]
    Other(String),
}
