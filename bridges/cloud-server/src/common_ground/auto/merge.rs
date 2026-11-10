//! Merging an automatic update's reply into the stored card. The reply only
//! names changes, so everything else stays. Protected topics are never
//! dropped: hidden ones, ones the owner typed ("Added by you"), and ones
//! citing a source the server cannot read again (device titles, agent
//! files, links, documents, notes). Only references from memory and
//! connected accounts can be taken off a topic, and a topic always keeps at
//! least one.

use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;

use super::delta::{same_reference, NewItem};
use crate::common_ground::build::provider_label;
use crate::common_ground::card::{
    next_evidence_id, Evidence, Topics, ADDED_BY_YOU, MAX_TOPICS, MAX_TOPIC_CHARS,
};
use crate::common_ground::prompt;

#[derive(Debug, Default, Deserialize)]
pub(in crate::common_ground) struct Update {
    #[serde(default)]
    add: Vec<Added>,
    #[serde(default)]
    revise: Vec<Revised>,
    #[serde(default)]
    drop: Vec<Dropped>,
}

#[derive(Debug, Deserialize)]
struct Added {
    #[serde(default)]
    list: String,
    label: String,
    #[serde(default)]
    evidence: Vec<i64>,
}

#[derive(Debug, Deserialize)]
struct Revised {
    label: String,
    #[serde(default)]
    evidence: Vec<i64>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Dropped {
    label: String,
    #[serde(default)]
    evidence: Vec<i64>,
}

/// The reply's changes, or `None` when it is not a readable update.
pub(in crate::common_ground) fn parse_update(text: &str) -> Option<Update> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(text.get(start..=end)?).ok()
}

/// The card's stored lists, references and hidden topics.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::common_ground) struct StoredCard {
    pub topics: Topics,
    pub evidence: Vec<Evidence>,
    pub hidden: Vec<String>,
}

/// Whether the server reads this source again on its own: memories and
/// connected accounts.
pub(in crate::common_ground) fn rereadable(source: &str) -> bool {
    source == "Memory"
        || crate::connectors::providers::PROVIDER_SPECS
            .iter()
            .any(|spec| provider_label(spec.id) == source)
}

fn clean_label(label: &str) -> String {
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    label.chars().take(MAX_TOPIC_CHARS).collect()
}

struct Merge<'a> {
    card: StoredCard,
    new: &'a [NewItem],
    /// New evidence index to the reference id it became.
    cited: BTreeMap<usize, String>,
    changed: bool,
}

