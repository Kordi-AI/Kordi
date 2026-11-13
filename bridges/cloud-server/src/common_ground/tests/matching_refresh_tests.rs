//! Room themes while they are found again: after the members or their cards
//! change, an open room's results keep the previous themes, with only the
//! people the viewer still sees, until the new theme run lands.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::{pool, send, signed_in};
use super::sharing_support::{ids, results, topics, CG};
use super::support::{
    answer_match, answer_themes, build_card_with, card_reply, make_contacts, people_in_a_room,
};

type Theme = (String, Vec<String>);

fn theme(label: &str, people: &[&String]) -> Theme {
    (
        label.to_string(),
        people.iter().map(|id| id.to_string()).collect(),
    )
}

fn suggested(body: &Value) -> Option<Theme> {
    let suggestion = &body["suggestion"];
    let label = suggestion["label"].as_str()?.to_string();
    Some((label, ids(&suggestion["people"], "")))
}

async fn room_of(pool: &PgPool, code: &str) -> Uuid {
    let (room,): (Uuid,) = query_as(
        "SELECT room_id FROM cloud_common_ground_rooms WHERE code = $1 AND closed_at IS NULL",
    )
    .bind(code)
    .fetch_one(pool)
    .await
    .unwrap();
    room
}

/// Theme runs ever queued for the room.
async fn theme_runs(pool: &PgPool, room: Uuid) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs WHERE kind = 'room' AND room_id = $1",
    )
    .bind(room)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn previous_themes_stay_until_the_new_ones_land() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, priya_token), (sam, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let room = room_of(&pool, &code).await;

    // A room that never had themes shows none while its first run works.
    let (status, body) = results(&app, &code, &alex_token).await;
    assert_eq!(
        (status, &body["status"]),
        (200, &json!("matching")),
        "{body}"
    );
    assert_eq!(
        (&body["topics"], &body["suggestion"]),
        (&json!([]), &Value::Null)
    );
    answer_match(&pool, &alex).await;
    let everyone = [&alex, &priya, &sam];
    answer_themes(
        &pool,
        &[("Agent memory", &everyone), ("Retrieval", &[&alex, &priya])],
    )
    .await;
    let (_, body) = results(&app, &code, &alex_token).await;
    assert_eq!(body["status"], "ready", "{body}");
    let before = vec![
        theme("Agent memory", &everyone),
        theme("Retrieval", &[&alex, &priya]),
    ];
    assert_eq!(topics(&body), before);

    // Lee joins: the previous themes stay, without him, while one new run
    // finds them again.
    let (lee, lee_token) = signed_in(&pool, "Lee").await;
    let reply = card_reply(&["Agent memory"], &["Retrieval"], &[], &[]);
    build_card_with(&app, &pool, &lee, &lee_token, &reply).await;
    let join = format!("{CG}/rooms/{code}/join");
    assert_eq!(send(&app, "POST", &join, &lee_token, None).await.0, 200);
    let (status, body) = results(&app, &code, &alex_token).await;
    assert_eq!(
        (status, &body["status"]),
        (200, &json!("matching")),
        "{body}"
    );
    assert_eq!(topics(&body), before, "{body}");
    assert_eq!(suggested(&body), Some(theme("Agent memory", &everyone)));
    let (_, body) = results(&app, &code, &priya_token).await;
    let mine = theme("Agent memory", &[&priya, &alex, &sam]);
    assert_eq!(topics(&body)[0], mine, "{body}");
    assert_eq!(theme_runs(&pool, room).await, 2, "one new theme run");

    answer_match(&pool, &alex).await;
    let all = [&alex, &priya, &sam, &lee];
    let read = answer_themes(&pool, &[("Agent memory", &all), ("Evals", &[&sam, &lee])]).await;
    assert_eq!(read, all.map(|id| id.clone()));
    let (_, body) = results(&app, &code, &alex_token).await;
    assert_eq!(body["status"], "ready", "{body}");
    let after = vec![theme("Agent memory", &all), theme("Evals", &[&sam, &lee])];
    assert_eq!(topics(&body), after);
    assert_eq!(suggested(&body), Some(theme("Agent memory", &all)));
}

