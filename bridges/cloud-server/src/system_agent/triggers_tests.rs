use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};

use super::super::conflicts::{find_conflict, CardFact};
use super::super::loops::{find_loop, ExchangeFact, LOOP_ROUNDS, REPEATS};
use super::super::ownership_store::Gate;
use super::*;

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-09T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn quiet_for(minutes: i64) -> Gate {
    Gate {
        last_human_at: Some(now() - Duration::minutes(minutes)),
        first_new_human_at: Some(now() - Duration::minutes(minutes)),
        ..Gate::default()
    }
}

fn facts<'a>(gate: &'a Gate, hooks_fired: &'a Value) -> PassFacts<'a> {
    PassFacts {
        now: now(),
        silence: Duration::minutes(10),
        seen_sequence: 4,
        hooks_fired,
        hooks: vec!["new_messages".to_string()],
        plan_talk: true,
        asks_system_agent: false,
        gate,
        newest_card_created_at: None,
        found_loop: None,
        found_conflict: None,
        requests_only: false,
    }
}

fn finding(kind: &str) -> Finding {
    Finding {
        detail: json!({"kind": kind}),
        marks: json!({ format!("{kind}:key"): true }),
        ask: None,
    }
}

#[test]
fn plan_talk_waits_for_silence_then_runs_once_from_its_first_message() {
    let talking = quiet_for(1);
    let empty = json!({});
    let held = decide(facts(&talking, &empty));
    assert!(held.run.is_none(), "people are still talking");
    let stored = held.patch[DISCUSSION_KEY].clone();
    assert_eq!(stored["fromSequence"], 4);
    let discussion = PlanDiscussion::read(&json!({ DISCUSSION_KEY: stored.clone() })).unwrap();
    assert_eq!(discussion.check_after, now() + Duration::minutes(9));

    // Later passes keep the first message; quiet long enough, it runs.
    let hooks_fired = json!({ DISCUSSION_KEY: stored });
    let quiet = quiet_for(12);
    let mut later = facts(&quiet, &hooks_fired);
    later.seen_sequence = 9;
    later.plan_talk = false;
    later.hooks.clear();
    let plan = decide(later);
    match plan.run {
        Some(Trigger::Silence { from_sequence, .. }) => assert_eq!(from_sequence, 4),
        other => panic!("expected a silence run, got {other:?}"),
    }
    assert_eq!(plan.marks[DISCUSSION_KEY], Value::Null, "fires once");
    assert!(!plan.patch.contains_key(DISCUSSION_KEY));
}

#[test]
fn a_new_message_from_a_person_pushes_the_silence_back() {
    let hooks_fired = json!({ DISCUSSION_KEY: {
        "fromSequence": 4, "since": now() - Duration::minutes(20),
        "checkAfter": now() - Duration::seconds(1)} });
    let talking = quiet_for(3);
    let mut pass = facts(&talking, &hooks_fired);
    pass.plan_talk = false;
    let plan = decide(pass);
    assert!(plan.run.is_none());
    let discussion = PlanDiscussion::read(&Value::Object(plan.patch)).unwrap();
    assert_eq!(discussion.from_sequence, 4);
    assert_eq!(discussion.check_after, now() + Duration::minutes(7));
}

#[test]
fn an_agent_task_a_card_or_an_agent_reply_resolves_the_discussion() {
    let hooks_fired = json!({ DISCUSSION_KEY: {
        "fromSequence": 4, "since": now() - Duration::minutes(20), "checkAfter": now()} });
    let owned = Gate {
        agent_task: true,
        agent_busy: true,
        ..quiet_for(15)
    };
    let mut pass = facts(&owned, &hooks_fired);
    pass.plan_talk = false;
    let plan = decide(pass);
    assert!(plan.run.is_none(), "an agent owns the task");
    assert_eq!(plan.patch[DISCUSSION_KEY], Value::Null);

    let quiet = quiet_for(15);
    let mut carded = facts(&quiet, &hooks_fired);
    carded.newest_card_created_at = Some(now() - Duration::minutes(5));
    assert!(decide(carded).run.is_none(), "a card covers it");

    let replied = Gate {
        newest_agent_sequence: Some(6),
        ..quiet_for(15)
    };
    let mut pass = facts(&replied, &hooks_fired);
    pass.plan_talk = false;
    assert!(decide(pass).run.is_none(), "an agent took it up");
}

