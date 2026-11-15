//! Inviting Grounding people into groups: who may invite whom, contacts
//! added directly, the invitee's list, joining and declining, and what
//! makes an invitation stale.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{account, signed_in};
use super::group_invitation_support::{ids, setup};

#[tokio::test]
async fn an_admin_invites_a_room_co_member_who_joins() {
    let Some(s) = setup().await else {
        return;
    };
    let (status, body) = s.invite(&s.alex.1, &[&s.sam.0]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body["invited"]), vec![s.sam.0.clone()]);
    assert_eq!(body["added"], json!([]));
    assert_eq!(body["skipped"], json!([]));
    assert_eq!(body["invited"][0]["name"], "Sam");
    assert_eq!(s.hints(&s.sam.0).await, 1, "the invitee is told");
    assert!(!s.is_member(&s.sam.0).await);

    let invitations = s.pending(&s.sam.1).await;
    assert_eq!(invitations.len(), 1, "{invitations:?}");
    let invitation = &invitations[0];
    assert_eq!(invitation["kind"], "group");
    assert_eq!(invitation["code"], Value::Null);
    assert_eq!(invitation["roomName"], s.room_name);
    assert_eq!(invitation["groupSpaceId"], s.space());
    assert_eq!(invitation["conversationId"], s.group["conversationId"]);
    assert_eq!(invitation["name"], "Infrastructure and CI");
    assert_eq!(invitation["from"]["accountId"], s.alex.0);
    assert_eq!(invitation["memberCount"], 2);
    assert_eq!(
        ids(&invitation["members"]),
        vec![s.alex.0.clone(), s.priya.0.clone()],
        "owner first"
    );
    assert!(invitation["createdAt"].is_string());

    let (status, groups) = s.person_groups(&s.alex.1, &s.sam.0).await;
    assert_eq!(status, 200, "{groups}");
    assert_eq!(groups["contact"], false);
    let group = &groups["groups"][0];
    assert_eq!(group["groupSpaceId"], s.space());
    assert_eq!(group["state"], "invited");
    assert_eq!(group["memberCount"], 2);
    assert_eq!(group["members"][0]["accountId"], s.alex.0);

    let reference = invitation["invitationRef"].clone();
    let (status, body) = s.answer(&s.priya.1, &reference, "join").await;
    assert_eq!(status, 404, "only the invitee joins: {body}");
    let (status, body) = s.answer(&s.sam.1, &reference, "join").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "joined");
    assert_eq!(body["groupSpaceId"], s.space());
    assert_eq!(body["name"], "Infrastructure and CI");
    assert!(s.is_member(&s.sam.0).await);
    assert_eq!(s.statuses(&s.sam.0).await, vec!["accepted"]);
    assert_eq!(s.hints(&s.sam.0).await, 2, "the invitee's devices refresh");
    assert!(s.pending(&s.sam.1).await.is_empty());
    let (audits,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_audit_events
         WHERE account_id = $1 AND event_type = 'group.invitation.accepted'
           AND metadata_json::jsonb->>'invited_by' = $2",
    )
    .bind(&s.sam.0)
    .bind(&s.alex.0)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);

    let (status, body) = s.answer(&s.sam.1, &reference, "join").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "already_joined");
    let (_, groups) = s.person_groups(&s.alex.1, &s.sam.0).await;
    assert_eq!(groups["groups"][0]["state"], "member");
    let (status, body) = s.invite(&s.alex.1, &[&s.sam.0]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["skipped"],
        json!([{ "accountId": s.sam.0, "reason": "member" }])
    );
}

