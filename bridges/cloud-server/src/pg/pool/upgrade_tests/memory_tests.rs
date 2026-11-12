use super::*;

/// Memory id, category, declaration type, confidence and profile id.
type Backfill = (String, String, String, Option<String>, Option<String>);

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_149_adds_memory_categories() {
    let pool = fixture(149).await;
    execute(
        &pool,
        "INSERT INTO cloud_account_memories \
           (memory_id, owner_account_id, scope, scope_id, scope_label, source, text, created_at, updated_at) \
         VALUES \
           ('mem_manual', 'fixture-owner', 'global', 'account', NULL, 'manual', \
            'Answer in British English', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), \
           ('mem_correction', 'fixture-owner', 'conversation', 'session-1', 'Launch', \
            'user_correction', 'Prefer short replies', '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z'), \
           ('mem_outcome', 'fixture-owner', 'project', 'project-1', NULL, 'outcome', \
            'Run the smoke test first', '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z')",
    )
    .await;
    let rows = "SELECT memory_id, to_jsonb(m) - ARRAY['category','declaration_type','confidence','profile_id','categories'] \
        FROM cloud_account_memories m ORDER BY memory_id";
    let before: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "text, scope and timestamps are untouched");

    let backfill: Vec<Backfill> = query_as(
        "SELECT memory_id, category, declaration_type, confidence, profile_id \
         FROM cloud_account_memories ORDER BY memory_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let expected = |id: &str, category: &str, declaration: &str, confidence: Option<&str>| {
        (
            id.to_string(),
            category.to_string(),
            declaration.to_string(),
            confidence.map(str::to_string),
            None,
        )
    };
    assert_eq!(
        backfill,
        vec![
            expected(
                "mem_correction",
                "general_preferences",
                "model-inferred",
                Some("medium")
            ),
            expected("mem_manual", "general_preferences", "user-declared", None),
            expected(
                "mem_outcome",
                "hcp-custom:task_lessons",
                "model-inferred",
                Some("medium")
            ),
        ]
    );

    for invalid in [
        "UPDATE cloud_account_memories SET category = 'diary' WHERE memory_id = 'mem_manual'",
        "UPDATE cloud_account_memories SET declaration_type = 'guessed' WHERE memory_id = 'mem_manual'",
        "UPDATE cloud_account_memories SET confidence = 'certain' WHERE memory_id = 'mem_manual'",
        "UPDATE cloud_account_memories SET profile_id = 'cgp_missing' WHERE memory_id = 'mem_manual'",
    ] {
        assert!(
            sqlx_core::raw_sql::raw_sql(invalid)
                .execute(&pool)
                .await
                .is_err(),
            "{invalid}"
        );
    }

    // Deleting a profile keeps its memories and clears their profile.
    execute(
        &pool,
        "INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position) \
         VALUES ('cgp_fixture_health', 'fixture-owner', 'health', 'Health', 7); \
         UPDATE cloud_account_memories SET profile_id = 'cgp_fixture_health' WHERE memory_id = 'mem_manual'; \
         DELETE FROM cloud_common_ground_profiles WHERE profile_id = 'cgp_fixture_health'",
    )
    .await;
    let (profile,): (Option<String>,) =
        query_as("SELECT profile_id FROM cloud_account_memories WHERE memory_id = 'mem_manual'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(profile, None);
}

