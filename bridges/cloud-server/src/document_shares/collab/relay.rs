//! Signals between server processes holding the same collaboration room.
//!
//! Every process listens on [`COLLAB_CHANNEL`] through its single
//! notification listener. Three payloads travel on it:
//!
//! - `u:<attachment_id>:<seq>`: updates up to `seq` were stored. Sent by
//!   the appending transaction, so it arrives after the rows are visible;
//!   a process holding the room reads them from storage.
//! - `a:<origin>:<attachment_id>:<base64>`: an awareness update (cursors,
//!   presence) from the process `origin`. Ephemeral and loss-tolerant.
//! - `q:<origin>:<attachment_id>`: `origin` just loaded the room; others
//!   holding it answer with their current awareness.
//!
//! Awareness payloads leave through a bounded queue drained by one task,
//! so a socket never waits on the database to share a cursor; when the
//! queue is full the payload is dropped.

use std::sync::Mutex as StdMutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tokio::sync::mpsc;

/// The PostgreSQL notification channel for collaboration rooms.
pub(crate) const COLLAB_CHANNEL: &str = "cloud_document_collab";
/// PostgreSQL refuses notification payloads of 8000 bytes or more.
pub(crate) const MAX_PAYLOAD_BYTES: usize = 7_900;
const OUTBOX_CAPACITY: usize = 256;

/// One parsed notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Signal {
    Update {
        attachment_id: String,
        seq: i64,
    },
    Awareness {
        origin: String,
        attachment_id: String,
        update: Vec<u8>,
    },
    Query {
        origin: String,
        attachment_id: String,
    },
}

pub(crate) fn update_payload(attachment_id: &str, seq: i64) -> String {
    format!("u:{attachment_id}:{seq}")
}

/// The awareness payload, or `None` when it would be too large to send.
pub(crate) fn awareness_payload(
    origin: &str,
    attachment_id: &str,
    update: &[u8],
) -> Option<String> {
    let payload = format!("a:{origin}:{attachment_id}:{}", STANDARD.encode(update));
    (payload.len() <= MAX_PAYLOAD_BYTES).then_some(payload)
}

pub(crate) fn query_payload(origin: &str, attachment_id: &str) -> String {
    format!("q:{origin}:{attachment_id}")
}

impl Signal {
    /// Parses a payload; anything malformed is `None`. Origins and base64
    /// never contain `:`, so an attachment id may.
    pub(crate) fn parse(payload: &str) -> Option<Self> {
        let (kind, rest) = payload.split_once(':')?;
        let signal = match kind {
            "u" => {
                let (attachment_id, seq) = rest.rsplit_once(':')?;
                Self::Update {
                    attachment_id: attachment_id.to_string(),
                    seq: seq.parse().ok().filter(|seq| *seq >= 1)?,
                }
            }
            "a" => {
                let (origin, rest) = rest.split_once(':')?;
                let (attachment_id, data) = rest.rsplit_once(':')?;
                Self::Awareness {
                    origin: origin.to_string(),
                    attachment_id: attachment_id.to_string(),
                    update: STANDARD.decode(data).ok().filter(|data| !data.is_empty())?,
                }
            }
            "q" => {
                let (origin, attachment_id) = rest.split_once(':')?;
                Self::Query {
                    origin: origin.to_string(),
                    attachment_id: attachment_id.to_string(),
                }
            }
            _ => return None,
        };
        let well_formed = match &signal {
            Self::Update { attachment_id, .. } => !attachment_id.is_empty(),
            Self::Awareness {
                origin,
                attachment_id,
                ..
            }
            | Self::Query {
                origin,
                attachment_id,
            } => !origin.is_empty() && !attachment_id.is_empty(),
        };
        well_formed.then_some(signal)
    }
}

/// This process's side of the relay: its origin id, its database pool, and
/// the queue of outgoing awareness payloads.
pub(crate) struct Relay {
    pub(crate) pool: PgPool,
    pub(crate) origin: String,
    outbox: mpsc::Sender<String>,
    unstarted: StdMutex<Option<mpsc::Receiver<String>>>,
}

impl Relay {
    pub(crate) fn new(pool: PgPool) -> Self {
        let (outbox, inbox) = mpsc::channel(OUTBOX_CAPACITY);
        Self {
            pool,
            origin: uuid::Uuid::new_v4().simple().to_string(),
            outbox,
            unstarted: StdMutex::new(Some(inbox)),
        }
    }

    /// Shares an encoded awareness update with the other processes.
    pub(crate) fn publish_awareness(&self, attachment_id: &str, update: &[u8]) {
        if let Some(payload) = awareness_payload(&self.origin, attachment_id, update) {
            let _ = self.outbox.try_send(payload);
        }
    }

    /// Asks the other processes holding the room for their awareness.
    pub(crate) fn query_awareness(&self, attachment_id: &str) {
        let _ = self
            .outbox
            .try_send(query_payload(&self.origin, attachment_id));
    }

    /// Starts the task that sends queued payloads, one at a time. Returns
    /// whether this call started it; later calls do nothing.
    pub(crate) fn start(&self) -> bool {
        let inbox = self
            .unstarted
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(mut inbox) = inbox else {
            return false;
        };
        let pool = self.pool.clone();
        tokio::spawn(async move {
            while let Some(payload) = inbox.recv().await {
                if let Err(error) = query("SELECT pg_notify($1, $2)")
                    .bind(COLLAB_CHANNEL)
                    .bind(&payload)
                    .execute(&pool)
                    .await
                {
                    eprintln!("[document-collab] relay awareness: {error}");
                }
            }
        });
        true
    }
}
