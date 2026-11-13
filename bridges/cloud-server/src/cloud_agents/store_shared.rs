//! The agents other accounts can see: shared agents of the owners they ask
//! about, except owners who stopped the viewer from using their agents.
//! On request, also the default agents of owners who share an active group
//! chat with the viewer and left that agent open
//! (docs/contact-permissions.md).

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::avatars::{descriptor_from_parts, StoredAvatar};
use crate::cloud_agents::models::{
    SharedCloudAgentSummary, CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS,
    CLOUD_AGENT_STATUS_ACTIVE,
};
use crate::cloud_agents::store::CloudAgentStoreError;

pub async fn list_shared_agent_summaries(
    pool: &PgPool,
    owner_account_ids: &[String],
    viewer_account_id: &str,
) -> Result<Vec<SharedCloudAgentSummary>, CloudAgentStoreError> {
    let owners: Vec<String> = owner_account_ids
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .take(50)
        .collect();
    if owners.is_empty() {
        return Ok(Vec::new());
    }

    type SharedAgentRow = (
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        i64,
        String,
    );
    let rows = query_as::<_, SharedAgentRow>(&format!(
        "SELECT a.agent_id, a.owner_account_id, c.display_name, a.access_scope, a.name, a.role, a.description, a.updated_at,
             a.avatar_url, a.avatar_source, a.avatar_style, a.avatar_seed, a.avatar_renderer_version,
             a.avatar_version, a.avatar_updated_at
         FROM cloud_agent_definitions a
         LEFT JOIN cloud_accounts c ON c.account_id = a.owner_account_id
         WHERE a.owner_account_id = ANY($1)
           AND a.status = $2
           AND a.access_scope = $3
           AND a.is_system_managed = FALSE
           AND {allowed}
         ORDER BY a.updated_at DESC, a.agent_id ASC",
        allowed = crate::contact_permissions::agent_allowed_sql("a.owner_account_id", "$4"),
    ))
    .bind(&owners)
    .bind(CLOUD_AGENT_STATUS_ACTIVE)
    .bind(CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS)
    .bind(viewer_account_id)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let avatar = descriptor_from_parts(
                "agent".to_string(),
                row.0.clone(),
                StoredAvatar {
                    source: row.9,
                    style: row.10,
                    seed: row.11,
                    renderer_version: row.12,
                    avatar_url: row.8,
                    version: row.13,
                    updated_at: row.14,
                },
            );
            SharedCloudAgentSummary {
                agent_id: row.0,
                owner_account_id: row.1,
                owner_display_name: row.2,
                access_scope: row.3,
                name: row.4,
                role: row.5,
                description: row.6,
                avatar_url: Some(avatar.image_url()),
                avatar,
                updated_at: row.7,
                is_default_agent: false,
            }
        })
        .collect())
}

/// The default agents of `owner_account_ids` that the viewer may mention in
/// a group chat: each owner shares an active group chat with the viewer,
/// left the default agent's Access open, did not stop the viewer from using
/// their agents, and neither blocked the other. The viewer's own and
/// Kordi-operated accounts are left out.
pub async fn list_group_member_default_agent_summaries(
    pool: &PgPool,
    owner_account_ids: &[String],
    viewer_account_id: &str,
) -> Result<Vec<SharedCloudAgentSummary>, CloudAgentStoreError> {
    let viewer = viewer_account_id.trim();
    let owners: Vec<String> = owner_account_ids
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| {
            !value.is_empty()
                && value != viewer
                && !crate::system_account::is_service_account(value)
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .take(50)
        .collect();
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    type DefaultAgentRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        String,
        i64,
        Option<String>,
        Option<String>,
    );
    let rows = query_as::<_, DefaultAgentRow>(&format!(
        "SELECT account.account_id, account.display_name,
             COALESCE(profile.display_name, 'Kordi'), profile.avatar_url,
             COALESCE(profile.avatar_source, 'generated'),
             COALESCE(profile.avatar_style, $3),
             profile.avatar_seed,
             COALESCE(profile.avatar_renderer_version, $4),
             COALESCE(profile.avatar_version, 1),
             profile.avatar_updated_at, profile.updated_at
         FROM cloud_accounts account
         LEFT JOIN cloud_default_agent_profiles profile
           ON profile.owner_account_id = account.account_id
         WHERE account.account_id = ANY($1)
           AND {open}
           AND {allowed}
           AND NOT cloud_accounts_blocked_either_way(account.account_id, $2)
           AND EXISTS (
             SELECT 1
             FROM cloud_chat_conversations conversation
             JOIN cloud_chat_conversation_members owner_member
               ON owner_member.conversation_id = conversation.conversation_id
              AND owner_member.account_id = account.account_id
              AND owner_member.membership_state = 'active'
             JOIN cloud_chat_conversation_members viewer_member
               ON viewer_member.conversation_id = conversation.conversation_id
              AND viewer_member.account_id = $2
              AND viewer_member.membership_state = 'active'
             WHERE conversation.kind = 'group')
         ORDER BY account.account_id ASC",
        open = crate::agent_access::default_agent_open_sql("account.account_id"),
        allowed = crate::contact_permissions::agent_allowed_sql("account.account_id", "$2"),
    ))
    .bind(&owners)
    .bind(viewer)
    .bind(crate::avatars::AGENT_AVATAR_STYLE)
    .bind(crate::avatars::AVATAR_RENDERER_VERSION)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let agent_id = format!("cloud-agent:{}", row.0);
            let seed = row.6.unwrap_or_else(|| format!("default-agent-{}", row.0));
            // An owner who never edited the default agent has no profile row.
            let updated_at = row
                .10
                .clone()
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            let avatar = descriptor_from_parts(
                "agent".to_string(),
                agent_id.clone(),
                StoredAvatar {
                    source: row.4,
                    style: row.5,
                    seed,
                    renderer_version: row.7,
                    avatar_url: row.3,
                    version: row.8,
                    updated_at: row.9.unwrap_or_else(|| updated_at.clone()),
                },
            );
            SharedCloudAgentSummary {
                agent_id,
                owner_account_id: row.0,
                owner_display_name: row.1,
                access_scope: CLOUD_AGENT_ACCESS_PARTICIPANT_CONVERSATIONS.to_string(),
                name: row.2,
                role: "Default agent".to_string(),
                description: None,
                avatar_url: Some(avatar.image_url()),
                avatar,
                updated_at,
                is_default_agent: true,
            }
        })
        .collect())
}