impl Merge<'_> {
    /// The existing topic with this label, ignoring case, in any list.
    fn find(&self, label: &str, with_earlier: bool) -> Option<String> {
        let wanted = label.to_lowercase();
        let topics = &self.card.topics;
        let earlier = with_earlier.then_some(&topics.earlier);
        topics
            .current()
            .chain(earlier.into_iter().flatten())
            .find(|topic| topic.to_lowercase() == wanted)
            .cloned()
    }

    /// Valid new evidence indexes: `supporting` leaves out items that only
    /// say a memory is gone.
    fn indexes(&self, evidence: &[i64], supporting: bool) -> Vec<usize> {
        let mut out = Vec::new();
        for index in evidence.iter().filter_map(|i| usize::try_from(*i).ok()) {
            let Some(item) = self.new.get(index) else {
                continue;
            };
            if (!supporting || item.retracts.is_none()) && !out.contains(&index) {
                out.push(index);
            }
        }
        out
    }

    /// The reference id of new evidence `index`, added to the card once.
    /// Evidence the card already holds keeps its reference, so a reply that
    /// only restates it changes nothing.
    fn reference(&mut self, index: usize) -> String {
        if let Some(id) = self.cited.get(&index) {
            return id.clone();
        }
        let new: &[NewItem] = self.new;
        let item = &new[index].item;
        let held = self.card.evidence.iter().find(|e| same_reference(e, item));
        let id = match held {
            Some(evidence) => evidence.id.clone(),
            None => {
                let id = next_evidence_id(&self.card.evidence);
                self.card.evidence.push(prompt::reference(id.clone(), item));
                id
            }
        };
        self.cited.insert(index, id.clone());
        id
    }

    fn attach(&mut self, label: &str, indexes: &[usize]) {
        for &index in indexes {
            let id = self.reference(index);
            let refs = self.card.topics.refs.entry(label.to_string()).or_default();
            if !refs.contains(&id) {
                refs.push(id);
                self.changed = true;
            }
        }
    }

    fn source_of(&self, id: &str) -> Option<&str> {
        let item = self.card.evidence.iter().find(|item| item.id == id)?;
        Some(item.source.as_str())
    }

    /// Takes reference `id` off `label` when it came from a source the
    /// server reads again and the topic keeps another reference.
    fn take_off(&mut self, label: &str, id: &str) {
        let removable = self.source_of(id).is_some_and(rereadable);
        let Some(refs) = self.card.topics.refs.get_mut(label) else {
            return;
        };
        if removable && refs.len() > 1 && refs.iter().any(|r| r == id) {
            refs.retain(|r| r != id);
            self.changed = true;
        }
    }

    fn protected(&self, label: &str) -> bool {
        self.card.hidden.iter().any(|hidden| hidden == label)
            || self
                .card
                .topics
                .refs
                .get(label)
                .into_iter()
                .flatten()
                .filter_map(|id| self.source_of(id))
                .any(|source| source == ADDED_BY_YOU || !rereadable(source))
    }

    fn add(&mut self, added: &Added) {
        let label = clean_label(&added.label);
        let support = self.indexes(&added.evidence, true);
        if label.is_empty() || support.is_empty() {
            return;
        }
        if let Some(existing) = self.find(&label, true) {
            self.attach(&existing, &support);
            return;
        }
        let topics = &mut self.card.topics;
        let list = match added.list.as_str() {
            "working_on" => &mut topics.working_on,
            "interests" => &mut topics.interests,
            "can_help" => &mut topics.can_help,
            "looking_for" => &mut topics.looking_for,
            _ => return,
        };
        if list.len() >= MAX_TOPICS {
            return;
        }
        list.push(label.clone());
        self.changed = true;
        self.attach(&label, &support);
    }

    fn revise(&mut self, revised: &Revised) {
        let Some(label) = self.find(&clean_label(&revised.label), true) else {
            return;
        };
        let justified = self.indexes(&revised.evidence, false);
        if justified.is_empty() {
            return;
        }
        let support = self.indexes(&revised.evidence, true);
        self.attach(&label, &support);
        let mut gone: Vec<String> = revised
            .remove
            .iter()
            .map(|id| id.trim().to_string())
            .collect();
        gone.extend(
            justified
                .iter()
                .filter_map(|&i| self.new[i].retracts.clone()),
        );
        for id in gone {
            self.take_off(&label, &id);
        }
    }

    fn drop_topic(&mut self, dropped: &Dropped) {
        let Some(label) = self.find(&clean_label(&dropped.label), false) else {
            return;
        };
        if self.indexes(&dropped.evidence, false).is_empty() || self.protected(&label) {
            return;
        }
        let topics = &mut self.card.topics;
        for list in [
            &mut topics.working_on,
            &mut topics.interests,
            &mut topics.can_help,
            &mut topics.looking_for,
        ] {
            list.retain(|topic| topic != &label);
        }
        topics.refs.remove(&label);
        self.changed = true;
    }
}

/// The card after the update, or `None` when the update changes nothing.
/// References no topic cites any more are dropped, as a build drops them.
pub(in crate::common_ground) fn merge(
    card: &StoredCard,
    update: &Update,
    new: &[NewItem],
) -> Option<StoredCard> {
    let mut merge = Merge {
        card: card.clone(),
        new,
        cited: BTreeMap::new(),
        changed: false,
    };
    update.add.iter().for_each(|added| merge.add(added));
    update
        .revise
        .iter()
        .for_each(|revised| merge.revise(revised));
    update
        .drop
        .iter()
        .for_each(|dropped| merge.drop_topic(dropped));
    if !merge.changed {
        return None;
    }
    let mut card = merge.card;
    let labels: HashSet<String> = card
        .topics
        .current()
        .chain(card.topics.earlier.iter())
        .cloned()
        .collect();
    card.topics.refs.retain(|label, _| labels.contains(label));
    let cited: HashSet<&String> = card.topics.refs.values().flatten().collect();
    card.evidence.retain(|item| cited.contains(&item.id));
    let current: HashSet<&String> = card.topics.current().collect();
    card.hidden.retain(|topic| current.contains(topic));
    Some(card)
}
