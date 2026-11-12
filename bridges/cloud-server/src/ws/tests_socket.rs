//! A real gateway socket over a loopback listener: database errors no longer
//! close it, while a revocation signal or a session found gone still does.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::auth::session::IssuedSession;
use crate::auth::session_signals::{SessionSignal, SignalKind};
use crate::server::ServerState;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Harness {
    pool: PgPool,
    state: Arc<ServerState>,
    account_id: String,
    session: IssuedSession,
    socket: Socket,
}

async fn account_with_device(pool: &PgPool) -> (String, String) {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_gateway_{suffix}");
    let device_id = format!("dev_gateway_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Gateway', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices \
         (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Gateway device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    (account_id, device_id)
}

async fn open() -> Option<Harness> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let pool = crate::pg::init_pool(&url).await.expect("init test pool");
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let state = Arc::new(ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let router = crate::server::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let (mut socket, _) = connect_async(format!(
        "ws://{address}/v1/cloud/ws?token={}",
        session.plaintext_token
    ))
    .await
    .expect("gateway socket connects");
    let greeting = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("the gateway greets the client");
    assert!(matches!(greeting, Some(Ok(Message::Text(body))) if body.contains("connected")));
    Some(Harness {
        pool,
        state,
        account_id,
        session,
        socket,
    })
}

/// Whether the server closes the socket within `within`.
async fn closes_within(socket: &mut Socket, within: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        match tokio::time::timeout_at(deadline, socket.next()).await {
            Err(_) => return false,
            Ok(None | Some(Err(_)) | Some(Ok(Message::Close(_)))) => return true,
            Ok(Some(Ok(_))) => {}
        }
    }
}

fn signal(harness: &Harness, kind: SignalKind) -> SessionSignal {
    SessionSignal {
        account_id: harness.account_id.clone(),
        device_id: None,
        token_id: Some(harness.session.token_id.clone()),
        kind,
    }
}

#[tokio::test]
async fn database_errors_keep_the_socket_and_a_revocation_closes_it() {
    let Some(mut harness) = open().await else {
        return;
    };
    // Every check now fails. The old gateway closed on the first one,
    // within two seconds.
    harness.pool.close().await;
    let signals = harness.state.session_signals();
    signals.publish(signal(&harness, SignalKind::Recheck));
    assert!(
        !closes_within(&mut harness.socket, Duration::from_secs(3)).await,
        "a failing session check does not close the socket"
    );
    signals.publish(signal(&harness, SignalKind::Revoked));
    assert!(
        closes_within(&mut harness.socket, Duration::from_secs(2)).await,
        "a revocation signal closes the socket at once"
    );
}

#[tokio::test]
async fn a_session_found_gone_closes_at_the_next_check() {
    let Some(mut harness) = open().await else {
        return;
    };
    // Revoked without a signal, as if the notification were lost.
    crate::auth::session::revoke_session(&harness.pool, &harness.session.token_id)
        .await
        .unwrap();
    assert!(
        !closes_within(&mut harness.socket, Duration::from_millis(500)).await,
        "without a signal the socket waits for its next check"
    );
    harness
        .state
        .session_signals()
        .publish(signal(&harness, SignalKind::Recheck));
    assert!(
        closes_within(&mut harness.socket, Duration::from_secs(2)).await,
        "the check finds the session gone and closes"
    );
}
