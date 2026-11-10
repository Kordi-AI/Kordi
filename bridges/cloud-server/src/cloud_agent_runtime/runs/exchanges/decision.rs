//! The asking agent decides a planning task: after the answers it closes
//! with a decision card or a short result, and stays silent only for a pure
//! relay that the visible answer already completes.

/// A task about planning or choosing is the asking agent's to decide: it
/// closes with a card (or a short result), never silently.
pub(super) const DECIDE: &str = "If the originalRequest is about planning or choosing something (a day, time, place, event, or option), the task is yours to decide: never finish silently; close it with a decision step using the plan_card tool when you have it: plan_card create with kind vote (2 to 4 options) while options remain or others must agree, kind plan once one option is settled, and update the same card (its eventId) as details settle; add one short line with the result. Without that tool, publish the choices or the settled plan as that short result.";

#[cfg(test)]
mod tests {
    #[test]
    fn a_planning_task_closes_with_a_decision_and_only_a_pure_relay_may_be_silent() {
        for original in [
            "ask Robin's Kordi which day works for a bike ride, Saturday or Sunday",
            "ask Robin's Kordi whether they have the file",
        ] {
            let prompt = super::super::lifecycle::continuation_prompt(
                original,
                "Which day works?",
                "Sunday 13:00-15:00 works better",
                &[],
                7,
                serde_json::json!({}),
            );
            let rules = prompt.split_once('\n').unwrap().0;
            let data: serde_json::Value =
                serde_json::from_str(prompt.split_once('\n').unwrap().1).unwrap();
            assert_eq!(data["originalRequest"], original);
            // Planning or choosing: the asking agent decides with a card.
            assert!(rules.contains(
                "about planning or choosing something (a day, time, place, event, or option)"
            ));
            assert!(rules.contains(
                "never finish silently; close it with a decision step using the plan_card tool"
            ));
            assert!(rules.contains("plan_card create with kind vote (2 to 4 options) while options remain or others must agree"));
            assert!(rules.contains("kind plan once one option is settled"));
            assert!(rules.contains("update the same card (its eventId) as details settle"));
            assert!(rules.contains("one short line with the result"));
            assert!(
                !rules.contains("propose"),
                "the person agent's tool has create and update"
            );
            // A pure relay whose visible answer fully answers it may stay silent.
            assert!(rules.contains("Otherwise, after a single round, if the originalRequest only relayed a question to that agent and its visible answer fully answers it, finish silently"));
            assert!(!rules.contains("was only to ask or check with that agent"));
        }
    }
}
