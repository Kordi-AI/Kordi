//! The rooms this process holds, and the signals that keep them in step
//! with the other processes holding the same documents.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use sqlx_postgres::PgPool;
use tokio::sync::RwLock;
use yrs::block::ClientID;

use super::relay::{Relay, Signal};
use super::rooms::{Room, RoomError};
use super::store;

/// How often every loaded room checks for updates whose notification was
/// lost, for example while the listener reconnected.
const CATCH_UP_EVERY: Duration = Duration::from_secs(30);

pub struct RoomRegistry {
    rooms: RwLock<HashMap<String, Arc<Room>>>,
    relay: Arc<Relay>,
}

impl RoomRegistry {
    pub fn new(pool: PgPool) -> Arc<Self> {
        Arc::new(Self {
            rooms: RwLock::new(HashMap::new()),
            relay: Arc::new(Relay::new(pool)),
        })
    }

    /// Starts the awareness sender and the periodic catch-up. The
    /// notification listener calls this once; later calls do nothing.
    pub(crate) fn start(self: &Arc<Self>) {
        if !self.relay.start() {
            return;
        }
        let registry = self.clone();
        tokio::spawn(async move {
            let start = tokio::time::Instant::now() + CATCH_UP_EVERY;
            let mut interval = tokio::time::interval_at(start, CATCH_UP_EVERY);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                registry.catch_up_all().await;
            }
        });
    }

    /// Joins the room for `attachment_id`, loading it from storage when this
    /// process holds none or holds one that was discarded. A room that was
    /// already loaded catches up first, so the greeting is current.
    pub(crate) async fn join(&self, attachment_id: &str) -> Result<Arc<Room>, RoomError> {
        if let Some(room) = self.connect_loaded(attachment_id).await {
            room.catch_up().await;
            return Ok(room);
        }
        let loaded = Arc::new(Room::load(self.relay.clone(), attachment_id).await?);
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get(attachment_id).cloned() {
            if room.try_connect().await {
                drop(rooms);
                room.catch_up().await;
                return Ok(room);
            }
        }
        loaded.try_connect().await;
        rooms.insert(attachment_id.to_string(), loaded.clone());
        drop(rooms);
        self.relay.query_awareness(attachment_id);
        Ok(loaded)
    }

    async fn connect_loaded(&self, attachment_id: &str) -> Option<Arc<Room>> {
        let rooms = self.rooms.read().await;
        let room = rooms.get(attachment_id)?;
        room.try_connect().await.then(|| room.clone())
    }

    /// Leaves the room: clears the connection's awareness states for the
    /// others, and on the last leave compacts and unloads the room.
    pub(crate) async fn leave(&self, room: &Arc<Room>, conn: u64, clients: &HashSet<ClientID>) {
        if !room.disconnect(conn, clients).await {
            return;
        }
        let mut rooms = self.rooms.write().await;
        if room.is_idle().await
            && rooms
                .get(&room.attachment_id)
                .is_some_and(|current| Arc::ptr_eq(current, room))
        {
            rooms.remove(&room.attachment_id);
        }
    }

    async fn loaded(&self, attachment_id: &str) -> Option<Arc<Room>> {
        let rooms = self.rooms.read().await;
        rooms
            .get(attachment_id)
            .filter(|room| !room.is_poisoned())
            .cloned()
    }

    /// Handles one notification from [`super::COLLAB_CHANNEL`]. Never waits:
    /// the listener that calls it also carries chat wakes, so the work runs
    /// in its own task. Malformed payloads are ignored.
    pub(crate) fn receive(self: &Arc<Self>, payload: &str) {
        let Some(signal) = Signal::parse(payload) else {
            return;
        };
        let registry = self.clone();
        tokio::spawn(async move { registry.handle_signal(signal).await });
    }

    async fn handle_signal(&self, signal: Signal) {
        match signal {
            Signal::Update { attachment_id, seq } => {
                if let Some(room) = self.loaded(&attachment_id).await {
                    room.catch_up_to(seq).await;
                }
            }
            Signal::Awareness {
                origin,
                attachment_id,
                update,
            } if origin != self.relay.origin => {
                if let Some(room) = self.loaded(&attachment_id).await {
                    room.apply_remote_awareness(&update).await;
                }
            }
            Signal::Query {
                origin,
                attachment_id,
            } if origin != self.relay.origin => {
                if let Some(room) = self.loaded(&attachment_id).await {
                    room.answer_awareness_query().await;
                }
            }
            Signal::Awareness { .. } | Signal::Query { .. } => {}
        }
    }

    /// After the listener (re)connects: notifications sent while it was
    /// down may be lost, so every loaded room catches up in the background.
    pub(crate) fn listener_connected(self: &Arc<Self>) {
        let registry = self.clone();
        tokio::spawn(async move { registry.catch_up_all().await });
    }

    /// Catches up every loaded room that is behind the stored log.
    pub(crate) async fn catch_up_all(&self) {
        let rooms: Vec<Arc<Room>> = {
            let rooms = self.rooms.read().await;
            rooms
                .values()
                .filter(|room| !room.is_poisoned())
                .cloned()
                .collect()
        };
        if rooms.is_empty() {
            return;
        }
        let ids: Vec<String> = rooms
            .iter()
            .map(|room| room.attachment_id.clone())
            .collect();
        let heads: HashMap<String, i64> = match store::heads(&self.relay.pool, &ids).await {
            Ok(heads) => heads.into_iter().collect(),
            Err(error) => {
                eprintln!("[document-collab] read room heads: {error}");
                return;
            }
        };
        for room in rooms {
            if let Some(head) = heads.get(&room.attachment_id) {
                room.catch_up_to(*head).await;
            }
        }
    }
}
