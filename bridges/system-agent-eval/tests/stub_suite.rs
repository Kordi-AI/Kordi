//! The harness itself, driven by the scripted stub model. Grounding builds
//! and match runs need no database and run in every CI pass; the System
//! agent fixtures need a local PostgreSQL server, where each test creates and
//! drops its own database, and run where CI provides one.

use kordi_system_agent_eval::database::DisposableDatabase;
use kordi_system_agent_eval::fixture::{self, Fixture};
use kordi_system_agent_eval::match_run::MatchPrompt;
use kordi_system_agent_eval::match_suite::SHARED_WHY;
use kordi_system_agent_eval::replay::Engine;
use kordi_system_agent_eval::report::RunReport;
use kordi_system_agent_eval::report_numbers::Number;
use kordi_system_agent_eval::setup;
use serde_json::json;

fn fixtures(kind: &str) -> Vec<Fixture> {
    fixture::load_dir(
        &kordi_system_agent_eval::default_fixture_dir(),
        chrono::Utc::now(),
    )
    .unwrap()
    .into_iter()
    .filter(|fixture| fixture.kind() == kind)
    .collect()
}

fn failures(report: &RunReport) -> Vec<String> {
    report
        .fixtures
        .iter()
        .flat_map(|fixture| {
            fixture
                .passes
                .iter()
                .enumerate()
                .flat_map(move |(index, pass)| {
                    pass.checks
                        .iter()
                        .filter(|check| !check.passed)
                        .map(move |check| {
                            format!(
                                "{} / pass {} / {}: {}",
                                fixture.id,
                                index + 1,
                                check.name,
                                check.detail.clone().unwrap_or_default()
                            )
                        })
                })
        })
        .collect()
}

#[tokio::test]
async fn grounding_fixtures_pass_with_the_stub_model() {
    let settings = setup::stub_settings();
    let config = settings.pending.unprovisioned();
    let fixtures = fixtures("grounding");
    let report = setup::run_suite(
        "stub",
        &fixtures,
        &config,
        None,
        Engine::Stub,
        None,
        chrono::Utc::now(),
    )
    .await
    .unwrap();
    assert_eq!(failures(&report), Vec::<String>::new());
    assert_eq!(report.summary.fixtures.passed, fixtures.len());
    assert!(report.summary.metrics["grounding"].total >= 8);
}

async fn match_with_stub(fixtures: &[Fixture], repeat: usize) -> RunReport {
    let settings = setup::stub_settings();
    let options = setup::RunOptions {
        repeat,
        match_prompt: MatchPrompt::Current,
        prices: None,
        now: chrono::Utc::now(),
    };
    setup::run_suite_with(
        "stub-match",
        fixtures,
        &settings.pending.unprovisioned(),
        None,
        Engine::Stub,
        &options,
    )
    .await
    .unwrap()
}

fn number<'a>(report: &'a RunReport, name: &str) -> &'a Number {
    report
        .summary
        .numbers
        .iter()
        .find(|number| number.name == name)
        .unwrap_or_else(|| panic!("no {name} in {:#?}", report.summary.numbers))
}

#[tokio::test]
async fn match_fixtures_pass_with_the_stub_model_on_every_repeat() {
    let fixtures = fixtures("groundingMatch");
    let report = match_with_stub(&fixtures, 2).await;
    assert_eq!(failures(&report), Vec::<String>::new());
    assert_eq!(report.summary.fixtures.passed, fixtures.len());
    assert!(report
        .fixtures
        .iter()
        .all(|fixture| fixture.passes.len() == 2));
    assert!(report.summary.metrics["groundingMatch"].total >= 2 * 150);
    assert_eq!(
        report
            .match_prompt
            .as_ref()
            .map(|prompt| prompt.name.as_str()),
        Some("current")
    );
    // The stub gives every strong pair its gold pairs and nobody else anything.
    for name in [
        "match-lab/auc_strong_vs_none",
        "match-lab/top3_hit_rate",
        "match-lab/either_person_rate",
        "match-names/either_person_rate",
        "match-lab/direction_shared_jaccard",
    ] {
        let number = number(&report, name);
        assert_eq!(number.per_repeat, vec![1.0, 1.0], "{name}");
    }
    assert_eq!(number(&report, "match-lab/dropped_pair_rate").value, 0.0);
    assert_eq!(number(&report, "match-lab/top3_none_count").value, 0.0);
    assert_eq!(
        number(&report, "match-lab/direction_score_difference").value,
        0.0
    );
}

