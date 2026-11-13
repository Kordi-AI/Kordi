//! Grounding match suites: one file of synthetic people, labelled pairs and
//! rooms that the loader expands into match runs, batched the way the server
//! batches a viewer's matches. Each run's stub reply is written from the
//! suite's gold pairs.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Result};
use kordi_cloud_server::common_ground::quality::MatchCard;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Other people per run: the server matches a viewer with up to eight
/// people at a time.
pub const MATCH_BATCH: usize = 8;
/// The stub's reason for a gold shared pair.
pub const SHARED_WHY: &str = "Both work in this area";
/// The stub's reason for a gold trade.
pub const TRADE_WHY: &str = "A skill that fits this need";
/// The stub's next step for a pair with gold pairs.
pub const NEXT_STEP: &str = "Compare notes over coffee";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SuiteFile {
    GroundingMatchSuite(Suite),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Suite {
    pub id: String,
    pub description: String,
    pub people: Vec<Person>,
    pub pairs: Vec<Pair>,
    #[serde(default)]
    pub rooms: Vec<Room>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Person {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub working_on: Vec<String>,
    #[serde(default)]
    pub interests: Vec<String>,
    #[serde(default)]
    pub can_help: Vec<String>,
    #[serde(default)]
    pub looking_for: Vec<String>,
}

impl Person {
    pub fn card(&self) -> MatchCard {
        MatchCard {
            name: self.name.clone(),
            working_on: self.working_on.clone(),
            interests: self.interests.clone(),
            can_help: self.can_help.clone(),
            looking_for: self.looking_for.clone(),
        }
    }

    /// Topics a shared pair may use: working on and interests.
    fn shared_topics(&self) -> impl Iterator<Item = &String> {
        self.working_on.iter().chain(&self.interests)
    }

    /// Topics a trade may serve: working on, interests and looking for.
    fn trade_targets(&self) -> impl Iterator<Item = &String> {
        self.shared_topics().chain(&self.looking_for)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strength {
    Strong,
    Weak,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PairKind {
    Overlap,
    Paraphrase,
    Complement,
    HardNegative,
    Unrelated,
}

impl PairKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Overlap => "overlap",
            Self::Paraphrase => "paraphrase",
            Self::Complement => "complement",
            Self::HardNegative => "hard negative",
            Self::Unrelated => "unrelated",
        }
    }
}

/// A labelled pair. Strong pairs carry the gold pairs that justify the
/// label, with topic labels exactly as the cards write them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pair {
    pub a: String,
    pub b: String,
    pub label: Strength,
    pub kind: PairKind,
    pub why: String,
    /// (a's topic, b's topic), both from working on or interests.
    #[serde(default)]
    pub shared: Vec<(String, String)>,
    /// (giver id, a can help topic of the giver, a topic of the receiver).
    #[serde(default)]
    pub trades: Vec<(String, String, String)>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Room {
    pub id: String,
    pub members: Vec<String>,
}

/// How a pair is labelled, as a run's checks read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Label {
    pub strength: Strength,
    pub kind: PairKind,
}

/// One match run expanded from a suite.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchFixture {
    pub id: String,
    pub suite: String,
    pub description: String,
    /// The room this run matches within; `None` for a run over labelled
    /// pairs that no room covers.
    pub room: Option<String>,
    pub viewer: Person,
    pub others: Vec<Person>,
    /// Each other person's label with the viewer, when the pair is labelled.
    pub labels: Vec<Option<Label>>,
    /// The reply a good model gives: the gold pairs with neutral reasons.
    pub stub: String,
}

/// Reads a suite file and expands it into runs.
pub fn parse(raw: &str) -> Result<Vec<MatchFixture>> {
    let SuiteFile::GroundingMatchSuite(suite) = serde_json::from_str(raw)?;
    expand(&suite)
}

fn unordered<'a>(a: &'a str, b: &'a str) -> (&'a str, &'a str) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