#[tokio::test]
async fn contacts_are_added_directly() {
    let Some(s) = setup().await else {
        return;
    };
    super::support::make_contacts(&s.pool, &s.alex.0, &s.dana.0).await;
    let (status, people) = s.group_people(&s.alex.1).await;
    assert_eq!(status, 200, "{people}");
    let listed: Vec<&Value> = people["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| &row["person"]["accountId"])
        .collect();
    assert!(!listed.contains(&&json!(s.dana.0)), "contacts are left out");

    let (status, body) = s.invite(&s.alex.1, &[&s.dana.0, &s.sam.0]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body["added"]), vec![s.dana.0.clone()]);
    assert_eq!(ids(&body["invited"]), vec![s.sam.0.clone()]);
    assert!(s.is_member(&s.dana.0).await);
    assert!(s.statuses(&s.dana.0).await.is_empty(), "no invitation");
    let (_, groups) = s.person_groups(&s.alex.1, &s.dana.0).await;
    assert_eq!(groups["contact"], true);
    assert_eq!(groups["groups"][0]["state"], "member");
}

#[tokio::test]
async fn only_owners_and_admins_invite() {
    let Some(s) = setup().await else {
        return;
    };
    let (status, body) = s.invite(&s.priya.1, &[&s.sam.0]).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["errorCode"], "common_ground_group_forbidden");
    assert_eq!(body["message"], "Only group admins can invite.");
    let (status, body) = s.group_people(&s.priya.1).await;
    assert_eq!(status, 403, "{body}");
    let (status, _) = s.invite(&s.sam.1, &[&s.dana.0]).await;
    assert_eq!(status, 403, "people outside the group cannot invite");
    let (_, groups) = s.person_groups(&s.priya.1, &s.sam.0).await;
    assert_eq!(groups["groups"], json!([]), "a plain member runs no groups");

    s.set_membership(&s.priya.0, "admin", "active").await;
    let (status, body) = s.invite(&s.priya.1, &[&s.sam.0]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body["invited"]), vec![s.sam.0.clone()]);

    let (status, body) = s.invite(&s.alex.1, &[]).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["errorCode"], "common_ground_invalid_invitation");
    let many: Vec<String> = (0..21).map(|i| format!("acct_missing_{i}")).collect();
    let many: Vec<&String> = many.iter().collect();
    let (status, body) = s.invite(&s.alex.1, &many).await;
    assert_eq!(status, 400, "at most 20 ids: {body}");
    let twenty = &many[..20];
    let (status, body) = s.invite(&s.alex.1, twenty).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["skipped"].as_array().unwrap().len(), 20);
    assert!(body["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .all(|skip| skip["reason"] == "unavailable"));
}

#[tokio::test]
async fn strangers_are_unavailable_and_matches_count() {
    let Some(s) = setup().await else {
        return;
    };
    let (stranger, _) = signed_in(&s.pool, "Zed").await;
    let (status, body) = s.invite(&s.alex.1, &[&stranger]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["skipped"],
        json!([{ "accountId": stranger, "reason": "unavailable" }])
    );
    assert!(s.statuses(&stranger).await.is_empty());
    let (status, body) = s.person_groups(&s.alex.1, &stranger).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_person_not_found");

    // Eli leaves the room: nothing links them any more.
    s.leave_room(&s.eli.1).await;
    let (status, _) = s.person_groups(&s.alex.1, &s.eli.0).await;
    assert_eq!(status, 404);
    // An opened match from Alex links them again, without a room.
    s.open_match(&s.alex.0, &s.eli.0).await;
    let (status, groups) = s.person_groups(&s.alex.1, &s.eli.0).await;
    assert_eq!(status, 200, "{groups}");
    assert_eq!(groups["groups"][0]["state"], Value::Null);

    let (status, people) = s.group_people(&s.alex.1).await;
    assert_eq!(status, 200, "{people}");
    let rows = people["people"].as_array().unwrap();
    let listed: Vec<&str> = rows
        .iter()
        .map(|row| row["person"]["accountId"].as_str().unwrap())
        .collect();
    assert!(!listed.contains(&s.alex.0.as_str()), "not the viewer");
    assert!(!listed.contains(&s.priya.0.as_str()), "not members");
    assert!(!listed.contains(&stranger.as_str()));
    assert_eq!(
        listed.last().copied(),
        Some(s.eli.0.as_str()),
        "matches after rooms"
    );
    for row in rows {
        let match_only = row["person"]["accountId"] == s.eli.0;
        assert_eq!(row["source"].is_null(), match_only, "{row}");
        if !match_only {
            assert_eq!(row["source"], s.room_name);
        }
        assert_eq!(row["invited"], false);
    }

    let (status, body) = s.invite(&s.alex.1, &[&s.eli.0]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body["invited"]), vec![s.eli.0.clone()]);
    let invitation = &s.group_pending(&s.eli.1).await[0];
    assert_eq!(invitation["roomName"], Value::Null, "from a match");
    let (status, body) = s
        .answer(&s.eli.1, &invitation["invitationRef"], "join")
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(s.is_member(&s.eli.0).await);
}

