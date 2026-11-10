//! In-memory collaboration rooms: one Y document per canonical attachment,
//! the awareness states of its editors, and a broadcast channel to them.
//!
//! The server speaks y-protocols sync v1 and awareness, as `y-websocket`
//! does. Client updates are applied to the room's document; only the changes
//! the document actually took (as reported by its update observer) are
//! appended to storage and broadcast. The room compacts its state every
//! [`COMPACT_EVERY_UPDATES`] updates or [`COMPACT_EVERY`], and when the last
//! editor leaves.
//!
//! Several server processes may hold a room for the same document. The
//! stored update log is the shared truth: a room's `seq` is the highest
//! sequence such that its document holds every stored update up to it, and
//! a room catches up by reading the rows after it (see `remote.rs`). If a
//! change cannot be stored, the room is discarded and its editors reconnect.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Mutex};
use yrs::block::ClientID;
use yrs::encoding::read::Cursor;
use yrs::sync::protocol::{MessageReader, SyncMessage};
use yrs::sync::{Awareness, Message};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::Encode;
use yrs::{Doc, IdSet, ReadTxn, StateVector, Transact, Update};

use super::relay::Relay;
use super::store;

pub(crate) const COMPACT_EVERY_UPDATES: u32 = 200;
pub(crate) const COMPACT_EVERY: Duration = Duration::from_secs(5 * 60);
const BROADCAST_CAPACITY: usize = 512;
const APPEND_RETRY_AFTER: Duration = Duration::from_millis(100);
/// The sender of frames from storage or another process. Connection ids
/// start at 1, so these reach every socket of the room.
pub(super) const FROM_SERVER: u64 = 0;

#[derive(Debug, Clone)]
pub(crate) enum Outgoing {
    /// A frame for every connection of the room except `from`.
    Frame { from: u64, frame: Arc<Vec<u8>> },
    /// The room was discarded after a storage failure: every socket closes
    /// so its client reconnects and sends its changes again.
    Reset,
}

#[derive(Debug)]
pub(crate) enum RoomError {
    Database(sqlx_core::Error),
    /// The stored state or a client message could not be decoded or applied.
    Invalid,
    /// The room was discarded after a storage failure.
    Reset,
}

impl From<sqlx_core::Error> for RoomError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

pub(super) struct RoomState {
    pub(super) awareness: Awareness,
    /// Changes the document took in the current message, from its observer.
    pub(super) taken: Arc<StdMutex<Vec<Vec<u8>>>>,
    /// Keeps the update observer alive for the room's lifetime.
    _subscription: yrs::Subscription,
    /// Every stored update up to `seq` is in the document.
    pub(super) seq: i64,
    initialized: bool,
    pub(super) since_compaction: u32,
    last_compaction: Instant,
    connections: usize,
}

pub(crate) struct Room {
    pub attachment_id: String,
    pub(super) state: Mutex<RoomState>,
    tx: broadcast::Sender<Outgoing>,
    pub(super) relay: Arc<Relay>,
    poisoned: AtomicBool,
}

/// Drains the changes the document's observer collected.
pub(super) fn take_changes(taken: &StdMutex<Vec<Vec<u8>>>) -> Vec<Vec<u8>> {
    taken
        .lock()
        .map(|mut taken| std::mem::take(&mut *taken))
        .unwrap_or_default()
}

/// What the document holds back for missing dependencies, if anything.
fn pending_of(doc: &Doc) -> Option<(Vec<u8>, Option<IdSet>)> {
    let txn = doc.transact();
    if !txn.has_missing_updates() {
        return None;
    }
    let store = txn.store();
    Some((
        store
            .pending_update()
            .map(|pending| pending.update.encode_v1())
            .unwrap_or_default(),
        store.pending_ds().cloned(),
    ))
}

