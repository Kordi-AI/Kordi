//! Card builds and match runs without a database, for the System agent
//! quality test: the same redaction, instructions, reply parsing and scoring
//! a real run uses, fed with synthetic evidence and cards instead of an
//! account's sources and shared cards.

use std::collections::BTreeMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::card::Topics;
use super::matching::prompt::{json_object, match_prompt, parse_matches, MATCH_SYSTEM};
use super::matching::{self, SharedCard};
use super::profiles::Profile;
use super::prompt::{self, Gathered};

pub use super::matching::Addressing;

/// One synthetic evidence item, before redaction.
#[derive(Debug, Clone)]
pub struct EvidenceItem {
    pub source: String,
    pub title: String,
    pub date: Option<String>,
    pub text: String,
}

/// The topics a parsed reply produced, with the evidence ids (`e1`, `e2`, ...)
/// each topic cites.
#[derive(Debug, Clone, Default)]
pub struct CardTopics {
    pub working_on: Vec<String>,
    pub interests: Vec<String>,
    pub can_help: Vec<String>,
    pub looking_for: Vec<String>,
    pub earlier: Vec<String>,
    pub refs: BTreeMap<String, Vec<String>>,
}

/// One card build's instructions, as a real build would queue them.
pub struct CardBuild {
    pub system_prompt: String,
    pub user_prompt: String,
    gathered: Vec<Gathered>,
}

impl CardBuild {
    /// `kind` is work, health, daily or custom; `today` is `YYYY-MM-DD`.
    pub fn new(
        kind: &str,
        name: &str,
        focus: Option<&str>,
        today: &str,
        evidence: &[EvidenceItem],
    ) -> Self {
        let profile = Profile {
            profile_id: "cgp_quality".into(),
            account_id: "acct_quality".into(),
            kind: kind.into(),
            name: name.into(),
            focus: focus.map(str::to_string),
            position: 0,
            design: None,
            icon: None,
            sources: None,
        };
        let gathered: Vec<Gathered> = evidence
            .iter()
            .map(|item| {
                super::build::item(
                    &item.source,
                    &item.title,
                    item.date.clone(),
                    None,
                    &item.text,
                )
            })
            .collect();
        Self {
            system_prompt: prompt::system_prompt(&profile),
            user_prompt: prompt::user_prompt(today, &profile, &gathered),
            gathered,
        }
    }

    /// Parses a reply the way a finished build does. The error is the code
    /// clients would show (`invalid_output` or `no_topics`).
    pub fn parse(&self, reply: &str) -> Result<CardTopics, &'static str> {
        let (topics, _) =
            prompt::parse_reply(reply, &self.gathered).map_err(|error| error.code())?;
        Ok(CardTopics {
            working_on: topics.working_on,
            interests: topics.interests,
            can_help: topics.can_help,
            looking_for: topics.looking_for,
            earlier: topics.earlier,
            refs: topics.refs,
        })
    }
}

/// The instructions every match run is queued with.
pub const MATCH_SYSTEM_PROMPT: &str = MATCH_SYSTEM;

/// The SHA-256 of a prompt text, in hex, to tell instruction versions apart
/// in reports.
pub fn prompt_sha256(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// One person's card as a match run sees it: the display name and the four
/// shared lists.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatchCard {
    pub name: String,
    pub working_on: Vec<String>,
    pub interests: Vec<String>,
    pub can_help: Vec<String>,
    pub looking_for: Vec<String>,
}

/// A shared topic pair: the viewer's topic, the other person's, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchReason {
    pub topic: String,
    pub their_topic: String,
    pub why: String,
}

/// A skill one person offers and the other person's topic it serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchTrade {
    pub topic: String,
    pub target: String,
    pub why: String,
}

/// What a match run found for one other person, as the server stores it
/// for the viewer.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchFinding {
    /// 0-100.
    pub score: i64,
    pub headline: String,
    pub shared: Vec<MatchReason>,
    pub you_bring: Vec<MatchTrade>,
    pub they_bring: Vec<MatchTrade>,
    pub next_step: String,
    /// The score of the same finding stored for the other person.
    pub reversed_score: i64,
    /// Whether the server also stores the finding for the other person.
    pub reads_for_either: bool,
    /// When it does not, how the first reason or next step addresses
    /// someone.
    pub addressing: Option<Addressing>,
    /// Pairs the reply proposed for this person (shared, you_bring and
    /// they_bring entries) and pairs that passed the server's checks.
    pub proposed: usize,
    pub kept: usize,
}

/// One match run's instructions, as a real run would queue them.
pub struct MatchRun {
    pub system_prompt: String,
    pub user_prompt: String,
    viewer: SharedCard,
    others: Vec<SharedCard>,
}

