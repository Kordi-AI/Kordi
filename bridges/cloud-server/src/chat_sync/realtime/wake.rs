use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx_core::query::query;
use sqlx_postgres::{PgListener, PgPoolOptions};
use tokio::sync::{broadcast, watch};

use crate::auth::session_cache::{HEARTBEAT_INTERVAL, HEARTBEAT_PAYLOAD};
use crate::auth::session_signals::{SessionSignal, SessionSignalHub, SESSION_SIGNAL_CHANNEL};
use crate::document_shares::collab::{RoomRegistry, COLLAB_CHANNEL};

const WAKE_CHANNEL: &str = "chat_sync_events";

/// Whether this replica's notification listener is connected. `epoch` grows
/// on every successful (re)connect, so sockets can catch up on anything a
/// disconnected listener may have missed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ListenerStatus {
    pub(crate) connected: bool,
    pub(crate) epoch: u64,
}

pub(crate) struct ChatSyncWakeHub {
    accounts: Mutex<HashMap<String, broadcast::Sender<()>>>,
    status: watch::Sender<ListenerStatus>,
}

impl ChatSyncWakeHub {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            accounts: Mutex::new(HashMap::new()),
            status: watch::channel(ListenerStatus::default()).0,
        })
    }

    /// The listener status, for sockets that adapt their backstop polling.
    pub(crate) fn listener_status(&self) -> watch::Receiver<ListenerStatus> {
        self.status.subscribe()
    }

    pub(super) fn set_listener_connected(&self, connected: bool) {
        self.status.send_modify(|status| {
            if connected && !status.connected {
                status.epoch += 1;
            }
            status.connected = connected;
        });
    }

    pub(super) fn subscribe(self: &Arc<Self>, account_id: &str) -> ChatSyncWakeSubscription {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let sender = accounts
            .entry(account_id.to_string())
            .or_insert_with(|| broadcast::channel(16).0);
        ChatSyncWakeSubscription {
            account_id: account_id.to_string(),
            receiver: sender.subscribe(),
            hub: self.clone(),
        }
    }

    pub(super) fn wake(&self, account_id: &str) {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if accounts
            .get(account_id)
            .is_some_and(|sender| sender.send(()).is_err())
        {
            accounts.remove(account_id);
        }
    }

    /// Called while the dropping subscription's own receiver still counts.
    fn release(&self, account_id: &str) {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if accounts
            .get(account_id)
            .is_some_and(|sender| sender.receiver_count() <= 1)
        {
            accounts.remove(account_id);
        }
    }
}

pub(super) struct ChatSyncWakeSubscription {
    account_id: String,
    pub(super) receiver: broadcast::Receiver<()>,
    hub: Arc<ChatSyncWakeHub>,
}

impl ChatSyncWakeSubscription {
    pub(super) async fn recv(&mut self) {
        let _ = self.receiver.recv().await;
    }
}

impl Drop for ChatSyncWakeSubscription {
    fn drop(&mut self) {
        self.hub.release(&self.account_id);
    }
}

/// Starts this replica's single notification listener: chat sync wakes,
/// session revocation signals, and collaboration room signals share one
/// PostgreSQL connection. Also starts the room registry's relay tasks and
/// the heartbeat that proves the listener live to the session lookup cache.
pub(crate) fn spawn_wake_listener(
    database_url: String,
    hub: Arc<ChatSyncWakeHub>,
    sessions: Arc<SessionSignalHub>,
    rooms: Arc<RoomRegistry>,
) {
    rooms.start();
    spawn_session_heartbeat(&database_url);
    crate::auth::session_metrics::spawn_reporter(sessions.clone());
    tokio::spawn(async move {
        loop {
            let result: Result<(), sqlx_core::Error> = async {
                let mut listener = PgListener::connect(&database_url).await?;
                listener
                    .listen_all([WAKE_CHANNEL, SESSION_SIGNAL_CHANNEL, COLLAB_CHANNEL])
                    .await?;
                hub.set_listener_connected(true);
                sessions.lookup_cache().set_listener_connected(true);
                rooms.listener_connected();
                // A first heartbeat on this connection, so the session
                // lookup cache knows at once that notifications arrive.
                send_heartbeat(&mut listener).await?;
                // `try_recv` reports a lost connection instead of silently
                // reconnecting, so the status (and the catch-up it drives)
                // follows every gap in which notifications may be lost.
                while let Some(notification) = listener.try_recv().await? {
                    sessions.lookup_cache().notification_received();
                    let payload = notification.payload().trim();
                    match notification.channel() {
                        SESSION_SIGNAL_CHANNEL => {
                            if let Some(signal) = SessionSignal::parse(payload) {
                                sessions.publish(signal);
                            }
                        }
                        // Never waits: room work runs in its own tasks.
                        COLLAB_CHANNEL => rooms.receive(payload),
                        _ if !payload.is_empty() => hub.wake(payload),
                        _ => {}
                    }
                }
                Ok(())
            }
            .await;
            hub.set_listener_connected(false);
            sessions.lookup_cache().set_listener_connected(false);
            match result {
                Ok(()) => eprintln!("[chat-realtime] notification listener: connection lost"),
                Err(error) => eprintln!("[chat-realtime] notification listener: {error}"),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

async fn send_heartbeat<'e, E>(executor: E) -> Result<(), sqlx_core::Error>
where
    E: sqlx_core::executor::Executor<'e, Database = sqlx_postgres::Postgres>,
{
    query("SELECT pg_notify($1, $2)")
        .bind(SESSION_SIGNAL_CHANNEL)
        .bind(HEARTBEAT_PAYLOAD)
        .execute(executor)
        .await
        .map(|_| ())
}

/// Sends a heartbeat notification every [`HEARTBEAT_INTERVAL`] over its own
/// connection. Every replica's listener receives it; while heartbeats stop
/// arriving, the session lookup cache is bypassed.
fn spawn_session_heartbeat(database_url: &str) {
    let pool = match PgPoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .acquire_timeout(HEARTBEAT_INTERVAL)
        .connect_lazy(database_url)
    {
        Ok(pool) => pool,
        Err(error) => {
            eprintln!("[chat-realtime] session heartbeat: {error}");
            return;
        }
    };
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            match tokio::time::timeout(HEARTBEAT_INTERVAL, send_heartbeat(&pool)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => eprintln!("[chat-realtime] session heartbeat: {error}"),
                Err(_) => eprintln!("[chat-realtime] session heartbeat: timed out"),
            }
        }
    });
}
