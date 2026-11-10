//! Helpers for collaboration tests that run several server instances (one
//! per process in production, behind a load balancer without affinity)
//! against one database, and editors that talk to them over sockets.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use sqlx_postgres::PgPool;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use yrs::encoding::read::Cursor;
use yrs::sync::{Message, MessageReader, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::Encode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update};

use super::db_fixture::*;
use crate::attachments::S3Config;
use crate::document_shares::collab::{Room, RoomRegistry};
use crate::events::EventBus;
use crate::server::ServerState;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// One server instance with its own pool, room registry and, when asked,
/// its own notification listener.
pub(super) struct Instance {
    pub(super) state: Arc<ServerState>,
    pub(super) base: String,
}

pub(super) async fn instance(listen: bool) -> Instance {
    let pool = pool().await.expect("DATABASE_URL is set");
    let s3 = S3Config {
        endpoint: url::Url::parse(&storage_stub().await).unwrap(),
        region: "us-east-1".into(),
        bucket: "documents".into(),
        access_key: "test-access".into(),
        secret_key: "test-secret".into(),
    };
    let state = Arc::new(ServerState::new(pool, EventBus::noop()).with_s3(s3));
    if listen {
        crate::chat_sync::realtime::spawn_wake_listener(
            std::env::var("DATABASE_URL").unwrap(),
            state.chat_sync_wakes().clone(),
            state.session_signals().clone(),
            state.document_rooms().clone(),
        );
        let mut status = state.chat_sync_wakes().listener_status();
        tokio::time::timeout(
            Duration::from_secs(10),
            status.wait_for(|status| status.connected),
        )
        .await
        .expect("listener connects")
        .expect("listener status is live");
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("ws://{}", listener.local_addr().unwrap());
    let app = crate::server::router(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Instance { state, base }
}

pub(super) async fn ticket(f: &Fixture, token: &str) -> Value {
    let uri = format!("/v1/cloud/documents/{}/collab/ticket", f.attachment_id);
    let (status, body) = send(&f.app, "POST", &uri, Some(token), None).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    body
}

pub(super) fn text_of(doc: &Doc) -> String {
    let text = doc.get_or_insert_text("document");
    text.get_string(&doc.transact())
}

/// Appends `fragment` to `doc`'s text and returns the update.
pub(super) fn append_text(doc: &Doc, fragment: &str) -> Vec<u8> {
    let text = doc.get_or_insert_text("document");
    let mut txn = doc.transact_mut();
    let end = text.len(&txn);
    text.insert(&mut txn, end, fragment);
    txn.encode_update_v1()
}

pub(super) fn update_frame(update: Vec<u8>) -> Vec<u8> {
    Message::Sync(SyncMessage::Update(update)).encode_v1()
}

/// Feeds `fragment`, typed into `doc`, to `room` as connection 1 would.
pub(super) async fn type_into(room: &Room, doc: &Doc, fragment: &str) {
    let frame = update_frame(append_text(doc, fragment));
    room.handle(1, &frame, &mut HashSet::new()).await.unwrap();
}

/// The text of a full-state update.
pub(super) fn text_of_update(update: &[u8]) -> String {
    let doc = Doc::new();
    doc.transact_mut()
        .apply_update(Update::decode_v1(update).unwrap())
        .unwrap();
    text_of(&doc)
}

/// The text a newly started process loads from storage.
pub(super) async fn stored_text(pool: &PgPool, attachment_id: &str) -> String {
    let room = RoomRegistry::new(pool.clone())
        .join(attachment_id)
        .await
        .unwrap();
    text_of_update(&room.snapshot().await.1)
}

/// An editor connected over a socket. Sync updates it receives are applied
/// to its document as they arrive; awareness messages wait in `stash`.
pub(super) struct Peer {
    socket: Socket,
    pub(super) doc: Doc,
    pub(super) stash: VecDeque<Message>,
}

impl Peer {
    /// Opens a socket on `instance` and completes the sync handshake.
    pub(super) async fn join(f: &Fixture, instance: &Instance, token: &str, doc: Doc) -> Self {
        let ticket = ticket(f, token).await;
        let url = format!(
            "{}{}?ticket={}",
            instance.base,
            ticket["url"].as_str().unwrap(),
            ticket["ticket"].as_str().unwrap()
        );
        let mut peer = Self {
            socket: connect_async(url).await.unwrap().0,
            doc,
            stash: VecDeque::new(),
        };
        let server_sv = loop {
            let messages = peer.read_frame().await.expect("greeting");
            let mut step1 = None;
            for message in messages {
                match message {
                    Message::Sync(SyncMessage::SyncStep1(sv)) => step1 = Some(sv),
                    other => peer.absorb(other),
                }
            }
            if let Some(sv) = step1 {
                break sv;
            }
        };
        let step2 = peer.doc.transact().encode_state_as_update_v1(&server_sv);
        let step1 = peer.doc.transact().state_vector();
        peer.send(Message::Sync(SyncMessage::SyncStep2(step2)))
            .await;
        peer.send(Message::Sync(SyncMessage::SyncStep1(step1)))
            .await;
        loop {
            let messages = peer.read_frame().await.expect("sync step 2");
            let mut synced = false;
            for message in messages {
                synced |= matches!(message, Message::Sync(SyncMessage::SyncStep2(_)));
                peer.absorb(message);
            }
            if synced {
                return peer;
            }
        }
    }

    pub(super) async fn send(&mut self, message: Message) {
        self.socket
            .send(WsMessage::Binary(message.encode_v1()))
            .await
            .unwrap();
    }

    /// Types `fragment` at the end of the document and sends the update.
    pub(super) async fn type_text(&mut self, fragment: &str) {
        let update = append_text(&self.doc, fragment);
        self.send(Message::Sync(SyncMessage::Update(update))).await;
    }

    pub(super) fn text(&self) -> String {
        text_of(&self.doc)
    }

    /// The messages of the next frame, or the close code.
    async fn read_frame_within(&mut self, window: Duration) -> Option<Result<Vec<Message>, u16>> {
        loop {
            let frame = tokio::time::timeout(window, self.socket.next())
                .await
                .ok()?;
            return Some(match frame {
                Some(Ok(WsMessage::Binary(data))) => {
                    let mut decoder = DecoderV1::new(Cursor::new(&data));
                    Ok(MessageReader::new(&mut decoder)
                        .map(Result::unwrap)
                        .collect())
                }
                Some(Ok(WsMessage::Close(frame))) => {
                    Err(frame.map_or(1005, |frame| u16::from(frame.code)))
                }
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => Err(1006),
            });
        }
    }

    async fn read_frame(&mut self) -> Result<Vec<Message>, u16> {
        self.read_frame_within(Duration::from_secs(5))
            .await
            .expect("a frame within 5 seconds")
    }

    fn absorb(&mut self, message: Message) {
        match message {
            Message::Sync(SyncMessage::Update(update))
            | Message::Sync(SyncMessage::SyncStep2(update)) => {
                self.doc
                    .transact_mut()
                    .apply_update(Update::decode_v1(&update).unwrap())
                    .unwrap();
            }
            other => self.stash.push_back(other),
        }
    }

    /// Reads frames until none arrives within `window`; panics on close.
    pub(super) async fn pump_for(&mut self, window: Duration) {
        while let Some(frame) = self.read_frame_within(window).await {
            for message in frame.expect("the socket stays open") {
                self.absorb(message);
            }
        }
    }

    /// Reads frames until `done` holds for the document.
    pub(super) async fn sync_until(&mut self, done: impl Fn(&str) -> bool) {
        for _ in 0..100 {
            if done(&self.text()) {
                return;
            }
            self.pump_for(Duration::from_millis(100)).await;
        }
        panic!(
            "the document never reached the expected text: {}",
            self.text()
        );
    }

    /// The next awareness message (stashed or arriving) that satisfies `want`.
    pub(super) async fn awareness_until(
        &mut self,
        want: impl Fn(&yrs::sync::AwarenessUpdate) -> bool,
    ) -> yrs::sync::AwarenessUpdate {
        loop {
            while let Some(message) = self.stash.pop_front() {
                if let Message::Awareness(update) = message {
                    if want(&update) {
                        return update;
                    }
                }
            }
            let messages = self.read_frame().await.expect("the socket stays open");
            for message in messages {
                self.absorb(message);
            }
        }
    }

    /// The close code the server sends next, skipping frames.
    pub(super) async fn close_code(&mut self) -> u16 {
        loop {
            if let Err(code) = self.read_frame().await {
                return code;
            }
        }
    }

    /// Whether no frame at all arrives within `window`.
    pub(super) async fn stays_quiet(&mut self, window: Duration) -> bool {
        self.stash.is_empty() && self.read_frame_within(window).await.is_none()
    }

    /// Checks the socket still answers: sync step 1 gets step 2 back.
    pub(super) async fn assert_open(&mut self) {
        self.send(Message::Sync(
            SyncMessage::SyncStep1(StateVector::default()),
        ))
        .await;
        loop {
            let messages = self.read_frame().await.expect("the socket stays open");
            let answered = messages
                .iter()
                .any(|message| matches!(message, Message::Sync(SyncMessage::SyncStep2(_))));
            for message in messages {
                self.absorb(message);
            }
            if answered {
                return;
            }
        }
    }

    pub(super) async fn close(mut self) {
        self.socket.close(None).await.unwrap();
    }
}