#[tokio::test]
async fn blocks_either_way_make_people_unavailable() {
    let Some(s) = setup().await else {
        return;
    };
    s.block(&s.sam.0, &s.alex.0).await;
    s.block(&s.priya.0, &s.dana.0).await;
    let (status, body) = s.invite(&s.alex.1, &[&s.sam.0, &s.dana.0]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["skipped"],
        json!([
            { "accountId": s.sam.0, "reason": "unavailable" },
            { "accountId": s.dana.0, "reason": "unavailable" },
        ])
    );
    assert!(!body.to_string().contains("Priya"), "{body}");
    let (status, _) = s.person_groups(&s.alex.1, &s.sam.0).await;
    assert_eq!(status, 404);
    let (_, people) = s.group_people(&s.alex.1).await;
    let listed: Vec<&str> = people["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["person"]["accountId"].as_str().unwrap())
        .collect();
    assert_eq!(listed, vec![s.eli.0.as_str()], "{people}");

    // A block that starts after the invitation: joining is refused.
    let (_, body) = s.invite(&s.alex.1, &[&s.eli.0]).await;
    assert_eq!(ids(&body["invited"]), vec![s.eli.0.clone()]);
    let reference = s.group_pending(&s.eli.1).await[0]["invitationRef"].clone();
    s.block(&s.eli.0, &s.priya.0).await;
    let (status, body) = s.answer(&s.eli.1, &reference, "join").await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["message"], "You can't join this group.");
    assert!(!s.is_member(&s.eli.0).await);
}

