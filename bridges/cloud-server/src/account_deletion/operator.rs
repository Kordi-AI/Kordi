//! `kordi-cloud-server delete-accounts` (docs/development/account-deletion.md):
//! an operator deletes a list of accounts while everyone else keeps their
//! history, direct conversations with the deleted accounts included.
//!
//! [`plan`] resolves every entry and refuses before anything changes. A dry
//! run ([`dry_run`]) deletes each account in its own transaction and rolls it
//! back, so it changes nothing and contacts no provider. A confirmed run
//! ([`run`]) deletes one account at a time, each in its own transaction, with
//! the same steps as the self-serve route: [`super::prepare`], then
//! [`super::delete_and_record`] with [`DirectConversations::Keep`], then
//! [`super::finish`].

use std::collections::{BTreeMap, BTreeSet};

use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::{Deletion, DirectConversations};
use crate::server::ServerState;

/// The audit record's `proof` for a deletion an operator ran.
pub const OPERATOR_PROOF: &str = "operator";

/// The entries of a list file: one account id or email per line. Blank
/// lines are skipped, and so is everything from a `#` that starts a line or
/// follows a space.
pub fn parse_entries(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| {
            let end = line
                .char_indices()
                .find(|&(index, c)| {
                    c == '#' && (index == 0 || line[..index].ends_with(char::is_whitespace))
                })
                .map_or(line.len(), |(index, _)| index);
            line[..end].trim()
        })
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// An entry of the delete list and the account it names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub entry: String,
    pub account_id: String,
}

/// Why the command does not start: every problem found, in list order.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal(pub Vec<String>);

impl std::fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Nothing was changed:")?;
        for problem in &self.0 {
            write!(formatter, "\n  - {problem}")?;
        }
        Ok(())
    }
}

/// Accounts an entry names: by account id, primary email, or a verified
/// sign-in email, ignoring case.
async fn resolve(pool: &PgPool, entry: &str) -> Result<Vec<String>, sqlx_core::Error> {
    let rows: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_accounts WHERE account_id = $1 \
         UNION SELECT account_id FROM cloud_accounts WHERE lower(primary_email) = lower($1) \
         UNION SELECT account_id FROM cloud_account_identities \
           WHERE email_verified AND lower(email) = lower($1) \
         ORDER BY 1",
    )
    .bind(entry)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Accounts the server runs on its own: the service accounts and the
/// owners of system-managed agents.
async fn protected_accounts(pool: &PgPool) -> Result<BTreeSet<String>, sqlx_core::Error> {
    let owners: Vec<(String,)> = query_as(
        "SELECT DISTINCT owner_account_id FROM cloud_agent_definitions WHERE is_system_managed",
    )
    .fetch_all(pool)
    .await?;
    let mut protected: BTreeSet<String> = crate::system_account::service_account_ids()
        .into_iter()
        .collect();
    protected.insert(crate::deleted_account::DELETED_ACCOUNT_ID.to_string());
    protected.extend(owners.into_iter().map(|(id,)| id));
    Ok(protected)
}

/// Resolves both lists. Refuses when the delete list is empty, when an
/// entry names no account or more than one, when an account is on both
/// lists, or when it is one the server runs. An account named twice is
/// deleted once.
pub async fn plan(
    pool: &PgPool,
    delete: &[String],
    keep: &[String],
) -> Result<Result<Vec<Target>, Refusal>, sqlx_core::Error> {
    let mut problems = Vec::new();
    if delete.is_empty() {
        problems.push("The delete list is empty.".to_string());
    }
    let mut kept: BTreeMap<String, String> = BTreeMap::new();
    for entry in keep {
        match resolve(pool, entry).await?.as_slice() {
            [account_id] => {
                kept.entry(account_id.clone())
                    .or_insert_with(|| entry.clone());
            }
            [] => problems.push(format!("Keep entry {entry:?} matches no account.")),
            many => problems.push(format!(
                "Keep entry {entry:?} matches {} accounts.",
                many.len()
            )),
        }
    }
    let protected = protected_accounts(pool).await?;
    let mut targets: Vec<Target> = Vec::new();
    for entry in delete {
        let account_id = match resolve(pool, entry).await?.as_slice() {
            [account_id] => account_id.clone(),
            [] => {
                problems.push(format!("Delete entry {entry:?} matches no account."));
                continue;
            }
            many => {
                problems.push(format!(
                    "Delete entry {entry:?} matches {} accounts.",
                    many.len()
                ));
                continue;
            }
        };
        if protected.contains(&account_id) {
            problems.push(format!(
                "Delete entry {entry:?} is an account the server runs ({account_id})."
            ));
        }
        if let Some(keep_entry) = kept.get(&account_id) {
            problems.push(format!(
                "Delete entry {entry:?} and keep entry {keep_entry:?} are the same account \
                 ({account_id})."
            ));
        }
        if !targets.iter().any(|target| target.account_id == account_id) {
            targets.push(Target {
                entry: entry.clone(),
                account_id,
            });
        }
    }
    Ok(if problems.is_empty() {
        Ok(targets)
    } else {
        Err(Refusal(problems))
    })
}

/// How one account went.
#[derive(Debug)]
pub struct Outcome {
    pub target: Target,
    pub result: Result<Deletion, String>,
}