#[tokio::test]
async fn previous_themes_leave_out_who_left_or_hid_their_card() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam", "Lee"]).await;
    let [(alex, alex_token), (priya, priya_token), (sam, sam_token), (lee, _)] = [
        people[0].clone(),
        people[1].clone(),
        people[2].clone(),
        people[3].clone(),
    ];
    let room = room_of(&pool, &code).await;
    assert_eq!(results(&app, &code, &alex_token).await.0, 200);
    answer_match(&pool, &alex).await;
    answer_themes(
        &pool,
        &[
            ("Agent memory", &[&alex, &priya, &sam, &lee]),
            ("Robots", &[&alex, &sam]),
            ("Evals", &[&alex, &priya]),
        ],
    )
    .await;
    let (_, body) = results(&app, &code, &alex_token).await;
    assert_eq!(topics(&body).len(), 3, "{body}");

    // Sam leaves: he is gone from the previous themes, and a theme left
    // with one person is dropped.
    let leave = format!("{CG}/rooms/{code}/leave");
    assert_eq!(send(&app, "POST", &leave, &sam_token, None).await.0, 204);
    let (_, body) = results(&app, &code, &alex_token).await;
    assert_eq!(body["status"], "matching", "{body}");
    let left = vec![
        theme("Agent memory", &[&alex, &priya, &lee]),
        theme("Evals", &[&alex, &priya]),
    ];
    assert_eq!(topics(&body), left, "{body}");
    assert_eq!(
        suggested(&body),
        Some(theme("Agent memory", &[&alex, &priya, &lee]))
    );
    assert_eq!(theme_runs(&pool, room).await, 2);

    // Priya stops Alex from seeing her card: he no longer sees her in them;
    // she still sees him.
    make_contacts(&pool, &alex, &priya).await;
    let permissions = format!("/v1/cloud/contacts/{alex}/permissions");
    let off = Some(json!({"cardAccess": false}));
    assert_eq!(
        send(&app, "PUT", &permissions, &priya_token, off).await.0,
        200
    );
    let (_, body) = results(&app, &code, &alex_token).await;
    let hidden = vec![theme("Agent memory", &[&alex, &lee])];
    assert_eq!(topics(&body), hidden, "{body}");
    assert_eq!(suggested(&body), Some(hidden[0].clone()));
    let (_, body) = results(&app, &code, &priya_token).await;
    let hers = vec![
        theme("Agent memory", &[&priya, &alex, &lee]),
        theme("Evals", &[&priya, &alex]),
    ];
    assert_eq!(topics(&body), hers, "{body}");
    assert_eq!(theme_runs(&pool, room).await, 2, "polling queues nothing");

    // Closed, the room shows its last themes as before and queues nothing.
    query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE room_id = $1")
        .bind(room)
        .execute(&pool)
        .await
        .unwrap();
    let (_, body) = results(&app, &code, &alex_token).await;
    assert_eq!(body["status"], "ready", "{body}");
    assert_eq!(topics(&body), hidden, "{body}");
    assert_eq!(theme_runs(&pool, room).await, 2);
}

#[tokio::test]
async fn previous_themes_need_a_run_that_may_replace_them() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, _), (sam, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let room = room_of(&pool, &code).await;
    assert_eq!(results(&app, &code, &alex_token).await.0, 200);
    answer_match(&pool, &alex).await;
    answer_themes(
        &pool,
        &[
            ("Agent memory", &[&alex, &priya, &sam]),
            ("Retrieval", &[&alex, &sam]),
        ],
    )
    .await;
    let decline = |account: String| {
        let pool = pool.clone();
        async move {
            query("UPDATE cloud_accounts SET ai_consent_status = 'declined' WHERE account_id = $1")
                .bind(&account)
                .execute(&pool)
                .await
                .unwrap();
        }
    };

    // Sam declines AI. His own request cannot queue a theme run, so he sees
    // no themes, not the previous ones.
    decline(sam.clone()).await;
    let (status, body) = results(&app, &code, &sam_token).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["topics"], &body["suggestion"]),
        (&json!([]), &Value::Null)
    );
    assert_eq!(theme_runs(&pool, room).await, 1, "nothing queued");

    // Alex's request queues one without Sam; the previous themes leave Sam
    // out too, as the new ones will.
    let (_, body) = results(&app, &code, &alex_token).await;
    assert_eq!(body["status"], "matching", "{body}");
    let without_sam = vec![theme("Agent memory", &[&alex, &priya])];
    assert_eq!(topics(&body), without_sam, "{body}");
    assert_eq!(theme_runs(&pool, room).await, 2);
    let (_, body) = results(&app, &code, &sam_token).await;
    assert_eq!(body["topics"], json!([]), "still none while it works");

    // With fewer than two members left for themes, there are none.
    decline(priya).await;
    let (_, body) = results(&app, &code, &alex_token).await;
    assert_eq!(
        (&body["topics"], &body["suggestion"]),
        (&json!([]), &Value::Null)
    );
}
