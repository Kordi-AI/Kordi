//! "Rebuild automatically" without a database: the due decision, the
//! settings body, the merge of an update's reply, and the owner view.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{json, Value};

use crate::common_ground::auto::{
    decide, merge, parse_update, removed, same_reference, user_prompt, AutoRebuildConfig,
    CardState, Decision, Hold, NewItem, SettingsRequest, StoredCard,
};
use crate::common_ground::card::{empty_view, CardRow, Evidence, Topics, ADDED_BY_YOU};
use crate::common_ground::profiles;

fn at(minutes: i64) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-09T10:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
        + Duration::minutes(minutes)
}

fn marked(first: i64, last: i64) -> CardState {
    CardState {
        auto_rebuild: true,
        built: true,
        dirty_since: Some(at(first)),
        last_change_at: Some(at(last)),
        manual_in_flight: false,
        auto_in_flight: false,
        updates_last_hour: 0,
        updates_last_day: 0,
        consent_allowed: true,
    }
}

#[test]
fn a_card_is_due_after_the_quiet_window_or_the_maximum_wait() {
    let config = AutoRebuildConfig::default();
    // Changed at 0; quiet for five minutes at 5.
    assert_eq!(decide(&marked(0, 0), at(4), &config), Decision::Wait(at(5)));
    assert_eq!(decide(&marked(0, 0), at(5), &config), Decision::Due);
    // A change at 4 restarts the quiet window.
    assert_eq!(decide(&marked(0, 4), at(6), &config), Decision::Wait(at(9)));
    // A conversation that keeps writing still lands after 30 minutes.
    assert_eq!(
        decide(&marked(0, 29), at(29), &config),
        Decision::Wait(at(30))
    );
    assert_eq!(decide(&marked(0, 29), at(30), &config), Decision::Due);
}

#[test]
fn caps_consent_and_runs_in_flight_hold_a_due_card() {
    let config = AutoRebuildConfig::default();
    let now = at(10);
    let hold = |change: fn(&mut CardState)| {
        let mut state = marked(0, 0);
        change(&mut state);
        decide(&state, now, &config)
    };
    assert_eq!(hold(|_| {}), Decision::Due);
    assert_eq!(
        hold(|s| s.updates_last_hour = 2),
        Decision::Hold(Hold::Capped)
    );
    assert_eq!(hold(|s| s.updates_last_hour = 1), Decision::Due);
    assert_eq!(
        hold(|s| s.updates_last_day = 12),
        Decision::Hold(Hold::Capped)
    );
    assert_eq!(
        hold(|s| s.consent_allowed = false),
        Decision::Hold(Hold::NoConsent)
    );
    // An automatic update never starts while a manual build is in flight,
    // even before the quiet window ends.
    assert_eq!(
        hold(|s| s.manual_in_flight = true),
        Decision::Hold(Hold::InFlight)
    );
    let mut early = marked(0, 9);
    early.manual_in_flight = true;
    assert_eq!(decide(&early, now, &config), Decision::Hold(Hold::InFlight));
    assert_eq!(
        hold(|s| s.auto_in_flight = true),
        Decision::Hold(Hold::InFlight)
    );
    assert!(Hold::InFlight.retry_in() < Hold::Capped.retry_in());
}

#[test]
fn a_card_without_the_setting_a_build_or_a_mark_is_cleared() {
    let config = AutoRebuildConfig::default();
    for change in [
        (|s: &mut CardState| s.auto_rebuild = false) as fn(&mut CardState),
        |s| s.built = false,
        |s| s.dirty_since = None,
    ] {
        let mut state = marked(0, 0);
        change(&mut state);
        assert_eq!(decide(&state, at(60), &config), Decision::Clear);
    }
}

#[test]
fn settings_bodies_name_sharing_auto_rebuild_or_both() {
    let parse = |body: Value| serde_json::from_value::<SettingsRequest>(body).unwrap();
    let sharing = parse(json!({"sharing": false}));
    assert_eq!((sharing.sharing, sharing.auto_rebuild), (Some(false), None));
    assert!(sharing.names_a_setting());
    let auto = parse(json!({"autoRebuild": true, "profileId": "cgp_1"}));
    assert_eq!((auto.sharing, auto.auto_rebuild), (None, Some(true)));
    assert_eq!(auto.profile_id.as_deref(), Some("cgp_1"));
    assert!(auto.names_a_setting());
    let both = parse(json!({"sharing": true, "autoRebuild": false}));
    assert_eq!((both.sharing, both.auto_rebuild), (Some(true), Some(false)));
    assert!(!parse(json!({})).names_a_setting());
    assert!(!parse(json!({"profileId": "cgp_1", "autoRebuild": null})).names_a_setting());
}

fn reference(id: &str, source: &str, title: &str) -> Evidence {
    Evidence {
        id: id.into(),
        source: source.into(),
        title: title.into(),
        date: Some("2026-10-01".into()),
        url: None,
        snippet: title.into(),
    }
}

