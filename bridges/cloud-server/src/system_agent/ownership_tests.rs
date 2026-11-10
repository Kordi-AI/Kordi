use super::*;

const ALICE_AGENT: &str = "acct_alice";

fn at(minute: i64) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-06T18:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
        + Duration::minutes(minute)
}

fn clock(minute: i64) -> Clock {
    Clock {
        now: at(minute),
        stall: Duration::minutes(10),
    }
}

fn agent_owner() -> Owner {
    Owner {
        account_id: Some(ALICE_AGENT.to_string()),
        agent_name: Some("KordiAlice".to_string()),
    }
}

fn person(sequence: i64, minute: i64) -> MessageFact {
    MessageFact {
        sequence,
        created_at: at(minute),
        agent: None,
        human: true,
        addressed_owner: None,
    }
}

fn addressed(sequence: i64, minute: i64) -> MessageFact {
    MessageFact {
        addressed_owner: Some(agent_owner()),
        ..person(sequence, minute)
    }
}

fn agent(sequence: i64, minute: i64, waiting: bool, delivery: Delivery) -> MessageFact {
    MessageFact {
        sequence,
        created_at: at(minute),
        agent: Some(AgentMessage {
            owner: agent_owner(),
            waiting,
            delivery,
        }),
        human: false,
        addressed_owner: None,
    }
}

fn run(status: &str, lease_minute: Option<i64>, updated_minute: i64) -> RunFact {
    RunFact {
        status: status.to_string(),
        owner: agent_owner(),
        lease_expires_at: lease_minute.map(at),
        updated_at: Some(at(updated_minute)),
    }
}

fn work(runs: Vec<RunFact>) -> Work {
    Work {
        runs,
        pending_exchange: None,
    }
}

fn waiting_task(assessment: &Assessment) -> &Deferral {
    match &assessment.outcome {
        Outcome::Waiting(task) => task,
        other => panic!("expected a waiting task, got {other:?}"),
    }
}

#[test]
fn a_message_that_mentions_or_replies_to_an_agent_is_deferred() {
    // `addressed_owner` covers mentions, replies, and quotes of an agent message.
    let messages = [person(1, 0), addressed(2, 1)];
    let result = assess(None, 0, 1, &messages, &Work::default(), &clock(2));
    assert_eq!(result.owned, BTreeSet::from([2]));
    let task = waiting_task(&result);
    assert_eq!(task.from_sequence, 1);
    assert_eq!(task.owner, agent_owner());
    assert_eq!(task.check_after, at(3));
}

#[test]
fn a_plain_answer_to_an_agent_question_is_deferred() {
    // The live failure: "@Agent plan Friday dinner", the agent asks a
    // question, someone answers "7pm, anything is fine".
    let messages = [
        addressed(1, 0),
        agent(2, 1, true, Delivery::Complete),
        person(3, 2),
    ];
    let result = assess(None, 0, 2, &messages, &Work::default(), &clock(3));
    assert_eq!(result.owned, BTreeSet::from([3]));
    assert_eq!(result.agents.get(&2), Some(&Some("KordiAlice".to_string())));
    assert_eq!(waiting_task(&result).owner, agent_owner());
}

#[test]
fn people_planning_among_themselves_stay_with_the_system_agent() {
    let finished = [agent(1, 0, false, Delivery::Complete), person(2, 1)];
    let result = assess(None, 0, 1, &finished, &Work::default(), &clock(2));
    assert_eq!(result.outcome, Outcome::Free);
    assert!(result.owned.is_empty());
    // An agent question long ago no longer owns the chat.
    let stale = [agent(1, 0, true, Delivery::Complete), person(2, 30)];
    let result = assess(None, 0, 1, &stale, &Work::default(), &clock(31));
    assert_eq!(result.outcome, Outcome::Free);
}

#[test]
fn an_open_run_or_pending_exchange_owns_new_messages() {
    let messages = [person(1, 0)];
    let running = work(vec![run("running", Some(5), 0)]);
    let result = assess(None, 0, 0, &messages, &running, &clock(1));
    assert_eq!(result.owned, BTreeSet::from([1]));
    assert_eq!(waiting_task(&result).owner, agent_owner());
    let exchange = Work {
        runs: Vec::new(),
        pending_exchange: Some(agent_owner()),
    };
    let result = assess(None, 0, 0, &messages, &exchange, &clock(1));
    assert_eq!(result.owned, BTreeSet::from([1]));
    // A run left open for hours is stuck, not working on this chat.
    let stuck = work(vec![run("queued", None, -120)]);
    let result = assess(None, 0, 0, &messages, &stuck, &clock(1));
    assert_eq!(result.outcome, Outcome::Free);
}

