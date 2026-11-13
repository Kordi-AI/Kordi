//! Matching: what a viewer shares with other people, and the themes of a
//! room. A background run on the Kordi key reads the shared cards and names
//! topic pairs; the server checks every pair against the cards, scores it,
//! and keeps the result for the pair of profiles and the card revisions it
//! was computed from. A finding that reads the same to either person is
//! kept for both of them, so each pair runs once.

mod finish;
pub(super) mod prompt;
mod recent;
mod routes;
mod store;

pub(super) use finish::{complete, fail};
pub(super) use recent::recent;
pub(super) use routes::{match_detail, results};
pub(super) use store::{fresh_results, queue_matches, stored_results, Pending, Queued};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::card::{self, Topics};

/// A profile's card as other people may see it: the four lists without
/// hidden topics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SharedCard {
    pub account_id: String,
    #[serde(default)]
    pub profile_id: String,
    #[serde(default)]
    pub profile_kind: String,
    #[serde(default)]
    pub profile_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_design: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_icon: Option<String>,
    pub name: String,
    /// The public @handle, without the `@`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub revision: i64,
    pub topics: Topics,
}

impl SharedCard {
    /// `{profileId, kind, name, design, icon}`: the profile shared with the
    /// viewer.
    pub fn profile_tag(&self) -> serde_json::Value {
        crate::common_ground::profiles::tag(
            &self.profile_id,
            &self.profile_kind,
            &self.profile_name,
            self.profile_design.as_deref(),
            self.profile_icon.as_deref(),
        )
    }
}

type SharedRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    Value,
    Value,
);

/// The shared cards of these (account, profile) pairs that exist and are
/// shared, in the order given. One query, however many members a room has.
pub(super) async fn shared_cards(
    pool: &PgPool,
    members: &[(String, String)],
) -> sqlx_core::Result<Vec<SharedCard>> {
    let (accounts, profiles): (Vec<&str>, Vec<&str>) = members
        .iter()
        .map(|(account, profile)| (account.as_str(), profile.as_str()))
        .unzip();
    let rows: Vec<SharedRow> = query_as(
        "SELECT account.account_id, profile.profile_id, account.display_name,
                COALESCE(account.public_handle, account.public_account_number::TEXT),
                account.avatar_url, profile.kind, profile.name, profile.design, profile.icon,
                card.revision, card.topics_json, card.hidden_json
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS member(account_id, profile_id, ord)
         JOIN cloud_accounts account ON account.account_id = member.account_id
         JOIN cloud_common_ground_profiles profile
           ON profile.profile_id = member.profile_id AND profile.account_id = account.account_id
         JOIN cloud_common_ground_cards card ON card.profile_id = profile.profile_id
         WHERE card.built_at IS NOT NULL AND card.sharing_enabled
         ORDER BY member.ord",
    )
    .bind(&accounts)
    .bind(&profiles)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                account_id,
                profile_id,
                name,
                handle,
                avatar_url,
                profile_kind,
                profile_name,
                profile_design,
                profile_icon,
                revision,
                topics,
                hidden,
            )| {
                let topics: Topics = serde_json::from_value(topics).unwrap_or_default();
                let hidden: Vec<String> = serde_json::from_value(hidden).unwrap_or_default();
                SharedCard {
                    account_id,
                    profile_id,
                    profile_kind,
                    profile_name,
                    profile_design,
                    profile_icon,
                    name: crate::document_shares::access::clean_display_name(name.as_deref()),
                    handle,
                    avatar_url,
                    revision,
                    topics: card::shared_topics(&topics, &hidden),
                }
            },
        )
        .collect())
}

/// A topic pair you share, with a short reason.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Reason {
    pub topic: String,
    pub their_topic: String,
    pub why: String,
}

/// A skill one person offers and the other person's topic it helps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct Trade {
    pub topic: String,
    #[serde(rename = "for")]
    pub target: String,
    pub why: String,
}

/// A match as the viewer sees it. Stored per (viewer profile, other
/// profile).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MatchResult {
    /// 0-100.
    pub score: i64,
    pub headline: String,
    pub shared: Vec<Reason>,
    pub you_bring: Vec<Trade>,
    pub they_bring: Vec<Trade>,
    pub next_step: String,
}

const WORKING_ON: f64 = 1.0;
const OTHER_FIELD: f64 = 0.6;
const OVERLAP_WEIGHT: f64 = 0.6;
const COMPLEMENT_WEIGHT: f64 = 0.4;

fn weight(topics: &Topics, topic: &str) -> f64 {
    if topics.working_on.iter().any(|t| t == topic) {
        WORKING_ON
    } else {
        OTHER_FIELD
    }
}

/// `1 - e^-x`: a second or third topic still helps, but less than the first.
fn saturate(x: f64) -> f64 {
    1.0 - (-x).exp()
}

