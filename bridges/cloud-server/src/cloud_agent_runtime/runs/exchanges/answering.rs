//! A run answering another agent's request may ask its own owner first; the
//! continuation of that question still answers the same request.
use super::*;

/// The agent exchange `run` answers: the exchange it is the target of, or,
/// for the continuation of a question it asked its own owner, the exchange
/// its asking run answers.
pub(super) async fn answered_exchange(
    conn: &mut sqlx_postgres::PgConnection,
    run: &str,
) -> RunResult<Option<Uuid>> {
    let row: Option<(Uuid,)> = query_as(
        "WITH RECURSIVE chain(run_id,depth) AS (SELECT $1::text,0 UNION ALL
            SELECT x.parent_run_id,c.depth+1 FROM chain c JOIN cloud_agent_exchanges x ON x.resume_run_id=c.run_id AND x.target_kind='person' WHERE c.depth<16)
         SELECT a.exchange_id FROM chain c JOIN cloud_agent_exchanges a ON a.target_run_id=c.run_id ORDER BY c.depth LIMIT 1",
    )
    .bind(run)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|r| r.0))
}

/// Check under the session lock before publishing or resuming an answer.
pub(super) async fn can_reply(
    conn: &mut sqlx_postgres::PgConnection,
    exchange: Option<Uuid>,
) -> RunResult<bool> {
    let Some(exchange) = exchange else {
        return Ok(true);
    };
    let (open,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_exchanges
         WHERE exchange_id=$1 AND status='pending' AND deadline_at>clock_timestamp())",
    )
    .bind(exchange)
    .fetch_one(conn)
    .await?;
    Ok(open)
}