#[test]
fn a_working_agent_postpones_every_trigger_except_its_own_stall() {
    let busy = Gate {
        agent_busy: true,
        ..quiet_for(15)
    };
    let empty = json!({});
    let mut pass = facts(&busy, &empty);
    pass.found_loop = Some(finding("loop"));
    pass.found_conflict = Some(finding("conflict"));
    pass.asks_system_agent = true;
    let plan = decide(pass);
    assert!(plan.run.is_none());
    assert!(
        plan.patch[CHECK_AFTER_KEY].is_string(),
        "checked again soon"
    );

    let stalled = Gate {
        stepping_in: true,
        agent_task: true,
        ..quiet_for(15)
    };
    assert_eq!(decide(facts(&stalled, &empty)).run, Some(Trigger::Stall));
}

#[test]
fn loops_come_before_conflicts_and_the_other_waits_for_the_next_pass() {
    let quiet = quiet_for(1);
    let empty = json!({});
    let mut pass = facts(&quiet, &empty);
    pass.found_loop = Some(finding("loop"));
    pass.found_conflict = Some(finding("conflict"));
    let plan = decide(pass);
    assert_eq!(plan.run, Some(Trigger::Loop(finding("loop"))));
    assert_eq!(plan.marks["loop:key"], true);
    assert!(plan.patch[CHECK_AFTER_KEY].is_string());
    // Plan talk still waits for its own silence.
    assert!(plan.patch[DISCUSSION_KEY].is_object());

    let waited = json!({ CHECK_AFTER_KEY: now() });
    let mut pass = facts(&quiet, &waited);
    pass.plan_talk = false;
    pass.found_conflict = Some(finding("conflict"));
    let plan = decide(pass);
    assert_eq!(plan.run, Some(Trigger::Conflict(finding("conflict"))));
    assert_eq!(plan.patch[CHECK_AFTER_KEY], Value::Null);
}

#[test]
fn card_hooks_and_direct_requests_still_wake_the_system_agent() {
    let talking = quiet_for(1);
    let empty = json!({});
    let mut pass = facts(&talking, &empty);
    pass.hooks.push("card_changed".to_string());
    let plan = decide(pass);
    assert_eq!(plan.run, Some(Trigger::Cards));
    assert!(
        plan.patch[DISCUSSION_KEY].is_object(),
        "plan talk still waits"
    );

    let mut asked = facts(&talking, &empty);
    asked.asks_system_agent = true;
    let plan = decide(asked);
    assert_eq!(plan.run, Some(Trigger::Request { rewind_to: Some(4) }));
    assert_eq!(plan.marks[DISCUSSION_KEY], Value::Null);
}

#[test]
fn a_grounding_group_wakes_the_system_agent_only_when_asked() {
    let quiet = quiet_for(15);
    let empty = json!({});
    let mut pass = facts(&quiet, &empty);
    pass.requests_only = true;
    pass.found_loop = Some(finding("loop"));
    pass.found_conflict = Some(finding("conflict"));
    let plan = decide(pass);
    assert_eq!(plan.run, None, "no silence, loop or conflict run");
    assert!(!plan.patch.contains_key(DISCUSSION_KEY), "nothing is held");
    assert!(!plan.patch.contains_key(CHECK_AFTER_KEY), "nothing waits");

    // A person's agent that stalled on a task someone gave it still gets help.
    let stalled = Gate {
        stepping_in: true,
        agent_task: true,
        ..quiet_for(15)
    };
    let mut pass = facts(&stalled, &empty);
    pass.requests_only = true;
    assert_eq!(decide(pass).run, Some(Trigger::Stall));

    let mut asked = facts(&quiet, &empty);
    asked.requests_only = true;
    asked.asks_system_agent = true;
    assert_eq!(
        decide(asked).run,
        Some(Trigger::Request { rewind_to: None })
    );
    let mut card = facts(&quiet, &empty);
    card.requests_only = true;
    card.hooks.push("card_changed".to_string());
    assert_eq!(decide(card).run, Some(Trigger::Cards));
}

#[test]
fn apply_names_the_trigger_and_keeps_chat_as_context_for_other_triggers() {
    let input = json!({
        "hooks": [{"name": "new_messages", "sinceSequence": 4}, {"name": "card_changed"}],
        "messages": [{"sequence": 5, "isNew": true}],
    });
    let mut silence = input.clone();
    let quiet = Duration::minutes(12);
    apply(
        &mut silence,
        &Trigger::Silence {
            from_sequence: 4,
            quiet,
        },
        Map::new(),
    );
    assert_eq!(
        silence["trigger"],
        json!({"kind": "silence", "quietMinutes": 12})
    );
    assert_eq!(silence["messages"][0]["isNew"], true);

    let mut conflict = input;
    let mut marks = Map::new();
    marks.insert("conflict:a|b".into(), json!(true));
    apply(
        &mut conflict,
        &Trigger::Conflict(finding("conflict")),
        marks,
    );
    assert_eq!(conflict["trigger"]["kind"], "conflict");
    assert_eq!(conflict["messages"][0]["isNew"], false);
    assert_eq!(conflict["hooks"].as_array().unwrap().len(), 1);
    let fired = finish_marks(&conflict);
    assert_eq!(fired, json!({"conflict:a|b": true}));
}

