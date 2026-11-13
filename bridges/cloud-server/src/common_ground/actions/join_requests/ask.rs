//! Asking to join: the checks that refuse a request, and storing it with
//! its card.

use super::*;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::common_ground) struct AskRequest {
    group_space_id: String,
}

/// `POST /v1/cloud/common-ground/rooms/:code/join-requests`: asks to join a
/// group started from this open room.
pub(in crate::common_ground) async fn ask_to_join(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
    body: Option<Json<AskRequest>>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let (room_id, open) = match rooms::my_room(pool, &code, viewer).await {
        Ok(Some(room)) => room,
        Ok(None) => return rooms::room_not_found(),
        Err(error) => return db_error(error),
    };
    if !open {
        return err(
            "common_ground_room_closed",
            "This room has closed.",
            StatusCode::CONFLICT,
        );
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let group_space_id = body.group_space_id.trim();
    let group: Result<Option<(Uuid, String)>, _> = query_as(
        "SELECT conversation_id, name FROM cloud_common_ground_room_groups
         WHERE group_space_id = $1 AND room_id = $2",
    )
    .bind(group_space_id)
    .bind(room_id)
    .fetch_optional(pool)
    .await;
    let conversation_id = match group {
        Ok(Some((conversation_id, _))) => conversation_id,
        Ok(None) => return group_not_found(),
        Err(error) => return db_error(error),
    };
    match refusal(pool, group_space_id, conversation_id, viewer).await {
        Ok(Refusal::None) => {}
        Ok(Refusal::Pending(request)) => return respond(pool, StatusCode::OK, &request).await,
        Ok(Refusal::Response(response)) => return *response,
        Err(error) => return db_error(error),
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(JOIN_REQUEST_LIMIT, viewer)
        .await
    {
        return limited(retry_after);
    }
    // Older groups have only the System agent; System posts the card.
    if let Err(error) = crate::system_account::join(pool, conversation_id).await {
        eprintln!("[common-ground] Could not add System to a group: {error}");
    }
    match create(pool, room_id, &code, group_space_id, viewer).await {
        Ok((request, true)) => respond(pool, StatusCode::CREATED, &request).await,
        Ok((request, false)) => respond(pool, StatusCode::OK, &request).await,
        Err(error) => {
            eprintln!("[common-ground] Could not ask to join a group: {error}");
            err(
                "common_ground_failed",
                "Could not send the request. Try again.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

/// Why asking is refused, or the pending request asking returns again.
enum Refusal {
    None,
    Pending(Box<JoinRequest>),
    Response(Box<Response>),
}

fn conflict(code: &str, message: &str) -> Refusal {
    Refusal::Response(Box::new(err(code, message, StatusCode::CONFLICT)))
}

async fn refusal(
    pool: &PgPool,
    group_space_id: &str,
    conversation_id: Uuid,
    viewer: &str,
) -> sqlx_core::Result<Refusal> {
    if is_active_member(pool, conversation_id, viewer).await? {
        return Ok(conflict(
            "common_ground_already_member",
            "You're already in this group.",
        ));
    }
    let (invited,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_common_ground_room_invitations invite
                        JOIN cloud_group_invitations group_invite
                          ON group_invite.invitation_id = invite.group_invitation_id
                        WHERE invite.group_space_id = $1 AND invite.invitee_account_id = $2
                          AND invite.accepted_at IS NULL AND group_invite.revoked_at IS NULL
                          AND group_invite.expires_at > $3)",
    )
    .bind(group_space_id)
    .bind(viewer)
    .bind(chrono::Utc::now().to_rfc3339())
    .fetch_one(pool)
    .await?;
    if invited {
        return Ok(conflict(
            "common_ground_already_invited",
            "You're already invited. Join the group instead.",
        ));
    }
    let earlier: Vec<(Uuid, String)> = query_as(
        "SELECT request_id, status FROM cloud_common_ground_room_join_requests
         WHERE group_space_id = $1 AND requester_account_id = $2
           AND status IN ('pending', 'declined')
         ORDER BY created_at DESC",
    )
    .bind(group_space_id)
    .bind(viewer)
    .fetch_all(pool)
    .await?;
    if earlier.iter().any(|(_, status)| status == "declined") {
        return Ok(conflict(
            "common_ground_join_request_declined",
            "Your request to join this group was declined.",
        ));
    }
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    let members: Vec<String> = members.into_iter().map(|(id,)| id).collect();
    if crate::safety::blocks::any_blocked(pool, viewer, &members).await? {
        // The same refusal for either direction, naming nobody.
        return Ok(Refusal::Response(Box::new(err(
            "common_ground_join_request_unavailable",
            "You can't join this group.",
            StatusCode::BAD_REQUEST,
        ))));
    }
    if let Some((request_id, _)) = earlier.iter().find(|(_, status)| status == "pending") {
        if let Some(request) = load(pool, *request_id, false).await? {
            return Ok(Refusal::Pending(Box::new(request)));
        }
    }
    Ok(Refusal::None)
}

/// Stores a pending request, posts its card as System and tells the room.
/// Returns the request and whether it is new; a request another call stored
/// first is returned instead.
async fn create(
    pool: &PgPool,
    room_id: Uuid,
    code: &str,
    group_space_id: &str,
    viewer: &str,
) -> sqlx_core::Result<(JoinRequest, bool)> {
    let request_id = Uuid::new_v4();
    let mut tx = pool.begin().await?;
    let inserted = query(
        "INSERT INTO cloud_common_ground_room_join_requests
             (request_id, room_id, group_space_id, requester_account_id, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (group_space_id, requester_account_id) WHERE status = 'pending' DO NOTHING",
    )
    .bind(request_id)
    .bind(room_id)
    .bind(group_space_id)
    .bind(viewer)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if !inserted {
        drop(tx);
        let (existing,): (Uuid,) = query_as(
            "SELECT request_id FROM cloud_common_ground_room_join_requests
             WHERE group_space_id = $1 AND requester_account_id = $2 AND status = 'pending'",
        )
        .bind(group_space_id)
        .bind(viewer)
        .fetch_one(pool)
        .await?;
        let request = load(pool, existing, false)
            .await?
            .ok_or(sqlx_core::Error::RowNotFound)?;
        return Ok((request, false));
    }
    let mut request = load(&mut *tx, request_id, false)
        .await?
        .ok_or(sqlx_core::Error::RowNotFound)?;
    // The snapshot reads approvers and people, none of which this
    // transaction changed.
    let block = snapshot(pool, &request).await?;
    let name: Option<(Option<String>,)> =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(viewer)
            .fetch_optional(&mut *tx)
            .await?;
    let name = clean_display_name(name.and_then(|(name,)| name).as_deref());
    let message = SendMessageRequest {
        client_message_id: request_id,
        kind: SYSTEM_NOTICE_KIND.to_string(),
        content: json!({
            "schema": 1,
            "blocks": [{ "type": "text", "text": format!("{name} asked to join.") }, block],
            "legacy_attachments": [],
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let posted = chat::send_message_in_transaction(
        &mut tx,
        SYSTEM_ACCOUNT_ID,
        request.conversation_id,
        message,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    query(
        "UPDATE cloud_common_ground_room_join_requests SET message_id = $2 WHERE request_id = $1",
    )
    .bind(request_id)
    .bind(posted.value.id)
    .execute(&mut *tx)
    .await?;
    request.message_id = Some(posted.value.id);
    rooms::notify_members(&mut tx, room_id, code).await?;
    tx.commit().await?;
    Ok((request, true))
}
