use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_200_adds_room_join_requests() {
    let pool = fixture(200).await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code,name,created_by) VALUES('00000000-0000-0000-0000-0000000000a1','1234','Fixture room','fixture-owner')").await;
    execute(&pool, "INSERT INTO cloud_common_ground_room_groups(group_space_id,room_id,conversation_id,name,created_by) VALUES('session:group:fixture','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Fixture group','fixture-owner')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let groups: (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_room_groups")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(groups.0, 1, "existing groups are kept");
    let insert = |request: &'static str, status: &'static str| {
        let pool = pool.clone();
        async move {
            query(
                "INSERT INTO cloud_common_ground_room_join_requests
                     (request_id,room_id,group_space_id,requester_account_id,status)
                 VALUES($1::uuid,'00000000-0000-0000-0000-0000000000a1','session:group:fixture','fixture-owner',$2)",
            )
            .bind(request)
            .bind(status)
            .execute(&pool)
            .await
        }
    };
    insert("00000000-0000-0000-0000-0000000000c1", "declined")
        .await
        .unwrap();
    insert("00000000-0000-0000-0000-0000000000c2", "pending")
        .await
        .unwrap();
    assert!(
        insert("00000000-0000-0000-0000-0000000000c3", "pending")
            .await
            .is_err(),
        "one pending request per person and group"
    );
    assert!(insert("00000000-0000-0000-0000-0000000000c4", "maybe")
        .await
        .is_err());
    let (revision,): (i64,) = query_as(
        "SELECT revision FROM cloud_common_ground_room_join_requests
         WHERE request_id = '00000000-0000-0000-0000-0000000000c2'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(revision, 1);
    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 201)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (count,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_room_join_requests")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let (declined,): (Option<chrono::DateTime<chrono::Utc>>,) =
        query_as("SELECT declined_at FROM cloud_common_ground_room_invitations LIMIT 1")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .unwrap_or((None,));
    assert!(declined.is_none(), "room invitations can record a decline");
}
