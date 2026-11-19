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

#[test]
fn gallery_preview_repair_is_registered() {
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 208)
        .expect("migration 208 is embedded");
    assert_eq!(
        migration.description,
        "common ground gallery preview block ids"
    );
    assert!(migration.sql.starts_with("-- Room gallery previews"));
    assert!(migration.sql.contains("SET LOCAL lock_timeout"));
}

/// The previews of the room gallery items, by attachment id.
async fn previews(pool: &PgPool) -> Vec<(String, Option<String>)> {
    query_as(
        "SELECT attachment_id, preview FROM cloud_common_ground_room_gallery_items
         ORDER BY attachment_id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_207_strips_block_ids_from_document_previews() {
    let pool = fixture(207).await;
    execute(&pool, "INSERT INTO cloud_common_ground_rooms(room_id,code) VALUES('00000000-0000-0000-0000-0000000000d2','4322')").await;
    let items = [
        // A document with stored text, cut at 800 characters inside a comment.
        (
            "att_doc",
            true,
            "# Plan\n<!-- k:head0001 -->\n\nFirst paragraph. <!-- k:para0001 -->\n\n<!-- a note -->\nCut <!-- k:2nv",
        ),
        // A document whose preview held nothing but block-id comments.
        ("att_doc_blank", true, "<!-- k:aaaa1111 -->\n<!-- k:bbbb2222 -->\n"),
        // A document with an ordinary comment only.
        ("att_doc_note", true, "Text <!-- note -->"),
        // A file without stored text is another person's bytes: unchanged.
        ("att_file", false, "Notes <!-- k:keep0001 -->"),
    ];
    for (index, (attachment, stored, preview)) in items.iter().enumerate() {
        query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at,finalized_at) VALUES($1,'fixture-owner',$1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")
            .bind(attachment)
            .execute(&pool)
            .await
            .unwrap();
        if *stored {
            query("INSERT INTO cloud_document_contents(attachment_id,source,revision,updated_at) VALUES($1,$2,1,'2026-01-01T00:00:00Z')")
                .bind(attachment)
                .bind(preview)
                .execute(&pool)
                .await
                .unwrap();
        }
        query(
            "INSERT INTO cloud_common_ground_room_gallery_items
                 (item_id,room_id,account_id,attachment_id,title,file_name,preview)
             VALUES($1,'00000000-0000-0000-0000-0000000000d2','fixture-owner',$2,'Plan',
                    'plan.md',$3)",
        )
        .bind(Uuid::from_u128(0xe10 + index as u128))
        .bind(attachment)
        .bind(preview)
        .execute(&pool)
        .await
        .unwrap();
    }
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let expected = vec![
        (
            "att_doc".to_string(),
            Some("# Plan\n\nFirst paragraph.\n\n<!-- a note -->\nCut".to_string()),
        ),
        ("att_doc_blank".to_string(), None),
        (
            "att_doc_note".to_string(),
            Some("Text <!-- note -->".to_string()),
        ),
        (
            "att_file".to_string(),
            Some("Notes <!-- k:keep0001 -->".to_string()),
        ),
    ];
    assert_eq!(previews(&pool).await, expected);
    // Running the released SQL again changes nothing.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 208)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    let result = sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(result.rows_affected(), 0);
    assert_eq!(previews(&pool).await, expected);
}
