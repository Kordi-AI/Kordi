//! A confirmed plan on each attending member's Kordi calendar.
//!
//! The digest calendar is per account; the plan writes one event per member
//! whose answer is yes, keyed by the card so later changes update the same
//! entry, and removes it again for a decline or a cancellation.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::models::{PlanCardAgent, PlanCardRow, PlanCardRsvp, PlanCardState};

fn calendar_event_id(event_id: &str) -> String {
    format!("plan:{event_id}")
}

/// "Planned with <agent> in <chat>.": the person's agent that opened the card,
/// or the Facilitator.
fn planned_with(row: &PlanCardRow, group: Option<&str>) -> String {
    let planner = row
        .agent
        .as_ref()
        .map(PlanCardAgent::label)
        .unwrap_or_else(|| "the Facilitator".to_string());
    match group {
        Some(group) => format!("Planned with {planner} in {group}."),
        None => format!("Planned with {planner}."),
    }
}

pub(super) async fn sync_plan(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    row: &PlanCardRow,
) -> Result<(), sqlx_core::Error> {
    let calendar_id = calendar_event_id(&row.event_id);
    let attending = row.state == PlanCardState::Confirmed && row.start_at.is_some();
    let title: Option<(Option<String>, Option<String>)> =
        match Uuid::parse_str(&row.conversation_id) {
            Ok(conversation_id) => {
                query_as(
                    "SELECT shared_title, group_title FROM cloud_chat_conversations \
                     WHERE conversation_id = $1",
                )
                .bind(conversation_id)
                .fetch_optional(&mut **tx)
                .await?
            }
            Err(_) => None,
        };
    let group = title
        .and_then(|(shared, group)| group.or(shared))
        .filter(|value| !value.trim().is_empty());
    let mut description = planned_with(row, group.as_deref());
    if let Some(location) = row
        .location
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        description.push_str(&format!(" Where: {location}."));
    }
    let start = row
        .start_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    let end_at = row
        .end_at
        .clone()
        .or_else(|| start.map(|start| (start + chrono::Duration::hours(2)).to_rfc3339()));
    let reminder_at = start.map(|start| (start - chrono::Duration::hours(1)).to_rfc3339());

    let members: Vec<String> = row
        .participants
        .iter()
        .map(|participant| participant.account_id.clone())
        .collect();
    // The System agent outranks the digest: once a plan is confirmed, competing
    // calendar suggestions leave every member's saved digest right away.
    if row.state == PlanCardState::Confirmed {
        let plan = crate::digest::system_agent_guard::TrackedPlan {
            conversation_id: Some(row.conversation_id.clone()),
            title: row.title.clone(),
            start_at: start.map(|value| value.with_timezone(&chrono::Utc)),
        };
        crate::digest::system_agent_guard::clear_saved_conflicts(tx, &members, &plan).await?;
    }
    let mut calendar_changed: Vec<String> = Vec::new();

    for participant in &row.participants {
        let keep = attending && participant.rsvp == PlanCardRsvp::Yes;
        if keep {
            let payload = json!({
                "id": calendar_id,
                "title": row.title,
                "startAt": row.start_at,
                "endAt": end_at,
                "reminderAt": reminder_at,
                "allDay": false,
                "sourceIds": [],
                "description": description,
                "externalUid": null,
            });
            let written = query(
                "INSERT INTO cloud_calendar_events (account_id, event_id, payload) \
                 VALUES ($1, $2, $3) \
                 ON CONFLICT (account_id, event_id) DO UPDATE \
                 SET payload = EXCLUDED.payload, revision = cloud_calendar_events.revision + 1, \
                     updated_at = now() \
                 WHERE cloud_calendar_events.payload IS DISTINCT FROM EXCLUDED.payload",
            )
            .bind(&participant.account_id)
            .bind(&calendar_id)
            .bind(payload)
            .execute(&mut **tx)
            .await?;
            if written.rows_affected() > 0 {
                calendar_changed.push(participant.account_id.clone());
            }
        } else {
            let removed =
                query("DELETE FROM cloud_calendar_events WHERE account_id = $1 AND event_id = $2")
                    .bind(&participant.account_id)
                    .bind(&calendar_id)
                    .execute(&mut **tx)
                    .await?;
            if removed.rows_affected() > 0 {
                calendar_changed.push(participant.account_id.clone());
            }
        }
    }
    // A calendar the System agent changed is a digest change for that person.
    crate::digest::changes::mark_accounts(&mut **tx, &calendar_changed).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(agent: Option<PlanCardAgent>) -> PlanCardRow {
        PlanCardRow {
            event_id: "plan_a".to_string(),
            conversation_id: Uuid::nil().to_string(),
            revision: 1,
            state: PlanCardState::Confirmed,
            title: "Coffee".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            unresolved_fields: Vec::new(),
            source_message_ids: Vec::new(),
            participants: Vec::new(),
            manager_ids: Vec::new(),
            options: Vec::new(),
            note: None,
            agent,
        }
    }

    #[test]
    fn the_description_names_the_agent_that_planned_it() {
        assert_eq!(
            planned_with(&row(None), Some("Team")),
            "Planned with the Facilitator in Team."
        );
        let agent = PlanCardAgent {
            agent_id: "cloud-agent:acct_a".to_string(),
            owner_account_id: "acct_a".to_string(),
            name: "Kordi".to_string(),
            owner_name: "Ada".to_string(),
            avatar_url: None,
        };
        assert_eq!(
            planned_with(&row(Some(agent.clone())), Some("Team")),
            "Planned with Ada's Kordi in Team."
        );
        assert_eq!(
            planned_with(&row(Some(agent.clone())), None),
            "Planned with Ada's Kordi."
        );
        // A card that stored the owner's name with the agent's reads the same.
        let stored = PlanCardAgent {
            name: "Ada's Kordi".to_string(),
            ..agent
        };
        assert_eq!(stored.agent_name(), "Kordi");
        assert_eq!(stored.label(), "Ada's Kordi");
    }
}
