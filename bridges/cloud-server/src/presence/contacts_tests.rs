//! Contact presence against `$DATABASE_URL`: the set-based list must equal
//! the per-account rollup it replaced, row for row and in the same order.
//! Outside a database run these tests return early. Every account is
//! synthetic.

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{account_presence_status, contact_presence_summaries, presence_timeout};

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

struct Fixture {
    pool: PgPool,
    suffix: String,
    now: DateTime<Utc>,
}

impl Fixture {
    fn ago(&self, seconds: i64) -> String {
        (self.now - ChronoDuration::seconds(seconds)).to_rfc3339()
    }

    async fn account(&self, label: &str) -> String {
        let account_id = format!("acct_presence_{label}_{}", self.suffix);
        let now = self.now.to_rfc3339();
        query(
            "INSERT INTO cloud_accounts \
             (account_id, display_name, primary_email, created_at, updated_at, \
              avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
             VALUES ($1, $2, $3, $4, $4, 'generated', $5, $1, $6, 1, $4)",
        )
        .bind(&account_id)
        .bind(label)
        .bind(format!("{account_id}@example.test"))
        .bind(&now)
        .bind(crate::avatars::HUMAN_AVATAR_STYLE)
        .bind(crate::avatars::AVATAR_RENDERER_VERSION)
        .execute(&self.pool)
        .await
        .unwrap();
        account_id
    }

    async fn contact(&self, account_id: &str, peer_account_id: &str) {
        query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, $3)",
        )
        .bind(account_id)
        .bind(peer_account_id)
        .bind(self.now.to_rfc3339())
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// Adds a device with one presence row.
    async fn device(&self, account_id: &str, presence: DevicePresence<'_>) {
        let device_id = format!("dev_presence_{}", Uuid::new_v4().simple());
        query(
            "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
             created_at, last_seen_at, device_platform, revoked_at) \
             VALUES ($1, $2, 'Presence device', $3, $4, $4, $5, $6)",
        )
        .bind(&device_id)
        .bind(account_id)
        .bind(format!("legacy:{device_id}"))
        .bind(self.now.to_rfc3339())
        .bind(presence.platform)
        .bind(presence.revoked.then(|| self.now.to_rfc3339()))
        .execute(&self.pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_device_presence \
             (device_id, account_id, state, last_heartbeat_at, last_offline_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&device_id)
        .bind(account_id)
        .bind(presence.state)
        .bind(&presence.heartbeat)
        .bind(&presence.offline)
        .bind(self.now.to_rfc3339())
        .execute(&self.pool)
        .await
        .unwrap();
    }
}

struct DevicePresence<'a> {
    platform: Option<&'a str>,
    state: &'a str,
    heartbeat: Option<String>,
    offline: Option<String>,
    revoked: bool,
}

/// The list as the server built it before: the same id statement, then one
/// single-account rollup per id.
async fn per_account_reference(pool: &PgPool, account_id: &str) -> Vec<Value> {
    let ids: Vec<(String,)> = query_as(
        "SELECT $1::TEXT AS account_id \
         UNION \
         SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .unwrap();
    let now = Utc::now();
    let mut rows = Vec::new();
    for (id,) in ids {
        let summary = account_presence_status(pool, &id, now, presence_timeout())
            .await
            .unwrap();
        rows.push(serde_json::to_value(summary).unwrap());
    }
    rows
}

/// Serializes the list and drops `updatedAt`, which is the request time.
fn without_request_time(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut row = row.clone();
            row.as_object_mut().unwrap().remove("updatedAt");
            row
        })
        .collect()
}

async fn assert_matches_reference(f: &Fixture, viewer: &str) -> Vec<Value> {
    let listed: Vec<Value> = contact_presence_summaries(&f.pool, viewer)
        .await
        .unwrap()
        .into_iter()
        .map(|summary| serde_json::to_value(summary).unwrap())
        .collect();
    let reference = per_account_reference(&f.pool, viewer).await;
    assert_eq!(
        without_request_time(&listed),
        without_request_time(&reference)
    );
    let request_time = &listed[0]["updatedAt"];
    assert!(listed.iter().all(|row| &row["updatedAt"] == request_time));
    listed
}

fn row<'a>(rows: &'a [Value], account_id: &str) -> &'a Value {
    rows.iter()
        .find(|row| row["accountId"] == account_id)
        .unwrap_or_else(|| panic!("{account_id} is listed"))
}

