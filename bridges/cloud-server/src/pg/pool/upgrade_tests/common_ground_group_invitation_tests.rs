use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_202_adds_group_invitations() {
    let pool = fixture(202).await;
    execute(&pool, "INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id) VALUES('00000000-0000-0000-0000-0000000000b1','group','fixture-owner','00000000-0000-0000-0000-0000000000b2','fixture','session:group:fixture')").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (conversations,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_chat_conversations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(conversations, 1, "existing groups are kept");
    let insert = |invitation: &'static str, status: &'static str| {
        let pool = pool.clone();
        async move {
            query(
                "INSERT INTO cloud_common_ground_group_invitations
                     (invitation_id,conversation_id,group_space_id,inviter_account_id,
                      invitee_account_id,status)
                 VALUES($1::uuid,'00000000-0000-0000-0000-0000000000b1','session:group:fixture',
                        'fixture-owner','fixture-peer',$2)",
            )
            .bind(invitation)
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
        "one pending invitation per person and group"
    );
    assert!(insert("00000000-0000-0000-0000-0000000000c4", "maybe")
        .await
        .is_err());
    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 203)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (count,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_group_invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    // Deleting the group deletes its invitations.
    execute(
        &pool,
        "DELETE FROM cloud_chat_conversations WHERE conversation_id = '00000000-0000-0000-0000-0000000000b1'",
    )
    .await;
    let (count,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_common_ground_group_invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