/// Memory id, profile id and whether the card is included.
type Override = (String, String, bool);

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_150_adds_memory_card_overrides() {
    let pool = fixture(150).await;
    execute(
        &pool,
        "INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position) VALUES \
           ('cgp_work', 'fixture-owner', 'work', 'Work', 0), \
           ('cgp_health', 'fixture-owner', 'health', 'Health', 1), \
           ('cgp_daily', 'fixture-owner', 'daily', 'Daily tasks', 2), \
           ('cgp_custom', 'fixture-owner', 'custom', 'KAUST', 3), \
           ('cgp_peer_work', 'fixture-peer', 'work', 'Work', 0); \
         INSERT INTO cloud_account_memories \
           (memory_id, owner_account_id, scope, scope_id, source, text, category, profile_id) VALUES \
           ('mem_work_to_custom', 'fixture-owner', 'global', 'account', 'manual', \
            'Reviews papers for the lab', 'work_context', 'cgp_custom'), \
           ('mem_coordination_to_health', 'fixture-owner', 'global', 'account', 'manual', \
            'Free on Tuesday mornings', 'coordination_context', 'cgp_health'), \
           ('mem_preference_to_work', 'fixture-owner', 'global', 'account', 'manual', \
            'Prefers short replies', 'general_preferences', 'cgp_work'), \
           ('mem_unpinned', 'fixture-owner', 'global', 'account', 'manual', \
            'Leads the Atlas pipeline', 'work_context', NULL)",
    )
    .await;
    let rows = "SELECT memory_id, to_jsonb(m) - 'categories' FROM cloud_account_memories m \
        ORDER BY memory_id";
    let before: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "memories, pins and timestamps are untouched");

    let overrides: Vec<Override> = query_as(
        "SELECT memory_id, profile_id, included FROM cloud_account_memory_card_overrides \
         ORDER BY memory_id, profile_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let row = |memory: &str, profile: &str, included: bool| {
        (memory.to_string(), profile.to_string(), included)
    };
    // Each pin is an included card; the other cards its category routes to
    // are excluded, so a pinned memory still feeds only its pinned card.
    assert_eq!(
        overrides,
        vec![
            row("mem_coordination_to_health", "cgp_daily", false),
            row("mem_coordination_to_health", "cgp_health", true),
            row("mem_coordination_to_health", "cgp_work", false),
            row("mem_preference_to_work", "cgp_work", true),
            row("mem_work_to_custom", "cgp_custom", true),
            row("mem_work_to_custom", "cgp_work", false),
        ]
    );

    // Deleting a profile or a memory removes its card rows.
    execute(
        &pool,
        "DELETE FROM cloud_common_ground_profiles WHERE profile_id = 'cgp_daily'; \
         DELETE FROM cloud_account_memories WHERE memory_id = 'mem_work_to_custom'",
    )
    .await;
    let (left,): (i64,) = query_as("SELECT COUNT(*) FROM cloud_account_memory_card_overrides")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 3);
    assert!(
        sqlx_core::raw_sql::raw_sql(
            "INSERT INTO cloud_account_memory_card_overrides (memory_id, profile_id, included) \
             VALUES ('mem_unpinned', 'cgp_missing', TRUE)"
        )
        .execute(&pool)
        .await
        .is_err(),
        "the card must exist"
    );
}

