//! What an automatic update reads: only what changed since the card last
//! caught up, from the sources the owner saved for it. Memories routed to
//! the card that were saved or changed, references to memories that left it,
//! and new events from the picked connected accounts, each bounded. Device
//! titles, agent files, links, documents and notes are never read again.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx_postgres::PgPool;

use crate::common_ground::build::{event_item, memory_item};
use crate::common_ground::card::Evidence;
use crate::common_ground::profiles::Profile;
use crate::common_ground::prompt::{self, Gathered};

const MAX_CHANGED_MEMORIES: i64 = 40;
const MAX_LEFT_MEMORIES: i64 = 40;
const MAX_EVENTS: i64 = 40;
/// Events that happened in about the last six months, as a build reads.
const CONNECTOR_DAYS: i64 = 183;
/// The source of an item that says a cited memory is gone.
pub(in crate::common_ground) const REMOVED_SOURCE: &str = "Removed memory";
const REMOVED_TEXT: &str = "The person deleted this memory or took it off this card.";

/// One item of new evidence. An item that `retracts` a reference says the
/// memory behind it left the card; it never supports a topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(in crate::common_ground) struct NewItem {
    #[serde(flatten)]
    pub item: Gathered,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retracts: Option<String>,
}

impl NewItem {
    fn new(item: Gathered) -> Self {
        Self {
            item,
            retracts: None,
        }
    }
}

/// Whether `item` would become the card's `reference` again: the same
/// source, title, link and normalized text. The date is left out, since
/// saving a memory again moves it.
pub(in crate::common_ground) fn same_reference(reference: &Evidence, item: &Gathered) -> bool {
    reference.source == item.source
        && reference.title == item.title
        && reference.url == item.url
        && reference.snippet == prompt::reference(String::new(), item).snippet
}

/// The item that says the memory behind `reference` left the card. Only
/// the reference already on the card is shown; archived text is not.
pub(in crate::common_ground) fn removed(reference: &Evidence) -> NewItem {
    NewItem {
        item: Gathered {
            source: REMOVED_SOURCE.into(),
            title: reference.title.clone(),
            date: reference.date.clone(),
            url: None,
            text: REMOVED_TEXT.into(),
        },
        retracts: Some(reference.id.clone()),
    }
}

/// The new evidence for `profile`'s card since `since`. Without saved
/// picks the card follows memory only, as a build from Memory does.
pub(in crate::common_ground) async fn gather(
    pool: &PgPool,
    profile: &Profile,
    references: &[Evidence],
    since: DateTime<Utc>,
) -> sqlx_core::Result<Vec<NewItem>> {
    let account = profile.account_id.as_str();
    let target = profile.memory_target();
    let memory_on = profile.sources.as_ref().is_none_or(|picks| picks.memory);
    let providers = profile
        .sources
        .as_ref()
        .map(|picks| picks.connectors.clone())
        .unwrap_or_default();
    let mut out = Vec::new();
    let memory_enabled = memory_on
        && crate::memory_store::settings(pool, account)
            .await
            .map_err(|_| sqlx_core::Error::Protocol("Could not read memories.".into()))?
            .memory_enabled;
    if memory_enabled {
        let changed = crate::memory_store::build_memories_since(
            pool,
            account,
            target,
            since,
            MAX_CHANGED_MEMORIES,
        )
        .await?;
        for memory in &changed {
            let item = memory_item(&memory.text, &memory.updated_at);
            // Saving the same text again only touches a memory: one older
            // than `since` that the card already cites is not new.
            let older = DateTime::parse_from_rfc3339(&memory.created_at)
                .is_ok_and(|created| created.with_timezone(&Utc) <= since);
            if older && references.iter().any(|r| same_reference(r, &item)) {
                continue;
            }
            out.push(NewItem::new(item));
        }
        let left = crate::memory_store::left_since(pool, account, target, since, MAX_LEFT_MEMORIES)
            .await?;
        for (text, updated_at) in &left {
            // The title a build gave this memory's reference.
            let title = memory_item(text, &updated_at.to_rfc3339()).title;
            for reference in references
                .iter()
                .filter(|reference| reference.source == "Memory" && reference.title == title)
            {
                if !out
                    .iter()
                    .any(|item| item.retracts.as_ref() == Some(&reference.id))
                {
                    out.push(removed(reference));
                }
            }
        }
    }
    if !providers.is_empty() {
        let events = crate::connectors::digest_input::events_received_since(
            pool,
            account,
            since,
            Utc::now() - Duration::days(CONNECTOR_DAYS),
            &providers,
            MAX_EVENTS,
        )
        .await?;
        out.extend(events.iter().map(|event| NewItem::new(event_item(event))));
    }
    Ok(out)
}
