//! Closing ("dissolving") a group or one of its channels
//! (docs/development/group-closed-state.md). Only a group owner or admin may
//! do it. The conversations keep their members and history: everyone can
//! still read them, and each member's devices learn of the close through a
//! `conversation.updated` event whose snapshot carries `closed`. Nothing new
//! is written there afterwards (`closed_state::require_open`). Members remove
//! a closed group from their own list by leaving it.
//!
//! Closing a group also revokes its invitation links. Queued agent runs in
//! it are cancelled and running agent subsessions stop.

use super::service_members::is_service_member;
use super::support::load_active_conversation_projections;
use super::*;

/// What a close changed.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct DissolveOutcome {
    /// Conversations closed: every channel of a group, or one channel.
    pub conversation_ids: Vec<Uuid>,
    /// Members told about the close, the caller included. Empty when the
    /// conversations were already closed.
    pub member_account_ids: Vec<String>,
}

/// The SQL expression for a group conversation's space, as channels use it.
pub(super) const GROUP_SPACE_SQL: &str = "COALESCE(group_space_id, \
     regexp_replace(COALESCE(legacy_session_id, conversation_id::text), '^(group:)+', ''))";

pub(super) fn normalized_space(group_space_id: &str) -> Option<&str> {
    let space = group_space_id.trim().trim_start_matches("group:");
    (!space.is_empty()).then_some(space)
}

/// The group's channels in creation order, locked. The first one is the
/// group's authority, as for channel creation.
pub(super) async fn group_channels(
    transaction: &mut Transaction<'_, Postgres>,
    space: &str,
) -> Result<Vec<(Uuid, Option<String>)>, StoreError> {
    Ok(query_as(&format!(
        "SELECT conversation_id, legacy_session_id FROM cloud_chat_conversations \
         WHERE kind = 'group' AND {GROUP_SPACE_SQL} = $1 \
         ORDER BY created_at, conversation_id FOR UPDATE"
    ))
    .bind(space)
    .fetch_all(&mut **transaction)
    .await?)
}

async fn require_group_admin(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    let role: Option<(String,)> = query_as(
        "SELECT role FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    match role {
        Some((role,)) if role == "owner" || role == "admin" => Ok(()),
        _ => Err(StoreError::Forbidden),
    }
}

/// Closes the whole group `group_space_id`: every channel in it.
pub async fn dissolve_group(
    pool: &PgPool,
    account_id: &str,
    group_space_id: &str,
) -> Result<DissolveOutcome, StoreError> {
    let space = normalized_space(group_space_id).ok_or(StoreError::NotFound)?;
    let mut transaction = pool.begin().await?;
    let channels = group_channels(&mut transaction, space).await?;
    let Some((authority, _)) = channels.first() else {
        return Err(StoreError::NotFound);
    };
    require_group_admin(&mut transaction, *authority, account_id).await?;
    let outcome = close_conversations(&mut transaction, &channels, account_id).await?;
    // Links and pins name the space with or without its "group:" prefix.
    let spaces = vec![space.to_string(), format!("group:{space}")];
    query(
        "UPDATE cloud_group_invitations SET revoked_at = $2 \
         WHERE group_space_id = ANY($1) AND revoked_at IS NULL",
    )
    .bind(&spaces)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(outcome)
}

/// Closes one channel of a group. The group's first channel is the group
/// itself: closing it means closing the group.
pub async fn dissolve_group_channel(
    pool: &PgPool,
    account_id: &str,
    group_space_id: &str,
    conversation_id: Uuid,
) -> Result<DissolveOutcome, StoreError> {
    let space = normalized_space(group_space_id).ok_or(StoreError::NotFound)?;
    let mut transaction = pool.begin().await?;
    let channels = group_channels(&mut transaction, space).await?;
    let Some(position) = channels.iter().position(|(id, _)| *id == conversation_id) else {
        return Err(StoreError::NotFound);
    };
    if position == 0 {
        return Err(StoreError::InvalidInput(
            "the first channel is the group: close the group instead",
        ));
    }
    require_group_admin(&mut transaction, conversation_id, account_id).await?;
    let outcome =
        close_conversations(&mut transaction, &channels[position..=position], account_id).await?;
    transaction.commit().await?;
    Ok(outcome)
}

async fn close_conversations(
    transaction: &mut Transaction<'_, Postgres>,
    conversations: &[(Uuid, Option<String>)],
    account_id: &str,
) -> Result<DissolveOutcome, StoreError> {
    let ids: Vec<Uuid> = conversations.iter().map(|(id, _)| *id).collect();
    let sessions: Vec<String> = conversations
        .iter()
        .flat_map(|(id, session)| [Some(id.to_string()), session.clone()])
        .flatten()
        .collect();
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', error_code = 'group_closed', \
           error_message = 'The group was closed.', completed_at = $2, updated_at = $2 \
         WHERE session_id = ANY($1) AND status = 'queued'",
    )
    .bind(&sessions)
    .bind(&now)
    .execute(&mut **transaction)
    .await?;
    query(
        "UPDATE cloud_agent_subsessions SET status = 'stopped', version = version + 1, \
           updated_at = now() \
         WHERE parent_conversation_id = ANY($1) AND status = 'running'",
    )
    .bind(&ids)
    .execute(&mut **transaction)
    .await?;
    let mut member_account_ids = std::collections::BTreeSet::new();
    for conversation_id in &ids {
        // Closing twice changes nothing and sends nothing.
        let closed: Option<(i32,)> = query_as(
            "UPDATE cloud_chat_conversations \
             SET closed_at = now(), closed_by_account_id = $2, \
                 version = version + 1, updated_at = now() \
             WHERE conversation_id = $1 AND closed_at IS NULL RETURNING version",
        )
        .bind(conversation_id)
        .bind(account_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let Some((version,)) = closed else {
            continue;
        };
        for (member, projection) in
            load_active_conversation_projections(transaction, *conversation_id).await?
        {
            if is_service_member(&member) {
                continue;
            }
            insert_sync_event(
                transaction,
                &member,
                "conversation.updated",
                Some(*conversation_id),
                Some(*conversation_id),
                Some(version),
                &json!({ "conversation": &projection }),
            )
            .await?;
            member_account_ids.insert(member);
        }
    }
    Ok(DissolveOutcome {
        conversation_ids: ids,
        member_account_ids: member_account_ids.into_iter().collect(),
    })
}
