//! Account profile requests and responses.

use super::*;

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarMutation")]
    pub avatar_mutation: Option<AvatarMutationRequest>,
    #[serde(rename = "agentDisplayName")]
    pub agent_display_name: Option<String>,
    #[serde(rename = "agentAvatarMutation")]
    pub agent_avatar_mutation: Option<AvatarMutationRequest>,
    /// A chosen public handle. Absent leaves it unchanged; blank clears it so
    /// the account shows its nine-digit number again.
    #[serde(rename = "kordiId")]
    pub kordi_id: Option<String>,
    /// Profile fields. Absent leaves a field unchanged; null or blank clears it.
    #[serde(
        default,
        deserialize_with = "crate::auth::routes::profile_handlers::double_option"
    )]
    pub about: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::auth::routes::profile_handlers::double_option"
    )]
    pub location: Option<Option<String>>,
    #[serde(
        rename = "timeZone",
        default,
        deserialize_with = "crate::auth::routes::profile_handlers::double_option"
    )]
    pub time_zone: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::auth::routes::profile_handlers::double_option"
    )]
    pub website: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::auth::routes::profile_handlers::double_option"
    )]
    pub birthday: Option<Option<String>>,
    /// `automatic` or `manual`. Absent keeps the mode, unless the field's
    /// value changes without one; see `ProfileFieldChanges`.
    #[serde(rename = "locationMode")]
    pub location_mode: Option<String>,
    #[serde(rename = "timeZoneMode")]
    pub time_zone_mode: Option<String>,
    /// Owner setting; absent leaves it unchanged.
    #[serde(rename = "shareCalendarAvailability")]
    pub share_calendar_availability: Option<bool>,
}

/// What one of the owner's devices observed, for `POST /me/device-profile`.
/// Each field is written only while its mode is `automatic`.
#[derive(Debug, Deserialize)]
pub struct DeviceProfileRequest {
    pub location: Option<String>,
    #[serde(rename = "timeZone")]
    pub time_zone: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AccountResponse {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "kordiId")]
    pub kordi_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "primaryEmail")]
    pub primary_email: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    pub avatar: AvatarDescriptor,
    #[serde(rename = "defaultAgent")]
    pub default_agent: DefaultAgentProfileResponse,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    #[serde(rename = "passwordSet")]
    pub password_set: bool,
    /// Set only on payloads for the signed-in owner; never describes others.
    #[serde(
        rename = "primaryEmailVerified",
        skip_serializing_if = "Option::is_none"
    )]
    pub primary_email_verified: Option<bool>,
    pub about: Option<String>,
    pub location: Option<String>,
    #[serde(rename = "timeZone")]
    pub time_zone: Option<String>,
    pub website: Option<String>,
    /// Owner payloads only: `Some(None)` serializes as null, `None` is omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub birthday: Option<Option<String>>,
    /// Owner payloads only: the nine-digit public account number, which stays
    /// the fallback Kordi ID when a handle is set.
    #[serde(rename = "accountNumber", skip_serializing_if = "Option::is_none")]
    pub account_number: Option<String>,
    /// Owner payloads only: when the handle may change again (RFC 3339), or
    /// null when it may change now.
    #[serde(
        rename = "kordiIdChangeAvailableAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub kordi_id_change_available_at: Option<Option<String>>,
    /// Owner payloads only: whether Location and Time zone follow the
    /// owner's devices (`automatic`) or keep a value they set (`manual`).
    #[serde(rename = "locationMode", skip_serializing_if = "Option::is_none")]
    pub location_mode: Option<String>,
    #[serde(rename = "timeZoneMode", skip_serializing_if = "Option::is_none")]
    pub time_zone_mode: Option<String>,
    /// Owner payloads from `/v1/cloud/auth/me` only: the AI consent decision.
    #[serde(rename = "aiConsent", skip_serializing_if = "Option::is_none")]
    pub ai_consent: Option<crate::ai_consent::AiConsent>,
    /// Owner payloads only: whether people in the owner's chats may ask the
    /// owner's agent for busy/free times (never event details).
    #[serde(
        rename = "shareCalendarAvailability",
        skip_serializing_if = "Option::is_none"
    )]
    pub share_calendar_availability: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct PublicProfileResponse {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "kordiId")]
    pub kordi_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "defaultAgent")]
    pub default_agent: DefaultAgentProfileResponse,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    pub about: Option<String>,
    pub location: Option<String>,
    #[serde(rename = "timeZone")]
    pub time_zone: Option<String>,
    pub website: Option<String>,
    #[serde(rename = "isContact")]
    pub is_contact: bool,
    #[serde(rename = "isSelf")]
    pub is_self: bool,
}