#[tokio::test]
async fn contact_presence_matches_the_per_account_rollup() {
    let Some(pool) = pool().await else { return };
    let f = Fixture {
        pool,
        suffix: Uuid::new_v4().simple().to_string(),
        now: Utc::now(),
    };
    let device = |platform, state, heartbeat, offline, revoked| DevicePresence {
        platform,
        state,
        heartbeat,
        offline,
        revoked,
    };

    let viewer = f.account("viewer").await;
    f.device(
        &viewer,
        device(Some("desktop"), "online", Some(f.ago(3)), None, false),
    )
    .await;

    let mac_online = f.account("mac_online").await;
    f.device(
        &mac_online,
        device(Some("macos"), "online", Some(f.ago(5)), None, false),
    )
    .await;

    let phone_online = f.account("phone_online").await;
    f.device(
        &phone_online,
        device(Some("ios"), "online", Some(f.ago(4)), None, false),
    )
    .await;
    let mac_left_at = f.ago(600);
    f.device(
        &phone_online,
        device(
            Some(" MacOS "),
            "offline",
            Some(f.ago(900)),
            Some(mac_left_at.clone()),
            false,
        ),
    )
    .await;

    let stale = f.account("stale").await;
    let stale_heartbeat = f.ago(600);
    f.device(
        &stale,
        device(
            Some("macos"),
            "online",
            Some(stale_heartbeat.clone()),
            None,
            false,
        ),
    )
    .await;

    let offline = f.account("offline").await;
    let offline_at = (f.now - ChronoDuration::seconds(3600))
        .format("%Y-%m-%dT%H:%M:%S%.fZ")
        .to_string();
    f.device(
        &offline,
        device(
            None,
            "offline",
            Some(f.ago(7200)),
            Some(offline_at.clone()),
            false,
        ),
    )
    .await;

    let revoked_only = f.account("revoked_only").await;
    f.device(
        &revoked_only,
        device(Some("macos"), "online", Some(f.ago(2)), None, true),
    )
    .await;

    let never_signed_in = f.account("never_signed_in").await;

    let incoming_only = f.account("incoming_only").await;
    f.device(
        &incoming_only,
        device(Some("macos"), "online", Some(f.ago(2)), None, false),
    )
    .await;
    f.contact(&incoming_only, &viewer).await;

    let stranger = f.account("stranger").await;
    f.device(
        &stranger,
        device(Some("macos"), "online", Some(f.ago(2)), None, false),
    )
    .await;

    let deleted = f.account("deleted").await;
    f.device(
        &deleted,
        device(Some("macos"), "online", Some(f.ago(2)), None, false),
    )
    .await;

    for peer in [
        &mac_online,
        &phone_online,
        &stale,
        &offline,
        &revoked_only,
        &never_signed_in,
        &deleted,
    ] {
        f.contact(&viewer, peer).await;
    }
    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&deleted)
        .execute(&f.pool)
        .await
        .unwrap();

    let listed = assert_matches_reference(&f, &viewer).await;
    let mut ids: Vec<&str> = listed
        .iter()
        .map(|row| row["accountId"].as_str().unwrap())
        .collect();
    ids.sort_unstable();
    let mut expected = vec![
        viewer.as_str(),
        mac_online.as_str(),
        phone_online.as_str(),
        stale.as_str(),
        offline.as_str(),
        revoked_only.as_str(),
        never_signed_in.as_str(),
    ];
    expected.sort_unstable();
    assert_eq!(ids, expected, "self and own contacts only");

    let rfc3339 = |raw: &str| {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
            .to_rfc3339()
    };
    let me = row(&listed, &viewer);
    assert_eq!(me["status"], "online");
    assert_eq!(me["desktopOnline"], true);
    let mac = row(&listed, &mac_online);
    assert_eq!(mac["status"], "online");
    assert_eq!(mac["desktopOnline"], true);
    assert_eq!(mac["lastSeenAt"], Value::Null);
    let phone = row(&listed, &phone_online);
    assert_eq!(phone["status"], "online");
    assert_eq!(phone["lastSeenAt"], Value::Null);
    assert_eq!(phone["desktopOnline"], false);
    assert_eq!(phone["desktopLastSeenAt"], rfc3339(&mac_left_at));
    let stale_row = row(&listed, &stale);
    assert_eq!(stale_row["status"], "offline");
    assert_eq!(stale_row["lastSeenAt"], rfc3339(&stale_heartbeat));
    assert_eq!(stale_row["desktopLastSeenAt"], rfc3339(&stale_heartbeat));
    let offline_row = row(&listed, &offline);
    assert_eq!(offline_row["status"], "offline");
    assert_eq!(offline_row["lastSeenAt"], rfc3339(&offline_at));
    assert_eq!(offline_row["desktopLastSeenAt"], Value::Null);
    for quiet in [&revoked_only, &never_signed_in] {
        let quiet_row = row(&listed, quiet);
        assert_eq!(quiet_row["status"], "offline");
        assert_eq!(quiet_row["lastSeenAt"], Value::Null);
        assert_eq!(quiet_row["desktopOnline"], false);
        assert_eq!(quiet_row["desktopLastSeenAt"], Value::Null);
    }

    // A longer list keeps matching the per-account rollup.
    for index in 0..10 {
        let peer = f.account(&format!("extra_{index}")).await;
        if index % 2 == 0 {
            f.device(
                &peer,
                device(Some("macos"), "online", Some(f.ago(index)), None, false),
            )
            .await;
        }
        f.contact(&viewer, &peer).await;
    }
    let longer = assert_matches_reference(&f, &viewer).await;
    assert_eq!(longer.len(), 17);
}

#[tokio::test]
async fn an_account_without_contacts_lists_only_itself() {
    let Some(pool) = pool().await else { return };
    let f = Fixture {
        pool,
        suffix: Uuid::new_v4().simple().to_string(),
        now: Utc::now(),
    };
    let lonely = f.account("lonely").await;
    let listed = assert_matches_reference(&f, &lonely).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["accountId"], lonely);
    assert_eq!(listed[0]["status"], "offline");
}