/// Shared topics count by list ("working on" more than interests); a skill
/// that serves what the other person is looking for counts in full, one that
/// serves their work or interests a little less.
pub(super) fn score(viewer: &Topics, other: &Topics, found: &prompt::Found) -> i64 {
    let overlap: f64 = found
        .shared
        .iter()
        .map(|r| weight(viewer, &r.topic).min(weight(other, &r.their_topic)))
        .sum();
    let serves = |receiver: &Topics, trade: &Trade| {
        if receiver.looking_for.iter().any(|t| t == &trade.target) {
            WORKING_ON
        } else {
            OTHER_FIELD
        }
    };
    let complement: f64 = found
        .you_bring
        .iter()
        .map(|t| serves(other, t))
        .sum::<f64>()
        + found
            .they_bring
            .iter()
            .map(|t| serves(viewer, t))
            .sum::<f64>();
    let raw = OVERLAP_WEIGHT * saturate(overlap) + COMPLEMENT_WEIGHT * saturate(complement);
    (raw * 100.0).round() as i64
}

pub(super) fn headline(found: &prompt::Found) -> String {
    if let Some(reason) = found.shared.first() {
        reason.their_topic.clone()
    } else if let Some(trade) = found.they_bring.first() {
        format!("Can help with {}", trade.topic)
    } else if let Some(trade) = found.you_bring.first() {
        format!("Needs your {}", trade.topic)
    } else {
        "Different area".into()
    }
}

pub(super) fn result(viewer: &SharedCard, other: &SharedCard, found: prompt::Found) -> MatchResult {
    MatchResult {
        score: score(&viewer.topics, &other.topics, &found),
        headline: headline(&found),
        shared: found.shared,
        you_bring: found.you_bring,
        they_bring: found.they_bring,
        next_step: found.next_step,
    }
}

/// The same finding from the other person's side: each shared pair and the
/// two trade lists change sides, and the next step stays. Score it with
/// [`result`] and the cards swapped.
pub(super) fn reversed(found: &prompt::Found) -> prompt::Found {
    prompt::Found {
        shared: found
            .shared
            .iter()
            .map(|reason| Reason {
                topic: reason.their_topic.clone(),
                their_topic: reason.topic.clone(),
                why: reason.why.clone(),
            })
            .collect(),
        you_bring: found.they_bring.clone(),
        they_bring: found.you_bring.clone(),
        next_step: found.next_step.clone(),
    }
}

/// Words that address the reader. Text is split at anything but letters
/// and digits, so "you're" and "you'll" count through "you".
const SECOND_PERSON: [&str; 5] = ["you", "your", "yours", "yourself", "yourselves"];

/// The lower-case words of `text`.
fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
}

/// What makes a text read differently to the two people.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Addressing {
    /// A word that addresses the reader, such as "you" or "your".
    SecondPerson,
    /// A word of one of the two people's names.
    Name,
}

/// How `text` addresses the reader or names one of `names`, if it does. A
/// name counts by any word of it longer than one letter, as a whole word,
/// or anywhere for a word with letters beyond ASCII (some scripts put no
/// spaces between words). Extra matches only cost a second run.
fn addressing_in(text: &str, names: &[&str]) -> Option<Addressing> {
    let found: std::collections::HashSet<String> = words(text).collect();
    if SECOND_PERSON.iter().any(|word| found.contains(*word)) {
        return Some(Addressing::SecondPerson);
    }
    let lower = text.to_lowercase();
    names
        .iter()
        .flat_map(|name| words(name))
        .any(|word| {
            word.chars().count() > 1
                && (found.contains(&word) || (!word.is_ascii() && lower.contains(&word)))
        })
        .then_some(Addressing::Name)
}

/// How the first reason or next step that addresses someone does it, in
/// the order reasons, trades, next step; `None` when all of them read the
/// same to either person.
pub(super) fn addressing(found: &prompt::Found, names: &[&str]) -> Option<Addressing> {
    let reasons = found.shared.iter().map(|reason| &reason.why);
    let trades = found.you_bring.iter().chain(&found.they_bring);
    reasons
        .chain(trades.map(|trade| &trade.why))
        .chain(std::iter::once(&found.next_step))
        .find_map(|text| addressing_in(text, names))
}

/// Whether every reason and the next step read the same to either person:
/// no "you" and neither person's name. Only then is one run's finding also
/// stored for the other person.
pub(super) fn reads_for_either(found: &prompt::Found, names: &[&str]) -> bool {
    addressing(found, names).is_none()
}

/// Themes with only the people in `cards`, the cards the viewer sees. A
/// theme left with fewer than two of them is dropped, so no theme stands
/// for someone hidden; the largest come first.
pub(super) fn visible_themes(
    themes: Vec<(String, Vec<String>)>,
    cards: &[SharedCard],
) -> Vec<(String, Vec<String>)> {
    let mut themes: Vec<(String, Vec<String>)> = themes
        .into_iter()
        .map(|(label, people)| {
            let people: Vec<String> = people
                .into_iter()
                .filter(|id| cards.iter().any(|card| &card.account_id == id))
                .collect();
            (label, people)
        })
        .filter(|(_, people)| people.len() >= 2)
        .collect();
    themes.sort_by_key(|theme| std::cmp::Reverse(theme.1.len()));
    themes
}

/// The largest theme with the viewer and at least two others, else the
/// largest one with the viewer.
pub(super) fn suggestion<'a>(
    themes: &'a [(String, Vec<String>)],
    viewer: &str,
) -> Option<&'a (String, Vec<String>)> {
    let mine = themes
        .iter()
        .filter(|(_, people)| people.iter().any(|p| p == viewer));
    let mut best = None;
    for theme in mine {
        if theme.1.len() >= 3 {
            return Some(theme);
        }
        best = best.or(Some(theme));
    }
    best
}
