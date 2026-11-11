use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_187_adds_profile_field_modes() {
    let pool = fixture(187).await;
    // fixture-owner chose a time zone by hand; fixture-peer never set one.
    execute(
        &pool,
        "UPDATE cloud_accounts SET time_zone = 'Asia/Riyadh', location = 'Lisbon' \
         WHERE account_id = 'fixture-owner'",
    )
    .await;
    let accounts = "SELECT to_jsonb(a) - ARRAY['location_mode','time_zone_mode','share_calendar_availability'] \
        FROM cloud_accounts a ORDER BY account_id";
    let before: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> = query_as(accounts).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "existing account data is untouched");

    let modes: Vec<(String, String, String)> = query_as(
        "SELECT account_id, location_mode, time_zone_mode FROM cloud_accounts ORDER BY account_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        modes,
        vec![
            ("fixture-owner".into(), "manual".into(), "manual".into()),
            ("fixture-peer".into(), "manual".into(), "automatic".into()),
        ],
        "a chosen time zone stays manual; location stays off"
    );

    execute(&pool, "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('fixture-new','fixture-new','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','lorelei','fixture-new','fixture',1,'2026-01-01T00:00:00Z')").await;
    let (location_mode, time_zone_mode): (String, String) = query_as(
        "SELECT location_mode, time_zone_mode FROM cloud_accounts WHERE account_id = 'fixture-new'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (location_mode.as_str(), time_zone_mode.as_str()),
        ("manual", "automatic")
    );
    for invalid in [
        "UPDATE cloud_accounts SET location_mode = 'device' WHERE account_id = 'fixture-new'",
        "UPDATE cloud_accounts SET time_zone_mode = NULL WHERE account_id = 'fixture-new'",
    ] {
        assert!(
            sqlx_core::raw_sql::raw_sql(invalid)
                .execute(&pool)
                .await
                .is_err(),
            "{invalid}"
        );
    }
}
