use super::*;

const GROUP: &str = "00000000-0000-4000-8000-000000000192";
const DIRECT: &str = "00000000-0000-4000-8000-000000000193";

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_191_backfills_read_watermarks() {
    let pool = fixture(191).await;
    execute(&pool, "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('fixture-third','fixture-third','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','lorelei','fixture-third','fixture',1,'2026-01-01T00:00:00Z')").await;
    execute(&pool, &format!("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,next_message_sequence,latest_message_sequence) VALUES('{GROUP}','group','fixture-owner',gen_random_uuid(),'fixture',6,5),('{DIRECT}','group','fixture-owner',gen_random_uuid(),'fixture',2,1)")).await;
    // Group: owner wrote 1, 3 and 5, peer 2, third 4. Peer read through 3,
    // third through 4, owner through 5.
    execute(&pool, &format!("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id,last_delivered_sequence,last_read_sequence) VALUES('{GROUP}','fixture-owner',5,5),('{GROUP}','fixture-peer',5,3),('{GROUP}','fixture-third',4,4),('{DIRECT}','fixture-owner',1,1),('{DIRECT}','fixture-peer',1,0)")).await;
    for (conversation, sequence, sender) in [
        (GROUP, 1, "fixture-owner"),
        (GROUP, 2, "fixture-peer"),
        (GROUP, 3, "fixture-owner"),
        (GROUP, 4, "fixture-third"),
        (GROUP, 5, "fixture-owner"),
        (DIRECT, 1, "fixture-owner"),
    ] {
        query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content) VALUES($1,$2::uuid,$3,$4,$5,'fixture',$6)")
            .bind(Uuid::new_v4())
            .bind(conversation)
            .bind(sequence)
            .bind(sender)
            .bind(Uuid::new_v4())
            .bind(json!({"schema":1,"blocks":[{"type":"text","text":"Historical message"}]}))
            .execute(&pool)
            .await
            .unwrap();
    }
    let members = "SELECT to_jsonb(m) FROM cloud_chat_conversation_members m \
        ORDER BY conversation_id, account_id";
    let before: Vec<(Value,)> = query_as(members).fetch_all(&pool).await.unwrap();

    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    let after: Vec<(Value,)> = query_as(members).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "member cursors are untouched");
    let watermarks: Vec<(String, String, i64)> = query_as(
        "SELECT conversation_id::text, account_id, sequence FROM cloud_chat_read_outbox \
         ORDER BY conversation_id, account_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    // Owner: others read through 4 at most, so 3. Peer: 2, read by owner.
    // Third: 4, read by owner. Nobody read the direct message yet.
    assert_eq!(
        watermarks,
        vec![
            (GROUP.into(), "fixture-owner".into(), 3),
            (GROUP.into(), "fixture-peer".into(), 2),
            (GROUP.into(), "fixture-third".into(), 4),
        ]
    );
    let (marks,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_chat_read_marks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(marks, 0, "no read times are invented");
}
