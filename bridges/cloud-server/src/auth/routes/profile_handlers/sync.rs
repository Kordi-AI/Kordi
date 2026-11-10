//! Telling the owner's other devices and the people who can see the account
//! that its profile changed, after an update in `tx`.

use super::*;

type Tx<'a> = sqlx_core::transaction::Transaction<'a, sqlx_postgres::Postgres>;

/// Records the sync events in `tx`, commits it, then publishes realtime
/// updates. On error nothing is committed and the response says so.
pub(super) async fn publish_profile_change(
    state: &Arc<ServerState>,
    mut tx: Tx<'_>,
    account_id: &str,
    account: &AccountResponse,
) -> Result<(), Box<Response>> {
    let failed = || {
        Box::new(err(
            "server_error",
            "Could not synchronize profile.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ))
    };
    let owner = account_id.to_string();
    let recipients =
        crate::chat_sync::store::identity_sync_recipient_ids(&mut tx, account_id, true)
            .await
            .map_err(|_| failed())?;
    let viewer_recipients = recipients
        .iter()
        .filter(|recipient| recipient.as_str() != account_id)
        .cloned()
        .collect::<Vec<_>>();
    if crate::chat_sync::store::append_user_sync_events_in_transaction(
        &mut tx,
        std::slice::from_ref(&owner),
        "account.profile.updated",
        None,
        &serde_json::json!({ "account": account }),
    )
    .await
    .is_err()
        || crate::chat_sync::store::append_user_sync_events_in_transaction(
            &mut tx,
            &viewer_recipients,
            "account.directory.changed",
            None,
            &serde_json::json!({
                "accountId": account.account_id,
                "avatarVersion": account.avatar.version,
                "agentAvatarVersion": account.default_agent.avatar.version,
            }),
        )
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return Err(failed());
    }

    let events = state.events().clone();
    let account_for_event = account.clone();
    let observer_account_ids = recipients;
    tokio::spawn(async move {
        for observer_account_id in observer_account_ids {
            events
                .publish_profile_updated(
                    &account_for_event.account_id,
                    &observer_account_id,
                    account_for_event.display_name.as_deref(),
                    account_for_event.avatar_url.as_deref(),
                )
                .await;
        }
    });
    Ok(())
}