fn new_memory(text: &str) -> NewItem {
    serde_json::from_value(json!({
        "source": "Memory", "title": text, "date": "2026-11-08", "url": null, "text": text,
    }))
    .unwrap()
}

/// A card with a memory topic, a hidden topic, a topic the owner typed and
/// a topic from notes, which the server cannot read again.
fn card() -> StoredCard {
    let mut refs = BTreeMap::new();
    refs.insert("Agent memory".to_string(), vec!["e1".into(), "e2".into()]);
    refs.insert("Old dashboard".to_string(), vec!["e2".into()]);
    refs.insert("Private project".to_string(), vec!["e2".into()]);
    refs.insert("Rust".to_string(), vec!["e3".into()]);
    refs.insert("Sensor design".to_string(), vec!["e4".into(), "e1".into()]);
    StoredCard {
        topics: Topics {
            working_on: vec!["Agent memory".into(), "Old dashboard".into()],
            interests: vec!["Private project".into(), "Sensor design".into()],
            can_help: vec!["Rust".into()],
            looking_for: vec![],
            earlier: vec![],
            refs,
        },
        evidence: vec![
            reference("e1", "Memory", "Leads the agent memory work"),
            reference("e2", "Memory", "Built a dashboard"),
            reference("e3", ADDED_BY_YOU, "Rust"),
            reference("e4", "Your words", "I design sensors"),
        ],
        hidden: vec!["Private project".into()],
    }
}

#[test]
fn an_update_adds_and_revises_topics_with_new_references() {
    let new = vec![
        new_memory("Started a retrieval benchmark"),
        new_memory("Mentors two interns on agent memory"),
    ];
    let update = parse_update(
        r#"Here: {"add":[{"list":"working_on","label":"Retrieval  benchmark","evidence":[0]},
             {"list":"interests","label":"agent memory","evidence":[1]},
             {"list":"nowhere","label":"Ignored","evidence":[0]},
             {"list":"can_help","label":"Unsupported","evidence":[7]}],
            "revise":[{"label":"Agent memory","evidence":[1],"remove":["e2"]}]}"#,
    )
    .unwrap();
    let merged = merge(&card(), &update, &new).unwrap();
    let topics = &merged.topics;
    assert_eq!(
        topics.working_on,
        vec!["Agent memory", "Old dashboard", "Retrieval benchmark"]
    );
    // "agent memory" is the existing topic: it gains evidence, not a twin.
    assert_eq!(topics.interests, vec!["Private project", "Sensor design"]);
    assert_eq!(topics.refs["Retrieval benchmark"], vec!["e5"]);
    assert_eq!(topics.refs["Agent memory"], vec!["e1", "e6"]);
    let e5 = merged.evidence.iter().find(|e| e.id == "e5").unwrap();
    assert_eq!(
        (e5.source.as_str(), e5.snippet.as_str()),
        ("Memory", "Started a retrieval benchmark")
    );
    // e2 still backs other topics, so it stays.
    assert!(merged.evidence.iter().any(|e| e.id == "e2"));
    assert_eq!(merged.hidden, vec!["Private project"]);
}

#[test]
fn an_update_keeps_hidden_typed_and_unreadable_topics() {
    let new = vec![new_memory("Stopped all side projects")];
    let update = parse_update(
        r#"{"drop":[{"label":"Private project","evidence":[0]},{"label":"Rust","evidence":[0]},
            {"label":"Sensor design","evidence":[0]},{"label":"Old dashboard","evidence":[0]},
            {"label":"Agent memory","evidence":[]}],
           "revise":[{"label":"Sensor design","evidence":[0],"remove":["e4","e1"]},
                     {"label":"Rust","evidence":[0],"remove":["e3"]}]}"#,
    )
    .unwrap();
    let merged = merge(&card(), &update, &new).unwrap();
    let topics = &merged.topics;
    // Only the memory-only topic with cited evidence is dropped.
    assert_eq!(topics.working_on, vec!["Agent memory"]);
    assert_eq!(topics.interests, vec!["Private project", "Sensor design"]);
    assert_eq!(topics.can_help, vec!["Rust"]);
    assert!(!topics.refs.contains_key("Old dashboard"));
    // The note stays; the memory reference beside it may go.
    assert_eq!(topics.refs["Sensor design"], vec!["e4", "e5"]);
    assert_eq!(topics.refs["Rust"], vec!["e3", "e5"]);
    let sources: Vec<&str> = merged.evidence.iter().map(|e| e.source.as_str()).collect();
    assert!(sources.contains(&ADDED_BY_YOU) && sources.contains(&"Your words"));
    assert_eq!(merged.hidden, vec!["Private project"]);
}

