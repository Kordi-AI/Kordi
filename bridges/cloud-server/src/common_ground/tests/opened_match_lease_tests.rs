//! A match run queued because someone opened a person is leased ahead of
//! the room's bulk runs queued shortly before it, and never ahead of a run
//! that has waited longer than its head start.

use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{pool, send};
use super::support::people_in_a_room;
use crate::cloud_agent_runtime::runs::lease_next_run_among;

const CG: &str = "/v1/cloud/common-ground";
const RUNNER: &str = "cg-opened-lease-runner";

/// Queued Grounding match and theme runs for these people, oldest first,
/// with their lease head start.
async fn queued_runs(pool: &PgPool, people: &[String]) -> Vec<(String, i32)> {
    query_as(
        "SELECT run_id, lease_head_start_seconds FROM cloud_agent_fallback_runs
         WHERE requester_account_id = ANY($1) AND status = 'queued'
           AND (run_id LIKE 'cg\\_match\\_%' OR run_id LIKE 'cg\\_room\\_%')
         ORDER BY created_at, run_id",
    )
    .bind(people)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn an_opened_person_is_leased_before_the_rooms_bulk_runs() {
    let Some(pool) = pool().await else {
        return;
    };
    let labels = ["Alex", "Priya", "Bo", "Chen", "Dana", "Eli", "Femi", "Gus"];
    let (app, code, people) = people_in_a_room(&pool, &labels).await;
    let ids: Vec<String> = people.iter().map(|(id, _)| id.clone()).collect();
    let (alex_token, priya) = (&people[0].1, &people[1].0);

    // Everyone but Alex and Priya opens the room's results, which queues a
    // bulk match run for each of them (and the room's theme run).
    for (_, token) in &people[2..] {
        let (status, body) = send(
            &app,
            "POST",
            &format!("{CG}/rooms/{code}/results"),
            token,
            None,
        )
        .await;
        assert_eq!(status, 200, "{body}");
    }
    let bulk = queued_runs(&pool, &ids).await;
    assert_eq!(bulk.len(), people.len() - 2 + 1, "{bulk:?}");
    assert!(bulk.iter().all(|(_, head_start)| *head_start == 0));

    // Then Alex opens Priya: one run for that pair, queued after all of them.
    let (status, body) = send(
        &app,
        "GET",
        &format!("{CG}/people/{priya}/match"),
        alex_token,
        None,
    )
    .await;
    assert_eq!(status, 202, "{body}");
    let all = queued_runs(&pool, &ids).await;
    assert_eq!(all.len(), bulk.len() + 1);
    let (opened, head_start) = all.last().unwrap().clone();
    assert!(opened.starts_with("cg_match_"), "{opened}");
    assert_eq!(head_start, 600);
    let (viewer, cards): (String, i64) = query_as(
        "SELECT viewer_account_id, jsonb_array_length(cards_json)::bigint
         FROM cloud_common_ground_match_runs WHERE run_id = $1",
    )
    .bind(&opened)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((viewer.as_str(), cards), (people[0].0.as_str(), 2));

    // A run that has waited longer than the head start keeps its place.
    let waited = bulk[0].0.clone();
    query("UPDATE cloud_agent_fallback_runs SET created_at = $2 WHERE run_id = $1")
        .bind(&waited)
        .bind((chrono::Utc::now() - chrono::Duration::minutes(11)).to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();

    let run_ids: Vec<String> = all.iter().map(|(run_id, _)| run_id.clone()).collect();
    let mut leased = Vec::new();
    while let Some(run_id) = lease_next_run_among(&pool, RUNNER, &run_ids).await.unwrap() {
        leased.push(run_id);
    }
    // The long-waiting run, then the opened one, then the other bulk runs
    // in the order they were queued.
    let mut expected = vec![waited, opened];
    expected.extend(bulk[1..].iter().map(|(run_id, _)| run_id.clone()));
    assert_eq!(leased, expected);

    // Nothing is left for a later test's runner once these leases lapse.
    query("UPDATE cloud_agent_fallback_runs SET status = 'cancelled' WHERE run_id = ANY($1)")
        .bind(&run_ids)
        .execute(&pool)
        .await
        .unwrap();
}