fn exchange(root: &str, from: &str, to: &str, minutes_ago: i64) -> ExchangeFact {
    ExchangeFact {
        root_run_id: root.to_string(),
        from_account: from.to_string(),
        from_agent: format!("{from}'s agent"),
        to_account: to.to_string(),
        to_agent: format!("{to}'s agent"),
        created_at: now() - Duration::minutes(minutes_ago),
    }
}

#[test]
fn rounds_between_the_same_agents_without_a_card_are_a_loop_once() {
    let rounds: Vec<ExchangeFact> = (0..LOOP_ROUNDS as i64)
        .map(|round| {
            let (from, to) = if round % 2 == 0 {
                ("a", "b")
            } else {
                ("b", "a")
            };
            exchange(&format!("root{round}"), from, to, 40 - round)
        })
        .collect();
    let found = find_loop(&rounds[..3], None, &[], &json!({}), 8);
    assert!(found.is_none(), "three rounds are still a conversation");
    let found = find_loop(&rounds, None, &[], &json!({}), 8).unwrap();
    assert_eq!(found.detail["reason"], "repeated_rounds");
    assert_eq!(found.detail["agents"], json!(["a's agent", "b's agent"]));
    let fired = found.marks.clone();
    assert!(find_loop(&rounds, None, &[], &fired, 8).is_none(), "once");
    let card_since = Some(now() - Duration::minutes(38));
    assert!(
        find_loop(&rounds, card_since, &[], &json!({}), 8).is_none(),
        "a card is progress"
    );
}

#[test]
fn a_task_at_its_request_limit_is_a_loop_once() {
    let rounds: Vec<ExchangeFact> = (0..8).map(|n| exchange("root", "a", "c", 30 - n)).collect();
    let found = find_loop(&rounds, None, &[], &json!({}), 8).unwrap();
    assert_eq!(found.detail["reason"], "request_limit");
    assert_eq!(found.detail["rounds"], 8);
    // Its rounds never count again as a loop between the same agents.
    assert!(find_loop(&rounds, None, &[], &found.marks, 8).is_none());
}

#[test]
fn near_identical_agent_messages_are_a_loop_once() {
    let message = |sequence: i64, text: &str| json!({"sequence": sequence, "fromAgent": true, "agentName": "Ana's agent", "text": text});
    let mut messages: Vec<Value> = (1..REPEATS as i64)
        .map(|n| {
            message(
                n,
                "Checking availability for Friday dinner with everyone now",
            )
        })
        .collect();
    messages.push(json!({"sequence": 20, "text": "Checking availability for Friday dinner"}));
    assert!(find_loop(&[], None, &messages, &json!({}), 8).is_none());
    messages.push(message(
        21,
        "Checking availability for Friday dinner with everyone",
    ));
    let found = find_loop(&[], None, &messages, &json!({}), 8).unwrap();
    assert_eq!(found.detail["reason"], "repeated_messages");
    assert_eq!(found.marks, json!({"loop:repeat": 21}));
    assert!(find_loop(&[], None, &messages, &found.marks, 8).is_none());
}

fn card(id: &str, title: &str, start_hours: Option<i64>, by_system_agent: bool) -> CardFact {
    CardFact {
        event_id: id.to_string(),
        title: title.to_string(),
        start_at: start_hours.map(|hours| now() + Duration::hours(hours)),
        end_at: None,
        created_at: now(),
        updated_at: now(),
        created_by: format!("acct_{id}"),
        by_system_agent,
    }
}

#[test]
fn overlapping_cards_and_one_plan_at_two_times_are_conflicts_once() {
    let overlap = [
        card("plan_b", "Team call", Some(30), false),
        card("plan_a", "Friday dinner", Some(30), true),
    ];
    let found = find_conflict(&overlap, &json!({})).unwrap();
    assert_eq!(found.detail["reason"], "overlap");
    assert_eq!(found.detail["cards"][0]["eventId"], "plan_a");
    assert_eq!(found.detail["cards"][0]["createdBySystemAgent"], true);
    assert_eq!(found.marks, json!({"conflict:plan_a|plan_b": true}));
    assert!(find_conflict(&overlap, &found.marks).is_none(), "once");

    let two_times = [
        card("plan_a", "Friday dinner", Some(30), true),
        card("plan_c", "Dinner on Friday", Some(33), false),
    ];
    let found = find_conflict(&two_times, &json!({})).unwrap();
    assert_eq!(found.detail["reason"], "different_times");

    let unrelated = [
        card("plan_a", "Friday dinner", Some(30), true),
        card("plan_d", "Book club", Some(34), false),
        card("plan_e", "Friday dinner", Some(80), false),
        card("plan_f", "Friday dinner", None, false),
    ];
    assert!(find_conflict(&unrelated, &json!({})).is_none());
}