impl Outcome {
    /// One line for the operator: the counts, or the error.
    pub fn line(&self) -> String {
        let Target { entry, account_id } = &self.target;
        match &self.result {
            Ok(deletion) => {
                let conversations = &deletion.conversations;
                format!(
                    "{entry} ({account_id}): conversations deleted {}, kept {}, direct kept {}, \
                     direct emptied {}, groups transferred {}; devices {}; objects queued {}",
                    conversations.deleted,
                    conversations.kept,
                    conversations.direct_kept,
                    conversations.direct,
                    conversations.transferred,
                    deletion.devices.len(),
                    deletion.queued_objects,
                )
            }
            Err(error) => format!("{entry} ({account_id}): failed: {error}"),
        }
    }
}

/// Locks the account row, as the self-serve route does before deleting.
async fn lock(tx: &mut Transaction<'_, Postgres>, account_id: &str) -> Result<(), String> {
    let found: Option<(String,)> =
        query_as("SELECT account_id FROM cloud_accounts WHERE account_id = $1 FOR UPDATE")
            .bind(account_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|error| error.to_string())?;
    found
        .map(|_| ())
        .ok_or_else(|| "the account no longer exists".to_string())
}

async fn delete_one(pool: &PgPool, account_id: &str, commit: bool) -> Result<Deletion, String> {
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    lock(&mut tx, account_id).await?;
    let deletion = super::delete_and_record(
        &mut tx,
        account_id,
        DirectConversations::Keep,
        OPERATOR_PROOF,
    )
    .await
    .map_err(|error| error.to_string())?;
    if commit {
        tx.commit().await
    } else {
        tx.rollback().await
    }
    .map_err(|error| error.to_string())?;
    Ok(deletion)
}

/// Deletes each account in its own transaction and rolls it back. Each
/// account is measured on its own: a direct conversation between two
/// accounts on the list counts as kept for both, while a confirmed run keeps
/// it with the first and deletes it with the second.
pub async fn dry_run(pool: &PgPool, targets: &[Target]) -> Vec<Outcome> {
    let mut outcomes = Vec::with_capacity(targets.len());
    for target in targets {
        let result = delete_one(pool, &target.account_id, false).await;
        outcomes.push(Outcome {
            target: target.clone(),
            result,
        });
    }
    outcomes
}

/// Deletes the accounts one at a time and goes on past a failure.
pub async fn run(state: &ServerState, targets: &[Target]) -> Vec<Outcome> {
    let mut outcomes = Vec::with_capacity(targets.len());
    for target in targets {
        let account_id = &target.account_id;
        // Outside any transaction: provider calls never hold the account lock.
        super::prepare(state, account_id).await;
        let result = delete_one(state.db_pool(), account_id, true).await;
        if let Ok(deletion) = &result {
            super::finish(state, account_id, deletion).await;
        }
        outcomes.push(Outcome {
            target: target.clone(),
            result,
        });
    }
    if let Some(client) = state.events().nats_client() {
        // Device revocations are plain publishes; send them before exiting.
        if let Err(error) = client.flush().await {
            eprintln!("[account-deletion] Could not flush device revocations: {error}");
        }
    }
    outcomes
}

/// What the command was asked to do.
pub struct Command {
    pub database_url: String,
    pub delete: Vec<String>,
    pub keep: Vec<String>,
    pub confirm: bool,
    /// Publishes device revocations and contact removals when set.
    pub nats_url: Option<String>,
}

/// Runs `delete-accounts`: prints a line per account and a summary. Fails
/// when it refuses to start or when any account failed.
pub async fn command(command: Command) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let pool = crate::pg::init_pool(&command.database_url).await?;
    let targets = match plan(&pool, &command.delete, &command.keep).await? {
        Ok(targets) => targets,
        Err(refusal) => {
            eprintln!("{refusal}");
            return Err("delete-accounts refused to start".into());
        }
    };
    let outcomes = if command.confirm {
        let events = match command.nats_url.as_deref() {
            Some(url) => crate::events::EventBus::connect(url).await?,
            None => {
                println!(
                    "NATS_URL is not set: device revocations and contact removals are not \
                     published on the event bus. Chat realtime connections still close through \
                     the database's session signals."
                );
                crate::events::EventBus::noop()
            }
        };
        let mut state = ServerState::new(pool, events);
        match crate::attachments::S3Config::from_env() {
            Some(s3) => state = state.with_s3(s3),
            None => println!(
                "Object storage is not configured: queued objects wait for the server's \
                 deletion worker."
            ),
        }
        run(&state, &targets).await
    } else {
        dry_run(&pool, &targets).await
    };
    for outcome in &outcomes {
        println!("{}", outcome.line());
    }
    let failed = outcomes
        .iter()
        .filter(|outcome| outcome.result.is_err())
        .count();
    let succeeded = outcomes.len() - failed;
    if command.confirm {
        println!(
            "Deleted {succeeded} of {} accounts; {failed} failed.",
            outcomes.len()
        );
    } else {
        println!(
            "Dry run: {succeeded} of {} accounts can be deleted; {failed} failed. Nothing was \
             changed. Run again with --confirm to delete.",
            outcomes.len()
        );
    }
    if failed > 0 {
        return Err(format!("{failed} accounts failed").into());
    }
    Ok(())
}
