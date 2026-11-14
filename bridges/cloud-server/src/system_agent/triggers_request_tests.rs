//! Direct requests: a held request while another agent is busy, and the
//! requests-only mode of Grounding groups.

use serde_json::{json, Value};

use super::super::ownership_store::Gate;
use super::tests::{facts, finding, quiet_for};
use super::*;

#[test]
fn a_request_while_another_agent_is_busy_waits_then_runs() {
    let busy = Gate {
        agent_busy: true,
        ..quiet_for(1)
    };
    let empty = json!({});
    let mut asked = facts(&busy, &empty);
    asked.plan_talk = false;
    asked.asks_system_agent = true;
    let plan = decide(asked);
    assert_eq!(plan.run, None);
    assert_eq!(plan.patch[HELD_REQUEST_KEY], json!({ "fromSequence": 4 }));
    assert!(
        plan.patch[CHECK_AFTER_KEY].is_string(),
        "checked again soon"
    );

    // Still busy on the next pass: it keeps waiting, with no new patch.
    let held = json!({ HELD_REQUEST_KEY: { "fromSequence": 4 } });
    let mut pass = facts(&busy, &held);
    pass.plan_talk = false;
    let plan = decide(pass);
    assert_eq!(plan.run, None);
    assert!(!plan.patch.contains_key(HELD_REQUEST_KEY));
    assert!(plan.patch[CHECK_AFTER_KEY].is_string());

    // The other agent is done: the request runs from where it was asked.
    let free = quiet_for(1);
    let mut pass = facts(&free, &held);
    pass.plan_talk = false;
    let plan = decide(pass);
    assert_eq!(plan.run, Some(Trigger::Request { rewind_to: Some(4) }));
    assert_eq!(plan.marks[HELD_REQUEST_KEY], Value::Null);

    // A stall steps in first and leaves the request for the next pass.
    let stalled = Gate {
        stepping_in: true,
        agent_task: true,
        ..quiet_for(15)
    };
    let plan = decide(facts(&stalled, &held));
    assert_eq!(plan.run, Some(Trigger::Stall));
    assert!(!plan.marks.contains_key(HELD_REQUEST_KEY));
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
