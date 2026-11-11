//! Changes that reach a room from other server processes: stored updates
//! read back from the log (catch-up) and relayed awareness.
//!
//! Catch-up reads the rows after the room's `seq` in one consistent read and
//! applies them; the deltas the document actually takes are broadcast to
//! this process's sockets and never stored again, since they already are.

use yrs::sync::protocol::SyncMessage;
use yrs::sync::{AwarenessUpdate, Message};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Transact, Update};

use super::rooms::{take_changes, Room, RoomError, RoomState, FROM_SERVER};
use super::store;

impl Room {
    /// Catches up with every stored update.
    pub(crate) async fn catch_up(&self) {
        let mut state = self.state.lock().await;
        if let Err(error) = self.catch_up_locked(&mut state).await {
            eprintln!("[document-collab] catch up: {error:?}");
        }
    }

    /// Catches up when updates up to `seq` were stored and the room is behind.
    pub(crate) async fn catch_up_to(&self, seq: i64) {
        let mut state = self.state.lock().await;
        if state.seq >= seq {
            return;
        }
        if let Err(error) = self.catch_up_locked(&mut state).await {
            eprintln!("[document-collab] catch up: {error:?}");
        }
    }

    pub(super) async fn catch_up_locked(&self, state: &mut RoomState) -> Result<(), RoomError> {
        if self.is_poisoned() {
            return Ok(());
        }
        let since = store::load_since(&self.relay.pool, &self.attachment_id, state.seq).await?;
        let mut covered = state.seq;
        let mut applied_rows = 0_u32;
        let outcome = {
            let mut txn = state.awareness.doc().transact_mut();
            let mut apply = |bytes: &[u8]| -> Result<(), RoomError> {
                if bytes.is_empty() {
                    return Ok(());
                }
                let update = Update::decode_v1(bytes).map_err(|_| RoomError::Invalid)?;
                txn.apply_update(update).map_err(|_| RoomError::Invalid)
            };
            let mut outcome = Ok(());
            if let Some(compacted) = &since.state {
                outcome = apply(compacted);
                if outcome.is_ok() {
                    covered = covered.max(since.compacted_seq);
                }
            }
            for (seq, bytes) in &since.updates {
                if outcome.is_err() {
                    break;
                }
                outcome = apply(bytes);
                if outcome.is_ok() {
                    covered = *seq;
                    applied_rows += 1;
                }
            }
            outcome
        };
        // The transaction committed above: what the document took is in `taken`.
        for delta in take_changes(&state.taken) {
            self.broadcast(
                FROM_SERVER,
                Message::Sync(SyncMessage::Update(delta)).encode_v1(),
            );
        }
        state.seq = covered;
        state.since_compaction = state.since_compaction.saturating_add(applied_rows);
        outcome
    }

    /// Applies an awareness update relayed by another process and passes
    /// it to every local socket. It is never relayed again.
    pub(crate) async fn apply_remote_awareness(&self, bytes: &[u8]) {
        let Ok(update) = AwarenessUpdate::decode_v1(bytes) else {
            return;
        };
        let state = self.state.lock().await;
        if self.is_poisoned() {
            return;
        }
        let frame = Message::Awareness(update.clone()).encode_v1();
        if state.awareness.apply_update(update).is_ok() {
            self.broadcast(FROM_SERVER, frame);
        }
    }

    /// Answers another process that just loaded this room with the room's
    /// current awareness.
    pub(crate) async fn answer_awareness_query(&self) {
        let state = self.state.lock().await;
        if self.is_poisoned() {
            return;
        }
        if let Ok(update) = state.awareness.update() {
            if !update.clients.is_empty() {
                self.relay
                    .publish_awareness(&self.attachment_id, &update.encode_v1());
            }
        }
    }
}