#[test]
fn messages_while_a_task_waits_join_it() {
    let stored = Deferral {
        from_sequence: 1,
        last_human_sequence: 2,
        since: at(0),
        last_human_at: at(0),
        owner: agent_owner(),
        check_after: at(1),
    };
    let messages = [addressed(2, 0), person(3, 4)];
    let result = assess(Some(stored), 0, 2, &messages, &Work::default(), &clock(5));
    assert_eq!(result.owned, BTreeSet::from([3]));
    let task = waiting_task(&result);
    // A message without its own signal does not extend the window.
    assert_eq!(task.last_human_sequence, 2);
    assert_eq!(task.from_sequence, 1);
}

fn deferred_answer() -> (Deferral, Vec<MessageFact>) {
    let messages = vec![agent(1, 0, true, Delivery::Complete), person(2, 1)];
    let task = Deferral {
        from_sequence: 1,
        last_human_sequence: 2,
        since: at(1),
        last_human_at: at(1),
        owner: agent_owner(),
        check_after: at(2),
    };
    (task, messages)
}

#[test]
fn a_failed_or_expired_run_is_a_stall() {
    let (task, messages) = deferred_answer();
    for runs in [
        vec![run("failed", None, 2)],
        vec![run("cancelled", None, 2)],
        vec![run("running", Some(2), 2)],
    ] {
        let result = assess(Some(task.clone()), 0, 2, &messages, &work(runs), &clock(4));
        assert!(matches!(result.outcome, Outcome::Stalled(_)), "{result:?}");
    }
    let mut failed_reply = messages.clone();
    failed_reply.push(agent(3, 2, false, Delivery::Failed));
    let result = assess(Some(task), 0, 3, &failed_reply, &Work::default(), &clock(4));
    assert!(matches!(result.outcome, Outcome::Stalled(_)));
}

#[test]
fn a_running_agent_with_a_live_lease_is_never_overtaken() {
    let (task, messages) = deferred_answer();
    let running = work(vec![run("running", Some(40), 30)]);
    let result = assess(Some(task), 0, 2, &messages, &running, &clock(30));
    assert_eq!(waiting_task(&result).check_after, at(31));
}

#[test]
fn the_window_passing_without_a_reply_is_a_stall() {
    let (task, messages) = deferred_answer();
    let early = assess(
        Some(task.clone()),
        0,
        2,
        &messages,
        &Work::default(),
        &clock(10),
    );
    waiting_task(&early);
    let late = assess(
        Some(task.clone()),
        0,
        2,
        &messages,
        &Work::default(),
        &clock(11),
    );
    assert_eq!(late.outcome, Outcome::Stalled(task));
    // A run that finished for an earlier request is not this task's failure.
    let (task, messages) = deferred_answer();
    let earlier = work(vec![run("failed", None, 0)]);
    let result = assess(Some(task), 0, 2, &messages, &earlier, &clock(5));
    waiting_task(&result);
}

#[test]
fn an_agent_reply_ends_the_task_without_the_system_agent() {
    let (task, mut messages) = deferred_answer();
    messages.push(agent(3, 3, false, Delivery::Complete));
    let result = assess(
        Some(task.clone()),
        0,
        3,
        &messages,
        &Work::default(),
        &clock(20),
    );
    assert_eq!(result.outcome, Outcome::Replied);
    // Another agent's reply does not answer this one's task.
    let (task, mut messages) = deferred_answer();
    let mut other = agent(3, 3, false, Delivery::Complete);
    other.agent.as_mut().unwrap().owner.account_id = Some("acct_bob".to_string());
    messages.push(other);
    let result = assess(Some(task), 0, 3, &messages, &Work::default(), &clock(20));
    assert!(matches!(result.outcome, Outcome::Stalled(_)));
}

#[test]
fn an_agent_question_after_a_step_in_is_needed_to_defer_again() {
    let messages = [agent(1, 0, true, Delivery::Complete), person(5, 2)];
    let result = assess(None, 4, 4, &messages, &Work::default(), &clock(3));
    assert_eq!(result.outcome, Outcome::Free);
    let messages = [person(2, 0)];
    let result = assess(None, 4, 0, &messages, &Work::default(), &clock(3));
    assert!(
        result.owned.is_empty(),
        "messages the System agent took over"
    );
}

