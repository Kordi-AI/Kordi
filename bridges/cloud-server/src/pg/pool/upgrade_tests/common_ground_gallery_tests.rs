use super::*;

#[test]
fn room_gallery_migration_is_registered() {
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 207)
        .expect("migration 207 is embedded");
    assert_eq!(migration.description, "common ground room gallery");
    assert!(migration.sql.starts_with("-- Room gallery"));
    assert!(migration.sql.contains("SET LOCAL lock_timeout"));
    for table in [
        "cloud_common_ground_room_gallery_items",
        "cloud_common_ground_room_gallery_comments",
    ] {
        assert!(
            migration
                .sql
                .contains(&format!("CREATE TABLE IF NOT EXISTS {table}")),
            "{table}"
        );
    }
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_206_adds_the_room_gallery() {
    let pool = fixture(206).await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-0000000000d1','4321')").await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at,finalized_at) VALUES('att_fixture','fixture-owner','att_fixture','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (rooms,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_rooms")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rooms, 1, "existing rooms are kept");
    let insert = |item: &'static str, title: &'static str, topic: Option<String>| {
        let pool = pool.clone();
        async move {
            query(
                "INSERT INTO cloud_common_ground_room_gallery_items
                     (item_id,room_id,account_id,attachment_id,title,file_name,topic)
                 VALUES($1::uuid,'00000000-0000-0000-0000-0000000000d1','fixture-owner',
                        'att_fixture',$2,'plan.md',$3)",
            )
            .bind(item)
            .bind(title)
            .bind(topic)
            .execute(&pool)
            .await
        }
    };
    assert!(insert("00000000-0000-0000-0000-0000000000e1", "", None)
        .await
        .is_err());
    assert!(insert(
        "00000000-0000-0000-0000-0000000000e2",
        "Plan",
        Some("t".repeat(81))
    )
    .await
    .is_err());
    insert("00000000-0000-0000-0000-0000000000e3", "Plan", None)
        .await
        .unwrap();
    assert!(
        insert("00000000-0000-0000-0000-0000000000e4", "Plan", None)
            .await
            .is_err(),
        "an attachment is in a room's gallery once"
    );
    execute(&pool, "INSERT INTO cloud_common_ground_room_gallery_comments(comment_id,item_id,account_id,body) VALUES('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000e3','fixture-peer','Nice')").await;
    assert!(query("INSERT INTO cloud_common_ground_room_gallery_comments(comment_id,item_id,account_id,body) VALUES('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000e3','fixture-peer','')")
        .execute(&pool)
        .await
        .is_err());
    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 207)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let count = |sql: &'static str| {
        let pool = pool.clone();
        async move {
            let (count,): (i64,) = query_as(sql).fetch_one(&pool).await.unwrap();
            count
        }
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_common_ground_room_gallery_comments").await,
        1
    );
    // Deleting the attachment deletes its items and their comments.
    execute(
        &pool,
        "DELETE FROM cloud_attachments WHERE attachment_id = 'att_fixture'",
    )
    .await;
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_common_ground_room_gallery_items").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_common_ground_room_gallery_comments").await,
        0
    );
}