impl Room {
    pub(super) async fn load(relay: Arc<Relay>, attachment_id: &str) -> Result<Self, RoomError> {
        let stored = store::load_room(&relay.pool, attachment_id).await?;
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            for bytes in std::iter::once(&stored.state)
                .chain(stored.updates.iter().map(|(_, update)| update))
                .filter(|bytes| !bytes.is_empty())
            {
                let update = Update::decode_v1(bytes).map_err(|_| RoomError::Invalid)?;
                txn.apply_update(update).map_err(|_| RoomError::Invalid)?;
            }
        }
        let taken = Arc::new(StdMutex::new(Vec::new()));
        let sink = taken.clone();
        let subscription = doc
            .observe_update_v1(move |_, event| {
                if let Ok(mut taken) = sink.lock() {
                    taken.push(event.update.clone());
                }
            })
            .map_err(|_| RoomError::Invalid)?;
        let seq = stored.updates.last().map_or(stored.seq, |(seq, _)| *seq);
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Ok(Self {
            attachment_id: attachment_id.to_string(),
            state: Mutex::new(RoomState {
                awareness: Awareness::new(doc),
                taken,
                _subscription: subscription,
                seq,
                initialized: stored.initialized,
                since_compaction: stored.updates.len() as u32,
                last_compaction: Instant::now(),
                connections: 0,
            }),
            tx,
            relay,
            poisoned: AtomicBool::new(false),
        })
    }

    pub(crate) fn is_poisoned(&self) -> bool {
        self.poisoned.load(Ordering::SeqCst)
    }

    /// Counts a new connection, unless the room was discarded.
    pub(super) async fn try_connect(&self) -> bool {
        let mut state = self.state.lock().await;
        if self.is_poisoned() {
            return false;
        }
        state.connections += 1;
        true
    }

    pub(super) async fn is_idle(&self) -> bool {
        self.state.lock().await.connections == 0
    }

    /// Ends connection `conn`: clears its awareness states for everyone,
    /// and on the last leave compacts a healthy room. Returns whether it was
    /// the last connection.
    pub(super) async fn disconnect(&self, conn: u64, clients: &HashSet<ClientID>) -> bool {
        let mut state = self.state.lock().await;
        for client in clients {
            state.awareness.remove_state(*client);
        }
        if !clients.is_empty() {
            if let Ok(update) = state.awareness.update_with_clients(clients.iter().copied()) {
                self.relay
                    .publish_awareness(&self.attachment_id, &update.encode_v1());
                self.broadcast(conn, Message::Awareness(update).encode_v1());
            }
        }
        state.connections = state.connections.saturating_sub(1);
        if state.connections == 0 && !self.is_poisoned() {
            if let Err(error) = self.compact_locked(&mut state).await {
                eprintln!("[document-collab] compact on leave: {error:?}");
            }
        }
        state.connections == 0
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Outgoing> {
        self.tx.subscribe()
    }

    pub(super) fn broadcast(&self, from: u64, frame: Vec<u8>) {
        let _ = self.tx.send(Outgoing::Frame {
            from,
            frame: Arc::new(frame),
        });
    }

    /// The server's opening messages: sync step 1 and the current awareness.
    pub(crate) async fn greeting(&self) -> Vec<Vec<u8>> {
        let state = self.state.lock().await;
        let sv = state.awareness.doc().transact().state_vector();
        let mut frames = vec![Message::Sync(SyncMessage::SyncStep1(sv)).encode_v1()];
        if let Ok(update) = state.awareness.update() {
            if !update.clients.is_empty() {
                frames.push(Message::Awareness(update).encode_v1());
            }
        }
        frames
    }

    /// Handles one binary frame from connection `conn`. Returns the replies
    /// for that connection; changes go to the others through the channel.
    /// Awareness client ids the connection announces are added to `clients`.
    pub(crate) async fn handle(
        &self,
        conn: u64,
        data: &[u8],
        clients: &mut HashSet<ClientID>,
    ) -> Result<Vec<Vec<u8>>, RoomError> {
        let messages = decode_messages(data)?;
        let mut state = self.state.lock().await;
        if self.is_poisoned() {
            return Err(RoomError::Reset);
        }
        let mut replies = Vec::new();
        for message in messages {
            match message {
                Message::Sync(SyncMessage::SyncStep1(sv)) => {
                    let update = state
                        .awareness
                        .doc()
                        .transact()
                        .encode_state_as_update_v1(&sv);
                    replies.push(Message::Sync(SyncMessage::SyncStep2(update)).encode_v1());
                }
                Message::Sync(SyncMessage::SyncStep2(bytes))
                | Message::Sync(SyncMessage::Update(bytes)) => {
                    self.apply_locked(&mut state, conn, &bytes).await?;
                }
                Message::Awareness(update) => {
                    clients.extend(update.clients.keys().copied());
                    let encoded = update.encode_v1();
                    let frame = Message::Awareness(update.clone()).encode_v1();
                    state
                        .awareness
                        .apply_update(update)
                        .map_err(|_| RoomError::Invalid)?;
                    self.relay.publish_awareness(&self.attachment_id, &encoded);
                    self.broadcast(conn, frame);
                }
                Message::AwarenessQuery => {
                    let update = state.awareness.update().map_err(|_| RoomError::Invalid)?;
                    replies.push(Message::Awareness(update).encode_v1());
                }
                Message::Auth(_) | Message::Custom(_, _) => return Err(RoomError::Invalid),
            }
        }
        Ok(replies)
    }

    async fn apply_locked(
        &self,
        state: &mut RoomState,
        conn: u64,
        bytes: &[u8],
    ) -> Result<(), RoomError> {
        let update = Update::decode_v1(bytes).map_err(|_| RoomError::Invalid)?;
        let pending_before = pending_of(state.awareness.doc());
        let applied = state.awareness.doc().transact_mut().apply_update(update);
        let mut changes = take_changes(&state.taken);
        let taken = changes.len();
        // A change waiting for missing dependencies is not reported by the
        // observer. Store it as received, so it is not lost when those
        // dependencies arrive through a catch-up, which never stores again.
        if pending_of(state.awareness.doc()) != pending_before {
            changes.push(bytes.to_vec());
        }
        if !changes.is_empty() {
            self.store_locked(state, &changes).await?;
        }
        for change in changes.into_iter().take(taken) {
            self.broadcast(conn, Message::Sync(SyncMessage::Update(change)).encode_v1());
        }
        applied.map_err(|_| RoomError::Invalid)?;
        if state.since_compaction >= COMPACT_EVERY_UPDATES
            || (state.since_compaction > 0 && state.last_compaction.elapsed() >= COMPACT_EVERY)
        {
            if let Err(error) = self.compact_locked(state).await {
                eprintln!("[document-collab] compact: {error:?}");
            }
        }
        Ok(())
    }

    /// Stores the document's new changes and advances the room's sequence,
    /// catching up first when another process stored rows in between. A
    /// change that cannot be stored after one retry discards the room.
    async fn store_locked(
        &self,
        state: &mut RoomState,
        changes: &[Vec<u8>],
    ) -> Result<(), RoomError> {
        let pool = &self.relay.pool;
        let mark_initialized = !state.initialized;
        let appended =
            match store::append_updates(pool, &self.attachment_id, changes, mark_initialized).await
            {
                Ok(range) => Ok(range),
                Err(error) => {
                    eprintln!("[document-collab] append update, retrying: {error}");
                    tokio::time::sleep(APPEND_RETRY_AFTER).await;
                    store::append_updates(pool, &self.attachment_id, changes, mark_initialized)
                        .await
                }
            };
        let (first_seq, last_seq) = match appended {
            Ok(range) => range,
            Err(error) => {
                self.poison();
                return Err(RoomError::Database(error));
            }
        };
        state.initialized = true;
        state.since_compaction = state.since_compaction.saturating_add(changes.len() as u32);
        if first_seq == state.seq + 1 {
            state.seq = last_seq;
        } else if let Err(error) = self.catch_up_locked(state).await {
            // The sequence stays behind the gap; the next catch-up reads it.
            eprintln!("[document-collab] catch up after append: {error:?}");
        }
        Ok(())
    }

    /// Discards the room: its document holds a change that was never stored
    /// or broadcast. Every socket closes with "try again", and the registry
    /// hands the next editor a freshly loaded room.
    fn poison(&self) {
        self.poisoned.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Outgoing::Reset);
    }

    pub(super) async fn compact_locked(&self, state: &mut RoomState) -> Result<(), RoomError> {
        let (snapshot, state_vector) = {
            let txn = state.awareness.doc().transact();
            (
                txn.encode_state_as_update_v1(&StateVector::default()),
                txn.state_vector().encode_v1(),
            )
        };
        store::compact(
            &self.relay.pool,
            &self.attachment_id,
            &snapshot,
            &state_vector,
            state.seq,
        )
        .await?;
        state.since_compaction = 0;
        state.last_compaction = Instant::now();
        Ok(())
    }

    /// The room's sequence and full document, for tests.
    #[cfg(test)]
    pub(crate) async fn snapshot(&self) -> (i64, Vec<u8>) {
        let state = self.state.lock().await;
        let update = state
            .awareness
            .doc()
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        (state.seq, update)
    }
}

/// Decodes every message in a frame; anything malformed is unsupported.
pub(crate) fn decode_messages(data: &[u8]) -> Result<Vec<Message>, RoomError> {
    let mut decoder = DecoderV1::new(Cursor::new(data));
    let reader = MessageReader::new(&mut decoder);
    let mut messages = Vec::new();
    for message in reader {
        messages.push(message.map_err(|_| RoomError::Invalid)?);
    }
    if messages.is_empty() {
        return Err(RoomError::Invalid);
    }
    Ok(messages)
}
