use super::*;

#[test]
fn deleted_account_credentials_migration_is_registered() {
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 208)
        .expect("migration 208 is embedded");
    assert_eq!(migration.description, "deleted account credentials");
    assert!(migration
        .sql
        .starts_with("-- Credentials of deleted accounts"));
    assert!(migration.sql.contains("SET LOCAL lock_timeout"));
    assert!(migration
        .sql
        .contains("CREATE TABLE IF NOT EXISTS cloud_deleted_account_credentials"));
    // The table never names an account, device, email or person.
    let table = migration
        .sql
        .split("CREATE TABLE")
        .nth(1)
        .and_then(|rest| rest.split_once('('))
        .and_then(|(_, columns)| columns.split(");").next())
        .expect("the column definitions");
    for column in ["account", "device", "email", "name"] {
        assert!(!table.contains(column), "{column}: {table}");
    }
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_207_adds_deleted_account_credentials() {
    let pool = fixture(207).await;
    let before: Option<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT to_regclass('public.cloud_deleted_account_credentials')::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(before.is_none());
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (accounts,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_accounts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(accounts, 2, "existing accounts are kept");

    let hash = "a".repeat(64);
    let insert = |hash: String, kind: &'static str| {
        let pool = pool.clone();
        async move {
            query(
                "INSERT INTO cloud_deleted_account_credentials (credential_hash, kind, expires_at) \
                 VALUES ($1, $2, now() + interval '1 day')",
            )
            .bind(hash)
            .bind(kind)
            .execute(&pool)
            .await
        }
    };
    insert(hash.clone(), "session").await.unwrap();
    insert("b".repeat(64), "refresh").await.unwrap();
    assert!(
        insert(hash.clone(), "refresh").await.is_err(),
        "a hash is listed once"
    );
    assert!(
        insert("person@example.test".to_string(), "session")
            .await
            .is_err(),
        "only a hex SHA-256 fits"
    );
    assert!(
        insert("c".repeat(64), "web").await.is_err(),
        "known kinds only"
    );

    // Running the released SQL again keeps the rows.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 208)
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx_core::raw_sql::raw_sql(migration.sql)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (rows,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_deleted_account_credentials")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 2);
}