fn shared_card(index: usize, card: &MatchCard) -> SharedCard {
    SharedCard {
        account_id: format!("acct_quality_{index}"),
        profile_id: format!("cgp_quality_{index}"),
        profile_kind: "work".into(),
        profile_name: "Work".into(),
        profile_design: None,
        profile_icon: None,
        name: crate::document_shares::access::clean_display_name(Some(&card.name)),
        handle: None,
        avatar_url: None,
        revision: 1,
        topics: Topics {
            working_on: card.working_on.clone(),
            interests: card.interests.clone(),
            can_help: card.can_help.clone(),
            looking_for: card.looking_for.clone(),
            ..Topics::default()
        },
    }
}

fn reasons(reasons: Vec<matching::Reason>) -> Vec<MatchReason> {
    reasons
        .into_iter()
        .map(|reason| MatchReason {
            topic: reason.topic,
            their_topic: reason.their_topic,
            why: reason.why,
        })
        .collect()
}

fn trades(trades: Vec<matching::Trade>) -> Vec<MatchTrade> {
    trades
        .into_iter()
        .map(|trade| MatchTrade {
            topic: trade.topic,
            target: trade.target,
            why: trade.why,
        })
        .collect()
}

/// Entries the reply lists for each person, read loosely: the three lists
/// of the first entry for each person number, the entry the server reads.
fn proposed_pairs(reply: &str, people: usize) -> Vec<usize> {
    let mut counts = vec![0; people];
    let mut seen = vec![false; people];
    let Some(value) = json_object(reply).and_then(|text| serde_json::from_str::<Value>(text).ok())
    else {
        return counts;
    };
    for person in value["people"].as_array().into_iter().flatten() {
        let Some(index) = person["person"]
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < people)
        else {
            continue;
        };
        if std::mem::replace(&mut seen[index], true) {
            continue;
        }
        counts[index] = ["shared", "you_bring", "they_bring"]
            .iter()
            .map(|list| person[*list].as_array().map_or(0, Vec::len))
            .sum();
    }
    counts
}

impl MatchRun {
    /// `viewer` is the person the run is for; `others` are numbered in order.
    pub fn new(viewer: &MatchCard, others: &[MatchCard]) -> Self {
        let viewer = shared_card(0, viewer);
        let others: Vec<SharedCard> = others
            .iter()
            .enumerate()
            .map(|(index, card)| shared_card(index + 1, card))
            .collect();
        Self {
            system_prompt: MATCH_SYSTEM.to_string(),
            user_prompt: match_prompt(&viewer, &others),
            viewer,
            others,
        }
    }

    /// The same run with other instructions, such as an earlier wording.
    pub fn with_system_prompt(mut self, text: &str) -> Self {
        self.system_prompt = text.to_string();
        self
    }