#[test]
fn a_removed_memory_only_takes_support_away() {
    let base = card();
    let gone = removed(&base.evidence[1]);
    let new = vec![gone];
    // Citing the removal as support adds nothing.
    let add = parse_update(r#"{"add":[{"list":"looking_for","label":"Help","evidence":[0]}]}"#);
    assert!(merge(&base, &add.unwrap(), &new).is_none());
    // Revising with it takes e2 off, but never a topic's last reference.
    let revise = parse_update(
        r#"{"revise":[{"label":"Agent memory","evidence":[0]},{"label":"Old dashboard","evidence":[0]}]}"#,
    )
    .unwrap();
    let merged = merge(&base, &revise, &new).unwrap();
    assert_eq!(merged.topics.refs["Agent memory"], vec!["e1"]);
    assert_eq!(merged.topics.refs["Old dashboard"], vec!["e2"]);
    // Dropping with it is allowed for a topic that only memory backs.
    let drop = parse_update(r#"{"drop":[{"label":"Old dashboard","evidence":[0]}]}"#).unwrap();
    let merged = merge(&base, &drop, &new).unwrap();
    assert!(!merged
        .topics
        .working_on
        .contains(&"Old dashboard".to_string()));
}

#[test]
fn an_update_that_changes_nothing_or_cannot_be_read_leaves_the_card() {
    let new = vec![new_memory("Had lunch")];
    let nothing = parse_update(r#"{"add":[],"revise":[],"drop":[]}"#).unwrap();
    assert!(merge(&card(), &nothing, &new).is_none());
    let same = parse_update(r#"{"revise":[{"label":"Agent memory","evidence":[]}]}"#).unwrap();
    assert!(merge(&card(), &same, &new).is_none());
    assert!(parse_update("no json here").is_none());
    assert!(parse_update(r#"{"add": "everything"}"#).is_none());
}

#[test]
fn an_update_that_only_restates_references_changes_nothing() {
    // The memory behind e1, saved again: a newer date, the same text.
    let again = new_memory("Leads the agent memory work");
    let base = card();
    assert!(same_reference(&base.evidence[0], &again.item));
    assert!(!same_reference(&base.evidence[1], &again.item));
    let new = vec![again];
    let restated = parse_update(
        r#"{"revise":[{"label":"Agent memory","evidence":[0]},{"label":"Sensor design","evidence":[0]}],
            "add":[{"list":"working_on","label":"agent memory","evidence":[0]}]}"#,
    )
    .unwrap();
    assert!(merge(&base, &restated, &new).is_none());
    // Citing it for another topic is a change, with the reference it has.
    let moved = parse_update(r#"{"revise":[{"label":"Old dashboard","evidence":[0]}]}"#).unwrap();
    let merged = merge(&base, &moved, &new).unwrap();
    assert_eq!(merged.topics.refs["Old dashboard"], vec!["e2", "e1"]);
    assert_eq!(merged.evidence.len(), base.evidence.len());
}

#[test]
fn the_update_prompt_shows_the_card_and_only_new_evidence() {
    let profile = profiles::for_tests("work", "Work", None);
    let base = card();
    let new = vec![
        new_memory("Started a benchmark"),
        removed(&base.evidence[1]),
    ];
    let prompt = user_prompt("2026-11-09", &profile, &base.topics, &base.evidence, &new);
    assert!(prompt.contains("- Agent memory (e1, e2)"));
    assert!(prompt.contains("(e4) 2026-10-01 · Your words · I design sensors"));
    assert!(prompt.contains("[0] 2026-11-08 · Memory · Started a benchmark"));
    assert!(prompt.contains("[1] 2026-10-01 · Removed memory (was e2) · Built a dashboard"));
}

fn row(built: bool, auto_updating: bool) -> CardRow {
    CardRow {
        topics: card().topics,
        evidence: card().evidence,
        hidden: vec![],
        sharing: true,
        revision: 3,
        built_at: built.then(Utc::now),
        building: false,
        error_code: None,
        unread_links: vec![],
        auto_rebuild: true,
        auto_updating,
        caught_up_at: None,
    }
}

#[test]
fn the_owner_view_carries_the_setting_and_stays_idle_while_updating() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
    let view = row(true, true).owner_view(today);
    assert_eq!(view["autoRebuild"], true);
    assert_eq!(view["autoUpdating"], true);
    assert_eq!(view["build"]["status"], "idle");
    assert_eq!(view["build"]["errorCode"], Value::Null);
    let view = row(false, false).owner_view(today);
    assert_eq!(view["card"], Value::Null);
    assert_eq!(
        (view["autoRebuild"].clone(), view["autoUpdating"].clone()),
        (json!(true), json!(false))
    );
    let empty = empty_view();
    assert_eq!(
        (empty["autoRebuild"].clone(), empty["autoUpdating"].clone()),
        (json!(false), json!(false))
    );
}

#[test]
fn new_items_round_trip_as_stored_with_the_run() {
    let base = card();
    let items = vec![new_memory("A"), removed(&base.evidence[0])];
    let stored = serde_json::to_value(&items).unwrap();
    assert_eq!(stored[0].get("retracts"), None);
    assert_eq!(stored[1]["retracts"], "e1");
    let back: Vec<NewItem> = serde_json::from_value(stored).unwrap();
    assert_eq!(back, items);
}