#[test]
fn the_sweep_row_keeps_waiting_tasks_and_drops_finished_ones() {
    let (task, _) = deferred_answer();
    let waiting = state_patch(false, &Outcome::Waiting(task.clone()), 9).unwrap();
    assert_eq!(Deferral::read(&waiting), Some(task.clone()));
    assert!(waiting["deferred"]["checkAfter"].is_string());
    let stalled = state_patch(true, &Outcome::Stalled(task), 9).unwrap();
    assert!(stalled.get(DEFERRED_KEY).is_none());
    assert_eq!(SteppedIn::read(&stalled).unwrap().through, 9);
    assert_eq!(state_patch(true, &Outcome::Replied, 9), Some(json!({})));
    assert_eq!(state_patch(false, &Outcome::Free, 9), None);
}

#[test]
fn input_marks_and_step_in_line() {
    let mut input = json!({"messages": [
        {"sequence": 1, "text": "@KordiAlice plan Friday dinner", "addressesAgent": true},
        {"sequence": 2, "text": "What time?"},
        {"sequence": 3, "text": "7pm, anything is fine"},
    ]});
    let agents = BTreeMap::from([(2, Some("KordiAlice".to_string()))]);
    mark(&mut input, &BTreeSet::from([3]), &agents);
    assert_eq!(input["messages"][2]["agentOwned"], true);
    assert_eq!(input["messages"][1]["fromAgent"], true);
    assert_eq!(input["messages"][1]["agentName"], "KordiAlice");
    assert_eq!(with_step_in_line(&input, "Card is up."), "Card is up.");
    step_in(&mut input, &agent_owner());
    assert!(input["messages"][0].get("addressesAgent").is_none());
    assert!(input["messages"][2].get("agentOwned").is_none());
    assert_eq!(input["messages"][1]["fromAgent"], true);
    assert_eq!(
        with_step_in_line(&input, "Card is up."),
        "KordiAlice hasn't replied, so I'm picking this up.\nCard is up."
    );
    step_in(&mut input, &Owner::default());
    assert!(with_step_in_line(&input, "x").starts_with("The agent hasn't replied"));
}

#[test]
fn a_run_that_completed_after_the_answer_ends_the_task() {
    let (task, messages) = deferred_answer();
    let done = work(vec![run("completed", None, 3)]);
    let result = assess(Some(task.clone()), 0, 2, &messages, &done, &clock(20));
    assert_eq!(result.outcome, Outcome::Replied);
    // The run that asked the question finished before the answer.
    let asked = work(vec![run("completed", None, 0)]);
    let result = assess(Some(task), 0, 2, &messages, &asked, &clock(5));
    waiting_task(&result);
}

#[test]
fn a_run_whose_lease_lapsed_owns_no_new_messages() {
    // A Mac went to sleep mid-run: plain chat stays the System agent's, and
    // its reply carries no "picking this up" line.
    let messages = [person(1, 30)];
    let asleep = work(vec![run("running", Some(5), 2)]);
    let result = assess(None, 0, 0, &messages, &asleep, &clock(31));
    assert_eq!(result.outcome, Outcome::Free);
    assert!(result.owned.is_empty());
    let mut input = json!({"messages": [{"sequence": 1, "text": "Dinner Friday at 7?"}]});
    mark(&mut input, &result.owned, &result.agents);
    assert!(input["messages"][0].get("agentOwned").is_none());
    assert!(input.get("stepIn").is_none());
    assert_eq!(with_step_in_line(&input, "Card is up."), "Card is up.");
}

#[test]
fn only_the_owning_agents_completed_run_answers_the_task() {
    let (task, messages) = deferred_answer();
    let mut other = run("completed", None, 3);
    other.owner.account_id = Some("acct_bob".to_string());
    let result = assess(
        Some(task.clone()),
        0,
        2,
        &messages,
        &work(vec![other]),
        &clock(5),
    );
    waiting_task(&result);
    let own = run("completed", None, 3);
    let result = assess(Some(task), 0, 2, &messages, &work(vec![own]), &clock(5));
    assert_eq!(result.outcome, Outcome::Replied);
}

#[test]
fn an_unreadable_deferred_value_is_cleared() {
    assert_eq!(
        Deferral::read(&json!({"deferred": {"checkAfter": "soon"}})),
        None
    );
    assert_eq!(state_patch(true, &Outcome::Free, 4), Some(json!({})));
}
