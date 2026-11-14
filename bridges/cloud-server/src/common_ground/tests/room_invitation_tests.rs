//! Room group invitations outside the room: the pending list for Contacts ›
//! Requests, declining, and what drops an invitation from it.

use serde_json::{json, Value};

use super::db_fixture::send;
use super::join_request_support::{setup, Setup};

async fn pending(s: &Setup, token: &str) -> Vec<Value> {
    let (status, body) = send(
        &s.app,
        "GET",
        "/v1/cloud/common-ground/invitations",
        token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body["invitations"].as_array().unwrap().clone()
}

async fn decline(s: &Setup, token: &str, reference: &str) -> (u16, Value) {
    send(
        &s.app,
        "POST",
        &format!(
            "/v1/cloud/common-ground/rooms/{}/invitations/{reference}/decline",
            s.code
        ),
        token,
        None,
    )
    .await
}

async fn room_invitations(s: &Setup, token: &str) -> Value {
    let (status, room) = send(
        &s.app,
        "GET",
        &format!("/v1/cloud/common-ground/rooms/{}", s.code),
        token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{room}");
    room["invitations"].clone()
}

#[tokio::test]
async fn an_invitee_sees_the_invitation_outside_the_room_and_declines_it() {
    let Some(s) = setup().await else {
        return;
    };
    let invitations = pending(&s, &s.dana.1).await;
    assert_eq!(invitations.len(), 1, "{invitations:?}");
    let invitation = &invitations[0];
    assert_eq!(invitation["code"], s.code);
    assert_eq!(invitation["name"], "Agent memory");
    assert_eq!(invitation["groupSpaceId"], s.space());
    assert_eq!(invitation["from"]["accountId"], s.alex.0);
    assert!(invitation["roomName"].is_string());
    assert!(
        pending(&s, &s.sam.1).await.is_empty(),
        "only invitees see it"
    );
    assert!(
        pending(&s, &s.priya.1).await.is_empty(),
        "members were added, not invited"
    );

    let reference = invitation["invitationRef"].as_str().unwrap().to_string();
    let (status, body) = decline(&s, &s.sam.1, &reference).await;
    assert_eq!(status, 404, "only the invitee declines: {body}");
    let (status, body) = decline(&s, &s.dana.1, &reference).await;
    assert_eq!(status, 204, "{body}");
    assert!(pending(&s, &s.dana.1).await.is_empty());
    assert_eq!(room_invitations(&s, &s.dana.1).await, json!([]));
    let (status, _) = decline(&s, &s.dana.1, &reference).await;
    assert_eq!(status, 204, "declining again changes nothing");
    assert!(!s.is_member(&s.dana.0).await);

    // After declining, Dana may still ask to join.
    let (status, body) = s.ask(&s.dana.1).await;
    assert_eq!(status, 201, "{body}");
}

#[tokio::test]
async fn joining_or_leaving_the_room_drops_the_invitation() {
    let Some(s) = setup().await else {
        return;
    };
    let reference = pending(&s, &s.dana.1).await[0]["invitationRef"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, body) = send(
        &s.app,
        "POST",
        &format!(
            "/v1/cloud/common-ground/rooms/{}/invitations/{reference}/join",
            s.code
        ),
        &s.dana.1,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(pending(&s, &s.dana.1).await.is_empty());

    let Some(s) = setup().await else {
        return;
    };
    assert_eq!(pending(&s, &s.dana.1).await.len(), 1);
    let (status, _) = send(
        &s.app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{}/leave", s.code),
        &s.dana.1,
        None,
    )
    .await;
    assert_eq!(status, 204);
    assert!(pending(&s, &s.dana.1).await.is_empty());
}
