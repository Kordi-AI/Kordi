//! Identity comes from the authorized run and account records, never mention labels.
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::RunResult;

pub(crate) async fn identity_for_run(pool: &PgPool, run_id: &str) -> RunResult<Value> {
    let (saved, session, request, owner, agent): (Option<Value>, String, String, String, String) =
        query_as(
            "SELECT turn_identity,session_id,request_message_id,owner_account_id,execution_agent_id
         FROM cloud_agent_fallback_runs WHERE run_id=$1",
        )
        .bind(run_id)
        .fetch_one(pool)
        .await?;
    if let Some(saved) = saved {
        return Ok(with_names(saved));
    }
    let facilitator_assignment = request.starts_with(super::facilitator_handoff::REQUEST_PREFIX);
    let policy = if facilitator_assignment {
        None
    } else {
        super::envelopes::cloud_group_request_envelope_for_run(pool, &session, &request)
            .await?
            .and_then(|envelope| {
                super::group_mentions::persona_instruction(&envelope, &owner, &agent)
            })
    };
    let (mut identity,): (Value,) = query_as(
        "SELECT
            jsonb_build_object('requestId',r.request_message_id,'agentId',COALESCE(NULLIF(r.execution_agent_id,''),'cloud-agent:'||r.owner_account_id),
                'ownerAccountId',r.owner_account_id,'ownerName',COALESCE(NULLIF(btrim(owner.display_name),''),'Participant'),
                'requesterAccountId',r.requester_account_id,'requesterName',COALESCE(NULLIF(btrim(requester.display_name),''),'Participant'),
                'agentName',COALESCE((SELECT name FROM cloud_agent_definitions
                    WHERE agent_id=r.execution_agent_id AND owner_account_id=r.owner_account_id),
                    profile.display_name,'Kordi'))
         FROM cloud_agent_fallback_runs r JOIN cloud_accounts owner ON owner.account_id=r.owner_account_id
         JOIN cloud_accounts requester ON requester.account_id=r.requester_account_id
         LEFT JOIN cloud_default_agent_profiles profile ON profile.owner_account_id=owner.account_id
         WHERE r.run_id=$1",
    ).bind(run_id).fetch_one(pool).await?;
    if let Some(policy) = policy {
        identity["requestPolicy"] = Value::String(policy);
    }
    // A short note for the tail of this turn's context: the current time, the
    // members when they changed, and whom reach_out can reach. It never goes
    // into the system prompt, which stays the same from run to run.
    // The owner's private chat has no members note, but whom the run can
    // reach is listed there too, since the tool's guidance points to it.
    if !facilitator_assignment {
        let reach = super::exchanges::reachable(pool, run_id)
            .await?
            .map(|reachable| super::exchanges::reach_note(&reachable));
        let note = match super::conversation_context::note(pool, run_id).await? {
            Some((note, digest)) => {
                identity["conversationMembersDigest"] = Value::String(digest);
                Some(match reach {
                    Some(reach) => format!("{note}\n{reach}"),
                    None => note,
                })
            }
            // Names and handles in the list come from members, so the list
            // keeps the same untrusted-data framing as the members note.
            None => {
                reach.map(|reach| format!("{} {reach}", super::conversation_context::NOTE_FRAMING))
            }
        };
        if let Some(note) = note {
            identity["conversationContext"] = Value::String(note);
        }
    }
    // The current request decides the reply's language, not history or memory.
    let (request_text,): (String,) = query_as("SELECT COALESCE(omp_input_json->>'prompt',prompt,'') FROM cloud_agent_fallback_runs WHERE run_id=$1")
        .bind(run_id).fetch_one(pool).await?;
    let language = super::request_language::language_line(&request_text);
    identity["conversationContext"] =
        Value::String(match identity["conversationContext"].as_str() {
            Some(note) => format!(
                "{note}
{language}"
            ),
            None => language,
        });
    // Atomic first-writer wins, including competing lease attempts. Avoid holding
    // a pool connection while reading the request envelope on another connection.
    let (identity,): (Value,) = query_as("UPDATE cloud_agent_fallback_runs SET turn_identity=COALESCE(turn_identity,$2) WHERE run_id=$1 RETURNING turn_identity")
        .bind(run_id)
        .bind(&identity)
        .fetch_one(pool)
        .await?;
    Ok(with_names(identity))
}

/// The label an account without a display name gets, as elsewhere in runs.
const UNNAMED: &str = "Participant";

/// Gives the owner and requester a name label when the stored identity has
/// none. An account may have no display name, and runners read both names as
/// strings, so an identity saved without one would make every lease of its
/// run unreadable.
pub(crate) fn with_names(mut identity: Value) -> Value {
    if let Some(object) = identity.as_object_mut() {
        for field in ["ownerName", "requesterName"] {
            let named = object
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|name| !name.trim().is_empty());
            if !named {
                object.insert(field.to_string(), Value::String(UNNAMED.to_string()));
            }
        }
    }
    identity
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn identities_without_names_get_a_label() {
        let identity = super::with_names(json!({
            "agentName": "Facilitator",
            "ownerName": "Facilitator",
            "requesterName": null,
        }));
        assert_eq!(identity["requesterName"], "Participant");
        assert_eq!(identity["ownerName"], "Facilitator");
        let identity = super::with_names(json!({ "ownerName": " ", "agentName": "Kordi" }));
        assert_eq!(identity["ownerName"], "Participant");
        assert_eq!(identity["requesterName"], "Participant");
        assert_eq!(identity["agentName"], "Kordi");
    }
}