fn set_match_stub(fixtures: &mut [Fixture], id: &str, edit: impl FnOnce(&mut String, &[String])) {
    for fixture in fixtures {
        if let Fixture::GroundingMatch(run) = fixture {
            if run.id == id {
                let others: Vec<String> = run.others.iter().map(|p| p.id.clone()).collect();
                edit(&mut run.stub, &others);
                return;
            }
        }
    }
    panic!("no fixture {id}");
}

#[tokio::test]
async fn scoring_catches_a_match_model_that_misbehaves() {
    let ids = [
        "match-lab-r1-p15-1",
        "match-lab-r1-p01-1",
        "match-lab-r2-p09-1",
    ];
    let mut fixtures: Vec<Fixture> = fixtures("groundingMatch")
        .into_iter()
        .filter(|fixture| ids.contains(&fixture.id()))
        .collect();
    // Dmitri's GPU memory work is a hard negative for Maya's agent memory.
    set_match_stub(&mut fixtures, ids[0], |stub, others| {
        let maya = others.iter().position(|id| id == "p01").unwrap();
        *stub = json!({"people": [{"person": maya, "shared": [{
            "mine": "GPU memory optimization for training",
            "theirs": "Long-term memory for personal agents", "why": "Both work on memory"}],
            "next_step": "Compare memory notes"}]})
        .to_string();
    });
    // Every reason for Maya's strong partners addresses the reader.
    set_match_stub(&mut fixtures, ids[1], |stub, _| {
        *stub = stub.replace(SHARED_WHY, "Helps your research");
    });
    // A reply that names nobody fails the run.
    set_match_stub(&mut fixtures, ids[2], |stub, _| {
        *stub = json!({"people": []}).to_string();
    });
    let report = match_with_stub(&fixtures, 1).await;
    let failed = failures(&report);
    let has = |needle: &str| failed.iter().any(|failure| failure.contains(needle));
    assert!(
        has("match-lab-r1-p15-1 / pass 1 / hard negative p01 keeps nothing: kept shared"),
        "{failed:#?}"
    );
    assert!(
        has("match-lab-r2-p09-1 / pass 1 / reply becomes a match list: invalid_output"),
        "{failed:#?}"
    );
    assert!(
        !failed
            .iter()
            .any(|failure| failure.starts_with("match-lab-r1-p01-1")),
        "wording alone fails no check: {failed:#?}"
    );
    let rate = number(&report, "match-lab/either_person_rate").value;
    assert!(rate < 1.0, "{rate}");
    assert!(number(&report, "match-lab/either_person_second_person_rate").value > 0.0);
    assert_eq!(
        number(&report, "match-lab/either_person_name_rate").value,
        0.0
    );
    // The invented pair is kept and counts against the hard negative.
    assert!(number(&report, "match-lab/auc_strong_vs_none").value < 1.0);
}

fn server_url() -> String {
    std::env::var(setup::DATABASE_URL_VAR).expect("database URL")
}

/// Replays `fixtures` with the stub model into a new database, which is
/// dropped before the caller asserts anything.
async fn replay_with_stub(label: &str, fixtures: &[Fixture]) -> RunReport {
    let database = DisposableDatabase::prepare(&server_url())
        .await
        .expect("quality test server");
    let settings = setup::stub_settings();
    let result = async {
        let pool = database.create().await?;
        let harness = setup::harness(pool, settings.pending, Engine::Stub).await?;
        setup::run_suite(
            label,
            fixtures,
            &harness.config,
            Some(&harness),
            Engine::Stub,
            None,
            chrono::Utc::now(),
        )
        .await
    }
    .await;
    assert!(database.drop_database().await, "dropping the database");
    result.unwrap()
}

async fn database_exists(admin: &sqlx_postgres::PgPool, name: &str) -> bool {
    sqlx_core::query_scalar::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)",
    )
    .bind(name)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a local PostgreSQL server in KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL"]