/// Memory id, primary category and categories.
type Categories = (String, String, Vec<String>);

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_after_197_backfills_missing_memory_categories() {
    let pool = fixture(195).await;
    // Session caching can be installed while the earlier memory migration is pending.
    let migration = EMBEDDED_MIGRATIONS
        .iter()
        .find(|m| m.version == 197)
        .unwrap();
    execute(&pool, migration.sql).await;
    query("INSERT INTO cloud_schema_versions(version,description) VALUES($1,$2)")
        .bind(migration.version)
        .bind(migration.description)
        .execute(&pool)
        .await
        .unwrap();
    execute(
        &pool,
        "INSERT INTO cloud_account_memories \
           (memory_id, owner_account_id, scope, scope_id, source, text, category) VALUES \
           ('mem_after_cache', 'fixture-owner', 'global', 'account', 'manual', \
            'Keep project review notes', 'work_context')",
    )
    .await;
    let recorded = "SELECT applied_at::text FROM cloud_schema_versions WHERE version=197";
    let before: (String,) = query_as(recorded).fetch_one(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (category, categories): (String, Vec<String>) = query_as(
        "SELECT category, categories FROM cloud_account_memories WHERE memory_id='mem_after_cache'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(category, "work_context");
    assert_eq!(categories, ["work_context"]);
    let after: (String,) = query_as(recorded).fetch_one(&pool).await.unwrap();
    assert_eq!(before, after, "the newer migration is not reapplied");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_195_adds_several_categories_per_memory() {
    let pool = fixture(195).await;
    execute(
        &pool,
        "INSERT INTO cloud_account_memories \
           (memory_id, owner_account_id, scope, scope_id, source, text, category, archived_at) VALUES \
           ('mem_work', 'fixture-owner', 'global', 'account', 'manual', \
            'Leads the Atlas pipeline', 'work_context', NULL), \
           ('mem_lesson', 'fixture-owner', 'project', 'project-1', 'outcome', \
            'Run the smoke test first', 'hcp-custom:task_lessons', NULL), \
           ('mem_archived', 'fixture-owner', 'global', 'account', 'manual', \
            'Trains on weekends', 'health_context', '2026-01-02T00:00:00Z')",
    )
    .await;
    let rows = "SELECT memory_id, to_jsonb(m) - 'categories' FROM cloud_account_memories m \
        ORDER BY memory_id";
    let before: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(String, Value)> = query_as(rows).fetch_all(&pool).await.unwrap();
    assert_eq!(
        before, after,
        "text, categories and timestamps are untouched"
    );

    let categories = "SELECT memory_id, category, categories FROM cloud_account_memories \
        ORDER BY memory_id";
    let row = |id: &str, primary: &str, all: &[&str]| -> Categories {
        (
            id.to_string(),
            primary.to_string(),
            all.iter().map(|c| c.to_string()).collect(),
        )
    };
    let backfill: Vec<Categories> = query_as(categories).fetch_all(&pool).await.unwrap();
    assert_eq!(
        backfill,
        vec![
            row("mem_archived", "health_context", &["health_context"]),
            row(
                "mem_lesson",
                "hcp-custom:task_lessons",
                &["hcp-custom:task_lessons"]
            ),
            row("mem_work", "work_context", &["work_context"]),
        ]
    );

    for invalid in [
        "UPDATE cloud_account_memories SET categories = '{}' WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = ARRAY['work_context', 'health_context', \
           'location_context', 'general_preferences'] WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = ARRAY['work_context', 'diary'] \
           WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = ARRAY['work_context', 'work_context'] \
           WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = ARRAY['work_context', 'health_context', \
           'health_context'] WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = ARRAY['work_context', NULL] \
           WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = '[0:1]={work_context,health_context}' \
           WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = ARRAY['health_context', 'work_context'] \
           WHERE memory_id = 'mem_work'",
        "UPDATE cloud_account_memories SET categories = NULL WHERE memory_id = 'mem_work'",
    ] {
        assert!(
            sqlx_core::raw_sql::raw_sql(invalid)
                .execute(&pool)
                .await
                .is_err(),
            "{invalid}"
        );
    }

    // The current server writes both columns together.
    execute(
        &pool,
        "UPDATE cloud_account_memories SET category = 'work_context', \
           categories = ARRAY['work_context', 'health_context', 'location_context'] \
         WHERE memory_id = 'mem_work'",
    )
    .await;
    // An older server writes only the category: an insert gets that one
    // category, and a category change replaces only the primary.
    execute(
        &pool,
        "INSERT INTO cloud_account_memories \
           (memory_id, owner_account_id, scope, scope_id, source, text, category) VALUES \
           ('mem_old_insert', 'fixture-owner', 'global', 'account', 'manual', \
            'Prefers short replies', 'general_preferences'); \
         UPDATE cloud_account_memories SET category = 'coordination_context' \
           WHERE memory_id = 'mem_work'",
    )
    .await;
    let synced: Vec<Categories> = query_as(
        "SELECT memory_id, category, categories FROM cloud_account_memories \
         WHERE memory_id IN ('mem_work', 'mem_old_insert') ORDER BY memory_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        synced,
        vec![
            row(
                "mem_old_insert",
                "general_preferences",
                &["general_preferences"]
            ),
            row(
                "mem_work",
                "coordination_context",
                &["coordination_context", "health_context", "location_context"]
            ),
        ]
    );
    // An older server moving the primary to one of the others keeps it once.
    execute(
        &pool,
        "UPDATE cloud_account_memories SET category = 'location_context' \
         WHERE memory_id = 'mem_work'",
    )
    .await;
    let (moved,): (Vec<String>,) =
        query_as("SELECT categories FROM cloud_account_memories WHERE memory_id = 'mem_work'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(moved, ["location_context", "health_context"]);
}
