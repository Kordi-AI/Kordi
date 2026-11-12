//! The asking agent decides a planning task: after the answers it closes
//! with a decision card or a short result, and stays silent only for a pure
//! relay that the visible answer already completes.

/// A task about planning or choosing is the asking agent's to decide: it
/// closes with a card (or a short result), never silently.
pub(super) const DECIDE: &str = "If the originalRequest is about planning or choosing something (a day, time, place, event, or option), the task is yours to decide: never finish silently; close it with a decision step using the plan_card tool when you have it: plan_card create with kind vote (2 to 4 options) while options remain or others must agree, kind plan once one option is settled, and update the same card (its eventId) as details settle; add one short line with the result. Without that tool, publish the choices or the settled plan as that short result.";

use serde_json::{json, Value};

/// The last instruction of a planning continuation, after all its data.
const NOW: &str = "Decision step, required now: this task is about planning or choosing. Before your final line, call plan_card create with kind vote and 2 to 4 options taken from the replies above while options remain or others must agree, or with kind plan if one option is settled (update that card by its eventId later). Then write one short line with the result. Do not end with text only, and do not finish silently.";

/// The instruction for the one retry of a planning answer that had no card.
const RETRY: &str = "Your previous answer (previousAnswer) ended without the decision card. Call plan_card create now: kind vote with 2 to 4 options taken from the replies above, or kind plan if one option is settled. Then write one short line with the result. Do not answer with text only.";

/// Words that mark a request about planning or choosing a day, time,
/// place, or event, in English and Chinese.
const PLANNING: &[&str] = &[
    "day",
    "days",
    "date",
    "dates",
    "time",
    "times",
    "weekend",
    "tonight",
    "tomorrow",
    "morning",
    "afternoon",
    "evening",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "schedule",
    "meet",
    "meeting",
    "meetup",
    "plan",
    "vote",
    "poll",
    "dinner",
    "lunch",
    "brunch",
    "coffee",
    "drinks",
    "ride",
    "hike",
    "trip",
    "party",
    "event",
    "venue",
    "restaurant",
    "place",
    "where",
];
const PLANNING_CJK: &[&str] = &[
    "\u{54ea}\u{5929}",
    "\u{65f6}\u{95f4}",
    "\u{65e5}\u{671f}",
    "\u{5468}\u{672b}",
    "\u{5468}\u{516d}",
    "\u{5468}\u{65e5}",
    "\u{661f}\u{671f}",
    "\u{7ea6}",
    "\u{5b89}\u{6392}",
    "\u{8ba1}\u{5212}",
    "\u{9009}\u{62e9}",
    "\u{5730}\u{70b9}",
    "\u{89c1}\u{9762}",
    "\u{5403}\u{996d}",
    "\u{6295}\u{7968}",
];

/// Whether `original` asks to plan or choose something, so the asking agent
/// must close with a decision card.
pub(super) fn due(original: &str) -> bool {
    let lower = original.to_lowercase();
    let words = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty());
    let mut words = words;
    words.any(|word| PLANNING.contains(&word)) || PLANNING_CJK.iter().any(|w| original.contains(w))
}

/// Adds the decision step at the end of a planning continuation's data.
pub(super) fn mark(data: &mut Value, original: &str) {
    if due(original) {
        data["decisionDue"] = json!(true);
        // Keys sort, so this is the last thing the agent reads.
        data["whatToDoNow"] = json!(NOW);
    }
}

/// The continuation data of a run's prompt: its last JSON line.
fn data_of(prompt: &str) -> Option<(&str, Value)> {
    let (head, rest) = prompt.rsplit_once("\n{")?;
    Some((head, serde_json::from_str(&format!("{{{rest}")).ok()?))
}

/// Whether a run's continuation is a planning task whose answer needs a card.
pub(super) fn required(prompt: &str) -> bool {
    data_of(prompt).is_some_and(|(_, data)| data["decisionDue"] == true)
}

/// The prompt for the one retry: the same continuation with the answer that
/// had no card and the instruction to make it now.
pub(super) fn retry_prompt(prompt: &str, answer: &str) -> Option<String> {
    let (head, mut data) = data_of(prompt)?;
    data["previousAnswer"] = json!(answer);
    data["whatToDoNow"] = json!(RETRY);
    Some(format!("{head}\n{data}"))
}

/// A planning answer that ends without its decision card gets one retry: a
/// new resume run of the same exchange gets the answer back and is told to
/// make the card now. Returns that run; this answer is then not published.
pub(super) async fn retry_if_needed(
    pool: &sqlx_postgres::PgPool,
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    parent: &super::store::Parent,
    exchange: uuid::Uuid,
    run: &str,
    answer: &str,
) -> super::RunResult<Option<String>> {
    use sqlx_core::query_as::query_as;
    let (prompt, request, system, route, sandbox, card): (String, String, String, Value, Option<String>, bool) = query_as(
        "SELECT r.prompt,r.request_message_id,r.system_prompt,r.runtime_route_json,r.sandbox_id,
                EXISTS(SELECT 1 FROM cloud_plan_cards c WHERE c.conversation_id=$2 AND c.updated_at>=r.created_at::timestamptz)
         FROM cloud_agent_fallback_runs r WHERE r.run_id=$1",
    )
    .bind(run)
    .bind(parent.conversation)
    .fetch_one(&mut **tx)
    .await?;
    // Only once, and only when no card was made while this run worked.
    if card || request.ends_with(":decide") || !required(&prompt) {
        return Ok(None);
    }
    let Some(prompt) = retry_prompt(&prompt, answer) else {
        return Ok(None);
    };
    let retry = format!("car_exchange_decide_{}", exchange.simple());
    let ready =
        super::super::super::desktop::agent_desktop_ready(pool, &parent.owner, &parent.agent)
            .await?;
    super::store::insert_run(
        tx,
        &retry,
        &format!("{}{exchange}:decide", super::PREFIX),
        parent,
        &parent.owner,
        &parent.agent,
        &prompt,
        &system,
        &route,
        sandbox.as_deref().unwrap_or_default(),
        ready,
    )
    .await?;
    Ok(Some(retry))
}

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
                Some("Sunday 13:00-15:00 works better"),
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

    #[test]
    fn planning_requests_get_the_decision_step_last_and_one_retry() {
        assert!(super::due(
            "ask Robin's Kordi which day works for a bike ride, Saturday or Sunday"
        ));
        assert!(super::due(
            "\u{5e2e}\u{6211}\u{7ea6}\u{4e2a}\u{65f6}\u{95f4}"
        ));
        assert!(!super::due("ask Robin's Kordi whether they have the file"));
        let mut data = serde_json::json!({"originalRequest":"x","sentRequest":"y"});
        super::mark(&mut data, "which day works, Saturday or Sunday");
        let prompt = format!("Rules\n{data}");
        assert!(prompt.ends_with(&format!(
            "{}\"}}",
            serde_json::to_string(super::NOW).unwrap().trim_matches('"')
        )));
        assert!(super::required(&prompt));
        let retry = super::retry_prompt(&prompt, "Maya prefers Saturday.").unwrap();
        assert!(super::required(&retry));
        assert!(retry.contains("previousAnswer"));
        assert!(retry.contains("ended without the decision card"));
        let mut relay = serde_json::json!({"originalRequest":"x"});
        super::mark(&mut relay, "whether they have the file");
        assert!(relay.get("whatToDoNow").is_none());
    }
}