fn step_in_input() -> Value {
    json!({
        "members": [
            {"participantId": "acct_bob", "handle": "@Bob", "agentHandle": "@KordiBob",
             "isSystemAgent": false},
            {"participantId": "acct_ana", "handle": "@Ana", "agentHandle": "@KordiAna",
             "isSystemAgent": false},
            {"participantId": "acct_system", "handle": "@System", "agentHandle": null,
             "isSystemAgent": true},
        ],
        "messages": [
            {"sequence": 3, "isNew": false, "senderId": "acct_ana"},
            {"sequence": 4, "isNew": true, "senderId": "acct_ana", "fromAgent": true},
            {"sequence": 5, "isNew": true, "senderId": "acct_bob"},
        ],
        "hooks": [],
    })
}

#[test]
fn every_step_in_names_whom_to_address() {
    let quiet = Duration::minutes(12);
    let mut silence = step_in_input();
    let trigger = Trigger::Silence {
        from_sequence: 3,
        quiet,
    };
    apply(&mut silence, &trigger, Map::new());
    assert_eq!(
        silence["trigger"]["ask"]["mention"], "@Bob",
        "first speaker"
    );

    let mut stall = step_in_input();
    stall["stepIn"] = json!({"agentName": "KordiAna", "ownerAccountId": "acct_ana"});
    apply(&mut stall, &Trigger::Stall, Map::new());
    assert_eq!(stall["trigger"]["ask"]["mention"], "@Ana");

    let mut looped = step_in_input();
    let found = Finding {
        ask: Some("acct_ana".to_string()),
        ..finding("loop")
    };
    apply(&mut looped, &Trigger::Loop(found.clone()), Map::new());
    assert_eq!(
        looped["trigger"]["ask"]["mention"], "@KordiAna",
        "the agent"
    );
    assert_eq!(looped["trigger"]["ask"]["handle"], "@Ana");

    let mut conflict = step_in_input();
    apply(&mut conflict, &Trigger::Conflict(found), Map::new());
    assert_eq!(conflict["trigger"]["ask"]["mention"], "@Ana", "a person");

    let mut unknown = step_in_input();
    let nobody = Finding {
        ask: Some("acct_system".to_string()),
        ..finding("conflict")
    };
    apply(&mut unknown, &Trigger::Conflict(nobody), Map::new());
    assert!(unknown["trigger"].get("ask").is_none());
}

#[test]
fn loops_and_conflicts_ask_the_task_owner_or_the_other_cards_maker() {
    let rounds: Vec<ExchangeFact> = (0..LOOP_ROUNDS as i64)
        .map(|round| exchange(&format!("r{round}"), "a", "b", 30 - round))
        .collect();
    let found = find_loop(&rounds, None, &[], &json!({}), 8).unwrap();
    assert_eq!(found.ask.as_deref(), Some("a"));
    let cards = [
        card("plan_a", "Friday dinner", Some(30), true),
        card("plan_b", "Dinner on Friday", Some(30), false),
    ];
    let found = find_conflict(&cards, &json!({})).unwrap();
    assert_eq!(found.ask.as_deref(), Some("acct_plan_b"));
}

#[test]
fn an_agent_result_after_the_discussion_began_closes_it() {
    let hooks_fired = json!({ DISCUSSION_KEY: {
        "fromSequence": 4, "since": now() - Duration::minutes(20), "checkAfter": now()} });
    // The owning agent updated its row in place, or finished a run it
    // started, after the plan talk began, so it covered it.
    for finished in [
        Gate {
            last_agent_activity_at: Some(now() - Duration::minutes(12)),
            ..quiet_for(15)
        },
        Gate {
            last_finished_run_started_at: Some(now() - Duration::minutes(12)),
            ..quiet_for(15)
        },
    ] {
        let mut pass = facts(&finished, &hooks_fired);
        pass.plan_talk = false;
        let plan = decide(pass);
        assert!(plan.run.is_none());
        assert_eq!(plan.patch[DISCUSSION_KEY], Value::Null);
    }
    // A run started for an earlier request does not cover it.
    let earlier = Gate {
        last_finished_run_started_at: Some(now() - Duration::minutes(25)),
        ..quiet_for(15)
    };
    let mut pass = facts(&earlier, &hooks_fired);
    pass.plan_talk = false;
    assert!(matches!(decide(pass).run, Some(Trigger::Silence { .. })));
}
