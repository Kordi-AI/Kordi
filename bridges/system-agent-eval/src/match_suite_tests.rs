use super::*;
use serde_json::Value;

fn suite_text(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/grounding-match")
        .join(name);
    std::fs::read_to_string(path).unwrap()
}

fn suite(name: &str) -> Suite {
    let SuiteFile::GroundingMatchSuite(suite) = serde_json::from_str(&suite_text(name)).unwrap();
    suite
}

/// The lab's personas file stays the single source of the synthetic people:
/// the suite repeats its people, cards, labelled pairs and rooms exactly.
#[test]
fn the_lab_suite_matches_the_lab_personas() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../experiments/common-ground-lab/fixtures/personas.json");
    let lab: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let suite = suite("lab.json");
    let personas = lab["personas"].as_array().unwrap();
    assert_eq!(suite.people.len(), personas.len());
    let list = |value: &Value| -> Vec<String> {
        serde_json::from_value(value.clone()).unwrap_or_default()
    };
    for (person, persona) in suite.people.iter().zip(personas) {
        let card = &persona["card"];
        let expected = Person {
            id: persona["id"].as_str().unwrap().into(),
            name: persona["name"].as_str().unwrap().into(),
            working_on: list(&card["working_on"]),
            interests: list(&card["interests"]),
            can_help: list(&card["can_help"]),
            looking_for: list(&card["looking_for"]),
        };
        assert_eq!(person, &expected);
    }
    let pairs = lab["pairs"].as_array().unwrap();
    assert_eq!(suite.pairs.len(), pairs.len());
    for (pair, expected) in suite.pairs.iter().zip(pairs) {
        let actual = json!({"a": pair.a, "b": pair.b, "label": pair.label,
            "kind": pair.kind, "why": pair.why});
        let expected = json!({"a": expected["a"], "b": expected["b"], "label": expected["label"],
            "kind": expected["kind"], "why": expected["why"]});
        assert_eq!(actual, expected);
    }
    let rooms = lab["rooms"].as_array().unwrap();
    assert_eq!(suite.rooms.len(), rooms.len());
    for (room, expected) in suite.rooms.iter().zip(rooms) {
        assert_eq!(room.id, expected["id"].as_str().unwrap());
        assert_eq!(room.members, list(&expected["members"]));
    }
}

#[test]
fn every_strong_pair_has_gold_and_only_strong_pairs_do() {
    for name in ["lab.json", "names.json"] {
        for pair in suite(name).pairs {
            let gold = !pair.shared.is_empty() || !pair.trades.is_empty();
            assert_eq!(
                gold,
                pair.label == Strength::Strong,
                "{}-{}",
                pair.a,
                pair.b
            );
        }
    }
}

#[test]
fn rooms_expand_into_batches_of_eight_and_labelled_pairs_run_both_ways() {
    let suite = suite("lab.json");
    let runs = expand(&suite).unwrap();
    assert_eq!(runs, expand(&suite).unwrap(), "loading is deterministic");
    let first = &runs[0];
    assert_eq!(first.id, "match-lab-r1-p01-1");
    assert_eq!(first.room.as_deref(), Some("r1"));
    let ids = |people: &[Person]| people.iter().map(|p| p.id.clone()).collect::<Vec<_>>();
    assert_eq!(
        ids(&first.others),
        ["p02", "p03", "p04", "p05", "p06", "p07", "p17", "p18"]
    );
    assert_eq!(ids(&runs[1].others), ["p19", "p15", "p25"]);
    assert_eq!(runs[1].id, "match-lab-r1-p01-2");
    let room_runs = runs.iter().filter(|run| run.room.is_some()).count();
    assert_eq!(room_runs, 2 * 12 * 2);
    let mut seen: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut unique = BTreeSet::new();
    for run in &runs {
        assert!(unique.insert(run.id.clone()), "{} repeats", run.id);
        assert!(!run.others.is_empty() && run.others.len() <= MATCH_BATCH);
        assert_eq!(run.labels.len(), run.others.len());
        for other in &run.others {
            *seen
                .entry((run.viewer.id.clone(), other.id.clone()))
                .or_default() += 1;
        }
    }
    for pair in &suite.pairs {
        for key in [
            (pair.a.clone(), pair.b.clone()),
            (pair.b.clone(), pair.a.clone()),
        ] {
            assert_eq!(seen.get(&key), Some(&1), "{key:?}");
        }
    }
    // Maya (p01, room r1) also has labelled pairs with Sana (p23, room r2)
    // and Clara (p27, in no room).
    let extra = runs
        .iter()
        .find(|run| run.id == "match-lab-pairs-p01-1")
        .unwrap();
    assert_eq!(ids(&extra.others), ["p23", "p27"]);
    let label = |strength, kind| Some(Label { strength, kind });
    assert_eq!(
        extra.labels,
        [
            label(Strength::None, PairKind::HardNegative),
            label(Strength::Strong, PairKind::Complement)
        ]
    );
}