#[tokio::test]
async fn invitations_dedupe_and_declining_is_quiet() {
    let Some(s) = setup().await else {
        return;
    };
    let (_, first) = s.invite(&s.alex.1, &[&s.sam.0]).await;
    assert_eq!(ids(&first["invited"]), vec![s.sam.0.clone()]);
    let (status, again) = s.invite(&s.alex.1, &[&s.sam.0, &s.sam.0]).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(ids(&again["invited"]), vec![s.sam.0.clone()]);
    assert_eq!(again["skipped"], json!([]));
    assert_eq!(s.statuses(&s.sam.0).await, vec!["pending"]);
    assert_eq!(s.hints(&s.sam.0).await, 1, "no second hint");
    let (_, people) = s.group_people(&s.alex.1).await;
    let sam = people["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["person"]["accountId"] == s.sam.0)
        .cloned()
        .unwrap();
    assert_eq!(sam["invited"], true);

    let reference = s.group_pending(&s.sam.1).await[0]["invitationRef"].clone();
    let alex_hints = s.hints(&s.alex.0).await;
    let (status, _) = s.answer(&s.dana.1, &reference, "decline").await;
    assert_eq!(status, 404, "only the invitee declines");
    let (status, body) = s.answer(&s.sam.1, &reference, "decline").await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(s.statuses(&s.sam.0).await, vec!["declined"]);
    assert_eq!(s.hints(&s.sam.0).await, 2, "the invitee's devices refresh");
    assert_eq!(
        s.hints(&s.alex.0).await,
        alex_hints,
        "the inviter is not told"
    );
    assert!(s.pending(&s.sam.1).await.is_empty());
    let (status, _) = s.answer(&s.sam.1, &reference, "decline").await;
    assert_eq!(status, 204, "declining again changes nothing");
    let (status, body) = s.answer(&s.sam.1, &reference, "join").await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_invitation_not_found");

    let (_, body) = s.invite(&s.alex.1, &[&s.sam.0]).await;
    assert_eq!(
        body["skipped"],
        json!([{ "accountId": s.sam.0, "reason": "declined" }])
    );
    assert_eq!(s.statuses(&s.sam.0).await, vec!["declined"]);
    let (status, _) = s.answer(&s.sam.1, &json!("not-a-uuid"), "join").await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn an_inviter_who_leaves_takes_the_invitation_with_them() {
    let Some(s) = setup().await else {
        return;
    };
    s.set_membership(&s.priya.0, "admin", "active").await;
    let (_, body) = s.invite(&s.priya.1, &[&s.sam.0, &s.dana.0]).await;
    assert_eq!(ids(&body["invited"]).len(), 2, "{body}");
    let reference = s.group_pending(&s.sam.1).await[0]["invitationRef"].clone();
    s.set_membership(&s.priya.0, "member", "left").await;

    assert!(s.group_pending(&s.sam.1).await.is_empty());
    let (status, body) = s.answer(&s.sam.1, &reference, "join").await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["message"], "This invitation is no longer available.");
    assert_eq!(s.statuses(&s.sam.0).await, vec!["withdrawn"]);
    assert!(!s.is_member(&s.sam.0).await);

    // Another admin may invite again; the stale invitation is withdrawn.
    let (_, people) = s.group_people(&s.alex.1).await;
    let dana = people["people"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["person"]["accountId"] == s.dana.0)
        .cloned()
        .unwrap();
    assert_eq!(dana["invited"], false, "a stale invitation does not count");
    let (_, body) = s.invite(&s.alex.1, &[&s.dana.0]).await;
    assert_eq!(ids(&body["invited"]), vec![s.dana.0.clone()]);
    assert_eq!(s.statuses(&s.dana.0).await, vec!["withdrawn", "pending"]);
    let invitation = &s.group_pending(&s.dana.1).await[0];
    assert_eq!(invitation["from"]["accountId"], s.alex.0);
}

#[tokio::test]
async fn a_room_invitation_wins_over_a_person_invitation() {
    let Some(s) = setup().await else {
        return;
    };
    // A second group Alex starts in the room invites Dana through the room.
    let (status, body) = super::db_fixture::send(
        &s.app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{}/group", s.code),
        &s.alex.1,
        Some(json!({"name": "Agent memory", "memberIds": [s.dana.0]})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let space = body["group"]["groupSpaceId"].clone();
    let (status, body) = super::db_fixture::send(
        &s.app,
        "POST",
        "/v1/cloud/common-ground/group-invitations",
        &s.alex.1,
        Some(json!({ "groupSpaceId": space, "accountIds": [s.dana.0] })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body["invited"]), vec![s.dana.0.clone()]);
    let invitations = s.pending(&s.dana.1).await;
    assert_eq!(invitations.len(), 1, "{invitations:?}");
    assert_eq!(invitations[0]["kind"], "room");
    assert_eq!(invitations[0]["groupSpaceId"], space);
}

#[tokio::test]
async fn an_inviter_has_at_most_fifty_pending_invitations() {
    let Some(s) = setup().await else {
        return;
    };
    for i in 0..50 {
        let invitee = account(&s.pool, &format!("pending{i}")).await;
        query(
            "INSERT INTO cloud_common_ground_group_invitations
                 (invitation_id, conversation_id, group_space_id, inviter_account_id,
                  invitee_account_id, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')",
        )
        .bind(uuid::Uuid::new_v4())
        .bind(s.conversation())
        .bind(s.space())
        .bind(&s.alex.0)
        .bind(&invitee)
        .execute(&s.pool)
        .await
        .unwrap();
    }
    let (status, body) = s.invite(&s.alex.1, &[&s.sam.0]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["skipped"],
        json!([{ "accountId": s.sam.0, "reason": "limit" }])
    );
    assert!(s.statuses(&s.sam.0).await.is_empty());
}