    /// Parses and scores a reply the way a finished run does: one finding
    /// per other person, in order. The error is the code a failed run gets
    /// (`invalid_output`).
    pub fn parse(&self, reply: &str) -> Result<Vec<MatchFinding>, &'static str> {
        let found = parse_matches(reply, &self.viewer, &self.others).ok_or("invalid_output")?;
        let proposed = proposed_pairs(reply, self.others.len());
        Ok(self
            .others
            .iter()
            .zip(found)
            .zip(proposed)
            .map(|((other, found), proposed)| {
                let names = [self.viewer.name.as_str(), other.name.as_str()];
                let reads_for_either = matching::reads_for_either(&found, &names);
                let addressing = matching::addressing(&found, &names);
                let reversed = matching::result(other, &self.viewer, matching::reversed(&found));
                let kept = found.shared.len() + found.you_bring.len() + found.they_bring.len();
                let result = matching::result(&self.viewer, other, found);
                MatchFinding {
                    score: result.score,
                    headline: result.headline,
                    shared: reasons(result.shared),
                    you_bring: trades(result.you_bring),
                    they_bring: trades(result.they_bring),
                    next_step: result.next_step,
                    reversed_score: reversed.score,
                    reads_for_either,
                    addressing,
                    proposed,
                    kept,
                }
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A card with at most one topic per list; an empty topic leaves the
    /// list empty.
    fn card(name: &str, topics: [&str; 4]) -> MatchCard {
        let [working_on, interests, can_help, looking_for] = topics.map(|topic| {
            (!topic.is_empty())
                .then(|| topic.to_string())
                .into_iter()
                .collect()
        });
        MatchCard {
            name: name.into(),
            working_on,
            interests,
            can_help,
            looking_for,
        }
    }

    fn run() -> MatchRun {
        let ada = card(
            "Ada Park",
            ["Agent memory", "Retrieval", "Eval design", "GPU access"],
        );
        let priya = card(
            "Priya",
            ["Memory for agents", "Speech", "GPU clusters", "Eval help"],
        );
        MatchRun::new(&ada, &[priya, card("Sam", ["Robot grasping", "", "", ""])])
    }

    fn reply(why: &str, next_step: &str) -> String {
        json!({"people": [
            {"person": 0,
             "shared": [{"mine": "Agent memory", "theirs": "Memory for agents", "why": why}],
             "you_bring": [{"topic": "Eval design", "for": "Eval help",
                 "why": "Eval skills fit"}],
             "they_bring": [{"topic": "GPU clusters", "for": "GPU access",
                 "why": "Cluster time fits"}],
             "next_step": next_step},
            {"person": 1, "shared": [], "you_bring": [], "they_bring": [], "next_step": ""}]})
        .to_string()
    }

    #[test]
    fn prompts_hold_the_production_instructions_and_every_card() {
        let run = run();
        assert_eq!(run.system_prompt, MATCH_SYSTEM_PROMPT);
        for card in [
            "Your card:\n  Working on: Agent memory\n",
            "[0] Priya\n  Working on: Memory for agents\n",
            "[1] Sam\n  Working on: Robot grasping\n",
        ] {
            assert!(run.user_prompt.contains(card), "{card}");
        }
        let earlier = run.with_system_prompt("Earlier wording");
        assert_eq!(earlier.system_prompt, "Earlier wording");
        assert_eq!(prompt_sha256("abc").len(), 64);
        assert_ne!(prompt_sha256("abc"), prompt_sha256("abd"));
    }

    #[test]
    fn a_good_reply_is_scored_the_same_from_both_sides() {
        let found = run()
            .parse(&reply("Both study memory", "Compare notes"))
            .unwrap();
        assert_eq!(found.len(), 2);
        let priya = &found[0];
        assert!(priya.score > 50, "{}", priya.score);
        assert_eq!(priya.headline, "Memory for agents");
        let shared = &priya.shared[0];
        assert_eq!(
            (shared.topic.as_str(), shared.their_topic.as_str()),
            ("Agent memory", "Memory for agents")
        );
        assert_eq!(priya.you_bring[0].target, "Eval help");
        assert_eq!(priya.they_bring[0].topic, "GPU clusters");
        assert_eq!(priya.reversed_score, priya.score);
        assert!(priya.reads_for_either && priya.addressing.is_none());
        assert_eq!((priya.proposed, priya.kept), (3, 3));
        let sam = &found[1];
        assert_eq!((sam.score, sam.headline.as_str()), (0, "Different area"));
        assert_eq!((sam.proposed, sam.kept), (0, 0));
    }

    #[test]
    fn invented_labels_count_as_dropped() {
        let reply = json!({"people": [{"person": 0,
            "shared": [{"mine": "Agent memory", "theirs": "Memory for agents", "why": "Same"},
                       {"mine": "Retrieval", "theirs": "Speech retrieval", "why": "Not a label"}],
            "they_bring": [{"topic": "Cooking", "for": "GPU access", "why": "Not a skill"}],
            "next_step": "Meet"},
            // A later entry for the same person is ignored, as the server does.
            {"person": 0, "shared": [{"mine": "Retrieval", "theirs": "Speech", "why": "Late"}]}]})
        .to_string();
        let found = run().parse(&reply).unwrap();
        assert_eq!((found[0].proposed, found[0].kept), (3, 1));
        assert_eq!((found[1].proposed, found[1].kept), (0, 0));
    }

    #[test]
    fn text_for_one_person_is_reported_with_its_cause() {
        let first =
            |why: &str, next_step: &str| run().parse(&reply(why, next_step)).unwrap()[0].clone();
        let you = first("Both study memory", "Show what you are building");
        assert!(!you.reads_for_either);
        assert_eq!(you.addressing, Some(Addressing::SecondPerson));
        let named = first("Priya studies memory too", "Compare benchmarks");
        assert!(!named.reads_for_either);
        assert_eq!(named.addressing, Some(Addressing::Name));
        let viewer = first("Both study memory", "Ask Park about benchmarks");
        assert_eq!(viewer.addressing, Some(Addressing::Name));
        // The score does not depend on the wording.
        assert_eq!(named.score, you.score);
    }

    #[test]
    fn a_reply_that_is_not_a_match_list_is_invalid_output() {
        for reply in [
            "not json",
            r#"{"themes":[]}"#,
            r#"{"people":[{"person":7}]}"#,
        ] {
            assert_eq!(run().parse(reply).unwrap_err(), "invalid_output", "{reply}");
        }
    }

    #[test]
    fn a_synthetic_build_redacts_evidence_and_parses_cited_topics() {
        let build = CardBuild::new(
            "work",
            "Work",
            None,
            "2026-11-01",
            &[EvidenceItem {
                source: "note".into(),
                title: "Sensor dashboard".into(),
                date: Some("2026-10-20".into()),
                text: "Write to ada@example.test about the sensor dashboard".into(),
            }],
        );
        assert!(build.system_prompt.contains("work profile"));
        assert!(build.user_prompt.contains("[0] 2026-10-20"));
        assert!(!build.user_prompt.contains("ada@example.test"));
        let topics = build
            .parse(r#"{"working_on":[{"label":"Sensor dashboard","evidence":[0, 7]}]}"#)
            .unwrap();
        assert_eq!(topics.working_on, vec!["Sensor dashboard"]);
        assert_eq!(topics.refs["Sensor dashboard"], vec!["e1"]);
        assert_eq!(build.parse("not json").unwrap_err(), "invalid_output");
        assert_eq!(
            build.parse(r#"{"working_on":[]}"#).unwrap_err(),
            "no_topics"
        );
    }
}
