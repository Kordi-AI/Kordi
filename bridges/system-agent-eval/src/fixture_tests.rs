use super::*;

fn now() -> DateTime<Utc> {
    "2026-11-03T10:15:42Z".parse().unwrap()
}

#[test]
fn templates_resolve_against_the_replay_clock() {
    let text = "{{d+3:weekday}} {{d+3:long}} at {{d+3}}T19:00:00+00:00, reminder {{now+90m}}";
    assert_eq!(
        expand(text, now()).unwrap(),
        "Friday Friday, November 6 at 2026-11-06T19:00:00+00:00, reminder 2026-11-03T11:45:00+00:00"
    );
    assert!(expand("{{d+x}}", now()).is_err());
    assert!(expand("{{d+1", now()).is_err());
}

#[test]
fn every_fixture_in_the_repository_loads() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let fixtures = load_dir(&dir, now()).unwrap();
    let count = |kind| fixtures.iter().filter(|f| f.kind() == kind).count();
    assert!(count("systemAgent") >= 10);
    assert!(count("grounding") >= 2);
    assert!(count("groundingMatch") >= 80);
    // Every pass has a stub script, so the stub run covers every fixture.
    for fixture in &fixtures {
        match fixture {
            Fixture::SystemAgent(conversation) => {
                for turn in &conversation.turns {
                    assert!(!turn.stub.is_empty(), "{} lacks a stub", conversation.id);
                }
            }
            Fixture::Grounding(build) => {
                assert!(build.stub.is_some(), "{} lacks a stub", build.id)
            }
            Fixture::GroundingMatch(run) => assert!(!run.stub.is_empty()),
        }
    }
}

#[test]
fn unknown_members_and_actions_are_rejected() {
    let base = r#"{"kind":"systemAgent","id":"x","description":"d","title":"t",
        "members":[{"key":"a","name":"A"}],
        "turns":[{"messages":[{"from":"MSG","text":"hi","minutesAgo":2}],
        "expect":{"reply":"silent","allowedActions":["ACTION"]}}]}"#;
    assert!(parse(&base.replace("MSG", "a").replace("ACTION", "rsvp"), now()).is_ok());
    assert!(parse(&base.replace("MSG", "zed").replace("ACTION", "rsvp"), now()).is_err());
    assert!(parse(&base.replace("MSG", "a").replace("ACTION", "reopen"), now()).is_err());
}
