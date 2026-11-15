//! The execution lease of a turn: the deadline the renderer keeps renewing,
//! the native watchdog that stops the turn when it passes, and why it stopped.

use std::sync::{Arc, Mutex};

use super::super::models::{DesktopSyncRefusal, DesktopTurnStopReason};
use super::super::{DesktopChatManager, DesktopChatTurnSnapshot};
use super::{snapshot_turn, update_turn};

/// Records why a turn is being stopped. The first reason wins, and a turn
/// that already ended keeps its outcome.
pub(in crate::chat) fn record_stop_reason(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    reason: Option<DesktopTurnStopReason>,
) {
    let Some(reason) = reason else {
        return;
    };
    update_turn(snapshot, |state| {
        if !state.completed && state.stop_reason.is_none() {
            eprintln!(
                "[background-session] stopping turn {}: {}",
                state.id,
                describe_stop_reason(&reason)
            );
            state.stop_reason = Some(reason);
        }
    });
}

fn describe_stop_reason(reason: &DesktopTurnStopReason) -> String {
    match (reason.status, reason.code.as_deref()) {
        (Some(status), Some(code)) => format!("{} (last refusal {status} {code})", reason.kind),
        _ => reason.kind.clone(),
    }
}

/// The longest a renderer-provided lease deadline may reach ahead. The renderer
/// derives the deadline from the server's lease, so a slow server keeps a turn
/// alive while its lease holds; this cap only bounds a malformed deadline.
const MAX_EXECUTION_LEASE_WINDOW_MS: i64 = 10 * 60 * 1_000;

pub(in crate::chat) async fn renew_execution_lease(
    manager: &DesktopChatManager,
    turn_id: &str,
    deadline_ms: i64,
    refusal: Option<DesktopSyncRefusal>,
) -> Result<(), String> {
    let turn = manager
        .turns
        .lock()
        .await
        .get(turn_id)
        .cloned()
        .ok_or_else(|| "Unknown execution lease turn".to_string())?;
    if let Ok(mut last) = turn.lease_refusal.lock() {
        // The renderer passes the cloud's last refusal; log when it changes.
        if *last != refusal {
            match &refusal {
                Some(next) => eprintln!(
                    "[background-session] the cloud refuses updates of turn {turn_id}: {} {}; it keeps running",
                    next.status, next.code
                ),
                None => eprintln!("[background-session] turn {turn_id} is synced again"),
            }
        }
        *last = refusal;
    }
    let remaining = deadline_ms.saturating_sub(super::super::now_millis());
    if remaining <= 0 || turn.cancel.is_cancelled() {
        lapse_execution_lease(&turn);
        return Err("Execution lease expired".into());
    }
    let mut deadline = turn
        .execution_lease_deadline
        .lock()
        .map_err(|_| "Execution lease unavailable")?;
    let start_watchdog = deadline.is_none();
    *deadline = Some(
        std::time::Instant::now()
            + std::time::Duration::from_millis(remaining.min(MAX_EXECUTION_LEASE_WINDOW_MS) as u64),
    );
    drop(deadline);
    if start_watchdog {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                if turn.cancel.is_cancelled()
                    || snapshot_turn(&turn.snapshot).is_ok_and(|s| s.completed)
                {
                    return;
                }
                let valid = turn
                    .execution_lease_deadline
                    .lock()
                    .ok()
                    .and_then(|deadline| *deadline)
                    .is_some_and(|d| d > std::time::Instant::now());
                if !valid {
                    lapse_execution_lease(&turn);
                    return;
                }
            }
        });
    }
    Ok(())
}

/// Nothing renewed the turn's lease in time: stop it and say so.
fn lapse_execution_lease(turn: &super::super::DesktopChatTurnHandle) {
    let refusal = turn.lease_refusal.lock().ok().and_then(|last| last.clone());
    eprintln!(
        "[execution-lease] lease lapsed; stopping turn (last refusal: {})",
        refusal
            .as_ref()
            .map_or("none".to_string(), |refusal| format!(
                "{} {}",
                refusal.status, refusal.code
            ))
    );
    record_stop_reason(
        &turn.snapshot,
        Some(DesktopTurnStopReason::lease_lapsed(refusal.as_ref())),
    );
    turn.cancel.cancel();
}