fn validate(suite: &Suite) -> Result<()> {
    let mut people: BTreeMap<&str, &Person> = BTreeMap::new();
    for person in &suite.people {
        if person.name.trim().is_empty() {
            bail!("{} has no name", person.id);
        }
        if people.insert(&person.id, person).is_some() {
            bail!("duplicate person {}", person.id);
        }
    }
    let mut seen = BTreeSet::new();
    for pair in &suite.pairs {
        let (Some(a), Some(b)) = (people.get(pair.a.as_str()), people.get(pair.b.as_str())) else {
            bail!("pair {}-{} names an unknown person", pair.a, pair.b);
        };
        let name = format!("pair {}-{}", pair.a, pair.b);
        if pair.a == pair.b || !seen.insert(unordered(&pair.a, &pair.b)) {
            bail!("{name} pairs a person with themself or repeats a pair");
        }
        let allowed = match pair.label {
            Strength::Strong => !matches!(pair.kind, PairKind::HardNegative | PairKind::Unrelated),
            Strength::None => matches!(pair.kind, PairKind::HardNegative | PairKind::Unrelated),
            Strength::Weak => true,
        };
        if !allowed {
            bail!("{name} is {:?} with kind {}", pair.label, pair.kind.name());
        }
        let has_gold = !pair.shared.is_empty() || !pair.trades.is_empty();
        if pair.label != Strength::Strong {
            if has_gold {
                bail!("{name}: only strong pairs carry gold pairs");
            }
            continue;
        }
        let needed = if pair.kind == PairKind::Complement {
            !pair.trades.is_empty()
        } else {
            !pair.shared.is_empty()
        };
        if !needed {
            bail!(
                "{name}: a strong {} pair needs a gold pair of that kind",
                pair.kind.name()
            );
        }
        validate_gold(&name, pair, a, b)?;
    }
    let mut rooms = BTreeSet::new();
    for room in &suite.rooms {
        if !rooms.insert(&room.id) {
            bail!("duplicate room {}", room.id);
        }
        let mut members = BTreeSet::new();
        for member in &room.members {
            if !people.contains_key(member.as_str()) || !members.insert(member) {
                bail!("room {} lists {member} more than once or unknown", room.id);
            }
        }
    }
    Ok(())
}

/// Gold pairs must survive the server's checks unchanged: labels from the
/// right card and list, each topic once per side, at most three per list.
fn validate_gold(name: &str, pair: &Pair, a: &Person, b: &Person) -> Result<()> {
    fn has<'a>(mut topics: impl Iterator<Item = &'a String>, topic: &str) -> bool {
        topics.any(|candidate| candidate == topic)
    }
    let (mut mine, mut theirs) = (BTreeSet::new(), BTreeSet::new());
    for (topic, their_topic) in &pair.shared {
        if !has(a.shared_topics(), topic) || !has(b.shared_topics(), their_topic) {
            bail!("{name}: {topic} ~ {their_topic} is not working on or interests");
        }
        if !mine.insert(topic) || !theirs.insert(their_topic) {
            bail!("{name}: a topic is in two gold shared pairs");
        }
    }
    let mut given: BTreeMap<&str, BTreeSet<&String>> = BTreeMap::new();
    for (giver, topic, target) in &pair.trades {
        let (from, to) = match giver.as_str() {
            id if id == a.id => (a, b),
            id if id == b.id => (b, a),
            _ => bail!("{name}: trade giver {giver} is not in the pair"),
        };
        if !from.can_help.contains(topic) || !has(to.trade_targets(), target) {
            bail!("{name}: {giver} cannot trade {topic} for {target}");
        }
        if !given.entry(giver).or_default().insert(topic) {
            bail!("{name}: {giver} trades {topic} twice");
        }
    }
    let too_many = pair.shared.len() > 3 || given.values().any(|topics| topics.len() > 3);
    if too_many {
        bail!("{name}: the server keeps at most three pairs per list");
    }
    Ok(())
}

