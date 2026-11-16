//! Refresh hints a Grounding transaction sends once its own writes are done.
//!
//! Each hint advances the account's sync head, which holds that row's lock
//! until the transaction commits. A large room finishes many match runs at
//! once, each hinting an overlapping set of accounts, so hints go last and
//! in account order: two such transactions then wait for each other instead
//! of deadlocking. Hints only ask clients to refresh, so a failed one is
//! logged and dropped; it never fails the transaction that stored a result
//! or failed a run.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use sqlx_core::{query::query, transaction::Transaction};
use sqlx_postgres::Postgres;

#[derive(Debug, Default)]
pub(super) struct Hints {
    events: BTreeMap<String, Vec<(&'static str, Value)>>,
    nearby: BTreeSet<String>,
}

impl Hints {
    pub(super) fn add(&mut self, account: &str, event_type: &'static str, payload: Value) {
        self.events
            .entry(account.to_string())
            .or_default()
            .push((event_type, payload));
    }

    /// Also marks the account's Nearby results for a refresh
    /// (`nearby::run_finished`).
    pub(super) fn nearby(&mut self, account: &str) {
        self.nearby.insert(account.to_string());
    }

    /// Sends every hint, by account, under a savepoint: a failure rolls back
    /// only the hints.
    pub(super) async fn send(self, tx: &mut Transaction<'_, Postgres>) -> sqlx_core::Result<()> {
        if self.events.is_empty() && self.nearby.is_empty() {
            return Ok(());
        }
        query("SAVEPOINT common_ground_hints")
            .execute(&mut **tx)
            .await?;
        let end = match self.send_all(tx).await {
            Ok(()) => "RELEASE SAVEPOINT common_ground_hints",
            Err(error) => {
                eprintln!("[common-ground] Dropped refresh hints: {error}");
                "ROLLBACK TO SAVEPOINT common_ground_hints"
            }
        };
        query(end).execute(&mut **tx).await?;
        Ok(())
    }

    async fn send_all(&self, tx: &mut Transaction<'_, Postgres>) -> Result<(), String> {
        let accounts: BTreeSet<&String> = self.events.keys().chain(&self.nearby).collect();
        for account in accounts {
            for (event_type, payload) in self.events.get(account).into_iter().flatten() {
                crate::chat_sync::store::append_account_hint(tx, account, event_type, payload)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            if self.nearby.contains(account) {
                super::nearby::run_finished(tx, account)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}
