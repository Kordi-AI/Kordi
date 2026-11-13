use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_199_adds_card_rematch_marks() {
    let pool = fixture(199).await;
    execute(&pool, "INSERT INTO cloud_common_ground_profiles(profile_id,account_id,kind,name,position) VALUES('cgp_a','fixture-owner','work','Work',0)").await;
    execute(&pool, "INSERT INTO cloud_common_ground_cards(profile_id,account_id,revision) VALUES('cgp_a','fixture-owner',3)").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let card = "SELECT revision, rematch_at IS NOT NULL FROM cloud_common_ground_cards";
    let (revision, marked): (i64, bool) = query_as(card).fetch_one(&pool).await.unwrap();
    assert_eq!(
        (revision, marked),
        (3, false),
        "existing cards keep their revision and are not marked"
    );
    execute(
        &pool,
        "UPDATE cloud_common_ground_cards SET rematch_at = now()",
    )
    .await;
    // Running the released SQL again keeps the mark.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 200)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (_, marked): (i64, bool) = query_as(card).fetch_one(&pool).await.unwrap();
    assert!(marked);
}