/// The stub reply for `viewer` and `others`: gold pairs of strong pairs,
/// empty lists for everyone else.
fn stub(viewer: &str, others: &[&Person], pairs: &BTreeMap<(&str, &str), &Pair>) -> String {
    let people: Vec<serde_json::Value> = others
        .iter()
        .enumerate()
        .map(|(index, other)| {
            let pair = pairs
                .get(&unordered(viewer, &other.id))
                .filter(|pair| pair.label == Strength::Strong);
            let (mut shared, mut you_bring, mut they_bring) = (vec![], vec![], vec![]);
            if let Some(pair) = pair {
                for (a_topic, b_topic) in &pair.shared {
                    let (mine, theirs) = if pair.a == viewer {
                        (a_topic, b_topic)
                    } else {
                        (b_topic, a_topic)
                    };
                    shared.push(json!({"mine": mine, "theirs": theirs, "why": SHARED_WHY}));
                }
                for (giver, topic, target) in &pair.trades {
                    let trade = json!({"topic": topic, "for": target, "why": TRADE_WHY});
                    if giver == viewer {
                        you_bring.push(trade);
                    } else {
                        they_bring.push(trade);
                    }
                }
            }
            json!({"person": index, "shared": shared, "you_bring": you_bring,
                "they_bring": they_bring, "next_step": if pair.is_some() { NEXT_STEP } else { "" }})
        })
        .collect();
    json!({ "people": people }).to_string()
}

/// Every room member matched with the rest of the room in member order, in
/// batches; then every labelled pair no room run covers, in both
/// directions, grouped by viewer in the order of the people list.
pub fn expand(suite: &Suite) -> Result<Vec<MatchFixture>> {
    validate(suite)?;
    let people: BTreeMap<&str, &Person> = suite.people.iter().map(|p| (p.id.as_str(), p)).collect();
    let order: BTreeMap<&str, usize> = suite
        .people
        .iter()
        .enumerate()
        .map(|(index, person)| (person.id.as_str(), index))
        .collect();
    let pairs: BTreeMap<(&str, &str), &Pair> = suite
        .pairs
        .iter()
        .map(|pair| (unordered(&pair.a, &pair.b), pair))
        .collect();
    let mut runs = Vec::new();
    let mut add = |id: String, room: Option<&str>, viewer: &str, others: &[&str], what: String| {
        let viewer = people[viewer];
        let others: Vec<&Person> = others.iter().map(|id| people[id]).collect();
        let labels = others
            .iter()
            .map(|other| {
                pairs
                    .get(&unordered(&viewer.id, &other.id))
                    .map(|pair| Label {
                        strength: pair.label,
                        kind: pair.kind,
                    })
            })
            .collect();
        runs.push(MatchFixture {
            description: format!("{} ({}) with {what}", viewer.name, viewer.id),
            stub: stub(&viewer.id, &others, &pairs),
            id,
            suite: suite.id.clone(),
            room: room.map(str::to_string),
            viewer: viewer.clone(),
            others: others.into_iter().cloned().collect(),
            labels,
        });
    };
    let mut covered = BTreeSet::new();
    for room in &suite.rooms {
        for viewer in &room.members {
            let others: Vec<&str> = room
                .members
                .iter()
                .filter(|member| *member != viewer)
                .map(String::as_str)
                .collect();
            let batches = others.len().div_ceil(MATCH_BATCH);
            for (index, batch) in others.chunks(MATCH_BATCH).enumerate() {
                covered.extend(batch.iter().map(|other| (viewer.as_str(), *other)));
                add(
                    format!("{}-{}-{viewer}-{}", suite.id, room.id, index + 1),
                    Some(&room.id),
                    viewer,
                    batch,
                    format!(
                        "{} people in room {}, batch {} of {batches}",
                        batch.len(),
                        room.id,
                        index + 1
                    ),
                );
            }
        }
    }
    let mut missing: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
    for pair in &suite.pairs {
        for (viewer, other) in [
            (pair.a.as_str(), pair.b.as_str()),
            (pair.b.as_str(), pair.a.as_str()),
        ] {
            if !covered.contains(&(viewer, other)) {
                missing.entry(order[viewer]).or_default().push(other);
            }
        }
    }
    for (viewer, mut others) in missing {
        others.sort_by_key(|other| order[other]);
        let viewer = suite.people[viewer].id.as_str();
        for (index, batch) in others.chunks(MATCH_BATCH).enumerate() {
            add(
                format!("{}-pairs-{viewer}-{}", suite.id, index + 1),
                None,
                viewer,
                batch,
                format!("{} labelled people outside the rooms", batch.len()),
            );
        }
    }
    Ok(runs)
}

#[cfg(test)]
#[path = "match_suite_tests.rs"]
mod tests;
