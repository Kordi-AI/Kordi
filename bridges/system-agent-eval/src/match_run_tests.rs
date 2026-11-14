use super::*;
use serde_json::json;

#[test]
fn the_baseline_differs_from_the_current_instructions_only_where_pr_2503_and_2546_changed_them() {
    let baseline = MatchPrompt::Baseline.text();
    let current = MatchPrompt::Current.text();
    let old: Vec<&str> = baseline.lines().collect();
    let new: Vec<&str> = current.lines().collect();
    let removed: Vec<&str> = old.iter().copied().filter(|l| !new.contains(l)).collect();
    let added: Vec<&str> = new.iter().copied().filter(|l| !old.contains(l)).collect();
    // #2546 caps each list at two, for shorter replies in large rooms.
    let (capped, reworded): (Vec<&str>, Vec<&str>) =
        removed.iter().partition(|line| line.contains("At most 3"));
    assert_eq!(capped.len(), 3, "{removed:#?}");
    assert_eq!(
        reworded,
        [
            "- why: one short reason per pair, under 14 words.",
            "- next_step: one concrete next step for the two of you, under 16 words. Empty when there is nothing in common.",
            "Copy topic labels exactly as written. Refer to people by name or \"you\", never by he, she, him or her.",
        ]
    );
    for line in &capped {
        assert!(added.contains(&line.replace("At most 3", "At most 2").as_str()));
    }
    assert_eq!(added.len(), 4 + 3, "{added:#?}");
    assert!(added
        .iter()
        .any(|line| line.contains("read the same to either person")));
    assert!(!baseline.contains("read the same to either person"));
    assert!(baseline.contains("Refer to people by name or \"you\""));
    assert!(!baseline.ends_with('\n'));
    assert_ne!(
        MatchPrompt::Baseline.info().sha256,
        MatchPrompt::Current.info().sha256
    );
    assert_eq!(MatchPrompt::parse("baseline"), Some(MatchPrompt::Baseline));
    assert_eq!(MatchPrompt::parse("old"), None);
}

/// Ada is the viewer of the only run: Ben is a strong overlap, Cy a hard
/// negative, Dee a strong complement and Eve a weak pair.
fn fixture() -> MatchFixture {
    let suite = json!({"kind": "groundingMatchSuite", "id": "t", "description": "d",
        "people": [
            {"id": "ada", "name": "Ada", "workingOn": ["Agent memory"], "interests": ["GPU kernels"],
             "canHelp": ["Study design"], "lookingFor": ["Retrieval backend"]},
            {"id": "ben", "name": "Ben", "workingOn": ["Memory for assistants"]},
            {"id": "cy", "name": "Cy", "workingOn": ["GPU memory"]},
            {"id": "dee", "name": "Dee", "workingOn": ["Field studies"], "canHelp": ["Retrieval engineering"]},
            {"id": "eve", "name": "Eve", "interests": ["Agents"]}],
        "pairs": [
            {"a": "ada", "b": "ben", "label": "strong", "kind": "overlap", "why": "w",
             "shared": [["Agent memory", "Memory for assistants"]]},
            {"a": "cy", "b": "ada", "label": "none", "kind": "hard_negative", "why": "w"},
            {"a": "ada", "b": "dee", "label": "strong", "kind": "complement", "why": "w",
             "trades": [["dee", "Retrieval engineering", "Retrieval backend"]]},
            {"a": "eve", "b": "ada", "label": "weak", "kind": "overlap", "why": "w"}],
        "rooms": [{"id": "r1", "members": ["ada", "ben", "cy", "dee", "eve"]}]});
    crate::match_suite::parse(&suite.to_string())
        .unwrap()
        .remove(0)
}

fn score(fixture: &MatchFixture, reply: &str) -> (MatchOutcome, Vec<Check>) {
    let outcome = MatchOutcome::from_reply(
        fixture,
        &match_run(fixture, MatchPrompt::Current),
        reply.into(),
    );
    let checks = score_match(fixture, &outcome);
    (outcome, checks)
}

fn failed(checks: &[Check]) -> Vec<String> {
    checks
        .iter()
        .filter(|check| !check.passed)
        .map(|check| {
            format!(
                "{}: {}",
                check.name,
                check.detail.clone().unwrap_or_default()
            )
        })
        .collect()
}

#[test]
fn the_stub_reply_passes_every_label_check() {
    let fixture = fixture();
    assert_eq!(fixture.id, "t-r1-ada-1");
    let (outcome, checks) = score(&fixture, &fixture.stub.clone());
    assert_eq!(failed(&checks), Vec::<String>::new());
    let names: Vec<&str> = checks.iter().map(|check| check.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "run completes",
            "reply becomes a match list",
            "strong overlap ben keeps a shared pair",
            "hard negative cy keeps nothing",
            "strong complement dee keeps a trade",
        ]
    );
    let findings = outcome.findings.unwrap();
    assert_eq!(findings[0].person, "ben");
    assert!(findings[0].score > 0 && findings[0].reads_for_either);
    assert_eq!(findings[0].reversed_score, findings[0].score);
    assert_eq!((findings[2].proposed, findings[2].kept), (1, 1));
}

#[test]
fn checks_catch_invented_pairs_missing_pairs_and_bad_replies() {
    let fixture = fixture();
    let reply = json!({"people": [
        {"person": 0, "shared": [], "next_step": ""},
        {"person": 1, "shared": [{"mine": "GPU kernels", "theirs": "GPU memory",
            "why": "Your GPU work fits"}], "next_step": "Meet"},
        {"person": 2, "you_bring": [{"topic": "Study design", "for": "Field studies",
            "why": "Helps your studies"}], "next_step": "Meet"}]})
    .to_string();
    let (outcome, checks) = score(&fixture, &reply);
    assert_eq!(
        failed(&checks),
        [
            "strong overlap ben keeps a shared pair: kept nothing",
            "hard negative cy keeps nothing: kept shared GPU kernels ~ GPU memory",
        ]
    );
    let findings = outcome.findings.unwrap();
    assert_eq!(findings[1].cause, Some(Cause::SecondPerson));
    assert!(!findings[1].reads_for_either);
    let (outcome, checks) = score(&fixture, r#"{"people":[]}"#);
    assert_eq!(outcome.rejected.as_deref(), Some("invalid_output"));
    assert_eq!(
        failed(&checks),
        ["reply becomes a match list: invalid_output"]
    );
    let errored = MatchOutcome {
        error: Some("timed out".into()),
        ..MatchOutcome::default()
    };
    assert_eq!(
        failed(&score_match(&fixture, &errored)),
        ["run completes: timed out"]
    );
}