async fn each_run_gets_its_own_database_and_drops_it() {
    let url = server_url();
    let admin = sqlx_postgres::PgPool::connect(&url).await.unwrap();
    let database = DisposableDatabase::prepare(&url).await.unwrap();
    let name = database.name().to_string();
    assert!(name.starts_with("kordi_eval_"), "{name}");
    assert!(
        !database_exists(&admin, &name).await,
        "prepare creates nothing"
    );
    let pool = database.create().await.unwrap();
    assert!(database_exists(&admin, &name).await);
    let (current, migrated): (String, i64) = sqlx_core::query_as::query_as(
        "SELECT current_database(), (SELECT count(*) FROM cloud_schema_versions)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(current, name);
    assert!(migrated > 0);
    // The named database is only an administration connection.
    let touched: bool = sqlx_core::query_scalar::query_scalar(
        "SELECT to_regclass('cloud_schema_versions') IS NOT NULL",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(!touched, "the server URL's own database was migrated");
    // The run's pool is closed first; dropping twice is harmless.
    let again = database.clone();
    assert!(database.drop_database().await);
    assert!(pool.is_closed());
    assert!(!database_exists(&admin, &name).await);
    // A database that was never created drops cleanly too.
    let never = DisposableDatabase::prepare(&url).await.unwrap();
    assert!(never.drop_database().await);
    drop(again);
    admin.close().await;
}

#[tokio::test]
#[ignore = "requires a local PostgreSQL server in KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL"]
async fn system_agent_fixtures_pass_with_the_stub_model() {
    let fixtures = fixtures("systemAgent");
    let report = replay_with_stub("stub", &fixtures).await;
    assert_eq!(failures(&report), Vec::<String>::new());
    let summary = &report.summary;
    assert_eq!(summary.fixtures.passed, fixtures.len());
    // The semantic pass reads small talk and stays silent. Messages owned by
    // other agents and already handled card events still skip the model.
    assert_eq!(summary.skipped_by_sweep, 3, "{summary:?}");
    for metric in [
        "planCard",
        "silence",
        "reply",
        "toolValidity",
        "workflow",
        "repetition",
        "reliability",
        "sweep",
    ] {
        assert!(
            summary.metrics[metric].total > 0,
            "{metric} was never checked"
        );
    }
}

fn set_stub(fixtures: &mut [Fixture], id: &str, turn: usize, stub: serde_json::Value) {
    for fixture in fixtures {
        if let Fixture::SystemAgent(conversation) = fixture {
            if conversation.id == id {
                conversation.turns[turn].stub = serde_json::from_value(stub).unwrap();
                return;
            }
        }
    }
    panic!("no fixture {id}");
}

#[tokio::test]
#[ignore = "requires a local PostgreSQL server in KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL"]
async fn scoring_catches_a_model_that_misbehaves() {
    let mut fixtures: Vec<Fixture> = fixtures("systemAgent")
        .into_iter()
        .filter(|fixture| {
            [
                "silent-past-recap",
                "repeat-temptation",
                "deal-across-two-passes",
                "reschedule-confirmed-plan",
            ]
            .contains(&fixture.id())
        })
        .collect();
    let speak = |text: &str| json!([{"final": {"message": text, "hooksHandled": []}}]);
    set_stub(
        &mut fixtures,
        "silent-past-recap",
        0,
        speak("Want me to plan another dinner?"),
    );
    set_stub(
        &mut fixtures,
        "repeat-temptation",
        0,
        speak(
            "Two days are on the table, so I opened a vote. Vote on the card so we can lock it in.",
        ),
    );
    set_stub(
        &mut fixtures,
        "deal-across-two-passes",
        1,
        json!([{"final": {"message": "Confirmed.", "hooksHandled": [],
            "planCard": {"action": "confirm", "eventId": "$eventId", "revision": "$revision",
                "confirmedBy": "$member:maya"}}}]),
    );
    // A second card instead of revising the confirmed one.
    set_stub(
        &mut fixtures,
        "reschedule-confirmed-plan",
        0,
        json!([{"final": {"message": null, "hooksHandled": [],
            "planCard": {"action": "propose", "conversationId": "$conversationId",
                "title": "Dinner at Luigi's", "state": "awaitingConfirmation",
                "participants": "$participants:maya", "sourceMessageIds": "$newMessageIds"}}}]),
    );
    let report = replay_with_stub("misbehaving", &fixtures).await;
    let failed = failures(&report);
    let has = |needle: &str| failed.iter().any(|failure| failure.contains(needle));
    assert!(
        has("silent-past-recap / pass 1 / stays silent"),
        "{failed:#?}"
    );
    assert!(
        has("repeat-temptation / pass 1 / does not repeat an earlier message"),
        "{failed:#?}"
    );
    assert!(
        has("deal-across-two-passes / pass 2 / plan_card confirm is expected and accepted"),
        "{failed:#?}"
    );
    assert!(
        has("reschedule-confirmed-plan / pass 1 / starts at"),
        "{failed:#?}"
    );
    assert_eq!(report.summary.fixtures.passed, 0);
}