#[test]
fn stub_replies_give_the_gold_pairs_from_the_viewers_side() {
    let runs = expand(&suite("lab.json")).unwrap();
    // Priya (p03) is "b" in her pair with Maya and receives Tomas's trade.
    let run = runs
        .iter()
        .find(|run| run.id == "match-lab-r1-p03-1")
        .unwrap();
    let reply: Value = serde_json::from_str(&run.stub).unwrap();
    let people = reply["people"].as_array().unwrap();
    assert_eq!(people.len(), run.others.len());
    let entry = |id: &str| {
        let index = run.others.iter().position(|p| p.id == id).unwrap();
        &people[index]
    };
    assert_eq!(
        entry("p01")["shared"][0],
        json!({"mine": "Editable agent memory interfaces",
            "theirs": "Long-term memory for personal agents", "why": SHARED_WHY})
    );
    assert_eq!(entry("p01")["next_step"], NEXT_STEP);
    assert_eq!(
        entry("p02")["they_bring"][0]["topic"],
        "Retrieval index engineering"
    );
    assert_eq!(entry("p02")["you_bring"][0]["topic"], "Interview studies");
    // A weak pair and an unlabelled person get empty lists.
    assert_eq!(
        entry("p18"),
        &json!({"person": 7, "shared": [], "you_bring": [], "they_bring": [], "next_step": ""})
    );
    assert_eq!(entry("p05")["shared"], json!([]));
}

#[test]
fn gold_pairs_must_survive_the_servers_checks() {
    let base = r#"{"kind": "groundingMatchSuite", "id": "s", "description": "d",
        "people": [
          {"id": "a", "name": "A", "workingOn": ["Agent memory"], "canHelp": ["Study design"]},
          {"id": "b", "name": "B", "interests": ["Memory for agents"], "lookingFor": ["Studies"]}],
        "pairs": [{"a": "a", "b": "b", "label": "strong", "kind": "KIND", "why": "w", GOLD}]}"#;
    let load = |kind: &str, gold: &str| parse(&base.replace("KIND", kind).replace("GOLD", gold));
    let shared = r#""shared": [["Agent memory", "Memory for agents"]]"#;
    let trade = r#""trades": [["a", "Study design", "Studies"]]"#;
    assert_eq!(load("overlap", shared).unwrap().len(), 2);
    assert!(load("complement", trade).is_ok());
    assert!(
        load("complement", shared).is_err(),
        "a complement needs a trade"
    );
    assert!(load("overlap", r#""shared": [["Agent memory", "Studies"]]"#).is_err());
    assert!(load(
        "complement",
        r#""trades": [["b", "Study design", "Agent memory"]]"#
    )
    .is_err());
    assert!(load(
        "complement",
        r#""trades": [["a", "Study design", "Agent  memory"]]"#
    )
    .is_err());
    assert!(load("unrelated", shared).is_err());
}
